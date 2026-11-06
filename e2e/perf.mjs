#!/usr/bin/env node
/**
 * Performance run of the REAL stack on the real-size multi-file paper (fixtures/large-multifile): the
 * built web app served by `paper open` (simulated AI, PAPER_FAKE_LLM=1, the real lint sidecar when the
 * skill is present, latexmk), Chromium driven by Playwright. Measures what the author feels:
 *
 *   open          navigation -> main.tex decorated; switch to sections/results.tex -> decorated
 *                 (there is no file switcher yet: the workspace store's setFile, as the switcher will)
 *   render        keystroke -> rendered in the editor: one CodeMirror transaction as typing makes it,
 *                 its synchronous DOM update and forced layout, plus CodeMirror's measure phase in the
 *                 next frame (budget p95 < 16 ms: one frame)
 *   keys          real key events (Playwright keyboard.type): keydown -> keyup handling time, and long
 *                 animation frames (> 50 ms) while typing
 *   patch         last keystroke -> sentences.patch for the typed sentence, minus the server's 300 ms
 *                 segmentation debounce (budget < 500 ms)
 *   lint-document segmentation pass -> lint.update (scope document), minus the 2 s lint debounce
 *   compile       api.compile() -> compile.status ok (latexmk, multi-file, the PDF pane renders it)
 *   scroll        frame intervals while scrolling results.tex top to bottom
 *   memory        JS heap (CDP Performance.getMetrics after a GC) and DOM nodes
 *
 *   node e2e/perf.mjs [--shots DIR] [--work DIR] [--port 4419] [--no-build] [--keep] [--headed] [--json FILE]
 *
 * Prints a table; exit code 1 if a budget is missed, 2 on a crash. Every process it starts is stopped and
 * the temp work dir is removed (unless --keep). Screenshots (deviceScaleFactor 1) go to --shots (default
 * <work>/shots, removed with the work dir).
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
const WORK = resolve(arg('--work', '') || mkdtempSync(join(tmpdir(), 'paper-perf-')));
const SHOTS = resolve(arg('--shots', process.env.SHOTS_DIR ?? join(WORK, 'shots')));
const PORT = Number(arg('--port', '4419'));
const BUILD = !args.includes('--no-build');
const KEEP = args.includes('--keep');
const HEADED = args.includes('--headed');
const JSON_OUT = arg('--json', '');
mkdirSync(SHOTS, { recursive: true });
mkdirSync(WORK, { recursive: true });

const FX = join(ROOT, 'fixtures', 'large-multifile');
const RESULTS = 'sections/results.tex';
const SEG_DEBOUNCE_MS = 300; // docService default
const LINT_DEBOUNCE_MS = 2000; // lintService default
const P = {
  dist: join(WORK, 'web-dist'),
  proj: join(WORK, 'proj'),
  tex: join(WORK, 'proj', 'tex'),
  repo: join(WORK, 'repo'),
  serverLog: join(WORK, 'server.log'),
};
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const ENV = { ...process.env, PAPER_FAKE_LLM: '1', PAPER_WEB_DIST: P.dist, PAPER_LOG_LEVEL: 'info' };
delete ENV.ANTHROPIC_API_KEY;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', env: ENV, maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${argv.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout || '').slice(0, 800)}`);
  return r;
}
const paper = (...a) => run(process.execPath, [TSX, 'src/cli.ts', ...a], { cwd: join(ROOT, 'apps', 'server') });

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
    try {
      writeFileSync(P.serverLog, serverOut);
    } catch {
      /* ignore */
    }
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

async function stopServer(signal = 'SIGTERM') {
  const child = server;
  server = null;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  try {
    process.kill(-child.pid, signal);
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

function buildWeb() {
  run('npx', ['vite', 'build', '--outDir', P.dist, '--emptyOutDir', '--logLevel', 'warn'], { cwd: join(ROOT, 'apps', 'web'), env: { ...ENV, VITE_PAPER_E2E: '1' } });
}

function makeProject() {
  cpSync(join(FX, 'repo'), P.repo, { recursive: true });
  mkdirSync(P.proj, { recursive: true });
  cpSync(join(FX, 'tex'), P.tex, { recursive: true });
  const skill = join(ROOT, '.skill');
  const r = paper('init', P.proj, '--repo', P.repo, ...(existsSync(join(skill, 'scripts', 'style_check.py')) ? ['--skill', skill] : []));
  return r.stdout.trim().split('\n').slice(-2).join(' | ');
}

/* ------------------------------------------------------------------------------------ */
/* Measurements                                                                          */
/* ------------------------------------------------------------------------------------ */

const rows = [];
let failed = 0;
const q = (xs, p) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : String(x));
/** One table row; `budget` is an upper bound (null: reported only). */
function row(metric, value, unit, budget = null, note = '') {
  const ok = budget === null || (Number.isFinite(value) && value < budget);
  if (!ok) failed++;
  rows.push({ metric, value: Number.isFinite(value) ? Number(value.toFixed(2)) : value, unit, budget, ok, note });
  console.log(`${ok ? 'ok  ' : 'MISS'}  ${metric.padEnd(44)} ${String(f1(value)).padStart(9)} ${unit.padEnd(3)} ${budget === null ? '' : `< ${budget}`}${note ? `   ${note}` : ''}`);
}

let page;
const pc = (fn, a) => page.evaluate(fn, a);

async function waitFor(fn, a, ms, what) {
  try {
    await page.waitForFunction(fn, a, { timeout: ms, polling: 'raf' });
  } catch {
    throw new Error(`timed out waiting for ${what}`);
  }
}

/** JS heap and DOM size after a forced GC (CDP). */
async function memory(cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  return { heapMb: m.JSHeapUsedSize / 1048576, nodes: m.Nodes, listeners: m.JSEventListeners };
}

/** In-page recorder of server messages (ws) with receive timestamps. */
async function installRecorder() {
  await pc(() => {
    const w = window;
    if (w.__perf) return;
    w.__perf = { msgs: [], keys: [], laf: [] };
    const api = w.__paper.api;
    for (const type of ['sentences.patch', 'doc.ack', 'lint.update', 'compile.status', 'doc.snapshot']) {
      api.on(type, (m) => w.__perf.msgs.push({ type, t: performance.now(), file: m.file ?? null, version: m.version ?? null, scope: m.scope ?? null, state: m.state ?? null, upserts: m.upserts ? m.upserts.length : null, n: m.flags ? m.flags.length : null }));
    }
    addEventListener('keydown', (e) => w.__perf.keys.push({ k: 'down', t: performance.now(), key: e.key }), true);
    addEventListener('keyup', (e) => w.__perf.keys.push({ k: 'up', t: performance.now(), key: e.key }), true);
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) w.__perf.laf.push({ t: e.startTime, d: e.duration, block: e.blockingDuration ?? 0 });
      }).observe({ type: 'long-animation-frame', buffered: false });
    } catch {
      /* no LoAF in this browser */
    }
  });
}

async function openTimes() {
  // Navigation -> main.tex decorated (performance.now() counts from the navigation start).
  await page.goto(SERVER_URL);
  await waitFor(() => {
    const ws = window.__paper?.workspace.getState();
    return !!ws && ws.connected && ws.units.length > 15 && ws.units.every((u) => u.file === 'main.tex') && document.querySelectorAll('.cm-content .pc-s').length > 5;
  }, null, 30000, 'main.tex decorated');
  const mainMs = await pc(() => performance.now());
  await installRecorder();
  await sleep(500);
  await page.screenshot({ path: join(SHOTS, 'perf-01-main.png') });
  row('open main.tex (navigation -> decorated)', mainMs, 'ms', 2000);

  // Switch to sections/results.tex the way a file switcher does (workspace.setFile).
  const t0 = await pc((f) => {
    window.__perfT0 = performance.now();
    window.__paper.workspace.getState().setFile(f);
    return window.__perfT0;
  }, RESULTS);
  await waitFor((f) => {
    const ws = window.__paper.workspace.getState();
    return ws.units.length > 150 && ws.units.every((u) => u.file === f) && document.querySelectorAll('.cm-content .pc-s').length > 5 && !!ws.editor;
  }, RESULTS, 20000, `${RESULTS} decorated`);
  const resMs = (await pc(() => performance.now())) - t0;
  row(`open ${RESULTS} (setFile -> decorated)`, resMs, 'ms', 2000);
  await sleep(800);
  await page.screenshot({ path: join(SHOTS, 'perf-02-results.png') });
  return { mainMs, resMs };
}

/** Put the cursor right after a sentence of the open file (by its text). */
async function cursorAfter(sentence) {
  const ok = await pc((s) => {
    const view = document.querySelector('.cm-content').cmTile.root.view;
    const text = view.state.doc.toString();
    // the source may be hard-wrapped: any run of whitespace in the sentence matches any other
    const re = new RegExp(s.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
    const m = re.exec(text);
    if (!m) return false;
    view.dispatch({ selection: { anchor: m.index + m[0].length }, scrollIntoView: true });
    view.focus();
    return true;
  }, sentence);
  if (!ok) throw new Error(`sentence not found: ${sentence}`);
  await sleep(300);
}

async function localRender(n) {
  await cursorAfter('Improving the graph would raise both trackers by the same amount, so it would not change the comparison.');
  const r = await pc(async (n) => {
    const view = document.querySelector('.cm-content').cmTile.root.view;
    const words = ' Graph construction itself is not a bottleneck on the processors we used.';
    const sync = [];
    const frame = [];
    const total = [];
    const raf = () => new Promise((res) => requestAnimationFrame(() => res(performance.now())));
    for (let i = 0; i < n; i++) {
      const ch = words[i % words.length];
      const pos = view.state.selection.main.head;
      let before = 0;
      requestAnimationFrame(() => {
        before = performance.now();
      });
      const t0 = performance.now();
      view.dispatch({ changes: { from: pos, insert: ch }, selection: { anchor: pos + 1 }, userEvent: 'input.type', scrollIntoView: true });
      void view.contentDOM.getBoundingClientRect().height; // style + layout of the update, synchronously
      const t1 = performance.now();
      const after = await raf(); // CodeMirror's measure phase runs between our two frame callbacks
      sync.push(t1 - t0);
      frame.push(after - before);
      total.push(t1 - t0 + (after - before));
      if (i % 37 === 36) await new Promise((res) => setTimeout(res, 120)); // pauses, like a typist
    }
    return { sync, frame, total, units: window.__paper.workspace.getState().units.length };
  }, n);
  row('render: keystroke -> rendered, p50', q(r.total, 0.5), 'ms', null, `${n} transactions`);
  row('render: keystroke -> rendered, p95', q(r.total, 0.95), 'ms', 16);
  row('render: keystroke -> rendered, max', Math.max(...r.total), 'ms', null, `sync p95 ${f1(q(r.sync, 0.95))}, measure p95 ${f1(q(r.frame, 0.95))}`);
  return r;
}

async function realTyping() {
  // a fresh sentence after the timing paragraph (the transactions above typed elsewhere)
  await cursorAfter('The timing would allow the pipeline to run in a software trigger, but we have not optimized it for that purpose.');
  await pc(() => {
    window.__perf.keys.length = 0;
    window.__perf.laf.length = 0;
    window.__perf.msgs.length = 0;
  });
  const sentence = ' The batch size was not tuned for speed either.';
  await page.keyboard.type(sentence, { delay: 45 });
  const lastKey = await pc(() => window.__perf.keys.filter((k) => k.k === 'down').at(-1).t);
  // the patch that contains the typed sentence (its text is in the editor; the unit spans it)
  await waitFor((s) => {
    const ws = window.__paper.workspace.getState();
    const t = ws.editor.getText();
    const at = t.indexOf(s.trim());
    return at >= 0 && ws.units.some((u) => u.start === at && u.end === at + s.trim().length);
  }, sentence, 10000, 'a unit for the typed sentence');
  const r = await pc((lastKey) => {
    const p = window.__perf;
    const patches = p.msgs.filter((m) => m.type === 'sentences.patch' && m.t > lastKey);
    const first = patches[0];
    const downs = p.keys.filter((k) => k.k === 'down');
    const ups = p.keys.filter((k) => k.k === 'up');
    const handle = downs.map((d, i) => (ups[i] ? ups[i].t - d.t : NaN)).filter(Number.isFinite);
    return { patchAt: first ? first.t : null, handle, laf: p.laf.filter((x) => x.d > 50), acks: p.msgs.filter((m) => m.type === 'doc.ack').length };
  }, lastKey);
  row('keys: keydown -> keyup handled, p95', q(r.handle, 0.95), 'ms', null, `${r.handle.length} keys, ${r.acks} doc.ack`);
  row('keys: long animation frames while typing', r.laf.length, '', 1, r.laf.length ? `longest ${f1(Math.max(...r.laf.map((x) => x.d)))} ms` : '');
  const patchMs = r.patchAt === null ? NaN : r.patchAt - lastKey - SEG_DEBOUNCE_MS;
  row('patch: last key -> sentences.patch - debounce', patchMs, 'ms', 500, `debounce ${SEG_DEBOUNCE_MS} ms`);
  await page.screenshot({ path: join(SHOTS, 'perf-03-typed.png') });
  return { lastKey, patchAt: r.patchAt };
}

async function lintDocument(patchAt) {
  try {
    await waitFor((after) => window.__perf.msgs.some((m) => m.type === 'lint.update' && m.scope === 'document' && m.t > after), patchAt, 15000, 'document lint');
  } catch (e) {
    row('lint-document: pass duration', NaN, 'ms', null, 'no document pass (no sidecar?)');
    return;
  }
  const r = await pc((after) => {
    const ups = window.__perf.msgs.filter((m) => m.type === 'lint.update' && m.scope === 'document' && m.t > after);
    return { t: ups[0].t, files: [...new Set(ups.map((u) => u.file))], flags: ups.reduce((a, u) => a + (u.n ?? 0), 0) };
  }, patchAt);
  row('lint-document: patch -> lint.update - debounce', r.t - patchAt - LINT_DEBOUNCE_MS, 'ms', 1500, `debounce ${LINT_DEBOUNCE_MS} ms; ${r.files.length} files, ${r.flags} flags`);
}

async function compile() {
  const t0 = await pc(() => performance.now());
  await pc(() => window.__paper.api.compile());
  await waitFor((t0) => window.__perf.msgs.some((m) => m.type === 'compile.status' && (m.state === 'ok' || m.state === 'error') && m.t > t0), t0, 180000, 'compile');
  const r = await pc((t0) => window.__perf.msgs.find((m) => m.type === 'compile.status' && (m.state === 'ok' || m.state === 'error') && m.t > t0), t0);
  row('compile: api.compile -> compile.status ok', r.t - t0, 'ms', 60000, r.state);
  if (r.state !== 'ok') failed++;
  // the PDF pane draws the pages
  try {
    await waitFor(() => document.querySelectorAll('.pdf-pane canvas, [data-testid="pdf"] canvas, canvas').length > 0, null, 15000, 'a PDF page canvas');
  } catch {
    /* reported via the screenshot */
  }
  await sleep(1200);
  await page.screenshot({ path: join(SHOTS, 'perf-04-compiled.png') });
}

async function scroll() {
  const r = await pc(async () => {
    const view = document.querySelector('.cm-content').cmTile.root.view;
    const sc = view.scrollDOM;
    sc.scrollTop = 0;
    await new Promise((res) => setTimeout(res, 200));
    const frames = [];
    let last = performance.now();
    const step = Math.max(40, sc.clientHeight / 3);
    while (sc.scrollTop + sc.clientHeight < sc.scrollHeight - 2) {
      sc.scrollTop += step;
      const t = await new Promise((res) => requestAnimationFrame(() => res(performance.now())));
      frames.push(t - last);
      last = t;
      if (frames.length > 2000) break;
    }
    return { frames, height: sc.scrollHeight };
  });
  row('scroll: frame interval p95', q(r.frames, 0.95), 'ms', 50, `${r.frames.length} frames over ${Math.round(r.height)} px`);
}

/* ------------------------------------------------------------------------------------ */
/* Main                                                                                  */
/* ------------------------------------------------------------------------------------ */

let SERVER_URL = '';

async function main() {
  console.log(`work ${WORK}\nshots ${SHOTS}`);
  if (BUILD) {
    process.stdout.write('building the web app (VITE_PAPER_E2E=1)... ');
    buildWeb();
    console.log('done');
  }
  console.log(`project: ${makeProject()}`);
  SERVER_URL = await startServer();
  console.log(`server: ${SERVER_URL.replace(/token=[^&]+/, 'token=…')}\n`);

  const browser = await chromium.launch({ headless: !HEADED, args: ['--enable-precise-memory-info'] });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
    page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');

    await openTimes();
    const m1 = await memory(cdp);
    row('memory: JS heap after opening both files', m1.heapMb, 'MB', null, `${m1.nodes} DOM nodes`);
    await localRender(300);
    const { patchAt } = await realTyping();
    await lintDocument(patchAt);
    await compile();
    await scroll();
    const m2 = await memory(cdp);
    row('memory: JS heap at the end', m2.heapMb, 'MB', 150, `${m2.nodes} DOM nodes, ${m2.listeners} listeners`);
    const real = errors.filter((e) => !/favicon|Failed to load resource/.test(e));
    row('page errors', real.length, '', 1, real.slice(0, 2).join(' | ').slice(0, 160));
  } finally {
    await browser.close().catch(() => undefined);
    await stopServer('SIGTERM');
  }

  console.log(`\n| metric | value | budget |\n|---|---:|---:|\n${rows.map((r) => `| ${r.metric} | ${f1(r.value)} ${r.unit} | ${r.budget === null ? '' : `< ${r.budget} ${r.unit}`}${r.ok ? '' : ' MISSED'} |`).join('\n')}`);
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(rows, null, 2) + '\n');
  console.log(`\n${rows.length - failed}/${rows.length} within budget; screenshots in ${SHOTS}${KEEP ? `; work dir ${WORK}` : ''}`);
  return failed ? 1 : 0;
}

let code = 2;
try {
  code = await main();
} catch (err) {
  console.error(err);
  await stopServer('SIGKILL').catch(() => undefined);
  if (existsSync(P.serverLog)) console.error(readFileSync(P.serverLog, 'utf8').slice(-3000));
} finally {
  if (!KEEP) {
    try {
      rmSync(WORK, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
process.exit(code);
