/**
 * Figure plan (consistency/figures.ts): floats across \input files with numbers, labels, caption
 * sentences, first citation and citation order, the caption-anatomy checklist and the outline's
 * claim -> figure map.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FigurePlanReport } from '../src/api';
import { figurePlan } from '../src/consistency/figures';
import { orderUnits, projectFileOrder, type ConsistencyUnit } from '../src/consistency/common';
import { segment } from '../src/latex/segment';
import { emptyOutline, type FigureEntry, type Outline } from '../src/schemas';

const PERF_SLACK = process.env.CI ? 3 : 1;
const FX = (p: string): string => fileURLToPath(new URL(`../../../fixtures/${p}`, import.meta.url));
const unitsOf = (file: string, text: string): ConsistencyUnit[] =>
  segment(text).sentences.map((s, i) => ({ id: `${file}#${i}`, file, line: s.line, part: s.part, kind: s.kind, sectionId: s.sectionId, text: s.text, start: s.start, end: s.end }));
const doc = (body: string): string => `\\documentclass{revtex4-2}\n\\begin{document}\n${body}\n\\end{document}\n`;
const withClaims = (pairs: Array<[string, string]>): Outline => ({ ...emptyOutline(), claimFigures: pairs.map(([claimId, figureId]) => ({ claimId, figureId })) });

const CANTO = readFileSync(FX('canto-demo/tex/main.tex'), 'utf8');
const LARGE_FILES = ['main.tex', 'sections/intro.tex', 'sections/method.tex', 'sections/results.tex', 'sections/appendix.tex'];
const LARGE: Record<string, string> = Object.fromEntries(LARGE_FILES.map((f) => [f, readFileSync(FX(`large-multifile/tex/${f}`), 'utf8')]));

describe('figurePlan on fixtures/canto-demo', () => {
  const units = unitsOf('main.tex', CANTO);
  const r = figurePlan([{ file: 'main.tex', text: CANTO }], units, withClaims([['G1', 'fig:eff'], ['G2', 'fig:roc']]), { claims: [{ claimId: 'G1', text: 'The tracker finds more targets', evidence: [], citations: [], qualification: '', status: 'supported', sentenceIds: [], section: null, move: null }] });

  it('lists the figure and the table with their captions and first citations', () => {
    expect(() => FigurePlanReport.parse(r)).not.toThrow();
    expect(r.floats.map((f) => [f.kind, f.number, f.label, f.refCount])).toEqual([
      ['figure', 1, 'fig:eff', 1],
      ['table', 1, 'tab:eff', 1],
    ]);
    const fig = r.floats[0]!;
    expect(fig.captionSentenceIds).toHaveLength(3);
    for (const id of fig.captionSentenceIds) expect(units.find((u) => u.id === id)!.kind).toBe('caption');
    expect(fig.firstRef!.text).toMatch(/^On the isolated gun particles, the tracker finds 2\.32/);
    expect(fig.firstRef!.sentenceId).toBe(units.find((u) => u.text.startsWith('On the isolated gun particles'))!.id);
    expect(r.floats[1]!.firstRef!.part).toBe('app');
    expect(fig.citeRank).toBe(1);
  });

  it('checks the caption anatomy', () => {
    const fig = Object.fromEntries(r.floats[0]!.checklist.map((c) => [c.key, c.status]));
    expect(fig).toEqual({ quantity: 'ok', conditions: 'ok', encoding: 'ok', panels: 'na', takeaway: 'ok' });
    expect(r.floats[0]!.checklist.find((c) => c.key === 'encoding')!.evidence).toBe('Solid');
    const tab = Object.fromEntries(r.floats[1]!.checklist.map((c) => [c.key, c.status]));
    expect(tab).toEqual({ quantity: 'na', conditions: 'ok', encoding: 'na', panels: 'na', takeaway: 'missing' });
    expect(r.flags.find((f) => f.kind === 'caption_anatomy')).toMatchObject({ label: 'tab:eff', severity: 'info', heuristic: true });
  });

  it('maps claims to figures', () => {
    expect(r.claims).toEqual([
      { claimId: 'G1', figureId: 'fig:eff', label: 'fig:eff', found: true, cited: true, claimText: 'The tracker finds more targets' },
      { claimId: 'G2', figureId: 'fig:roc', label: null, found: false, cited: false, claimText: null },
    ]);
    expect(r.floats[0]!.claimIds).toEqual(['G1']);
    expect(r.flags.filter((f) => f.kind === 'claim_figure_missing').map((f) => f.label)).toEqual(['fig:roc']);
  });
});

describe('figurePlan on fixtures/large-multifile', () => {
  const order = projectFileOrder('main.tex', LARGE);
  const units = orderUnits(LARGE_FILES.flatMap((f) => unitsOf(f, LARGE[f]!)), order);
  const files = LARGE_FILES.map((f) => ({ file: f, text: LARGE[f]! }));

  it('numbers 12 figures and 4 tables across the \\input files, every one cited and captioned', () => {
    const t0 = performance.now();
    const r = figurePlan(files, units, null, { order });
    expect(performance.now() - t0).toBeLessThan(400 * PERF_SLACK);
    expect(r.floats.filter((f) => f.kind === 'figure').map((f) => f.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(r.floats.filter((f) => f.kind === 'table')).toHaveLength(4);
    expect(r.floats.map((f) => f.file)).toEqual([...r.floats.map((f) => f.file)].sort((a, b) => LARGE_FILES.indexOf(a) - LARGE_FILES.indexOf(b)));
    for (const f of r.floats) {
      expect(f.refCount).toBeGreaterThan(0);
      expect(f.captionSentenceIds.length).toBeGreaterThan(0);
      expect(f.label).not.toBeNull();
    }
    expect(r.flags.map((f) => f.kind).filter((k) => k === 'float_uncited' || k === 'float_no_label' || k === 'float_no_caption')).toEqual([]);
  });

  it('flags the figures the introduction cites before the earlier-numbered ones', () => {
    const r = figurePlan(files, units, null, { order });
    const out = r.floats.filter((f) => f.outOfOrder).map((f) => f.label);
    expect(out).toEqual(['fig:eff_disp', 'fig:pileup']);
    const eff = r.floats.find((f) => f.label === 'fig:eff_disp')!;
    expect(eff.citeRank).toBe(1);
    expect(eff.firstRef!.file).toBe('sections/intro.tex');
    expect(r.flags.find((f) => f.kind === 'float_order' && f.label === 'fig:eff_disp')!.message).toMatch(/Fig\. 4 \(fig:eff_disp\) is cited before Fig\. 1, Fig\. 2, Fig\. 3/);
  });

  it('a multi-panel caption with a panel map passes; the claim map resolves figure entries', () => {
    const r = figurePlan(files, units, withClaims([['H1', 'eff_disp'], ['H2', 'fig-pileup-entry']]), {
      order,
      figures: [{ figureId: 'fig-pileup-entry', label: 'fig:pileup', path: null, sha256: null, producerScript: null, claimIds: [], captionSentenceIds: [], status: 'exists', job: '' } satisfies FigureEntry],
    });
    const det = r.floats.find((f) => f.label === 'fig:detector')!;
    expect(det.checklist.find((c) => c.key === 'panels')).toMatchObject({ status: 'ok', evidence: 'left, right' });
    const disp = r.floats.find((f) => f.label === 'fig:eff_disp')!;
    expect(disp.checklist.find((c) => c.key === 'panels')!.status).toBe('ok');
    expect(r.claims.map((c) => [c.claimId, c.label, c.found, c.cited])).toEqual([
      ['H1', 'fig:eff_disp', true, true],
      ['H2', 'fig:pileup', true, true],
    ]);
  });
});

describe('figurePlan rules', () => {
  const SRC = doc(
    [
      'Figure~\\ref{fig:b} shows the second result first.',
      '% Figure~\\ref{fig:c} is cited only in a comment.',
      'We also refer to Figs.~\\cref{fig:a,fig:b}.',
      '\\begin{figure}\\includegraphics{a.pdf}\\caption{Efficiency versus displacement. Solid: ours. A higher curve is better.}\\label{fig:a}\\end{figure}',
      '\\begin{figure*}\\includegraphics{b1.pdf}\\includegraphics{b2.pdf}\\caption{Fake rate for both trackers, see also Fig.~\\ref{fig:b}.}\\label{fig:b}\\end{figure*}',
      '\\begin{figure}\\begin{subfigure}{0.5\\linewidth}\\includegraphics{c1.pdf}\\end{subfigure}\\begin{subfigure}{0.5\\linewidth}\\includegraphics{c2.pdf}\\end{subfigure}\\caption{(a) Efficiency and (b) purity versus $p_T$ for the test events; dashed lines show the baseline, which is lower.}\\label{fig:c}\\end{figure}',
      '\\begin{table}\\begin{tabular}{c}1\\end{tabular}\\end{table}',
    ].join('\n\n'),
  );
  const units = unitsOf('main.tex', SRC);
  const r = figurePlan([{ file: 'main.tex', text: SRC }], units, null);

  it('counts citations outside comments and outside the float itself; \\cref lists count for each label', () => {
    const by = Object.fromEntries(r.floats.map((f) => [f.label ?? `#${f.number}`, f]));
    expect(by['fig:a']!.refCount).toBe(1);
    expect(by['fig:b']!.refCount).toBe(2);
    expect(by['fig:c']!.refCount).toBe(0);
    expect(r.flags.filter((f) => f.kind === 'float_uncited').map((f) => f.label)).toEqual(['fig:c']);
  });

  it('flags order, missing label and missing caption', () => {
    expect(r.floats.find((f) => f.label === 'fig:b')!).toMatchObject({ number: 2, citeRank: 1, outOfOrder: true });
    expect(r.floats.find((f) => f.label === 'fig:a')!).toMatchObject({ number: 1, citeRank: 2, outOfOrder: false });
    const kinds = r.flags.map((f) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(['float_order', 'float_no_label', 'float_no_caption']));
    expect(r.floats.find((f) => f.kind === 'table')!.checklist).toEqual([]);
  });

  it('panel map: several graphics without one is missing; (a)/(b) in the caption is ok', () => {
    const b = r.floats.find((f) => f.label === 'fig:b')!;
    expect(b.graphics).toEqual(['b1.pdf', 'b2.pdf']);
    expect(Object.fromEntries(b.checklist.map((c) => [c.key, c.status]))).toEqual({ quantity: 'missing', conditions: 'missing', encoding: 'missing', panels: 'missing', takeaway: 'missing' });
    const c = r.floats.find((f) => f.label === 'fig:c')!;
    expect(Object.fromEntries(c.checklist.map((x) => [x.key, x.status]))).toEqual({ quantity: 'ok', conditions: 'ok', encoding: 'ok', panels: 'ok', takeaway: 'ok' });
  });

  it('works from segmentations alone (no units: captions without sentence ids)', () => {
    const r2 = figurePlan([{ file: 'main.tex', text: SRC, seg: segment(SRC) }], [], null);
    expect(r2.floats.map((f) => f.caption)).toEqual(r.floats.map((f) => f.caption));
    expect(r2.floats.every((f) => f.captionSentenceIds.length === 0)).toBe(true);
    expect(r2.floats[0]!.firstRef).toMatchObject({ sentenceId: null, line: expect.any(Number) });
  });

  it('never throws on odd input', () => {
    expect(() => figurePlan([], [], null)).not.toThrow();
    expect(() => figurePlan([{ file: 'x.tex', text: '\\begin{figure}\\caption{unclosed \\label{fig:x' }], [], withClaims([['c', 'fig:x']]))).not.toThrow();
    expect(() => figurePlan(null as never, null as never, undefined)).not.toThrow();
  });
});
