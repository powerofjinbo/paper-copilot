import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SKILL_CORPUS_NORMS, STYLE_SPREADS, furthestSentences, styleDistance, styleFeatures, type StyleFeatures } from '../src/meta/index';

/** Shared CI runners are slower and noisier than a laptop: timing budgets get 3x slack there. */
const PERF_SLACK = process.env.CI ? 3 : 1;

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const MAIN = readFileSync(here('../../../fixtures/canto-demo/tex/main.tex'), 'utf8');
const STYLE_CHECK = here('../../../.skill/scripts/style_check.py');

/** A small LaTeX-to-plain converter for the fixture (built here so the test does not depend on the segmenter). */
function plainSentences(tex: string): string[] {
  let t = tex.slice(tex.indexOf('\\begin{document}') + '\\begin{document}'.length, tex.indexOf('\\end{document}'));
  t = t.replace(/(?<!\\)%.*$/gm, '');
  t = t.replace(/\\begin\{(figure|table|equation)\}[\s\S]*?\\end\{\1\}/g, ' ');
  t = t.replace(/\\(title|author|affiliation|section|label|bibliography|footnote)\{[^}]*\}/g, ' ');
  t = t.replace(/\\(maketitle|appendix|begin\{abstract\}|end\{abstract\})/g, ' ');
  t = t.replace(/~?\\cite\{[^}]*\}/g, '').replace(/\\(?:eq)?ref\{[^}]*\}/g, '1').replace(/\$[^$]*\$/g, 'X');
  t = t.replace(/\\ttbar\{\}/g, 'ttbar').replace(/\\%/g, '%').replace(/~/g, ' ').replace(/\\[a-zA-Z]+/g, ' ');
  t = t.replace(/[{}]/g, '').replace(/\s+/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();
  return t.split(/(?<=[.?!])\s+(?=[A-Z])/).map((s) => s.trim()).filter((s) => /[A-Za-z]{2}/.test(s));
}

/** A typical AI-flavoured paragraph: stock openers, excess vocabulary, hype, long sentences. */
const AI_PARAGRAPH = [
  'Moreover, it is worth noting that our novel approach plays a crucial role in significantly enhancing the overall tracking performance across a wide range of challenging scenarios.',
  'Furthermore, by leveraging cutting-edge graph neural network architectures, we delve into the intricate landscape of displaced-particle reconstruction and showcase remarkable, robust and unprecedented improvements.',
  'Additionally, this comprehensive framework not only underscores the pivotal importance of signal-agnostic training but also paves the way for transformative advances in the realm of long-lived particle searches.',
  'Notably, these meticulous findings highlight the transformative potential of innovative machine-learning paradigms, offering invaluable insights that will undoubtedly reshape the ever-evolving field of collider physics.',
];

describe('styleFeatures', () => {
  it('returns n = 0 and zeros for empty input', () => {
    const f = styleFeatures([]);
    expect(f.n).toBe(0);
    for (const [k, v] of Object.entries(f)) expect(v, k).toBe(0);
    expect(styleFeatures(['', '   ', '.']).n).toBe(0);
  });

  it('measures length statistics as style_check.py does', () => {
    // Lengths 3, 5, 7, 9, 11: median 7; p90 = srt[round(0.9 * 4)] = srt[4] = 11 (style_check length_rows);
    // sample std = sqrt((16 + 4 + 0 + 4 + 16) / 4) = sqrt(10).
    const f = styleFeatures(['One two three.', 'One two three four five.', 'a b c d e f g.', 'a b c d e f g h i.', 'a b c d e f g h i j k.']);
    expect(f.n).toBe(5);
    expect(f.words).toBe(35);
    expect(f.medianLen).toBe(7);
    expect(f.p90Len).toBe(11);
    expect(f.lenStd).toBeCloseTo(Math.sqrt(10), 12);
    // Python round(0.9 * 5) = round(4.5) = 4 (half to even): six sentences of lengths 1..6 -> srt[4] = 5.
    expect(styleFeatures(['a.', 'a b.', 'a b c.', 'a b c d.', 'a b c d e.', 'a b c d e f.']).p90Len).toBe(5);
  });

  it('finds the first finite verb', () => {
    expect(styleFeatures(['We measure the efficiency of the tracker.']).verbPos).toBe(2);
    expect(styleFeatures(['In this paper, we train on generic events only.']).verbPos).toBe(5);
    expect(styleFeatures(['The fake-track rate is 0.55% against 1.38% for the baseline.']).verbPos).toBe(4);
    expect(styleFeatures(['A reconstructed track matches a particle.']).verbPos).toBe(4);
    // No finite verb: counted as after the last word.
    expect(styleFeatures(['Efficiency versus displacement for gun particles.']).verbPos).toBe(6);
  });

  it('detects passives, we, hedges, intensifiers, openers, inflated words, excess words and dashes', () => {
    const f1 = styleFeatures(['The jets are required to have a large momentum.']);
    expect(f1.passiveShare).toBe(1);
    expect(styleFeatures(['We require jets with a large momentum.']).passiveShare).toBe(0);
    // 10 words, we + our = 2 -> 200 per 1,000.
    expect(styleFeatures(['We find that our tracker beats the baseline by far.']).weRate).toBeCloseTo(200, 9);
    // may + suggest = 2 hedges in 5 words -> 400 per 1,000.
    expect(styleFeatures(['This may suggest a bias.']).hedgeRate).toBeCloseTo(400, 9);
    // very (no number in the sentence) + powerful (not after more/less/as) = 2 in 6 words.
    expect(styleFeatures(['This is a very powerful method.']).intensifierRate).toBeCloseTo(2000 / 6, 9);
    expect(styleFeatures(['This method is more powerful than the cut-based one.']).intensifierRate).toBe(0);
    expect(styleFeatures(['The very first event is shown.']).intensifierRate).toBe(0);
    expect(styleFeatures(['Moreover, the rate is low.']).connectorOpenerRate).toBeCloseTo(200, 9);
    expect(styleFeatures(['However, the rate is low.']).connectorOpenerRate).toBe(0);
    expect(styleFeatures(['We utilize a plethora of methods.']).inflatedRate).toBeCloseTo(2000 / 6, 9);
    expect(styleFeatures(['We delve into the intricate details.']).excessVocabRate).toBeCloseTo(2000 / 6, 9);
    expect(styleFeatures(['The rate — measured twice — is low.']).dashRate).toBeCloseTo(2000 / 6, 9);
    expect(styleFeatures(['The rate is 10–20 GeV and well-measured.']).dashRate).toBe(0);
    expect(styleFeatures(['The rate -- measured twice -- is low.']).dashRate).toBeCloseTo(2000 / 6, 9);
  });

  it('gives a type-token ratio at 1,000 words, extrapolated for short texts', () => {
    const many = Array.from({ length: 150 }, (_, i) => `Sample ${i} of tracks has word${i % 50} and more.`);
    const f = styleFeatures(many);
    expect(f.words).toBeGreaterThan(1000);
    expect(f.ttr).toBeGreaterThan(0);
    expect(f.ttr).toBeLessThan(0.5);
    // A short plain paragraph comes out near the long-text value instead of near 1.
    const short = styleFeatures(plainSentences(MAIN).slice(0, 4));
    expect(short.ttr).toBeLessThan(0.75);
    expect(styleFeatures(['Word.']).ttr).toBe(1);
  });

  it('agrees with style_check.py on the same plain text', () => {
    let py = true;
    try {
      execFileSync('python3', ['--version'], { stdio: 'ignore' });
    } catch {
      py = false;
    }
    if (!py) return;
    const sents = [
      'The jets are required to have a transverse momentum above 20 GeV.',
      'We measure the efficiency of the tracker in three samples.',
      'Moreover, the fake rate is low in every sample we consider.',
      'Thus the method is reliable for the analysis of displaced tracks.',
      'The events were selected with a single-muon trigger and an isolation requirement.',
      'In this paper, we utilize a novel and very powerful graph network to delve into tracking.',
      'Our tracker finds more particles than the baseline, which was trained on the signal.',
      'Additionally, the background is estimated from data in a control region.',
      'It is worth noting that the result is crucial for future searches at the LHC.',
      'These results suggest that the network may generalize to other detectors.',
    ];
    const dir = mkdtempSync(join(tmpdir(), 'meta-style-'));
    try {
      writeFileSync(join(dir, 'draft.txt'), 'Results\n\n' + sents.join('\n\n') + '\n');
      const out = JSON.parse(execFileSync('python3', ['-I', '-B', STYLE_CHECK, join(dir, 'draft.txt'), '--json'], { encoding: 'utf8' })) as {
        words: number;
        sentences: number;
        checks: Record<string, { flags: unknown[]; length_distribution?: Array<{ part: string; median: number; p90: number }>; openers?: Record<string, number>; passive_by_part?: Array<{ part: string; passive: number; n: number }>; we_per_1000_words?: number }>;
      };
      const f = styleFeatures(sents);
      const prose = out.checks['1']!.length_distribution!.find((r) => r.part === 'prose')!;
      expect(f.n).toBe(out.sentences);
      expect(f.words).toBe(out.words);
      expect(f.medianLen).toBe(prose.median);
      expect(f.p90Len).toBe(prose.p90);
      const pass = out.checks['10']!.passive_by_part!.find((r) => r.part === 'prose')!;
      expect(f.passiveShare).toBeCloseTo(pass.passive / pass.n, 12);
      expect(f.weRate).toBeCloseTo(out.checks['10']!.we_per_1000_words!, 1);
      const openers = Object.values(out.checks['3']!.openers!).reduce((a, b) => a + b, 0);
      expect(Math.round((f.connectorOpenerRate * f.words!) / 1000)).toBe(openers);
      expect(Math.round((f.inflatedRate * f.words!) / 1000)).toBe(out.checks['4']!.flags.length);
      expect(Math.round((f.intensifierRate * f.words!) / 1000)).toBe(out.checks['5']!.flags.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('styleDistance', () => {
  const fixture = styleFeatures(plainSentences(MAIN));
  const ai = styleFeatures(AI_PARAGRAPH);

  it('is 0 for identical features, symmetric, and its contributions sum to distance^2', () => {
    expect(styleDistance(SKILL_CORPUS_NORMS, SKILL_CORPUS_NORMS).distance).toBe(0);
    expect(styleDistance(fixture, fixture).distance).toBe(0);
    const ab = styleDistance(fixture, ai);
    const ba = styleDistance(ai, fixture);
    expect(ab.distance).toBeCloseTo(ba.distance, 12);
    const sum = Object.values(ab.perFeature).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(ab.distance ** 2, 9);
    expect(Object.keys(ab.perFeature).sort()).toEqual(Object.keys(STYLE_SPREADS).sort());
    for (const v of Object.values(ab.perFeature)) expect(v).toBeGreaterThanOrEqual(0);
  });

  it('documents a spread for every feature except the sample sizes', () => {
    const keys = Object.keys(SKILL_CORPUS_NORMS).filter((k) => k !== 'n' && k !== 'words');
    expect(Object.keys(STYLE_SPREADS).sort()).toEqual(keys.sort());
    for (const s of Object.values(STYLE_SPREADS)) {
      expect(s.spread).toBeGreaterThan(0);
      expect(s.basis.length).toBeGreaterThan(10);
    }
  });

  it('puts the fixture manuscript close to the skill corpus and an AI-flavoured paragraph far from it', () => {
    expect(fixture.n).toBeGreaterThanOrEqual(18);
    const dFix = styleDistance(fixture, SKILL_CORPUS_NORMS).distance;
    const dAi = styleDistance(ai, SKILL_CORPUS_NORMS).distance;
    expect(dFix).toBeLessThan(1.5);
    expect(dAi).toBeGreaterThan(5);
    expect(dAi).toBeGreaterThan(5 * dFix);
    // The AI paragraph is also far from the fixture used as an author corpus.
    expect(styleDistance(ai, fixture).distance).toBeGreaterThan(5);
    const top = Object.entries(styleDistance(ai, SKILL_CORPUS_NORMS).perFeature).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k]) => k);
    expect(top).toEqual(expect.arrayContaining(['excessVocabRate', 'inflatedRate', 'connectorOpenerRate']));
  });

  it('is about 1 for a typical between-author difference', () => {
    const shifted: StyleFeatures = { ...SKILL_CORPUS_NORMS };
    for (const [k, s] of Object.entries(STYLE_SPREADS)) (shifted as unknown as Record<string, number>)[k] = (SKILL_CORPUS_NORMS as unknown as Record<string, number>)[k]! + s.spread;
    const d = styleDistance(shifted, SKILL_CORPUS_NORMS).distance;
    expect(d).toBeGreaterThan(0.95);
    expect(d).toBeLessThanOrEqual(1);
  });

  it('discounts differences that chance alone produces in a short paragraph', () => {
    // One "Moreover" in 3 sentences of 25 words: a large rate, but a small sample.
    const one = styleFeatures([
      'Moreover, we measure the efficiency of the tracker on isolated particles from the gun sample at every radius we consider here.',
      'The fake-track rate is low for both models and stays below one percent in every bin of the transverse displacement.',
      'We find that the tracker trained without signal finds more displaced particles than the baseline at the same fake rate.',
    ]);
    const big: StyleFeatures = { ...one, n: 300, words: 30 * one.words! };
    expect(styleDistance(one, SKILL_CORPUS_NORMS).distance).toBeLessThan(styleDistance(big, SKILL_CORPUS_NORMS).distance);
  });

  it('handles empty sides and stored features without a word count', () => {
    expect(styleDistance(styleFeatures([]), SKILL_CORPUS_NORMS).distance).toBe(0);
    const { words: _w, ...legacy } = fixture;
    expect(styleDistance(legacy as StyleFeatures, SKILL_CORPUS_NORMS).distance).toBeGreaterThan(0);
    expect(Number.isFinite(styleDistance(legacy as StyleFeatures, ai).distance)).toBe(true);
  });
});

describe('furthestSentences', () => {
  const human = plainSentences(MAIN).map((text, i) => ({ id: `h${i}`, text }));
  const ai = AI_PARAGRAPH.map((text, i) => ({ id: `ai${i}`, text }));

  it('names the AI-flavoured sentences first, with plain reasons', () => {
    const mixed = [...human.slice(0, 8), ai[0]!, ...human.slice(8), ai[1]!, ai[2]!];
    const r = furthestSentences(mixed, SKILL_CORPUS_NORMS, 3);
    expect(r).toHaveLength(3);
    expect(r.map((x) => x.id).sort()).toEqual(['ai0', 'ai1', 'ai2']);
    for (let i = 1; i < r.length; i++) expect(r[i - 1]!.contribution).toBeGreaterThanOrEqual(r[i]!.contribution);
    for (const x of r) {
      expect(x.contribution).toBeGreaterThan(0);
      expect(x.why.length).toBeGreaterThan(5);
    }
    expect(r.map((x) => x.why).join(' ')).toMatch(/delve|underscores|crucial|Moreover|Additionally|Furthermore|leveraging/);
  });

  it('works against an author target and respects k', () => {
    const author = styleFeatures(human.map((h) => h.text));
    const r = furthestSentences([...human, ...ai], author, 2);
    expect(r).toHaveLength(2);
    expect(r.every((x) => x.id.startsWith('ai'))).toBe(true);
    expect(furthestSentences([...human, ...ai], author, 0)).toEqual([]);
    expect(furthestSentences([], author)).toEqual([]);
  });

  it('returns only sentences whose removal helps', () => {
    for (const x of furthestSentences(human, styleFeatures(human.map((h) => h.text)), 10)) expect(x.contribution).toBeGreaterThan(0);
  });

  it('is fast enough for a whole paper', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ id: `s${i}`, text: i % 40 === 0 ? AI_PARAGRAPH[i % 4]! : human[i % human.length]!.text }));
    const t0 = performance.now();
    const r = furthestSentences(many, SKILL_CORPUS_NORMS, 3);
    const ms = performance.now() - t0;
    expect(r).toHaveLength(3);
    expect(ms).toBeLessThan(3000 * PERF_SLACK);
  });
});
