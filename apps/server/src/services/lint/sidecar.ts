/**
 * LintSidecar: the Node client of sidecar/lintd.py (protocol: sidecar/PROTOCOL.md).
 *
 * One long-lived `python3 sidecar/lintd.py --skill-dir <dir>` process speaks JSON lines over stdio. The client
 * gives every request an id, sends one request at a time from a FIFO queue (so concurrent callers are safe and
 * responses can never be mismatched), parses stdout with readline, and keeps the last lines of stderr in a ring
 * buffer for diagnostics (stderrTail()).
 *
 * Failure handling:
 * - Per-request timeout (timeoutMs, default 30 s): the request rejects, the stuck process is killed and the next
 *   request starts a fresh one.
 * - If the process dies, it is restarted automatically on the next request, and a request that was in flight is
 *   retried once on the new process; a request that kills the fresh process too is rejected (the queue goes on).
 *   After three deaths with no successful response in between, or when a restart cannot start at all (skill
 *   removed, python gone), the client gives up: every later call rejects with the reason (stderr tail included).
 * - close() sends `shutdown`, waits briefly for exit 0, then kills; queued calls reject.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------------------------ */
/* Wire types                                                                            */
/* ------------------------------------------------------------------------------------ */

/** A sentence-local style_check flag (lint.sentences). */
export interface SidecarFlag {
  /** The sid of the item the flag belongs to. */
  sid: string;
  /** style_check check number (1 long, 2 verb, 3 connectors, 4 vocab, 5 hype, 10 passive). */
  check: number;
  /** style_check check key ('long', 'verb', ...). */
  key: string;
  /** style_check's message, with its *emphasis* markup. */
  msg: string;
  /** The offending word or phrase re-found from the message's *emphasis*, else null. */
  word: string | null;
  /** style_check's excerpt of the sentence (about 170 characters). */
  excerpt: string;
}

/** A document flag (lint.document), all ten checks. */
export interface SidecarDocFlag {
  check: number;
  key: string;
  /** Line in the text sent (1-based); 0 when style_check gives none. */
  line: number;
  /** abstract/intro/body/concl/app/caption/footnote, or '' for flags not tied to a sentence. */
  part: string;
  excerpt: string;
  msg: string;
  word: string | null;
  /** style_check's internal sentence index (Sent.i), or null for flags not tied to a sentence. */
  sent_index: number | null;
}

export interface SidecarDocResult {
  flags: SidecarDocFlag[];
  /** Flags per 1,000 words, by check key, for this document. */
  rates: Record<string, number>;
  /** Flags per 1,000 words, by check key, on the five reference papers. */
  referenceRates: Record<string, number>;
  words: number;
  sentences: number;
  /** \input/\include targets style_check saw (it does not follow them). */
  includes: string[];
}

export interface SidecarReady {
  /** Absolute path of the style_check.py the sidecar imported. */
  styleCheckPath: string;
  /** sha256 prefix of style_check.py. */
  version: string;
  protocol: number | null;
}

export interface SidecarLintOptions {
  /** Acronyms that need no definition (style_check --known). */
  known?: string[];
  /** Long-sentence threshold (style_check --max-words, default 40, at least 5). */
  maxWords?: number;
  /** snake_case alias of maxWords (accepted for callers that pass protocol names). */
  max_words?: number;
  /** lint.sentences only: a LaTeX preamble whose \newcommand/\def macros are expanded in the sentences. */
  preamble?: string;
}

export interface SidecarLogger {
  debug?(msg: string, data?: unknown): void;
  info?(msg: string, data?: unknown): void;
  warn?(msg: string, data?: unknown): void;
  error?(msg: string, data?: unknown): void;
}

export interface LintSidecarStartOptions {
  /** Python interpreter (default $PAPER_PYTHON, else 'python3'). */
  python?: string;
  /** The hep-paper-writing skill directory (else lintd.py's own search: $PAPER_SKILL_DIR, ~/.claude/skills/..., .skill). */
  skillDir?: string;
  /** Path of lintd.py (default: sidecar/lintd.py at the repository root, resolved from this file). */
  scriptPath?: string;
  /** Per-request timeout in ms (default 30000). */
  timeoutMs?: number;
  /** Time allowed for the process to print its ready line, in ms (default max(timeoutMs, 15000)). */
  startTimeoutMs?: number;
  /** Optional logger for restarts and stray output. */
  log?: SidecarLogger;
  /** Extra environment variables for the process. */
  env?: Record<string, string>;
}

/* ------------------------------------------------------------------------------------ */
/* Internals                                                                             */
/* ------------------------------------------------------------------------------------ */

const DEFAULT_TIMEOUT_MS = 30_000;
const STDERR_LINES = 200;
const STDERR_LINE_CHARS = 2000;
const CLOSE_GRACE_MS = 2000;
/** Deaths with no successful response in between before the client gives up. */
const MAX_CONSECUTIVE_DEATHS = 3;

interface Job {
  cmd: string;
  payload: Record<string, unknown>;
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  retried: boolean;
}

interface Proc {
  child: ChildProcessWithoutNullStreams;
  rl: Interface;
  alive: boolean;
  /** The request in flight on this process. */
  current: { id: number; job: Job; timer: NodeJS.Timeout } | null;
  /** Set when the client killed the process on purpose (timeout, close). */
  killedOnPurpose: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
}

/** sidecar/lintd.py from this file (apps/server/src/services/lint/), searching upward when the layout differs. */
export function defaultScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const direct = resolve(here, '../../../../../sidecar/lintd.py');
  if (existsSync(direct)) return direct;
  let dir = here;
  for (let k = 0; k < 10; k++) {
    const cand = join(dir, 'sidecar', 'lintd.py');
    if (existsSync(cand)) return cand;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return direct;
}

function str(v: unknown, dflt = ''): string {
  return typeof v === 'string' ? v : dflt;
}

function num(v: unknown, dflt = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

function numRecord(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) if (typeof n === 'number' && Number.isFinite(n)) out[k] = n;
  return out;
}

function lintArgs(opts: SidecarLintOptions | undefined): Record<string, unknown> {
  const o = opts ?? {};
  const out: Record<string, unknown> = { known: Array.isArray(o.known) ? o.known.filter((k) => typeof k === 'string') : [] };
  const mw = o.maxWords ?? o.max_words;
  if (mw !== undefined && mw !== null) out.max_words = mw;
  return out;
}

/* ------------------------------------------------------------------------------------ */
/* Client                                                                                */
/* ------------------------------------------------------------------------------------ */

export class LintSidecar {
  private readonly python: string;
  private readonly scriptPath: string;
  private readonly skillDir: string | undefined;
  private readonly timeoutMs: number;
  private readonly startTimeoutMs: number;
  private readonly log: SidecarLogger | undefined;
  private readonly env: Record<string, string> | undefined;

  private proc: Proc | null = null;
  private starting: Promise<Proc> | null = null;
  private readonly queue: Job[] = [];
  private busy = false;
  private nextId = 1;
  private closed = false;
  /** Process deaths since the last successful response. */
  private deaths = 0;
  /** Set once the client has given up; every call rejects with it. */
  private failed: Error | null = null;
  private readonly stderrRing: string[] = [];
  private readyInfo: SidecarReady = { styleCheckPath: '', version: '', protocol: null };

  private constructor(opts: LintSidecarStartOptions) {
    this.python = opts.python ?? process.env.PAPER_PYTHON ?? 'python3';
    this.scriptPath = opts.scriptPath ?? defaultScriptPath();
    this.skillDir = opts.skillDir || undefined;
    this.timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.startTimeoutMs = opts.startTimeoutMs && opts.startTimeoutMs > 0 ? opts.startTimeoutMs : Math.max(this.timeoutMs, 15_000);
    this.log = opts.log;
    this.env = opts.env;
  }

  /** Spawn lintd.py and wait for its ready line. Rejects with the sidecar's reason when it cannot start. */
  static async start(opts: LintSidecarStartOptions = {}): Promise<LintSidecar> {
    const s = new LintSidecar(opts);
    s.proc = await s.spawnProc();
    return s;
  }

  /** What the sidecar reported on start: the style_check.py path and its version hash. */
  get ready(): SidecarReady {
    return { ...this.readyInfo };
  }

  get version(): string {
    return this.readyInfo.version;
  }

  get styleCheckPath(): string {
    return this.readyInfo.styleCheckPath;
  }

  /** The last lines the process wrote to stderr (diagnostics). */
  stderrTail(lines = 40): string {
    return this.stderrRing.slice(-lines).join('\n');
  }

  /** PID of the current process, or null (tests and diagnostics). */
  get pid(): number | null {
    return this.proc && this.proc.alive ? (this.proc.child.pid ?? null) : null;
  }

  async ping(): Promise<boolean> {
    const r = await this.request('ping', {});
    return r.pong === true;
  }

  /** Sentence-local checks (1, 2, 3, 4, 5, 10) on each item; flags come back in item order. */
  async lintSentences(items: { sid: string; text: string; part: string }[], opts?: SidecarLintOptions): Promise<SidecarFlag[]> {
    if (!Array.isArray(items) || items.length === 0) return [];
    const payload: Record<string, unknown> = {
      items: items.map((it) => ({ sid: String(it.sid), text: typeof it.text === 'string' ? it.text : '', part: typeof it.part === 'string' ? it.part : 'body' })),
      ...lintArgs(opts),
    };
    if (opts?.preamble) payload.preamble = opts.preamble;
    const r = await this.request('lint.sentences', payload);
    if (Array.isArray(r.errors) && r.errors.length) this.log?.warn?.('lint sidecar: some sentences could not be linted', r.errors);
    const flags = Array.isArray(r.flags) ? r.flags : [];
    const out: SidecarFlag[] = [];
    for (const f of flags as Record<string, unknown>[]) {
      if (!f || typeof f.msg !== 'string') continue;
      out.push({ sid: String(f.sid ?? ''), check: num(f.check), key: str(f.key), msg: f.msg, word: typeof f.word === 'string' ? f.word : null, excerpt: str(f.excerpt) });
    }
    return out;
  }

  /** All ten checks on a flattened LaTeX document. */
  async lintDocument(text: string, opts?: SidecarLintOptions): Promise<SidecarDocResult> {
    const r = await this.request('lint.document', { text: typeof text === 'string' ? text : '', ...lintArgs(opts) });
    const flags: SidecarDocFlag[] = [];
    for (const f of (Array.isArray(r.flags) ? r.flags : []) as Record<string, unknown>[]) {
      if (!f || typeof f.msg !== 'string') continue;
      flags.push({
        check: num(f.check),
        key: str(f.key),
        line: num(f.line),
        part: str(f.part),
        excerpt: str(f.excerpt),
        msg: f.msg,
        word: typeof f.word === 'string' ? f.word : null,
        sent_index: typeof f.sent_index === 'number' ? f.sent_index : null,
      });
    }
    return {
      flags,
      rates: numRecord(r.rates),
      referenceRates: numRecord(r.reference_rates),
      words: num(r.words),
      sentences: num(r.sentences),
      includes: Array.isArray(r.includes) ? r.includes.filter((x): x is string => typeof x === 'string') : [],
    };
  }

  /** style_check's report statistics over a corpus of texts (sentence length, passive share, we per 1k, verb position). */
  async corpusStats(texts: string[], fmt: 'tex' | 'txt' = 'txt'): Promise<Record<string, unknown>> {
    const r = await this.request('corpus.stats', { texts: texts.filter((t) => typeof t === 'string'), fmt });
    const { id: _id, ok: _ok, ...rest } = r;
    return rest;
  }

  /**
   * Stop the process: a request already sent is still answered, queued ones reject; `shutdown`, then a kill after
   * a grace period. Idempotent.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const closedErr = new Error('lint sidecar closed');
    for (const job of this.queue.splice(0)) job.reject(closedErr);
    const p = this.proc ?? (this.starting ? await this.starting.catch(() => null) : null);
    if (!p || !p.alive) return;
    await new Promise<void>((done) => {
      const finish = () => {
        clearTimeout(t);
        done();
      };
      const t = setTimeout(() => {
        p.killedOnPurpose = true;
        p.child.kill('SIGKILL');
      }, CLOSE_GRACE_MS);
      p.child.once('exit', finish);
      if (!p.alive) return finish();
      try {
        p.child.stdin.write(JSON.stringify({ id: 0, cmd: 'shutdown' }) + '\n');
        p.child.stdin.end();
      } catch {
        p.killedOnPurpose = true;
        p.child.kill('SIGKILL');
      }
    });
    // A request still in flight when the process went away.
    if (p.current) {
      clearTimeout(p.current.timer);
      p.current.job.reject(closedErr);
      p.current = null;
    }
  }

  /* -- request queue --------------------------------------------------------------------- */

  private request(cmd: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('lint sidecar closed'));
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolveP, rejectP) => {
      this.queue.push({ cmd, payload, resolve: resolveP, reject: rejectP, retried: false });
      this.pump();
    });
  }

  private pump(): void {
    if (this.busy || this.queue.length === 0) return;
    const job = this.queue.shift()!;
    if (this.closed) return job.reject(new Error('lint sidecar closed'));
    if (this.failed) {
      job.reject(this.failed);
      return this.pump();
    }
    this.busy = true;
    this.ensureProc().then(
      (p) => this.send(p, job),
      (e: unknown) => {
        this.busy = false;
        job.reject(e instanceof Error ? e : new Error(String(e)));
        this.pump();
      },
    );
  }

  private async ensureProc(): Promise<Proc> {
    if (this.proc && this.proc.alive) return this.proc;
    if (this.failed) throw this.failed;
    if (this.closed) throw new Error('lint sidecar closed');
    if (!this.starting) {
      this.log?.info?.('lint sidecar: starting a new process');
      this.starting = this.spawnProc()
        .catch((e: unknown) => {
          // A process that cannot start again (skill removed, python gone) is not retried on every call.
          this.failed = e instanceof Error ? e : new Error(String(e));
          for (const job of this.queue.splice(0)) job.reject(this.failed);
          throw this.failed;
        })
        .finally(() => {
          this.starting = null;
        });
    }
    const p = await this.starting;
    this.proc = p;
    return p;
  }

  private send(p: Proc, job: Job): void {
    if (this.closed) {
      this.busy = false;
      job.reject(new Error('lint sidecar closed'));
      return;
    }
    if (!p.alive) {
      this.busy = false;
      this.queue.unshift(job);
      return this.pump();
    }
    const id = this.nextId++;
    let line: string;
    try {
      line = JSON.stringify({ ...job.payload, id, cmd: job.cmd });
    } catch (e) {
      this.busy = false;
      job.reject(new Error(`lint sidecar: cannot encode ${job.cmd}: ${e instanceof Error ? e.message : String(e)}`));
      return this.pump();
    }
    const timer = setTimeout(() => this.onTimeout(p, id), this.timeoutMs);
    p.current = { id, job, timer };
    p.child.stdin.write(line + '\n');
  }

  private onTimeout(p: Proc, id: number): void {
    const cur = p.current;
    if (!cur || cur.id !== id) return;
    p.current = null;
    cur.job.reject(new Error(`lint sidecar: ${cur.job.cmd} timed out after ${this.timeoutMs} ms`));
    this.log?.warn?.(`lint sidecar: ${cur.job.cmd} timed out; restarting the process`);
    p.killedOnPurpose = true;
    p.alive = false;
    p.child.kill('SIGKILL');
    if (this.proc === p) this.proc = null;
    this.busy = false;
    this.pump();
  }

  private onLine(p: Proc, line: string): void {
    const t = line.trim();
    if (!t) return;
    let msg: Record<string, unknown>;
    try {
      const v: unknown = JSON.parse(t);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
      msg = v as Record<string, unknown>;
    } catch {
      this.log?.warn?.('lint sidecar: ignoring a non-protocol stdout line', t.slice(0, 200));
      return;
    }
    const cur = p.current;
    if (!cur || msg.id !== cur.id) {
      this.log?.debug?.('lint sidecar: ignoring a response with no matching request', msg.id);
      return;
    }
    clearTimeout(cur.timer);
    p.current = null;
    this.deaths = 0;
    if (msg.ok === true) cur.job.resolve(msg);
    else cur.job.reject(new Error(`lint sidecar: ${cur.job.cmd}: ${str(msg.error, 'request failed')}`));
    this.busy = false;
    this.pump();
  }

  private onExit(p: Proc): void {
    const wasCurrent = this.proc === p;
    if (wasCurrent) this.proc = null;
    const cur = p.current;
    p.current = null;
    if (cur) clearTimeout(cur.timer);
    if (this.closed || p.killedOnPurpose) {
      if (cur) cur.job.reject(new Error('lint sidecar closed'));
      return;
    }
    const why = `lint sidecar exited (${p.exitSignal ? `signal ${p.exitSignal}` : `code ${p.exitCode}`})`;
    const tail = this.stderrTail(10);
    this.log?.warn?.(why, tail || undefined);
    this.deaths++;
    if (this.deaths >= MAX_CONSECUTIVE_DEATHS) {
      this.failed = new Error(`${why} ${this.deaths} times in a row; giving up${tail ? `: ${tail}` : ''}`);
      if (cur) cur.job.reject(this.failed);
      for (const job of this.queue.splice(0)) job.reject(this.failed);
    } else if (cur && !cur.job.retried) {
      // Restart once and retry the request that was in flight.
      cur.job.retried = true;
      this.queue.unshift(cur.job);
    } else if (cur) {
      // The request killed a fresh process too: reject it, keep serving others.
      cur.job.reject(new Error(`${why} twice on this ${cur.job.cmd} request${tail ? `: ${tail}` : ''}`));
    }
    if (cur) {
      this.busy = false;
      this.pump();
    }
  }

  private pushStderr(line: string): void {
    this.stderrRing.push(line.length > STDERR_LINE_CHARS ? line.slice(0, STDERR_LINE_CHARS) + ' …' : line);
    if (this.stderrRing.length > STDERR_LINES) this.stderrRing.splice(0, this.stderrRing.length - STDERR_LINES);
  }

  /** Spawn a process and wait for its ready line. */
  private spawnProc(): Promise<Proc> {
    const args = ['-B', this.scriptPath];
    if (this.skillDir) args.push('--skill-dir', this.skillDir);
    return new Promise<Proc>((resolveP, rejectP) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.python, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', ...(this.env ?? {}) },
          windowsHide: true,
        });
      } catch (e) {
        rejectP(new Error(`lint sidecar: cannot spawn ${this.python}: ${e instanceof Error ? e.message : String(e)}`));
        return;
      }
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      const errRl = createInterface({ input: child.stderr, crlfDelay: Infinity });
      errRl.on('line', (l) => this.pushStderr(l));
      const p: Proc = { child, rl, alive: true, current: null, killedOnPurpose: false, exitCode: null, exitSignal: null };
      let settled = false;
      const fail = (msg: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        p.killedOnPurpose = true;
        if (p.alive) child.kill('SIGKILL');
        const tail = this.stderrTail(10);
        rejectP(new Error(`lint sidecar: ${msg}${tail ? ` (stderr: ${tail})` : ''}`));
      };
      const startTimer = setTimeout(() => fail(`no ready line within ${this.startTimeoutMs} ms`), this.startTimeoutMs);
      child.stdin.on('error', (e) => this.log?.debug?.('lint sidecar: stdin error', e.message));
      child.on('error', (e) => {
        p.alive = false;
        fail(`cannot run ${this.python}: ${e.message}`);
      });
      child.on('exit', (code, signal) => {
        p.alive = false;
        p.exitCode = code;
        p.exitSignal = signal;
        rl.close();
        // Let stderr drain into the ring before the exit is reported.
        setImmediate(() => {
          if (!settled) fail(`exited before it was ready (${signal ? `signal ${signal}` : `code ${code}`})`);
          else this.onExit(p);
        });
      });
      rl.on('line', (line) => {
        if (settled) return this.onLine(p, line);
        let r: Record<string, unknown> | null = null;
        try {
          const v: unknown = JSON.parse(line);
          if (v && typeof v === 'object' && !Array.isArray(v)) r = v as Record<string, unknown>;
        } catch {
          r = null;
        }
        if (!r || !('ready' in r)) {
          this.pushStderr(`[stdout before ready] ${line}`);
          return;
        }
        if (r.ready !== true) return fail(str(r.error, 'not ready'));
        settled = true;
        clearTimeout(startTimer);
        this.readyInfo = { styleCheckPath: str(r.style_check), version: str(r.version), protocol: typeof r.protocol === 'number' ? r.protocol : null };
        resolveP(p);
      });
    });
  }
}
