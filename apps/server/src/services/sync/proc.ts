/**
 * Child processes for sync: git (always `git -C <texRoot>`) and overleaf-sync (`ols`).
 *
 * Never interactive (GIT_TERMINAL_PROMPT=0, no editor, no pager), English output (LC_ALL=C) so errors
 * can be recognised, a hard timeout, and an environment without the app's secrets (API keys, tokens).
 * A missing binary is reported as `{ code: null, notFound: true }`, never thrown.
 */
import { spawn } from 'node:child_process';

export interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The executable is not installed (ENOENT). */
  notFound: boolean;
  timedOut: boolean;
}

const SECRET_ENV = /(^ANTHROPIC_|API_KEY|_TOKEN$|SECRET|PASSWORD|^PAPER_TOKEN$)/i;

export function syncEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (SECRET_ENV.test(k) && !/^GIT_/.test(k)) continue;
    env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_EDITOR = 'true';
  env.GIT_SEQUENCE_EDITOR = 'true';
  env.GIT_PAGER = 'cat';
  env.PAGER = 'cat';
  env.LC_ALL = 'C';
  env.LANG = 'C';
  // never let a hook of the analysis repo or a global config open an editor for the merge message
  env.GIT_MERGE_AUTOEDIT = 'no';
  return env;
}

export function runProc(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string; env?: NodeJS.ProcessEnv; maxBytes?: number } = {}): Promise<ProcResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxBytes = opts.maxBytes ?? 32 * 1024 * 1024;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? syncEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: String(e), notFound: (e as NodeJS.ErrnoException).code === 'ENOENT', timedOut: false });
      return;
    }
    const finish = (r: ProcResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, timeoutMs);
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      if (stdout.length < maxBytes) stdout += d;
    });
    child.stderr!.on('data', (d: string) => {
      if (stderr.length < 1024 * 1024) stderr += d;
    });
    child.on('error', (e: NodeJS.ErrnoException) => finish({ code: null, stdout, stderr: stderr || String(e), notFound: e.code === 'ENOENT', timedOut }));
    child.on('close', (code) => finish({ code, stdout, stderr, notFound: false, timedOut }));
    if (opts.input !== undefined) child.stdin!.end(opts.input);
    else child.stdin!.end();
  });
}

export interface Git {
  readonly dir: string;
  run(args: string[], opts?: { timeoutMs?: number; input?: string }): Promise<ProcResult>;
  /** Run and return trimmed stdout; throws GitError on a non-zero exit. */
  out(args: string[], opts?: { timeoutMs?: number }): Promise<string>;
  ok(args: string[]): Promise<boolean>;
}

export class GitError extends Error {
  constructor(
    message: string,
    public readonly result: ProcResult,
  ) {
    super(message);
  }
}

export function describeProc(r: ProcResult): string {
  if (r.notFound) return 'not installed';
  if (r.timedOut) return 'timed out';
  return (r.stderr || r.stdout).trim().split('\n').slice(-6).join('\n') || `exit ${r.code}`;
}

export function createGit(dir: string, bin = 'git'): Git {
  const run = (args: string[], opts: { timeoutMs?: number; input?: string } = {}) => runProc(bin, ['-C', dir, '-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args], { timeoutMs: opts.timeoutMs, input: opts.input });
  return {
    dir,
    run,
    async out(args, opts) {
      const r = await run(args, opts);
      if (r.code !== 0) throw new GitError(`git ${args[0]} failed: ${describeProc(r)}`, r);
      return r.stdout.replace(/\s+$/, '');
    },
    async ok(args) {
      return (await run(args)).code === 0;
    },
  };
}
