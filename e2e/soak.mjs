#!/usr/bin/env node
/**
 * Soak test: data safety under a long, messy session on the REAL stack.
 *
 * `paper open` (Fastify + WebSocket + every service, simulated AI with PAPER_FAKE_LLM=1) on a temp project made
 * from fixtures/canto-demo whose LaTeX tree is a clone of a local bare remote (the Overleaf git bridge), the
 * built web app (VITE_PAPER_E2E=1) in Chromium with TWO tabs on main.tex. For SOAK_MINUTES (default 5) a
 * seeded PRNG (SOAK_SEED, default 1) picks weighted random actions:
 *
 *   type words / a sentence, Chinese IME composition (CDP Input.imeSetComposition + Input.insertText), paste a
 *   paragraph, delete a range, undo, redo, Alt+Up/Down, ghost (Ctrl+Space, Tab), instruct + accept, grammar +
 *   accept, draft from the outline (the five items and the attestation are filled first) and review
 *   (accept / reject), compile, a co-author commit on the bare remote + Pull, Pull alone, server kill -9 +
 *   restart in the middle of typing, typing in tab 2, typing in both tabs at once, reload of a tab.
 *
 * After EVERY action the run waits for quiescence and checks the invariants:
 *   - both tabs' text == the server mirror (GET /api/doc) == the file on disk (after a doc.flush);
 *   - the text an action typed (or pasted, or composed) is in the document right after it;
 *   - every unit span is a valid slice whose normalized text is the unit's textNorm, and the spans are exactly
 *     the sentences of a fresh segmentation (core segment()) of the server text; the tabs show the same ids
 *     and spans as the server;
 *   - no unit id disappears unless a sentences.patch removed it or it was orphaned (doc.replace report or
 *     the orphan list);
 *   - everAi never goes from true to false for an id;
 *   - every proposed / unsupported unit is a blocker of GET /api/sync/push-check (which is then not ok);
 *   - no page errors (connection errors while the server is down are expected).
 * On a violation the action log, the seed, the server log and screenshots of both tabs are saved to the
 * shots directory and the run stops with exit code 1. At the end it prints the action counts.
 *
 *   SOAK_SEED=1 SOAK_MINUTES=5 node e2e/soak.mjs [--shots DIR] [--work DIR] [--port 4437] [--no-build] [--keep] [--headed]
 *
 * Timing budgets are multiplied by PERF_SLACK (3 on CI, else 1). Every process the script starts is stopped
 * before it exits; the work directory (temp) is removed unless --keep.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { tsImport } = await import(pathToFileURL(join(ROOT, 'node_modules', 'tsx', 'dist', 'esm', 'api', 'index.mjs')).href);
const core = await tsImport(join(ROOT, 'packages', 'core', 'src', 'index.ts'), import.meta.url);

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const SEED = Number(arg('--seed', process.env.SOAK_SEED ?? '1')) >>> 0;
const MINUTES = Number(arg('--minutes', process.env.SOAK_MINUTES ?? '5'));
const SHOTS = resolve(arg('--shots', process.env.SHOTS_DIR ?? join(tmpdir(), 'paper-copilot-soak-shots')));
const WORK = resolve(arg('--work', '') || mkdtempSync(join(tmpdir(), 'paper-soak-')));
const PORT = Number(arg('--port', '4437'));
const BUILD = !args.includes('--no-build');
const KEEP = args.includes('--keep');
const HEADED = args.includes('--headed');
const PERF_SLACK = process.env.CI ? 3 : 1;
const ms = (n) => Math.round(n * PERF_SLACK);
mkdirSync(SHOTS, { recursive: true });
mkdirSync(WORK, { recursive: true });

const P = {
  dist: join(WORK, 'web-dist'),
  gitcfg: join(WORK, 'gitconfig'),
  seed: join(WORK, 'seed'),
  remote: join(WORK, 'remote.git'),
  proj: join(WORK, 'proj'),
  tex: join(WORK, 'proj', 'tex'),
  repo: join(WORK, 'repo'),
  coauthor: join(WORK, 'coauthor'),
  serverLog: join(WORK, 'server.log'),
};
const FILE = 'main.tex';
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const sleep = (t) => new Promise((r) => setTimeout(r, t));

/* ------------------------------------------------------------------------------------ */
/* Seeded PRNG                                                                           */
/* ------------------------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const ri = (n) => Math.floor(rand() * n);
const pick = (xs) => xs[ri(xs.length)];
let uniq = 0;
const tag = () => `${SEED.toString(36)}${(uniq++).toString(36)}`;

const WORDS = ['the', 'tracker', 'finds', 'more', 'displaced', 'particles', 'than', 'baseline', 'at', 'low', 'fake', 'rate', 'for', 'every', 'species', 'we', 'simulated', 'and', 'its', 'efficiency', 'rises', 'with', 'radius', 'in', 'each', 'sample'];
const ZH = ['这里说明两个径迹重建器的假径迹率', '强调效率随半径上升', '结果在验证样本上也成立', '和基线比较'];
const PINYIN = ['zheli', 'qiangdiao', 'jieguo', 'he'];
const INSTRUCT = ['把动词提前', 'make it shorter', '把引用放在句末', 'state the number first'];
const words = (n) => Array.from({ length: n }, () => pick(WORDS)).join(' ');
const sentence = () => {
  const w = words(5 + ri(7));
  return `${w[0].toUpperCase()}${w.slice(1)} soak${tag()}.`;
};
const PARAGRAPHS = [
  () => `The efficiency stays flat up to a radius of 300 mm soak${tag()}. Beyond it the tracker loses hits, and the fake rate rises as shown in Fig.~\\ref{fig:eff}. We keep the cut fixed for every sample.`,
  () => `A second check uses the validation sample soak${tag()}. The gain over the baseline~\\cite{Wang2022LRT} holds there too, with $p_T > 1$~GeV.`,
  () => `We repeat the study with half the training data soak${tag()}. The result changes by less than its uncertainty.`,
];

/* ------------------------------------------------------------------------------------ */
/* Processes                                                                             */
/* ------------------------------------------------------------------------------------ */

writeFileSync(P.gitcfg, '[user]\n\tname = Soak Author\n\temail = soak@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = master\n[advice]\n\tdetachedHead = false\n');
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: P.gitcfg, GIT_CONFIG_NOSYSTEM: '1', PAPER_FAKE_LLM: '1', PAPER_WEB_DIST: P.dist, PAPER_LOG_LEVEL: 'info' };
delete ENV.ANTHROPIC_API_KEY;

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', env: ENV, maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${argv.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout || '').slice(0, 800)}`);
  return r;
}
const git = (cwd, ...a) => run('git', a, { cwd }).stdout.trim();
const paper = (...a) => run(process.execPath, [TSX, 'src/cli.ts', ...a], { cwd: join(ROOT, 'apps', 'server') });

let server = null;
let serverOut = '';
let URL_ = '';
let TOKEN = '';

async function startServer() {
  const child = spawn(process.execPath, [TSX, 'src/cli.ts', 'open', P.proj, '--no-browser', '--port', String(PORT)], {
    cwd: join(ROOT, 'apps', 'server'),
    env: ENV,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server = child;
  const mark = serverOut.length;
  serverOut += `\n----- server start ${new Date().toISOString()} -----\n`;
  const onData = (d) => {
    serverOut += d.toString();
    if (serverOut.length > 4_000_000) serverOut = serverOut.slice(-2_000_000);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  for (let i = 0; i < 400; i++) {
    const m = /Open: (http:\/\/\S+)/.exec(serverOut.slice(mark));
    if (m) {
      URL_ = m[1];
      TOKEN = new URL(URL_).searchParams.get('token') ?? '';
      return URL_;
    }
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
  cpSync(join(ROOT, 'fixtures', 'canto-demo', 'repo'), P.repo, { recursive: true });
  cpSync(join(ROOT, 'fixtures', 'canto-demo', 'tex'), P.seed, { recursive: true });
  git(WORK, 'init', '--quiet', '--bare', P.remote);
  git(P.seed, 'init', '--quiet');
  git(P.seed, 'add', '-A');
  git(P.seed, 'commit', '--quiet', '-m', 'Overleaf: initial manuscript');
  git(P.seed, 'push', '--quiet', P.remote, 'HEAD:refs/heads/master');
  mkdirSync(P.proj, { recursive: true });
  git(WORK, 'clone', '--quiet', P.remote, P.tex);
  git(WORK, 'clone', '--quiet', P.remote, P.coauthor);
  paper('init', P.proj, '--repo', P.repo, '--skill', join(ROOT, '.skill'), '--sync', 'git', '--remote', P.remote);
}

async function api(path, init = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { ...init, headers: { 'x-paper-token': TOKEN, accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/* ------------------------------------------------------------------------------------ */
/* Browser                                                                               */
/* ------------------------------------------------------------------------------------ */

class Violation extends Error {}
const fail = (msg) => {
  throw new Violation(msg);
};

/** Error windows: [from, to] timestamps while the server is down (connection errors expected). */
const downWindows = [];
let downSince = null;
const pageErrors = [];
/** Unit ids reported removed / orphaned by the server since the last check (from the tabs' WebSocket frames). */
let removedSeen = new Set();

/** Recent WebSocket frames and console lines of each tab (saved with a violation). */
const trace = [];
const traceLine = (line) => {
  trace.push(`${new Date().toISOString()} ${line}`);
  if (trace.length > 3000) trace.splice(0, trace.length - 2000);
};
const brief = (payload) => {
  try {
    const m = JSON.parse(payload);
    const short = { ...m };
    for (const k of ['text', 'units', 'upserts', 'intentLines', 'flags', 'project', 'report', 'outline', 'paragraphs', 'logTail', 'totals'])
      if (k in short) short[k] = Array.isArray(short[k]) ? `[${short[k].length}]` : typeof short[k] === 'string' ? `<${short[k].length} chars>` : '{…}';
    return JSON.stringify(short).slice(0, 400);
  } catch {
    return String(payload).slice(0, 200);
  }
};

function watchPage(page, name) {
  page.on('pageerror', (e) => pageErrors.push({ at: Date.now(), tab: name, msg: `pageerror: ${e.message}` }));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push({ at: Date.now(), tab: name, msg: m.text() });
    if (m.type() === 'error' || m.type() === 'warning') traceLine(`${name} console.${m.type()} ${m.text().slice(0, 300)}`);
  });
  page.on('websocket', (ws) => {
    traceLine(`${name} ws open ${ws.url().replace(/token=[^&]+/, 'token=…')}`);
    ws.on('close', () => traceLine(`${name} ws close`));
    ws.on('framesent', (f) => {
      if (typeof f.payload === 'string' && !f.payload.includes('"ghost.')) traceLine(`${name} >> ${brief(f.payload)}`);
    });
    ws.on('framereceived', (f) => {
      const payload = typeof f.payload === 'string' ? f.payload : null;
      if (payload && /"type":"(doc\.|sentences\.patch|notice)/.test(payload)) traceLine(`${name} << ${brief(payload)}`);
      if (!payload || (!payload.includes('"sentences.patch"') && !payload.includes('"doc.replace"'))) return;
      try {
        const m = JSON.parse(payload);
        if (m.type === 'sentences.patch') for (const id of m.removed) removedSeen.add(id);
        if (m.type === 'doc.replace') for (const id of m.report.orphaned) removedSeen.add(id);
      } catch {
        /* not ours */
      }
    });
  });
}

const tabs = [];
const pc = (page, fn, a) => page.evaluate(fn, a);
const textOf = (page) => pc(page, () => window.__paper.workspace.getState().editor?.getText() ?? null);
const connected = (page) => pc(page, () => !!window.__paper?.workspace.getState().connected).catch(() => false);

async function waitFor(page, fn, a, t, what) {
  try {
    await page.waitForFunction(fn, a, { timeout: ms(t), polling: 50 });
  } catch {
    fail(`timed out waiting for ${what}`);
  }
}

async function waitApp(page) {
  await page.waitForSelector('.cm-content .pc-s', { timeout: ms(30000) });
  await waitFor(page, () => window.__paper?.workspace.getState().units.length > 10 && window.__paper.workspace.getState().connected && window.__paper.workspace.getState().editor, null, 15000, 'units and connection');
}

async function openTab(page, name) {
  const tab = page.locator('.rail [role="tab"]').filter({ hasText: name }).first();
  const selected = await tab.getAttribute('aria-selected');
  const collapsed = await pc(page, () => window.__paper.shell.getState().leftCollapsed);
  if (selected !== 'true' || collapsed) await tab.click();
  await sleep(200);
  if (await pc(page, () => window.__paper.shell.getState().leftCollapsed)) await tab.click();
  for (let i = 0; i < 3 && !(await page.locator('.shell-panel').first().isVisible()); i++) {
    await tab.click();
    await sleep(250);
  }
  if (!(await page.locator('.shell-panel').first().isVisible())) fail(`the ${name} panel does not open`);
}

/** Units of a tab in its editor coordinates. */
const tabUnits = (page) =>
  pc(page, () => window.__paper.workspace.getState().units.map((u) => ({ id: u.id, start: u.start, end: u.end, state: u.state, everAi: u.everAi, kind: u.kind })));

/** A random prose unit of the tab (optionally filtered by state). */
async function randomUnit(page, filter = () => true) {
  const us = (await tabUnits(page)).filter((u) => u.kind === 'prose' && filter(u));
  return us.length ? pick(us) : null;
}

/** Cursor at the end of a random sentence (the editor focused). */
async function cursorAtSentenceEnd(page) {
  const u = await randomUnit(page);
  if (!u) return null;
  await pc(page, (i) => window.__paper.workspace.getState().editor.revealSentence(i), u.id);
  await page.keyboard.press('ArrowRight');
  return u;
}

async function focusEditor(page) {
  await pc(page, () => {
    const el = document.querySelector('.cm-content');
    if (el && document.activeElement !== el) el.focus();
  });
}

/* ------------------------------------------------------------------------------------ */
/* Actions                                                                               */
/* ------------------------------------------------------------------------------------ */

/** Text every action expects to find in the document right after it (contiguous, as typed). */
let expectText = [];

async function typeWords(page) {
  if (!(await cursorAtSentenceEnd(page))) return 'no sentence';
  const s = ` ${words(2 + ri(5))} w${tag()}${rand() < 0.5 ? '.' : ''}`;
  await page.keyboard.type(s, { delay: ri(25) });
  expectText.push(s);
  return JSON.stringify(s);
}

async function typeSentence(page) {
  if (!(await cursorAtSentenceEnd(page))) return 'no sentence';
  await page.keyboard.press('Enter');
  const s = sentence();
  await page.keyboard.type(s, { delay: ri(20) });
  expectText.push(s);
  return JSON.stringify(s);
}

async function imeChinese(page, cdp) {
  if (!(await cursorAtSentenceEnd(page))) return 'no sentence';
  const ownLine = rand() < 0.6;
  if (ownLine) await page.keyboard.press('Enter');
  const k = ri(ZH.length);
  const py = PINYIN[k];
  for (let i = 1; i <= py.length; i++) {
    await cdp.send('Input.imeSetComposition', { text: py.slice(0, i), selectionStart: i, selectionEnd: i });
    await sleep(15);
  }
  const zh = ZH[k];
  await cdp.send('Input.imeSetComposition', { text: zh, selectionStart: zh.length, selectionEnd: zh.length });
  await sleep(40);
  await cdp.send('Input.insertText', { text: zh });
  await sleep(100);
  expectText.push(zh);
  return `${ownLine ? 'own line' : 'inline'} ${zh}`;
}

async function pasteParagraph(page) {
  if (!(await cursorAtSentenceEnd(page))) return 'no sentence';
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  const para = pick(PARAGRAPHS)();
  await pc(page, (text) => {
    const el = document.querySelector('.cm-content');
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, para);
  await sleep(50);
  expectText.push(para);
  return JSON.stringify(para.slice(0, 50));
}

async function deleteRange(page) {
  const u = await randomUnit(page);
  if (!u) return 'no sentence';
  await pc(page, (i) => window.__paper.workspace.getState().editor.revealSentence(i), u.id);
  const mode = ri(3);
  if (mode === 0) {
    await page.keyboard.press(rand() < 0.5 ? 'Backspace' : 'Delete'); // the whole sentence
    return `sentence ${u.id}`;
  }
  await page.keyboard.press('ArrowLeft');
  const n = 1 + ri(mode === 1 ? 12 : 60);
  for (let i = 0; i < n; i++) await page.keyboard.press('Shift+ArrowRight');
  if (mode === 2 && rand() < 0.4) await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Backspace');
  return `${n} chars from ${u.id}`;
}

async function undo(page) {
  await focusEditor(page);
  const n = 1 + ri(3);
  for (let i = 0; i < n; i++) await page.keyboard.press('Control+z');
  return `${n}x`;
}

async function redo(page) {
  await focusEditor(page);
  const n = 1 + ri(2);
  for (let i = 0; i < n; i++) await page.keyboard.press(rand() < 0.5 ? 'Control+y' : 'Control+Shift+z');
  return `${n}x`;
}

async function altUpDown(page) {
  if (rand() < 0.5) await cursorAtSentenceEnd(page);
  else await focusEditor(page);
  const keys = [];
  for (let i = 0, n = 1 + ri(2); i < n; i++) {
    const k = rand() < 0.6 ? 'Alt+ArrowDown' : 'Alt+ArrowUp';
    keys.push(k);
    await page.keyboard.press(k);
    await sleep(60);
  }
  return keys.join(' ');
}

async function ghost(page) {
  if (!(await cursorAtSentenceEnd(page))) return 'no sentence';
  await page.keyboard.press('Enter');
  const prefix = pick(['The gain', 'We find', 'This rate']);
  await page.keyboard.type(prefix, { delay: 10 });
  expectText.push(prefix);
  await sleep(150);
  await page.keyboard.press('Control+Space');
  try {
    await page.waitForSelector('[data-testid="ghost"]', { timeout: ms(8000) });
  } catch {
    await page.keyboard.press('Escape');
    return 'no ghost shown';
  }
  const g = (await page.locator('[data-testid="ghost"]').innerText().catch(() => '')).trim();
  await page.keyboard.press('Tab');
  await sleep(150);
  return `accepted ${JSON.stringify(g.slice(0, 40))}`;
}

async function proposalFlow(page, key, input) {
  const u = await randomUnit(page, (x) => x.state !== 'proposed' && x.state !== 'unsupported' && x.state !== 'placeholder');
  if (!u) return 'no sentence';
  await pc(page, (i) => window.__paper.workspace.getState().editor.revealSentence(i), u.id);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press(key);
  if (input) {
    try {
      await page.waitForSelector('.pc-card input.pc-input', { timeout: ms(3000) });
    } catch {
      await page.keyboard.press('Escape');
      return `${u.id}: no instruction box`;
    }
    await page.keyboard.insertText(input);
    await page.keyboard.press('Enter');
  }
  try {
    await page.waitForSelector('[data-testid="proposal"]', { timeout: ms(8000) });
  } catch {
    await page.keyboard.press('Escape');
    return `${u.id}: no proposal`;
  }
  await page.keyboard.press('Control+Enter');
  await sleep(300);
  await page.keyboard.press('Escape');
  return `${u.id} accepted`;
}
const instruct = (page) => proposalFlow(page, 'Control+i', pick(INSTRUCT));
const grammar = (page) => proposalFlow(page, 'Control+g', null);

let outlineFilled = false;
async function draft(page) {
  await openTab(page, 'Outline');
  if (!outlineFilled) {
    const items = page.locator('.five-items textarea');
    const n = await items.count();
    const fill = [
      'A tracker trained without the signal finds more displaced particles than the signal-trained baseline.',
      'Trackers tuned on prompt particles lose displaced tracks.',
      'Training on background-only events removes the signal bias.',
      'The signal-trained baseline loses efficiency at large radius.',
    ];
    for (let i = 0; i < n; i++) await items.nth(i).fill(fill[i % fill.length]);
    // 1 key phrase, 3 the ladder of cases, 4 the figure behind each claim, 5 the headline number + baseline
    const five = page.locator('.five-items');
    await five.locator('input.input').first().fill('displaced tracks');
    const addCase = five.getByRole('button', { name: /Add a case/i });
    for (const c of ['Isolated gun particles', 'Particles from the decay of a long-lived particle']) {
      await addCase.click();
      await five.locator('.ladder-case input.input').last().fill(c);
    }
    const addMap = five.getByRole('button', { name: /mapping/i });
    if (await addMap.count()) await addMap.first().click();
    const selects = five.locator('.field select');
    for (let i = 0, k = await selects.count(); i < k; i++) {
      const sel = selects.nth(i);
      if ((await sel.evaluate((el) => el.closest('.ladder-case') !== null)) || (await sel.inputValue())) continue;
      const opts = await sel.locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
      if (opts.length) await sel.selectOption(opts[0]);
    }
    const empties = five.locator('.field input.input');
    for (let i = 0, k = await empties.count(); i < k; i++) {
      const el = empties.nth(i);
      if (!(await el.inputValue())) await el.fill('the signal-trained baseline');
    }
    const att = page.locator('.attest input[type="checkbox"]').first();
    await att.scrollIntoViewIfNeeded();
    if (!(await att.isChecked())) await att.check();
    outlineFilled = true;
  }
  const secs = page.locator('.section-card');
  const nSec = await secs.count();
  if (!nSec) return 'no section';
  const sec = secs.filter({ hasText: 'Results' }).first();
  await sec.scrollIntoViewIfNeeded();
  if (!(await sec.getByRole('button', { name: 'Add paragraph' }).count())) await sec.locator('button').first().click();
  await sec.getByRole('button', { name: 'Add paragraph' }).click();
  await sec.locator('input.input').last().fill(pick(['State the fake-track rates of both trackers', 'Say what the lower fake-track rate buys a search', 'Compare the efficiency at large radius']));
  await sleep(150);
  const before = await pc(page, () => window.__paper.workspace.getState().units.filter((u) => u.state === 'proposed' || u.state === 'unsupported').length);
  const btn = sec.getByRole('button', { name: 'Draft from outline' });
  await btn.scrollIntoViewIfNeeded();
  if (await btn.isDisabled()) return 'draft disabled';
  await btn.click();
  try {
    await page.waitForFunction((n) => window.__paper.workspace.getState().units.filter((u) => u.state === 'proposed' || u.state === 'unsupported').length > n, before, { timeout: ms(20000), polling: 100 });
  } catch {
    return 'no drafted units';
  }
  await sleep(500);
  const after = await pc(page, () => window.__paper.workspace.getState().units.filter((u) => u.state === 'proposed' || u.state === 'unsupported').length);
  return `${after - before} drafted`;
}

async function review(page) {
  const queue = (await tabUnits(page)).filter((u) => u.state === 'proposed' || u.state === 'unsupported');
  if (!queue.length) return 'queue empty';
  await focusEditor(page);
  const u = pick(queue);
  await pc(page, (i) => window.__paper.workspace.getState().editor.revealSentence(i), u.id);
  if (rand() < 0.7) {
    await page.keyboard.press('Control+Enter');
    await sleep(300);
    return `accept ${u.id}`;
  }
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Control+.');
  try {
    await page.waitForSelector('[data-testid="sentence-card"]', { timeout: ms(3000) });
  } catch {
    return `reject ${u.id}: no card`;
  }
  await page.keyboard.press('x');
  await sleep(400);
  await page.keyboard.press('Escape');
  return `reject ${u.id}`;
}

async function compile(page) {
  await page.keyboard.press('Escape');
  await page.locator('.topbar').getByRole('button', { name: 'Compile', exact: true }).click();
  try {
    await page.waitForFunction(() => ['ok', 'error'].includes(window.__paper.workspace.getState().compile.state), null, { timeout: ms(90000), polling: 200 });
  } catch {
    fail('compile did not finish');
  }
  return pc(page, () => window.__paper.workspace.getState().compile.state);
}

let coauthorEdits = 0;
function coauthorCommit() {
  git(P.coauthor, 'pull', '--quiet', '--rebase', 'origin', 'master');
  const f = join(P.coauthor, FILE);
  const lines = readFileSync(f, 'utf8').split('\n');
  const prose = lines.map((l, i) => [l, i]).filter(([l]) => /^[A-Z][^%\\]*\.\s*$/.test(l) && l.length > 30);
  if (!prose.length) return 'no prose line';
  const [l, i] = pick(prose);
  const mode = ri(3);
  let what;
  if (mode === 0) {
    lines.splice(i + 1, 0, `The co-author adds that the result holds for sample ${tag()}.`);
    what = 'insert';
  } else if (mode === 1) {
    const ws = l.split(' ');
    const j = 1 + ri(Math.max(1, ws.length - 2));
    ws[j] = ws[j] === 'the' ? 'this' : 'the';
    lines[i] = ws.join(' ');
    what = 'edit';
  } else {
    lines.splice(i, 1);
    what = 'delete';
  }
  writeFileSync(f, lines.join('\n'));
  git(P.coauthor, 'commit', '--quiet', '-am', `Co-author edit ${++coauthorEdits}`);
  git(P.coauthor, 'push', '--quiet', 'origin', 'HEAD:master');
  return `${what} line ${i + 1}`;
}

async function pull(page) {
  await page.keyboard.press('Escape');
  const btn = page.locator('.topbar').getByRole('button', { name: 'Pull', exact: true });
  if (await btn.isDisabled()) return 'pull disabled';
  const res = await pc(page, () => window.__paper.api.pull().then((r) => ({ ok: true, n: r.length })).catch((e) => ({ ok: false, msg: String(e?.message ?? e) })));
  return res.ok ? `pulled (${res.n} report(s))` : `pull refused: ${res.msg.slice(0, 80)}`;
}

async function coauthorAndPull(page) {
  const c = coauthorCommit();
  await sleep(ri(400));
  const first = await pull(page);
  if (!first.startsWith('pull refused')) return `${c}; ${first}`;
  // A refused pull leaves the tree exactly as it was (checked by the invariants after this action). The
  // co-author then backs the conflicting commit out, so later pulls are not all refused by this one commit.
  git(P.coauthor, 'revert', '--no-edit', 'HEAD');
  git(P.coauthor, 'push', '--quiet', 'origin', 'HEAD:master');
  return `${c}; ${first.slice(0, 40)}…; co-author reverted; ${await pull(page)}`;
}

async function kill9(page, ctxPages) {
  if (!(await cursorAtSentenceEnd(page))) return 'no sentence';
  const s = ` ${words(8)} k${tag()}`;
  expectText.push(s);
  const typing = page.keyboard.type(s, { delay: 35 });
  await sleep(150 + ri(300));
  downSince = Date.now();
  traceLine('--- kill -9');
  await stopServer('SIGKILL');
  await typing;
  await sleep(ri(1500));
  traceLine('--- restart');
  await startServer();
  traceLine('--- restarted');
  for (const p of ctxPages) await waitFor(p, () => window.__paper.workspace.getState().connected, null, 25000, 'reconnect after restart');
  downWindows.push([downSince, Date.now() + 3000]);
  downSince = null;
  return `typed ${JSON.stringify(s)} across a kill -9`;
}

async function dualType(a, b) {
  const [ua, ub] = [await cursorAtSentenceEnd(a), await cursorAtSentenceEnd(b)];
  if (!ua || !ub) return 'no sentence';
  const sa = ` ${words(3)} a${tag()}`;
  const sb = ` ${words(3)} b${tag()}`;
  expectText.push(sa, sb);
  await Promise.all([a.keyboard.type(sa, { delay: 20 + ri(20) }), b.keyboard.type(sb, { delay: 20 + ri(20) })]);
  return `${JSON.stringify(sa)} || ${JSON.stringify(sb)}`;
}

async function reload(page) {
  await page.reload();
  await waitApp(page);
  return 'reloaded';
}

/* ------------------------------------------------------------------------------------ */
/* Invariants                                                                            */
/* ------------------------------------------------------------------------------------ */

const everAiSeen = new Set();
let lastIds = null;

async function serverDoc() {
  return api(`/api/doc?file=${encodeURIComponent(FILE)}`);
}

/** Wait until both tabs and the server mirror hold the same text, stable over two polls. */
async function quiesce() {
  const deadline = Date.now() + ms(30000);
  let prev = null;
  let last = null;
  while (Date.now() < deadline) {
    const ok = await Promise.all(tabs.map((t) => connected(t.page)));
    if (ok.every(Boolean)) {
      const [ta, tb] = await Promise.all(tabs.map((t) => textOf(t.page)));
      const s = await serverDoc().catch(() => null);
      last = { ta, tb, s };
      if (s && ta === s.text && tb === s.text) {
        const key = `${s.version}:${s.text.length}`;
        if (prev === key) return s;
        prev = key;
      } else prev = null;
    }
    await sleep(250);
  }
  if (last?.s) {
    const diffAt = (x, y) => {
      if (x === null || y === null) return 'null';
      let i = 0;
      while (i < x.length && x[i] === y[i]) i++;
      return `${i}: ${JSON.stringify(x.slice(Math.max(0, i - 30), i + 40))} vs ${JSON.stringify(y.slice(Math.max(0, i - 30), i + 40))}`;
    };
    fail(`no quiescence: tab1 ${last.ta === last.s.text ? '==' : `!= server at ${diffAt(last.ta, last.s.text)}`}; tab2 ${last.tb === last.s.text ? '==' : `!= server at ${diffAt(last.tb, last.s.text)}`}`);
  }
  fail('no quiescence: a tab is not connected or the server does not answer');
}

async function flushAndCheckDisk(text) {
  await pc(tabs[0].page, (f) => window.__paper.api.send({ type: 'doc.flush', file: f, version: 0 }), FILE);
  const disk = join(P.tex, FILE);
  const deadline = Date.now() + ms(8000);
  let d = '';
  while (Date.now() < deadline) {
    d = readFileSync(disk, 'utf8').replace(/\r\n/g, '\n');
    if (d === text) return;
    await sleep(100);
  }
  let i = 0;
  while (i < d.length && d[i] === text[i]) i++;
  fail(`disk != server mirror after flush (first difference at ${i}: disk ${JSON.stringify(d.slice(i, i + 40))} vs mirror ${JSON.stringify(text.slice(i, i + 40))})`);
}

function checkUnits(s) {
  const text = s.text;
  const seg = core.segment(text);
  const want = seg.sentences.map((x) => `${x.start}-${x.end}`).sort();
  const have = s.units.map((u) => `${u.start}-${u.end}`).sort();
  for (const u of s.units) {
    if (!(u.start >= 0 && u.start <= u.end && u.end <= text.length)) fail(`unit ${u.id} span ${u.start}-${u.end} outside the text (${text.length})`);
    if (core.normalizeForHash(text.slice(u.start, u.end)) !== u.textNorm) fail(`unit ${u.id} span ${u.start}-${u.end} holds ${JSON.stringify(text.slice(u.start, u.end).slice(0, 60))}, not its textNorm ${JSON.stringify(u.textNorm.slice(0, 60))}`);
  }
  if (want.join(',') !== have.join(',')) {
    const missing = want.filter((x) => !have.includes(x));
    const extra = have.filter((x) => !want.includes(x));
    const show = (k) => {
      const [a, b] = k.split('-').map(Number);
      return `${k} ${JSON.stringify(text.slice(a, b).slice(0, 50))}`;
    };
    fail(`unit spans != fresh segmentation: missing ${missing.slice(0, 3).map(show).join('; ')}; extra ${extra.slice(0, 3).map(show).join('; ')}`);
  }
  const ids = new Set();
  for (const u of s.units) {
    if (ids.has(u.id)) fail(`duplicate unit id ${u.id}`);
    ids.add(u.id);
  }
  return seg.sentences.length;
}

async function checkTabsUnits(s) {
  const want = new Map(s.units.map((u) => [u.id, u]));
  const deadline = Date.now() + ms(8000);
  let why = '';
  while (Date.now() < deadline) {
    why = '';
    for (const t of tabs) {
      const us = await tabUnits(t.page);
      if (us.length !== want.size) {
        why = `${t.name}: ${us.length} units, server ${want.size}`;
        break;
      }
      for (const u of us) {
        const w = want.get(u.id);
        if (!w) {
          why = `${t.name}: unknown unit ${u.id}`;
          break;
        }
        if (w.start !== u.start || w.end !== u.end || w.state !== u.state || w.everAi !== u.everAi) {
          why = `${t.name}: unit ${u.id} ${u.start}-${u.end} ${u.state}${u.everAi ? '*' : ''} vs server ${w.start}-${w.end} ${w.state}${w.everAi ? '*' : ''}`;
          break;
        }
      }
      if (why) break;
    }
    if (!why) return;
    await sleep(200);
  }
  fail(`tab units != server units: ${why}`);
}

function checkIdsAndProvenance(s, tabUnitLists) {
  const ids = new Set(s.units.map((u) => u.id));
  const orphans = new Set((s.orphans ?? []).map((u) => u.id));
  if (lastIds) {
    const lost = [...lastIds].filter((id) => !ids.has(id) && !removedSeen.has(id) && !orphans.has(id));
    if (lost.length) fail(`unit(s) vanished without being removed or orphaned: ${lost.slice(0, 5).join(', ')}`);
  }
  lastIds = ids;
  removedSeen = new Set();
  for (const list of [s.units, s.orphans ?? [], ...tabUnitLists]) {
    for (const u of list) {
      if (u.everAi) everAiSeen.add(u.id);
      else if (everAiSeen.has(u.id)) fail(`everAi went true -> false for ${u.id} (state ${u.state})`);
    }
  }
}

async function checkPushGuard(s) {
  const unreviewed = s.units.filter((u) => u.state === 'proposed' || u.state === 'unsupported');
  const c = await api('/api/sync/push-check');
  if (unreviewed.length === 0) return `push-check ${c.ok ? 'ok' : `${c.blockers.length} blocker(s)`}`;
  if (c.ok) fail(`push-check ok with ${unreviewed.length} unreviewed unit(s)`);
  const blocked = new Set(c.blockers.filter((b) => b.kind === 'proposed' || b.kind === 'unsupported').map((b) => b.sentenceId));
  const missing = unreviewed.filter((u) => !blocked.has(u.id));
  if (missing.length) fail(`unreviewed unit(s) not blocking the push: ${missing.map((u) => `${u.id} ${u.state}`).join(', ')}`);
  return `push blocked by ${unreviewed.length} unreviewed`;
}

function checkPageErrors() {
  const inDown = (at) => downWindows.some(([a, b]) => at >= a && at <= b) || (downSince !== null && at >= downSince);
  const real = pageErrors.filter((e) => {
    if (/favicon/.test(e.msg)) return false;
    if (/status of 4\d\d/.test(e.msg)) return false; // a refused request (409 draft locked, pull conflict) is shown to the author
    if (inDown(e.at) && /ERR_CONNECTION_REFUSED|WebSocket|Failed to load resource|Failed to fetch|NetworkError|net::/.test(e.msg)) return false;
    return true;
  });
  if (real.length) fail(`page error(s): ${real.slice(0, 3).map((e) => `[${e.tab}] ${e.msg.slice(0, 200)}`).join(' | ')}`);
  pageErrors.length = 0;
}

async function checkAll() {
  const s0 = await quiesce();
  for (const t of expectText) if (!s0.text.includes(t)) fail(`typed text lost: ${JSON.stringify(t)}`);
  expectText = [];
  await flushAndCheckDisk(s0.text);
  const s = await serverDoc();
  if (s.text !== s0.text) fail('the server text changed during the flush');
  const n = checkUnits(s);
  await checkTabsUnits(s);
  const lists = await Promise.all(tabs.map((t) => tabUnits(t.page)));
  checkIdsAndProvenance(s, lists);
  const push = await checkPushGuard(s);
  checkPageErrors();
  return `v${s.version} ${n} units, ${s.orphans?.length ?? 0} orphans; ${push}`;
}

/* ------------------------------------------------------------------------------------ */
/* The run                                                                               */
/* ------------------------------------------------------------------------------------ */

const ACTIONS = [
  ['typeWords', 14, (t) => typeWords(t.page)],
  ['typeSentence', 8, (t) => typeSentence(t.page)],
  ['imeChinese', 5, (t) => imeChinese(t.page, t.cdp)],
  ['paste', 4, (t) => pasteParagraph(t.page)],
  ['deleteRange', 7, (t) => deleteRange(t.page)],
  ['undo', 5, (t) => undo(t.page)],
  ['redo', 3, (t) => redo(t.page)],
  ['altUpDown', 3, (t) => altUpDown(t.page)],
  ['ghost', 5, (t) => ghost(t.page)],
  ['instruct', 4, (t) => instruct(t.page)],
  ['grammar', 3, (t) => grammar(t.page)],
  ['draft', 2, () => draft(tabs[0].page)],
  ['review', 5, () => review(tabs[0].page)],
  ['compile', 2, () => compile(tabs[0].page)],
  ['coauthorPull', 3, () => coauthorAndPull(tabs[0].page)],
  ['pull', 1, () => pull(tabs[0].page)],
  ['kill9', 1.5, () => kill9(tabs[0].page, tabs.map((x) => x.page))],
  ['dualType', 4, () => dualType(tabs[0].page, tabs[1].page)],
  ['reload', 2, (t) => reload(t.page)],
];
/** Text actions run in tab 2 with this probability ("typing in tab 2"). */
const TAB2 = 0.3;
const TAB_ACTIONS = new Set(['typeWords', 'typeSentence', 'imeChinese', 'paste', 'deleteRange', 'undo', 'redo', 'altUpDown', 'ghost', 'instruct', 'grammar', 'reload']);
// SOAK_ONLY=kill9,typeWords restricts the run to some actions (debugging a finding)
const ONLY = (process.env.SOAK_ONLY ?? '').split(',').filter(Boolean);
if (ONLY.length) for (const a of ACTIONS) if (!ONLY.includes(a[0])) a[1] = 0;
const TOTAL = ACTIONS.reduce((a, x) => a + x[1], 0);
function chooseAction() {
  let x = rand() * TOTAL;
  for (const a of ACTIONS) {
    x -= a[1];
    if (x < 0) return a;
  }
  return ACTIONS[0];
}

const counts = {};
const actionLog = [];

function outcomes() {
  const o = {};
  for (const e of actionLog) {
    const k = `${e.action}: ${(e.detail || '').replace(/^\S+ (accepted|reject|accept)\b.*/, '$1').replace(/[0-9A-Z]{26}/g, 'ID').replace(/"[^"]*"/g, '"…"').replace(/\d+/g, 'N').slice(0, 40)}`;
    o[k] = (o[k] ?? 0) + 1;
  }
  return o;
}

async function saveViolation(err, i) {
  const base = join(SHOTS, `soak-seed${SEED}-violation`);
  writeFileSync(`${base}.json`, JSON.stringify({ seed: SEED, minutes: MINUTES, action: i, error: err.message, counts, log: actionLog }, null, 1));
  writeFileSync(`${base}-server.log`, serverOut.slice(-400_000));
  writeFileSync(`${base}-trace.log`, trace.join('\n'));
  for (const t of tabs) await t.page.screenshot({ path: `${base}-${t.name}.png` }).catch(() => undefined);
  try {
    copyFileSync(join(P.tex, FILE), `${base}-disk.tex`);
    const s = await serverDoc().catch(() => null);
    if (s) writeFileSync(`${base}-mirror.tex`, s.text);
    for (const t of tabs) {
      const x = await textOf(t.page).catch(() => null);
      if (x !== null) writeFileSync(`${base}-${t.name}.tex`, x);
    }
  } catch {
    /* best effort */
  }
  return base;
}

async function main() {
  console.log(`soak seed ${SEED}, ${MINUTES} min, work ${WORK}, shots ${SHOTS}`);
  if (BUILD) {
    process.stdout.write('building the web app (VITE_PAPER_E2E=1)... ');
    buildWeb();
    console.log('done');
  } else if (!existsSync(join(P.dist, 'index.html'))) {
    // --no-build without a build in --work: build once anyway
    buildWeb();
  }
  makeProject();
  await startServer();
  const browser = await chromium.launch({ headless: !HEADED });
  let exitCode = 0;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
    for (const name of ['tab1', 'tab2']) {
      const page = await context.newPage();
      watchPage(page, name);
      await page.goto(URL_);
      await waitApp(page);
      const cdp = await context.newCDPSession(page);
      tabs.push({ name, page, cdp });
    }
    await tabs[0].page.getByRole('button', { name: 'EN', exact: true }).click().catch(() => undefined);
    await sleep(300);
    for (const t of tabs) await t.page.reload().then(() => waitApp(t.page));
    console.log(`baseline: ${await checkAll()}`);

    const end = Date.now() + MINUTES * 60_000;
    let i = 0;
    while (Date.now() < end) {
      i++;
      const [name, , fn] = chooseAction();
      const t = TAB_ACTIONS.has(name) && rand() < TAB2 ? tabs[1] : tabs[0];
      const entry = { i, at: new Date().toISOString(), action: name, tab: TAB_ACTIONS.has(name) ? t.name : name === 'dualType' ? 'both' : 'tab1', detail: '', check: '' };
      actionLog.push(entry);
      traceLine(`=== #${i} ${name}@${entry.tab}`);
      counts[name] = (counts[name] ?? 0) + 1;
      try {
        entry.detail = String(await fn(t));
        entry.check = await checkAll();
        if (i % 10 === 0 || name === 'kill9' || name === 'coauthorPull') console.log(`#${i} ${name}@${entry.tab}: ${entry.detail} | ${entry.check}`);
      } catch (err) {
        entry.error = err.message;
        const base = await saveViolation(err, i);
        console.error(`\nVIOLATION at action #${i} (${name}@${entry.tab}, seed ${SEED}): ${err.message}\n${err instanceof Violation ? '' : err.stack}\nsaved ${base}.json, -server.log, -tab1.png, -tab2.png`);
        exitCode = 1;
        break;
      }
    }
    if (!exitCode) {
      for (const t of tabs) await t.page.screenshot({ path: join(SHOTS, `soak-seed${SEED}-end-${t.name}.png`) });
      console.log(`\nsoak seed ${SEED}: ${i} actions in ${MINUTES} min, every invariant held after every action`);
    }
    console.log(`action counts: ${JSON.stringify(counts)}`);
    if (process.env.SOAK_TRACE) writeFileSync(join(SHOTS, `soak-seed${SEED}-trace.log`), trace.join('\n'));
    writeFileSync(join(SHOTS, `soak-seed${SEED}-log.json`), JSON.stringify({ seed: SEED, minutes: MINUTES, counts, outcomes: outcomes(), log: actionLog }, null, 1));
    console.log(`outcomes: ${JSON.stringify(outcomes())}`);
  } finally {
    await browser.close().catch(() => undefined);
    await stopServer('SIGTERM');
    if (!KEEP) {
      try {
        rmSync(WORK, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
  process.exit(exitCode);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await stopServer('SIGKILL').catch(() => undefined);
    if (!KEEP) rmSync(WORK, { recursive: true, force: true });
    process.exit(130);
  });
}

main().catch(async (err) => {
  console.error(err);
  await stopServer('SIGKILL').catch(() => undefined);
  console.error(serverOut.slice(-3000));
  if (!KEEP) rmSync(WORK, { recursive: true, force: true });
  process.exit(2);
});
