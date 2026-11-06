/**
 * Test helpers shared by every server test: a temporary project copied from fixtures/canto-demo and
 * a Ctx whose infrastructure is real (paths, files, bus, jobs, logger) and whose services are
 * provided by the test or are proxies that throw "service not provided: X" on use.
 */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ServerMessage } from '@paper-copilot/core';
import type { Ctx, PaperPaths } from '../../src/contracts';
import { defaultProjectConfig } from '../../src/config';
import { createEventBus, createJobRegistry, createLogger, createPaperFiles, ensureLayout, paperPaths } from '../../src/infra';

export const REPO_ROOT = resolve(new URL('../../../..', import.meta.url).pathname);
export const FIXTURE = join(REPO_ROOT, 'fixtures', 'canto-demo');
export const SKILL_DIR = join(REPO_ROOT, '.skill');

export interface TempProject {
  root: string;
  paths: PaperPaths;
  repoDir: string;
  cleanup(): void;
}

/** Copy fixtures/canto-demo/{tex,repo} into a fresh temp dir: <tmp>/tex, <tmp>/repo, <tmp>/.paper. */
export async function makeTempProject(): Promise<TempProject> {
  const root = mkdtempSync(join(tmpdir(), 'paper-test-'));
  cpSync(join(FIXTURE, 'tex'), join(root, 'tex'), { recursive: true });
  cpSync(join(FIXTURE, 'repo'), join(root, 'repo'), { recursive: true });
  const paths = paperPaths(root);
  await ensureLayout(paths);
  return { root, paths, repoDir: join(root, 'repo'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function missing(name: string): never {
  throw new Error(`service not provided: ${name}`);
}

function throwingProxy<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get(_t, prop) {
      if (prop === 'then') return undefined; // not a thenable
      return () => missing(`${name}.${String(prop)}`);
    },
  });
}

/** Build a Ctx for tests. `events` collects every bus message. */
export function makeTestCtx(project: TempProject, overrides: Partial<Ctx> = {}): Ctx & { events: ServerMessage[] } {
  const log = createLogger((process.env.PAPER_LOG_LEVEL as 'debug') || 'error');
  const bus = createEventBus(log);
  const events: ServerMessage[] = [];
  bus.subscribe((m) => events.push(m));
  let config = defaultProjectConfig(project.paths, {
    repoDir: project.repoDir,
    skillDir: SKILL_DIR,
    bibFiles: ['refs.bib'],
  });
  const ctx = {
    paths: project.paths,
    get config() {
      return config;
    },
    async saveConfig(next) {
      config = next;
    },
    token: 'test-token',
    fakeLlm: true,
    log,
    bus,
    jobs: createJobRegistry(bus, log),
    files: createPaperFiles(log),
    db: throwingProxy('db'),
    docs: throwingProxy('docs'),
    facts: throwingProxy('facts'),
    lit: throwingProxy('lit'),
    lint: throwingProxy('lint'),
    llm: throwingProxy('llm'),
    agents: throwingProxy('agents'),
    build: throwingProxy('build'),
    sync: throwingProxy('sync'),
    voice: throwingProxy('voice'),
    events,
    ...overrides,
  } as Ctx & { events: ServerMessage[] };
  return ctx;
}

/** Wait until a job finishes (polls the registry). */
export async function waitForJob(ctx: Ctx, jobId: string, timeoutMs = 20000): Promise<unknown> {
  const t0 = Date.now();
  for (;;) {
    const j = ctx.jobs.get(jobId);
    if (j && (j.state === 'done' || j.state === 'error')) {
      if (j.state === 'error') throw new Error(`job failed: ${j.message}`);
      return j.result;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`job ${jobId} timed out`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
