#!/usr/bin/env node
/**
 * End-to-end check of the PDF pane (harness/pdf.html) with a real PDF compiled from the fixture.
 *
 *   node apps/web/harness/e2e-pdf.mjs [--url http://127.0.0.1:5176] [--shots DIR] [--headed] [--build-only]
 *
 * 1. Compiles fixtures/canto-demo/tex/main.tex with latexmk (and long.tex: the same paper with the body
 *    repeated four times, so there are several pages) in a temp dir, and copies main.pdf, long.pdf and
 *    a few `synctex view` boxes (boxes.json) to apps/web/harness/.out/ (git-ignored by its own
 *    .gitignore; nothing is added to git).
 * 2. Starts `vite --port 5176` in apps/web when nothing answers at --url.
 * 3. Checks: page 1 renders at devicePixelRatio; fit width; a click near the top-left margin reports
 *    small top-left-origin points equal to the CSS offset over the zoom; a click on a typeset line
 *    round-trips through the real `synctex edit` to that source line; showBox scrolls to a later page
 *    and fades; a reload with a new version keeps the reading position; zoom keys; stale, empty,
 *    loading and error states; dark mode; devicePixelRatio 2.
 * Screenshots (pdf-*.png, deviceScaleFactor 1) go to --shots (default $SHOTS_DIR or $TMPDIR/paper-copilot-shots).
 */
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(here, '..');
const FIXTURE = resolve(here, '../../../fixtures/canto-demo/tex');
const OUT = join(here, '.out');
const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const BASE = arg('--url', 'http://127.0.0.1:5176');
const SHOTS = resolve(arg('--shots', process.env.SHOTS_DIR ?? join(tmpdir(), 'paper-copilot-shots')));
const HEADED = args.includes('--headed');
const BUILD_ONLY = args.includes('--build-only');

/* ---------------------------------------------------------------------------------------------- */
/* Build the PDFs                                                                                  */
/* ---------------------------------------------------------------------------------------------- */

function lineOf(text, needle, nth = 1) {
  const lines = text.split('\n');
  let seen = 0;
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(needle) && ++seen === nth) return i + 1;
  throw new Error(`"${needle}" #${nth} not found`);
}

function synctexBox(pdf, tex, line, cwd) {
  const out = execFileSync('synctex', ['view', '-i', `${line}:0:${tex}`, '-o', pdf], { cwd, encoding: 'utf8' });
  const rec = {};
  for (const l of out.split('\n')) {
    const m = /^(Page|h|v|W|H):(-?[\d.]+)$/.exec(l.trim());
    if (m && !(m[1] in rec)) rec[m[1]] = Number(m[2]);
  }
  if (!('Page' in rec)) throw new Error(`synctex view found nothing for ${tex}:${line}`);
  return { page: rec.Page, x: rec.h, y: rec.v - rec.H, w: rec.W, h: rec.H };
}

function synctexEdit(pdf, page, x, y, cwd) {
  const out = execFileSync('synctex', ['edit', '-o', `${page}:${x}:${y}:${pdf}`], { cwd, encoding: 'utf8' });
  const m = /^Line:(\d+)/m.exec(out);
  return m ? Number(m[1]) : null;
}

function build() {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, '.gitignore'), '# build output of harness/e2e-pdf.mjs\n*\n');
  const tmp = mkdtempSync(join(tmpdir(), 'pc-pdf-'));
  copyFileSync(join(FIXTURE, 'main.tex'), join(tmp, 'main.tex'));
  copyFileSync(join(FIXTURE, 'refs.bib'), join(tmp, 'refs.bib'));
  const main = readFileSync(join(FIXTURE, 'main.tex'), 'utf8');
  // long.tex: the body (Introduction..Conclusions) repeated four times before the appendix; the
  // original lines keep their numbers, the copies drop their \label{}s.
  const lines = main.split('\n');
  const from = lineOf(main, '\\section{Introduction}') - 1;
  const to = lineOf(main, '\\appendix') - 1;
  // (a line left empty inside an equation would end the math, so it becomes a comment)
  const body = lines.slice(from, to).map((l) => (/\\label\{/.test(l) ? l.replace(/\\label\{[^}]*\}/g, '%') : l));
  const long = [...lines.slice(0, to), ...body, ...body, ...body, ...body, ...lines.slice(to)].join('\n');
  writeFileSync(join(tmp, 'long.tex'), long);
  for (const job of ['main', 'long']) {
    execFileSync('latexmk', ['-pdf', '-synctex=1', '-interaction=nonstopmode', '-outdir=out', `${job}.tex`], { cwd: tmp, stdio: 'ignore' });
    copyFileSync(join(tmp, 'out', `${job}.pdf`), join(OUT, `${job}.pdf`));
  }
  const intro = lineOf(long, 'Searches for long-lived particles look for tracks');
  const late = lineOf(long, 'The test set holds 8,710 targets.', 4);
  const boxes = {
    intro: synctexBox('out/long.pdf', 'long.tex', intro, tmp),
    late: synctexBox('out/long.pdf', 'long.tex', late, tmp),
  };
  writeFileSync(join(OUT, 'boxes.json'), JSON.stringify(boxes, null, 2));
  return { tmp, intro, late, boxes };
}

/* ---------------------------------------------------------------------------------------------- */
/* Checks                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

const results = [];
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
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

async function up(url) {
  try {
    const r = await fetch(url);
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  const probe = `${BASE}/harness/pdf.html`;
  if (await up(probe)) return null;
  const port = new URL(BASE).port || '5176';
  const child = spawn('npx', ['vite', '--port', port, '--strictPort'], { cwd: WEB, stdio: 'ignore', detached: false });
  for (let i = 0; i < 120; i++) {
    if (await up(probe)) return child;
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error(`vite did not start on ${BASE}`);
}

const pageRect = (page, n) =>
  page.evaluate((n) => {
    const el = document.querySelector(`.pdfp-page[data-page="${n}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }, n);

const scrollState = (page) =>
  page.evaluate(() => {
    const s = document.querySelector('.pdfp-scroll');
    return { top: s.scrollTop, left: s.scrollLeft, h: s.clientHeight, w: s.clientWidth, page: document.querySelector('.pdfp-pageinput')?.value ?? '' };
  });

const waitRendered = (page, n = 1) => page.waitForSelector(`.pdfp-page.is-rendered[data-page="${n}"] canvas`, { timeout: 20_000 });

async function main() {
  const built = build();
  console.log(`built ${OUT}/main.pdf, long.pdf (intro line ${built.intro}, late line ${built.late} on page ${built.boxes.late.page})`);
  if (BUILD_ONLY) return 0;
  mkdirSync(SHOTS, { recursive: true });
  const server = await ensureServer();
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: !HEADED });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1, colorScheme: 'light' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const shot = (name) => page.screenshot({ path: join(SHOTS, `pdf-${name}.png`) });

  try {
    await page.goto(`${BASE}/harness/pdf.html?doc=long&theme=light`);
    await page.evaluate(() => sessionStorage.clear());
    await page.reload();

    await check('page 1 renders lazily at devicePixelRatio, fit to width', async () => {
      await waitRendered(page, 1);
      const info = await page.evaluate(() => {
        const s = document.querySelector('.pdfp-scroll');
        const p = document.querySelector('.pdfp-page[data-page="1"]');
        const c = p.querySelector('canvas');
        return {
          pages: document.querySelectorAll('.pdfp-page').length,
          rendered: document.querySelectorAll('.pdfp-page.is-rendered').length,
          pageW: p.getBoundingClientRect().width,
          paneW: s.clientWidth,
          canvasW: c.width,
          pct: document.querySelector('.pdfp-pct').textContent,
          fit: document.querySelector('.pdfp-btn[aria-pressed]').getAttribute('aria-pressed'),
        };
      });
      assert(info.pages >= 3, `expected several pages, got ${info.pages}`);
      assert(info.rendered < info.pages, `all ${info.pages} pages rendered eagerly`);
      assert(near(info.pageW, info.paneW - 24, 1.5), `page ${info.pageW}px in a ${info.paneW}px pane is not fit-width`);
      assert(near(info.canvasW, info.pageW, 1.5), `canvas ${info.canvasW}px for ${info.pageW} CSS px at DPR 1`);
      assert(info.fit === 'true', 'fit width not pressed');
      return `${info.pages} pages, ${info.rendered} rendered, ${info.pct}`;
    });
    await shot('ready');

    await check('click near the top-left margin -> small top-left-origin points', async () => {
      const r = await pageRect(page, 1);
      const scale = r.width / 612;
      await page.mouse.click(r.left + 30, r.top + 40);
      await page.waitForFunction(() => window.__pdf.calls.length >= 1);
      const c = await page.evaluate(() => window.__pdf.calls.at(-1));
      assert(c.page === 1, `page ${c.page}`);
      assert(c.x >= 0 && c.y >= 0 && c.x <= 612 && c.y <= 792, `outside the page: ${c.x},${c.y}`);
      assert(near(c.x, 30 / scale, 0.6) && near(c.y, 40 / scale, 0.6), `got ${c.x},${c.y}; want ${(30 / scale).toFixed(2)},${(40 / scale).toFixed(2)}`);
      assert(c.x < 40 && c.y < 50, 'not small');
      return `x=${c.x} y=${c.y} at ${(scale * 100 / (96 / 72)).toFixed(0)}%`;
    });

    await check('click on a typeset line round-trips through synctex edit to its source line', async () => {
      const b = built.boxes.intro;
      const r = await pageRect(page, b.page);
      const scale = r.width / 612;
      const tx = b.x + Math.min(60, b.w / 2);
      const ty = b.y + b.h / 2;
      await page.mouse.click(r.left + tx * scale, r.top + ty * scale);
      await page.waitForFunction(() => window.__pdf.calls.length >= 2 && window.__pdf.targets.length >= 2);
      const c = await page.evaluate(() => window.__pdf.calls.at(-1));
      assert(near(c.x, tx, 0.75) && near(c.y, ty, 0.75), `got ${c.x},${c.y}; want ${tx.toFixed(2)},${ty.toFixed(2)}`);
      const line = synctexEdit('out/long.pdf', c.page, c.x, c.y, built.tmp);
      assert(line === built.intro, `synctex edit says line ${line}, want ${built.intro}`);
      const targets = await page.evaluate(() => window.__pdf.targets.length);
      assert(targets >= 2, 'onInverse not called');
      return `(${c.x}, ${c.y}) -> long.tex:${line}`;
    });

    await check('inverse search with no source line shows a quiet notice', async () => {
      await page.evaluate(() => (window.__pdf.inverseResult = 'null'));
      const r = await pageRect(page, 1);
      await page.mouse.click(r.left + 200, r.top + 10);
      await page.waitForSelector('.pdfp-notice', { timeout: 3000 });
      await page.evaluate(() => (window.__pdf.inverseResult = 'echo'));
      return await page.textContent('.pdfp-notice');
    });

    await check('showBox scrolls to a later page and draws a highlight that fades', async () => {
      const b = built.boxes.late;
      const before = await scrollState(page);
      await page.evaluate((b) => window.__pdf.handle.showBox(b), b);
      await page.waitForSelector(`.pdfp-page[data-page="${b.page}"] .pdfp-hl`, { timeout: 2000 });
      await page.waitForTimeout(700); // smooth scroll + render
      await waitRendered(page, b.page);
      const info = await page.evaluate(() => {
        const s = document.querySelector('.pdfp-scroll').getBoundingClientRect();
        const h = document.querySelector('.pdfp-hl').getBoundingClientRect();
        return { s: { top: s.top, bottom: s.bottom, left: s.left, right: s.right }, h: { top: h.top, bottom: h.bottom, left: h.left, right: h.right, width: h.width, height: h.height } };
      });
      const after = await scrollState(page);
      assert(after.top > before.top + 100, `did not scroll (${before.top} -> ${after.top})`);
      assert(info.h.top >= info.s.top && info.h.bottom <= info.s.bottom, 'highlight not in view');
      const r = await pageRect(page, b.page);
      const scale = r.width / 612;
      assert(near(info.h.left - r.left, b.x * scale - 3, 2) && near(info.h.width, b.w * scale + 6, 3), `highlight at ${info.h.left - r.left}px, want ${(b.x * scale - 3).toFixed(1)}`);
      await shot('showbox');
      await page.waitForFunction(() => !document.querySelector('.pdfp-hl'), null, { timeout: 3000 });
      return `page ${b.page}, page indicator ${after.page}`;
    });

    await check('a new version keeps the reading position with no blank pages after the swap', async () => {
      await page.evaluate(() => {
        const s = document.querySelector('.pdfp-scroll');
        const p2 = document.querySelector('.pdfp-page[data-page="2"]');
        s.scrollTop = p2.offsetTop + p2.offsetHeight * 0.37;
      });
      await page.waitForTimeout(150);
      const before = await scrollState(page);
      await page.evaluate(() => {
        document.querySelector('.pdfp-pages').dataset.old = '1';
        window.__pdf.bump();
      });
      await page.waitForFunction(() => document.querySelector('.pdfp-pages') && !document.querySelector('.pdfp-pages[data-old]'), null, { timeout: 15_000 });
      await page.waitForTimeout(100);
      const after = await scrollState(page);
      assert(near(after.top, before.top, 2), `scrollTop ${before.top} -> ${after.top}`);
      assert(after.page === before.page, `page ${before.page} -> ${after.page}`);
      const blank = await page.evaluate(() => {
        const s = document.querySelector('.pdfp-scroll').getBoundingClientRect();
        return [...document.querySelectorAll('.pdfp-page')].filter((p) => {
          const r = p.getBoundingClientRect();
          return r.bottom > s.top && r.top < s.bottom && !p.querySelector('canvas');
        }).length;
      });
      assert(blank === 0, `${blank} visible pages without a canvas right after the swap`);
      return `scrollTop ${before.top.toFixed(0)} -> ${after.top.toFixed(0)}, page ${after.page}`;
    });
    await shot('reloaded');

    await check('a page refresh restores the reading position (sessionStorage)', async () => {
      await page.evaluate(() => window.__pdf.handle.showBox(window.__pdf.boxes.late));
      await page.waitForTimeout(900);
      const before = await scrollState(page);
      await page.reload();
      await waitRendered(page, Number(before.page));
      await page.waitForTimeout(150);
      const after = await scrollState(page);
      assert(after.page === before.page && near(after.top, before.top, 3), `page ${before.page}@${before.top} -> ${after.page}@${after.top}`);
      return `page ${after.page}`;
    });

    await check('zoom keys: + zooms in around the top line, 0 fits the width again', async () => {
      await page.focus('.pdfp-scroll');
      const before = await page.evaluate(() => ({ w: document.querySelector('.pdfp-page').getBoundingClientRect().width, pct: document.querySelector('.pdfp-pct').textContent }));
      const pos0 = await scrollState(page);
      await page.keyboard.press('+');
      await page.keyboard.press('+');
      await page.waitForTimeout(400);
      const zoomed = await page.evaluate(() => ({ w: document.querySelector('.pdfp-page').getBoundingClientRect().width, pct: document.querySelector('.pdfp-pct').textContent, fit: document.querySelector('.pdfp-btn[aria-pressed]').getAttribute('aria-pressed') }));
      const pos1 = await scrollState(page);
      assert(zoomed.w > before.w * 1.1, `width ${before.w} -> ${zoomed.w}`);
      assert(zoomed.fit === 'false', 'still fit');
      assert(pos1.page === pos0.page, `page changed ${pos0.page} -> ${pos1.page}`);
      const sw = await page.evaluate(() => document.querySelector('.pdfp-scroll').scrollWidth);
      assert(zoomed.w + 24 <= pos1.w || sw >= zoomed.w + 24 - 1, `page ${zoomed.w}px wider than the pane but scrollWidth ${sw}`);
      await shot('zoomed');
      // Click conversion still exact when zoomed and scrolled horizontally.
      const r = await pageRect(page, Number(pos1.page));
      const scale = r.width / 612;
      const n0 = await page.evaluate(() => window.__pdf.calls.length);
      const cx = Math.max(r.left + 5, 700);
      const cy = Math.max(r.top + 5, 300);
      await page.mouse.click(cx, cy);
      await page.waitForFunction((n) => window.__pdf.calls.length > n, n0);
      const c = await page.evaluate(() => window.__pdf.calls.at(-1));
      assert(near(c.x, (cx - r.left) / scale, 0.6) && near(c.y, (cy - r.top) / scale, 0.6), `zoomed click ${c.x},${c.y}`);
      await page.focus('.pdfp-scroll');
      await page.keyboard.press('0');
      await page.waitForTimeout(300);
      const fit = await page.evaluate(() => document.querySelector('.pdfp-btn[aria-pressed]').getAttribute('aria-pressed'));
      assert(fit === 'true', 'fit width not restored');
      return `${before.pct} -> ${zoomed.pct} -> fit`;
    });

    await check('Ctrl+wheel zooms around the pointer', async () => {
      const r = await pageRect(page, 1);
      await page.mouse.move(r.left + r.width / 2, 400);
      const pct0 = await page.textContent('.pdfp-pct');
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -240);
      await page.keyboard.up('Control');
      await page.waitForTimeout(300);
      const pct1 = await page.textContent('.pdfp-pct');
      assert(parseInt(pct1) > parseInt(pct0), `${pct0} -> ${pct1}`);
      await page.focus('.pdfp-scroll');
      await page.keyboard.press('0');
      await page.waitForTimeout(200);
      return `${pct0} -> ${pct1}`;
    });

    await check('stale: the last PDF stays while a compile runs, with a badge', async () => {
      await page.evaluate(() => window.__pdf.setCompile('running'));
      await page.waitForSelector('.pdfp-badge.is-busy', { timeout: 2000 });
      const n = await page.locator('.pdfp-page canvas').count();
      assert(n > 0, 'pages gone while compiling');
      await shot('stale');
      await page.evaluate(() => window.__pdf.setCompile('error'));
      await page.waitForSelector('.pdfp-badge.is-warn', { timeout: 2000 });
      const text = await page.textContent('.pdfp-badge');
      await page.evaluate(() => window.__pdf.setCompile('ok'));
      return text;
    });

    await check('error: a broken URL keeps the old PDF and offers retry; on a cold start it shows the message', async () => {
      await page.evaluate(() => {
        window.__pdf.setBroken(true);
        window.__pdf.bump();
      });
      await page.waitForSelector('.pdfp-badge.is-error', { timeout: 10_000 });
      assert((await page.locator('.pdfp-page canvas').count()) > 0, 'old pages dropped on error');
      await page.evaluate(() => window.__pdf.setVersion(null));
      await page.waitForSelector('.pdfp[data-state="empty"]', { timeout: 3000 });
      await page.evaluate(() => window.__pdf.setVersion(7));
      await page.waitForSelector('.pdfp[data-state="error"] .pdfp-message', { timeout: 10_000 });
      const msg = await page.textContent('.pdfp-message');
      await shot('error');
      await page.evaluate(() => window.__pdf.setBroken(false));
      await page.click('.pdfp-action');
      await page.waitForSelector('.pdfp[data-state="ready"]', { timeout: 10_000 });
      return msg.replace(/\s+/g, ' ').trim();
    });

    await check('empty state: "Compile to see the PDF" with a Compile button that works', async () => {
      await page.evaluate(() => window.__pdf.setVersion(null));
      await page.waitForSelector('.pdfp[data-state="empty"]', { timeout: 3000 });
      const title = await page.textContent('.pdfp-title');
      assert(/Compile to see the PDF/.test(title), title);
      await shot('empty');
      await page.click('.pdfp-action');
      await page.waitForSelector('.pdfp-spinner', { timeout: 2000 });
      await page.waitForSelector('.pdfp[data-state="ready"]', { timeout: 10_000 });
      return title;
    });

    await check('loading state on a slow first load', async () => {
      await page.route('**/harness/.out/long.pdf*', async (route) => {
        await new Promise((r) => setTimeout(r, 1200));
        await route.continue();
      });
      await page.evaluate(() => window.__pdf.setVersion(null));
      await page.evaluate(() => window.__pdf.setVersion(20));
      await page.waitForSelector('.pdfp[data-state="loading"] .pdfp-spinner', { timeout: 2000 });
      await shot('loading');
      await page.waitForSelector('.pdfp[data-state="ready"]', { timeout: 10_000 });
      await page.unroute('**/harness/.out/long.pdf*');
    });

    await check('dark mode', async () => {
      await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
      await page.evaluate(() => window.__pdf.handle.showBox(JSON.parse(JSON.stringify(window.__pdf.boxes.intro))));
      await page.waitForTimeout(400);
      const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.pdfp')).backgroundColor);
      await shot('dark');
      assert(bg !== 'rgb(242, 240, 235)', `pane background ${bg} is the light one`);
      await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
      return bg;
    });

    await check('keyboard: toolbar buttons are reachable and labelled', async () => {
      const labels = await page.evaluate(() => [...document.querySelectorAll('.pdfp-bar button')].map((b) => b.getAttribute('aria-label') || b.textContent));
      assert(labels.length >= 3 && labels.every(Boolean), JSON.stringify(labels));
      await page.focus('.pdfp-pageinput');
      await page.keyboard.type('3');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
      const s = await scrollState(page);
      assert(s.page === '3', `page input went to ${s.page}`);
      await page.keyboard.press('Shift+Tab');
      return labels.join(' | ');
    });
  } finally {
    await ctx.close();
  }

  // devicePixelRatio 2: canvases have twice the pixels, clicks still in points.
  const ctx2 = await browser.newContext({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 });
  const p2 = await ctx2.newPage();
  try {
    await check('devicePixelRatio 2: crisp canvas, same click coordinates', async () => {
      await p2.goto(`${BASE}/harness/pdf.html?doc=main&width=480`);
      await waitRendered(p2, 1);
      const info = await p2.evaluate(() => {
        const p = document.querySelector('.pdfp-page[data-page="1"]');
        return { css: p.getBoundingClientRect().width, px: p.querySelector('canvas').width };
      });
      assert(near(info.px, info.css * 2, 2), `canvas ${info.px}px for ${info.css} CSS px`);
      const r = await pageRect(p2, 1);
      await p2.mouse.click(r.left + 30, r.top + 40);
      await p2.waitForFunction(() => window.__pdf.calls.length >= 1);
      const c = await p2.evaluate(() => window.__pdf.calls.at(-1));
      const scale = r.width / 612;
      assert(near(c.x, 30 / scale, 0.6) && near(c.y, 40 / scale, 0.6), `got ${c.x},${c.y}`);
      return `${info.px}px canvas for ${info.css.toFixed(0)} CSS px; click ${c.x},${c.y}`;
    });
  } finally {
    await ctx2.close();
    await browser.close();
    server?.kill();
    rmSync(built.tmp, { recursive: true, force: true });
  }

  const relevant = errors.filter((e) => !/missing\.pdf|404|Failed to load resource|Unexpected server response|ResponseException/i.test(e));
  log(relevant.length === 0, 'no unexpected console errors', relevant.slice(0, 3).join(' | '));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed; screenshots in ${SHOTS}`);
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(2);
  },
);
