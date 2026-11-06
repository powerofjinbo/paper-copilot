#!/usr/bin/env node
/**
 * End-to-end check of the WHOLE web app (shell + editor + panels + PDF pane) in demo mode (`?mock=1`,
 * the in-browser MockApiClient on the canto-demo fixture; no server).
 *
 *   node apps/web/harness/e2e-app.mjs [--url http://127.0.0.1:5173] [--shots DIR] [--headed]
 *
 * Starts `vite --port 5173` in apps/web when nothing answers at --url, runs the flows below, writes
 * screenshots (app-*.png, deviceScaleFactor 1) to --shots (default: $TMPDIR/paper-copilot-shots) and
 * exits non-zero if a check failed. Uses the dev-only `window.__paper` handle ({api, workspace, shell}).
 *
 * Flows: fixture render (sentence marks, gutter); status-bar review progress; sentence card by hover and
 * by Ctrl+.; Instruct (Chinese) + accept -> gutter shows an AI state; Grammar; Reject -> [claim: ...?]
 * placeholder listed in the Placeholders panel; Draft from the Outline panel -> proposed sentences in the
 * Review queue; Alt+Down / Ctrl+Enter; ghost via Ctrl+Space then Tab; a Chinese intent line (teal) rendered
 * by Ctrl+Enter; Facts panel; Sync panel blockers; UI language toggle; light and dark screenshots.
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

async function openTab(name) {
  const tab = page.locator('.rail [role="tab"]').filter({ hasText: name }).first();
  const selected = await tab.getAttribute('aria-selected');
  const collapsed = await pc(() => window.__paper.shell.getState().leftCollapsed);
  if (selected !== 'true' || collapsed) await tab.click();
  await sleep(150);
  if (await pc(() => window.__paper.shell.getState().leftCollapsed)) await tab.click();
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

  await check('language toggle: default 中文 (notesLanguage zh), EN switches the UI', async () => {
    const zh = await page.locator('.statusbar').innerText();
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await waitFor(() => /sentences/.test(document.querySelector('.statusbar')?.textContent ?? ''), null, 2000, 'English status bar');
    const tabs = await page.locator('.rail [role="tab"]').allInnerTexts();
    assert(tabs.some((x) => /Outline/.test(x)), `tabs not English: ${tabs.join(',')}`);
    return `zh status "${zh.replace(/\s+/g, ' ').slice(0, 30)}…"`;
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
    instructId = await cursorIn('Trackers tuned on prompt particles');
    await page.keyboard.press('Control+.');
    await page.waitForSelector('[data-testid="sentence-card"]', { timeout: 2000 });
    const inCard = await pc(() => !!document.activeElement?.closest('[data-testid="sentence-card"]'));
    assert(inCard, 'focus not in the card');
    await shot('card-ctrl-dot');
    await page.keyboard.press('Escape');
  });

  await check('Instruct with a Chinese instruction, accept, gutter shows the AI state', async () => {
    const before = await gutterStateFor(instructId);
    await cursorIn('Trackers tuned on prompt particles');
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
    const before = await pc(() => window.__paper.workspace.getState().units.filter((u) => u.state === 'proposed' || u.state === 'unsupported').length);
    // open the Results section card
    const sec = page.locator('.section-card').filter({ hasText: /Results/ }).first();
    await sec.scrollIntoViewIfNeeded();
    const head = sec.locator('button').first();
    await head.click();
    const draftBtn = sec.getByRole('button', { name: /Draft from (outline|my notes)/ }).first();
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

  await check('Sync panel shows push blockers while proposed sentences exist', async () => {
    await openTab('Sync');
    const checkBtn = page.getByRole('button', { name: /Check/ }).first();
    if (await checkBtn.count()) await checkBtn.click();
    await waitFor(() => !!document.querySelector('.shell-panel .blockers'), null, 4000, 'blockers');
    const txt = await page.locator('.shell-panel .blockers').innerText();
    assert(/roposed|nsupported/i.test(txt), `blockers: ${txt.slice(0, 120)}`);
    await shot('sync');
    return txt.split('\n').slice(0, 2).join(' / ');
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

  await check('language toggle to 中文 switches the UI', async () => {
    await page.getByRole('button', { name: '中文', exact: true }).click();
    await waitFor(() => /句/.test(document.querySelector('.statusbar')?.textContent ?? ''), null, 2000, 'Chinese status bar');
    const tabs = await page.locator('.rail [role="tab"]').allInnerTexts();
    assert(tabs.some((x) => /事实/.test(x)), `tabs: ${tabs.join(',')}`);
    await openTab('审阅');
    await shot('zh');
    // card in zh UI
    await cursorIn('Charged particles from the decay');
    await page.keyboard.press('Control+.');
    await page.waitForSelector('[data-testid="sentence-card"]', { timeout: 2000 });
    const cardText = await page.locator('[data-testid="sentence-card"]').innerText();
    assert(/你写的/.test(cardText) && /指令/.test(cardText) && /拒绝/.test(cardText), `card not in 中文: ${cardText.replace(/\s+/g, ' ').slice(0, 80)}`);
    const bar = await page.locator('.pc-editor-bar').innerText();
    assert(/归属/.test(bar), `editor bar not in 中文: ${bar}`);
    await shot('zh-card');
    await page.keyboard.press('Escape');
    return `card: "${cardText.split('\n')[0]}"`;
  });

  await check('dark mode renders (shell, editor, card, panels)', async () => {
    await page.getByRole('button', { name: 'EN', exact: true }).click();
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
    await openTab('Sync');
    await shot('dark-sync');
    return `body ${bg}, editor ${edBg}, card ${cardBg}`;
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
