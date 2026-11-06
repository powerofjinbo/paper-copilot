#!/usr/bin/env tsx
/**
 * The `paper` command.
 *
 *   paper init <dir> [--tex <dir>] [--repo <dir>] [--skill <dir>] [--venue aps|elsevier|arxiv|springer]
 *                    [--notes zh|en] [--sync git|ols|none] [--remote <url>] [--branch <name>]
 *                    [--main <file>] [--semantic-lines]
 *   paper import <git-url|zip|dir> --to <dir> [init options]
 *   paper open <dir> [--port 4317] [--no-browser] [--dev] [--fake]
 *   paper serve [<dir>]            (open --no-browser --dev; <dir> defaults to $PAPER_PROJECT)
 *   paper pull <dir>
 *   paper push <dir> -m <message>
 *   paper read-repo <dir>
 *   paper semantic-lines <dir> [--undo] [--file <file>]
 *   paper doctor <dir>
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { NotesLanguage, Venue } from '@paper-copilot/core';
import { loadConfig } from './config';
import { createCtx, type AppCtx } from './ctx';
import { paperPaths } from './infra';
import { isTexName, listFiles } from './docs/text';
import { createServer, DEFAULT_PORT } from './server';
import { InitError, initProject, resolveLayout, type InitOptions } from './project/init';
import { importProject } from './project/import';
import { applySemanticLines, undoSemanticLines } from './project/semanticLines';
import { runProc, createGit } from './services/sync/proc';
import { resolveApiKey } from './services/llm/apiKey';
import { SERVER_VERSION } from './version';
import { loadSqlite } from './store/db';

const out = (s = '') => process.stdout.write(s + '\n');
const err = (s: string) => process.stderr.write(s + '\n');

class UsageError extends Error {}

const USAGE = `paper-copilot ${SERVER_VERSION}

Usage:
  paper init <dir> [options]             create .paper for a LaTeX tree (<dir>/tex, or <dir> itself)
  paper import <src> --to <dir> [opts]   clone a git URL / extract a .zip / copy a folder into <dir>/tex
  paper open <dir> [--port N] [--no-browser] [--dev] [--fake]
  paper serve [<dir>]                    run the server for the Vite dev client (no browser)
  paper pull <dir>                       pull co-author changes (git pull --rebase or ols) and re-anchor
  paper push <dir> -m <message>          push reviewed changes (refused while sentences await review)
  paper read-repo <dir>                  run the read-only repository reader
  paper semantic-lines <dir> [--undo] [--file <f>]   one sentence per line (reversible)
  paper doctor <dir>                     check the toolchain and the project

Init/import options:
  --tex <dir> --repo <dir> --skill <dir> --main <file> --venue aps|elsevier|arxiv|springer
  --notes zh|en --sync git|ols|none --remote <url> --branch <name> --semantic-lines
`;

const INIT_OPTIONS = {
  tex: { type: 'string' },
  repo: { type: 'string' },
  skill: { type: 'string' },
  main: { type: 'string' },
  venue: { type: 'string' },
  notes: { type: 'string' },
  sync: { type: 'string' },
  remote: { type: 'string' },
  branch: { type: 'string' },
  name: { type: 'string' },
  'semantic-lines': { type: 'boolean' },
} as const satisfies ParseArgsConfig['options'];

function parse<O extends NonNullable<ParseArgsConfig['options']>>(argv: string[], options: O) {
  try {
    return parseArgs({ args: argv, options: { ...options, help: { type: 'boolean', short: 'h' } }, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
}

function initOptionsOf(v: Record<string, string | boolean | undefined>): InitOptions {
  const o: InitOptions = {};
  if (typeof v.tex === 'string') o.tex = v.tex;
  if (typeof v.repo === 'string') o.repo = v.repo;
  if (typeof v.skill === 'string') o.skill = v.skill;
  if (typeof v.main === 'string') o.main = v.main;
  if (typeof v.name === 'string') o.name = v.name;
  if (typeof v.venue === 'string') {
    const p = Venue.safeParse(v.venue);
    if (!p.success) throw new UsageError(`--venue must be one of ${Venue.options.join(', ')}`);
    o.venue = p.data;
  }
  if (typeof v.notes === 'string') {
    const p = NotesLanguage.safeParse(v.notes);
    if (!p.success) throw new UsageError('--notes must be zh or en');
    o.notes = p.data;
  }
  if (typeof v.sync === 'string') {
    if (!['git', 'ols', 'none'].includes(v.sync)) throw new UsageError('--sync must be git, ols or none');
    o.sync = v.sync as 'git' | 'ols' | 'none';
  }
  if (typeof v.remote === 'string') o.remote = v.remote;
  if (typeof v.branch === 'string') o.branch = v.branch;
  if (v['semantic-lines'] === true) o.semanticLines = true;
  return o;
}

function one(positionals: string[], what: string): string {
  if (positionals.length !== 1) throw new UsageError(`expected exactly one ${what}`);
  return positionals[0]!;
}

/** Hide credentials in a remote URL (Overleaf tokens live there). */
export function maskUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^@/]+)@/i, (_m, scheme: string, cred: string) => `${scheme}${cred.includes(':') ? cred.split(':')[0] + ':***' : cred}@`);
}

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => out(`(could not open a browser; open the URL above yourself)`));
    child.unref();
  } catch {
    out('(could not open a browser; open the URL above yourself)');
  }
}

async function withCtx<T>(dir: string, fn: (ctx: AppCtx) => Promise<T>, opts: { fake?: boolean } = {}): Promise<T> {
  const ctx = await createCtx({ root: resolve(dir), autoInit: false, watch: false, lintSidecar: false, logLevel: (process.env.PAPER_LOG_LEVEL as 'info') || 'warn', fake: opts.fake });
  try {
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

function projectRoot(dir: string): string {
  // accept the LaTeX tree itself as well as the project root
  try {
    return resolveLayout(dir).root;
  } catch {
    return resolve(dir);
  }
}

/* ------------------------------------------------------------------------------------ */
/* Commands                                                                              */
/* ------------------------------------------------------------------------------------ */

async function cmdInit(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, INIT_OPTIONS);
  if (values.help) return (out(USAGE), 0);
  const r = await initProject(one(positionals, 'project folder'), initOptionsOf(values));
  for (const a of r.actions) out(`  ${a}`);
  out(`Project ${r.config.name}: LaTeX tree ${r.config.texRoot}, main file ${r.config.mainFile}, bibliography ${r.config.bibFiles.join(', ') || '(none)'}, sync ${r.config.sync.mode}.`);
  out(`Next: paper open ${r.root}`);
  return 0;
}

async function cmdImport(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { ...INIT_OPTIONS, to: { type: 'string' } });
  if (values.help) return (out(USAGE), 0);
  const src = one(positionals, 'source (git URL, .zip or folder)');
  if (typeof values.to !== 'string') throw new UsageError('--to <dir> is required');
  if (values.tex) throw new UsageError('--tex cannot be used with import (the tree goes to <dir>/tex)');
  const r = await importProject(src, values.to, { ...initOptionsOf(values), interactive: process.stdin.isTTY === true });
  out(`Imported from ${r.source === 'git' ? maskUrl(src) : src} into ${r.config.texRoot}`);
  for (const a of r.actions) out(`  ${a}`);
  out(`Main file ${r.config.mainFile}; bibliography ${r.config.bibFiles.join(', ') || '(none)'}; sync ${r.config.sync.mode}.`);
  out(`Next: paper open ${r.root}`);
  return 0;
}

async function serve(dir: string, o: { port: number; browser: boolean; dev: boolean; fake?: boolean }): Promise<number> {
  const root = projectRoot(dir);
  const ctx = await createCtx({ root, fake: o.fake, autoInit: true });
  await ctx.start();
  let server;
  try {
    server = await createServer({ ctx, port: o.port, dev: o.dev });
  } catch (e) {
    await ctx.close();
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new UsageError(`port ${o.port} is already in use (another paper-copilot?); pass --port <n>`);
    throw e;
  }
  const url = `${server.url}?token=${encodeURIComponent(ctx.token)}`;
  out(`paper-copilot ${SERVER_VERSION}: ${ctx.config.name}${ctx.fakeLlm ? ' (simulated AI: every AI output is labelled as simulated)' : ''}`);
  out(`Open: ${url}`);
  if (o.dev) out(`Dev client: http://127.0.0.1:5173/ (Vite)`);
  if (o.browser) openBrowser(url);
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    out(`\n${signal}: saving open documents...`);
    try {
      await server!.close();
    } finally {
      await ctx.close();
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  return new Promise<number>(() => undefined); // runs until a signal
}

async function cmdOpen(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { port: { type: 'string' }, 'no-browser': { type: 'boolean' }, dev: { type: 'boolean' }, fake: { type: 'boolean' } });
  if (values.help) return (out(USAGE), 0);
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('--port must be a port number');
  return serve(one(positionals, 'project folder'), { port, browser: !values['no-browser'], dev: values.dev === true, fake: values.fake ? true : undefined });
}

async function cmdServe(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { port: { type: 'string' }, fake: { type: 'boolean' } });
  if (values.help) return (out(USAGE), 0);
  const dir = positionals[0] ?? process.env.PAPER_PROJECT;
  if (!dir) throw new UsageError('paper serve needs a project folder: pass it, or set PAPER_PROJECT=<dir> (e.g. PAPER_PROJECT=~/papers/canto pnpm dev)');
  const port = values.port === undefined ? Number(process.env.PAPER_PORT ?? DEFAULT_PORT) : Number(values.port);
  return serve(dir, { port, browser: false, dev: true, fake: values.fake ? true : undefined });
}

async function cmdPull(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {});
  if (values.help) return (out(USAGE), 0);
  return withCtx(projectRoot(one(positionals, 'project folder')), async (ctx) => {
    const reports = await ctx.sync.pull();
    if (reports.length === 0) {
      out('Already up to date.');
      return 0;
    }
    let edited = 0;
    let created = 0;
    let orphaned = 0;
    for (const r of reports) {
      edited += r.edited.length;
      created += r.created.length;
      orphaned += r.orphaned.length;
    }
    out(`Co-authors changed ${edited + created} sentence(s): ${edited} edited, ${created} new (marked external).`);
    if (orphaned) out(`${orphaned} sentence(s) could not be re-anchored; their metadata is kept and listed as orphans in the app.`);
    return 0;
  });
}

async function cmdPush(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { message: { type: 'string', short: 'm' } });
  if (values.help) return (out(USAGE), 0);
  if (typeof values.message !== 'string' || !values.message.trim()) throw new UsageError('-m <message> is required');
  const message = values.message;
  return withCtx(projectRoot(one(positionals, 'project folder')), async (ctx) => {
    // open every .tex file so the push guard sees current units
    for (const f of listFiles(ctx.paths.tex, isTexName)) {
      try {
        await ctx.docs.open(f);
      } catch {
        /* unreadable file: the guard still scans its text */
      }
    }
    const res = await ctx.sync.push(message);
    if (!res.ok) {
      err(res.output);
      for (const b of res.check.blockers.slice(0, 30)) err(`  [${b.kind}] ${b.text}`);
      if (res.check.blockers.length > 30) err(`  ... and ${res.check.blockers.length - 30} more`);
      return 2;
    }
    out(res.output);
    return 0;
  });
}

async function cmdReadRepo(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {});
  if (values.help) return (out(USAGE), 0);
  return withCtx(projectRoot(one(positionals, 'project folder')), async (ctx) => {
    if (!ctx.config.repoDir) throw new UsageError('no analysis repository configured: paper init <dir> --repo <path>');
    const id = ctx.agents.readRepo();
    out(`Reading ${ctx.config.repoDir} (read-only)${ctx.fakeLlm ? ' with the simulated AI' : ''}...`);
    const off = ctx.bus.subscribe((m) => {
      if (m.type === 'job.progress' && m.jobId === id && m.state === 'running' && m.message !== 'running') out(`  ${m.message}`);
    });
    try {
      for (;;) {
        const j = ctx.jobs.get(id);
        if (j && (j.state === 'done' || j.state === 'error')) {
          if (j.state === 'error') {
            err(`Repository reader failed: ${j.message}`);
            return 1;
          }
          out(`Done. Brief: ${ctx.paths.repoBrief}`);
          return 0;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      off();
    }
  });
}

async function cmdSemanticLines(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { undo: { type: 'boolean' }, file: { type: 'string' } });
  if (values.help) return (out(USAGE), 0);
  const root = projectRoot(one(positionals, 'project folder'));
  const config = loadConfig(paperPaths(root));
  if (!config) throw new UsageError(`${root} is not a paper-copilot project (run paper init first)`);
  const paths = paperPaths(root, config.texRoot);
  const files = values.file ? [values.file] : listFiles(paths.tex, isTexName);
  for (const f of files) {
    const r = values.undo ? await undoSemanticLines(paths, f) : await applySemanticLines(paths, f);
    out(values.undo ? `${r.file}: restored ${r.changed} line break(s)${r.skipped ? `, ${r.skipped} left (edited since)` : ''}${r.undoFile ? '' : ' (nothing to undo)'}` : `${r.file}: ${r.changed} sentence(s) moved to their own line`);
  }
  out('Open documents in a running app reload on their own; units keep their ids (only whitespace changed).');
  return 0;
}

async function version(cmd: string, args: string[]): Promise<string | null> {
  const r = await runProc(cmd, args, { timeoutMs: 10_000 });
  if (r.notFound || r.code !== 0) return null;
  return (r.stdout || r.stderr).trim().split('\n')[0] ?? '';
}

async function cmdDoctor(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {});
  if (values.help) return (out(USAGE), 0);
  let problems = 0;
  const line = (status: 'ok' | 'warn' | 'FAIL', what: string, detail = '') => {
    if (status === 'FAIL') problems++;
    out(`  [${status.padEnd(4)}] ${what}${detail ? `: ${detail}` : ''}`);
  };
  out('Toolchain');
  const [maj, min] = process.versions.node.split('.').map(Number);
  line(maj! > 22 || (maj === 22 && min! >= 13) ? 'ok' : 'FAIL', 'node', `${process.versions.node} (>= 22.13 needed)`);
  const sqliteOk = (() => {
    try {
      return !!loadSqlite();
    } catch {
      return false;
    }
  })();
  line(sqliteOk ? 'ok' : 'FAIL', 'node:sqlite');
  const py = await version('python3', ['--version']);
  line(py ? 'ok' : 'warn', 'python3', py ?? 'not found (style_check lint disabled)');
  const lm = await version('latexmk', ['--version']);
  line(lm ? 'ok' : 'warn', 'latexmk', lm ?? 'not found (no PDF preview)');
  const pl = await version('pdflatex', ['--version']);
  line(pl ? 'ok' : 'warn', 'pdflatex', pl ?? 'not found');
  const st = await runProc('synctex', ['help', 'view'], { timeoutMs: 10_000 });
  line(!st.notFound ? 'ok' : 'warn', 'synctex', !st.notFound ? 'found' : 'not found (no PDF<->source jumps)');
  const gv = await version('git', ['--version']);
  line(gv ? 'ok' : 'warn', 'git', gv ?? 'not found (no Overleaf git sync)');
  const ols = await runProc('ols', ['--help'], { timeoutMs: 10_000 });
  line(ols.notFound ? 'warn' : 'ok', 'overleaf-sync (ols)', ols.notFound ? 'not installed (only needed for --sync ols)' : 'found');
  const key = resolveApiKey();
  line(key.key ? 'ok' : 'warn', 'Anthropic API key', key.key ? `found (${key.source === 'env' ? 'ANTHROPIC_API_KEY' : 'OS keychain'})` : 'not found: the AI is simulated (set ANTHROPIC_API_KEY or the keychain entry "paper-copilot")');

  const dir = positionals[0];
  if (dir) {
    out('Project');
    const root = projectRoot(dir);
    const config = (() => {
      try {
        return loadConfig(paperPaths(root));
      } catch (e) {
        line('FAIL', 'project.json', e instanceof Error ? e.message : String(e));
        return null;
      }
    })();
    if (!config) {
      if (problems === 0) line('FAIL', 'project', `${join(root, '.paper', 'project.json')} not found (paper init ${root})`);
    } else {
      line(existsSync(config.texRoot) ? 'ok' : 'FAIL', 'LaTeX tree', config.texRoot);
      line(existsSync(join(config.texRoot, config.mainFile)) ? 'ok' : 'FAIL', 'main file', config.mainFile);
      for (const b of config.bibFiles) line(existsSync(join(config.texRoot, b)) ? 'ok' : 'warn', 'bibliography', b);
      const inside = resolve(join(root, '.paper')).startsWith(resolve(config.texRoot) + '/');
      line(inside ? 'FAIL' : 'ok', 'sidecar outside the synced tree', join(root, '.paper'));
      const skillOk = existsSync(join(config.skillDir, 'SKILL.md'));
      line(skillOk ? 'ok' : 'warn', 'hep-paper-writing skill', skillOk ? config.skillDir : `no SKILL.md in ${config.skillDir}`);
      if (skillOk) line(existsSync(join(config.skillDir, 'scripts', 'style_check.py')) ? 'ok' : 'warn', 'style_check.py', join(config.skillDir, 'scripts', 'style_check.py'));
      if (config.repoDir) line(existsSync(config.repoDir) ? 'ok' : 'warn', 'analysis repository', config.repoDir);
      else line('warn', 'analysis repository', 'not configured (paper init <dir> --repo <path>)');
      if (config.sync.mode === 'git') {
        const g = createGit(config.texRoot);
        const inside = await g.run(['rev-parse', '--is-inside-work-tree']);
        if (inside.code !== 0) line('FAIL', 'git sync', `${config.texRoot} is not a git clone`);
        else {
          const remotes = (await g.run(['remote', '-v'])).stdout.split('\n').filter((l) => l.endsWith('(push)'));
          line(remotes.length ? 'ok' : 'FAIL', 'git remote', remotes.length ? remotes.map((r) => maskUrl(r.split(/\s+/)[1] ?? '')).join(', ') : 'none');
          const ident = (await g.run(['config', 'user.email'])).stdout.trim();
          line(ident ? 'ok' : 'warn', 'git identity', ident ? 'configured' : 'set git config user.name / user.email before pushing');
        }
      } else line('ok', 'sync', config.sync.mode);
    }
  }
  out(problems ? `${problems} problem(s).` : 'All required checks passed.');
  return problems ? 1 : 0;
}

/* ------------------------------------------------------------------------------------ */

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'init':
        return await cmdInit(rest);
      case 'import':
        return await cmdImport(rest);
      case 'open':
        return await cmdOpen(rest);
      case 'serve':
        return await cmdServe(rest);
      case 'pull':
        return await cmdPull(rest);
      case 'push':
        return await cmdPush(rest);
      case 'read-repo':
        return await cmdReadRepo(rest);
      case 'semantic-lines':
        return await cmdSemanticLines(rest);
      case 'doctor':
        return await cmdDoctor(rest);
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        out(USAGE);
        return 0;
      case '--version':
      case 'version':
        out(SERVER_VERSION);
        return 0;
      default:
        throw new UsageError(`unknown command: ${cmd}`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      err(`paper: ${e.message}\n\n${USAGE}`);
      return 64;
    }
    if (e instanceof InitError) {
      err(`paper: ${e.message}`);
      return 1;
    }
    const status = (e as { status?: number }).status;
    err(`paper: ${e instanceof Error ? e.message : String(e)}`);
    return status && status < 500 ? 1 : 70;
  }
}

const isMain = (() => {
  const a = process.argv[1];
  if (!a) return false;
  try {
    return resolve(a) === resolve(new URL(import.meta.url).pathname) || /[\\/]cli\.(ts|js|mjs)$/.test(a);
  } catch {
    return false;
  }
})();

if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== 0 || !['open', 'serve'].includes(process.argv[2] ?? '')) process.exit(code);
    },
    (e) => {
      err(String(e));
      process.exit(70);
    },
  );
}
