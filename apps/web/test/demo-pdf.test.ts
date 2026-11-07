/** The browser demo's example PDF: the mock "compiles" by showing it, with approximate SyncTeX over the current text. */
import { describe, expect, it } from 'vitest';
import tex from '../../../fixtures/canto-demo/tex/main.tex?raw';
import { MockApiClient } from '../src/api/mock';
import { createLargeMock } from '../src/api/mockLarge';
import { DEMO_PDF_URL, demoForward, demoInverse, demoSynctexAvailable } from '../src/api/mockPdf';

const lineOf = (text: string, prefix: string) => text.split('\n').findIndex((l) => l.startsWith(prefix)) + 1;

describe('demo SyncTeX table', () => {
  it('loads the committed table and finds a box for a prose line', () => {
    expect(demoSynctexAvailable()).toBe(true);
    const b = demoForward(tex, lineOf(tex, 'The test set holds'));
    expect(b).not.toBeNull();
    expect(b!.page).toBe(1);
    expect(b!.w).toBeGreaterThan(20);
  });

  it('forward search follows a line that moved, and falls back to the line above for a new line', () => {
    const line = lineOf(tex, 'The test set holds');
    const moved = tex.replace('\\section{Introduction}', 'A new line.\n\\section{Introduction}');
    expect(demoForward(moved, line + 1)).toEqual(demoForward(tex, line));
    const added = tex.replace('The test set holds 8,710 targets.', 'The test set holds 8,710 targets.\nA sentence the fixture never had.');
    expect(demoForward(added, line + 1)).toEqual(demoForward(tex, line));
  });

  it('inverse search: a click inside a line box gives that line of the current text', () => {
    const line = lineOf(tex, 'The test set holds');
    const b = demoForward(tex, line)!;
    const hit = demoInverse(tex, b.page, b.x + 5, b.y + b.h / 2);
    expect(tex.split('\n')[hit! - 1]).toMatch(/^The test set holds/);
    // the same line after the author added lines above it
    const moved = tex.replace('\\section{Introduction}', 'One.\nTwo.\n\\section{Introduction}');
    const hit2 = demoInverse(moved, b.page, b.x + 5, b.y + b.h / 2);
    expect(moved.split('\n')[hit2! - 1]).toMatch(/^The test set holds/);
    // a line the author changed (and lines added above it): counted from the nearest unchanged line
    const edited = moved.replace('holds 8,710 targets', 'holds 9,000 targets');
    const hit3 = demoInverse(edited, b.page, b.x + 5, b.y + b.h / 2);
    expect(edited.split('\n')[hit3! - 1]).toMatch(/^The test set holds 9,000/);
  });

  it('inverse search never lands in the preamble, and a click far from text finds nothing', () => {
    const title = demoForward(tex, lineOf(tex, '\\title'))!;
    const hit = demoInverse(tex, 1, title.x + 10, title.y + title.h / 2);
    expect(hit).toBeGreaterThan(lineOf(tex, '\\begin{document}'));
    expect(demoInverse(tex, 1, 5, 5)).toBeNull();
    expect(demoInverse(tex, 2, 300, 300)).toBeNull();
  });
});

describe('MockApiClient compile', () => {
  it('shows the example PDF: pdfVersion increments, the log says it does not follow edits', async () => {
    const api = new MockApiClient({ latencyMs: 0, restLatencyMs: 0, jobStepMs: 5 });
    await api.ready();
    const seen: Array<{ state: string; pdfVersion: number | null; logTail: string }> = [];
    api.on('compile.status', (m) => seen.push(m));
    await api.compile();
    await new Promise((r) => setTimeout(r, 40));
    await api.compile();
    await new Promise((r) => setTimeout(r, 40));
    const ok = seen.filter((m) => m.state === 'ok');
    expect(ok.map((m) => m.pdfVersion)).toEqual([1, 2]);
    expect(ok[0]!.logTail).toMatch(/Example PDF: the browser demo has no LaTeX/);
    expect(api.pdfUrl(1)).toBe(DEMO_PDF_URL);
    const box = await api.synctexForward('main.tex', lineOf(tex, 'The test set holds'));
    expect(box?.page).toBe(1);
    const back = await api.synctexInverse(box!.page, box!.x + 5, box!.y + box!.h / 2);
    expect(back).toEqual({ file: 'main.tex', line: lineOf(tex, 'The test set holds') });
  });

  it('no SyncTeX before the first compile, and no example PDF for another fixture', async () => {
    const api = new MockApiClient({ latencyMs: 0, restLatencyMs: 0, jobStepMs: 5 });
    await api.ready();
    expect(await api.synctexForward('main.tex', 30)).toBeNull();
    const large = createLargeMock({ latencyMs: 0, restLatencyMs: 0, jobStepMs: 5 });
    await large.ready();
    const seen: Array<number | null> = [];
    large.on('compile.status', (m) => seen.push(m.pdfVersion));
    await large.compile();
    await new Promise((r) => setTimeout(r, 40));
    expect(seen.every((v) => v === null)).toBe(true);
    expect(large.pdfUrl(1)).toBe('about:blank');
  });
});
