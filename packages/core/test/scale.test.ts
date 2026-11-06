/**
 * Scale: segmentation and unit assignment on a real-size, multi-file paper (fixtures/large-multifile,
 * five files, ~440 sentences) and on long English LaTeX documents that ship with TeX Live (read-only
 * inputs, skipped when TeX Live is not installed).
 *
 * Checks: budgets per file (segment, import, one local re-assignment), the invariants every consumer
 * relies on (sorted, non-overlapping, trimmed spans inside the text), id stability through a seeded
 * typing session, linear growth (a document four times longer costs about four times as much, not
 * sixteen), and a co-author edit re-anchored with nearly every id kept.
 *
 * Timing: wall-clock, best or median of several runs (other processes can only ADD time), with
 * PERF_SLACK = 3 on CI.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ChangeSet, Text } from '@codemirror/state';
import { assignUnits, changedRanges, mapUnits, reanchor, type AssignResult } from '../src/anchor/units';
import { segment, type Segmentation } from '../src/latex/segment';
import type { ChangeAnnotation } from '../src/api';
import type { SentenceUnit } from '../src/schemas';

const PERF_SLACK = process.env.CI ? 3 : 1;
const FX = fileURLToPath(new URL('../../../fixtures/large-multifile/tex/', import.meta.url));
const FILES = ['main.tex', 'sections/intro.tex', 'sections/method.tex', 'sections/results.tex', 'sections/appendix.tex'];
const SRC: Record<string, string> = Object.fromEntries(FILES.map((f) => [f, readFileSync(join(FX, f), 'utf8')]));
const NOW = '2026-11-06T12:00:00.000Z';

const IMPORT: ChangeAnnotation = {
  origin: 'import',
  sentenceIds: [],
  state: 'human',
  model: null,
  promptHash: null,
  instruction: null,
  lang: null,
  intentNote: null,
  factIds: [],
  citeKeys: [],
  move: null,
  requestId: null,
};

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bestOf(n: number, fn: () => unknown): number {
  let min = Infinity;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    fn();
    min = Math.min(min, performance.now() - t0);
  }
  return min;
}

const percentile = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};

function importFile(file: string, text: string, seg: Segmentation = segment(text)): AssignResult {
  return assignUnits({ file, text, seg, prev: [], lastVersion: () => undefined, lastAiVersion: () => undefined, changeSource: 'external', annotation: IMPORT, annotatedRange: { from: 0, to: text.length }, now: NOW });
}

/**
 * Every consumer (decorations, the push guard, SyncTeX lines) relies on these: spans inside the text,
 * trimmed, in document order; a footnote or caption unit may nest inside its host sentence (the host
 * keeps the masked \footnote{..} in its span) but spans never partially overlap.
 */
function checkInvariants(seg: Segmentation, text: string): void {
  const stack: Array<{ start: number; end: number }> = [];
  let lastStart = -1;
  for (const s of seg.sentences) {
    expect(s.start).toBeGreaterThanOrEqual(0);
    expect(s.end).toBeLessThanOrEqual(text.length);
    expect(s.end).toBeGreaterThan(s.start);
    expect(s.start).toBeGreaterThanOrEqual(lastStart);
    lastStart = s.start;
    while (stack.length && stack[stack.length - 1]!.end <= s.start) stack.pop();
    const host = stack[stack.length - 1];
    if (host) expect(s.end, `partial overlap at ${s.start}: ${text.slice(s.start, s.start + 60)}`).toBeLessThanOrEqual(host.end);
    stack.push(s);
    const slice = text.slice(s.start, s.end);
    expect(slice).toBe(slice.trim());
  }
}

describe('scale: the large multi-file fixture', () => {
  it('segments every file within budget, with valid spans, ~440 sentences in all', () => {
    let total = 0;
    const kinds: Record<string, number> = {};
    for (const f of FILES) {
      const text = SRC[f]!;
      const seg = segment(text);
      checkInvariants(seg, text);
      for (const s of seg.sentences) kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
      total += seg.sentences.length;
      // section files are fragments (no \begin{document}); main.tex is a full document
      expect(seg.fragment).toBe(f !== 'main.tex');
      expect(bestOf(5, () => segment(text))).toBeLessThan(15 * PERF_SLACK);
    }
    expect(total).toBeGreaterThanOrEqual(400);
    expect(kinds.prose).toBeGreaterThanOrEqual(370);
    expect(kinds.caption).toBeGreaterThanOrEqual(16);
    expect(kinds.footnote).toBeGreaterThanOrEqual(8);
  });

  it('keeps the parts of the abstract, the introduction and the appendix', () => {
    const main = segment(SRC['main.tex']!);
    expect(main.sentences.some((s) => s.part === 'abstract')).toBe(true);
    expect(main.sentences.some((s) => s.part === 'concl')).toBe(true);
    const intro = segment(SRC['sections/intro.tex']!);
    expect(intro.sentences.filter((s) => s.kind === 'prose').every((s) => s.part === 'intro')).toBe(true);
    // the cross-file labels the section files define (the server merges them for the gate)
    const labels = FILES.flatMap((f) => segment(SRC[f]!).labels);
    for (const l of ['sec:intro', 'sec:method', 'sec:results', 'app:stat', 'fig:eff_disp', 'tab:species', 'eq:eff']) expect(labels).toContain(l);
  });

  it('imports every file with unique ids and every unit holding its own text', () => {
    const ids = new Set<string>();
    for (const f of FILES) {
      const text = SRC[f]!;
      const r = importFile(f, text);
      for (const u of r.units) {
        expect(ids.has(u.id)).toBe(false);
        ids.add(u.id);
        expect(u.file).toBe(f);
        expect(u.state).toBe('human');
      }
      expect(bestOf(3, () => importFile(f, text))).toBeLessThan(40 * PERF_SLACK);
    }
    expect(ids.size).toBeGreaterThanOrEqual(400);
  });

  it('types 300 seeded keystrokes into sections/results.tex: every pass within budget, no id churn', () => {
    const file = 'sections/results.tex';
    let text = SRC[file]!;
    let units = importFile(file, text).units;
    const ids0 = units.map((u) => u.id);
    const rnd = mulberry32(42);
    const times: number[] = [];
    const prose = units.filter((u) => u.kind === 'prose');
    for (let k = 0; k < 300; k++) {
      // a letter typed inside a word of a random prose sentence (a typo fix, an inserted word...)
      const want = prose[Math.floor(rnd() * prose.length)]!.id;
      const u = units.find((x) => x.id === want)!;
      const slice = text.slice(u.start, u.end);
      const spaces = [...slice.matchAll(/ [a-z]/g)].map((m) => m.index!);
      if (!spaces.length) continue;
      const at = u.start + spaces[Math.floor(rnd() * spaces.length)]! + 1;
      const cs = ChangeSet.of({ from: at, insert: 'abcdefghij'[k % 10]! }, text.length, '\n');
      const next = cs.apply(Text.of(text.split('\n'))).toString();
      const t0 = performance.now();
      const prev = mapUnits(units, cs, next);
      const seg = segment(next);
      const r = assignUnits({ file, text: next, seg, prev, lastVersion: () => undefined, lastAiVersion: () => undefined, dirty: changedRanges(cs), changeSource: 'local', annotation: null, now: NOW });
      times.push(performance.now() - t0);
      text = next;
      units = r.units;
      expect(r.removed).toEqual([]);
      // the edited sentence (and the footnote it hosts, when the letter landed in one), plus its
      // neighbours when their context hash changed
      expect(r.upserts.length).toBeLessThanOrEqual(4);
    }
    expect(units.map((u) => u.id)).toEqual(ids0);
    // one full pass (map + segment + assign) per debounced batch of keystrokes
    expect(percentile(times, 0.5)).toBeLessThan(10 * PERF_SLACK);
    expect(percentile(times, 0.95)).toBeLessThan(25 * PERF_SLACK);
  });

  it('grows linearly: four times the text costs well under sixteen times as much', () => {
    // all section bodies concatenated, then repeated with distinct labels, as one long fragment
    const body = FILES.slice(1).map((f) => SRC[f]!).join('\n\n');
    const times = (reps: number) => {
      const text = Array.from({ length: reps }, (_, r) => body.replace(/\\label\{([^}]*)\}/g, `\\label{$1-${r}}`)).join('\n\n');
      const seg = segment(text);
      const imported = importFile('big.tex', text, seg).units;
      const at = text.length >> 1;
      const insertAt = text.indexOf(' the ', at) + 1;
      const cs = ChangeSet.of({ from: insertAt, insert: 'x' }, text.length, '\n');
      const next = cs.apply(Text.of(text.split('\n'))).toString();
      const run = () => {
        const prev = mapUnits(imported, cs, next);
        const s = segment(next);
        assignUnits({ file: 'big.tex', text: next, seg: s, prev, lastVersion: () => undefined, lastAiVersion: () => undefined, dirty: changedRanges(cs), changeSource: 'local', annotation: null, now: NOW });
      };
      run();
      return { ms: bestOf(5, run), units: imported.length };
    };
    const one = times(1);
    const four = times(4);
    expect(four.units).toBeGreaterThanOrEqual(4 * one.units - 4);
    // linear would be 4x; allow noise and constant costs, but not quadratic (16x)
    expect(four.ms / Math.max(one.ms, 0.5)).toBeLessThan(8);
    expect(four.ms).toBeLessThan(60 * PERF_SLACK);
  });

  it('re-anchors a co-author edit of sections/method.tex keeping >= 95% of the ids', () => {
    const file = 'sections/method.tex';
    const old = SRC[file]!;
    const imported = importFile(file, old).units;
    // five sentences edited, one inserted, one deleted, as an Overleaf co-author would
    let next = old
      .replace('Graph construction connects each hit', 'Graph construction links each hit')
      .replace('The edge classifier is an interaction network', 'The edge classifier is a graph interaction network')
      .replace('No test event influences any choice of the pipeline.', 'No test event influences any choice of the pipeline, by construction.')
      .replace('This criterion is called double majority.', '')
      .replace('Edges with a score above one half are kept.', 'Edges with a score above one half are kept. Lower scores are dropped before track building.')
      .replace('The node features are', 'The node features are, as usual,');
    expect(next).not.toBe(old);
    next = next.replace('Hits are recorded as three-dimensional space points', 'Hits are stored as three-dimensional space points');
    const seg = segment(next);
    let r: AssignResult | null = null;
    const ms = bestOf(3, () => {
      r = reanchor(old, next, seg, { file, prev: imported, lastVersion: () => undefined, lastAiVersion: () => undefined, now: NOW });
    });
    const res = r! as AssignResult;
    const before = new Set(imported.map((u: SentenceUnit) => u.id));
    const kept = res.units.filter((u) => before.has(u.id)).length;
    expect(kept / imported.length).toBeGreaterThanOrEqual(0.95);
    expect(res.report.created.length).toBeGreaterThanOrEqual(1);
    expect(ms).toBeLessThan(100 * PERF_SLACK);
  });
});

/* ------------------------------------------------------------------------------------ */
/* Real LaTeX from TeX Live (read-only inputs)                                           */
/* ------------------------------------------------------------------------------------ */

const TEXMF = ['/usr/share/texlive/texmf-dist', '/usr/local/texlive/texmf-dist', '/opt/texlive/texmf-dist'].find((d) => existsSync(d));
/** Long English prose documents that TeX Live ships as LaTeX source. */
function texLiveDocs(): string[] {
  if (!TEXMF) return [];
  const out: string[] = [];
  const koma = join(TEXMF, 'source/latex/koma-script/doc');
  if (existsSync(koma)) for (const f of readdirSync(koma).sort()) if (/-en\.tex$/.test(f) && statSync(join(koma, f)).size > 20_000) out.push(join(koma, f));
  for (const rel of ['tex/latex/base/lppl.tex', 'doc/latex/amsmath/amsldoc.tex', 'doc/latex/base/usrguide.tex', 'doc/latex/base/clsguide.tex', 'doc/latex/lshort-english/lshort.tex']) if (existsSync(join(TEXMF, rel))) out.push(join(TEXMF, rel));
  return out;
}
const REAL = texLiveDocs();

describe.skipIf(REAL.length === 0)('scale: long real LaTeX documents from TeX Live (read-only)', () => {
  it(`segments ${REAL.length} documents without failing, with valid spans and in linear time`, () => {
    let bytes = 0;
    let sentences = 0;
    let ms = 0;
    for (const p of REAL) {
      const text = readFileSync(p, 'utf8');
      const seg = segment(text);
      checkInvariants(seg, text);
      const t = bestOf(2, () => segment(text));
      // about 1 ms per 10 KB on a laptop; 5x margin for macro-heavy manuals
      expect(t).toBeLessThan((10 + text.length / 2000) * PERF_SLACK);
      const r = importFile(p, text, seg);
      expect(new Set(r.units.map((u) => u.id)).size).toBe(r.units.length);
      bytes += text.length;
      sentences += seg.sentences.length;
      ms += t;
    }
    expect(sentences).toBeGreaterThan(REAL.length * 20);
    expect(ms / (bytes / 1e5)).toBeLessThan(50 * PERF_SLACK);
  });
});
