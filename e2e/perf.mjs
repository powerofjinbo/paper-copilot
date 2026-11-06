#!/usr/bin/env node
/**
 * Performance run of the REAL stack on a real-size, multi-file paper (fixtures/large-multifile): the built
 * web app served by `paper open` (Fastify + WebSocket + every service, simulated AI with PAPER_FAKE_LLM=1,
 * the lint sidecar when python3 and the skill are present), Chromium driven by Playwright.
 *
 *   node e2e/perf.mjs [--shots DIR] [--work DIR] [--port 4419] [--no-build] [--keep] [--headed] [--json FILE]
 *
 * Measures, for main.tex and sections/results.tex (opened through the workspace store, as the file
 * switcher will do):
 *   open        navigation (main.tex) / file switch (results.tex) until every sentence is decorated
 *   key.js      keydown -> end of the keystroke's task (CodeMirror update, unit mapping, decorations)
 *   key.render  key.js + style recalculation and layout of the editor (forced after the task)
 *   key.slow    Event Timing entries (keydown/keypress/input to next paint) of 50 ms or more
 *   patch       last keystroke -> sentences.patch for the file (server debounce is 300 ms; the budget
 *               is the time after it)
 *   lint.doc    sentences.patch -> lint.update scope 'document' (the server waits 2 s before the pass)
 *   compile     POST /api/compile on the multi-file tree (latexmk), and SyncTeX forward into results.tex
 *   memory      JS heap of the page (CDP Performance.getMetrics) and RSS of the server process group
 *   scroll      frame times while scrolling results.tex from top to bottom
 * and prints a table. Budgets: typing p95 key.render < 16 ms, patch < 500 ms after the debounce,
 * open < 2 s. Exit code 1 if a budget is missed or a check fails.
 *
 * The project is a temp copy of the fixture (sync mode none); screenshots (deviceScaleFactor 1) go to
 * --shots (default $SHOTS_DIR or <tmp>/paper-copilot-perf-shots). Every process the script starts is
 * stopped before it exits; the work dir is removed unless --keep.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const SHOTS = resolve(arg('--shots', process.env.SHOTS_DIR ?? join(tmpdir(), 'paper-copilot-perf-shots')));
const WORK = resolve(arg('--work', '') || mkdtempSync(join(tmpdir(), 'paper-perf-')));
const PORT = Number(arg('--port', '4419'));
const BUILD = !args.includes('--no-build');
const KEEP = args.includes('--keep');
const HEADED = args.includes('--headed');
const JSON_OUT = arg('--json', '');
mkdirSync(SHOTS, { recursive: true });
mkdirSync(WORK, { recursive: true });

const BUDGET = { keyRenderP95: 16, patchAfterDebounce: 500, open: 2000 };
const SEG_DEBOUNCE = 300;

const P = {
  dist: join(WORK, 'web-dist'),
  proj: join(WORK, 'proj'),
  tex: join(WORK, 'proj', 'tex'),
  repo: join(WORK, 'repo'),
  serverLog: join(WORK, 'server.log'),
};
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SKILL = existsSync(join(ROOT, '.skill', 'scripts', 'style_check.py')) ? join(ROOT, '.skill') : null;
const ENV = { ...process.env, PAPER_FAKE_LLM: '1', PAPER_WEB_DIST: P.dist, PAPER_LOG_LEVEL: 'info' };
delete ENV.ANTHROPIC_API_KEY;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', env: ENV, maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${argv.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout || '').slice(0, 800)}`);
  return r;
}

/* ------------------------------------------------------------------------------------ */
/* Processes                                                                             */
/* ------------------------------------------------------------------------------------ */

let server = null;
let serverOut = '';

async function startServer() {
  serverOut = '';
  const child = spawn(process.execPath, [TSX, 'src/cli.ts', 'open', P.proj, '--no-browser', '--port', String(PORT)], {
    cwd: join(ROOT, 'apps', 'server'),
    env: ENV,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server = child;
  const onData = (d) => {
    serverOut += d.toString();
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  for (let i = 0; i < 300; i++) {
    const m = /Open: (http:\/\/\S+)/.exec(serverOut);
    if (m) return m[1];
    if (child.exitCode !== null) throw new Error(`paper open exited (${child.exitCode}):\n${serverOut.slice(-2000)}`);
    await sleep(100);
  }
  throw new Error(`paper open did not print its URL:\n${serverOut.slice(-2000)}`);
}

async function stopServer() {
  const child = server;
  server = null;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* gone */
  }
  const t = await Promise.race([exited.then(() => 'exit'), sleep(15000).then(() => 'timeout')]);
  if (t === 'timeout') {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
    await exited;
  }
}

/** RSS (MB) of the server's process group (tsx runs the server in a child process). */
function serverRssMb() {
  if (!server) return null;
  const r = spawnSync('ps', ['-o', 'rss=', '-g', String(server.pid)], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const kb = r.stdout.split('\n').map((s) => Number(s.trim())).filter((n) => n > 0);
  return kb.length ? Math.max(...kb) / 1024 : null;
}

function buildWeb() {
  run('npx', ['vite', 'build', '--outDir', P.dist, '--emptyOutDir', '--logLevel', 'warn'], { cwd: join(ROOT, 'apps', 'web'), env: { ...ENV, VITE_PAPER_E2E: '1' } });
}

function makeProject() {
  const fx = join(ROOT, 'fixtures', 'large-multifile');
  cpSync(join(fx, 'repo'), P.repo, { recursive: true });
  mkdirSync(P.proj, { recursive: true });
  cpSync(join(fx, 'tex'), P.tex, { recursive: true });
  const argv = ['src/cli.ts', 'init', P.proj, '--repo', P.repo, '--sync', 'none'];
  if (SKILL) argv.push('--skill', SKILL);
  const r = run(process.execPath, [TSX, ...argv], { cwd: join(ROOT, 'apps', 'server') });
  return r.stdout.trim().split('\n').slice(-1)[0];
}

/* ------------------------------------------------------------------------------------ */
/* Measurements                                                                          */
/* ------------------------------------------------------------------------------------ */

const rows = [];
const failures = [];
function row(name, value, unit, budget = null, note = '') {
  const ok = budget === null || value === null || value < budget;
  rows.push({ name, value, unit, budget, ok, note });
  if (!ok) failures.push(`${name}: ${value.toFixed(1)} ${unit} (budget < ${budget})`);
}
const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

let page;
const pc = (fn, a) => page.evaluate(fn, a);
const shot = (name) => page.screenshot({ path: join(SHOTS, `perf-${name}.png`) });

async function waitFor(fn, a, ms, what) {
  try {
    await page.waitForFunction(fn, a, { timeout: ms, polling: 20 });
  } catch {
    throw new Error(`timed out waiting for ${what}`);
  }
}

/** Installed once per page: key timing, Event Timing, a log of server messages with page timestamps. */
function instrument() {
  const perf = (window.__perf = { keys: [], slow: [], msgs: [], frames: [] });
  let t0 = null;
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key.length !== 1 && e.key !== 'Backspace') return;
      t0 = performance.now();
      const start = t0;
      setTimeout(() => {
        const js = performance.now() - start;
        // force style + layout of the editor: what the next frame has to do before it can paint
        const el = document.querySelector('.cm-content');
        if (el) void el.getBoundingClientRect().height;
        perf.keys.push({ at: start, js, render: performance.now() - start });
      }, 0);
    },
    true,
  );
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (['keydown', 'keypress', 'input', 'beforeinput', 'keyup'].includes(e.name)) perf.slow.push({ name: e.name, duration: e.duration });
    }).observe({ type: 'event', durationThreshold: 50, buffered: false });
  } catch {
    /* Event Timing unavailable */
  }
  const api = window.__paper.api;
  for (const type of ['sentences.patch', 'doc.ack', 'lint.update', 'doc.snapshot', 'compile.status']) {
    api.on(type, (m) => perf.msgs.push({ type, at: performance.now(), file: m.file ?? null, scope: m.scope ?? null, n: m.upserts?.length ?? m.units?.length ?? m.flags?.length ?? null, state: m.state ?? null }));
  }
}

async function openMeasured(file) {
  if (file === 'main.tex') {
    const t0 = Date.now();
    await page.goto(URL);
    await waitFor(() => window.__paper?.workspace.getState().units.length > 10 && window.__paper.workspace.getState().connected && document.querySelectorAll('.cm-content .pc-s').length > 5, null, 30000, 'main.tex decorated');
    return Date.now() - t0;
  }
  const t0 = await pc(() => performance.now());
  await pc((f) => window.__paper.workspace.getState().setFile(f), file);
  await waitFor(
    (f) => {
      const ws = window.__paper.workspace.getState();
      return ws.file === f && ws.units.length > 50 && ws.units.every((u) => u.file === f) && document.querySelectorAll('.cm-content .pc-s').length > 5;
    },
    file,
    30000,
    `${file} decorated`,
  );
  return (await pc(() => performance.now())) - t0;
}

/** Put the cursor at the end of the first sentence that starts with `prefix` (prose of the open file). */
async function cursorAfter(prefix) {
  const ok = await pc((p) => {
    const ws = window.__paper.workspace.getState();
    const t = ws.editor.getText();
    const u = ws.units.find((x) => t.slice(x.start, x.end).replace(/\s+/g, ' ').startsWith(p));
    if (!u) return false;
    ws.editor.revealSentence(u.id);
    return true;
  }, prefix);
  if (!ok) throw new Error(`no sentence starting with "${prefix}"`);
  await sleep(200);
  await page.keyboard.press('ArrowRight'); // collapse the selection at the sentence end
  await sleep(100);
}

/** Type a phrase key by key; returns the page time of the last keydown. */
async function typePhrase(text, delay = 40) {
  for (const ch of text) {
    await page.keyboard.type(ch);
    await sleep(delay);
  }
  return pc(() => window.__perf.keys.at(-1)?.at ?? performance.now());
}

async function measureTyping(file, prefix, phrase) {
  await pc(() => {
    window.__perf.keys.length = 0;
    window.__perf.slow.length = 0;
    window.__perf.msgs.length = 0;
  });
  await cursorAfter(prefix);
  const lastKey = await typePhrase(phrase);
  await waitFor(
    ([f, t]) => window.__perf.msgs.some((m) => m.type === 'sentences.patch' && m.file === f && m.at > t),
    [file, lastKey],
    10000,
    `sentences.patch for ${file}`,
  );
  const r = await pc(([f, t]) => {
    const patch = window.__perf.msgs.find((m) => m.type === 'sentences.patch' && m.file === f && m.at > t);
    return { keys: window.__perf.keys.slice(), slow: window.__perf.slow.slice(), patchAt: patch.at, lastKey: t };
  }, [file, lastKey]);
  const js = r.keys.map((k) => k.js);
  const render = r.keys.map((k) => k.render);
  return { n: r.keys.length, jsP50: pct(js, 0.5), jsP95: pct(js, 0.95), renderP50: pct(render, 0.5), renderP95: pct(render, 0.95), renderMax: Math.max(...render), slow: r.slow.length, patch: r.patchAt - r.lastKey, patchAt: r.patchAt };
}

async function heapMb(cdp) {
  await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined);
  const { metrics } = await cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  return { heap: m.JSHeapUsedSize / 1048576, nodes: m.Nodes };
}

async function measureScroll() {
  return pc(async () => {
    const sc = document.querySelector('.cm-scroller');
    const frames = [];
    let last = performance.now();
    const total = sc.scrollHeight - sc.clientHeight;
    sc.scrollTop = 0;
    await new Promise((r) => requestAnimationFrame(r));
    last = performance.now();
    for (let y = 0; y <= total; y += 120) {
      sc.scrollTop = y;
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now();
      frames.push(now - last);
      last = now;
    }
    frames.sort((a, b) => a - b);
    return { frames: frames.length, p50: frames[frames.length >> 1], p95: frames[Math.floor(frames.length * 0.95)], max: frames[frames.length - 1] };
  });
}

/* ------------------------------------------------------------------------------------ */
/* The run                                                                               */
/* ------------------------------------------------------------------------------------ */

let URL = '';

async function main() {
  console.log(`work ${WORK}\nshots ${SHOTS}`);
  if (BUILD) {
    process.stdout.write('building the web app (VITE_PAPER_E2E=1)... ');
    buildWeb();
    console.log('done');
  } else if (!existsSync(join(P.dist, 'index.html'))) throw new Error(`--no-build needs a build in ${P.dist} (use --work with a previous --keep run)`);
  console.log(`project: ${makeProject()}`);
  const tStart = Date.now();
  URL = await startServer();
  const serverStartMs = Date.now() - tStart;
  console.log(`server: ${URL.replace(/token=[^&]+/, 'token=…')} (${serverStartMs} ms)`);

  const browser = await chromium.launch({ headless: !HEADED, args: ['--enable-precise-memory-info'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');

  try {
    row('server start (paper open)', serverStartMs, 'ms', null, 'includes the startup fact scan');
    const openMain = await openMeasured('main.tex');
    await pc(instrument);
    row('open main.tex (navigation -> decorated)', openMain, 'ms', BUDGET.open);
    await shot('01-main');
    const mem1 = await heapMb(cdp);

    const tMain = await measureTyping('main.tex', 'We asked whether a graph-neural-network tracker', ' really');
    row('main.tex keystroke js p95', tMain.jsP95, 'ms', null, `p50 ${tMain.jsP50.toFixed(1)}, ${tMain.n} keys`);
    row('main.tex keystroke render p95', tMain.renderP95, 'ms', BUDGET.keyRenderP95, `p50 ${tMain.renderP50.toFixed(1)}, max ${tMain.renderMax.toFixed(1)}`);
    row('main.tex keystroke -> sentences.patch', tMain.patch, 'ms', null, `server debounce ${SEG_DEBOUNCE} ms`);
    row('main.tex patch after debounce', tMain.patch - SEG_DEBOUNCE, 'ms', BUDGET.patchAfterDebounce);

    const openRes = await openMeasured('sections/results.tex');
    row('open sections/results.tex (file switch -> decorated)', openRes, 'ms', BUDGET.open);
    const units = await pc(() => window.__paper.workspace.getState().units.length);
    await shot('02-results');

    const tRes = await measureTyping('sections/results.tex', 'The gap between the trackers widens with displacement.', ' and at every momentum');
    row('results.tex keystroke js p95', tRes.jsP95, 'ms', null, `p50 ${tRes.jsP50.toFixed(1)}, ${tRes.n} keys, ${units} units`);
    row('results.tex keystroke render p95', tRes.renderP95, 'ms', BUDGET.keyRenderP95, `p50 ${tRes.renderP50.toFixed(1)}, max ${tRes.renderMax.toFixed(1)}`);
    row('results.tex input events >= 50 ms (Event Timing)', tRes.slow + tMain.slow, 'count', 1);
    row('results.tex keystroke -> sentences.patch', tRes.patch, 'ms', null, `server debounce ${SEG_DEBOUNCE} ms`);
    row('results.tex patch after debounce', tRes.patch - SEG_DEBOUNCE, 'ms', BUDGET.patchAfterDebounce);
    await shot('03-typed');

    // lint: the document pass follows the patch after the server's 2 s debounce
    let lintNote = 'sidecar not running';
    let lintMs = null;
    try {
      await waitFor((t) => window.__perf.msgs.some((m) => m.type === 'lint.update' && m.scope === 'document' && m.file === 'sections/results.tex' && m.at > t), tRes.patchAt, 15000, 'document lint');
      lintMs = await pc((t) => window.__perf.msgs.find((m) => m.type === 'lint.update' && m.scope === 'document' && m.file === 'sections/results.tex' && m.at > t).at - t, tRes.patchAt);
      lintNote = 'patch -> lint.update(document); includes the 2 s debounce';
    } catch (e) {
      if (SKILL) failures.push(`lint: ${e.message}`);
    }
    row('lint document pass (flattened \\input tree)', lintMs, 'ms', null, lintNote);

    const scroll = await measureScroll();
    row('scroll results.tex frame p95', scroll.p95, 'ms', null, `${scroll.frames} frames, p50 ${scroll.p50.toFixed(1)}, max ${scroll.max.toFixed(1)}`);

    // compile the multi-file tree; SyncTeX forward from results.tex
    const c = await pc(async () => {
      const t0 = performance.now();
      await window.__paper.api.compile();
      return { ms: performance.now() - t0 };
    });
    await waitFor(() => window.__paper.workspace.getState().compile.state === 'ok', null, 120000, 'compile ok');
    row('compile (latexmk, 5 files)', c.ms, 'ms', null);
    const fwd = await pc(async () => {
      const ws = window.__paper.workspace.getState();
      const t = ws.editor.getText();
      const u = ws.units.find((x) => t.slice(x.start, x.end).startsWith('The signal-trained tracker finds'));
      const t0 = performance.now();
      const box = await window.__paper.api.synctexForward('sections/results.tex', u.line);
      const ms = performance.now() - t0;
      const back = box ? await window.__paper.api.synctexInverse(box.page, box.x + 10, box.y + box.h / 2) : null;
      return { ms, box, back };
    });
    if (!fwd.box || fwd.back?.file !== 'sections/results.tex') failures.push(`synctex: forward ${JSON.stringify(fwd.box)} inverse ${JSON.stringify(fwd.back)}`);
    row('synctex forward (results.tex)', fwd.ms, 'ms', null, `page ${fwd.box?.page}, inverse -> ${fwd.back?.file}:${fwd.back?.line}`);
    await sleep(1500);
    await shot('04-compiled');

    const mem2 = await heapMb(cdp);
    row('page JS heap (main.tex open)', mem1.heap, 'MB', null, `${mem1.nodes} DOM nodes`);
    row('page JS heap (after results.tex, typing, compile)', mem2.heap, 'MB', null, `${mem2.nodes} DOM nodes`);
    const rss = serverRssMb();
    row('server RSS', rss, 'MB', null);
    if (errors.length) failures.push(`page errors: ${errors.slice(0, 3).join(' | ')}`);
  } finally {
    await browser.close().catch(() => undefined);
    await stopServer();
  }
}

function printTable() {
  const w = Math.max(...rows.map((r) => r.name.length));
  console.log(`\n${'measurement'.padEnd(w)}  ${'value'.padStart(9)}        budget   note`);
  for (const r of rows) {
    const v = r.value === null || r.value === undefined ? '—' : r.value.toFixed(r.unit === 'count' ? 0 : 1);
    const b = r.budget === null ? '' : `< ${r.budget}`;
    console.log(`${r.name.padEnd(w)}  ${v.padStart(9)} ${r.unit.padEnd(5)} ${b.padStart(7)} ${r.ok ? '  ' : '!!'} ${r.note}`);
  }
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(rows, null, 1) + '\n');
}

let code = 0;
try {
  await main();
} catch (e) {
  failures.push(e instanceof Error ? e.message : String(e));
  if (serverOut) console.log(serverOut.slice(-1500));
} finally {
  await stopServer();
  printTable();
  if (failures.length) {
    console.log(`\nFAILED (${failures.length}):\n  ${failures.join('\n  ')}`);
    code = 1;
  } else console.log('\nall budgets met');
  if (!KEEP) rmSync(WORK, { recursive: true, force: true });
  else console.log(`kept ${WORK}`);
}
process.exit(code);
