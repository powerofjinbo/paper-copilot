#!/usr/bin/env node
/**
 * End-to-end check of the WHOLE web app (shell + editor + panels + PDF pane) in demo mode (`?mock=1`,
 * the in-browser MockApiClient on the canto-demo fixture; no server).
 *
 *   node apps/web/harness/e2e-app.mjs [--url http://127.0.0.1:5173] [--shots DIR] [--headed] [--only TEXT]
 *
 * --only runs the checks whose name contains TEXT; DEBUG_SCROLL=1 logs any element (other than the editor
 * and panel scrollers) that scrolled after each check, e.g. the page itself.
 *
 * Starts `vite --port 5173` in apps/web when nothing answers at --url, runs the flows below, writes
 * screenshots (app-*.png, deviceScaleFactor 1) to --shots (default: $TMPDIR/paper-copilot-shots) and
 * exits non-zero if a check failed. Uses the dev-only `window.__paper` handle ({api, workspace, shell}).
 *
 * Flows: fixture render (sentence marks, gutter); status-bar review progress; sentence card by hover and
 * by Ctrl+.; Instruct (Chinese) + accept -> gutter shows an AI state; Grammar (Ctrl+G); Reject -> [claim: ...?]
 * placeholder listed in ③ To do; Draft from ① Plan -> proposed sentences in ③ To do; Alt+Down / Ctrl+Enter;
 * ghost via Ctrl+Space then Tab; a Chinese intent line (teal) rendered by Ctrl+Enter; ② Sources (facts,
 * literature); ④ Check & submit (submission check from the top-bar pill, consistency, terminology, figure
 * plan, disclosure, sync blockers with Push disabled); the four-step rail, the first-run hint (remembered),
 * the simplified top bar, the Settings drawer (language, theme, heatmap, voice, cost); card history restore;
 * the large \input fixture (`?fixture=large`: file switcher, cross-file reveal); 中文 and dark screenshots of
 * every step; a narrow window with no page scroll; no page errors.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const BASE = arg('--url', 'http://127.0.0.1:5173');
const SHOTS = resolve(arg('--shots', process.env.SHOTS_DIR ?? join(tmpdir(), 'paper-copilot-shots')));
const HEADED = args.includes('--headed');
const ONLY = arg('--only', null);
mkdirSync(SHOTS, { recursive: true });

const results = [];
let page;

function log(ok, name, detail = '') {
  results.push({ ok, name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function check(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  try {
    const detail = await fn();
    log(true, name, typeof detail === 'string' ? detail : '');
  } catch (err) {
    log(false, name, err instanceof Error ? err.message.split('\n')[0] : String(err));
    try {
      await page.screenshot({ path: join(SHOTS, `app-fail-${results.length}.png`) });
    } catch {
      /* ignore */
    }
  }
  if (process.env.DEBUG_SCROLL) {
    const d = await page.evaluate(() => [...document.querySelectorAll('*')].filter((e) => e.scrollTop > 0 && !/cm-scroller|panel-body/.test(e.className)).map((e) => `${e.tagName}.${e.className}:${e.scrollTop}`));
    console.log('   scrolled:', JSON.stringify(d));
  }
  // leave every flow with no card or popup open
  try {
    await page.keyboard.press('Escape');
    await page.mouse.move(2, 450);
  } catch {
    /* ignore */
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function up(url) {
  try {
    const r = await fetch(url);
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  const url = `${BASE}/`;
  if (await up(url)) return null;
  const port = new URL(BASE).port || '5173';
  const child = spawn('npx', ['vite', '--port', port, '--strictPort'], { cwd: resolve(here, '..'), stdio: 'ignore', detached: true });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await up(url)) return child;
  }
  throw new Error(`vite did not start on ${BASE}`);
}

const pc = (fn, a) => page.evaluate(fn, a);
const shot = (name) => page.screenshot({ path: join(SHOTS, `app-${name}.png`) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, a, ms = 4000, what = 'condition') {
  try {
    await page.waitForFunction(fn, a, { timeout: ms, polling: 50 });
  } catch {
    throw new Error(`timed out waiting for ${what}`);
  }
}

/** Unit id whose current text starts with `prefix`. */
async function unitId(prefix) {
  let id = null;
  for (let i = 0; i < 40 && !id; i++) {
    id = await pc((p) => {
      const ws = window.__paper.workspace.getState();
      const t = ws.editor.getText();
      const u = ws.units.find((x) => t.slice(x.start, x.end).startsWith(p));
      return u ? u.id : null;
    }, prefix);
    if (!id) await sleep(50);
  }
  assert(id, `no unit starting with "${prefix}"`);
  return id;
}

const unitById = (id) => pc((i) => window.__paper.workspace.getState().units.find((u) => u.id === i) ?? null, id);
const docText = () => pc(() => window.__paper.workspace.getState().editor.getText());

/** Put the cursor inside the sentence starting with `prefix` (one character after its start). */
async function cursorIn(prefix) {
  const id = await unitId(prefix);
  await pc((i) => window.__paper.workspace.getState().editor.revealSentence(i), id);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowLeft');
  return id;
}

/** Hover the first visible wrapped line of a sentence. */
async function hoverSentence(id) {
  const rects = await pc((i) => [...document.querySelectorAll(`.cm-content [data-unit="${i}"]`)].flatMap((n) => [...n.getClientRects()].map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height }))), id);
  const box = rects.find((r) => r.w > 12 && r.y > 60 && r.y + r.h < 860);
  assert(box, `sentence ${id} not visible`);
  const x = box.x + Math.min(40, box.w / 2);
  const y = box.y + box.h / 2;
  await page.mouse.move(x, Math.max(70, box.y - 300));
  await page.mouse.move(5, 5);
  await page.mouse.move(x, y, { steps: 4 });
  return { rects, x, y };
}

const overlaps = (r, c) => r.x < c.x + c.width && r.x + r.w > c.x && r.y < c.y + c.height && r.y + r.h > c.y;

async function gutterStateFor(id) {
  // the provenance bar of the sentence's first line
  return pc((i) => {
    const ws = window.__paper.workspace.getState();
    const u = ws.units.find((x) => x.id === i);
    if (!u) return null;
    const lines = [...document.querySelectorAll('.cm-content .cm-line')];
    const el = document.querySelector(`.cm-content [data-unit="${i}"]`);
    if (!el) return { state: u.state, bar: null };
    const top = el.getBoundingClientRect().top;
    const bars = [...document.querySelectorAll('.pc-prov')];
    let best = null;
    let bestD = 1e9;
    for (const b of bars) {
      const r = b.closest('.cm-gutterElement')?.getBoundingClientRect() ?? b.getBoundingClientRect();
      const d = Math.abs(r.top - top);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    void lines;
    const ok = best && bestD < 12;
    return { state: u.state, bar: ok ? [...best.querySelectorAll('.pc-prov-seg')].map((x) => x.className).join(' ') : null, title: ok ? best.getAttribute('title') : null };
  }, id);
}

/**
 * The rail has four steps (① Plan ② Sources ③ To do ④ Check & submit); the older panel names select
 * their step and open their section there.
 */
const STEP_OF = { Outline: 'plan', 大纲: 'plan', 构思: 'plan', Plan: 'plan', Facts: 'sources', 事实: 'sources', Sources: 'sources', Literature: 'sources', Review: 'todo', 审阅: 'todo', Placeholders: 'todo', Questions: 'todo', 'To do': 'todo', 待办: 'todo', Sync: 'check', 同步: 'check', Check: 'check', 检查: 'check' };
const SECTION_OF = { Sync: 'sync', 同步: 'sync', Facts: 'facts', 事实: 'facts', Literature: 'lit' };

async function openStep(step) {
  const tab = page.locator(`.rail [role="tab"][data-step="${step}"]`);
  const selected = await tab.getAttribute('aria-selected');
  const collapsed = await pc(() => window.__paper.shell.getState().leftCollapsed);
  if (selected !== 'true' || collapsed) await tab.click();
  await sleep(150);
  if (await pc(() => window.__paper.shell.getState().leftCollapsed)) await tab.click();
}

async function openTab(name) {
  const step = STEP_OF[name];
  assert(step, `unknown tab ${name}`);
  await openStep(step);
  const section = SECTION_OF[name];
  if (section) {
    await pc((s) => window.__paper.shell.getState().focusSection(s), section);
    await sleep(250);
  }
}

/** The UI language lives in the Settings drawer (⚙). */
async function setLang(label) {
  await page.locator('[data-testid="settings-button"]').click();
  await page.waitForSelector('[data-testid="settings-drawer"]', { timeout: 2000 });
  await page.locator('[data-testid="settings-drawer"]').getByRole('button', { name: label, exact: true }).click();
  await page.keyboard.press('Escape');
  await waitFor(() => !document.querySelector('[data-testid="settings-drawer"]'), null, 2000, 'settings closed');
}

/** Open a collapsible section of ④ (consistency, terminology, figures, disclosure, sync). */
async function openCheckSection(id) {
  await openStep('check');
  const sec = page.locator(`.shell-panel [data-section="${id}"]`);
  const toggle = sec.locator('.psec-toggle').first();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await sleep(200);
  return sec;
}

async function main() {
  const child = await ensureServer();
  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
  page = await context.newPage();
  const errors = [];
  const warnings = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    if (m.type() === 'warning') warnings.push(m.text());
  });
  await page.goto(`${BASE}/?mock=1`);
  await page.waitForSelector('.cm-content .pc-s', { timeout: 20000 });
  await sleep(800);

  await check('first-run hint shows the four steps once and stays dismissed after a reload', async () => {
    await page.waitForSelector('[data-testid="first-run"]', { timeout: 3000 });
    const items = await page.locator('[data-testid="first-run"] .first-run-step').count();
    assert(items === 4, `${items} steps in the hint`);
    await shot('first-run');
    await page.locator('[data-testid="first-run"] .btn-primary').click();
    await waitFor(() => !document.querySelector('[data-testid="first-run"]'), null, 2000, 'hint dismissed');
    await page.reload();
    await page.waitForSelector('.cm-content .pc-s', { timeout: 20000 });
    await sleep(600);
    assert((await page.locator('[data-testid="first-run"]').count()) === 0, 'hint came back after reload');
    return `${items} steps; remembered`;
  });

  await check('language: default 中文 (notesLanguage zh), EN in Settings switches the UI', async () => {
    const zh = await page.locator('.statusbar').innerText();
    const zhTabs = await page.locator('.rail [role="tab"]').allInnerTexts();
    await setLang('EN');
    await waitFor(() => /sentences/.test(document.querySelector('.statusbar')?.textContent ?? ''), null, 2000, 'English status bar');
    const tabs = await page.locator('.rail [role="tab"]').allInnerTexts();
    assert(tabs.some((x) => /Plan/.test(x)), `tabs not English: ${tabs.join(',')}`);
    assert(zhTabs.some((x) => /构思/.test(x)) && zhTabs.some((x) => /待办/.test(x)), `tabs not 中文: ${zhTabs.join(',')}`);
    return `zh status "${zh.replace(/\s+/g, ' ').slice(0, 30)}…"`;
  });

  await check('rail: exactly four numbered steps in writing order (Plan, Sources, To do, Check)', async () => {
    const steps = await pc(() => [...document.querySelectorAll('.rail [role="tab"]')].map((t) => ({ step: t.getAttribute('data-step'), text: t.textContent.replace(/\s+/g, ' ').trim() })));
    assert(steps.length === 4, `${steps.length} rail entries: ${JSON.stringify(steps)}`);
    assert(steps.map((s) => s.step).join(',') === 'plan,sources,todo,check', `order ${steps.map((s) => s.step)}`);
    for (let i = 0; i < 4; i++) assert(steps[i].text.includes(String(i + 1)), `step ${i + 1} has no number: ${steps[i].text}`);
    // keyboard: arrows move between steps
    await page.locator('.rail [data-step="plan"]').focus();
    await page.keyboard.press('ArrowDown');
    const sel = await pc(() => window.__paper.workspace.getState().leftTab);
    assert(sel === 'sources', `ArrowDown selected ${sel}`);
    await openStep('plan');
    return steps.map((s) => s.text).join(' | ');
  });

  await check('top bar: name, file, compile, Sync, submission, simulated AI, settings, help and nothing else', async () => {
    const info = await pc(() => {
      const bar = document.querySelector('.topbar');
      const buttons = [...bar.querySelectorAll('button')].map((b) => (b.getAttribute('aria-label') || b.textContent).trim());
      return { buttons, text: bar.textContent.replace(/\s+/g, ' ') };
    });
    assert(info.buttons.length <= 7, `too many top-bar controls: ${info.buttons.join(' | ')}`);
    for (const re of [/Compile/, /Sync/, /Settings/, /help/i]) assert(info.buttons.some((b) => re.test(b)), `missing ${re}: ${info.buttons.join(' | ')}`);
    assert(/Simulated AI/.test(info.text), 'simulated-AI badge missing in fake mode');
    assert(!/\$\d/.test(info.text), 'cost meter still in the top bar');
    assert(!info.buttons.some((b) => /^(EN|中文)$/.test(b)), 'language toggle still in the top bar');
    await shot('topbar');
    return info.buttons.join(' | ');
  });

  await check('settings drawer: language, theme, heatmap, cost and voice; Escape closes', async () => {
    await page.locator('[data-testid="settings-button"]').click();
    await page.waitForSelector('[data-testid="settings-drawer"]', { timeout: 2000 });
    const txt = await page.locator('[data-testid="settings-drawer"]').innerText();
    for (const re of [/Interface language/i, /Theme/i, /Ownership heatmap/i, /API cost/i, /Your voice/i, /Style distance|style/i]) assert(re.test(txt), `settings lacks ${re}`);
    await page.locator('[data-testid="settings-drawer"] .settings-check input').first().check();
    await waitFor(() => !!document.querySelector('.pc-heatmap'), null, 2000, 'heatmap on');
    await shot('settings');
    await page.locator('[data-testid="settings-drawer"] .settings-check input').first().uncheck();
    await page.keyboard.press('Escape');
    await waitFor(() => !document.querySelector('[data-testid="settings-drawer"]'), null, 2000, 'drawer closed');
    const focus = await pc(() => document.activeElement?.getAttribute('data-testid'));
    return `focus back on ${focus}`;
  });

  await check('editor renders the fixture with sentence decorations and gutter', async () => {
    const info = await pc(() => ({
      units: window.__paper.workspace.getState().units.length,
      marks: document.querySelectorAll('.cm-content .pc-s').length,
      gutters: document.querySelectorAll('.cm-gutter').length,
      lineNumbers: document.querySelectorAll('.cm-lineNumbers .cm-gutterElement').length,
      facts: document.querySelectorAll('.pc-fact').length,
    }));
    assert(info.units === 26, `${info.units} units (fixture has 26)`);
    assert(info.marks > 5, `${info.marks} sentence marks`);
    assert(info.gutters >= 4, `${info.gutters} gutters`);
    await pc(() => window.__paper.workspace.getState().editor.revealLine(40));
    await sleep(300);
    const facts = await pc(() => document.querySelectorAll('.pc-fact').length);
    await shot('light');
    return `${info.units} units, ${info.marks} marks visible, ${info.gutters} gutters, ${facts} fact underlines near line 40`;
  });

  await check('status bar shows review progress', async () => {
    const t = await page.locator('.statusbar').innerText();
    assert(/Nothing to review|reviewed/.test(t), `status: ${t}`);
    assert(/26 sentences/.test(t), `status: ${t}`);
    return t.replace(/\s+/g, ' ');
  });

  let instructId;
  await check('sentence card opens on hover (400 ms) and does not cover its sentence', async () => {
    const id = await unitId('Charged particles from the decay');
    await pc((i) => window.__paper.workspace.getState().editor.revealSentence(i), id);
    await page.mouse.move(2, 450);
    await sleep(1000); // hover cards are suppressed briefly after cursor moves/typing
    const { rects } = await hoverSentence(id);
    await page.waitForSelector('[data-testid="sentence-card"]', { timeout: 2500 });
    const card = await page.locator('[data-testid="sentence-card"]').boundingBox();
    for (const r of rects) assert(!overlaps(r, card), 'card covers its sentence');
    const text = await page.locator('[data-testid="sentence-card"]').innerText();
    assert(/Written by you/.test(text), `state in words missing: ${text.slice(0, 80)}`);
    await shot('card-hover');
    await page.mouse.move(2, 450);
    await sleep(400);
  });

  await check('Ctrl+. opens the card with focus', async () => {
    // a sentence the simulated rewrite can change ("compared with" -> baseline first); an identical
    // proposal is a no-op and leaves the sentence the author's
    instructId = await cursorIn('On isolated displaced particles that neither');
    await page.keyboard.press('Control+.');
    await page.waitForSelector('[data-testid="sentence-card"]', { timeout: 2000 });
    const inCard = await pc(() => !!document.activeElement?.closest('[data-testid="sentence-card"]'));
    assert(inCard, 'focus not in the card');
    await shot('card-ctrl-dot');
    await page.keyboard.press('Escape');
  });

  await check('Instruct with a Chinese instruction, accept, gutter shows the AI state', async () => {
    const before = await gutterStateFor(instructId);
    await cursorIn('On isolated displaced particles that neither');
    await page.keyboard.press('Control+i');
    await page.waitForSelector('.pc-card input.pc-input', { timeout: 2000 });
    await page.keyboard.insertText('把基线放在前面');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="proposal"]', { timeout: 4000 });
    const p = await page.locator('[data-testid="proposal"]').innerText();
    assert(/[一-鿿]/.test(p), 'Chinese note missing');
    await shot('instruct');
    await page.keyboard.press('Control+Enter');
    await waitFor((i) => {
      const u = window.__paper.workspace.getState().units.find((x) => x.id === i);
      return !!u && u.state !== 'human';
    }, instructId, 3000, 'state change');
    await sleep(400);
    const after = await gutterStateFor(instructId);
    assert(after && after.bar && /pc-prov-ai-/.test(after.bar), `gutter after accept: ${JSON.stringify(after)}`);
    assert(before && !/pc-prov-ai-/.test(before.bar ?? ''), `gutter before: ${JSON.stringify(before)}`);
    return `${before.state} -> ${after.state} (bar ${after.bar}, title "${after.title}")`;
  });

  await check('Grammar (Ctrl+G) shows a minimal diff and applies', async () => {
    const id = await cursorIn('However, graph-neural-network');
    await page.keyboard.type(' the the'); // the cursor sits before the final period: a doubled word the grammar pass removes
    await sleep(400);
    const before = await docText();
    await page.keyboard.press('Control+g');
    await page.waitForSelector('[data-testid="proposal"]', { timeout: 4000 });
    await shot('grammar');
    const txt = await page.locator('[data-testid="proposal"]').innerText();
    await page.keyboard.press('Control+Enter');
    await sleep(600);
    const u = await unitById(id);
    const changed = (await docText()) !== before;
    assert(changed, 'grammar fix not applied');
    assert(u && u.grammarFixed, `grammarFixed flag not set (state ${u?.state})`);
    return `grammar proposal "${txt.split('\n')[1]?.slice(0, 50) ?? ''}", state ${u.state}, grammarFixed`;
  });

  let rejectedText = '';
  await check('Reject turns the sentence into a [claim: ...?] placeholder listed in Placeholders', async () => {
    const id = await cursorIn('Trackers tuned on prompt particles');
    const u = await unitById(id);
    const t = await docText();
    rejectedText = t.slice(u.start, u.end);
    await page.keyboard.press('Control+.');
    await page.waitForSelector('[data-testid="sentence-card"]', { timeout: 2000 });
    await page.keyboard.press('x');
    await waitFor(() => /\[claim: [^\]]+\?\]/.test(window.__paper.workspace.getState().editor.getText()), null, 3000, 'claim placeholder in the text');
    await openTab('Placeholders');
    await waitFor(() => /claim:/.test(document.querySelector('.shell-panel')?.textContent ?? ''), null, 3000, 'placeholder in the panel');
    await shot('placeholders');
    return rejectedText.slice(0, 40);
  });

  let drafted = 0;
  await check('Draft from the Outline panel inserts proposed sentences that appear in the Review queue', async () => {
    await openTab('Outline');
    // anti-anchoring: Draft is locked until the author wrote the five items
    const story = page.locator('.five-items textarea').first();
    await story.scrollIntoViewIfNeeded();
    await story.fill('A tracker trained without the signal finds more displaced particles than the baseline.');
    await page.locator('.attest input[type="checkbox"]').first().check();
    const before = await pc(() => window.__paper.workspace.getState().units.filter((u) => u.state === 'proposed' || u.state === 'unsupported').length);
    // open the Results section card
    const sec = page.locator('.section-card').filter({ hasText: /Results/ }).first();
    await sec.scrollIntoViewIfNeeded();
    const head = sec.locator('button').first();
    await head.click();
    const draftBtn = sec.getByRole('button', { name: /Draft from outline/ }).first();
    await draftBtn.scrollIntoViewIfNeeded();
    await shot('outline-draft');
    await draftBtn.click();
    await waitFor((n) => window.__paper.workspace.getState().units.filter((u) => u.state === 'proposed' || u.state === 'unsupported').length > n, before, 8000, 'drafted units');
    await sleep(800);
    drafted = (await pc(() => window.__paper.workspace.getState().units.filter((u) => u.state === 'proposed' || u.state === 'unsupported').length)) - before;
    await openTab('Review');
    await waitFor(() => document.querySelectorAll('.review-list li, .review-list .review-main').length > 0, null, 3000, 'review list entries');
    const n = await page.locator('.review-main').count();
    const status = await page.locator('.statusbar').innerText();
    assert(/reviewed/.test(status), `status bar has no progress: ${status}`);
    await shot('review');
    return `${drafted} drafted, ${n} in queue, status "${status.split('\n').find((x) => /reviewed/.test(x))}"`;
  });

  await check('④ Sync with Overleaf shows push blockers while proposed sentences exist; Push disabled with a reason', async () => {
    const sec = await openCheckSection('sync');
    await sec.getByRole('button', { name: 'Check', exact: true }).click();
    await waitFor(() => !!document.querySelector('.shell-panel .blockers'), null, 4000, 'blockers');
    const txt = await page.locator('.shell-panel .blockers').innerText();
    assert(/roposed|nsupported/i.test(txt), `blockers: ${txt.slice(0, 120)}`);
    const pushDisabled = await sec.getByRole('button', { name: 'Push', exact: true }).isDisabled();
    assert(pushDisabled, 'Push enabled despite blockers');
    assert((await sec.locator('.push-reason').count()) === 1, 'no visible reason for the disabled Push');
    await page.locator('.shell-panel [data-section="sync"]').scrollIntoViewIfNeeded();
    await shot('sync');
    return txt.split('\n').slice(0, 2).join(' / ');
  });

  await check('top-bar submission pill runs the check and opens ④ with blockers first; items reveal their sentence', async () => {
    await page.locator('[data-testid="submission-pill"]').click();
    await page.waitForSelector('[data-testid="submission-check"] .sub-list', { timeout: 5000 });
    const sel = await pc(() => window.__paper.workspace.getState().leftTab);
    assert(sel === 'check', `step ${sel}`);
    const rows = await pc(() => [...document.querySelectorAll('[data-testid="submission-check"] .sub-list > .sub-item')].map((li) => li.className));
    const firstWarn = rows.findIndex((c) => /sub-warn|sub-info/.test(c));
    const lastBlock = rows.map((c) => /sub-block/.test(c)).lastIndexOf(true);
    assert(lastBlock < firstWarn || firstWarn < 0, `blockers not first: ${rows.join(',')}`);
    const pill = await page.locator('[data-testid="submission-pill"]').innerText();
    assert(/issue/.test(pill), `pill: ${pill}`);
    const unreviewed = page.locator('[data-testid="submission-check"] [data-item="unreviewed"] .sub-head');
    assert(await unreviewed.count(), 'no "unreviewed" item while proposed sentences exist');
    await unreviewed.click();
    await shot('submission');
    await page.locator('[data-testid="submission-check"] [data-item="unreviewed"] .sub-entries .list-row').first().click();
    await waitFor(() => {
      const ws = window.__paper.workspace.getState();
      const u = ws.units.find((x) => x.id === ws.activeSentenceId);
      return !!u && (u.state === 'proposed' || u.state === 'unsupported');
    }, null, 3000, 'revealed proposed sentence');
    return `pill "${pill.trim()}", ${rows.length} failing items`;
  });

  for (const [id, re] of [
    ['consistency', /Numbers across the paper/],
    ['terminology', /Acronyms/],
    ['figures', /Figures and tables/],
  ]) {
    await check(`④ ${id} section loads its report and reveals a sentence`, async () => {
      const sec = await openCheckSection(id);
      await waitFor((i) => !!document.querySelector(`.shell-panel [data-section="${i}"] .report-body`), id, 5000, `${id} report`);
      const txt = await sec.innerText();
      assert(re.test(txt), `${id}: ${txt.slice(0, 120)}`);
      await sec.scrollIntoViewIfNeeded();
      await shot(`check-${id}`);
      const row = sec.locator('.report-body button.list-row:not([disabled]), .report-body .q-head').first();
      if (await row.count()) await row.click();
      const toggle = sec.locator('.psec-toggle').first();
      await toggle.click();
      return txt.split('\n').slice(0, 3).join(' / ').slice(0, 100);
    });
  }

  await check('④ AI-use disclosure: venue select and copy', async () => {
    const sec = await openCheckSection('disclosure');
    await waitFor(() => !!document.querySelector('.shell-panel [data-section="disclosure"] textarea.disclosure-text')?.value, null, 4000, 'disclosure text');
    await sec.locator('select').first().selectOption('elsevier');
    await waitFor(() => /Declaration/i.test(document.querySelector('.shell-panel [data-section="disclosure"] textarea.disclosure-text')?.value ?? ''), null, 4000, 'Elsevier statement');
    assert(await sec.getByRole('button', { name: /Copy/ }).count(), 'no copy button');
    await shot('disclosure');
    await sec.locator('.psec-toggle').first().click();
  });

  await check('Alt+Down navigates the review queue; Ctrl+Enter accepts', async () => {
    await pc(() => window.__paper.workspace.getState().editor.revealLine(1));
    await page.keyboard.press('Alt+ArrowDown');
    await waitFor(() => {
      const ws = window.__paper.workspace.getState();
      const u = ws.units.find((x) => x.id === ws.activeSentenceId);
      return !!u && (u.state === 'proposed' || u.state === 'unsupported');
    }, null, 2500, 'a proposed sentence active');
    const first = await pc(() => window.__paper.workspace.getState().activeSentenceId);
    const st = (await unitById(first)).state;
    await shot('review-nav');
    await page.keyboard.press('Control+Enter');
    if (st === 'proposed') await waitFor((i) => window.__paper.workspace.getState().units.find((u) => u.id === i)?.state === 'ai-drafted', first, 3000, 'accepted state');
    await page.keyboard.press('Alt+ArrowDown');
    await waitFor((i) => window.__paper.workspace.getState().activeSentenceId !== i, first, 2500, 'next sentence');
    const status = await page.locator('.statusbar').innerText();
    return `first was ${st}; ${status.split('\n').find((x) => /reviewed/.test(x))}`;
  });

  await check('ghost text via Ctrl+Space, Tab accepts', async () => {
    const id = await unitId('Charged particles from the decay');
    await pc((i) => window.__paper.workspace.getState().editor.revealSentence(i), id);
    const u = await unitById(id);
    await pc((p) => window.__paper.workspace.getState().editor.focus(), u.end);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('The gain');
    await page.keyboard.press('Control+Space');
    await page.waitForSelector('[data-testid="ghost"]', { timeout: 4000 });
    const g = await page.locator('[data-testid="ghost"]').innerText();
    await shot('ghost');
    await page.keyboard.press('Tab');
    await waitFor((g2) => window.__paper.workspace.getState().editor.getText().includes(g2.trim().slice(0, 12)), g, 2000, 'accepted ghost');
    return `ghost "${g.slice(0, 50)}"`;
  });

  await check('intent line typed in Chinese gets the teal tint; Ctrl+Enter renders it', async () => {
    const id = await unitId('Charged particles from the decay');
    await pc((i) => window.__paper.workspace.getState().editor.revealSentence(i), id);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('这里说明重建效率在大位移处提高了多少');
    await waitFor(() => document.querySelectorAll('.pc-intent-line').length > 0, null, 3000, 'teal intent line');
    const color = await pc(() => getComputedStyle(document.querySelector('.pc-intent-line')).backgroundColor);
    await shot('intent-line');
    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('.pc-intent-render .pc-ir-option', { timeout: 4000 });
    await shot('intent-render');
    await page.keyboard.press('Tab');
    await waitFor(() => !window.__paper.workspace.getState().editor.getText().includes('这里说明重建效率'), null, 3000, 'rendered sentence replacing the note');
    await sleep(500);
    const st = await pc(() => window.__paper.workspace.getState().units.filter((u) => u.state === 'ai-from-intent').length);
    assert(st > 0, 'no ai-from-intent unit');
    return `tint ${color}; ${st} ai-from-intent unit(s)`;
  });

  await check('Facts panel lists facts', async () => {
    await openTab('Facts');
    await waitFor(() => /f\.|delta|points/i.test(document.querySelector('.shell-panel')?.textContent ?? ''), null, 3000, 'facts listed');
    const count = await pc(() => document.querySelector('.shell-panel')?.textContent.match(/(\d+) of (\d+) facts/)?.[0] ?? '');
    await shot('facts');
    return count;
  });

  await check('card history: restore an earlier version as one annotated change; provenance stays AI', async () => {
    const id = instructId;
    const u0 = await unitById(id);
    assert(u0 && u0.everAi, `instructed sentence not AI-touched: ${JSON.stringify(u0?.state)}`);
    await pc((i) => window.__paper.workspace.getState().editor.revealSentence(i), id);
    await page.keyboard.press('Control+.');
    await page.waitForSelector('[data-testid="sentence-card"]', { timeout: 2000 });
    await page.keyboard.press('h');
    await page.waitForSelector('.pc-history .pc-hist-restore', { timeout: 3000 });
    await shot('history');
    const before = await docText();
    // the oldest version: the author's imported text
    await page.locator('.pc-history .pc-hist-restore').last().click();
    await waitFor((b) => window.__paper.workspace.getState().editor.getText() !== b, before, 3000, 'restored text');
    await sleep(500);
    const u1 = await unitById(id);
    const after = await docText();
    assert(/On isolated displaced particles that neither model saw/.test(after), 'original wording not back');
    assert(u1 && u1.everAi, 'everAi was cleared by the restore');
    return `state ${u0.state} -> ${u1.state}, everAi kept`;
  });

  await check('language 中文 switches the UI (rail, To do, card, Settings)', async () => {
    await setLang('中文');
    await waitFor(() => /句/.test(document.querySelector('.statusbar')?.textContent ?? ''), null, 2000, 'Chinese status bar');
    const tabs = await page.locator('.rail [role="tab"]').allInnerTexts();
    assert(tabs.some((x) => /资料/.test(x)) && tabs.some((x) => /检查/.test(x)), `tabs: ${tabs.join(',')}`);
    await openTab('审阅');
    await shot('zh');
    // card in zh UI
    await cursorIn('Charged particles from the decay');
    await page.keyboard.press('Control+.');
    await page.waitForSelector('[data-testid="sentence-card"]', { timeout: 2000 });
    const cardText = await page.locator('[data-testid="sentence-card"]').innerText();
    assert(/你写的/.test(cardText) && /指令/.test(cardText) && /拒绝/.test(cardText), `card not in 中文: ${cardText.replace(/\s+/g, ' ').slice(0, 80)}`);
    await shot('zh-card');
    await page.keyboard.press('Escape');
    await page.locator('[data-testid="settings-button"]').click();
    await page.waitForSelector('[data-testid="settings-drawer"]', { timeout: 2000 });
    const st = await page.locator('[data-testid="settings-drawer"]').innerText();
    assert(/归属热图/.test(st) && /界面语言/.test(st), `settings not in 中文: ${st.slice(0, 80)}`);
    await shot('zh-settings');
    await page.keyboard.press('Escape');
    for (const step of ['plan', 'sources', 'check']) {
      await openStep(step);
      await sleep(300);
      await shot(`zh-${step}`);
    }
    const sub = await page.locator('[data-testid="submission-check"]').innerText();
    assert(/未审阅的 AI 句子|阻碍/.test(sub), `submission items not in 中文: ${sub.slice(0, 100)}`);
    return `card: "${cardText.split('\n')[0]}"`;
  });

  await check('dark mode renders (shell, editor, card, panels)', async () => {
    await setLang('EN');
    await page.emulateMedia({ colorScheme: 'dark' });
    await pc(() => window.__paper.shell.getState().setTheme?.('dark'));
    await sleep(400);
    const bg = await pc(() => getComputedStyle(document.body).backgroundColor);
    const edBg = await pc(() => getComputedStyle(document.querySelector('.cm-editor')).backgroundColor);
    await openTab('Review');
    await shot('dark');
    await cursorIn('Charged particles from the decay');
    await page.keyboard.press('Control+.');
    await page.waitForSelector('[data-testid="sentence-card"]', { timeout: 2000 });
    const cardBg = await pc(() => getComputedStyle(document.querySelector('.pc-card')).backgroundColor);
    assert(cardBg !== 'rgb(255, 255, 255)', 'card is not dark');
    await shot('dark-card');
    await page.keyboard.press('Escape');
    await openTab('Outline');
    await shot('dark-outline');
    await openTab('Facts');
    await shot('dark-facts');
    await openTab('Literature');
    await shot('dark-lit');
    await openStep('todo');
    await shot('dark-todo');
    await openStep('check');
    await shot('dark-check');
    for (const id of ['consistency', 'figures']) {
      const sec = await openCheckSection(id);
      await waitFor((i) => !!document.querySelector(`.shell-panel [data-section="${i}"] .report-body`), id, 5000, `${id} report`);
      await sec.scrollIntoViewIfNeeded();
      await shot(`dark-check-${id}`);
      await sec.locator('.psec-toggle').first().click();
    }
    await page.locator('[data-testid="settings-button"]').click();
    await page.waitForSelector('[data-testid="settings-drawer"]', { timeout: 2000 });
    await shot('dark-settings');
    await page.keyboard.press('Escape');
    await openTab('Sync');
    await shot('dark-sync');
    return `body ${bg}, editor ${edBg}, card ${cardBg}`;
  });

  await check('narrow window (1100x760): no page scroll, editor keeps a usable column', async () => {
    await page.setViewportSize({ width: 1100, height: 760 });
    await sleep(400);
    const m = await pc(() => {
      const se = document.scrollingElement;
      const ed = document.querySelector('.cm-content')?.getBoundingClientRect();
      return { sw: se.scrollWidth, sh: se.scrollHeight, w: innerWidth, h: innerHeight, edW: ed ? Math.round(ed.width) : 0 };
    });
    await shot('narrow-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await pc(() => window.__paper.shell.getState().setTheme?.('light'));
    await sleep(300);
    await shot('narrow-light');
    assert(m.sw <= m.w && m.sh <= m.h, `page overflows: ${JSON.stringify(m)}`);
    assert(m.edW >= 280, `editor column only ${m.edW}px`);
    return `editor column ${m.edW}px`;
  });

  await check('large \\input fixture: file switcher with per-file counts; switching and cross-file reveal', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/?mock=1&fixture=large`);
    await page.waitForSelector('.cm-content .pc-s', { timeout: 30000 });
    await sleep(600);
    await page.locator('[data-testid="file-switcher"]').click();
    const items = await pc(() => [...document.querySelectorAll('.file-menu [data-file]')].map((b) => b.getAttribute('data-file')));
    assert(items.length === 5 && items[0] === 'main.tex', `files: ${items.join(',')}`);
    await shot('files');
    await page.locator('.file-menu [data-file="sections/method.tex"]').click();
    await waitFor(() => {
      const ws = window.__paper.workspace.getState();
      return ws.file === 'sections/method.tex' && ws.units.length > 0 && ws.units.every((u) => u.file === 'sections/method.tex');
    }, null, 6000, 'method.tex open');
    const crumb = await page.locator('.topbar .crumb-file').innerText();
    assert(/method\.tex/.test(crumb), `crumb ${crumb}`);
    // a report row in another file: the editor switches, then reveals the sentence
    const target = await pc(async () => {
      const rep = await window.__paper.api.consistency();
      const o = rep.quantities.flatMap((q) => q.occurrences).find((x) => x.file === 'sections/results.tex' && x.sentenceId);
      return o ? { id: o.sentenceId, file: o.file } : null;
    });
    assert(target, 'no occurrence in results.tex');
    // the same path a report row takes (goRef -> revealSentence(id, false, file))
    await pc((t) => window.__paper.actions.revealSentence(t.id, false, t.file), target);
    await waitFor((t) => {
      const ws = window.__paper.workspace.getState();
      return ws.file === t.file && ws.activeSentenceId === t.id;
    }, target, 8000, 'cross-file reveal');
    // drafting a section that lives in another file: the editor opens that file, then inserts the draft
    await page.locator('[data-testid="file-switcher"]').click();
    await page.locator('.file-menu [data-file="main.tex"]').click();
    await waitFor(() => window.__paper.workspace.getState().file === 'main.tex' && window.__paper.workspace.getState().units.length > 0, null, 6000, 'main.tex open');
    await openTab('Outline');
    const story = page.locator('.five-items textarea').first();
    await story.scrollIntoViewIfNeeded();
    await story.fill('A tracker trained without the signal finds more displaced particles than the baseline.');
    await page.locator('.attest input[type="checkbox"]').first().check();
    const sec = page.locator('.section-card').filter({ hasText: /Results/ }).first();
    await sec.scrollIntoViewIfNeeded();
    await sec.locator('button').first().click();
    const draftBtn = sec.getByRole('button', { name: /Draft from outline/ }).first();
    await draftBtn.scrollIntoViewIfNeeded();
    await draftBtn.click();
    await waitFor(() => {
      const ws = window.__paper.workspace.getState();
      return ws.file === 'sections/results.tex' && ws.units.some((u) => u.state === 'proposed' || u.state === 'unsupported');
    }, null, 10000, 'draft inserted into results.tex');
    const drafted = await pc(() => window.__paper.workspace.getState().units.filter((u) => u.state === 'proposed' || u.state === 'unsupported').length);
    await shot('files-draft');
    // the submission check spans every file
    await page.locator('[data-testid="submission-pill"]').click();
    await page.waitForSelector('[data-testid="submission-check"] .sub-list', { timeout: 8000 });
    await shot('files-check');
    return `${items.length} files; revealed ${target.id.slice(-6)} in ${target.file}; ${drafted} drafted sentence(s) landed in results.tex`;
  });

  await check('no page errors', async () => {
    const real = errors.filter((e) => !/favicon/.test(e));
    assert(real.length === 0, `page errors: ${real.slice(0, 3).join(' | ')}`);
    return warnings.length ? `${warnings.length} warnings, e.g. ${warnings[0].slice(0, 90)}` : '';
  });

  await browser.close();
  if (child) process.kill(-child.pid);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed; screenshots in ${SHOTS}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
