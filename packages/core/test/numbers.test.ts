import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractNumerals, factAliases, linkSentenceFacts, matchNumeral, precisionOf, renderFact, type NumeralToken } from '../src/facts/numbers';
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

/** Facts as the extractor builds them from the claim JSON (paired uncertainties folded into the value). */
const CLAIM_FACTS: Fact[] = [
  fact({ id: 'f.g1.n_targets', value: CLAIM.n_targets!, tags: ['count', 'claim'] }),
  fact({ id: 'f.g1.eff_A', value: CLAIM.eff_A!, tags: ['fraction', 'claim'] }),
  fact({ id: 'f.g1.eff_B', value: CLAIM.eff_B!, tags: ['fraction', 'claim'] }),
  fact({
    id: 'f.g1.delta_points',
    value: CLAIM.delta_points!,
    unit: 'points',
    uncertainties: { total: CLAIM.sigma_points!, boot: CLAIM.sigma_boot_points!, seeds: CLAIM.sigma_seeds_points! },
    tags: ['claim'],
  }),
  fact({ id: 'f.g1.delta_minus_2sigma', value: CLAIM.delta_minus_2sigma!, unit: 'points' }),
  fact({ id: 'f.g1.delta_plus_2sigma', value: CLAIM.delta_plus_2sigma!, unit: 'points' }),
  fact({ id: 'f.g1.margin', value: CLAIM.margin! }),
  fact({ id: 'f.g1.fake_rate_A', value: CLAIM.fake_rate_A!, tags: ['fraction', 'claim'] }),
  fact({ id: 'f.g1.fake_rate_B', value: CLAIM.fake_rate_B!, tags: ['fraction', 'claim'] }),
  fact({ id: 'f.g1.fake_rate_diff_points', value: CLAIM.fake_rate_diff_points!, unit: 'points' }),
];
const CUT_FACTS: Fact[] = [
  fact({ id: 'f.definitions.pT_gt_1GeV', kind: 'cut', value: 1, unit: 'GeV', tags: ['cut', 'cmp:gt'], artifact: 'docs/definitions.md', locator: 'md:line=56' }),
  fact({ id: 'f.definitions.abs_eta_lt_4', kind: 'cut', value: 4, unit: '', tags: ['cut', 'cmp:lt'], artifact: 'docs/definitions.md', locator: 'md:line=56' }),
  fact({ id: 'f.definitions.ge_5_space_points', kind: 'cut', value: 5, unit: '', tags: ['cut', 'cmp:ge'], artifact: 'docs/definitions.md', locator: 'md:line=56' }),
];
/** The CSV row of the same tracker repeats eff_A as `mean`, with its uncertainties. */
const CSV_FACTS: Fact[] = [
  fact({ id: 'f.addendum_g_g1_v1.canto_l_ttbar.mean', value: 0.9694221201683888, uncertainties: { boot: 0.0018096711939944463, seeds: 0.0025603870927941213, total: 0.0023366865112851992 }, tags: ['fraction'], artifact: 'results/addendum_g_g1_v1.csv', locator: 'csv:row=1;col=mean' }),
  fact({ id: 'f.addendum_g_g1_v1.canto_l_ttbar.n', value: 8710, tags: ['count'], artifact: 'results/addendum_g_g1_v1.csv', locator: 'csv:row=1;col=n' }),
];
const FACTS = [...CLAIM_FACTS, ...CUT_FACTS];

const nums = (s: string): Array<Partial<NumeralToken>> =>
  extractNumerals(s).map((t) => ({ raw: t.raw, value: t.value, percent: t.percent, points: t.points, unit: t.unit, isUncertainty: t.isUncertainty, structural: t.structural }));

describe('precisionOf', () => {
  it('counts decimals and significant figures as written', () => {
    expect(precisionOf('0.0550')).toEqual({ decimals: 4, sigfigs: 3 });
    expect(precisionOf('2.32')).toEqual({ decimals: 2, sigfigs: 3 });
    expect(precisionOf('8,710')).toEqual({ decimals: 0, sigfigs: 3 });
    expect(precisionOf('8{,}710')).toEqual({ decimals: 0, sigfigs: 3 });
    expect(precisionOf('96.94')).toEqual({ decimals: 2, sigfigs: 4 });
    expect(precisionOf('1.2\\times10^{-4}')).toEqual({ decimals: 1, sigfigs: 2 });
    expect(precisionOf('10^8')).toEqual({ decimals: 0, sigfigs: 1 });
    expect(precisionOf('-0.83')).toEqual({ decimals: 2, sigfigs: 2 });
    expect(precisionOf('.5')).toEqual({ decimals: 1, sigfigs: 1 });
    expect(precisionOf('100.0')).toEqual({ decimals: 1, sigfigs: 4 });
    expect(precisionOf('abc')).toEqual({ decimals: 0, sigfigs: 0 });
  });
});

describe('extractNumerals', () => {
  it('reads percents, points and uncertainties of the fixture results', () => {
    expect(nums('it finds 96.94\\% of the targets, compared with 94.62\\%')).toEqual([
      { raw: '96.94', value: 96.94, percent: true, points: false, unit: null, isUncertainty: false, structural: false },
      { raw: '94.62', value: 94.62, percent: true, points: false, unit: null, isUncertainty: false, structural: false },
    ]);
    expect(nums('the tracker finds 2.32~$\\pm$~0.28 points more')).toEqual([
      { raw: '2.32', value: 2.32, percent: false, points: true, unit: null, isUncertainty: false, structural: false },
      { raw: '0.28', value: 0.28, percent: false, points: true, unit: null, isUncertainty: true, structural: false },
    ]);
    const t = extractNumerals('finds 2.32~$\\pm$~0.28 points')[1]!;
    expect(t.inMath).toBe(false);
    expect(extractNumerals('has $p_T > 1$~GeV')[0]!.inMath).toBe(true);
    expect('finds 2.32~$\\pm$~0.28 points'.slice(t.start, t.end)).toBe('0.28');
  });

  it('parses thousands separators, siunitx and scientific forms', () => {
    const r = extractNumerals('The set holds 8,710 targets, 8{,}710 and 8\\,710, \\num{8710}, \\SI{30}{\\GeV}, $1.2\\times10^{-4}$, 10^8, $10^{8}$, 1.2e-3.');
    expect(r.map((t) => [t.raw, t.value, t.unit])).toEqual([
      ['8,710', 8710, null],
      ['8{,}710', 8710, null],
      ['8\\,710', 8710, null],
      ['8710', 8710, null],
      ['30', 30, 'GeV'],
      ['1.2\\times10^{-4}', 0.00012, null],
      ['10^8', 1e8, null],
      ['10^{8}', 1e8, null],
      ['1.2e-3', 0.0012, null],
    ]);
    expect(r.every((t) => !t.structural)).toBe(true);
    const sci = r[5]!;
    expect(sci.decimals).toBe(1);
    expect(sci.sigfigs).toBe(2);
  });

  it('reads units in all their LaTeX spellings', () => {
    const units = extractNumerals('$p_T > 1$~GeV, 30\\,\\mathrm{mm}, 5 mm, $30\\,\\text{GeV}$, 13~TeV, 300~fb$^{-1}$, $3~\\mathrm{ab}^{-1}$, 2~T, 5\\sigma, 10~ns, \\SI{1.5}{\\milli\\metre}, 2.5\\,\\si{\\micro\\metre}').map((t) => t.unit);
    expect(units).toEqual(['GeV', 'mm', 'mm', 'GeV', 'TeV', 'fb^-1', 'ab^-1', 'T', 'σ', 'ns', 'mm', 'µm']);
  });

  it('marks structural numbers', () => {
    const s = 'See Sec.~3, Fig.~2, Table~I, Eq.~(4), Ref.~[12], (i) and (ii), in 2024~\\cite{Wang2022LRT}, Wang et al. (2022), (1) first, the 1st step, 3 seeds, Figs.~2 and 5, version 1.2.3.';
    const r = extractNumerals(s);
    expect(r.map((t) => [t.raw, t.structural])).toEqual([
      ['3', true],
      ['2', true],
      ['4', true],
      ['12', true],
      ['2024', true],
      ['2022', true],
      ['1', true],
      ['1', true],
      ['3', true],
      ['2', true],
      ['5', true],
    ]);
  });

  it('keeps non-structural integers and decimals', () => {
    const r = extractNumerals('We use 12 seeds, 2.0 GeV, 3 GeV, 5\\% and a 2-fold gain in 2024 the LHC ran on a sample of 2024 events.');
    expect(r.map((t) => [t.raw, t.structural])).toEqual([
      ['12', false],
      ['2.0', false],
      ['3', false],
      ['5', false],
      ['2', false],
      ['2024', true],
      ['2024', false],
    ]);
    expect(extractNumerals('collected in 2024 events')[0]!.structural).toBe(false);
  });

  it('never reads keys, macro names, options, identifiers, scripts or comments', () => {
    expect(extractNumerals('Studied by Wang et al.~\\cite{Wang2022LRT} in Fig.~\\ref{fig:2} \\label{eq:3}.')).toEqual([]);
    expect(extractNumerals('\\cite[p.~3]{x} \\\\[2pt] \\begin{figure}[t] \\includegraphics[width=0.8\\linewidth]{fig2.pdf} \\hspace{2pt} \\SI[round-precision=3]{}{}')).toEqual([]);
    expect(extractNumerals('The T1 deviation 13a, eff_s0, 3D, H2, $p_{T,1}$, $x^{2}$, ttbar\\_10K, 1990s.')).toEqual([]);
    expect(extractNumerals('Text. % 97.3 in a comment\nNext.')).toEqual([]);
    expect(extractNumerals('A placeholder [fact?: the 97.3 value] stays.')).toEqual([]);
  });

  it('reads signs, asymmetric and compact uncertainties, ranges and factors', () => {
    expect(nums('a difference of $-0.83$ points')).toEqual([{ raw: '-0.83', value: -0.83, percent: false, points: true, unit: null, isUncertainty: false, structural: false }]);
    expect(nums('the range 0.052-0.061 mm').map((t) => [t.raw, t.value, t.unit])).toEqual([
      ['0.052', 0.052, 'mm'],
      ['0.061', 0.061, 'mm'],
    ]);
    expect(nums('$2.3^{+0.3}_{-0.2}$~GeV').map((t) => [t.raw, t.isUncertainty, t.unit])).toEqual([
      ['2.3', false, 'GeV'],
      ['0.3', true, 'GeV'],
      ['0.2', true, 'GeV'],
    ]);
    expect(nums('$(2.32 \\pm 0.28)\\%$').map((t) => [t.raw, t.percent, t.isUncertainty])).toEqual([
      ['2.32', true, false],
      ['0.28', true, true],
    ]);
    expect(nums('20--30\\% of the hits').map((t) => [t.raw, t.percent])).toEqual([
      ['20', true],
      ['30', true],
    ]);
  });

  it('applies multipliers: 10k, 1.5 million', () => {
    expect(extractNumerals('trained on 10k events and 1.5 million tracks, 2 thousand toys').map((t) => [t.raw, t.value, t.structural])).toEqual([
      ['10', 10000, false],
      ['1.5', 1.5e6, false],
      ['2', 2000, false],
    ]);
    const f = [{ id: 'f.n', kind: 'number', value: 1.52e6, sigfigs: null, unit: '', uncertainties: {}, definition: '', definitionSource: '', artifact: '', locator: '', artifactSha256: '', fingerprint: '', stale: false, validationState: 'candidate', aliases: [], confirmed: true, excluded: false, proseOnly: false, tags: [] } as Fact];
    expect(matchNumeral(extractNumerals('1.5 million tracks')[0]!, f)).toEqual([{ factId: 'f.n', field: 'value', scale: 1 }]);
  });

  it('keeps ordinary words that look structural from hiding numbers', () => {
    expect(extractNumerals('We run 100 toys; in this case 30 seeds; Fig.~2 and 300 events.').map((t) => [t.raw, t.structural])).toEqual([
      ['100', false],
      ['30', false],
      ['2', true],
      ['300', false],
    ]);
    expect(extractNumerals('LHC Run 2 and Case 3, Stage 1.').every((t) => t.structural)).toBe(true);
    expect(extractNumerals('the efficiency (95) and item (2)').map((t) => [t.raw, t.structural])).toEqual([
      ['95', false],
      ['2', true],
    ]);
  });

  it('treats a bare % after a digit as a percent sign', () => {
    expect(nums('it finds 97% of them')[0]).toMatchObject({ raw: '97', percent: true });
  });

  it('reads numbers in a Chinese intent note', () => {
    expect(extractNumerals('效率提高了2.3个百分点，共8710个').map((t) => t.value)).toEqual([2.3, 8710]);
  });

  it('never throws', () => {
    for (const s of ['', '1', '.', '1.', '1,', '{,}', '10^', '10^{', '$-$', '\\SI{', '\\num', '1e', '9'.repeat(400), '1.2.3.4']) expect(() => extractNumerals(s)).not.toThrow();
    expect(extractNumerals(null as unknown as string)).toEqual([]);
  });

  it('is fast enough for every keystroke debounce', () => {
    const s = 'On the isolated gun particles, the tracker finds 2.32~$\\pm$~0.28 points more than acorn (HNL) with 96.94\\% and 8,710 targets~\\cite{x}. ';
    const t0 = performance.now();
    for (let i = 0; i < 500; i++) extractNumerals(s);
    expect((performance.now() - t0) / 500).toBeLessThan(2);
  });
});

describe('matchNumeral', () => {
  const tok = (s: string, i = 0): NumeralToken => extractNumerals(s)[i]!;

  it('matches a fraction written as a percent at scale 100', () => {
    expect(matchNumeral(tok('finds 96.94\\% of'), FACTS)).toEqual([{ factId: 'f.g1.eff_A', field: 'value', scale: 100 }]);
    expect(matchNumeral(tok('a rate of 0.55\\%'), FACTS)).toEqual([{ factId: 'f.g1.fake_rate_A', field: 'value', scale: 100 }]);
    expect(matchNumeral(tok('a rate of 1.38\\%'), FACTS)).toEqual([{ factId: 'f.g1.fake_rate_B', field: 'value', scale: 100 }]);
    expect(matchNumeral(tok('finds 97\\%'), FACTS).map((m) => m.factId)).toEqual(['f.g1.eff_A']);
    expect(matchNumeral(tok('below 1\\%'), FACTS).map((m) => m.factId)).toEqual(['f.g1.fake_rate_A', 'f.g1.fake_rate_B']);
  });

  it('matches a fraction written as a fraction, but not a bare percent value', () => {
    expect(matchNumeral(tok('an efficiency of 0.9694'), FACTS)).toEqual([{ factId: 'f.g1.eff_A', field: 'value', scale: 1 }]);
    expect(matchNumeral(tok('an efficiency of 96.94'), FACTS)).toEqual([]);
    expect(matchNumeral(tok('an efficiency of 0.97\\%'), FACTS)).toEqual([]);
    expect(matchNumeral(tok('an efficiency of 97.0\\%'), FACTS)).toEqual([]);
  });

  it('matches points facts and their uncertainties at scale 1', () => {
    expect(matchNumeral(tok('finds 2.32~$\\pm$~0.28 points'), FACTS)).toEqual([{ factId: 'f.g1.delta_points', field: 'value', scale: 1 }]);
    expect(matchNumeral(tok('finds 2.32~$\\pm$~0.28 points', 1), FACTS)).toEqual([{ factId: 'f.g1.delta_points', field: 'unc:total', scale: 1 }]);
    expect(matchNumeral(tok('finds 2.3 points'), FACTS)).toEqual([{ factId: 'f.g1.delta_points', field: 'value', scale: 1 }]);
    // percent versus percentage points
    expect(matchNumeral(tok('finds 2.32\\% more'), FACTS)).toEqual([]);
    // a magnitude may be written without the sign; a wrong sign never matches
    expect(matchNumeral(tok('lower by 0.83 points'), FACTS)).toEqual([{ factId: 'f.g1.fake_rate_diff_points', field: 'value', scale: 1 }]);
    expect(matchNumeral(tok('a change of $-2.32$ points'), FACTS)).toEqual([]);
  });

  it('matches integer counts exactly', () => {
    for (const s of ['8,710 targets', '8{,}710 targets', '\\num{8710} targets', '8710 targets']) expect(matchNumeral(tok(s), FACTS)).toEqual([{ factId: 'f.g1.n_targets', field: 'value', scale: 1 }]);
    expect(matchNumeral(tok('8,700 targets'), FACTS)).toEqual([]);
    expect(matchNumeral(tok('8,711 targets'), FACTS)).toEqual([]);
    // a power of ten is an explicit order-of-magnitude rounding
    expect(matchNumeral(tok('$10^{4}$ targets'), FACTS)).toEqual([{ factId: 'f.g1.n_targets', field: 'value', scale: 1 }]);
    expect(matchNumeral(tok('$10^{5}$ targets'), FACTS)).toEqual([]);
  });

  it('requires units to agree when both are known', () => {
    expect(matchNumeral(tok('$p_T > 1$~GeV'), FACTS)).toEqual([{ factId: 'f.definitions.pT_gt_1GeV', field: 'value', scale: 1 }]);
    expect(matchNumeral(tok('$p_T > 1$~MeV'), FACTS)).toEqual([]);
    expect(matchNumeral(tok('\\SI{1}{\\GeV}'), FACTS)).toEqual([{ factId: 'f.definitions.pT_gt_1GeV', field: 'value', scale: 1 }]);
    // a numeral without a unit may stand for a fact with one
    expect(matchNumeral(tok('$p_T > 1.0$'), FACTS).map((m) => m.factId)).toContain('f.definitions.pT_gt_1GeV');
  });

  it('never matches excluded facts or string values', () => {
    const ex = FACTS.map((f) => (f.id === 'f.g1.eff_A' ? { ...f, excluded: true } : f));
    expect(matchNumeral(tok('finds 96.94\\%'), ex)).toEqual([]);
    expect(matchNumeral(tok('finds 96.94\\%'), [fact({ id: 'd', kind: 'definition', value: 'generic_iso union test' })])).toEqual([]);
    expect(matchNumeral(tok('finds 96.94\\%'), [])).toEqual([]);
  });

  it('matches scientific notation at the written precision', () => {
    const tiny = fact({ id: 'f.rate', value: 0.000123, unit: '' });
    expect(matchNumeral(tok('$1.2\\times10^{-4}$'), [tiny])).toEqual([{ factId: 'f.rate', field: 'value', scale: 1 }]);
    expect(matchNumeral(tok('$1.3\\times10^{-4}$'), [tiny])).toEqual([]);
    const big = fact({ id: 'f.lumi', value: 1.04e8, unit: '' });
    expect(matchNumeral(tok('10^8 events'), [big])).toEqual([{ factId: 'f.lumi', field: 'value', scale: 1 }]);
  });
});

describe('factAliases and renderFact', () => {
  it('renders a fraction as fraction and percent at 2-4 significant figures', () => {
    const a = factAliases(fact({ id: 'x', value: 0.96942 }));
    expect(a).toEqual(['0.97', '0.969', '0.9694', '97%', '96.9%', '96.94%']);
  });

  it('respects sigfigs and renders uncertainties at the same decimals', () => {
    const d = { ...CLAIM_FACTS.find((f) => f.id === 'f.g1.delta_points')!, sigfigs: 3 };
    expect(factAliases(d)).toEqual(['2.3 points', '2.3 ± 0.3 points', '2.32 points', '2.32 ± 0.28 points']);
    const csv = CSV_FACTS[0]!;
    expect(factAliases(csv)).toContain('96.94 ± 0.23%');
  });

  it('renders counts with and without thousands separators', () => {
    expect(factAliases(CLAIM_FACTS[0]!)).toEqual(['8,710', '8710']);
    expect(factAliases(CUT_FACTS[0]!)).toEqual(['1 GeV']);
    expect(factAliases(fact({ id: 's', kind: 'definition', value: 'text' }))).toEqual([]);
  });

  it('renders one-line chips', () => {
    expect(renderFact(CLAIM_FACTS.find((f) => f.id === 'f.g1.delta_points')!)).toBe('f.g1.delta_points = 2.32 ± 0.28 points');
    expect(renderFact(CLAIM_FACTS.find((f) => f.id === 'f.g1.eff_A')!)).toBe('f.g1.eff_A = 0.9694 (96.94%)');
    expect(renderFact(CSV_FACTS[0]!)).toBe('f.addendum_g_g1_v1.canto_l_ttbar.mean = 0.9694 ± 0.0023 (96.94 ± 0.23%)');
    expect(renderFact(CLAIM_FACTS[0]!)).toBe('f.g1.n_targets = 8,710');
    expect(renderFact(CUT_FACTS[0]!)).toBe('f.definitions.pT_gt_1GeV: > 1 GeV');
    expect(renderFact(fact({ id: 'f.def', kind: 'definition', value: 'generic_iso union test' }))).toBe('f.def = generic_iso union test');
    expect(renderFact(fact({ id: 'f.tiny', value: 0.000123 }))).toBe('f.tiny = 1.23×10^-4');
  });

  it('every alias of a fact links back to that fact', () => {
    for (const f of [...CLAIM_FACTS, ...CUT_FACTS]) {
      for (const alias of factAliases(f)) {
        const latex = alias.replace(/%/g, '\\%');
        const linked = linkSentenceFacts(`The value is ${latex}.`, [f]);
        const toks = extractNumerals(`The value is ${latex}.`).filter((t) => !t.structural);
        if (toks.length) expect(linked.linked, `${f.id} alias ${alias}`).toEqual([f.id]);
      }
    }
  });
});

describe('linkSentenceFacts', () => {
  it('links delta_points and its uncertainty', () => {
    const r = linkSentenceFacts('On the isolated gun particles, the tracker finds 2.32~$\\pm$~0.28 points more than acorn (HNL) with the same track builder; see Fig.~\\ref{fig:eff}.', FACTS);
    expect(r).toEqual({ linked: ['f.g1.delta_points'], unmatched: [], ambiguous: [] });
  });

  it('reports an invented uncertainty as unmatched even when the value links', () => {
    const r = linkSentenceFacts('The tracker finds 2.32~$\\pm$~0.35 points more.', FACTS);
    expect(r.linked).toEqual(['f.g1.delta_points']);
    expect(r.unmatched.map((t) => t.raw)).toEqual(['0.35']);
  });

  it('links a cut, including a structural-looking bound in a comparison', () => {
    const r = linkSentenceFacts('A target particle has $p_T > 1$~GeV, $|\\eta| < 4$ and at least five space points.', FACTS);
    // "at least five space points" is the cut f.definitions.ge_5_space_points, written in words
    expect(r).toEqual({ linked: ['f.definitions.pT_gt_1GeV', 'f.definitions.abs_eta_lt_4', 'f.definitions.ge_5_space_points'], unmatched: [], ambiguous: [] });
  });

  it('reports ambiguity and resolves it with prefer or with the uncertainty', () => {
    const facts = [...FACTS, ...CSV_FACTS];
    const s = 'It finds 96.94\\% of the 8,710 targets.';
    const r = linkSentenceFacts(s, facts);
    expect(r.linked).toEqual([]);
    expect(r.unmatched).toEqual([]);
    expect(r.ambiguous.map((a) => [a.token.raw, a.candidates])).toEqual([
      ['96.94', ['f.g1.eff_A', 'f.addendum_g_g1_v1.canto_l_ttbar.mean']],
      ['8,710', ['f.g1.n_targets', 'f.addendum_g_g1_v1.canto_l_ttbar.n']],
    ]);
    expect(linkSentenceFacts(s, facts, ['f.g1.eff_A', 'f.g1.n_targets']).linked).toEqual(['f.g1.eff_A', 'f.g1.n_targets']);
    // only the CSV row carries the uncertainty 0.23 (percent), so the value resolves to it
    expect(linkSentenceFacts('It finds $(96.94 \\pm 0.23)\\%$.', facts)).toEqual({ linked: ['f.addendum_g_g1_v1.canto_l_ttbar.mean'], unmatched: [], ambiguous: [] });
  });

  it('flags an invented number and a percent written without % for a fraction', () => {
    expect(linkSentenceFacts('It finds 97.3\\% of the targets.', FACTS).unmatched.map((t) => t.raw)).toEqual(['97.3']);
    expect(linkSentenceFacts('It finds 96.94 of the targets.', FACTS).unmatched.map((t) => t.raw)).toEqual(['96.94']);
  });

  it('ignores structural numbers', () => {
    expect(linkSentenceFacts('Section~3 and Fig.~2 show it, as in 2024~\\cite{x}; see Table~I and Eq.~(4), item (ii).', FACTS)).toEqual({ linked: [], unmatched: [], ambiguous: [] });
  });

  function fixtureSentences(): string[] {
    try {
      const seg = segment(MAIN);
      if (seg.sentences.length > 0) return seg.sentences.map((s) => s.text);
    } catch {
      /* segmenter not ready: fall back to one sentence per line */
    }
    const body = MAIN.slice(MAIN.indexOf('\\begin{document}'), MAIN.indexOf('\\end{document}'));
    return body.split('\n').filter((l) => l.trim() && !/^\s*[\\%]/.test(l) && !l.includes('&'));
  }

  it('links every numeral of the fixture paper (abstract, Method, Results) with zero unmatched', () => {
    const sentences = fixtureSentences().filter((s) => /\d/.test(s.replace(/\\(?:cite|ref|label|eqref)\{[^}]*\}/g, '')));
    expect(sentences.length).toBeGreaterThanOrEqual(4);
    const allLinked = new Set<string>();
    for (const s of sentences) {
      const r = linkSentenceFacts(s, FACTS);
      expect(r.unmatched.map((t) => t.raw), s).toEqual([]);
      expect(r.ambiguous, s).toEqual([]);
      r.linked.forEach((id) => allLinked.add(id));
    }
    for (const id of ['f.g1.eff_A', 'f.g1.eff_B', 'f.g1.fake_rate_A', 'f.g1.fake_rate_B', 'f.g1.delta_points', 'f.g1.n_targets', 'f.definitions.pT_gt_1GeV']) expect(allLinked.has(id), id).toBe(true);
    // with the CSV duplicates, nothing becomes unmatched (some numerals become ambiguous)
    for (const s of sentences) expect(linkSentenceFacts(s, [...FACTS, ...CSV_FACTS]).unmatched, s).toEqual([]);
  });

  it('never throws', () => {
    expect(linkSentenceFacts(undefined as unknown as string, FACTS)).toEqual({ linked: [], unmatched: [], ambiguous: [] });
    expect(linkSentenceFacts('1.5 GeV', null as unknown as Fact[])).toEqual({ linked: [], unmatched: [extractNumerals('1.5 GeV')[0]], ambiguous: [] });
  });
});
