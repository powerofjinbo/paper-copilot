import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { gateSentence, type GateContext, type GateResult } from '../src/gate/gate';
import { findPlaceholders } from '../src/latex/tokens';
import { segment } from '../src/latex/segment';
import type { Fact } from '../src/schemas';

const root = (p: string): string => fileURLToPath(new URL(`../../../fixtures/canto-demo/${p}`, import.meta.url));
const CLAIM = JSON.parse(readFileSync(root('repo/results/addendum_g_g1_v1_claim.json'), 'utf8')) as Record<string, number>;
const MAIN = readFileSync(root('tex/main.tex'), 'utf8');

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
  fact({ id: 'f.g1.margin', value: CLAIM.margin! }),
  fact({ id: 'f.g1.fake_rate_A', value: CLAIM.fake_rate_A!, tags: ['fraction'] }),
  fact({ id: 'f.g1.fake_rate_B', value: CLAIM.fake_rate_B!, tags: ['fraction'] }),
  fact({ id: 'f.g1.fake_rate_diff_points', value: CLAIM.fake_rate_diff_points!, unit: 'points' }),
  fact({ id: 'f.definitions.pT_gt_1GeV', kind: 'cut', value: 1, unit: 'GeV', tags: ['cut', 'cmp:gt'] }),
  fact({ id: 'f.definitions.abs_eta_lt_4', kind: 'cut', value: 4, unit: '', tags: ['cut', 'cmp:lt'] }),
  fact({ id: 'f.definitions.ge_5_space_points', kind: 'cut', value: 5, unit: '', tags: ['cut', 'cmp:ge'] }),
];

const LABELS = ['sec:intro', 'sec:method', 'sec:results', 'sec:concl', 'eq:eff', 'fig:eff', 'tab:eff', 'app:val'];
const CITES = ['Wang2022LRT', 'Ju2022Zenodo'];

function ctx(extra: Partial<GateContext> = {}): GateContext {
  return { mode: 'draft', facts: FACTS, allowedCiteKeys: CITES, knownLabels: LABELS, fictionalNumbers: ['1.2', '300', '87.8', '91.3'], ...extra };
}
const codes = (r: GateResult): string[] => r.issues.map((i) => `${i.code}:${i.severity}`);

describe('gateSentence: numbers', () => {
  it('passes the fixture abstract result sentence and links its facts', () => {
    const s = 'On isolated displaced particles that neither model saw in training, it finds 96.94\\% of the targets, compared with 94.62\\% for the signal-trained baseline, at a fake-track rate of 0.55\\% against 1.38\\%.';
    const r = gateSentence(s, ctx({ mode: 'ghost', maxWords: null }));
    expect(codes(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.repaired).toBe(s);
    expect(r.factIds).toEqual(['f.g1.eff_A', 'f.g1.eff_B', 'f.g1.fake_rate_A', 'f.g1.fake_rate_B']);
  });

  it('links a value with its uncertainty: 2.32 ± 0.28 points', () => {
    const s = 'On the isolated gun particles, the tracker finds 2.32~$\\pm$~0.28 points more than acorn (HNL) with the same track builder; see Fig.~\\ref{fig:eff}.';
    const r = gateSentence(s, ctx());
    expect(r.ok).toBe(true);
    expect(codes(r)).toEqual([]);
    expect(r.factIds).toEqual(['f.g1.delta_points']);
  });

  it('blocks an invented uncertainty', () => {
    const r = gateSentence('The tracker finds 2.32~$\\pm$~0.35 points more than acorn (HNL).', ctx());
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['unmatched_number:block']);
    expect(r.repaired).toMatch(/^The tracker finds 2\.32~\$\\pm\$~\[fact\?: [^\]]+\] points more/);
  });

  it('matches 8,710 and 8{,}710 to n_targets', () => {
    for (const s of ['The test set holds 8,710 targets.', 'The test set holds 8{,}710 targets.', 'The test set holds \\num{8710} targets.']) {
      const r = gateSentence(s, ctx());
      expect(r.ok, s).toBe(true);
      expect(r.factIds).toEqual(['f.g1.n_targets']);
    }
  });

  it('blocks an invented 97.3\\% and repairs it to a descriptive [fact?: ...] placeholder', () => {
    const s = 'On isolated displaced particles, the tracker finds 97.3\\% of the targets.';
    const r = gateSentence(s, ctx());
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['unmatched_number:block']);
    expect(r.issues[0]).toMatchObject({ raw: '97.3', start: s.indexOf('97.3'), end: s.indexOf('97.3') + 4 });
    expect(r.repaired).toBe('On isolated displaced particles, the tracker finds [fact?: displaced particles the tracker finds ... of the targets] of the targets.');
    expect(r.placeholders).toEqual(['[fact?: displaced particles the tracker finds ... of the targets]']);
    expect(findPlaceholders(r.repaired).map((p) => p.kind)).toEqual(['fact']);
    // the repaired sentence holds no number and passes the number checks
    expect(gateSentence(r.repaired, ctx()).issues.filter((i) => i.code === 'unmatched_number')).toEqual([]);
  });

  it('gives each repaired placeholder its own description', () => {
    const r = gateSentence('It finds 97.3\\% against 95.1\\% for the baseline.', ctx());
    expect(r.placeholders.length).toBe(2);
    expect(new Set(r.placeholders).size).toBe(2);
  });

  it('accepts a fraction written as a fraction', () => {
    const r = gateSentence('The efficiency of the new tracker is 0.9694 on these targets.', ctx());
    expect(r.ok).toBe(true);
    expect(r.factIds).toEqual(['f.g1.eff_A']);
  });

  it('blocks a percent written without % for a fraction fact (percent_scale), and a fraction with a % sign', () => {
    const a = gateSentence('The tracker finds 96.94 of the targets.', ctx());
    expect(a.ok).toBe(false);
    expect(codes(a)).toEqual(['percent_scale:block']);
    expect(a.issues[0]!.message).toContain('f.g1.eff_A');
    expect(a.factIds).toEqual([]);
    const b = gateSentence('The tracker finds 0.97\\% of the targets.', ctx());
    expect(codes(b)).toEqual(['percent_scale:block']);
    const c = gateSentence('The tracker finds 2.32\\% more targets.', ctx());
    expect(codes(c)).toEqual(['percent_scale:block']);
  });

  it('ignores structural numbers', () => {
    const s = 'As shown in Sec.~3, Fig.~2, Table~I and Eq.~(4), the method has two parts, (i) and (ii), first proposed in 2024~\\cite{Wang2022LRT}, and uses 3 seeds.';
    const r = gateSentence(s, ctx());
    expect(codes(r)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('parses \\SI, \\num, scientific notation and powers of ten', () => {
    const facts = [
      ...FACTS,
      fact({ id: 'f.cut.e', kind: 'cut', value: 30, unit: 'GeV', tags: ['cut', 'cmp:gt'] }),
      fact({ id: 'f.fake.tiny', value: 0.000123 }),
      fact({ id: 'f.n.events', value: 1.04e8 }),
    ];
    const s = 'Jets above \\SI{30}{\\GeV} pass, \\num{8710} targets remain, the rate is $1.2\\times10^{-4}$ and we simulate 10^8 and $10^{8}$ events.';
    const r = gateSentence(s, ctx({ facts, fictionalNumbers: [] }));
    expect(codes(r)).toEqual([]);
    expect(r.factIds).toEqual(['f.cut.e', 'f.g1.n_targets', 'f.fake.tiny', 'f.n.events']);
    // the same sentence without those facts: every one of them is blocked
    const r2 = gateSentence(s, ctx({ fictionalNumbers: [] }));
    expect(r2.ok).toBe(false);
    expect(r2.issues.map((i) => i.raw)).toEqual(['30', '1.2\\times10^{-4}', '10^8', '10^{8}']);
    expect(r2.issues[0]!.code).toBe('unmatched_cut');
    // a \SI command is replaced whole, so the repaired LaTeX still compiles
    expect(r2.repaired).toMatch(/^Jets above \[fact\?: [^\]]+\] pass/);
  });

  it('requires a cut fact for a unit next to a comparison', () => {
    expect(gateSentence('A target particle has $p_T > 1$~GeV, $|\\eta| < 4$ and at least five space points.', ctx())).toMatchObject({ ok: true, factIds: ['f.definitions.pT_gt_1GeV', 'f.definitions.abs_eta_lt_4'] });
    const r = gateSentence('A target particle has $p_T > 2$~GeV.', ctx());
    expect(codes(r)).toEqual(['unmatched_cut:block']);
    // a number fact with the right value is not a cut
    const facts = [...FACTS.filter((f) => f.kind !== 'cut'), fact({ id: 'f.mean.pt', value: 1, unit: 'GeV' })];
    expect(codes(gateSentence('A target particle has $p_T > 1$~GeV.', ctx({ facts })))).toEqual(['unmatched_cut:block']);
  });

  it('blocks fictional numbers unless they are also fact values', () => {
    const r = gateSentence('The search excludes masses up to 1.2~TeV with 300~fb$^{-1}$.', ctx());
    expect(r.issues.filter((i) => i.code === 'fictional_number').map((i) => i.raw)).toEqual(['1.2', '300']);
    expect(r.ok).toBe(false);
    const facts = [...FACTS, fact({ id: 'f.reach', value: 1.2, unit: 'TeV' }), fact({ id: 'f.lumi', value: 300, unit: 'fb^-1' })];
    const r2 = gateSentence('The reach is 1.2~TeV with 300~fb$^{-1}$.', ctx({ facts }));
    expect(r2.ok).toBe(true);
    expect(r2.factIds).toEqual(['f.reach', 'f.lumi']);
  });

  it('lets numbers typed in the intent note pass as unlinked (warn)', () => {
    const r = gateSentence('We train on 12 generic samples.', ctx({ mode: 'intent', intentText: '我们用12个通用样本训练' }));
    expect(r.ok).toBe(true);
    expect(codes(r)).toEqual(['unlinked_number:warn']);
    expect(r.unlinked).toEqual(['12']);
    // a number not in the note is still blocked
    expect(gateSentence('We train on 13 generic samples.', ctx({ mode: 'intent', intentText: '我们用12个通用样本训练' })).ok).toBe(false);
  });

  it('accepts a declared derived relation', () => {
    const derived = [{ value: CLAIM.fake_rate_B! / CLAIM.fake_rate_A!, raw: '2.5', factIds: ['f.g1.fake_rate_B', 'f.g1.fake_rate_A'], description: 'ratio of fake rates' }];
    const s = 'The baseline makes 2.5 times more fake tracks, 1.38\\% against 0.55\\%.';
    const r = gateSentence(s, ctx({ derived }));
    expect(r.ok).toBe(true);
    expect(r.factIds).toEqual(['f.g1.fake_rate_B', 'f.g1.fake_rate_A']);
    expect(gateSentence(s, ctx()).ok).toBe(false);
  });

  it('warns when one result is stated both as a factor and as a percent', () => {
    const derived = [
      { value: 2.51, raw: '2.5', factIds: ['f.g1.fake_rate_B', 'f.g1.fake_rate_A'], description: 'ratio' },
      { value: 151, raw: '151', factIds: ['f.g1.fake_rate_A', 'f.g1.fake_rate_B'], description: 'relative excess in percent' },
    ];
    const r = gateSentence('The baseline makes 2.5 times more fake tracks, an excess of 151\\%.', ctx({ derived }));
    expect(r.ok).toBe(true);
    expect(codes(r)).toEqual(['factor_percent:warn']);
  });

  it('uses the facts the model claimed to break ties', () => {
    const facts = [...FACTS, fact({ id: 'f.csv.mean', value: CLAIM.eff_A!, tags: ['fraction'] })];
    const s = 'It finds 96.94\\% of the targets.';
    expect(gateSentence(s, ctx({ facts })).factIds).toEqual([]);
    expect(gateSentence(s, ctx({ facts })).ok).toBe(true);
    expect(gateSentence(s, ctx({ facts, claimedFactIds: ['f.g1.eff_A'] })).factIds).toEqual(['f.g1.eff_A']);
  });

  it('blocks an unescaped % after a number', () => {
    expect(codes(gateSentence('It finds 96.94% of the targets.', ctx()))).toEqual(['bad_latex:block']);
  });
});

describe('gateSentence: citations and references', () => {
  it('replaces an unknown \\cite by [ref]', () => {
    const r = gateSentence('Earlier trackers were tuned on prompt tracks~\\cite{Smith2019}.', ctx());
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['unknown_cite:block']);
    expect(r.repaired).toBe('Earlier trackers were tuned on prompt tracks~[ref].');
    expect(r.citeKeys).toEqual([]);
    expect(r.placeholders).toEqual(['[ref]']);
  });

  it('keeps the known keys of a mixed \\cite', () => {
    const r = gateSentence('Both were studied~\\cite{Wang2022LRT,Smith2019}.', ctx());
    expect(r.repaired).toBe('Both were studied~\\cite{Wang2022LRT}~[ref].');
    expect(r.citeKeys).toEqual(['Wang2022LRT']);
  });

  it('accepts allowed cites and reports them', () => {
    const r = gateSentence('Their large-radius extension was studied by Wang et al.~\\cite{Wang2022LRT}.', ctx());
    expect(r.ok).toBe(true);
    expect(r.citeKeys).toEqual(['Wang2022LRT']);
  });

  it('blocks literal reference numbers', () => {
    for (const lit of ['as shown in [12].', 'earlier studies~[3, 4] did not.', 'see Refs.~[5--7].']) {
      const r = gateSentence(`The method fails, ${lit}`, ctx());
      expect(codes(r), lit).toContain('unknown_cite:block');
      expect(r.repaired).toContain('[ref]');
    }
    // intervals and optional arguments are not citations
    expect(codes(gateSentence('The bins [1, 3] and [0, 0.1) are used, and \\cite[3]{Wang2022LRT} too.', ctx())).filter((c) => c.startsWith('unknown_cite'))).toEqual([]);
  });

  it('accepts a confidence level documented by a limit fact', () => {
    const limit = fact({ id: 'f.limit.mass', value: 1.15, unit: 'TeV', definition: 'Observed 95% CL lower limit on the scalar mass', tags: ['limit'] });
    const s = 'Masses below 1.15~TeV are excluded at 95\\%~CL.';
    expect(codes(gateSentence(s, ctx({ facts: [...FACTS, limit] })))).toEqual([]);
    expect(codes(gateSentence('Masses below 1.15~TeV are excluded at 99\\%~CL.', ctx({ facts: [...FACTS, limit] })))).toEqual(['unmatched_number:block']);
    expect(gateSentence(s, ctx()).ok).toBe(false);
  });

  it('blocks an unknown \\ref target', () => {
    const r = gateSentence('Section~\\ref{sec:method} describes it, and Fig.~\\ref{fig:missing} shows it.', ctx());
    expect(codes(r)).toEqual(['unknown_ref:block']);
    expect(r.issues[0]!.raw).toBe('\\ref{fig:missing}');
    expect(r.repaired).toBe('Section~\\ref{sec:method} describes it, and Fig.~[ref target fig:missing?] shows it.');
  });
});

describe('gateSentence: LaTeX invariance', () => {
  const original = 'Machine-learning pipelines such as Exa.TrkX were built for prompt tracks, and their large-radius extension was studied by Wang et al.~\\cite{Wang2022LRT}.';

  it('accepts a rewrite that keeps notation', () => {
    const r = gateSentence('Wang et al.~\\cite{Wang2022LRT} studied the large-radius extension of pipelines such as Exa.TrkX, which were built for prompt tracks.', ctx({ mode: 'rewrite', original }));
    expect(codes(r)).toEqual([]);
  });

  it('blocks a rewrite that drops a \\cite', () => {
    const r = gateSentence('Pipelines such as Exa.TrkX were built for prompt tracks and later extended to large radii.', ctx({ mode: 'rewrite', original }));
    expect(codes(r)).toEqual(['latex_changed:block']);
    expect(r.issues[0]!.message).toContain('cite:Wang2022LRT');
  });

  it('blocks a grammar fix that changes math', () => {
    const r = gateSentence('A target particle has $p_T \\geq 1$~GeV.', ctx({ mode: 'grammar', original: 'A target particle have $p_T > 1$~GeV.' }));
    expect(codes(r)).toContain('latex_changed:block');
  });

  it('warns when a rewrite drops a number', () => {
    const r = gateSentence('The test set is large.', ctx({ mode: 'rewrite', original: 'The test set holds 8,710 targets.' }));
    expect(codes(r)).toEqual(['number_changed:warn']);
  });
});

describe('gateSentence: text sanity', () => {
  it('blocks Chinese characters', () => {
    const r = gateSentence('The tracker finds more targets（效率更高）.', ctx());
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('cjk_in_text:block');
  });

  it('blocks reasoning leaks and markdown', () => {
    for (const s of [
      'Let me write the next sentence: the tracker finds more targets.',
      'Here is the sentence: The tracker finds more targets.',
      'Sure! The tracker finds more targets.',
      'I will now state the result.',
      '- The tracker finds more targets.',
      '* The tracker finds more targets.',
      '1. The tracker finds more targets.',
      '**Result:** the tracker finds more targets.',
      '"The tracker finds more targets."',
      'The tracker finds more targets, as `eff_A` shows.',
      'Sentence: The tracker finds more targets.',
    ]) {
      const r = gateSentence(s, ctx({ facts: [] }));
      expect(codes(r), s).toContain('reasoning_leak:block');
    }
    // LaTeX quotes are fine
    expect(codes(gateSentence('We call this ``double majority\'\' matching.', ctx()))).toEqual([]);
  });

  it('blocks a ghost sentence over 35 words, warns elsewhere', () => {
    const long = 'The tracker that we trained only on generic top-quark pair events without any signal finds more of the isolated displaced particles than the baseline that was trained directly on the signal sample it is evaluated on today here.';
    expect(long.split(/\s+/).length).toBeGreaterThan(35);
    const g = gateSentence(long, ctx({ mode: 'ghost' }));
    expect(codes(g)).toContain('too_long:block');
    expect(g.ok).toBe(false);
    expect(codes(gateSentence(long, ctx({ mode: 'draft', maxWords: 35 })))).toContain('too_long:warn');
    expect(codes(gateSentence(long, ctx({ mode: 'draft' }))).filter((c) => c.startsWith('too_long'))).toEqual([]);
    expect(codes(gateSentence('A short sentence with $x = y$ and \\cite{Wang2022LRT}.', ctx({ mode: 'ghost' })))).toEqual([]);
  });

  it('blocks empty output', () => {
    for (const s of ['', '   ', '% only a comment']) expect(codes(gateSentence(s, ctx()))).toEqual(['empty:block']);
  });
});

describe('gateSentence: claim strength and placeholders', () => {
  it('warns on "We exclude" without a CL limit fact', () => {
    const r = gateSentence('We exclude long-lived scalars in this mass range.', ctx());
    expect(codes(r)).toEqual(['claim_strength:warn']);
    expect(r.ok).toBe(true);
    const limit = fact({ id: 'f.limit.mass', value: 1.15, unit: 'TeV', definition: 'Observed 95% CL lower limit on the scalar mass', tags: ['limit'] });
    const ok = gateSentence('We exclude long-lived scalars below 1.15~TeV.', ctx({ facts: [...FACTS, limit] }));
    expect(codes(ok)).toEqual([]);
    const weak = fact({ id: 'f.limit.weak', value: 1.15, unit: 'TeV', definition: 'expected limit at 90% CL', tags: ['limit'] });
    expect(codes(gateSentence('We exclude long-lived scalars below 1.15~TeV.', ctx({ facts: [...FACTS, weak] })))).toEqual(['claim_strength:warn']);
    // selection, negation: not exclusion claims
    expect(codes(gateSentence('Four corrupted events are excluded from the test set.', ctx()))).toEqual([]);
    expect(codes(gateSentence('We cannot exclude this scenario.', ctx()))).toEqual([]);
  });

  it('warns on "demonstrate" without a reproduced fact', () => {
    const s = 'We demonstrate that the tracker finds 96.94\\% of the targets.';
    expect(codes(gateSentence(s, ctx()))).toEqual(['claim_strength:warn']);
    const facts = FACTS.map((f) => (f.id === 'f.g1.eff_A' ? { ...f, validationState: 'reproduced' as const } : f));
    expect(codes(gateSentence(s, ctx({ facts })))).toEqual([]);
  });

  it('warns on a result verb with no number or placeholder', () => {
    expect(codes(gateSentence('The new tracker performs better than the baseline.', ctx()))).toEqual(['claim_strength:warn']);
    expect(codes(gateSentence('The new tracker performs better than the baseline by 2.32~points.', ctx()))).toEqual([]);
    expect(codes(gateSentence('The new tracker performs better than the baseline by [fact?: size of the gain].', ctx()))).toEqual([]);
    expect(codes(gateSentence('Higher-order corrections are small.', ctx()))).toEqual([]);
  });

  it('warns on duplicate placeholders', () => {
    const r = gateSentence('It improves by [factor?] and by [factor?].', ctx());
    expect(codes(r)).toEqual(['duplicate_placeholder:warn']);
    expect(r.placeholders).toEqual(['[factor?]', '[factor?]']);
  });
});

describe('gateSentence: the fixture paper', () => {
  function sentences(): string[] {
    return segment(MAIN).sentences.map((s) => s.text);
  }

  it('passes every sentence of the fixture with no blocking issue', () => {
    const all = sentences();
    expect(all.length).toBeGreaterThan(10);
    for (const s of all) {
      const r = gateSentence(s, ctx({ mode: 'draft' }));
      expect(r.issues.filter((i) => i.severity === 'block'), s).toEqual([]);
      expect(r.repaired).toBe(s);
    }
  });

  it('is fast: well under 5 ms per sentence', () => {
    const all = sentences();
    const t0 = performance.now();
    for (let k = 0; k < 20; k++) for (const s of all) gateSentence(s, ctx({ mode: 'ghost', maxWords: null }));
    expect((performance.now() - t0) / (20 * all.length)).toBeLessThan(5);
  });
});

describe('gateSentence: robustness', () => {
  it('never throws on odd input', () => {
    const odd: unknown[] = [undefined, null, 42, '\\', '$', '{{{', '\\cite{', '\\SI{', '10^{', '[fact?:', '\u0000\u0001', 'x'.repeat(5000), '$'.repeat(99)];
    for (const s of odd) {
      expect(() => gateSentence(s as string, ctx())).not.toThrow();
      expect(() => gateSentence(s as string, {} as GateContext)).not.toThrow();
      expect(() => gateSentence(s as string, null as unknown as GateContext)).not.toThrow();
    }
    const r = gateSentence('The tracker finds 97.3\\% of them.', { mode: 'ghost' } as GateContext);
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['unmatched_number:block']);
  });
});
