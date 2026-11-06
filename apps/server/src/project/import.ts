/**
 * `paper import <src> --to <dir>`: bring a LaTeX tree into <dir>/tex and initialise the project.
 *
 * Sources: a git URL (Overleaf git bridge: `git clone` into <dir>/tex; sync mode git with that remote),
 * a .zip (Overleaf "Download source"; extracted with Python's zipfile, which refuses absolute and `..`
 * member paths; a single top-level folder is unwrapped, __MACOSX dropped), or a local folder (copied,
 * including its .git so an existing clone keeps syncing; .paper and node_modules are skipped).
 * Then the main file and .bib files are detected and `initProject` runs (optionally with semantic lines).
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { runProc, syncEnv } from '../services/sync/proc';
import { initProject, InitError, type InitOptions, type InitResult } from './init';

export type ImportSource = 'git' | 'zip' | 'dir';

export function sourceKind(src: string): ImportSource {
  if (/^(https?:\/\/|ssh:\/\/|git:\/\/|git@[^:]+:)/i.test(src) || (/\.git$/i.test(src) && !existsSync(src))) return 'git';
  if (/\.zip$/i.test(src) && existsSync(src) && statSync(src).isFile()) return 'zip';
  if (existsSync(src) && statSync(src).isDirectory()) return 'dir';
  throw new InitError(`cannot import ${src}: not a git URL, a .zip file or a folder`);
}

function isEmptyDir(d: string): boolean {
  return !existsSync(d) || (statSync(d).isDirectory() && readdirSync(d).length === 0);
}

function inside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
}

/** git clone; interactive (terminal) runs may prompt for Overleaf credentials. */
export function gitClone(url: string, dest: string, interactive: boolean): Promise<void> {
  return new Promise((resolveP, reject) => {
    const env = interactive ? { ...syncEnv(), GIT_TERMINAL_PROMPT: '1' } : syncEnv();
    const child = spawn('git', ['clone', '--', url, dest], { stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'], env });
    let err = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => (err += d));
    child.on('error', (e) => reject(new InitError(`git clone failed: ${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolveP() : reject(new InitError(`git clone failed (exit ${code})${err ? `: ${err.trim().split('\n').slice(-3).join(' ')}` : ''}`))));
  });
}

/** Extract a zip safely into `dest` (created), unwrapping a single top-level folder. */
export async function extractZip(zip: string, dest: string): Promise<void> {
  const tmp = mkdtempSync(join(resolve(dest, '..'), '.paper-import-'));
  try {
    let r = await runProc('python3', ['-I', '-m', 'zipfile', '-e', resolve(zip), tmp], { timeoutMs: 300_000 });
    if (r.notFound) r = await runProc('unzip', ['-q', '-o', resolve(zip), '-d', tmp], { timeoutMs: 300_000 });
    if (r.code !== 0) throw new InitError(`cannot extract ${zip}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ') || (r.notFound ? 'python3 and unzip are not installed' : `exit ${r.code}`)}`);
    rmSync(join(tmp, '__MACOSX'), { recursive: true, force: true });
    // drop symlinks defensively (python's zipfile does not create them; unzip can)
    const walk = (d: string): void => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        const st = lstatSync(p);
        if (st.isSymbolicLink()) rmSync(p, { force: true });
        else if (st.isDirectory()) walk(p);
      }
    };
    walk(tmp);
    const entries = readdirSync(tmp).filter((e) => e !== '.DS_Store');
    const top = entries.length === 1 && statSync(join(tmp, entries[0]!)).isDirectory() ? join(tmp, entries[0]!) : tmp;
    rmSync(dest, { recursive: true, force: true });
    renameSync(top, dest);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export interface ImportOptions extends InitOptions {
  /** Allow git to prompt for credentials on the terminal (CLI). */
  interactive?: boolean;
}

export async function importProject(src: string, to: string, opts: ImportOptions = {}): Promise<InitResult & { source: ImportSource }> {
  const root = resolve(to);
  const tex = join(root, 'tex');
  if (existsSync(join(root, '.paper', 'project.json'))) throw new InitError(`${root} is already a paper-copilot project`);
  if (!isEmptyDir(tex)) throw new InitError(`${tex} already exists and is not empty`);
  const kind = sourceKind(src);
  mkdirSync(root, { recursive: true });
  const extra: InitOptions = {};
  if (kind === 'git') {
    await gitClone(src, tex, opts.interactive ?? false);
    extra.sync = opts.sync ?? 'git';
    extra.remote = opts.remote ?? src;
  } else if (kind === 'zip') {
    await extractZip(src, tex);
  } else {
    const from = resolve(src);
    if (inside(root, from)) throw new InitError(`the project folder ${root} must not be inside the source ${from}`);
    if (inside(from, root)) throw new InitError(`the source ${from} must not be inside the project folder ${root}`);
    cpSync(from, tex, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      filter: (p) => {
        const rel = relative(from, p);
        if (!rel) return true;
        const parts = rel.split(sep);
        return !parts.some((x) => x === '.paper' || x === 'node_modules' || x === '__MACOSX');
      },
    });
  }
  const result = await initProject(root, { ...opts, ...extra, tex });
  return { ...result, source: kind };
}
