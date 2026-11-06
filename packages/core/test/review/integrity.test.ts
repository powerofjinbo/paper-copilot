/**
 * Research-integrity review of the faithfulness gate (reviewer, integrity lens).
 *
 * Every `it` below states the behaviour the design promises ("AI text never invents numbers, cuts,
 * citations or causal claims silently": docs/design.md section 6). Tests that FAIL demonstrate a hole;
 * tests that pass are kept as regression tests.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { gateSentence, type GateContext, type GateResult } from '../../src/gate/gate';
import { fictionalNumbers } from '../../src/prompts/fictional';
import { computeDisclosureStats } from '../../src/meta/disclosure';
import type { Fact, SentenceUnit, SentenceVersion } from '../../src/schemas';

const root = (p: string): string => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));
const CLAIM = JSON.parse(readFileSync(root('fixtures/canto-demo/repo/results/addendum_g_g1_v1_claim.json'), 'utf8')) as Record<string, number>;

function fact(p: Partial<Fact> & Pick<Fact, 'id' | 'value'>): Fact {
  return {
    kind: 'number',
    sigfigs: null,
    unit: '',
    uncertainties: {},
    definition: '',
    definitionSource: 'test',
    artifact: 'results/addendum_g_g1_v1_claim.json',
    locator: `#/${p.id.split('.').pop()}`,
    artifactSha256: 'sha',
    fingerprint: 'fp',
    stale: false,
    validationState: 'candidate',
    aliases: [],
    confirmed: true,
    excluded: false,
    proseOnly: false,
    tags: [],
    ...p,
  };
}

/** The Canto fact store (same shape as packages/core/test/gate.test.ts). */
const FACTS: Fact[] = [
  fact({ id: 'f.g1.n_targets', value: CLAIM.n_targets!, tags: ['count', 'claim'] }),
  fact({ id: 'f.g1.eff_A', value: CLAIM.eff_A!, tags: ['fraction', 'claim'], definition: 'Efficiency of Canto-L (ttbar)' }),
  fact({ id: 'f.g1.eff_B', value: CLAIM.eff_B!, tags: ['fraction', 'claim'], definition: 'Efficiency of acorn (HNL) + LM' }),
  fact({
    id: 'f.g1.delta_points',
    value: CLAIM.delta_points!,
    unit: 'points',
    uncertainties: { total: CLAIM.sigma_points!, boot: CLAIM.sigma_boot_points!, seeds: CLAIM.sigma_seeds_points! },
  }),
  fact({ id: 'f.g1.fake_rate_A', value: CLAIM.fake_rate_A!, tags: ['fraction'], definition: 'Fake-track rate of Canto-L' }),
  fact({ id: 'f.g1.fake_rate_B', value: CLAIM.fake_rate_B!, tags: ['fraction'], definition: 'Fake-track rate of acorn' }),
  fact({ id: 'f.g1.fake_rate_diff_points', value: CLAIM.fake_rate_diff_points!, unit: 'points', definition: 'Fake-track rate, Canto-L minus acorn' }),
  fact({ id: 'f.definitions.pT_gt_1GeV', kind: 'cut', value: 1, unit: 'GeV', tags: ['cut', 'cmp:gt'] }),
  fact({ id: 'f.definitions.abs_eta_lt_4', kind: 'cut', value: 4, unit: '', tags: ['cut', 'cmp:lt'] }),
  fact({ id: 'f.definitions.ge_5_space_points', kind: 'cut', value: 5, unit: '', tags: ['cut', 'cmp:ge'] }),
];

function skillFictional(): string[] {
  const dir = root('.skill/references/');
  const refs: Record<string, string> = {};
  for (const f of readdirSync(dir)) if (f.endsWith('.md')) refs[f] = readFileSync(dir + f, 'utf8');
  return fictionalNumbers(refs);
}
const FICTIONAL = skillFictional();

function ctx(extra: Partial<GateContext> = {}): GateContext {
  return { mode: 'ghost', facts: FACTS, allowedCiteKeys: ['Wang2022LRT'], knownLabels: ['fig:eff'], fictionalNumbers: FICTIONAL, maxWords: null, ...extra };
}

// 'loose_number' (warn): a result restated in words or as a rough ratio that does match a fact
// ("ninety-seven percent" is eff_A = 96.94% rounded); it is linked, and the author is told to write the numeral.
const NUMBER_CODES = new Set(['unmatched_number', 'unmatched_cut', 'percent_scale', 'fictional_number', 'unlinked_number', 'factor_percent', 'number_changed', 'loose_number']);
/** The sentence is blocked, or at least one number-related issue is reported (the author is told). */
const numberFlagged = (r: GateResult): boolean => !r.ok || r.issues.some((i) => NUMBER_CODES.has(i.code));
const show = (s: string, r: GateResult): string => `${s} -> ok=${r.ok} issues=[${r.issues.map((i) => `${i.code}:${i.severity}`).join(',')}]`;

describe('integrity: quantities written in words reach the text without any flag', () => {
  const sentences = [
    'The tracker improves the efficiency by thirty percent over the baseline.',
    'Canto-L finds ninety-seven percent of the displaced targets.',
    'Canto-L halves the fake-track rate of acorn.',
    'The new model is twice as efficient as the baseline.',
    'The tracker is an order of magnitude faster than acorn.',
    // the skill's own invented example (figures-and-evidence.md, EVIDENCE "After" line)
    'The punch-through background has fallen a hundredfold.',
  ];
  for (const s of sentences) {
    it(`flags "${s}"`, () => {
      const r = gateSentence(s, ctx());
      expect(numberFlagged(r), show(s, r)).toBe(true);
    });
  }
});

describe('integrity: small integers (0-10) are never checked, even as cuts or results', () => {
  it('a cut that contradicts the cut fact (>= 5 space points) is flagged', () => {
    const s = 'Tracks need at least 3 space points.';
    const r = gateSentence(s, ctx());
    expect(numberFlagged(r), show(s, r)).toBe(true);
  });
  it('an eta acceptance that contradicts the cut fact (|eta| < 4) is flagged', () => {
    const s = 'Tracks are kept for $|\\eta| < 2$.';
    const r = gateSentence(s, ctx());
    expect(numberFlagged(r), show(s, r)).toBe(true);
  });
  it('an invented result as a small-integer fraction is flagged', () => {
    const s = 'Canto-L rejects 9 out of 10 fake tracks.';
    const r = gateSentence(s, ctx());
    expect(numberFlagged(r), show(s, r)).toBe(true);
  });
  it('an invented resource number with a unit the gate does not know is flagged', () => {
    const s = 'Training uses 8 GPUs and 10 GB of memory.';
    const r = gateSentence(s, ctx());
    expect(numberFlagged(r), show(s, r)).toBe(true);
  });
  it('regression: the matching cut passes and links its fact', () => {
    const r = gateSentence('Tracks are kept for $|\\eta| < 4$.', ctx());
    expect(r.ok).toBe(true);
    expect(r.factIds).toContain('f.definitions.abs_eta_lt_4');
  });
});

describe('integrity: uncertainties', () => {
  it('an invented uncertainty that happens to equal another fact value is flagged (eff_A has no recorded uncertainty)', () => {
    // 0.55% is the fake-track rate of Canto-L, not an uncertainty of the efficiency
    const s = 'Canto-L finds 96.94\\% $\\pm$ 0.55\\% of the targets.';
    const r = gateSentence(s, ctx());
    expect(numberFlagged(r), show(s, r)).toBe(true);
  });
  it('a wrong uncertainty on delta (real: 0.28) is flagged even when it equals another fact value', () => {
    const s = 'Canto-L finds 2.32 $\\pm$ 0.55 points more targets than acorn.';
    const r = gateSentence(s, ctx());
    expect(numberFlagged(r), show(s, r)).toBe(true);
  });
  it('regression: the recorded uncertainty passes', () => {
    const r = gateSentence('Canto-L finds 2.32 $\\pm$ 0.28 points more targets than acorn.', ctx());
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });
});

describe('integrity: direction of a result', () => {
  it('a decrease stated as a rise (fake_rate_diff = -0.83 points) is not passed silently', () => {
    const s = 'The fake-track rate rises by 0.83 points with Canto-L.';
    const r = gateSentence(s, ctx());
    expect(r.ok && r.issues.length === 0, show(s, r)).toBe(false);
  });
});

describe('integrity: a number typed in the intent note', () => {
  it('the note says 2.3 percentage points; the rendering "2.3%" (percent, not points) is still a percent/points mix-up', () => {
    const s = 'Canto-L improves the efficiency by 2.3\\% over acorn.';
    const r = gateSentence(s, ctx({ mode: 'intent', intentText: '效率比 acorn 高 2.3 个百分点 (2.3 points)' }));
    // unlinked (warn) hides the percent_scale block that the same sentence gets without a note
    const without = gateSentence(s, ctx({ mode: 'intent' }));
    expect(without.issues.some((i) => i.code === 'percent_scale' || i.code === 'unmatched_number')).toBe(true);
    expect(r.issues.some((i) => i.code === 'percent_scale'), show(s, r)).toBe(true);
  });
});

describe('integrity: the grammar-only path', () => {
  const original = 'Canto-L does not lower the fake-track rate of acorn.';
  it('a "grammar fix" that flips the claim is not accepted with zero issues', () => {
    const fixed = 'Canto-L lowers the fake-track rate of acorn.';
    const r = gateSentence(fixed, ctx({ mode: 'grammar', original }));
    expect(r.ok && r.issues.length === 0, show(fixed, r)).toBe(false);
  });
  it('disclosure: that meaning change, recorded as grammar_fix, is counted as language polishing only', () => {
    const unit: SentenceUnit = {
      id: 's1', file: 'main.tex', start: 0, end: 10, line: 1, hash: 'h', ctxHash: '', textNorm: 'x', sectionId: 's', paragraphId: 's/p0', part: 'body', kind: 'prose',
      move: null, state: 'human', everAi: true, grammarFixed: true, imported: true, model: 'claude-sonnet-5-5', promptHash: 'p', createdAt: '2026-11-06T00:00:00Z',
      acceptedAt: null, editDistance: null, intentNote: null, facts: [], cites: [], claims: [], placeholders: [], splitFrom: null, orphaned: false,
    } as SentenceUnit;
    const versions: SentenceVersion[] = [
      { sentenceId: 's1', version: 0, ts: '2026-11-06T00:00:00Z', text: original, origin: 'import', model: null, promptHash: null, instruction: null, lang: null, parentVersion: null, editDistance: null },
      { sentenceId: 's1', version: 1, ts: '2026-11-06T00:01:00Z', text: 'Canto-L lowers the fake-track rate of acorn.', origin: 'grammar_fix', model: 'claude-sonnet-5-5', promptHash: 'p', instruction: null, lang: null, parentVersion: 0, editDistance: 0.4 },
    ] as SentenceVersion[];
    const st = computeDisclosureStats([unit], versions);
    // A 40% word change (the claim inverted) is reported as "grammar only"; the design calls the grammar
    // route a minimal-diff fix and the disclosure must not hide substantive AI rewrites in that bucket.
    expect(st.grammarOnly, JSON.stringify({ grammarOnly: st.grammarOnly })).toBe(0);
  });
});

describe('integrity: the skill fictional-example numbers (regression)', () => {
  it('the precomputed set is not empty and contains the skill example numbers', () => {
    expect(FICTIONAL).toEqual(expect.arrayContaining(['31', '60', '2.5', '1.2', '300']));
  });
  for (const s of [
    'Canto-L keeps 31\\% of decays at large radii.',
    'The new trigger lowers the expected limit by a factor of 2.5.',
    'A search would exclude scalars up to 1.2~TeV.',
    'With 300~fb$^{-1}$ the reach grows.',
  ]) {
    it(`blocks "${s}"`, () => {
      const r = gateSentence(s, ctx());
      expect(r.ok, show(s, r)).toBe(false);
    });
  }
});

describe('integrity: numbers in LaTeX constructs (regression)', () => {
  for (const s of [
    'The efficiency is \\SI{97.5}{\\percent}.',
    'The efficiency is \\qty{97.5}{\\percent}.',
    'Tracks with $d_0$ in \\SIrange{1}{30}{\\mm} are kept.',
    'Tracks with $d_0$ between 1--3~mm are kept.',
    'The rate is $1.2\\times10^{-3}$.',
    'The rate is 3e-3.',
    'The rate changes by $-0.42$ points.',
    'The efficiency is 97.5\\%\\footnote{Measured with 12 seeds.}.',
    '\\caption{Efficiency versus $p_T$ for 25 seeds.}',
    'At $\\sqrt{s} = 14$~TeV the gain is 2.32 points.',
  ]) {
    it(`blocks "${s}"`, () => {
      const r = gateSentence(s, ctx());
      expect(r.ok, show(s, r)).toBe(false);
    });
  }
});

/* ------------------------------------------------------------------------------------ */
/* Regression tests for the fixes (INT-2..INT-9): what must pass, and what must be caught */
/* ------------------------------------------------------------------------------------ */

const codesOf = (r: GateResult): string[] => r.issues.map((i) => `${i.code}:${i.severity}`);

describe('integrity fixes: word numerals', () => {
  for (const s of [
    'We use three seeds and two trackers.',
    'We checked this twice.',
    'The two-step procedure keeps one of the methods.',
    'A track matches if more than half of its hits come from one particle.',
    'Section two describes the one-sentence-per-line layout.',
    'Hundreds of thousands of tracks are processed.',
  ]) {
    it(`leaves structural wording alone: "${s}"`, () => {
      const r = gateSentence(s, ctx());
      expect(codesOf(r), show(s, r)).toEqual([]);
    });
  }
  it('a factor in words with no ratio fact becomes a visible placeholder', () => {
    const r = gateSentence('Canto-L halves the fake-track rate of acorn.', ctx());
    expect(r.ok).toBe(false);
    expect(r.repaired).toMatch(/\[fact\?: /);
  });
  it('a factor is never a points difference: "a factor of two" does not link delta_points (2.32)', () => {
    const r = gateSentence('Canto-L improves the efficiency by a factor of two.', ctx());
    expect(r.ok, show('factor of two', r)).toBe(false);
    expect(r.factIds).not.toContain('f.g1.delta_points');
    const d = gateSentence('Canto-L improves the efficiency by a factor of 2.', ctx());
    expect(d.ok).toBe(false);
  });
  it('a factor in words matches a declared derived relation', () => {
    const derived = [{ value: 2.0, raw: '2', factIds: ['f.g1.fake_rate_B', 'f.g1.fake_rate_A'], description: 'ratio (rounded)' }];
    const r = gateSentence('Acorn makes twice as many fake tracks as Canto-L.', ctx({ derived }));
    expect(r.ok, show('twice', r)).toBe(true);
    expect(r.factIds).toEqual(['f.g1.fake_rate_B', 'f.g1.fake_rate_A']);
  });
  it('the skill example phrase is reported as fictional', () => {
    expect(FICTIONAL).toEqual(expect.arrayContaining(['hundredfold', 'five times']));
    const r = gateSentence('The punch-through background has fallen a hundredfold.', ctx());
    expect(codesOf(r)).toContain('fictional_number:block');
  });
  it('"ninety-seven percent" links eff_A and asks for the numeral', () => {
    const r = gateSentence('Canto-L finds ninety-seven percent of the displaced targets.', ctx());
    expect(r.factIds).toEqual(['f.g1.eff_A']);
    expect(codesOf(r)).toEqual(['loose_number:warn']);
  });
});

describe('integrity fixes: small integers, cuts, ratios, counts', () => {
  it('a word numeral after a comparison is checked as a cut', () => {
    expect(codesOf(gateSentence('Tracks need at least three space points.', ctx()))).toEqual(['unmatched_cut:block']);
    expect(gateSentence('Tracks need at least five space points.', ctx()).factIds).toEqual(['f.definitions.ge_5_space_points']);
  });
  it('a weak comparison word keeps a count structural ("averaged over 3 seeds")', () => {
    const r = gateSentence('The efficiency is averaged over 3 seeds.', ctx());
    expect(codesOf(r)).toEqual([]);
  });
  it('a ratio that matches a fraction fact links it (with a warn), one that does not is blocked', () => {
    const ok = gateSentence('About 1 in 200 Canto-L tracks is fake.', ctx());
    expect(ok.factIds).toEqual(['f.g1.fake_rate_A']);
    expect(codesOf(ok)).toEqual(['loose_number:warn']);
    const bad = gateSentence('Canto-L rejects 3 out of 4 fake tracks.', ctx());
    expect(bad.ok).toBe(false);
    expect(bad.repaired).toContain('[fact?:');
    expect(bad.repaired).not.toContain('out of 4');
  });
  it('a small count is checked in ghost/draft, warned in rewrite, and left alone when the original has it', () => {
    expect(gateSentence('Training uses 8 GPUs.', ctx()).ok).toBe(false);
    expect(gateSentence('Training uses 8 GPUs.', ctx({ mode: 'draft' })).ok).toBe(false);
    const rw = gateSentence('Training uses 8 GPUs.', ctx({ mode: 'rewrite', original: 'We train on many GPUs.' }));
    expect(rw.ok).toBe(true);
    expect(codesOf(rw)).toContain('unmatched_number:warn');
    const kept = gateSentence('Training uses 8 GPUs.', ctx({ mode: 'grammar', original: 'Training use 8 GPUs.' }));
    expect(codesOf(kept)).toEqual([]);
    expect(codesOf(gateSentence('The detector has 4 layers.', ctx()))).toEqual([]);
  });
});

describe('integrity fixes: uncertainties', () => {
  it('a standalone uncertainty fact is accepted for the value it belongs to', () => {
    const facts = [...FACTS.filter((f) => f.id !== 'f.g1.delta_points'), fact({ id: 'f.g1.delta_points', value: CLAIM.delta_points!, unit: 'points' }), fact({ id: 'f.g1.sigma_points', value: CLAIM.sigma_points!, unit: 'points' })];
    const r = gateSentence('Canto-L finds 2.32 $\\pm$ 0.28 points more targets than acorn.', ctx({ facts }));
    expect(r.ok, show('standalone sigma', r)).toBe(true);
  });
  it('the message names the fact whose uncertainty is missing', () => {
    const r = gateSentence('Canto-L finds 96.94\\% $\\pm$ 0.55\\% of the targets.', ctx());
    expect(r.issues.find((i) => i.code === 'unmatched_number')?.message).toContain('f.g1.eff_A');
  });
});

describe('integrity fixes: direction', () => {
  it('the right direction passes', () => {
    for (const s of ['The fake-track rate falls by 0.83 points with Canto-L.', 'Canto-L lowers the fake-track rate of acorn by 0.83 points.', "Acorn's fake-track rate is 0.83 points higher than that of Canto-L."]) {
      const r = gateSentence(s, ctx());
      expect(r.issues.filter((i) => i.code === 'direction'), show(s, r)).toEqual([]);
    }
  });
  it('a magnitude without a direction is warned; a gain stated as a loss is not silent', () => {
    expect(codesOf(gateSentence('The fake-track rate changes by 0.83 points with Canto-L.', ctx()))).toContain('direction:warn');
    const r = gateSentence('Canto-L loses 2.32 points against acorn.', ctx());
    expect(r.issues.some((i) => i.code === 'direction'), show('loses', r)).toBe(true);
    // with an "A minus B" definition the subject is known, and the contradiction blocks
    const facts = FACTS.map((f) => (f.id === 'f.g1.delta_points' ? { ...f, definition: 'Efficiency of Canto-L minus acorn, in points' } : f));
    expect(codesOf(gateSentence('Canto-L loses 2.32 points against acorn.', ctx({ facts })))).toContain('direction:block');
    expect(codesOf(gateSentence('Acorn loses 2.32 points against Canto-L.', ctx({ facts })))).not.toContain('direction:block');
  });
});

describe('integrity fixes: intent-note forms', () => {
  it('the note form must agree with the rendered form', () => {
    const intentText = '效率比 acorn 高 1.9 个百分点';
    expect(codesOf(gateSentence('Canto-L improves the efficiency by 1.9 points over acorn.', ctx({ mode: 'intent', intentText })))).toContain('unlinked_number:warn');
    const bad = gateSentence('Canto-L improves the efficiency by 1.9\\% over acorn.', ctx({ mode: 'intent', intentText }));
    expect(codesOf(bad)).toContain('percent_scale:block');
    // a bare number in the note accepts any form
    expect(gateSentence('Canto-L improves the efficiency by 1.9\\% over acorn.', ctx({ mode: 'intent', intentText: '高 1.9' })).ok).toBe(true);
  });
});

describe('integrity fixes: grammar-only path', () => {
  const original = 'Canto-L does not lower the fake-track rate of acorn.';
  it('real grammar fixes pass', () => {
    for (const [original, fixed] of [
      ['We has use the method for compute the efficiency.', 'We used the method to compute the efficiency.'],
      ['We make an experiment with the tracker.', 'We perform an experiment with the tracker.'],
      ['Canto-L find more target than acorn.', 'Canto-L finds more targets than acorn.'],
    ]) {
      const r = gateSentence(fixed!, ctx({ mode: 'grammar', original }));
      expect(codesOf(r), show(fixed!, r)).toEqual([]);
    }
  });
  it('a direction flip or a new claim is not a grammar fix', () => {
    expect(codesOf(gateSentence('Canto-L has a lower fake-track rate.', ctx({ mode: 'grammar', original: 'Canto-L have a higher fake-track rate.' })))).toContain('meaning_changed:block');
    expect(codesOf(gateSentence('The new tracker clearly outperforms every published baseline method.', ctx({ mode: 'grammar', original: 'The tracker is similar to acorn on this sample.' })))).toContain('meaning_changed:block');
  });
  it('a rewrite that drops a negation is flagged for rereading', () => {
    expect(codesOf(gateSentence('Canto-L lowers the fake-track rate of acorn.', ctx({ mode: 'rewrite', original })))).toContain('meaning_changed:warn');
  });
  it('disclosure: a minimal grammar fix counts as grammar only; a meaning change counts as an AI rewrite on request', () => {
    const base = { file: 'main.tex', start: 0, end: 10, line: 1, hash: 'h', ctxHash: '', textNorm: 'x', sectionId: 's', paragraphId: 's/p0', part: 'body', kind: 'prose', move: null, state: 'human', everAi: true, grammarFixed: true, imported: true, model: 'm', promptHash: 'p', createdAt: '2026-11-06T00:00:00Z', acceptedAt: null, editDistance: null, intentNote: null, facts: [], cites: [], claims: [], placeholders: [], splitFrom: null, orphaned: false } as unknown as SentenceUnit;
    const v = (id: string, version: number, text: string, origin: SentenceVersion['origin']): SentenceVersion => ({ sentenceId: id, version, ts: '2026-11-06T00:00:00Z', text, origin, model: origin === 'grammar_fix' ? 'm' : null, promptHash: null, instruction: null, lang: null, parentVersion: version ? version - 1 : null, editDistance: null }) as SentenceVersion;
    const st = computeDisclosureStats(
      [{ ...base, id: 'g' }, { ...base, id: 'r' }],
      [v('g', 0, 'We has use the method.', 'import'), v('g', 1, 'We used the method.', 'grammar_fix'), v('r', 0, original, 'import'), v('r', 1, 'Canto-L lowers the fake-track rate of acorn.', 'grammar_fix')],
    );
    expect(st.grammarOnly).toBe(1);
    expect(st.aiRewrittenOnRequest).toBe(1);
  });
});
