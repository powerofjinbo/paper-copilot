/**
 * The service container: createCtx({ root, texRoot?, fake?, logLevel? }) loads (or creates) the project
 * configuration, the sidecar layout, the database and file store, the event bus and job registry, the
 * per-launch token, and every service through its factory. Services reference each other only through
 * `ctx` at call time, so construction order does not matter.
 *
 * `start()` starts the background parts (lint sidecar, file watcher, a facts rescan of the analysis
 * repository); `close()` flushes every open document and the facts/literature stores to disk, stops
 * agents, the watcher and the sidecar, and closes the database.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ProjectConfig } from '@paper-copilot/core';
import { loadConfig, saveConfig as saveConfigFile } from './config';
import type { Ctx, Logger } from './contracts';
import { createEventBus, createJobRegistry, createLogger, createPaperFiles, ensureLayout, newToken, paperPaths } from './infra';
import { createDocService, type DocServiceExt, type DocServiceOptions } from './docs/docService';
import { createTexWatcher, type TexWatcher } from './docs/watcher';
import { createPaperDb, type PaperDbExt } from './store/db';
import { createSyncService } from './services/sync/syncService';
import { createDisclosureService, type DisclosureService } from './services/disclosure';
import { createFactService } from './services/facts/factService';
import { createLitService } from './services/lit/litService';
import { createLintService } from './services/lint/lintService';
import { createLlmService } from './services/llm/index';
import { resolveApiKey } from './services/llm/apiKey';
import { createAgentService } from './services/agents/index';
import { createBuildService } from './services/build/index';
import { createVoiceService } from './services/voice/index';
import { initProject } from './project/init';

export interface CreateCtxOptions {
  /** Project root (holds .paper and, by default, tex/). */
  root: string;
  /** LaTeX tree, when it is not the configured one (or <root>/tex for a new project). */
  texRoot?: string;
  /** Force the simulated AI on (true) or off (false); default: no API key or PAPER_FAKE_LLM=1. */
  fake?: boolean;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  /** Log sink (default stderr). */
  logSink?: (line: string) => void;
  /** Create the project (paper init) when .paper/project.json is missing. Default true. */
  autoInit?: boolean;
  /** Start the file watcher in start(). Default true. */
  watch?: boolean;
  /** Start the lint sidecar in start(). Default true. */
  lintSidecar?: boolean;
  docs?: DocServiceOptions;
}

export interface AppCtx extends Ctx {
  docs: DocServiceExt;
  db: PaperDbExt;
  disclosure: DisclosureService;
  start(): Promise<void>;
  close(): Promise<void>;
  readonly watcher: TexWatcher | null;
}

export function fakeLlmFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PAPER_FAKE_LLM === '1' || env.PAPER_FAKE_LLM === 'true') return true;
  return !resolveApiKey({ env }).key;
}

export async function createCtx(opts: CreateCtxOptions): Promise<AppCtx> {
  const root = resolve(opts.root);
  const log: Logger = createLogger(opts.logLevel ?? ((process.env.PAPER_LOG_LEVEL as CreateCtxOptions['logLevel']) || 'info'), opts.logSink);
  let config: ProjectConfig | null = loadConfig(paperPaths(root));
  if (!config) {
    if (opts.autoInit === false) throw new Error(`${join(root, '.paper', 'project.json')} not found; run \`paper init ${root}\` first`);
    const r = await initProject(root, opts.texRoot ? { tex: opts.texRoot } : {});
    for (const a of r.actions) log.info(a);
    config = r.config;
  } else if (opts.texRoot && resolve(opts.texRoot) !== resolve(config.texRoot)) {
    config = { ...config, texRoot: resolve(opts.texRoot) };
  }
  if (!existsSync(config.texRoot)) throw new Error(`the LaTeX tree ${config.texRoot} (from project.json) does not exist`);
  const paths = paperPaths(root, config.texRoot);
  await ensureLayout(paths);

  const bus = createEventBus(log);
  const jobs = createJobRegistry(bus, log);
  const db = createPaperDb(paths.db, log);
  const files = createPaperFiles(log);
  const fakeLlm = opts.fake ?? fakeLlmFromEnv();
  let current = config;
  let watcher: TexWatcher | null = null;
  let started = false;
  let closed = false;
  let startupScan: Promise<unknown> | null = null;

  const ctx = {
    paths,
    get config() {
      return current;
    },
    async saveConfig(next: ProjectConfig) {
      await saveConfigFile(paths, next);
      current = next;
    },
    token: newToken(),
    fakeLlm,
    log,
    bus,
    jobs,
    db,
    files,
    get watcher() {
      return watcher;
    },
  } as unknown as AppCtx;

  ctx.docs = createDocService(ctx, opts.docs);
  ctx.facts = createFactService(ctx);
  ctx.lit = createLitService(ctx);
  ctx.lint = createLintService(ctx);
  ctx.llm = createLlmService(ctx);
  const agents = createAgentService(ctx);
  ctx.agents = agents;
  ctx.build = createBuildService(ctx);
  ctx.voice = createVoiceService(ctx);
  ctx.sync = createSyncService(ctx, { pauseWatcher: () => watcher?.pause() ?? (() => undefined) });
  ctx.disclosure = createDisclosureService(ctx);

  ctx.start = async () => {
    if (started) return;
    started = true;
    if (opts.lintSidecar !== false) {
      try {
        await ctx.lint.start();
      } catch (e) {
        log.warn('lint sidecar unavailable; AI-ese and gate hints still work', e instanceof Error ? e.message : String(e));
      }
    }
    if (current.repoDir) {
      // Re-read the analysis artifacts once per launch so values changed by a re-run show up as stale.
      startupScan = Promise.resolve()
        .then(() => ctx.facts.rescan())
        .then(
          (r) => log.info(`facts: ${r.count} read from the analysis repository${r.stale.length ? `, ${r.stale.length} changed since last launch` : ''}`),
          (e) => log.warn('facts: startup scan failed; the fact list may be out of date', e instanceof Error ? e.message : String(e)),
        );
    }
    if (opts.watch !== false) {
      try {
        watcher = createTexWatcher(ctx, ctx.docs);
        await watcher.ready;
      } catch (e) {
        log.warn('file watcher unavailable; external edits are picked up on the next open', String(e));
      }
    }
  };

  ctx.close = async () => {
    if (closed) return;
    closed = true;
    try {
      agents.abortAll();
    } catch {
      /* none running */
    }
    try {
      await ctx.llm.close?.();
    } catch {
      /* no timers */
    }
    try {
      await ctx.docs.close();
    } catch (e) {
      log.error('could not write every open document on shutdown', String(e));
    }
    if (watcher) await watcher.close().catch(() => undefined);
    if (startupScan) await startupScan;
    for (const [name, svc] of [
      ['facts', ctx.facts],
      ['literature', ctx.lit],
    ] as const) {
      const flush = (svc as { flush?: () => Promise<void> }).flush;
      if (typeof flush !== 'function') continue;
      try {
        await flush.call(svc);
      } catch (e) {
        log.error(`could not save the ${name} store on shutdown`, e instanceof Error ? e.message : String(e));
      }
    }
    try {
      await ctx.lint.stop();
    } catch {
      /* not started */
    }
    db.close();
  };

  if (fakeLlm) log.info('AI: simulated (no ANTHROPIC_API_KEY or PAPER_FAKE_LLM=1); every AI output is labelled as simulated');
  return ctx;
}
