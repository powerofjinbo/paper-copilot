#!/usr/bin/env node
/**
 * Review round 2 (data safety): text typed while the server cannot acknowledge it must never be lost.
 *
 * Real stack: `paper open` (PAPER_FAKE_LLM=1) on a copy of fixtures/large-multifile (main.tex + four \input
 * files), the built web app (VITE_PAPER_E2E=1) in Chromium. Scenarios (A-C checked against the server
 * mirror, GET /api/doc, and the file on disk):
 *
 *  A. server frozen (SIGSTOP, i.e. a busy / paused process: laptop sleep, GC pause, long synchronous pass):
 *     type a marker in main.tex, switch to sections/intro.tex with the file switcher, unfreeze, switch back.
 *  B. server killed (kill -9) while the author types: type a marker, switch file, restart the server,
 *     switch back.
 *  C. server down, type a marker, close the tab: a beforeunload prompt must protect the unsent text.
 *  D. right after a reconnect (within ApiClient's 2 s "reopened" window), switch to a file this page had
 *     open before: the editor must load (the doc.open must not be swallowed).
 *
 * Expected for A and B: the whole marker is in main.tex on the server (and on disk) afterwards.
 *
 *   node apps/web/test/review2/data-unsent-text.mjs --dist <built web app dir> [--shots DIR] [--port 4461]
 *
 * (--dist: a `VITE_PAPER_E2E=1 npx vite build --outDir DIR` of apps/web; built here when omitted.)
 * Exit code 1 when a scenario lost text. Every process it starts is stopped; its temp dir is removed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const PORT = Number(arg('--port', '4461'));
const SHOTS = resolve(arg('--shots', join(tmpdir(), 'paper-review2-shots')));
const WORK = mkdtempSync(join(tmpdir(), 'paper-r2-unsent-'));
const DIST = arg('--dist', join(WORK, 'web-dist'));
mkdirSync(SHOTS, { recursive: true });
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const ENV = { ...process.env, PAPER_FAKE_LLM: '1', PAPER_WEB_DIST: DIST, PAPER_LOG_LEVEL: 'info' };
delete ENV.ANTHROPIC_API_KEY;
const sleep = (t) => new Promise((r) => setTimeout(r, t));
const PROJ = join(WORK, 'proj');
const TEX = join(PROJ, 'tex');

let server = null;
let out = '';
let URL_ = '';
let TOKEN = '';

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', env: ENV, maxBuffer: 64 << 20, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')}: ${(r.stderr || r.stdout).slice(0, 800)}`);
  return r;
}

async function startServer() {
  const mark = out.length;
  const child = spawn(process.execPath, [TSX, 'src/cli.ts', 'open', PROJ, '--no-browser', '--port', String(PORT)], { cwd: join(ROOT, 'apps', 'server'), env: ENV, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server = child;
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 400; i++) {
    const m = /Open: (http:\/\/\S+)/.exec(out.slice(mark));
    if (m) {
      URL_ = m[1];
      TOKEN = new URL(URL_).searchParams.get('token') ?? '';
      return;
    }
    if (child.exitCode !== null) throw new Error(`server exited:\n${out.slice(-2000)}`);
    await sleep(100);
  }
  throw new Error('server did not start');
}

async function stopServer(sig = 'SIGTERM') {
  const c = server;
  server = null;
  if (!c || c.exitCode !== null) return;
  const exited = new Promise((r) => c.once('exit', r));
  try {
    process.kill(-c.pid, 'SIGCONT');
    process.kill(-c.pid, sig);
  } catch {
    /* gone */
  }
  if ((await Promise.race([exited.then(() => 1), sleep(15000).then(() => 0)])) === 0) {
    try {
      process.kill(-c.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
    await exited;
  }
}

async function api(path) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { 'x-paper-token': TOKEN, accept: 'application/json' } });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

const pc = (page, fn, a) => page.evaluate(fn, a);

async function editorReady(page, file) {
  const st = () =>
    pc(page, () => {
      const w = window.__paper?.workspace.getState();
      return JSON.stringify({ file: w?.file, editor: !!w?.editor, connected: w?.connected, units: w?.units.length, status: document.querySelector('[data-testid="editor"]')?.getAttribute('data-status') });
    }).catch((e) => String(e));
  const t = setTimeout(async () => console.log(`  (still waiting for ${file}: ${await st()})`), 20000);
  await page.waitForFunction(
    (f) => {
      const w = window.__paper?.workspace.getState();
      return w && w.file === f && w.editor && w.connected && w.units.length > 0 && document.querySelector('[data-testid="editor"]')?.getAttribute('data-status') === 'ready';
    },
    file,
    { timeout: 30000, polling: 50 },
  ).finally(() => clearTimeout(t));
}

/** Put the cursor at the end of the first prose sentence of the open file. */
async function cursorInProse(page) {
  const id = await pc(page, () => window.__paper.workspace.getState().units.find((u) => u.kind === 'prose')?.id);
  await pc(page, (i) => window.__paper.workspace.getState().editor.revealSentence(i), id);
  await page.keyboard.press('Escape');
  await pc(page, () => document.querySelector('.cm-content')?.focus());
  await page.keyboard.press('ArrowRight');
}

const results = [];
function report(ok, name, detail) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
}

async function main() {
  if (!args.includes('--dist')) {
    process.stdout.write('building the web app... ');
    run('npx', ['vite', 'build', '--outDir', DIST, '--emptyOutDir', '--logLevel', 'warn'], { cwd: join(ROOT, 'apps', 'web'), env: { ...ENV, VITE_PAPER_E2E: '1' } });
    console.log('done');
  }
  cpSync(join(ROOT, 'fixtures', 'large-multifile', 'repo'), join(WORK, 'repo'), { recursive: true });
  mkdirSync(PROJ, { recursive: true });
  cpSync(join(ROOT, 'fixtures', 'large-multifile', 'tex'), TEX, { recursive: true });
  run(process.execPath, [TSX, 'src/cli.ts', 'init', PROJ, '--repo', join(WORK, 'repo'), '--skill', join(ROOT, '.skill'), '--sync', 'none'], { cwd: join(ROOT, 'apps', 'server') });
  await startServer();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(URL_);
    await editorReady(page, 'main.tex');
    await pc(page, () => window.__paper.shell.getState().setLang?.('en'));

    /* ---------------------------------------------------------------- A: frozen server + file switch */
    {
      await cursorInProse(page);
      const marker = ' frozenmarker alpha beta gamma';
      process.kill(-server.pid, 'SIGSTOP');
      await page.keyboard.type(marker, { delay: 15 });
      await sleep(200);
      const local = await pc(page, () => window.__paper.workspace.getState().editor && document.querySelector('.cm-content').innerText);
      await pc(page, () => window.__paper.actions.switchFile('sections/intro.tex'));
      await sleep(500);
      process.kill(-server.pid, 'SIGCONT');
      await editorReady(page, 'sections/intro.tex');
      await sleep(1500);
      await pc(page, () => window.__paper.actions.switchFile('main.tex'));
      await editorReady(page, 'main.tex');
      await sleep(2500);
      const srv = (await api('/api/doc?file=main.tex')).text;
      const disk = readFileSync(join(TEX, 'main.tex'), 'utf8');
      await page.screenshot({ path: join(SHOTS, 'r2-unsent-A.png') });
      const kept = srv.includes(marker.trim());
      const frag = srv.includes(' frozen') ? srv.slice(srv.indexOf(' frozen') - 5, srv.indexOf(' frozen') + 40) : '(no part of the marker)';
      report(kept && disk.includes(marker.trim()), 'A: text typed while the server was busy survives a file switch', `typed ${JSON.stringify(marker)}; editor had it: ${local.includes(marker.trim())}; server now has ${JSON.stringify(frag)}`);
    }

    /* ---------------------------------------------------------------- B: kill -9 + file switch */
    {
      await cursorInProse(page);
      const marker = ' killedmarker delta epsilon zeta';
      await stopServer('SIGKILL');
      await page.waitForFunction(() => !window.__paper.workspace.getState().connected, null, { timeout: 15000 });
      await page.keyboard.type(marker, { delay: 15 });
      await pc(page, () => window.__paper.actions.switchFile('sections/intro.tex'));
      await sleep(300);
      await startServer();
      await editorReady(page, 'sections/intro.tex');
      // more than 2 s after the reconnect (scenario D shows what happens before that)
      await sleep(3000);
      await pc(page, () => window.__paper.actions.switchFile('main.tex'));
      await editorReady(page, 'main.tex');
      await sleep(2500);
      const srv = (await api('/api/doc?file=main.tex')).text;
      await page.screenshot({ path: join(SHOTS, 'r2-unsent-B.png') });
      report(srv.includes(marker.trim()), 'B: text typed while the server was down survives a file switch', `typed ${JSON.stringify(marker)}; server has it: ${srv.includes(marker.trim())}`);
    }

    /* ---------------------------------------------------------------- D: switch file right after a reconnect */
    {
      await stopServer('SIGKILL');
      await page.waitForFunction(() => !window.__paper.workspace.getState().connected, null, { timeout: 15000 });
      await startServer();
      await page.waitForFunction(() => window.__paper.workspace.getState().connected, null, { timeout: 30000, polling: 20 });
      // within 2 s of the reconnect, open a file this page had open before (e.g. a cross-file reveal)
      await sleep(500);
      await pc(page, () => window.__paper.actions.switchFile('sections/intro.tex'));
      let ok = true;
      try {
        await editorReady(page, 'sections/intro.tex');
      } catch {
        ok = false;
      }
      const status = await pc(page, () => document.querySelector('[data-testid="editor"]')?.getAttribute('data-status'));
      await page.screenshot({ path: join(SHOTS, 'r2-unsent-D.png') });
      report(ok, 'D: a file opened right after a reconnect loads', `editor status after 30 s: ${status}`);
      if (!ok) {
        // recover for scenario C: open main.tex again, past the 2 s window
        await pc(page, () => window.__paper.actions.switchFile('main.tex'));
        await editorReady(page, 'main.tex');
      }
    }

    /* ---------------------------------------------------------------- C: close the tab while offline */
    {
      await cursorInProse(page);
      const marker = ' closedmarker eta theta';
      await stopServer('SIGKILL');
      await page.waitForFunction(() => !window.__paper.workspace.getState().connected, null, { timeout: 15000 });
      await page.keyboard.type(marker, { delay: 15 });
      let prompted = false;
      page.on('dialog', async (d) => {
        if (d.type() === 'beforeunload') prompted = true;
        await d.dismiss().catch(() => undefined);
      });
      await page.close({ runBeforeUnload: true });
      await sleep(1000);
      await startServer();
      const srv = (await api('/api/doc?file=main.tex')).text;
      report(prompted || srv.includes(marker.trim()), 'C: closing a tab with unsent text is guarded (beforeunload) or the text survives', `beforeunload prompt: ${prompted}; server has the text: ${srv.includes(marker.trim())}`);
    }
  } finally {
    await browser.close().catch(() => undefined);
    await stopServer('SIGTERM');
    rmSync(WORK, { recursive: true, force: true });
  }
  const bad = results.filter((x) => !x).length;
  console.log(bad ? `${bad} scenario(s) lost text` : 'no text lost');
  process.exit(bad ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  console.error(out.slice(-2000));
  await stopServer('SIGKILL');
  rmSync(WORK, { recursive: true, force: true });
  process.exit(2);
});
