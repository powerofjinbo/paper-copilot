#!/usr/bin/env node
/**
 * Full-stack end-to-end run of the REAL stack (no mock client): the built web app served by `paper open`
 * (Fastify + WebSocket + every service, simulated AI with PAPER_FAKE_LLM=1), a temp project made from
 * fixtures/canto-demo whose LaTeX tree is a git clone of a local bare remote (standing in for the Overleaf
 * git bridge), Chromium driven by Playwright. Walks the docs/plan.md Phase 1a acceptance test as far as
 * the simulated AI allows:
 *
 *   sentences decorated; click a sentence -> Chinese instruction -> accept (provenance, LaTeX intact);
 *   ghost (Ctrl+Space, Tab); a Chinese intent line rendered with Ctrl+Enter; compile -> PDF -> click in
 *   the PDF jumps to the source line, Ctrl+Shift+J highlights the line in the PDF; Facts panel (facts and
 *   unresolved numerals); draft from the Outline -> proposed sentences -> review queue -> accept/reject;
 *   push refused while a proposed sentence exists, allowed after review, the remote receives only .tex
 *   changes (no .paper files, no CJK); a co-author commit (one edited, one inserted sentence) -> Pull ->
 *   >= 95% ids kept, the edited sentence `external`, the editor updated (doc.replace); the APS disclosure
 *   counts; reload -> state persists; kill -9 + restart -> ids, states and the last PDF persist; dark
 *   mode; with sync mode "none" Pull/Push are unavailable and the Sync panel says why.
 *
 *   node e2e/fullstack.mjs [--shots DIR] [--work DIR] [--port 4417] [--no-build] [--keep] [--headed]
 *
 * Screenshots (deviceScaleFactor 1) go to --shots (default $SHOTS_DIR or <tmp>/paper-copilot-fullstack-shots).
 * Uses the `window.__paper` handle that a `VITE_PAPER_E2E=1` build exposes (the build goes to <work>/web-dist,
 * served through PAPER_WEB_DIST; apps/web/dist is untouched). git runs with a private global config (no
 * signing, a fixed identity) so the run never depends on or changes the user's git setup. Every process the
 * script starts is stopped before it exits. Exit code 1 if any check failed.
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
const SHOTS = resolve(arg('--shots', process.env.SHOTS_DIR ?? join(tmpdir(), 'paper-copilot-fullstack-shots')));
const WORK = resolve(arg('--work', '') || mkdtempSync(join(tmpdir(), 'paper-fullstack-')));
const PORT = Number(arg('--port', '4417'));
const BUILD = !args.includes('--no-build');
const KEEP = args.includes('--keep');
const HEADED = args.includes('--headed');
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
  script: join(WORK, 'fake-script.json'),
  large: join(WORK, 'large'),
  largeRepo: join(WORK, 'large-repo'),
};
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/;

/* ------------------------------------------------------------------------------------ */
/* Processes                                                                             */
/* ------------------------------------------------------------------------------------ */

writeFileSync(P.gitcfg, '[user]\n\tname = E2E Author\n\temail = e2e@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = master\n[advice]\n\tdetachedHead = false\n');
// PAPER_FAKE_SCRIPT: scripted replies of the simulated AI (llm/fake.ts fileScriptResponder), written below
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: P.gitcfg, GIT_CONFIG_NOSYSTEM: '1', PAPER_FAKE_LLM: '1', PAPER_WEB_DIST: P.dist, PAPER_LOG_LEVEL: 'info', PAPER_FAKE_SCRIPT: P.script };
delete ENV.ANTHROPIC_API_KEY;

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', env: ENV, maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${argv.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout || '').slice(0, 800)}`);
  return r;
}
const git = (cwd, ...a) => run('git', a, { cwd }).stdout.trim();
const gitBare = (...a) => run('git', [`--git-dir=${P.remote}`, ...a]).stdout;
const paper = (...a) => run(process.execPath, [TSX, 'src/cli.ts', ...a], { cwd: join(ROOT, 'apps', 'server') });

let server = null;
let serverOut = '';

async function startServer(proj = P.proj) {
  serverOut = '';
  const child = spawn(process.execPath, [TSX, 'src/cli.ts', 'open', proj, '--no-browser', '--port', String(PORT)], {
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
  cpSync(join(ROOT, 'fixtures', 'canto-demo', 'repo'), P.repo, { recursive: true });
  cpSync(join(ROOT, 'fixtures', 'canto-demo', 'tex'), P.seed, { recursive: true });
  // The author's draft has one wordy clause the simulated rewrite can tighten ("in order to" -> "to");
  // the simulated AI cannot follow a Chinese instruction, it only tidies wording.
  const main = join(P.seed, 'main.tex');
  const src = readFileSync(main, 'utf8');
  const wordy = src.replace('were built for prompt tracks, and their', 'were built in order to find prompt tracks, and their');
  if (wordy === src) throw new Error('fixture sentence for the rewrite not found');
  writeFileSync(main, wordy);
  git(WORK, 'init', '--quiet', '--bare', P.remote);
  git(P.seed, 'init', '--quiet');
  git(P.seed, 'add', '-A');
  git(P.seed, 'commit', '--quiet', '-m', 'Overleaf: initial manuscript');
  git(P.seed, 'push', '--quiet', P.remote, 'HEAD:refs/heads/master');
  mkdirSync(P.proj, { recursive: true });
  git(WORK, 'clone', '--quiet', P.remote, P.tex);
  const r = paper('init', P.proj, '--repo', P.repo, '--skill', join(ROOT, '.skill'), '--sync', 'git', '--remote', P.remote);
  return r.stdout.trim().split('\n').slice(-2).join(' | ');
}

/**
 * The simulated AI only tidies wording; for the derived-number check it must state a ratio of two facts.
 * The scripted rewrite keeps the sentence's LaTeX and numbers and adds "2.5 times" (fake_rate_B /
 * fake_rate_A = 0.01377 / 0.00548 = 2.51), a number no artifact holds: only the derived relation
 * the gate gets from the fact store makes it acceptable.
 */
const DERIVED_SENTENCE = 'The fake-track rate is 0.55\\% against 1.38\\% for the baseline, 2.5 times lower.';
function writeFakeScript() {
  const rule = {
    task: 'instruct',
    match: '低了多少倍',
    json: {
      text: DERIVED_SENTENCE,
      notes: '模拟模式（脚本）：补充了两者之比。',
      drift: { actor: false, scope: false, direction: false, condition: false },
      fact_ids: [],
      cite_keys: [],
    },
  };
  writeFileSync(P.script, JSON.stringify({ rules: [rule] }, null, 1));
}

/** fixtures/large-multifile as a second project: main.tex \\input's four section files; sync off. */
function makeLargeProject() {
  cpSync(join(ROOT, 'fixtures', 'large-multifile', 'repo'), P.largeRepo, { recursive: true });
  mkdirSync(P.large, { recursive: true });
  cpSync(join(ROOT, 'fixtures', 'large-multifile', 'tex'), join(P.large, 'tex'), { recursive: true });
  const r = paper('init', P.large, '--repo', P.largeRepo, '--skill', join(ROOT, '.skill'), '--sync', 'none');
  return r.stdout.trim().split('\n').slice(-2).join(' | ');
}

/* ------------------------------------------------------------------------------------ */
/* Checks                                                                                */
/* ------------------------------------------------------------------------------------ */

const results = [];
let page;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(ok, name, detail = '') {
  results.push({ ok, name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    log(true, name, typeof detail === 'string' ? detail : '');
  } catch (err) {
    log(false, name, err instanceof Error ? err.message.split('\n')[0] : String(err));
    try {
      await page.screenshot({ path: join(SHOTS, `full-fail-${results.length}.png`) });
    } catch {
      /* ignore */
    }
  }
  try {
    await page.keyboard.press('Escape');
  } catch {
    /* ignore */
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const pc = (fn, a) => page.evaluate(fn, a);
const shot = (name) => page.screenshot({ path: join(SHOTS, `full-${name}.png`) });

async function waitFor(fn, a, ms = 6000, what = 'condition') {
  try {
    await page.waitForFunction(fn, a, { timeout: ms, polling: 50 });
  } catch {
    throw new Error(`timed out waiting for ${what}`);
  }
}

const docText = () => pc(() => window.__paper.workspace.getState().editor.getText());
const unitById = (id) => pc((i) => window.__paper.workspace.getState().units.find((u) => u.id === i) ?? null, id);
const unitsNow = () => pc(() => window.__paper.workspace.getState().units.map((u) => ({ id: u.id, state: u.state, everAi: u.everAi, start: u.start, end: u.end, line: u.line, kind: u.kind })));
const unitTextOf = (id) => pc((i) => {
  const ws = window.__paper.workspace.getState();
  const u = ws.units.find((x) => x.id === i);
  return u ? ws.editor.getText().slice(u.start, u.end) : null;
}, id);

async function unitId(prefix) {
  let id = null;
  for (let i = 0; i < 80 && !id; i++) {
    id = await pc((p) => {
      const ws = window.__paper.workspace.getState();
      const t = ws.editor?.getText() ?? '';
      const u = ws.units.find((x) => t.slice(x.start, x.end).startsWith(p));
      return u ? u.id : null;
    }, prefix);
    if (!id) await sleep(50);
  }
  assert(id, `no unit starting with "${prefix}"`);
  return id;
}

/** Click on the first visible line of a sentence (a real mouse click in the editor). */
async function clickSentence(id) {
  await pc((i) => window.__paper.workspace.getState().editor.revealSentence(i), id);
  await sleep(250);
  const box = await pc((i) => {
    const r = [...document.querySelectorAll(`.cm-content [data-unit="${i}"]`)].flatMap((n) => [...n.getClientRects()]).find((x) => x.width > 20 && x.top > 60 && x.bottom < innerHeight - 40);
    return r ? { x: r.left + Math.min(30, r.width / 2), y: r.top + r.height / 2 } : null;
  }, id);
  assert(box, `sentence ${id} not visible`);
  await page.mouse.click(box.x, box.y);
  await sleep(150);
  return box;
}

/** Cursor at the end of a sentence's line. */
async function endOfSentenceLine(prefix) {
  const id = await unitId(prefix);
  await pc((i) => window.__paper.workspace.getState().editor.revealSentence(i), id);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('End');
  return id;
}

/** Replace a unit's text the way an author does: select it (revealSentence selects), then type. */
async function retype(id, text) {
  await pc((i) => window.__paper.workspace.getState().editor.revealSentence(i), id);
  await page.keyboard.insertText(text);
}

async function gutterStateFor(id) {
  return pc((i) => {
    const el = document.querySelector(`.cm-content [data-unit="${i}"]`);
    if (!el) return null;
    const top = el.getBoundingClientRect().top;
    let best = null;
    let bestD = 1e9;
    for (const b of document.querySelectorAll('.pc-prov')) {
      const r = b.closest('.cm-gutterElement')?.getBoundingClientRect() ?? b.getBoundingClientRect();
      const d = Math.abs(r.top - top);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best && bestD < 14 ? [...best.querySelectorAll('.pc-prov-seg')].map((x) => x.className).join(' ') : null;
  }, id);
}

/**
 * The rail has four steps (① Plan ② Sources ③ To do ④ Check & submit); the older panel names select the
 * step that holds them and open their section ('Sync' -> "Sync with Overleaf" inside ④).
 */
const STEP_OF = { Outline: 'plan', Facts: 'sources', Review: 'todo', Placeholders: 'todo', Questions: 'todo', Sync: 'check', Disclosure: 'check' };
const SYNC = '.shell-panel [data-section="sync"]';

async function openTab(name) {
  const tab = page.locator(`.rail [role="tab"][data-step="${STEP_OF[name] ?? name}"]`);
  const selected = await tab.getAttribute('aria-selected');
  const collapsed = await pc(() => window.__paper.shell.getState().leftCollapsed);
  if (selected !== 'true' || collapsed) await tab.click();
  await sleep(200);
  if (await pc(() => window.__paper.shell.getState().leftCollapsed)) await tab.click();
  if (name === 'Sync' || name === 'Disclosure') {
    const section = name === 'Sync' ? 'sync' : 'disclosure';
    await pc((sec) => window.__paper.shell.getState().focusSection(sec), section);
    await waitFor((sec) => document.querySelector(`.shell-panel [data-section="${sec}"] .psec-toggle`)?.getAttribute('aria-expanded') === 'true', section, 3000, `${section} section open`);
  }
  if (name === 'Facts') await pc(() => window.__paper.shell.getState().setSourcesTab('facts'));
}

/** The top bar's Sync menu: Pull / Push… / last pull report. Returns the Pull item (menu left open). */
async function syncMenuPull() {
  await page.locator('[data-testid="sync-menu"]').click();
  return page.locator('.sync-menu').getByRole('menuitem', { name: /Pull/ });
}

async function waitApp() {
  await page.waitForSelector('.cm-content .pc-s', { timeout: 30000 });
  await waitFor(() => window.__paper?.workspace.getState().units.length > 10 && window.__paper.workspace.getState().connected, null, 15000, 'units and connection');
  await sleep(600);
}

const idStateMap = async () => Object.fromEntries((await unitsNow()).map((u) => [u.id, `${u.state}${u.everAi ? '*' : ''}`]));

function compareMaps(before, after) {
  const ids = Object.keys(before);
  const kept = ids.filter((id) => id in after).length;
  const sameState = ids.filter((id) => after[id] === before[id]).length;
  return { total: ids.length, kept, sameState, extra: Object.keys(after).filter((id) => !(id in before)).length };
}

/* ------------------------------------------------------------------------------------ */
/* The walk                                                                              */
/* ------------------------------------------------------------------------------------ */

async function main() {
  console.log(`work ${WORK}\nshots ${SHOTS}`);
  if (BUILD) {
    process.stdout.write('building the web app (VITE_PAPER_E2E=1)... ');
    buildWeb();
    console.log('done');
  }
  console.log(`project: ${makeProject()}`);
  writeFakeScript();
  let url = await startServer();
  console.log(`server: ${url.replace(/token=[^&]+/, 'token=…')}`);

  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  try {
    await page.goto(url);
    await waitApp();

    await check('real server: the editor decorates every sentence (simulated AI badge, EN UI)', async () => {
      // the UI language lives in the Settings drawer (⚙)
      await page.locator('[data-testid="settings-button"]').click();
      await page.locator('[data-testid="settings-drawer"]').getByRole('button', { name: 'EN', exact: true }).click();
      await page.keyboard.press('Escape');
      await waitFor(() => /sentences/.test(document.querySelector('.statusbar')?.textContent ?? ''), null, 3000, 'English status bar');
      const info = await pc(() => ({
        units: window.__paper.workspace.getState().units.length,
        marks: document.querySelectorAll('.cm-content .pc-s').length,
        fake: !!document.querySelector('.fake-badge'),
        mock: !!document.querySelector('.demo-badge'),
        file: window.__paper.workspace.getState().file,
      }));
      assert(info.units === 26, `${info.units} units (fixture has 26)`);
      assert(info.marks > 5 && info.fake && !info.mock, JSON.stringify(info));
      await pc(() => window.__paper.workspace.getState().editor.revealLine(18));
      await sleep(300);
      await shot('01-open');
      return `${info.units} units, ${info.marks} marks visible, file ${info.file}`;
    });

    let rewriteId = null;
    await check('click a sentence, Chinese instruction, accept: provenance changes, LaTeX intact', async () => {
      rewriteId = await unitId('Machine-learning pipelines such as Exa.TrkX');
      const before = await unitById(rewriteId);
      const beforeText = await unitTextOf(rewriteId);
      assert(before.state === 'human' && !before.everAi, `before: ${before.state}`);
      await clickSentence(rewriteId);
      await waitFor((i) => window.__paper.workspace.getState().activeSentenceId === i, rewriteId, 3000, 'the clicked sentence to become active');
      await page.keyboard.press('Control+i');
      await page.waitForSelector('.pc-card input.pc-input', { timeout: 3000 });
      await page.keyboard.insertText('把引用放在句末，动词提前');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-testid="proposal"]', { timeout: 8000 });
      const prop = await page.locator('[data-testid="proposal"]').innerText();
      assert(CJK.test(prop), 'no Chinese note in the proposal');
      await shot('02-instruct');
      await page.keyboard.press('Control+Enter');
      await waitFor((i) => window.__paper.workspace.getState().units.find((u) => u.id === i)?.state === 'ai-drafted', rewriteId, 5000, 'state ai-drafted');
      await sleep(500);
      const after = await unitById(rewriteId);
      const text = await unitTextOf(rewriteId);
      assert(after.everAi, 'everAi not set');
      assert(text.includes('Wang et al.~\\cite{Wang2022LRT}') && text.includes('Exa.TrkX'), `LaTeX changed: ${text}`);
      assert(text !== beforeText && text.includes('built to find prompt tracks'), `text not rewritten: ${text}`);
      const h = await pc((i) => window.__paper.api.history(i), rewriteId);
      const last = h.versions.at(-1);
      assert(last.origin === 'ai_rewrite' && /^fake-/.test(last.model) && CJK.test(last.instruction ?? ''), `last version ${JSON.stringify(last).slice(0, 200)}`);
      const bar = await gutterStateFor(rewriteId);
      assert(bar && /pc-prov-ai-/.test(bar), `gutter ${bar}`);
      await shot('03-accepted');
      return `${before.state} -> ${after.state} (everAi), version ${last.origin} by ${last.model}; "${beforeText.slice(0, 30)}…" keeps \\cite{Wang2022LRT}`;
    });

    await check('ghost: Ctrl+Space shows a grounded continuation, Tab inserts exactly it', async () => {
      await endOfSentenceLine('This lead holds for every particle species');
      await page.keyboard.press('Enter');
      await page.keyboard.type('The gain');
      await sleep(200);
      await page.keyboard.press('Control+Space');
      await page.waitForSelector('[data-testid="ghost"]', { timeout: 8000 });
      const g = await page.locator('[data-testid="ghost"]').innerText();
      await shot('04-ghost');
      await page.keyboard.press('Tab');
      await waitFor(() => window.__paper.workspace.getState().editor.getText().includes('The gain is shown in Fig.~\\ref{fig:eff}.'), null, 3000, 'accepted ghost in the text');
      const t = await docText();
      assert(!t.includes('The gainThe gain') && t.split('The gain is shown').length === 2, 'prefix duplicated');
      const id = await unitId('The gain is shown');
      await waitFor((i) => {
        const u = window.__paper.workspace.getState().units.find((x) => x.id === i);
        return !!u && u.everAi;
      }, id, 4000, 'ghost sentence provenance');
      const u = await unitById(id);
      return `ghost "${g.trim()}" -> unit ${u.state}${u.everAi ? ' (everAi)' : ''}`;
    });

    await check('intent line in Chinese (teal) rendered by Ctrl+Enter; the author then writes it', async () => {
      await endOfSentenceLine('The gain is shown');
      await page.keyboard.press('Enter');
      await page.keyboard.insertText('这里说明两个径迹重建器的假径迹率');
      await waitFor(() => document.querySelectorAll('.pc-intent-line').length > 0, null, 4000, 'teal intent line');
      await shot('05-intent-line');
      await page.keyboard.press('Control+Enter');
      await page.waitForSelector('.pc-intent-render .pc-ir-option', { timeout: 8000 });
      await shot('06-intent-render');
      await page.keyboard.press('Tab');
      await waitFor(() => !/这里说明两个径迹/.test(window.__paper.workspace.getState().editor.getText()), null, 4000, 'the note replaced by the rendering');
      await sleep(600);
      const id = await unitId('This sentence states the point');
      const u = await unitById(id);
      assert(u.state === 'ai-from-intent' && u.everAi, `state ${u.state}`);
      assert(CJK.test(u.intentNote ?? ''), 'intent note not kept in the sidecar');
      // the simulated rendering is a placeholder (no model call); the author writes the sentence
      await retype(id, 'Both trackers keep the fake-track rate low.');
      await waitFor((i) => {
        const ws = window.__paper.workspace.getState();
        const x = ws.units.find((y) => y.id === i);
        return !!x && ws.editor.getText().slice(x.start, x.end).startsWith('Both trackers') && x.state !== 'ai-from-intent';
      }, id, 4000, 'the author text on the same unit');
      const v = await unitById(id);
      assert(v.everAi, 'everAi was laundered by a human edit');
      return `ai-from-intent (note "${u.intentNote}") -> ${v.state}, everAi kept`;
    });

    await check('compile -> the PDF renders', async () => {
      await page.keyboard.press('Escape');
      await page.locator('.topbar').getByRole('button', { name: 'Compile', exact: true }).click();
      await waitFor(() => window.__paper.workspace.getState().compile.state === 'ok', null, 90000, 'compile ok');
      await page.waitForSelector('.pdfp-page.is-rendered canvas', { timeout: 30000 });
      await sleep(800);
      const c = await pc(() => window.__paper.workspace.getState().compile);
      await shot('07-pdf');
      return `pdfVersion ${c.pdfVersion}, ${await pc(() => document.querySelectorAll('.pdfp-page').length)} page(s)`;
    });

    await check('click in the PDF jumps to the source line (inverse SyncTeX)', async () => {
      // the first sentence of the Results paragraph starts its own typeset line (SyncTeX resolves lines, not words)
      const id = await unitId('On the isolated gun particles');
      const target = (await unitById(id)).line;
      const box = await pc(([l]) => window.__paper.api.synctexForward(window.__paper.workspace.getState().file, l), [target]);
      assert(box, 'no SyncTeX box for the line');
      // bring that page into view, wait for the highlight to fade, then click the typeset line
      await pc((b) => window.__paper.shell.getState().pdf?.showBox(b), box);
      await page.waitForSelector(`.pdfp-page.is-rendered[data-page="${box.page}"] canvas`, { timeout: 20000 });
      await sleep(1800);
      await pc(() => window.__paper.workspace.getState().editor.revealLine(1));
      const r = await pc((n) => {
        const el = document.querySelector(`.pdfp-page[data-page="${n}"]`);
        const b = el.getBoundingClientRect();
        return { left: b.left, top: b.top, width: b.width };
      }, box.page);
      const scale = r.width / 612;
      // box: top-left origin, y = top of the (first) typeset line
      await page.mouse.click(r.left + (box.x + Math.min(20, box.w / 2)) * scale, r.top + (box.y + Math.min(box.h / 2, 4)) * scale);
      await waitFor((l) => window.__paper.workspace.getState().editor.currentLine() === l, target, 6000, `editor at line ${target}`);
      await shot('08-inverse');
      return `PDF page ${box.page} -> main.tex:${target}`;
    });

    await check('Ctrl+Shift+J highlights the current line in the PDF (forward SyncTeX)', async () => {
      const id = await unitId('The fake-track rate is 0.55');
      await pc((i) => window.__paper.workspace.getState().editor.revealSentence(i), id);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Control+Shift+J');
      await page.waitForSelector('.pdfp-hl', { timeout: 6000 });
      await shot('09-forward');
      const line = await pc(() => window.__paper.workspace.getState().editor.currentLine());
      return `line ${line} highlighted`;
    });

    await check('Facts panel shows the facts and the unresolved numerals', async () => {
      await openTab('Facts');
      await waitFor(() => /of \d+ facts/.test(document.querySelector('.shell-panel')?.textContent ?? ''), null, 5000, 'facts listed');
      const txt = await page.locator('.shell-panel').innerText();
      const count = /(\d+) of (\d+) facts/.exec(txt)?.[0] ?? '';
      assert(/Unresolved numerals/i.test(txt), 'no unresolved list');
      const unresolved = await pc(() => window.__paper.workspace.getState().unresolved.length);
      assert(unresolved > 0, 'unresolved list empty');
      await shot('10-facts');
      return `${count}; ${unresolved} unresolved numeral(s)`;
    });

    let dismissedFlag = null;
    await check('lint: the card lists a sentence\'s flags; Dismiss hides one (persisted, full list re-sent)', async () => {
      await waitFor(() => window.__paper.workspace.getState().lint.some((f) => !f.dismissed && f.sentenceId), null, 8000, 'lint flags');
      const flag = await pc(() => {
        const ws = window.__paper.workspace.getState();
        return ws.lint.find((f) => !f.dismissed && f.sentenceId && ws.units.some((u) => u.id === f.sentenceId)) ?? null;
      });
      const total = await pc(() => window.__paper.workspace.getState().lint.length);
      await pc((i) => window.__paper.workspace.getState().editor.revealSentence(i), flag.sentenceId);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Control+.');
      await page.waitForSelector('[data-testid="sentence-card"] [data-testid="lint-dismiss"]', { timeout: 4000 });
      await shot('10b-lint-card');
      const rows = await page.locator('[data-testid="sentence-card"] .pc-lint-row').count();
      // the card shows the check's translated label (core i18n), then the message
      await page.locator('[data-testid="sentence-card"] .pc-lint-row').filter({ hasText: flag.msg.slice(0, 40) }).first().getByTestId('lint-dismiss').click();
      await waitFor((id) => window.__paper.workspace.getState().lint.find((f) => f.id === id)?.dismissed === true, flag.id, 4000, 'flag dismissed');
      await sleep(600); // the server's lint.update (full list) has arrived
      const after = await pc(() => window.__paper.workspace.getState().lint.length);
      assert(after === total, `the list shrank from ${total} to ${after}: lint.update was not the full list`);
      dismissedFlag = flag.id;
      return `${rows} flag(s) on the card; dismissed ${flag.check} ("${flag.msg.slice(0, 50)}"); ${total} flags kept in the list`;
    });

    let drafted = [];
    await check('Outline: add a paragraph job to Results, Draft from outline -> proposed sentences in the Review queue', async () => {
      await openTab('Outline');
      // anti-anchoring: Draft stays locked (and the server answers 409) until the author wrote the five items
      const story = page.locator('.five-items textarea').first();
      await story.scrollIntoViewIfNeeded();
      await story.fill('A tracker trained without the signal finds more displaced particles than the signal-trained baseline.');
      await page.locator('.attest input[type="checkbox"]').first().check();
      const sec = page.locator('.section-card').filter({ hasText: 'Results' }).first();
      await sec.scrollIntoViewIfNeeded();
      const open = await sec.getByRole('button', { name: 'Add paragraph' }).count();
      if (!open) await sec.locator('button').first().click();
      for (const job of ['State the fake-track rates of both trackers', 'Say what the lower fake-track rate buys a search']) {
        await sec.getByRole('button', { name: 'Add paragraph' }).click();
        await sec.locator('input.input').last().fill(job);
        await sleep(150);
      }
      await sec.getByRole('button', { name: 'Draft from outline' }).scrollIntoViewIfNeeded();
      await shot('11-outline');
      const before = await pc(() => window.__paper.workspace.getState().units.filter((u) => u.state === 'proposed' || u.state === 'unsupported').length);
      await sec.getByRole('button', { name: 'Draft from outline' }).click();
      await waitFor((n) => window.__paper.workspace.getState().units.filter((u) => u.state === 'proposed' || u.state === 'unsupported').length > n, before, 15000, 'drafted units');
      await sleep(800);
      drafted = (await unitsNow()).filter((u) => u.state === 'proposed' || u.state === 'unsupported');
      await openTab('Review');
      await waitFor(() => document.querySelectorAll('.review-list .review-main').length > 0, null, 4000, 'review entries');
      const n = await page.locator('.review-main').count();
      await shot('12-review');
      const texts = await Promise.all(drafted.map((u) => unitTextOf(u.id)));
      assert(!texts.some((t) => CJK.test(t ?? '')), 'CJK in drafted text');
      return `${drafted.length} drafted (${drafted.map((u) => u.state).join(', ')}), ${n} in the queue; e.g. "${(texts[0] ?? '').slice(0, 60)}…"`;
    });

    await check('push is refused while a proposed sentence exists', async () => {
      await openTab('Sync');
      await page.locator(SYNC).getByRole('button', { name: 'Check', exact: true }).click();
      await waitFor(() => !!document.querySelector('.shell-panel .blockers'), null, 6000, 'blockers');
      const txt = await page.locator('.shell-panel .blockers').innerText();
      assert(/proposed|unsupported/i.test(txt), `blockers: ${txt.slice(0, 120)}`);
      const disabled = await page.locator(SYNC).getByRole('button', { name: 'Push', exact: true }).isDisabled();
      assert(disabled, 'Push button enabled');
      const res = await pc(() => window.__paper.api.push('should be refused'));
      assert(res.ok === false && /refused/i.test(res.output), `push result ${JSON.stringify(res).slice(0, 160)}`);
      const remoteLog = gitBare('log', '--oneline', 'master').trim().split('\n');
      assert(remoteLog.length === 1, `remote changed: ${remoteLog.join(' / ')}`);
      await shot('13-push-refused');
      return res.output.split('\n')[0];
    });

    await check('submission check (top-bar pill) lists the proposed sentences as unreviewed blockers; a row reveals one', async () => {
      await page.locator('[data-testid="submission-pill"]').click();
      await page.waitForSelector('[data-testid="submission-check"] .sub-list', { timeout: 8000 });
      const rep = await pc(() => window.__paper.api.submissionCheck());
      const un = rep.items.find((i) => i.id === 'unreviewed');
      const proposed = (await unitsNow()).filter((u) => u.state === 'proposed').map((u) => u.id);
      assert(un && !un.ok && un.severity === 'block' && un.count === proposed.length, `unreviewed item ${JSON.stringify(un).slice(0, 200)}`);
      assert(proposed.every((id) => un.items.some((e) => e.sentenceId === id)), 'a proposed sentence is not listed');
      assert(rep.ok === false && rep.blockers >= 1, `report ok=${rep.ok} blockers=${rep.blockers}`);
      await waitFor(() => /issue/.test(document.querySelector('[data-testid="submission-pill"]')?.textContent ?? ''), null, 4000, 'the pill to show issues');
      const head = page.locator('[data-testid="submission-check"] [data-item="unreviewed"] .sub-head');
      await head.click();
      await shot('13b-submission');
      await page.locator('[data-testid="submission-check"] [data-item="unreviewed"] .sub-entries .list-row').first().click();
      await waitFor((ids) => ids.includes(window.__paper.workspace.getState().activeSentenceId), proposed, 4000, 'the listed sentence revealed');
      const pill = await page.locator('[data-testid="submission-pill"]').innerText();
      return `pill "${pill.trim()}"; unreviewed ${un.count} (${un.items.map((e) => `line ${e.line}`).join(', ')}), ${rep.blockers} blocker(s), ${rep.warnings} warning(s)`;
    });

    await check('review: accept the drafted sentences, reject one (claim placeholder), the author removes it', async () => {
      await openTab('Review');
      const queue = (await unitsNow()).filter((u) => u.state === 'proposed' || u.state === 'unsupported');
      assert(queue.length >= 2, `${queue.length} in the queue`);
      const rejectId = queue[queue.length - 1].id;
      // accept all but the last from the queue's buttons
      for (const u of queue.slice(0, -1)) {
        await page.getByRole('button', { name: `Accept sentence on line ${u.line}` }).first().click().catch(async () => {
          await pc((i) => window.__paper.api.accept(i), u.id);
        });
        await waitFor((i) => window.__paper.workspace.getState().units.find((x) => x.id === i)?.state === 'ai-drafted', u.id, 4000, `accept ${u.id}`);
      }
      // reject the last with the card (Ctrl+. then x)
      await pc((i) => window.__paper.workspace.getState().editor.revealSentence(i), rejectId);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Control+.');
      await page.waitForSelector('[data-testid="sentence-card"]', { timeout: 3000 });
      await page.keyboard.press('x');
      await waitFor((i) => {
        const ws = window.__paper.workspace.getState();
        const u = ws.units.find((x) => x.id === i);
        return !!u && /^\[claim: .*\?\]$/.test(ws.editor.getText().slice(u.start, u.end).trim());
      }, rejectId, 5000, 'claim placeholder');
      await shot('14-rejected');
      const rej = await unitById(rejectId);
      // the author deletes the placeholder line (an explicit decision: the claim is dropped)
      await pc((i) => window.__paper.workspace.getState().editor.revealSentence(i), rejectId); // selects it
      await page.keyboard.press('Backspace');
      await page.keyboard.press('Backspace'); // and the now empty line
      await waitFor((i) => !window.__paper.workspace.getState().units.some((x) => x.id === i), rejectId, 4000, 'placeholder gone');
      const left = (await unitsNow()).filter((u) => u.state === 'proposed' || u.state === 'unsupported' || u.state === 'placeholder').length;
      assert(left === 0, `${left} unreviewed left`);
      const status = await page.locator('.statusbar').innerText();
      return `${queue.length - 1} accepted, 1 rejected -> ${rej.state} -> removed; ${status.split('\n').find((x) => /review/.test(x)) ?? ''}`;
    });

    await check('submission check after the review: the unreviewed blocker is gone; once the author adds the APS AI-use statement it is clean', async () => {
      const failingBlocks = (r) => r.items.filter((i) => !i.ok && i.severity === 'block');
      let rep = null;
      for (let i = 0; i < 20; i++) {
        rep = await pc(() => window.__paper.api.submissionCheck());
        if (rep.items.find((x) => x.id === 'unreviewed')?.ok) break;
        await sleep(300);
      }
      for (const id of ['unreviewed', 'unsupported', 'placeholders', 'intent_lines', 'cjk']) {
        const it = rep.items.find((x) => x.id === id);
        assert(it && it.ok && it.count === 0, `${id}: ${JSON.stringify(it).slice(0, 160)}`);
      }
      // AI text is in the record, so the venue's disclosure statement is the one blocker left
      const left = failingBlocks(rep).map((i) => i.id);
      assert(JSON.stringify(left) === '["disclosure"]', `blockers after the review: ${left.join(', ')}`);
      await page.locator('[data-testid="submission-pill"]').click();
      await page.waitForSelector('[data-testid="submission-check"] [data-item="disclosure"]', { timeout: 8000 });
      await waitFor(() => !document.querySelector('[data-testid="submission-check"] [data-item="unreviewed"].sub-block'), null, 6000, 'the unreviewed row to clear');
      await shot('14b-submission-after-review');
      // the author pastes the generated statement into the acknowledgments (as typed text)
      const d = await pc(() => window.__paper.api.disclosure('aps'));
      assert(d.latex.length > 40 && !CJK.test(d.latex), 'disclosure LaTeX');
      await endOfSentenceLine('On validation, the same comparison');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await page.keyboard.insertText(`\\begin{acknowledgments}\n${d.latex.trim()}\n\\end{acknowledgments}`);
      await waitFor(() => /\\end\{acknowledgments\}/.test(window.__paper.workspace.getState().editor.getText()), null, 3000, 'the statement in the text');
      for (let i = 0; i < 30; i++) {
        rep = await pc(() => window.__paper.api.submissionCheck());
        if (rep.ok) break;
        await sleep(300);
      }
      assert(rep.ok && rep.blockers === 0 && failingBlocks(rep).length === 0, `blockers left: ${failingBlocks(rep).map((i) => `${i.id} (${i.count})`).join(', ')}`);
      await page.locator('[data-testid="submission-check"]').getByRole('button', { name: /Run|Check again|Re-run|Refresh/ }).first().click().catch(() => undefined);
      await waitFor(() => !document.querySelector('[data-testid="submission-pill"].submit-blocked'), null, 8000, 'the pill to leave the blocked state');
      const pill = await page.locator('[data-testid="submission-pill"]').innerText();
      await shot('14c-submission-clean');
      const warn = rep.items.filter((i) => !i.ok && i.severity === 'warn').map((i) => i.id);
      return `pill "${pill.trim()}"; 0 blockers; open warnings: ${warn.join(', ') || 'none'}`;
    });

    await check('push allowed after review; the remote receives only .tex changes (no .paper, no CJK)', async () => {
      await sleep(1500); // disk write debounce
      await openTab('Sync');
      await page.locator(SYNC).getByRole('button', { name: 'Check', exact: true }).click();
      await waitFor(() => /Ready to push/.test(document.querySelector('.shell-panel')?.textContent ?? ''), null, 8000, 'ready to push');
      await page.locator(`${SYNC} input.input`).first().fill('Results: reviewed rewrite, ghost and draft sentences');
      const btn = page.locator(SYNC).getByRole('button', { name: 'Push', exact: true });
      assert(!(await btn.isDisabled()), 'Push still disabled');
      await shot('15-push-ready');
      await btn.click();
      await waitFor(() => /Pushed|\.\.|master/.test(document.querySelector('.shell-panel .log-tail')?.textContent ?? ''), null, 20000, 'push output');
      const out = await page.locator('.shell-panel .log-tail').innerText();
      const logLines = gitBare('log', '--oneline', 'master').trim().split('\n');
      assert(logLines.length === 2, `remote log: ${logLines.join(' / ')}`);
      const files = gitBare('show', '--name-only', '--format=', 'master').trim().split('\n').filter(Boolean);
      assert(files.length === 1 && files[0] === 'main.tex', `pushed files: ${files.join(', ')}`);
      const tree = gitBare('ls-tree', '-r', '--name-only', 'master').trim().split('\n');
      assert(!tree.some((f) => f.startsWith('.paper') || f.includes('paper.db')), `tree: ${tree.join(', ')}`);
      const pushed = gitBare('show', 'master:main.tex');
      assert(!CJK.test(pushed), 'CJK reached the remote');
      assert(!/\[claim:|\[fact\?|\[ref\]/.test(pushed), 'a placeholder reached the remote');
      assert(pushed.includes('The gain is shown in Fig.~\\ref{fig:eff}.') && pushed.includes('Both trackers keep the fake-track rate low.'), 'reviewed text missing on the remote');
      await shot('16-pushed');
      return `${out.split('\n')[0]}; remote: ${logLines[0]}; files ${files.join(', ')}`;
    });

    let beforePull = null;
    let editedId = null;
    await check('co-author edits in "Overleaf" (one sentence edited, one inserted) -> Pull: >= 95% ids kept, edited sentence external, editor updated', async () => {
      git(WORK, 'clone', '--quiet', P.remote, P.coauthor);
      const f = join(P.coauthor, 'main.tex');
      let t = readFileSync(f, 'utf8');
      assert(t.includes('The test set holds 8,710 targets.'), 'fixture sentence missing');
      t = t.replace('The test set holds 8,710 targets.', 'The test set contains 8,710 targets.');
      t = t.replace('This lead holds for every particle species.', 'This lead holds for every particle species.\nThe same holds for the validation sample.');
      writeFileSync(f, t);
      git(P.coauthor, 'commit', '--quiet', '-am', 'Advisor: wording in Results');
      git(P.coauthor, 'push', '--quiet', 'origin', 'HEAD:master');
      editedId = await unitId('The test set holds');
      beforePull = await idStateMap();
      await (await syncMenuPull()).click();
      await waitFor(() => window.__paper.workspace.getState().editor.getText().includes('The test set contains 8,710 targets.'), null, 15000, 'editor updated by doc.replace');
      await sleep(800);
      const after = await idStateMap();
      const cmp = compareMaps(beforePull, after);
      const pct = (100 * cmp.kept) / cmp.total;
      assert(pct >= 95, `${cmp.kept}/${cmp.total} ids kept`);
      const e = await unitById(editedId);
      assert(e && e.state === 'external', `edited sentence: ${e?.state}`);
      assert((await unitTextOf(editedId)).startsWith('The test set contains'), 'edited sentence text');
      const insId = await unitId('The same holds for the validation sample');
      const ins = await unitById(insId);
      assert(ins.state === 'external', `inserted sentence: ${ins.state}`);
      await pc((i) => window.__paper.workspace.getState().editor.revealSentence(i), editedId);
      await sleep(400);
      await shot('17-pulled');
      return `${cmp.kept}/${cmp.total} ids kept (${pct.toFixed(1)}%), ${cmp.extra} new; edited -> external, inserted -> external`;
    });

    await check('APS disclosure shows the right counts', async () => {
      await openTab('Disclosure');
      await waitFor(() => (document.querySelector('.disclosure-text')?.value ?? '').length > 40, null, 6000, 'disclosure text');
      const d = await pc(() => window.__paper.api.disclosure('aps'));
      const us = await unitsNow();
      const prose = us.filter((u) => u.kind === 'prose');
      const everAi = us.filter((u) => u.everAi).length;
      const st = d.stats;
      const text = await page.locator('.disclosure-text').inputValue();
      await page.locator('.disclosure-text').scrollIntoViewIfNeeded();
      await shot('18-disclosure');
      assert(st.everAi === everAi, `stats.everAi ${st.everAi}, units with everAi ${everAi}`);
      assert(typeof st.totalSentences === 'number' && st.totalSentences >= prose.length - 2, `total ${st.totalSentences} vs ${prose.length} prose units`);
      assert(/Claude|AI|language model/i.test(text), 'statement text');
      // the text the author copies states the same counts (fresh after the pull, not from when the panel opened)
      assert(text.includes(`Of the ${st.totalSentences} sentences in the text, ${everAi} were produced or changed with the tool`), `statement counts: ${text.slice(0, 400)}`);
      assert(st.aiRewrittenOnRequest === 1 && /1 of the authors' sentence was rewritten by the tool on the authors' instructions/.test(text), 'the instruction rewrite is not reported as such');
      assert(st.aiDrafted === 2 && /2 sentences were drafted by the tool/.test(text), `drafted count ${st.aiDrafted}`);
      assert(st.aiFromIntent === 0 && st.aiEdited === 1 && /1 sentence was drafted by the tool and then edited by the authors/.test(text), 'edited count');
      return `stats ${JSON.stringify(st).slice(0, 200)}`;
    });

    let abstractId = null;
    let abstractText = null;
    await check('consistency (④): a number edited in the abstract so it differs from the body is flagged; the row reveals the sentence', async () => {
      abstractId = await unitId('On isolated displaced particles that neither model saw');
      abstractText = await unitTextOf(abstractId);
      assert(abstractText.includes('against 1.38\\%'), `abstract: ${abstractText}`);
      const before = await pc(() => window.__paper.api.consistency());
      assert(!before.flags.some((f) => /^drift_/.test(f.kind) && f.sentenceIds.includes(abstractId)), 'a drift flag on the abstract before the edit');
      // the author mistypes the baseline's fake-track rate in the abstract (1.38 -> 1.36; the body keeps 1.38)
      await retype(abstractId, abstractText.replace('against 1.38\\%', 'against 1.36\\%'));
      await waitFor((i) => {
        const ws = window.__paper.workspace.getState();
        const u = ws.units.find((x) => x.id === i);
        return !!u && ws.editor.getText().slice(u.start, u.end).includes('1.36');
      }, abstractId, 4000, 'the edit on the abstract sentence');
      await sleep(400);
      let flag = null;
      for (let i = 0; i < 20 && !flag; i++) {
        const rep = await pc(() => window.__paper.api.consistency());
        flag = rep.flags.find((f) => /^drift_/.test(f.kind) && f.sentenceIds.includes(abstractId)) ?? null;
        if (!flag) await sleep(250);
      }
      assert(flag, 'no drift flag on the abstract sentence');
      const sec = page.locator('.shell-panel [data-section="consistency"]');
      await openTab('Disclosure'); // selects step ④
      const toggle = sec.locator('.psec-toggle').first();
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
      // the section loads its report when opened; refresh it if it was loaded before the edit
      await waitFor(() => !!document.querySelector('.shell-panel [data-section="consistency"] .report-body'), null, 6000, 'the consistency report');
      const refresh = sec.getByRole('button', { name: /Refresh|Re-run|Run again/ });
      if (await refresh.count()) await refresh.first().click();
      const row = sec.locator('.flag-list .flag').filter({ hasText: '1.36' }).first();
      await row.waitFor({ timeout: 6000 });
      const label = await row.locator('.flag-label').innerText();
      await row.scrollIntoViewIfNeeded();
      await shot('24-consistency-drift');
      await pc(() => window.__paper.workspace.getState().editor.revealLine(60));
      await row.locator('button.list-row').click();
      await waitFor((ids) => ids.includes(window.__paper.workspace.getState().activeSentenceId), flag.sentenceIds, 4000, 'the flagged sentence revealed');
      return `${flag.kind} (${label}): "${flag.message.slice(0, 110)}"`;
    });

    await check('restore: the card History brings back the imported abstract sentence as one change; the drift flag goes away', async () => {
      assert(abstractId, 'no abstract sentence from the previous check');
      const h0 = await pc((i) => window.__paper.api.history(i), abstractId);
      assert(h0.versions.length >= 2 && h0.versions[0].origin === 'import', `versions ${h0.versions.map((v) => v.origin).join(',')}`);
      await pc((i) => window.__paper.workspace.getState().editor.revealSentence(i), abstractId);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Control+.');
      await page.waitForSelector('[data-testid="sentence-card"]', { timeout: 3000 });
      await page.keyboard.press('h');
      await page.waitForSelector('.pc-history .pc-hist-restore', { timeout: 4000 });
      await shot('25-history');
      // the oldest version (the imported text) is the last row
      await page.locator('.pc-history .pc-hist-restore').last().click();
      await waitFor(([i, t]) => {
        const ws = window.__paper.workspace.getState();
        const u = ws.units.find((x) => x.id === i);
        return !!u && ws.editor.getText().slice(u.start, u.end) === t;
      }, [abstractId, abstractText], 5000, 'the imported text back on the same sentence');
      await sleep(800);
      const u = await unitById(abstractId);
      assert(u.state === 'human' && !u.everAi, `state ${u.state}${u.everAi ? ' everAi' : ''}`);
      const h1 = await pc((i) => window.__paper.api.history(i), abstractId);
      assert(h1.versions.length === h0.versions.length + 1 && h1.versions.at(-1).origin === 'human_edit' && h1.versions.at(-1).text === abstractText, `history after: ${h1.versions.map((v) => v.origin).join(',')}`);
      for (let i = 0; i < 20; i++) {
        const rep = await pc(() => window.__paper.api.consistency());
        if (!rep.flags.some((f) => /^drift_/.test(f.kind) && f.sentenceIds.includes(abstractId))) return `${h0.versions.length} -> ${h1.versions.length} versions (restore recorded as human_edit), state human; drift flag cleared`;
        await sleep(250);
      }
      throw new Error('the drift flag is still reported after the restore');
    });

    let derivedId = null;
    await check('instruct proposal stating a derived "2.5 times" (ratio of two facts): the gate accepts it and links both facts', async () => {
      const rels = await pc(() => window.__paper.api.request('GET', '/api/facts/derived'));
      const rel = rels.find((r) => r.kind === 'ratio' && r.raw === '2.5' && r.factIds.some((f) => /fake_rate_A/.test(f)) && r.factIds.some((f) => /fake_rate_B/.test(f)));
      assert(rel, `no 2.5 ratio of the fake-track rates among ${rels.length} relations`);
      derivedId = await unitId('The fake-track rate is 0.55');
      const before = await unitById(derivedId);
      await clickSentence(derivedId);
      await waitFor((i) => window.__paper.workspace.getState().activeSentenceId === i, derivedId, 3000, 'the sentence to become active');
      await page.keyboard.press('Control+i');
      await page.waitForSelector('.pc-card input.pc-input', { timeout: 3000 });
      await page.keyboard.insertText('补一句：比基线低了多少倍');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-testid="proposal"]', { timeout: 8000 });
      const prop = await page.locator('[data-testid="proposal"]').innerText();
      assert(prop.includes('2.5 times'), `proposal: ${prop.slice(0, 200)}`);
      const blocks = await page.locator('.pc-card .pc-issue-block').count();
      assert(blocks === 0, `the gate blocked the derived number: ${await page.locator('.pc-card .pc-issues').innerText().catch(() => '')}`);
      await shot('26-derived-proposal');
      await page.keyboard.press('Control+Enter');
      await waitFor((i) => window.__paper.workspace.getState().units.find((u) => u.id === i)?.state === 'ai-drafted', derivedId, 5000, 'state ai-drafted');
      await sleep(400);
      const text = await unitTextOf(derivedId);
      assert(text === DERIVED_SENTENCE, `text: ${text}`);
      const u = await unitById(derivedId);
      assert(u.everAi && rel.factIds.every((f) => u.facts.includes(f)), `unit facts ${JSON.stringify(u.facts)} lack ${rel.factIds.join(', ')}`);
      const last = (await pc((i) => window.__paper.api.history(i), derivedId)).versions.at(-1);
      assert(last.origin === 'ai_rewrite' && /^fake-/.test(last.model), `last version ${last.origin} ${last.model}`);
      return `${before.state} -> ${u.state}; "${rel.description ?? rel.raw}" links ${rel.factIds.join(' + ')}`;
    });

    await check('repo watcher: re-running the analysis (a result JSON changes) marks its facts stale: notice, Facts panel, card chip, consistency', async () => {
      const claim = join(P.repo, 'results', 'addendum_g_g1_v1_claim.json');
      const j = JSON.parse(readFileSync(claim, 'utf8'));
      j.fake_rate_A = 0.0049271;
      // record notices as they arrive (toasts close by themselves)
      await pc(() => {
        window.__e2eNotices = [];
        window.__paper.workspace.subscribe((st, prev) => {
          if (st.notices !== prev.notices) for (const n of st.notices) if (!window.__e2eNotices.some((x) => x.id === n.id)) window.__e2eNotices.push(n);
        });
      });
      writeFileSync(claim, `${JSON.stringify(j, null, 1)}\n`);
      await waitFor(() => window.__paper.workspace.getState().facts.some((f) => f.stale && /fake_rate_A$/.test(f.id)), null, 15000, 'the fact to turn stale');
      const stale = await pc(() => window.__paper.workspace.getState().facts.filter((f) => f.stale).map((f) => f.id));
      await waitFor(() => window.__e2eNotices.some((n) => /addendum_g_g1_v1_claim\.json/.test(n.message)), null, 5000, 'the watcher notice');
      const notice = await pc(() => window.__e2eNotices.find((n) => /addendum_g_g1_v1_claim\.json/.test(n.message)));
      assert(notice.level === 'warn', `notice level ${notice.level}`);
      // Facts panel, "stale" filter
      await openTab('Facts');
      await page.locator('.shell-panel select[aria-label="Show"]').selectOption('stale');
      await waitFor(() => [...document.querySelectorAll('.shell-panel .badge-warn')].some((b) => /stale/.test(b.textContent ?? '')), null, 4000, 'a stale badge in the Facts panel');
      const listed = await pc(() => document.querySelector('.shell-panel .count-line')?.textContent ?? '');
      await shot('27-facts-stale');
      // the sentence that states the fact shows the stale chip on its card
      await pc((i) => window.__paper.workspace.getState().editor.revealSentence(i), derivedId);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Control+.');
      await page.waitForSelector('[data-testid="sentence-card"] .pc-chip-fact', { timeout: 4000 });
      const chips = await page.locator('[data-testid="sentence-card"] .pc-chip-fact.pc-stale').count();
      assert(chips >= 1, 'no stale chip on the card');
      await shot('28-card-stale');
      await page.keyboard.press('Escape');
      await page.locator('.shell-panel select[aria-label="Show"]').selectOption('all');
      const rep = await pc(() => window.__paper.api.consistency());
      assert(rep.stale.some((x) => /fake_rate_A$/.test(x.factId) && x.sentences.length > 0), `consistency stale: ${JSON.stringify(rep.stale).slice(0, 200)}`);
      return `${stale.length} stale fact(s) (${stale.slice(0, 3).join(', ')}); Facts panel "${listed.trim()}"; notice "${notice.message.slice(0, 80)}…"; ${chips} stale chip(s) on the card`;
    });

    await check('reload the page -> ids and states persist', async () => {
      await sleep(1500);
      const before = await idStateMap();
      await page.reload();
      await waitApp();
      const after = await idStateMap();
      const cmp = compareMaps(before, after);
      assert(cmp.kept === cmp.total && cmp.sameState === cmp.total && cmp.extra === 0, JSON.stringify(cmp));
      if (dismissedFlag) await waitFor((id) => window.__paper.workspace.getState().lint.find((f) => f.id === id)?.dismissed === true, dismissedFlag, 6000, 'the dismissed flag to stay dismissed after reload');
      await shot('19-reloaded');
      return `${cmp.sameState}/${cmp.total} ids and states identical`;
    });

    await check('kill -9 the server, keep typing offline, restart: the page reconnects by itself, nothing typed is lost, ids/states/history/PDF persist', async () => {
      const before = await idStateMap();
      const hist = await pc((i) => window.__paper.api.history(i), rewriteId);
      await sleep(2000);
      await stopServer('SIGKILL');
      await waitFor(() => !window.__paper.workspace.getState().connected, null, 8000, 'the page to notice the server is gone');
      // the author keeps writing while the server is down
      await endOfSentenceLine('The principal limitation');
      await page.keyboard.press('Enter');
      const typed = 'Pileup is left for future work.';
      await page.keyboard.type(typed);
      await sleep(300);
      await shot('20-offline');
      url = await startServer(); // a new launch token; the page is NOT reloaded
      await waitFor(() => window.__paper.workspace.getState().connected, null, 20000, 'the page to reconnect on its own');
      const disk = join(P.tex, 'main.tex');
      for (let i = 0; i < 60 && !readFileSync(disk, 'utf8').includes(typed); i++) await sleep(250);
      assert(readFileSync(disk, 'utf8').includes(typed), 'the sentence typed while offline did not reach the file');
      const live = await idStateMap();
      const c1 = compareMaps(before, live);
      assert(c1.kept === c1.total && c1.sameState === c1.total && c1.extra === 1, `after reconnect ${JSON.stringify(c1)}`);
      await page.goto(url); // and a fresh load with the new token sees the same
      await waitApp();
      const after = await idStateMap();
      const cmp = compareMaps(live, after);
      assert(cmp.kept === cmp.total && cmp.sameState === cmp.total && cmp.extra === 0, JSON.stringify(cmp));
      // the last good PDF is shown again without a recompile
      await waitFor(() => window.__paper.workspace.getState().compile.pdfVersion !== null, null, 8000, 'the last PDF after the restart');
      await page.waitForSelector('.pdfp-page.is-rendered canvas', { timeout: 20000 });
      const hist2 = await pc((i) => window.__paper.api.history(i), rewriteId);
      assert(hist2.versions.length === hist.versions.length && hist2.unit.everAi, 'history changed');
      await shot('21-restarted');
      return `reconnected without reload, offline sentence saved; ${cmp.sameState}/${cmp.total} ids and states identical; ${hist2.versions.length} versions of the rewritten sentence`;
    });

    await check('dark mode (editor, card, panel)', async () => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await pc(() => window.__paper.shell.getState().setTheme?.('dark'));
      await sleep(300);
      await openTab('Review');
      await clickSentence(rewriteId);
      await page.keyboard.press('Control+.');
      await page.waitForSelector('[data-testid="sentence-card"]', { timeout: 3000 });
      const bg = await pc(() => getComputedStyle(document.body).backgroundColor);
      await shot('22-dark');
      await page.keyboard.press('Escape');
      await page.emulateMedia({ colorScheme: 'light' });
      await pc(() => window.__paper.shell.getState().setTheme?.('light'));
      return `body ${bg}`;
    });

    await check('sync mode "none": Pull disabled, Push hidden, the panel says why; the guard never reports ok', async () => {
      await stopServer('SIGTERM');
      paper('init', P.proj, '--sync', 'none');
      url = await startServer();
      await page.goto(url);
      await waitApp();
      await openTab('Sync');
      await waitFor(() => !!document.querySelector('[data-testid="sync-off"]'), null, 5000, 'the sync-off note');
      const pullItem = await syncMenuPull();
      const pullDisabled = await pullItem.isDisabled();
      await page.keyboard.press('Escape');
      assert(pullDisabled, 'top-bar Pull enabled');
      await page.locator(SYNC).getByRole('button', { name: 'Check', exact: true }).click();
      await sleep(800);
      const pushButtons = await page.locator(SYNC).getByRole('button', { name: 'Push', exact: true }).count();
      assert(pushButtons === 0, 'Push button shown');
      const c = await pc(() => window.__paper.api.pushCheck());
      assert(c.ok === false && /sync mode "none"/.test(c.unavailable ?? ''), `push-check ${JSON.stringify(c).slice(0, 160)}`);
      const note = await page.locator('[data-testid="sync-off"]').innerText();
      await shot('23-sync-off');
      return note.slice(0, 90);
    });

    await check('large \\input project (fixtures/large-multifile): the file switcher lists main.tex and its 4 sections with counts; switching opens each file', async () => {
      await stopServer('SIGTERM');
      console.log(`      large project: ${makeLargeProject()}`);
      url = await startServer(P.large);
      await page.goto(url);
      await waitApp();
      const files = await pc(() => window.__paper.api.files());
      const names = files.map((f) => f.file);
      assert(names[0] === 'main.tex' && names.length === 5 && ['sections/intro.tex', 'sections/method.tex', 'sections/results.tex', 'sections/appendix.tex'].every((f) => names.includes(f)), `files ${names.join(', ')}`);
      const sentences = files.reduce((n, f) => n + (f.sentences ?? f.units ?? 0), 0);
      await page.locator('[data-testid="file-switcher"]').click();
      const items = await pc(() => [...document.querySelectorAll('.file-menu [data-file]')].map((b) => b.getAttribute('data-file')));
      assert(JSON.stringify(items) === JSON.stringify(names), `menu ${items.join(', ')} vs ${names.join(', ')}`);
      await shot('29-files-menu');
      const opened = [];
      for (const f of ['sections/method.tex', 'sections/results.tex', 'sections/appendix.tex', 'main.tex']) {
        if (!(await page.locator('.file-menu').count())) await page.locator('[data-testid="file-switcher"]').click();
        await page.locator(`.file-menu [data-file="${f}"]`).click();
        await waitFor((x) => {
          const ws = window.__paper.workspace.getState();
          return ws.file === x && ws.units.length > 0 && ws.units.every((u) => u.file === x) && !!ws.editor && ws.editor.getText().length > 0;
        }, f, 10000, `${f} open`);
        const t = await docText();
        const disk = readFileSync(join(P.large, 'tex', f), 'utf8');
        assert(t === disk, `${f}: the editor text differs from the file on disk`);
        const crumb = await page.locator('.topbar .crumb-file').innerText();
        assert(crumb.includes(f.split('/').pop()), `crumb ${crumb}`);
        opened.push(`${f} ${await pc(() => window.__paper.workspace.getState().units.length)}`);
        if (f === 'sections/results.tex') {
          await sleep(300);
          await shot('30-files-results');
        }
      }
      return `${names.length} files, ${sentences} sentences in all; opened ${opened.join(', ')}`;
    });

    await check('the 4-step layout on the real server: 中文, light and dark (rail, each step, Settings) without overflow', async () => {
      await page.locator('[data-testid="settings-button"]').click();
      await page.locator('[data-testid="settings-drawer"]').getByRole('button', { name: '中文', exact: true }).click();
      await page.keyboard.press('Escape');
      await waitFor(() => /句/.test(document.querySelector('.statusbar')?.textContent ?? ''), null, 3000, 'Chinese status bar');
      const tabs = await page.locator('.rail [role="tab"]').allInnerTexts();
      assert(tabs.length === 4 && /构思/.test(tabs[0]) && /资料/.test(tabs[1]) && /待办/.test(tabs[2]) && /检查/.test(tabs[3]), `rail ${tabs.map((x) => x.replace(/\s+/g, '')).join(' | ')}`);
      const problems = [];
      for (const scheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: scheme });
        await pc((t) => window.__paper.shell.getState().setTheme?.(t), scheme);
        for (const step of ['plan', 'sources', 'todo', 'check']) {
          const tab = page.locator(`.rail [role="tab"][data-step="${step}"]`);
          if ((await tab.getAttribute('aria-selected')) !== 'true' || (await pc(() => window.__paper.shell.getState().leftCollapsed))) await tab.click();
          await sleep(350);
          const m = await pc(() => {
            const se = document.scrollingElement;
            const panel = document.querySelector('.shell-panel');
            const over = panel ? [...panel.querySelectorAll('*')].filter((el) => el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX === 'visible' && el.clientWidth > 0).length : 0;
            return { page: se.scrollWidth > innerWidth || se.scrollHeight > innerHeight, panelX: panel ? panel.scrollWidth > panel.clientWidth + 1 : false, over };
          });
          if (m.page || m.panelX) problems.push(`${scheme}/${step}: ${JSON.stringify(m)}`);
          await shot(`31-zh-${scheme}-${step}`);
        }
        await page.locator('[data-testid="settings-button"]').click();
        await page.waitForSelector('[data-testid="settings-drawer"]', { timeout: 3000 });
        await shot(`31-zh-${scheme}-settings`);
        await page.keyboard.press('Escape');
      }
      await page.emulateMedia({ colorScheme: 'light' });
      await pc(() => window.__paper.shell.getState().setTheme?.('light'));
      assert(problems.length === 0, problems.join('; '));
      return `rail ${tabs.map((x) => x.replace(/\s+/g, '')).join(' · ')}; 2 x 5 screenshots`;
    });

    await check('no page errors', async () => {
      const real = errors.filter((e) => !/favicon|ERR_CONNECTION_REFUSED|WebSocket connection|Failed to load resource/.test(e));
      assert(real.length === 0, `page errors: ${real.slice(0, 3).join(' | ')}`);
      return errors.length ? `${errors.length} expected connection error(s) while the server was down` : '';
    });
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
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed; screenshots in ${SHOTS}${KEEP ? `; work dir ${WORK}` : ''}`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await stopServer('SIGKILL').catch(() => undefined);
  if (existsSync(P.serverLog)) console.error(readFileSync(P.serverLog, 'utf8').slice(-3000));
  process.exit(2);
});
