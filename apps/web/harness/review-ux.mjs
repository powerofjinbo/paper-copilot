#!/usr/bin/env node
/**
 * UX review checks of the whole web app in demo mode (`?mock=1`), from the point of view of a
 * non-native (Chinese/English) author using it every day. Each check is a regression test: a FAIL is
 * a UX defect found in review (see the reviewer report); a PASS documents behaviour that must stay.
 *
 *   node apps/web/harness/review-ux.mjs [--url http://127.0.0.1:5173] [--shots DIR] [--only TEXT]
 *
 * Starts `vite --port 5173` in apps/web when nothing answers at --url (and stops it at the end),
 * writes screenshots (ux-*.png, deviceScaleFactor 1) to --shots and exits non-zero if a check failed.
 * Uses the dev-only `window.__paper` handle ({api, workspace, shell}).
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
const ONLY = arg('--only', null);
mkdirSync(SHOTS, { recursive: true });

const results = [];
let browser;
let page;

function log(ok, name, detail = '') {
  results.push({ ok, name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pc = (fn, a) => page.evaluate(fn, a);
const shot = (name) => page.screenshot({ path: join(SHOTS, `ux-${name}.png`) });

async function up(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}
async function ensureServer() {
  if (await up(`${BASE}/`)) return null;
  const port = new URL(BASE).port || '5173';
  const child = spawn('npx', ['vite', '--port', port, '--strictPort'], { cwd: resolve(here, '..'), stdio: 'ignore', detached: true });
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await up(`${BASE}/`)) return child;
  }
  throw new Error(`vite did not start on ${BASE}`);
}

/** A fresh page on the demo (default UI language: 中文, as the fixture's notesLanguage is zh). */
async function freshPage({ width = 1440, height = 900, colorScheme = 'light', mock = true, mac = false } = {}) {
  if (page) await page.context().close();
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme });
  // macOS as CodeMirror and the app detect it (navigator.platform), before any module loads
  if (mac) await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));
  // the guided tour's first-launch offer is answered ("Not now"): these checks look at the app itself
  await ctx.addInitScript(() => localStorage.getItem('paper-copilot.tour.v1') ?? localStorage.setItem('paper-copilot.tour.v1', JSON.stringify({ status: 'declined', index: 0, done: [] })));
  page = await ctx.newPage();
  await page.goto(`${BASE}/${mock ? '?mock=1' : ''}`);
  if (mock) {
    await page.waitForSelector('.cm-content .pc-s', { timeout: 20000 });
    await sleep(700);
  }
}

async function check(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  try {
    const detail = await fn();
    log(true, name, typeof detail === 'string' ? detail : '');
  } catch (err) {
    log(false, name, err instanceof Error ? err.message.split('\n')[0] : String(err));
    try {
      await page.screenshot({ path: join(SHOTS, `ux-fail-${results.length}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function waitFor(fn, a, ms = 4000, what = 'condition') {
  try {
    await page.waitForFunction(fn, a, { timeout: ms, polling: 50 });
  } catch {
    throw new Error(`timed out waiting for ${what}`);
  }
}

async function unitId(prefix) {
  let id = null;
  for (let i = 0; i < 40 && !id; i++) {
    id = await pc((p) => {
      const ws = window.__paper.workspace.getState();
      const t = ws.editor.getText();
      return ws.units.find((x) => t.slice(x.start, x.end).startsWith(p))?.id ?? null;
    }, prefix);
    if (!id) await sleep(50);
  }
  assert(id, `no unit starting with "${prefix}"`);
  return id;
}
const unitById = (id) => pc((i) => window.__paper.workspace.getState().units.find((u) => u.id === i) ?? null, id);
const docText = () => pc(() => window.__paper.workspace.getState().editor.getText());
async function cursorIn(prefix) {
  const id = await unitId(prefix);
  await pc((i) => window.__paper.workspace.getState().editor.revealSentence(i), id);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowLeft');
  return id;
}
/** Cursor on a fresh line after the sentence starting with `prefix`, with `typed` typed there. */
async function newLineAfter(prefix, typed) {
  const id = await unitId(prefix);
  await pc((i) => window.__paper.workspace.getState().editor.revealSentence(i), id);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  if (typed) await page.keyboard.type(typed);
}
const overlaps = (r, c) => r.x < c.x + c.width && r.x + r.w > c.x && r.y < c.y + c.height && r.y + r.h > c.y;

/** Characters of the editor font that fit on one prose line (content box minus padding). */
const charsPerLine = () =>
  pc(() => {
    const content = document.querySelector('.cm-content');
    const line = content.querySelector('.pc-s')?.closest('.cm-line') ?? content.querySelector('.cm-line');
    const cs = getComputedStyle(line);
    const probe = document.createElement('span');
    probe.textContent = 'the reconstruction efficiency at large displacement '.repeat(2);
    probe.style.font = cs.font;
    probe.style.position = 'absolute';
    probe.style.whiteSpace = 'pre';
    document.body.appendChild(probe);
    const perChar = probe.getBoundingClientRect().width / probe.textContent.length;
    probe.remove();
    const ccs = getComputedStyle(content);
    const inner = content.getBoundingClientRect().width - parseFloat(ccs.paddingLeft) - parseFloat(ccs.paddingRight) - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return {
      chars: Math.floor(inner / perChar),
      contentPx: Math.round(content.getBoundingClientRect().width),
      editorPx: Math.round(document.querySelector('.shell-editor').getBoundingClientRect().width),
      panelPx: Math.round(document.querySelector('.shell-panel')?.getBoundingClientRect().width ?? 0),
      pdfPx: Math.round(document.querySelector('.shell-pdf')?.getBoundingClientRect().width ?? 0),
    };
  });

async function main() {
  const child = await ensureServer();
  browser = await chromium.launch();
  try {
    /* ------------------------------------------------------------------ layout */
    for (const [w, h] of [
      [1280, 800],
      [1366, 768],
      [1440, 900],
    ]) {
      await check(`UX-narrow: default layout at ${w}x${h} (outline + PDF open) leaves a readable prose column (>= 55 chars per line)`, async () => {
        await freshPage({ width: w, height: h });
        const m = await charsPerLine();
        await shot(`narrow-${w}`);
        assert(m.chars >= 55, `only ${m.chars} chars per line: editor ${m.editorPx}px, text column ${m.contentPx}px, outline ${m.panelPx}px, PDF ${m.pdfPx}px (PDF pane is an empty placeholder before the first compile)`);
        return `${m.chars} chars per line, editor ${m.editorPx}px`;
      });
    }

    await check('UX-font: prose sentences use a proportional text font (monospace only for commands)', async () => {
      await freshPage();
      const ff = await pc(() => {
        const s = document.querySelector('.cm-content .pc-s');
        const probe = (font) => {
          const c = document.createElement('canvas').getContext('2d');
          c.font = `16px ${font}`;
          return [c.measureText('iiiiiiiiii').width, c.measureText('MMMMMMMMMM').width];
        };
        const fam = getComputedStyle(s).fontFamily;
        const [i, m] = probe(fam);
        return { fam, mono: Math.abs(i - m) < 0.5 };
      });
      assert(!ff.mono, `prose is set in a monospace font (${ff.fam.slice(0, 60)}…)`);
      return ff.fam.slice(0, 50);
    });

    /* ------------------------------------------------------------------ discoverability */
    await check('UX-help: "?" (outside the text) opens a keyboard-shortcut overlay that names the ghost key', async () => {
      await freshPage();
      await page.locator('.statusbar').click();
      await page.keyboard.press('Shift+Slash');
      await sleep(300);
      const dialog = await pc(() => {
        const d = [...document.querySelectorAll('[role="dialog"], dialog[open]')].map((x) => x.textContent ?? '');
        return d.join(' | ');
      });
      await shot('help');
      assert(/Space|Alt\+\//.test(dialog), `no shortcut overlay (dialogs: "${dialog.slice(0, 80)}"); the ghost key Ctrl+Space / Alt+/ appears nowhere in the UI`);
    });

    await check('UX-i18n: editor feedback notes follow the 中文 UI (e.g. Ctrl+Enter on an accepted sentence)', async () => {
      await freshPage();
      const lang = await pc(() => window.__paper.shell.getState().lang);
      await cursorIn('Charged particles from the decay');
      await page.keyboard.press('Control+Enter');
      await page.waitForSelector('.pc-ghost-note', { timeout: 2000 });
      const note = await page.locator('.pc-ghost-note').first().innerText();
      await shot('note-zh');
      assert(lang === 'zh', `UI language is ${lang}`);
      assert(/[一-鿿]/.test(note), `UI is 中文 but the editor note is English only: "${note}"`);
      return note;
    });

    /* ------------------------------------------------------------------ keyboard conflicts */
    await check('UX-keys: Ctrl+Enter on an already-accepted / human sentence does not change the paper', async () => {
      await freshPage();
      const id = await cursorIn('Charged particles from the decay');
      const before = await docText();
      const st = (await unitById(id)).state;
      await page.keyboard.press('Control+Enter');
      await sleep(400);
      const after = await docText();
      let diff = '';
      if (after !== before) {
        let i = 0;
        while (before[i] === after[i]) i++;
        diff = JSON.stringify(after.slice(Math.max(0, i - 20), i + 20));
      }
      await shot('ctrl-enter-human');
      assert(after === before, `Ctrl+Enter on a "${st}" sentence silently inserted a blank line (a LaTeX paragraph break): ${diff}`);
    });

    await check('UX-keys: Alt+↓ with an empty review queue keeps the standard "move line down"', async () => {
      await freshPage();
      await cursorIn('Charged particles from the decay');
      const before = await docText();
      await page.keyboard.press('Alt+ArrowDown');
      await sleep(400);
      const after = await docText();
      assert(after !== before, 'Alt+↓ is swallowed even when there is nothing to review: the line (= sentence) cannot be moved with the standard binding');
    });

    await check('UX-keys: an impatient Alt+↓ right after the last review step does not move a sentence', async () => {
      await freshPage();
      await authorWrites();
      const sec = page.locator('.section-card').filter({ hasText: /Results|结果/ }).first();
      await sec.scrollIntoViewIfNeeded();
      await sec.locator('button').first().click();
      await sec.getByRole('button', { name: /根据大纲起草|Draft from outline/ }).first().click();
      await waitFor(() => window.__paper.workspace.getState().units.some((u) => u.state === 'proposed'), null, 8000, 'proposed sentences');
      await sleep(800);
      await pc(() => window.__paper.workspace.getState().editor.revealLine(1));
      await page.keyboard.press('Escape');
      // walk the queue to its end, accepting each sentence
      for (let i = 0; i < 6; i++) {
        const before = await docText();
        await page.keyboard.press('Alt+ArrowDown');
        await sleep(250);
        const st = await pc(() => {
          const ws = window.__paper.workspace.getState();
          return ws.units.find((u) => u.id === ws.activeSentenceId)?.state ?? null;
        });
        if (st !== 'proposed' && st !== 'unsupported') {
          assert((await docText()) === before, 'the Alt+↓ after the last accepted sentence moved a sentence');
          break;
        }
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+Enter');
        await sleep(300);
      }
      const t0 = await docText();
      await page.keyboard.press('Alt+ArrowDown');
      await sleep(300);
      const t1 = await docText();
      assert(t1 === t0, 'Alt+↓ right after a review step moved a sentence');
    });

    await check('UX-keys: Ctrl+Enter twice on a proposed sentence accepts it once and adds no blank line', async () => {
      await freshPage();
      // proposed sentences from the (simulated) drafter, after the author wrote the five items
      await authorWrites();
      const sec = page.locator('.section-card').filter({ hasText: /Results|结果/ }).first();
      await sec.scrollIntoViewIfNeeded();
      await sec.locator('button').first().click();
      const before = await pc(() => window.__paper.workspace.getState().units.filter((u) => u.state === 'proposed').length);
      await sec.getByRole('button', { name: /根据大纲起草|Draft from outline/ }).first().click();
      await waitFor((n) => window.__paper.workspace.getState().units.filter((u) => u.state === 'proposed').length > n, before, 8000, 'proposed sentences');
      await sleep(800);
      const id = await pc(() => window.__paper.workspace.getState().units.find((u) => u.state === 'proposed').id);
      await pc((i) => window.__paper.workspace.getState().editor.revealSentence(i), id);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Escape');
      const t0 = await docText();
      await page.keyboard.press('Control+Enter');
      await waitFor((i) => window.__paper.workspace.getState().units.find((u) => u.id === i)?.state !== 'proposed', id, 3000, 'accepted');
      await sleep(200);
      const t1 = await docText();
      await page.keyboard.press('Control+Enter'); // impatient second press
      await sleep(400);
      const t2 = await docText();
      assert(t1 === t0, 'accepting changed the text');
      assert(t2 === t1, `the second Ctrl+Enter inserted a paragraph break (${t2.length - t1.length} chars) in the middle of the drafted paragraph`);
    });

    await check('UX-mac: on macOS the Review panel hint names the key that actually accepts (it says "Ctrl+Enter")', async () => {
      await freshPage({ mac: true });
      await authorWrites();
      const sec = page.locator('.section-card').filter({ hasText: /Results|结果/ }).first();
      await sec.scrollIntoViewIfNeeded();
      await sec.locator('button').first().click();
      await sec.getByRole('button', { name: /根据大纲起草|Draft from outline/ }).first().click();
      await waitFor(() => window.__paper.workspace.getState().units.some((u) => u.state === 'proposed'), null, 8000, 'proposed sentences');
      await sleep(800);
      await openTab('审阅');
      const hint = (await page.locator('.shell-panel').innerText()).split('\n').find((l) => /Enter/.test(l)) ?? '';
      const id = await pc(() => window.__paper.workspace.getState().units.find((u) => u.state === 'proposed').id);
      await pc((i) => window.__paper.workspace.getState().editor.revealSentence(i), id);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Escape');
      await shot('mac-review-hint');
      const m = hint.match(/(Ctrl|⌘|Cmd)\+Enter/);
      assert(m, `no accept hint in the Review panel: "${hint}"`);
      await page.keyboard.press(m[1] === 'Ctrl' ? 'Control+Enter' : 'Meta+Enter');
      await sleep(600);
      const st = (await unitById(id)).state;
      assert(st !== 'proposed', `hint "${hint}" on macOS, but ${m[0]} leaves the sentence "${st}" (only Cmd+Enter accepts)`);
    });

    /* ------------------------------------------------------------------ anti-anchoring */
    await check('UX-anchor: Draft buttons stay disabled until the author has written the five items', async () => {
      await freshPage();
      await openTab('大纲');
      const filled = await pc(() => window.__paper.workspace.getState().outline?.authorFilled ?? null);
      const story = await page.locator('.five-items textarea').first().inputValue();
      const sec = page.locator('.section-card').filter({ hasText: /Results|结果/ }).first();
      await sec.scrollIntoViewIfNeeded();
      await sec.locator('button').first().click();
      const btn = sec.getByRole('button', { name: /根据大纲起草|Draft from outline/ }).first();
      await btn.scrollIntoViewIfNeeded();
      const enabled = await btn.isEnabled();
      const framingsBtn = await page.getByRole('button', { name: /提出.*框架|Propose.*framing/ }).first().isEnabled().catch(() => null);
      await shot('anchor-draft');
      assert(!enabled, `five items empty (story "${story}", authorFilled ${filled}) but "Draft from outline" is enabled (framings button enabled: ${framingsBtn}); the AI writes the section before the author`);
      await authorWrites();
      await btn.scrollIntoViewIfNeeded();
      assert(await btn.isEnabled(), '"Draft from outline" stays disabled after the author wrote the five items');
    });

    /* ------------------------------------------------------------------ ghost: IME and latency */
    await check('UX-ime: pinyin composition over a visible ghost (full app, 中文 UI) hides the ghost and commits cleanly', async () => {
      await freshPage();
      await newLineAfter('Charged particles from the decay', 'The gain');
      await page.keyboard.press('Control+Space');
      await page.waitForSelector('[data-testid="ghost"]', { timeout: 4000 });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
      await sleep(250);
      const during = await page.locator('[data-testid="ghost"]').count();
      await shot('ime-composing');
      await cdp.send('Input.insertText', { text: '中' });
      await sleep(400);
      const t = await docText();
      assert(during === 0, 'ghost still visible while composing');
      assert(t.includes('The gain中') && !t.includes('zhong'), 'composition not committed cleanly');
    });

    await check('UX-latency: a pending ghost request shows visible feedback within 150 ms', async () => {
      await freshPage();
      await pc(() => {
        window.__paper.api.ghostDelay = 1500;
      });
      await newLineAfter('Charged particles from the decay', 'The gain');
      await page.keyboard.press('Control+Space');
      await sleep(150);
      const fb = await pc(() => {
        const el = document.querySelector('.pc-pulse');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height, title: el.closest('[title]')?.getAttribute('title') ?? '' };
      });
      await shot('ghost-pending');
      assert(fb && fb.w > 0, 'no pending indicator after 150 ms');
      return `pulse ${fb.w}x${fb.h} "${fb.title}"`;
    });

    /* ------------------------------------------------------------------ card placement */
    await check('UX-card: Instruct proposal card at 1280x800 never covers its own sentence', async () => {
      await freshPage({ width: 1280, height: 800 });
      const id = await cursorIn('On isolated displaced particles that neither');
      await page.keyboard.press('Control+i');
      await page.waitForSelector('.pc-card input.pc-input', { timeout: 2000 });
      await page.keyboard.insertText('把基线放在前面');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-testid="proposal"]', { timeout: 4000 });
      await sleep(300);
      const r = await pc((i) => {
        const c = document.querySelector('[data-testid="sentence-card"]')?.getBoundingClientRect();
        const rects = [...document.querySelectorAll(`.cm-content [data-unit="${i}"]`)].flatMap((n) => [...n.getClientRects()].map((x) => ({ x: x.x, y: x.y, w: x.width, h: x.height })));
        return { c: c ? { x: c.x, y: c.y, width: c.width, height: c.height } : null, rects };
      }, id);
      await shot('card-instruct-1280');
      assert(r.c, 'no card');
      const hit = r.rects.filter((x) => x.w > 2 && overlaps(x, r.c));
      assert(hit.length === 0, `card covers ${hit.length} line box(es) of its sentence`);
    });

    /* ------------------------------------------------------------------ error states */
    await check('UX-errors: a compile error is visible and its line is one click away', async () => {
      await freshPage();
      await pc(() =>
        window.__paper.api.emit({
          type: 'compile.status',
          state: 'error',
          pdfVersion: null,
          errors: [{ file: 'main.tex', line: 20, message: 'Undefined control sequence \\effA' }],
          logTail: '! Undefined control sequence.\nl.20 ... \\effA',
        }),
      );
      await sleep(300);
      const pill = await page.locator('.compile-pill').innerText();
      // the pill compiles; its caret (which shows the error count) opens the errors
      await page.locator('.compile-caret').click();
      await page.locator('.compile-errors button').first().click();
      await sleep(300);
      const line = await pc(() => {
        return document.querySelector('.cm-activeLineGutter')?.textContent ?? '';
      });
      await shot('compile-error');
      assert(/1|错误|error/i.test(pill), `pill "${pill}"`);
      return `pill "${pill}", active line gutter "${line}"`;
    });

    await check('UX-errors: server down (no ?mock) explains how to start the server', async () => {
      await freshPage({ width: 1280, height: 800, mock: false });
      await sleep(4000);
      const txt = await pc(() => document.body.innerText);
      await shot('server-down');
      assert(/paper open|mock=1/.test(txt), 'no hint how to start the server');
    });

    /* ------------------------------------------------------------------ dark mode */
    await check('UX-contrast: ghost text keeps >= 3:1 contrast in light and dark', async () => {
      const out = [];
      for (const scheme of ['light', 'dark']) {
        await freshPage({ colorScheme: scheme });
        await newLineAfter('Charged particles from the decay', 'The gain');
        await page.keyboard.press('Control+Space');
        await page.waitForSelector('[data-testid="ghost"]', { timeout: 4000 });
        await shot(`ghost-${scheme}`);
        const c = await pc(() => {
          const cv = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
          const parse = (s) => {
            // normalise any CSS colour (rgb(), color(srgb ...), color-mix results) through a 1x1 canvas
            cv.clearRect(0, 0, 1, 1);
            cv.fillStyle = s;
            cv.fillRect(0, 0, 1, 1);
            const [r, g, b, a] = cv.getImageData(0, 0, 1, 1).data;
            return { r, g, b, a: a / 255 };
          };
          const bgOf = (el) => {
            for (let e = el; e; e = e.parentElement) {
              const b = parse(getComputedStyle(e).backgroundColor);
              if (b.a > 0.9) return b;
            }
            return { r: 255, g: 255, b: 255, a: 1 };
          };
          const lum = ({ r, g, b }) => {
            const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
            return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
          };
          const ratio = (el) => {
            const fg = parse(getComputedStyle(el).color);
            const bg = bgOf(el);
            const mix = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
            const [l1, l2] = [lum(mix), lum(bg)].sort((a, b) => b - a);
            return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
          };
          return { ghost: ratio(document.querySelector('[data-testid="ghost"]')) };
        });
        out.push({ scheme, ghost: c.ghost });
      }
      const txt = out.map((o) => `${o.scheme} ghost ${o.ghost}:1`).join(', ');
      assert(out.every((o) => o.ghost >= 3), `${txt}: the ghost sentence the author must read and judge is below 3:1`);
      return txt;
    });
  } finally {
    await browser.close();
    if (child) process.kill(-child.pid);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed; screenshots in ${SHOTS}`);
  process.exit(failed.length ? 1 : 0);
}

/** The author writes the story and ticks "I wrote these five items myself" (Draft is locked before). */
async function authorWrites() {
  await openTab('大纲');
  const story = page.locator('.five-items textarea').first();
  await story.scrollIntoViewIfNeeded();
  await story.fill('A tracker trained without the signal finds more displaced particles than the baseline.');
  const box = page.locator('.attest input[type="checkbox"]').first();
  await box.check();
  await waitFor(() => window.__paper.workspace.getState().outline !== null, null, 2000, 'outline');
}

/** The rail's four steps; the older panel names (大纲, 审阅 ...) select the step that now holds them. */
const STEP_OF = { 大纲: 'plan', 构思: 'plan', Outline: 'plan', 审阅: 'todo', 待办: 'todo', Review: 'todo', 事实: 'sources', Facts: 'sources', 同步: 'check', Sync: 'check' };

async function openTab(name) {
  const tab = page.locator(`.rail [role="tab"][data-step="${STEP_OF[name] ?? name}"]`);
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await sleep(150);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
