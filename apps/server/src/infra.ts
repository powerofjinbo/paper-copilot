/**
 * Small shared infrastructure: sidecar paths, logger, event bus, job registry and the atomic
 * JSON/JSONL file store. Used by every service.
 */
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ServerMessage, JobKind } from '@paper-copilot/core';
import type { z } from 'zod';
import type { EventBus, JobInfo, JobRegistry, Logger, PaperFiles, PaperPaths } from './contracts';

/* ------------------------------------------------------------------------------------ */
/* Paths                                                                                 */
/* ------------------------------------------------------------------------------------ */

export function paperPaths(root: string, texRoot?: string): PaperPaths {
  const r = resolve(root);
  const paper = join(r, '.paper');
  const tex = texRoot ? resolve(texRoot) : join(r, 'tex');
  return {
    root: r,
    tex,
    paper,
    config: join(paper, 'project.json'),
    db: join(paper, 'paper.db'),
    history: join(paper, 'history.jsonl'),
    outline: join(paper, 'outline.json'),
    facts: join(paper, 'facts.json'),
    claims: join(paper, 'claims.json'),
    figures: join(paper, 'figures.json'),
    terminology: join(paper, 'terminology.json'),
    evidence: join(paper, 'evidence.jsonl'),
    questions: join(paper, 'questions.json'),
    briefDir: join(paper, 'brief'),
    repoBrief: join(paper, 'brief', 'repo_brief.md'),
    litBrief: join(paper, 'brief', 'lit_brief.md'),
    litDir: join(paper, 'lit'),
    litIndex: join(paper, 'lit', 'index.json'),
    voiceDir: join(paper, 'voice'),
    corpus: join(paper, 'voice', 'corpus.jsonl'),
    voiceStats: join(paper, 'voice', 'stats.json'),
    memo: join(paper, 'voice', 'memo.md'),
    editPairs: join(paper, 'voice', 'edit_pairs.jsonl'),
    syncBase: join(paper, 'sync', 'base'),
    build: join(paper, 'build'),
    claudeCwd: join(paper, 'claude'),
    costLog: join(paper, 'cost.jsonl'),
    aiUseRecord: join(paper, 'ai_use_record.json'),
  };
}

export async function ensureLayout(paths: PaperPaths): Promise<void> {
  for (const d of [paths.paper, paths.briefDir, paths.litDir, paths.voiceDir, paths.syncBase, paths.build, paths.claudeCwd]) {
    await mkdir(d, { recursive: true });
  }
}

/** Resolve a client-supplied path relative to `base` and refuse anything that escapes it. */
export function safeJoin(base: string, rel: string): string {
  if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\0')) throw new Error('invalid path');
  if (rel.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(rel)) throw new Error('absolute paths are not allowed');
  const full = resolve(base, rel);
  const b = resolve(base);
  if (full !== b && !full.startsWith(b + '/') && !full.startsWith(b + '\\')) throw new Error('path escapes the project');
  return full;
}

export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

/* ------------------------------------------------------------------------------------ */
/* Logger                                                                                */
/* ------------------------------------------------------------------------------------ */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

/** Redact anything that looks like an API key or token before logging. */
export function redact(value: unknown): unknown {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s === undefined) return value;
  const red = s.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-***').replace(/("?(?:token|apiKey|api_key|authorization|x-api-key)"?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1***');
  return typeof value === 'string' ? red : red;
}

export function createLogger(level: Level = (process.env.PAPER_LOG_LEVEL as Level) || 'info', sink: (line: string) => void = (l) => process.stderr.write(l + '\n')): Logger {
  const min = LEVELS[level] ?? 20;
  const out = (lv: Level, msg: string, data?: unknown) => {
    if (LEVELS[lv] < min) return;
    const tail = data === undefined ? '' : ' ' + String(redact(data));
    sink(`[${new Date().toISOString()}] ${lv.toUpperCase()} ${msg}${tail}`);
  };
  return {
    debug: (m, d) => out('debug', m, d),
    info: (m, d) => out('info', m, d),
    warn: (m, d) => out('warn', m, d),
    error: (m, d) => out('error', m, d),
  };
}

/* ------------------------------------------------------------------------------------ */
/* Event bus                                                                             */
/* ------------------------------------------------------------------------------------ */

export function createEventBus(log?: Logger): EventBus {
  const subs = new Set<(m: ServerMessage) => void>();
  return {
    emit(msg) {
      for (const fn of [...subs]) {
        try {
          fn(msg);
        } catch (e) {
          log?.warn('event subscriber failed', String(e));
        }
      }
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/* ------------------------------------------------------------------------------------ */
/* Jobs                                                                                  */
/* ------------------------------------------------------------------------------------ */

export function createJobRegistry(bus: EventBus, log: Logger): JobRegistry {
  const jobs = new Map<string, JobInfo>();
  let seq = 0;
  const emit = (j: JobInfo) => bus.emit({ type: 'job.progress', jobId: j.id, kind: j.kind, state: j.state, message: j.message, result: j.state === 'done' ? j.result : undefined });
  return {
    start(kind: JobKind, run) {
      const id = `job-${Date.now().toString(36)}-${(++seq).toString(36)}`;
      const job: JobInfo = { id, kind, state: 'queued', message: 'queued', startedAt: new Date().toISOString(), finishedAt: null, result: null };
      jobs.set(id, job);
      emit(job);
      queueMicrotask(async () => {
        job.state = 'running';
        job.message = 'running';
        emit(job);
        try {
          job.result = await run((message) => {
            job.message = message;
            emit(job);
          });
          job.state = 'done';
          job.message = 'done';
        } catch (e) {
          job.state = 'error';
          job.message = e instanceof Error ? e.message : String(e);
          log.error(`job ${kind} failed`, job.message);
        }
        job.finishedAt = new Date().toISOString();
        emit(job);
      });
      return id;
    },
    get: (id) => jobs.get(id),
    list: () => [...jobs.values()],
  };
}

/* ------------------------------------------------------------------------------------ */
/* Files (atomic writes)                                                                 */
/* ------------------------------------------------------------------------------------ */

let tmpSeq = 0;

export async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${++tmpSeq}`;
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, path);
}

export function createPaperFiles(log?: Logger): PaperFiles {
  return {
    readJson<T>(path: string, schema: z.ZodType<T>, fallback: T): T {
      if (!existsSync(path)) return fallback;
      try {
        const parsed = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
        if (parsed.success) return parsed.data;
        log?.warn(`invalid JSON in ${path}; using fallback`, parsed.error.message.slice(0, 500));
        return fallback;
      } catch (e) {
        log?.warn(`cannot read ${path}; using fallback`, String(e));
        return fallback;
      }
    },
    async writeJson(path, value) {
      await writeFileAtomic(path, JSON.stringify(value, null, 1) + '\n');
    },
    async appendJsonl(path, value) {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, JSON.stringify(value) + '\n', 'utf8');
    },
    readJsonl<T>(path: string, schema: z.ZodType<T>): T[] {
      if (!existsSync(path)) return [];
      const out: T[] = [];
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const p = schema.safeParse(JSON.parse(line));
          if (p.success) out.push(p.data);
        } catch {
          /* skip a torn last line */
        }
      }
      return out;
    },
    readText(path) {
      return existsSync(path) ? readFileSync(path, 'utf8') : null;
    },
    writeText(path, text) {
      return writeFileAtomic(path, text);
    },
  };
}
