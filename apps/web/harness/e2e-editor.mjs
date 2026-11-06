#!/usr/bin/env node
/**
 * End-to-end check of the editor against the in-browser fake server (harness/editor.html).
 *
 *   node apps/web/harness/e2e-editor.mjs [--url http://127.0.0.1:5174] [--shots DIR] [--headed]
 *
 * Starts `vite --port 5174` in apps/web when nothing answers at --url, runs the flows below, writes
 * screenshots (editor-*.png, deviceScaleFactor 1) to --shots (default: $TMPDIR/paper-copilot-shots) and
 * exits non-zero if a check failed. Flows: sentence decorations and gutter; hover card (never covering its
 * sentence); Instruct with a Chinese instruction + accept; ghost text with Ctrl+Space + Tab; IME
 * composition over a visible ghost (no ghost, no request while composing); draft insert + review queue
 * (Alt+Down, Ctrl+Enter); intent line rendering; offline edits survive a reconnect; external edit;
 * dark mode and the ownership heatmap.
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
const BASE = arg('--url', 'http://127.0.0.1:5174');
const SHOTS = resolve(arg('--shots', process.env.SHOTS_DIR ?? join(tmpdir(), 'paper-copilot-shots')));
const HEADED = args.includes('--headed');
mkdirSync(SHOTS, { recursive: true });

const results = [];
let page;
let cdp;

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
      await page.screenshot({ path: join(SHOTS, `editor-fail-${results.length}.png`) });
    } catch {
      /* ignore */
    }
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
  const url = `${BASE}/harness/editor.html`;
  if (await up(url)) return null;
  const port = new URL(BASE).port || '5174';
  const child = spawn('npx', ['vite', '--port', port, '--strictPort'], { cwd: resolve(here, '..'), stdio: 'ignore', detached: true });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await up(url)) return child;
  }
  throw new Error(`vite did not start on ${BASE}`);
}

const pc = (fn, arg) => page.evaluate(fn, arg);
const shot = (name) => page.screenshot({ path: join(SHOTS, `editor-${name}.png`) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, arg, ms = 4000, what = 'condition') {
  try {
    await page.waitForFunction(fn, arg, { timeout: ms, polling: 50 });
  } catch {
    throw new Error(`timed out waiting for ${what}`);
  }
}

/** Unit id whose current text starts with `prefix` (the store is published with a short throttle: poll). */
async function unitId(prefix) {
  let id = null;
  for (let i = 0; i < 40 && !id; i++) {
    id = await pc((p) => {
      const t = window.__pc.editor.getText();
      const u = window.__pc.store.getState().units.find((x) => t.slice(x.start, x.end).startsWith(p));
      return u ? u.id : null;
    }, prefix);
    if (!id) await sleep(50);
  }
  assert(id, `no unit starting with "${prefix}"`);
  return id;
}

async function cursorAfter(prefix) {
  const id = await unitId(prefix);
  await pc((i) => window.__pc.editor.revealSentence(i), id);
  await page.keyboard.press('ArrowRight');
  return id;
}

const changesWith = (origin) => pc((o) => window.__pc.api.server.received.filter((m) => m.type === 'doc.change' && m.annotation && m.annotation.origin === o).length, origin);

/** Wait until the fake server has received a NEW doc.change (beyond `seen`) whose annotation has `origin`; return the newest. */
async function receivedChange(origin, seen = 0, what = `a doc.change with origin ${origin}`) {
  await waitFor(([o, n]) => window.__pc.api.server.received.filter((m) => m.type === 'doc.change' && m.annotation && m.annotation.origin === o).length > n, [origin, seen], 3000, what);
  return pc((o) => window.__pc.api.server.received.filter((m) => m.type === 'doc.change' && m.annotation && m.annotation.origin === o).pop(), origin);
}

async function hoverVisible(selector, hasText) {
  const all = page.locator(selector, hasText ? { hasText } : undefined);
  const n = await all.count();
  for (let i = 0; i < n; i++) {
    const el = all.nth(i);
    // a wrapped span has one client rect per visual line: aim at the first one, not the bounding box
    const rects = await el.evaluate((node) => [...node.getClientRects()].map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })));
    const box = rects.find((r) => r.width > 12 && r.y > 60 && r.y + r.height < 860);
    if (box) {
      const x = box.x + Math.min(40, box.width / 2);
      const y = box.y + box.height / 2;
      // leave the text first (a fresh hover), then rest on the sentence
      await page.mouse.move(x, Math.max(70, box.y - 400));
      await page.mouse.move(5, 5);
      await page.mouse.move(x, y, { steps: 4 });
      lastHover = { x, y };
      return el;
    }
  }
  throw new Error(`no visible ${selector}`);
}

let lastHover = { x: 0, y: 0 };
async function hoverDiagnostics() {
  return pc(({ x, y }) => {
    const e = document.elementFromPoint(x, y);
    return {
      cards: document.querySelectorAll('.pc-card').length,
      at: e ? `${e.tagName}.${e.className}` : null,
      unit: e && e.closest('[data-unit]') ? e.closest('[data-unit]').getAttribute('data-state') : null,
      active: document.activeElement ? document.activeElement.className : null,
    };
  }, lastHover);
}

const sentChanges = () => pc(() => window.__pc.api.sent.filter((m) => m.type === 'doc.change').length);
const ghostRequests = () => pc(() => window.__pc.api.sent.filter((m) => m.type === 'ghost.request').length);

async function main() {
  const child = await ensureServer();
  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  cdp = await context.newCDPSession(page);
  await page.goto(`${BASE}/harness/editor.html?theme=light`);
  await page.waitForSelector('.pc-s', { timeout: 15000 });
  await sleep(500);

  await check('sentence decorations and gutter', async () => {
    const info = await pc(() => {
      const states = new Set([...document.querySelectorAll('.pc-s')].map((e) => e.getAttribute('data-state')));
      return {
        marks: document.querySelectorAll('.pc-s').length,
        states: [...states].sort(),
        units: window.__pc.store.getState().units.length,
      };
    });
    assert(info.units >= 26, `only ${info.units} units in the store`);
    for (const s of ['ai-drafted', 'ai-edited', 'ai-from-intent', 'external', 'human', 'placeholder', 'proposed', 'unsupported'])
      assert(info.states.includes(s), `no sentence in state ${s}`);
    await pc(() => window.__pc.editor.revealLine(52));
    await sleep(300);
    const g = await pc(() => ({
      proposed: document.querySelectorAll('.pc-prov-proposed').length,
      unsupported: document.querySelectorAll('.pc-prov-unsupported').length,
      lint: document.querySelectorAll('.pc-lint-dot').length,
      intent: document.querySelectorAll('.pc-intent-line').length,
      facts: document.querySelectorAll('.pc-fact').length,
      placeholders: document.querySelectorAll('.pc-ph').length,
      titles: [...document.querySelectorAll('.pc-prov')].map((e) => e.getAttribute('title')).join(' | '),
    }));
    assert(g.proposed > 0 && g.unsupported > 0, 'provenance bars missing');
    assert(g.lint > 0, 'lint dots missing');
    assert(g.intent === 1, 'intent line not tinted');
    assert(g.facts >= 3, `only ${g.facts} fact underlines`);
    assert(g.placeholders >= 1, 'placeholder chip missing');
    assert(/Proposed, not yet reviewed/.test(g.titles), 'provenance tooltip has no words');
    await shot('light');
    return `${info.marks} marks, ${g.facts} fact links`;
  });

  await check('hover opens the sentence card without covering the sentence', async () => {
    const el = await hoverVisible('.pc-s[data-state="ai-drafted"]', 'On the isolated gun');
    await page.waitForSelector('[data-testid="sentence-card"]', { timeout: 2000 });
    const card = await page.locator('[data-testid="sentence-card"]').boundingBox();
    const rects = await el.evaluate((node) => {
      const id = node.getAttribute('data-unit');
      return [...document.querySelectorAll(`[data-unit="${id}"]`)].flatMap((n) => [...n.getClientRects()].map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })));
    });
    for (const r of rects) {
      const overlap = r.x < card.x + card.width && r.x + r.w > card.x && r.y < card.y + card.height && r.y + r.h > card.y;
      assert(!overlap, 'card covers its sentence');
    }
    const text = await page.locator('[data-testid="sentence-card"]').innerText();
    assert(/AI drafted, accepted/.test(text), 'state in words missing');
    assert(/f\.g1\.delta_points/.test(text), 'fact chip missing');
    await shot('card');
    await page.mouse.move(5, 300);
    await sleep(500);
  });

  await check('Instruct with a Chinese instruction, then accept', async () => {
    await cursorAfter('On the isolated gun particles');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Control+i');
    await page.waitForSelector('.pc-card input.pc-input', { timeout: 2000 });
    await page.keyboard.insertText('把基线放在前面');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="proposal"]', { timeout: 3000 });
    const p = await page.locator('[data-testid="proposal"]').innerText();
    assert((await page.locator('.pc-diff-ins').count()) > 0 && (await page.locator('.pc-diff-del').count()) > 0, 'diff not shown');
    assert(/[一-鿿]/.test(p), 'Chinese notes missing');
    assert(/actor/.test(p) && /condition/.test(p), 'drift checklist missing');
    await shot('instruct');
    await page.keyboard.press('Control+Enter');
    await waitFor(() => window.__pc.editor.getText().includes('With the same track builder, the tracker finds'), null, 3000, 'rewrite in the document');
    const c = await receivedChange('ai_rewrite');
    assert(c.annotation.state === 'ai-drafted' && c.annotation.instruction === '把基线放在前面' && c.annotation.sentenceIds.length === 1, `bad annotation ${JSON.stringify(c.annotation)}`);
    return 'origin ai_rewrite, state ai-drafted';
  });

  await check('card keys: grammar (Ctrl+G), history (h), alternatives (l, 1)', async () => {
    const id = await cursorAfter('The fake-track rate is');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Control+g');
    await page.waitForSelector('[data-testid="proposal"] .pc-diff-ins', { timeout: 3000 });
    await page.keyboard.press('Control+Enter');
    const g = await receivedChange('grammar_fix');
    assert(g.annotation.state === 'proposed' && g.annotation.sentenceIds[0] === id, `grammar annotation ${JSON.stringify(g.annotation)}`);
    await waitFor(() => window.__pc.editor.getText().includes('0.55\\% versus 1.38\\%'), null, 2000, 'grammar fix in the text');
    await pc((i) => window.__pc.editor.revealSentence(i), id);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Control+.');
    await page.waitForSelector('[data-testid="sentence-card"]', { timeout: 2000 });
    await page.keyboard.press('h');
    await page.waitForSelector('.pc-hist-row', { timeout: 2000 });
    await page.keyboard.press('Escape');
    await page.keyboard.press('l');
    await page.waitForSelector('.pc-alt', { timeout: 3000 });
    await shot('alternatives');
    const before = await changesWith('ai_rewrite');
    await page.keyboard.press('1');
    const a = await receivedChange('ai_rewrite', before);
    assert(a.annotation.sentenceIds[0] === id && a.annotation.state === 'ai-drafted', 'alternative not annotated');
  });

  await check('card keys: reject (x) leaves a claim placeholder; rewrite myself (r) keeps the id', async () => {
    const rid = await cursorAfter('This lead holds for every particle species.');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Control+.');
    await page.waitForSelector('[data-testid="sentence-card"]', { timeout: 2000 });
    await page.keyboard.press('x');
    await waitFor(() => window.__pc.editor.getText().includes('[claim: This lead holds for every particle species?]'), null, 3000, 'claim placeholder');
    const r = await receivedChange('human_edit');
    assert(r.annotation.state === 'placeholder' && r.annotation.sentenceIds[0] === rid, `reject annotation ${JSON.stringify(r.annotation)}`);

    const id = await cursorAfter('However, these studies trained on the signal');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Control+.');
    await page.waitForSelector('[data-testid="sentence-card"]', { timeout: 2000 });
    await page.keyboard.press('r');
    await page.waitForSelector('.pc-rewrite-hint', { timeout: 2000 });
    // the selection stops before the final period; the old words stay struck until the final period is typed
    await page.keyboard.type('Earlier studies trained on the signal they test');
    await page.waitForSelector('.pc-rewrite-old', { timeout: 1000 });
    await shot('rewrite');
    await page.keyboard.type('.');
    const h = await receivedChange('human_typed');
    assert(h.annotation.state === 'human' && h.annotation.sentenceIds[0] === id, `rewrite annotation ${JSON.stringify(h.annotation)}`);
    await waitFor((i) => {
      const t = window.__pc.editor.getText();
      const u = window.__pc.store.getState().units.find((x) => x.id === i);
      return !!u && t.slice(u.start, u.end) === 'Earlier studies trained on the signal they test.';
    }, id, 3000, 'the rewritten sentence keeping its id');
    await page.keyboard.press('Escape');
  });

  await check('ghost text: Ctrl+Space shows a grounded suggestion, Tab accepts it', async () => {
    await cursorAfter('At large radius the gain is');
    await page.keyboard.press('Enter');
    await page.keyboard.type('The gain');
    await page.keyboard.press('Control+Space');
    await page.waitForSelector('[data-testid="ghost"]', { timeout: 3000 });
    const g = await page.locator('[data-testid="ghost"]').innerText();
    assert(g.includes('2.32'), `ghost "${g}" has no fixture number`);
    assert((await page.locator('.pc-ghost-fact').count()) > 0, 'fact numbers in the ghost are not underlined');
    await shot('ghost');
    await page.keyboard.press('Tab');
    await waitFor(() => window.__pc.editor.getText().includes('The gain is 2.32 points, measured on 8,710 targets.'), null, 2000, 'accepted ghost text');
    await waitFor(() => window.__pc.api.server.received.some((m) => m.type === 'ghost.feedback' && m.outcome === 'accepted'), null, 2000, 'ghost.feedback accepted');
    const c = await pc(() => window.__pc.api.server.received.filter((m) => m.type === 'doc.change' && m.annotation && m.annotation.origin === 'ai_ghost').pop());
    assert(c && c.annotation.state === 'ai-drafted' && c.annotation.requestId, 'ghost insert not annotated');
    assert((await page.locator('[data-testid="ghost"]').count()) === 0, 'ghost still visible after accept');
    return 'origin ai_ghost with requestId';
  });

  await check('IME composition: no ghost and no request while composing', async () => {
    await page.keyboard.press('Enter');
    await page.keyboard.type('We use');
    await page.keyboard.press('Control+Space');
    await page.waitForSelector('[data-testid="ghost"]', { timeout: 3000 });
    const before = await ghostRequests();
    await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
    await sleep(150);
    assert((await page.locator('[data-testid="ghost"]').count()) === 0, 'ghost visible during composition');
    await cdp.send('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 });
    await sleep(900);
    assert((await page.locator('[data-testid="ghost"]').count()) === 0, 'ghost visible during composition (after a pause)');
    assert((await ghostRequests()) === before, 'a ghost request was sent while composing');
    await cdp.send('Input.insertText', { text: '中文' });
    await sleep(900);
    const text = await pc(() => window.__pc.editor.getText());
    assert(text.includes('We use中文'), 'composed text not committed');
    assert((await page.locator('[data-testid="ghost"]').count()) === 0, 'a non-matching composition brought the ghost back');
    await shot('ime');
    // clean up the line
    for (let i = 0; i < 2; i++) await page.keyboard.press('Control+z');
  });

  await check('draft insert, then review with Alt+Down and Ctrl+Enter', async () => {
    const proposedBefore = await pc(() => window.__pc.store.getState().units.filter((u) => u.state === 'proposed' || u.state === 'unsupported').length);
    const changesBefore = await sentChanges();
    await page.click('[data-testid="btn-draft"]');
    await waitFor((n) => window.__pc.store.getState().units.filter((u) => u.state === 'proposed' || u.state === 'unsupported').length >= n + 3, proposedBefore, 4000, 'three drafted units');
    const drafted = (await sentChanges()) - changesBefore;
    assert(drafted === 3, `expected one transaction per sentence (3), got ${drafted}`);
    await pc(() => window.__pc.editor.revealLine(1));
    await page.keyboard.press('Alt+ArrowDown');
    await page.waitForSelector('[data-testid="sentence-card"][data-state="proposed"]', { timeout: 2000 });
    const first = await pc(() => window.__pc.store.getState().activeSentenceId);
    await shot('review');
    await page.keyboard.press('Control+Enter');
    await waitFor((id) => window.__pc.store.getState().units.find((u) => u.id === id)?.state === 'ai-drafted', first, 2000, 'accepted state');
    await page.keyboard.press('Alt+ArrowDown');
    await waitFor((id) => window.__pc.store.getState().activeSentenceId !== id, first, 2000, 'next sentence in the queue');
    const remaining = await pc(() => window.__pc.store.getState().units.filter((u) => u.state === 'proposed' || u.state === 'unsupported').length);
    return `${remaining} left to review`;
  });

  await check('re-plan proposal shows ↻ and a revision in the card', async () => {
    await page.click('[data-testid="btn-replan"]');
    await page.waitForSelector('.pc-plan-replan', { timeout: 2000 });
    const id = await unitId('The gain is largest at large transverse displacement');
    await pc((i) => window.__pc.editor.revealSentence(i, { openCard: true }), id);
    await page.waitForSelector('.pc-replan', { timeout: 2000 });
    await shot('replan');
    await page.locator('.pc-replan button', { hasText: 'Use revision' }).click();
    await waitFor(() => window.__pc.editor.getText().includes('loses the most targets'), null, 2000, 'revision applied');
    const c = await receivedChange('replan');
    assert(c.annotation && c.annotation.origin === 'replan' && c.annotation.state === 'proposed', 'revision not annotated as replan/proposed');
  });

  await check('intent line: Ctrl+Enter renders English, Tab accepts in one annotated transaction', async () => {
    const line = await pc(() => window.__pc.editor.getText().split('\n').findIndex((l) => l.startsWith('这里补一句')) + 1);
    assert(line > 0, 'intent line not found');
    await pc((n) => window.__pc.editor.revealLine(n), line);
    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('.pc-intent-render .pc-ir-option', { timeout: 3000 });
    await shot('intent');
    await page.keyboard.press('Tab');
    await waitFor(() => window.__pc.editor.getText().includes('Double majority is stricter than a single majority'), null, 2000, 'rendered sentence');
    const c = await receivedChange('ai_intent');
    assert(c.annotation.state === 'ai-from-intent' && /双重多数/.test(c.annotation.intentNote ?? ''), `intent annotation wrong: ${JSON.stringify(c.annotation)}`);
    assert((await page.locator('.pc-intent-line').count()) === 0, 'intent tint still shown');
  });

  await check('offline edits survive a reconnect', async () => {
    await cursorAfter('Searches for long-lived particles look for tracks');
    await page.click('[data-testid="btn-connection"]');
    try {
      await page.waitForSelector('.pc-offline', { timeout: 1000 });
      await pc(() => window.__pc.editor.focus());
      await page.keyboard.type(' Written offline.');
    } finally {
      await page.click('[data-testid="btn-connection"]');
    }
    await waitFor(() => window.__pc.api.server.text.includes('Written offline.'), null, 4000, 'server text with the offline edit');
    const same = await pc(() => window.__pc.api.server.text === window.__pc.editor.getText());
    assert(same, 'server and editor texts differ after the reconnect');
  });

  await check('external edit (doc.replace) is applied and marked external', async () => {
    await page.click('[data-testid="btn-external"]');
    await waitFor(() => window.__pc.editor.getText().includes('The main limitation is'), null, 3000, 'external text');
    const st = await pc(() => {
      const t = window.__pc.editor.getText();
      return window.__pc.store.getState().units.find((u) => t.slice(u.start, u.end).startsWith('The main limitation'))?.state;
    });
    assert(st === 'external', `state ${st}`);
  });

  await check('dark mode and ownership heatmap render', async () => {
    await page.selectOption('[data-testid="theme"]', 'dark');
    await pc(() => window.__pc.editor.revealLine(50));
    await sleep(300);
    await pc(() => window.__pc.editor.focus());
    await page.keyboard.press('Escape');
    await hoverVisible('.pc-s[data-state="proposed"]');
    try {
      await page.waitForSelector('[data-testid="sentence-card"]', { timeout: 2000 });
    } catch {
      throw new Error(`no hover card: ${JSON.stringify(await hoverDiagnostics())}`);
    }
    const bg = await pc(() => getComputedStyle(document.querySelector('.pc-card')).backgroundColor);
    assert(bg !== 'rgb(255, 255, 255)', 'card is not dark');
    await shot('dark');
    await page.mouse.move(5, 300);
    await sleep(400);
    await page.click('.pc-toggle');
    await sleep(200);
    assert((await page.locator('.pc-heatmap').count()) === 1, 'heatmap class missing');
    await shot('heatmap-dark');
    await page.click('.pc-toggle');
    await page.selectOption('[data-testid="theme"]', 'light');
  });

  await check('no page errors, no core fallbacks', async () => {
    const fallbacks = await pc(() => window.__pc.fallbacks);
    assert(errors.length === 0, `page errors: ${errors.slice(0, 3).join(' | ')}`);
    assert(fallbacks.length === 0, `core fallbacks used: ${fallbacks.join(', ')}`);
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
