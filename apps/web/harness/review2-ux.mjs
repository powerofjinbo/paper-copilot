#!/usr/bin/env node
/**
 * Review round 2, UX: the 4-step rail, the Settings drawer and the short top bar as a first-time,
 * non-native author on a Mac (1280x800, 1440x900, 1920x1080; 中文 and EN; light and dark), with the
 * author's own report as the starting point: "pdf编译不出来呀，而且我也没懂咋用" (the PDF does not
 * compile, and I did not understand how to use it).
 *
 * Every check is a regression test: a FAIL is a defect found in review (see the reviewer report).
 *
 *   node apps/web/harness/review2-ux.mjs [--url http://127.0.0.1:5193] [--shots DIR] [--only TEXT] [--no-real]
 *
 * Part 1 drives the browser demo (`?mock=1`, vite dev; started on --url's port when nothing answers).
 * Part 2 drives the REAL server (`paper open`, simulated AI, a temp copy of fixtures/canto-demo with sync
 * off) on a VITE_PAPER_E2E=1 build, with real latexmk: a LaTeX error pdflatex recovers from, latexmk
 * missing (PAPER_LATEXMK pointing nowhere, as on a Mac with BasicTeX), and the server stopping.
 * Screenshots (deviceScaleFactor 1) go to --shots. Every process and temp directory is removed at the end.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..', '..');
const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const BASE = arg('--url', 'http://127.0.0.1:5193');
const SHOTS = resolve(arg('--shots', process.env.SHOTS_DIR ?? join(tmpdir(), 'paper-copilot-ux2-shots')));
const ONLY = arg('--only', null);
const REAL = !args.includes('--no-real');
const REAL_PORT = Number(arg('--port', '4494'));
mkdirSync(SHOTS, { recursive: true });

const results = [];
let browser;
let page;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pc = (fn, a) => page.evaluate(fn, a);
const shot = (name) => page.screenshot({ path: join(SHOTS, `ux2-${name}.png`) });

function log(ok, name, detail = '') {
  results.push({ ok, name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function check(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  try {
    const detail = await fn();
    log(true, name, typeof detail === 'string' ? detail : '');
  } catch (err) {
    log(false, name, err instanceof Error ? err.message.split('\n')[0] : String(err));
    try {
      await page.screenshot({ path: join(SHOTS, `ux2-fail-${results.length}.png`) });
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

/* ------------------------------------------------------------------------------------ */
/* Demo (vite dev, ?mock=1)                                                              */
/* ------------------------------------------------------------------------------------ */

async function up(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}
async function ensureVite() {
  if (await up(`${BASE}/`)) return null;
  const port = new URL(BASE).port || '5193';
  const child = spawn('npx', ['vite', '--port', port, '--strictPort'], { cwd: resolve(here, '..'), stdio: 'ignore', detached: true });
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await up(`${BASE}/`)) return child;
  }
  throw new Error(`vite did not start on ${BASE}`);
}

/** A Mac as the app and CodeMirror detect it (navigator.platform), set before any module loads. */
async function newMacContext({ width, height, colorScheme = 'light' }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme });
  await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));
  return ctx;
}

/** A fresh demo page (default UI language 中文: the fixture's notes language is zh). */
async function demoPage({ width = 1440, height = 900, colorScheme = 'light', lang = 'zh', ctx = null } = {}) {
  if (page && !ctx) await page.context().close();
  const c = ctx ?? (await newMacContext({ width, height, colorScheme }));
  page = await c.newPage();
  await page.goto(`${BASE}/?mock=1`);
  await page.waitForSelector('.cm-content .pc-s', { timeout: 20000 });
  await sleep(700);
  if (lang === 'en') await setLang('EN');
  return page;
}
async function setLang(label) {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('[data-testid="settings-drawer"]').getByRole('button', { name: label, exact: true }).click();
  await page.keyboard.press('Escape');
  await sleep(200);
}
const layout = () =>
  pc(() => {
    const w = (sel) => Math.round(document.querySelector(sel)?.getBoundingClientRect().width ?? 0);
    const sh = window.__paper.shell.getState();
    return {
      panel: w('.shell-panel'),
      editor: w('.shell-editor'),
      pdf: w('.shell-pdf'),
      fitHidden: sh.fitHidden,
      userCollapsed: sh.leftCollapsed,
      pinned: sh.pinned,
      selectedStep: document.querySelector('.rail [role="tab"][aria-selected="true"]')?.getAttribute('data-step') ?? null,
      pdfMessage: document.querySelector('.pdfp-message')?.innerText.replace(/\s+/g, ' ').trim() ?? null,
      pill: document.querySelector('.compile-pill')?.innerText.trim() ?? null,
    };
  });
async function compileAndSettle() {
  await page.locator('.compile-pill').click();
  await waitFor(() => ['ok', 'error'].includes(window.__paper.workspace.getState().compile.state), null, 120000, 'the compile to finish');
  await sleep(600);
}

/** WCAG 2.x contrast of every visible text node under the shell's chrome (top bar, rail, panel, status bar, PDF pane). */
function contrastScan() {
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const blend = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const bgOf = (el) => {
    const stack = [];
    for (let e = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0) {
        stack.push(c);
        if (c.a >= 1) break;
      }
    }
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = stack.length - 1; i >= 0; i--) bg = blend(stack[i], bg);
    return bg;
  };
  const out = [];
  for (const root of document.querySelectorAll('.topbar, .rail, .shell-panel, .statusbar, .pdfp')) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const txt = n.textContent.trim();
      if (!txt) continue;
      const el = n.parentElement;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden') continue;
      if (el.closest('[disabled],[aria-disabled="true"],textarea,input,select,option')) continue;
      const fg = parse(cs.color);
      let op = 1;
      for (let e = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
      fg.a *= op;
      const bg = bgOf(el);
      const L1 = lum(blend(fg, bg));
      const L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (Number(cs.fontWeight) >= 700 && size >= 18.66);
      if (ratio < (large ? 3 : 4.5)) out.push({ text: txt.slice(0, 24), cls: String(el.className || el.tagName).slice(0, 32), ratio: Math.round(ratio * 100) / 100, px: size });
    }
  }
  return out;
}

async function demoChecks() {
  /* ---------------------------------------------- the author's report: "the PDF does not compile" */
  await check('UX2-demo-compile: after Compile in the browser demo the PDF pane says why there is no PDF (no "Compile to see the PDF" loop)', async () => {
    await demoPage({ width: 1920, height: 1080 });
    await compileAndSettle();
    const m = await layout();
    const tail = await pc(() => window.__paper.workspace.getState().compile.logTail);
    await shot('demo-compile-1920-zh');
    assert(
      !/编译后在这里查看 PDF|Compile to see the PDF/.test(m.pdfMessage ?? ''),
      `the top bar says "${m.pill}" (green) while the PDF pane still asks "${m.pdfMessage}" and offers the same Compile button again; the reason ("${tail.slice(0, 60)}…") is only in the caret popover`,
    );
  });

  for (const [w, h] of [
    [1440, 900],
    [1280, 800],
  ]) {
    await check(`UX2-autohide: at ${w}x${h} the first Compile does not take away the step panel the author is using`, async () => {
      await demoPage({ width: w, height: h });
      const before = await layout();
      await compileAndSettle();
      const after = await layout();
      await shot(`autohide-${w}`);
      assert(
        after.panel > 0,
        `step panel ${before.panel}px -> ${after.panel}px after Compile (fitHidden.left=${after.fitHidden.left}, user collapsed=${after.userCollapsed}); the rail still marks "${after.selectedStep}" as selected; the space went to a PDF pane that shows "${after.pdfMessage}"`,
      );
    });
  }

  await check('UX2-autohide-persist: after one Compile, reopening the app at 1440x900 still shows the step panel (no empty PDF pane on load)', async () => {
    const ctx = await newMacContext({ width: 1440, height: 900 });
    if (page) await page.context().close();
    await demoPage({ ctx });
    await compileAndSettle();
    await page.close();
    await demoPage({ ctx });
    const m = await layout();
    const st = await pc(() => window.__paper.workspace.getState().compile.state);
    await shot('autohide-reload-1440');
    assert(
      m.panel > 0,
      `fresh load (compile state "${st}"): step panel ${m.panel}px, PDF pane ${m.pdf}px showing "${m.pdfMessage}" (pinned.pdf=${m.pinned.pdf} was persisted by the first Compile)`,
    );
  });

  await check('UX2-both-pinned: at 1280x800, bringing the panel back after a Compile leaves a usable editor column (>= 560 px)', async () => {
    await demoPage({ width: 1280, height: 800 });
    await compileAndSettle();
    await page.locator('.rail [data-step="sources"]').click();
    await sleep(500);
    const m = await layout();
    await shot('both-pinned-1280');
    assert(m.editor >= 560, `editor ${m.editor}px between a ${m.panel}px panel and a ${m.pdf}px PDF pane that shows "${m.pdfMessage}" (both now "pinned", the auto-fit gives up)`);
    return `editor ${m.editor}px`;
  });

  await check('UX2-rail-toggle: clicking the step that is already selected (① on first run) does not hide its panel', async () => {
    await demoPage({ width: 1440, height: 900 });
    await page.locator('.rail [data-step="plan"]').click();
    await sleep(300);
    const m = await layout();
    await shot('rail-click-plan');
    assert(m.panel > 0, `a first click on "① 构思" (the step the intro tells you to start with) closed the panel: panel ${m.panel}px`);
  });

  /* ---------------------------------------------- the author's report: "I did not understand how to use it" */
  await check('UX2-intro: the first-run intro says how to write with the AI in the editor and where the shortcuts are', async () => {
    for (const lang of ['zh', 'en']) {
      await demoPage({ width: 1440, height: 900, lang });
      const text = await page.locator('[data-testid="first-run"]').innerText();
      await shot(`intro-${lang}`);
      const editorHow = /⌥\/|Alt\+\/|Tab|⌘\+Enter|点击.*句|click a sentence|ghost|补全|\?|F1/.test(text);
      assert(editorHow, `${lang}: the intro (${text.replace(/\s+/g, ' ').length} chars) describes the four panels only; it never names the editor interactions (click a sentence, the ghost key ⌥/, a 中文 line + ⌘Enter) nor "?" for the shortcut list: "${text.replace(/\s+/g, ' ').slice(0, 140)}…"`);
    }
  });

  await check('UX2-help: the "?" list includes the sentence card letter keys (l alternatives, r rewrite, x reject, h history) that README documents', async () => {
    await demoPage({ width: 1440, height: 900, lang: 'en' });
    await page.locator('.statusbar').click();
    await page.keyboard.press('Shift+Slash');
    await page.waitForSelector('.help-dialog');
    const keys = await pc(() => [...document.querySelectorAll('.help-dialog kbd')].map((k) => k.textContent.trim()));
    await shot('help-en-mac');
    const missing = ['l', 'r', 'x', 'h'].filter((k) => !keys.includes(k) && !keys.includes(k.toUpperCase()));
    assert(missing.length === 0, `keys listed: ${[...new Set(keys)].join(' ')}; missing: ${missing.join(', ')} (only reachable by guessing from the card's "⌘+. to use the letter keys")`);
  });

  await check('UX2-mac-keys: on a Mac the sentence card names the Option key as ⌥, like the "?" list (not "Alt")', async () => {
    await demoPage({ width: 1440, height: 900, lang: 'en' });
    // a click on a sentence opens its card without moving the focus into it: the card then shows its key hint
    await page.locator('.cm-content .pc-s', { hasText: 'Trackers tuned on prompt' }).first().click();
    await page.waitForSelector('.pc-card-hint', { timeout: 3000 });
    const hint = await page.locator('.pc-card-hint').innerText();
    await shot('card-mac');
    assert(!/\bAlt\b/.test(hint), `card hint on macOS: "${hint.replace(/\s+/g, ' ')}" while the "?" list says ⌥+↓`);
  });

  await check('UX2-settings-pdf: Settings "Show the PDF pane" is unchecked while no PDF pane is on screen', async () => {
    await demoPage({ width: 1440, height: 900, lang: 'en' });
    await page.locator('[data-testid="settings-button"]').click();
    const box = page.locator('[data-testid="settings-drawer"]').getByLabel(/Show the PDF pane/);
    const checked = await box.isChecked();
    const pdf = await pc(() => !!document.querySelector('.shell-pdf'));
    await shot('settings-pdf-1440');
    await page.keyboard.press('Escape');
    assert(!(checked && !pdf), `"Show the PDF pane" is ticked but there is no PDF pane (it opens only after a compile); unticking and ticking it is the only way to find out`);
  });

  await check('UX2-contrast: light theme text in the rail, panels, PDF pane and status bar meets WCAG AA (4.5:1)', async () => {
    await demoPage({ width: 1920, height: 1080, colorScheme: 'light' });
    await compileAndSettle();
    const seen = new Map();
    for (const step of ['plan', 'sources', 'todo', 'check']) {
      const tab = page.locator(`.rail [data-step="${step}"]`);
      if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
      await sleep(350);
      for (const x of await pc(contrastScan)) if (!seen.has(x.cls)) seen.set(x.cls, x);
    }
    await shot('contrast-light-1920');
    const worst = [...seen.values()].sort((a, b) => a.ratio - b.ratio);
    assert(worst.length === 0, `${worst.length} text styles below AA: ${worst.slice(0, 8).map((x) => `"${x.text}" .${x.cls} ${x.ratio}:1 @${x.px}px`).join('; ')}`);
  });
  await check('UX2-contrast: dark theme text meets WCAG AA (4.5:1)', async () => {
    await demoPage({ width: 1920, height: 1080, colorScheme: 'dark', lang: 'en' });
    const seen = new Map();
    for (const step of ['plan', 'sources', 'todo', 'check']) {
      const tab = page.locator(`.rail [data-step="${step}"]`);
      if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
      await sleep(350);
      for (const x of await pc(contrastScan)) if (!seen.has(x.cls)) seen.set(x.cls, x);
    }
    await shot('contrast-dark-1920');
    const worst = [...seen.values()].sort((a, b) => a.ratio - b.ratio);
    assert(worst.length === 0, `${worst.length} text styles below AA: ${worst.slice(0, 8).map((x) => `"${x.text}" .${x.cls} ${x.ratio}:1 @${x.px}px`).join('; ')}`);
  });
}

/* ------------------------------------------------------------------------------------ */
/* Real server (paper open, real latexmk)                                                */
/* ------------------------------------------------------------------------------------ */

const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function makeRealProject(work, mutate) {
  const proj = join(work, 'proj');
  const repo = join(work, 'repo');
  cpSync(join(ROOT, 'fixtures', 'canto-demo', 'repo'), repo, { recursive: true });
  mkdirSync(proj, { recursive: true });
  cpSync(join(ROOT, 'fixtures', 'canto-demo', 'tex'), join(proj, 'tex'), { recursive: true });
  const main = join(proj, 'tex', 'main.tex');
  writeFileSync(main, mutate(readFileSync(main, 'utf8')));
  const env = { ...process.env, PAPER_FAKE_LLM: '1' };
  delete env.ANTHROPIC_API_KEY;
  const r = spawnSync(process.execPath, [TSX, 'src/cli.ts', 'init', proj, '--repo', repo, '--skill', join(ROOT, '.skill'), '--sync', 'none'], { cwd: join(ROOT, 'apps', 'server'), env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`paper init failed: ${(r.stderr || r.stdout).slice(0, 600)}`);
  return proj;
}

async function startServer(proj, dist, extraEnv = {}) {
  const env = { ...process.env, PAPER_FAKE_LLM: '1', PAPER_WEB_DIST: dist, ...extraEnv };
  delete env.ANTHROPIC_API_KEY;
  const child = spawn(process.execPath, [TSX, 'src/cli.ts', 'open', proj, '--no-browser', '--port', String(REAL_PORT)], { cwd: join(ROOT, 'apps', 'server'), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 300; i++) {
    const m = /Open: (http:\/\/\S+)/.exec(out);
    if (m) return { child, url: m[1] };
    if (child.exitCode !== null) throw new Error(`paper open exited: ${out.slice(-800)}`);
    await sleep(100);
  }
  throw new Error(`paper open printed no URL: ${out.slice(-800)}`);
}
async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* gone */
  }
  if ((await Promise.race([exited.then(() => 'exit'), sleep(10000).then(() => 'timeout')])) === 'timeout') {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}
async function realPage(url, { width = 1440, height = 900 } = {}) {
  if (page) await page.context().close();
  const ctx = await newMacContext({ width, height });
  page = await ctx.newPage();
  await page.goto(url);
  await page.waitForSelector('.cm-content .pc-s', { timeout: 30000 });
  await sleep(800);
}
/** Is `text` visible on screen without opening anything (popovers closed)? */
const onScreen = (text) =>
  pc((t) => {
    const all = document.body.innerText;
    return all.includes(t);
  }, text);

async function realChecks() {
  const work = mkdtempSync(join(tmpdir(), 'paper-ux2-'));
  const dist = join(work, 'web-dist');
  let server = null;
  try {
    const b = spawnSync('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: resolve(here, '..'), env: { ...process.env, VITE_PAPER_E2E: '1' }, encoding: 'utf8' });
    if (b.status !== 0) throw new Error(`vite build failed: ${(b.stderr || b.stdout).slice(0, 600)}`);

    /* ---- A: one undefined macro. pdflatex reports it, recovers and writes the PDF (Overleaf shows it). */
    const projA = makeRealProject(join(work, 'a'), (s) => s.replace('\\maketitle', '\\maketitle\n\\badmacro'));
    const a = await startServer(projA, dist);
    server = a.child;
    await realPage(a.url);

    await check('UX2-real-recoverable: one undefined macro still shows the PDF pdflatex wrote (with the error listed)', async () => {
      await compileAndSettle();
      const c = await pc(() => window.__paper.workspace.getState().compile);
      const written = /Output written on/.test(c.logTail);
      const m = await layout();
      await shot('real-badmacro-1440');
      assert(
        c.pdfVersion !== null,
        `compile "${c.state}", pdfVersion ${c.pdfVersion}; latexmk's log says "${written ? 'Output written on …main.pdf' : '(no output line)'}" but the app shows no PDF at all: "${m.pdfMessage}"`,
      );
    });

    await check('UX2-real-error-visible: after a failed compile the reason is on screen, and the PDF pane points to where the log really is', async () => {
      const c = await pc(() => window.__paper.workspace.getState().compile);
      const first = c.errors[0]?.message ?? '';
      const visible = first ? await onScreen(first) : false;
      const m = await layout();
      const statusbar = await pc(() => document.querySelector('.statusbar').innerText.replace(/\s+/g, ' '));
      const saysStatusBar = /状态栏|status bar/.test(m.pdfMessage ?? '');
      const statusHasLog = /log|日志|badmacro|Undefined/i.test(statusbar);
      assert(
        visible && !(saysStatusBar && !statusHasLog),
        `error "${first}" visible without opening the pill's caret: ${visible}; PDF pane: "${m.pdfMessage}"; status bar: "${statusbar}"`,
      );
    });

    await check('UX2-real-error-line: the failing line (main.tex:26 \\badmacro) is marked in the editor', async () => {
      const marked = await pc(() => {
        const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.trim() === '\\badmacro');
        if (!line) return 'line not rendered';
        const cls = line.className + ' ' + [...line.querySelectorAll('*')].map((e) => e.className).join(' ');
        const gutter = [...document.querySelectorAll('.cm-gutterElement')].some((g) => g.textContent.trim() === '26' && /error|danger|compile/i.test(g.className + g.innerHTML));
        return /error|danger|compile|lint-error/i.test(cls) || gutter ? 'marked' : `unmarked: "${line.className}"`;
      });
      assert(marked === 'marked', `the editor does not mark the compile error at line 26 (${marked}); the only way to it is the caret popover's main.tex:26 link`);
    });

    /* ---- server stops while the page is open */
    await check('UX2-real-server-down: Compile while the server is stopped says so in the UI language (not a raw "Failed to fetch")', async () => {
      await stopServer(server);
      server = null;
      await waitFor(() => !window.__paper.workspace.getState().connected, null, 8000, 'the client to notice the server is gone');
      await page.locator('.compile-pill').click();
      await sleep(1500);
      const toasts = await pc(() => [...document.querySelectorAll('.toast, [role="alert"], [role="status"]')].map((t) => t.innerText.trim()).filter(Boolean).join(' | '));
      await shot('real-server-down-compile');
      const raw = /Failed to fetch|Load failed|NetworkError/.test(toasts);
      assert(!raw, `zh UI, server stopped, Compile clicked: "${toasts.replace(/\s+/g, ' ').slice(0, 200)}" (Safari words it "Load failed"); nothing says the server stopped or how to restart it (pnpm paper open)`);
    });

    /* ---- B: latexmk not installed (BasicTeX on a Mac has no latexmk; MacTeX not on PATH) */
    const projB = makeRealProject(join(work, 'b'), (s) => s);
    const bsrv = await startServer(projB, dist, { PAPER_LATEXMK: join(work, 'no-such-latexmk') });
    server = bsrv.child;
    await realPage(bsrv.url);
    await check('UX2-real-no-latexmk: with latexmk missing, the reason is on screen after Compile (not only in the caret popover)', async () => {
      await compileAndSettle();
      const c = await pc(() => window.__paper.workspace.getState().compile);
      const first = c.errors[0]?.message ?? '';
      const visible = await onScreen(first.slice(0, 30));
      const m = await layout();
      await shot('real-no-latexmk-1440');
      assert(visible, `the server says "${first}" but the screen shows the pill "${m.pill}" and the PDF pane "${m.pdfMessage}" (log tail is empty, the status bar has no log)`);
    });
  } finally {
    await stopServer(server);
    rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const vite = await ensureVite();
  browser = await chromium.launch();
  try {
    await demoChecks();
    if (REAL) await realChecks();
  } finally {
    await browser.close();
    if (vite) {
      try {
        process.kill(-vite.pid, 'SIGTERM');
      } catch {
        /* gone */
      }
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed; screenshots in ${SHOTS}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
