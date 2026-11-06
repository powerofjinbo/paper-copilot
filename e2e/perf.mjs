#!/usr/bin/env node
/**
 * Performance run of the REAL stack on a real-size, multi-file paper (fixtures/large-multifile): the built
 * web app served by `paper open` (Fastify + WebSocket + every service, simulated AI with PAPER_FAKE_LLM=1,
 * the lint sidecar when python3 and the skill are present), Chromium driven by Playwright.
 *
 *   node e2e/perf.mjs [--shots DIR] [--work DIR] [--port 4419] [--no-build] [--keep] [--headed] [--json FILE]
 *                     [--stress K]   (sections/results.tex repeated K times: a thesis-size file, for profiling)
 *
 * Measures, for main.tex and sections/results.tex (opened through the workspace store, as the file
 * switcher will do):
 *   open        navigation (main.tex) / file switch (results.tex) until every sentence is decorated
 *   key.update  EditorView.update of the keystroke's transaction (state fields, unit mapping, view
 *               plugins, decorations, DOM sync), timed by wrapping the live view
 *   key.render  key.update + CodeMirror's measure pass before the next frame (layout read and write);
 *               also keydown -> end of the update (input queueing included)
 *   key.slow    Event Timing entries (keydown/keypress/input to next paint) of 50 ms or more
 *   patch       last keystroke -> sentences.patch for the file (server debounce is 300 ms; the budget
 *               is the time after it)
 *   lint.doc    sentences.patch -> lint.update scope 'document' (the server waits 2 s before the pass)
 *   compile     POST /api/compile on the multi-file tree (latexmk), and SyncTeX forward into results.tex
 *   memory      JS heap of the page (CDP Performance.getMetrics) and RSS of the server process group
 *   scroll      frame times while scrolling results.tex from top to bottom
 * and prints a table. Budgets: typing p95 key.render < 16 ms (one frame), patch < 500 ms after the debounce,
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
const STRESS = Math.max(1, Number(arg('--stress', '1')) || 1);
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
  // a fresh project every run (a --work dir kept from an earlier run holds its .paper sidecar)
  rmSync(P.proj, { recursive: true, force: true });
  rmSync(P.repo, { recursive: true, force: true });
  cpSync(join(fx, 'repo'), P.repo, { recursive: true });
  mkdirSync(P.proj, { recursive: true });
  cpSync(join(fx, 'tex'), P.tex, { recursive: true });
  if (STRESS > 1) {
    // --stress K: sections/results.tex repeated K times (labels made unique), a thesis-size file
    const f = join(P.tex, 'sections', 'results.tex');
    const src = readFileSync(f, 'utf8');
    const copies = [src];
    for (let k = 2; k <= STRESS; k++) copies.push(src.replace(/\\label\{([^}]*)\}/g, `\\label{$1-${k}}`).replace(/^(.*\S.*)$/gm, (l) => (/^\s*[\\%]/.test(l) ? l : l.replace(/\. ([A-Z])/, `. In copy ${k}, $1`))));
    writeFileSync(f, copies.join('\n'));
  }
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

/** Installed once per page: Event Timing and a log of server messages with page timestamps. */
function instrument() {
  const perf = (window.__perf = { keys: [], slow: [], msgs: [], lastKeyAt: null });
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key.length === 1 || e.key === 'Backspace') perf.lastKeyAt = performance.now();
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

/**
 * Time the editor's own work per keystroke (installed on each new EditorView: a file switch makes one).
 * `update` = EditorView.update for a doc-changing transaction (state fields, unit mapping, view plugins,
 * decorations, DOM sync); `measure` = the layout read/write pass CodeMirror runs before the next frame.
 * `latency` = keydown -> end of that update (queueing included). Wall time of the JS, not of the paint.
 */
function instrumentView() {
  const content = document.querySelector('.cm-content');
  const view = content?.cmTile?.root?.view;
  if (!view) throw new Error('EditorView not found');
  if (view.__perfWrapped) return;
  view.__perfWrapped = true;
  const perf = window.__perf;
  let open = null;
  const update = view.update.bind(view);
  view.update = (trs) => {
    const doc = trs.some((t) => t.docChanged);
    const t0 = performance.now();
    update(trs);
    const t1 = performance.now();
    if (doc) {
      open = { at: perf.lastKeyAt ?? t0, update: t1 - t0, measure: 0, latency: perf.lastKeyAt !== null ? t1 - perf.lastKeyAt : null };
      perf.keys.push(open);
    }
  };
  const measure = view.measure.bind(view);
  view.measure = (flush) => {
    const t0 = performance.now();
    measure(flush);
    if (open) open.measure += performance.now() - t0;
  };
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
  await sleep(50);
  return pc(() => window.__perf.lastKeyAt);
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
  const js = r.keys.map((k) => k.update);
  const render = r.keys.map((k) => k.update + k.measure);
  const lat = r.keys.map((k) => k.latency).filter((x) => x !== null);
  return { n: r.keys.length, jsP50: pct(js, 0.5), jsP95: pct(js, 0.95), renderP50: pct(render, 0.5), renderP95: pct(render, 0.95), renderMax: Math.max(...render), latP95: pct(lat, 0.95), slow: r.slow.length, patch: r.patchAt - r.lastKey, patchAt: r.patchAt };
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
    await pc(instrumentView);
    row('open main.tex (navigation -> decorated)', openMain, 'ms', BUDGET.open);
    await shot('01-main');
    const mem1 = await heapMb(cdp);

    const tMain = await measureTyping('main.tex', 'We asked whether a graph-neural-network tracker', ' really');
    row('main.tex keystroke update p95', tMain.jsP95, 'ms', null, `p50 ${tMain.jsP50.toFixed(2)}, ${tMain.n} keys; keydown->updated p95 ${tMain.latP95?.toFixed(1)}`);
    row('main.tex keystroke update+measure p95', tMain.renderP95, 'ms', BUDGET.keyRenderP95, `p50 ${tMain.renderP50.toFixed(2)}, max ${tMain.renderMax.toFixed(1)}`);
    row('main.tex keystroke -> sentences.patch', tMain.patch, 'ms', null, `server debounce ${SEG_DEBOUNCE} ms`);
    row('main.tex patch after debounce', tMain.patch - SEG_DEBOUNCE, 'ms', BUDGET.patchAfterDebounce);

    const openRes = await openMeasured('sections/results.tex');
    row('open sections/results.tex (file switch -> decorated)', openRes, 'ms', BUDGET.open);
    await pc(instrumentView);
    const units = await pc(() => window.__paper.workspace.getState().units.length);
    await shot('02-results');

    const tRes = await measureTyping('sections/results.tex', 'The gap between the trackers widens with displacement.', ' and at every momentum');
    row('results.tex keystroke update p95', tRes.jsP95, 'ms', null, `p50 ${tRes.jsP50.toFixed(2)}, ${tRes.n} keys, ${units} units; keydown->updated p95 ${tRes.latP95?.toFixed(1)}`);
    row('results.tex keystroke update+measure p95', tRes.renderP95, 'ms', BUDGET.keyRenderP95, `p50 ${tRes.renderP50.toFixed(2)}, max ${tRes.renderMax.toFixed(1)}`);
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

    // compile the multi-file tree from scratch (the save after typing schedules one; a manual compile
    // right after it finds latexmk up to date, so the first running -> ok span is the real cost)
    const c = await pc(async () => {
      const t0 = performance.now();
      await window.__paper.api.compile();
      return { ms: performance.now() - t0 };
    });
    await waitFor(() => window.__paper.workspace.getState().compile.state === 'ok', null, 120000, 'compile ok');
    const spans = await pc(() => {
      const out = [];
      let start = null;
      for (const m of window.__perf.msgs) {
        if (m.type !== 'compile.status') continue;
        if (m.state === 'running') start = m.at;
        else if (start !== null && (m.state === 'ok' || m.state === 'error')) {
          out.push(m.at - start);
          start = null;
        }
      }
      return out;
    });
    row('compile (latexmk, 5 files, POST -> status)', c.ms, 'ms', null, spans.length ? `running -> ok spans: ${spans.map((x) => x.toFixed(0)).join(', ')} ms` : '');
    const fwd = await pc(async () => {
      const ws = window.__paper.workspace.getState();
      const t = ws.editor.getText();
      const u = ws.units.find((x) => t.slice(x.start, x.end).replace(/\s+/g, ' ').startsWith('The signal-trained tracker finds'));
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
