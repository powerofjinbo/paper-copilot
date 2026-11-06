/**
 * Child-process helper for latexmk / synctex / pdftotext: no shell, stdin closed (so TeX can never wait
 * for input), bounded output capture, a hard timeout that kills the whole process group (latexmk spawns
 * pdflatex and bibtex), and ENOENT reported as `missing` instead of an exception.
 */
import { spawn, spawnSync } from 'node:child_process';

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The executable was not found (ENOENT). */
  missing: boolean;
  ms: number;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Keep at most this many characters of each stream (the tail). Default 1 MB. */
  maxOutput?: number;
}

function appendBounded(prev: string, chunk: string, max: number): string {
  const s = prev + chunk;
  return s.length > max ? s.slice(s.length - max) : s;
}

export function runProcess(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const max = opts.maxOutput ?? 1_000_000;
  const t0 = Date.now();
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (r: Omit<RunResult, 'stdout' | 'stderr' | 'timedOut' | 'ms'>) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({ ...r, stdout, stderr, timedOut, ms: Date.now() - t0 });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group, so a timeout can kill latexmk together with pdflatex/bibtex.
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (e) {
      stderr = String(e);
      finish({ code: null, signal: null, missing: (e as NodeJS.ErrnoException).code === 'ENOENT' });
      return;
    }
    const kill = () => {
      try {
        if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, opts.timeoutMs)
      : null;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => (stdout = appendBounded(stdout, d, max)));
    child.stderr?.on('data', (d: string) => (stderr = appendBounded(stderr, d, max)));
    child.on('error', (e: NodeJS.ErrnoException) => {
      stderr = appendBounded(stderr, String(e), max);
      finish({ code: null, signal: null, missing: e.code === 'ENOENT' });
    });
    child.on('close', (code, signal) => finish({ code, signal, missing: false }));
  });
}

/** Synchronous "is this executable on PATH and runnable" probe (used once per service). */
export function probeExecutable(cmd: string, args: string[]): boolean {
  try {
    const r = spawnSync(cmd, args, { stdio: 'ignore', timeout: 10_000, windowsHide: true });
    if (r.error) return false;
    // synctex prints its usage with a non-zero status on some versions; existing is what matters.
    return r.status !== null;
  } catch {
    return false;
  }
}
