/**
 * Terminology report (consistency/terms.ts): acronym first use versus definition across \input files,
 * and spelling variants of one term (hyphen / open / closed, capitalization, US versus UK), on the
 * fixture papers and on small hand-written sources.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TerminologyReport } from '../src/api';
import { findAcronymDefinitions, findAcronymUses, isAcronym, KNOWN_ACRONYMS, terminologyReport } from '../src/consistency/terms';
import { orderUnits, projectFileOrder, type ConsistencyUnit } from '../src/consistency/common';
import { segment } from '../src/latex/segment';
import type { TermEntry } from '../src/schemas';

const PERF_SLACK = process.env.CI ? 3 : 1;
const FX = (p: string): string => fileURLToPath(new URL(`../../../fixtures/${p}`, import.meta.url));

function unitsOf(file: string, text: string): ConsistencyUnit[] {
  return segment(text).sentences.map((s, i) => ({ id: `${file}#${i}`, file, line: s.line, part: s.part, kind: s.kind, sectionId: s.sectionId, text: s.text, start: s.start, end: s.end }));
}
const doc = (body: string, abstract = ''): string => `\\documentclass{revtex4-2}\n\\begin{document}\n${abstract ? `\\begin{abstract}\n${abstract}\n\\end{abstract}\n` : ''}\\maketitle\n${body}\n\\end{document}\n`;
const term = (t: string, acronym: string | null = null): TermEntry => ({ term: t, definition: '', acronym, firstUseSentenceId: null, variants: [], symbol: null });

const LARGE_FILES = ['main.tex', 'sections/intro.tex', 'sections/method.tex', 'sections/results.tex', 'sections/appendix.tex'];
const LARGE: Record<string, string> = Object.fromEntries(LARGE_FILES.map((f) => [f, readFileSync(FX(`large-multifile/tex/${f}`), 'utf8')]));
const largeUnits = (texts: Record<string, string> = LARGE): ConsistencyUnit[] => orderUnits(LARGE_FILES.flatMap((f) => unitsOf(f, texts[f]!)), projectFileOrder('main.tex', texts));

describe('acronym detection (style_check check 7 rules)', () => {
  it('finds definitions in the three style_check forms, with long forms', () => {
    expect(findAcronymDefinitions('We use a graph neural network (GNN) on hits.')).toEqual([{ acronym: 'GNN', longForm: 'graph neural network' }]);
    expect(findAcronymDefinitions('A graph-neural-network (GNN) tracker.')).toEqual([{ acronym: 'GNN', longForm: 'graph-neural-network' }]);
    expect(findAcronymDefinitions('Long-lived particles (LLPs) decay late.')[0]!.acronym).toBe('LLP');
    expect(findAcronymDefinitions('The HNL (heavy neutral lepton) decays.')[0]).toEqual({ acronym: 'HNL', longForm: 'heavy neutral lepton' });
    expect(findAcronymDefinitions('This tracker, hereafter GT, is fast.')[0]!.acronym).toBe('GT');
    expect(findAcronymDefinitions('than acorn (HNL) with the same builder')).toEqual([]);
  });

  it('reads acronym tokens as style_check does', () => {
    expect(isAcronym('GNN')).toBe(true);
    expect(isAcronym('Canto')).toBe(false);
    expect(isAcronym('IV')).toBe(false);
    expect(isAcronym('WW')).toBe(false);
    expect(isAcronym('CTEQ6L1')).toBe(false);
    expect(findAcronymUses('The SU(3) group and GNNs at the HL-LHC beat LRT.', KNOWN_ACRONYMS)).toEqual(['GNN', 'HL-LHC', 'LRT']);
  });
});

describe('terminologyReport: acronyms', () => {
  it('canto fixture: HNL is used but never defined; GeV is standard', () => {
    const r = terminologyReport(unitsOf('main.tex', readFileSync(FX('canto-demo/tex/main.tex'), 'utf8')));
    expect(() => TerminologyReport.parse(r)).not.toThrow();
    const hnl = r.acronyms.find((a) => a.acronym === 'HNL')!;
    expect(hnl).toMatchObject({ status: 'undefined', uses: 2, known: false, definition: null });
    expect(hnl.firstUse!.text).toMatch(/acorn \(HNL\) with the same track builder/);
    expect(r.acronyms.find((a) => a.acronym === 'GeV')).toMatchObject({ status: 'known', known: true });
    expect(r.flags.map((f) => f.kind)).toEqual(['acronym_undefined']);
  });

  it('flags use before definition, with both sentences, across \\input files in document order', () => {
    const texts = { ...LARGE };
    texts['sections/intro.tex'] = texts['sections/intro.tex']!.replace('We ask whether a tracker', 'We ask whether a GNN tracker');
    texts['sections/method.tex'] = texts['sections/method.tex']!.replace(/(\\section\{[^}]*\}\s*(?:\\label\{[^}]*\}\s*)?)/, '$1We use a graph neural network (GNN) throughout. ');
    const units = largeUnits(texts);
    const r = terminologyReport(units);
    const gnn = r.acronyms.find((a) => a.acronym === 'GNN')!;
    expect(gnn.status).toBe('used_before_definition');
    expect(gnn.longForm).toBe('graph neural network');
    expect(gnn.firstUse!.file).toBe('sections/intro.tex');
    expect(gnn.definition!.file).toBe('sections/method.tex');
    const f = r.flags.find((x) => x.kind === 'acronym_before_definition')!;
    expect(f.term).toBe('GNN');
    expect(f.sentenceIds.map((id) => units.find((u) => u.id === id)!.file)).toEqual(['sections/intro.tex', 'sections/method.tex']);
  });

  it('every status: abstract, captions, redefinition, defined but unused, known list', () => {
    const src = doc(
      [
        'We study long-lived particles (LLPs) with a tracker.',
        'The large-radius tracking (LRT) of ATLAS finds them.',
        'Our displaced vertex finder (DVF) is new.',
        'We compare with LRT and with the LRT seeds.',
        'A second large-radius tracking (LRT) pass is not needed.',
        'The ABC result holds.',
        '\\begin{figure}\\caption{The XYZW efficiency of a time-of-flight detector.}\\end{figure}',
        'A time-of-flight detector, the extended XYZW (XYZW) layer, helps.',
      ].join('\n\n'),
      'We search for LLPs with an MLP.',
    );
    const r = terminologyReport(unitsOf('main.tex', src), [], { known: ['MLP'] });
    const st = Object.fromEntries(r.acronyms.map((a) => [a.acronym, a.status]));
    expect(st).toMatchObject({ LLP: 'abstract_undefined', LRT: 'redefined', DVF: 'defined_unused', ABC: 'undefined', MLP: 'known', ATLAS: 'known' });
    // a caption use before the definition does not count as first use
    expect(st.XYZW).not.toBe('used_before_definition');
    expect(r.flags.filter((f) => f.kind === 'acronym_abstract_undefined').map((f) => f.term)).toEqual(['LLP']);
    const abstractOnly = terminologyReport(unitsOf('main.tex', doc('The GNN finds tracks.', 'A graph neural network (GNN) finds tracks.')));
    expect(abstractOnly.acronyms[0]).toMatchObject({ acronym: 'GNN', status: 'defined_only_in_abstract', definedInAbstract: true });
  });

  it('takes long forms from the terminology list', () => {
    const r = terminologyReport(unitsOf('main.tex', doc('The DVF runs last.')), [term('displaced vertex finder', 'DVF')]);
    expect(r.acronyms[0]).toMatchObject({ acronym: 'DVF', longForm: 'displaced vertex finder', status: 'undefined' });
  });
});

describe('terminologyReport: variants', () => {
  it('large fixture as generated: one spelling of pile-up, one -or/-our convention to report', () => {
    const t0 = performance.now();
    const r = terminologyReport(largeUnits(), [term('pile-up')]);
    expect(performance.now() - t0).toBeLessThan(500 * PERF_SLACK);
    expect(r.variants.filter((v) => v.kind === 'hyphen')).toEqual([]);
    expect(r.spelling.majority).toBe('US');
    const sp = r.variants.find((v) => v.kind === 'spelling')!;
    expect(sp.family).toBe('-or/-our');
    expect(sp.forms.map((f) => f.form)).toEqual(expect.arrayContaining(['favour', 'flavour']));
    expect(r.flags.find((f) => f.kind === 'variant_spelling')!.message).toMatch(/mostly US.*"favour"/);
  });

  it('pile-up / pileup / pile up across files: the list spelling is preferred, minorities flagged', () => {
    const texts = { ...LARGE };
    texts['sections/results.tex'] = texts['sections/results.tex']!.replace('when pile-up is added', 'when pileup is added').replace('with the pile-up study', 'with the pile up study');
    const units = largeUnits(texts);
    const r = terminologyReport(units, [term('pile-up')]);
    const row = r.variants.find((v) => v.kind === 'hyphen')!;
    expect(row).toMatchObject({ term: 'pile-up', preferred: 'pile-up', fromList: true });
    expect(Object.fromEntries(row.forms.map((f) => [f.form, f.count]))).toMatchObject({ pileup: 1, 'pile up': 1 });
    expect(row.forms[0]!.form).toBe('pile-up');
    const f = r.flags.find((x) => x.kind === 'variant_hyphen')!;
    expect(f.sentenceIds.every((id) => units.find((u) => u.id === id)!.file === 'sections/results.tex')).toBe(true);
    expect(f.sentenceIds).toHaveLength(2);
    // discovered without a list entry: the majority wins
    const r2 = terminologyReport(units);
    expect(r2.variants.find((v) => v.kind === 'hyphen')!.preferred).toBe('pile-up');
  });

  it('an attributive compound next to the open noun is not a variant', () => {
    const src = doc('The fake-track rate is low.\n\nA fake track has few hits.\n\nThe data set is large, and this dataset is ours.');
    const r = terminologyReport(unitsOf('main.tex', src));
    expect(r.variants.map((v) => v.term)).toEqual([]);
    const noun = terminologyReport(unitsOf('main.tex', doc('We fit the cross-section. The cross section is large. The cross-section is small.')));
    expect(noun.variants.map((v) => v.forms.map((f) => `${f.form} ${f.count}`))).toEqual([['cross-section 2', 'cross section 1']]);
    // "pile up" as a verb ("errors pile up") is not a variant of "pile-up" (style_check: no particle compounds)
    expect(terminologyReport(unitsOf('main.tex', doc('We add the pile-up. Errors pile up fast.'))).variants).toEqual([]);
  });

  it('capitalization of a list term mid-sentence; sentence-initial capitals do not count', () => {
    const src = doc('We use Monte Carlo samples.\n\nThe monte carlo truth is kept.\n\nMonte carlo is cheap.\n\nOur Monte Carlo runs are long.');
    const r = terminologyReport(unitsOf('main.tex', src), [term('Monte Carlo')]);
    const row = r.variants.find((v) => v.kind === 'case')!;
    expect(row.preferred).toBe('Monte Carlo');
    expect(Object.fromEntries(row.forms.map((f) => [f.form, f.count]))).toEqual({ 'Monte Carlo': 2, 'monte carlo': 1 });
    expect(r.flags.find((f) => f.kind === 'variant_case')!.sentenceIds).toEqual(['main.tex#1']);
  });

  it('US/UK: counts both conventions and flags the minority words per family', () => {
    const src = doc('We normalize the colour scale. We optimize the behavior. The centre is fixed.');
    const r = terminologyReport(unitsOf('main.tex', src));
    expect(r.spelling).toEqual({ us: 3, uk: 2, majority: 'US' });
    expect(r.flags.filter((f) => f.kind === 'variant_spelling').map((f) => f.term).sort()).toEqual(['-er/-re', '-or/-our']);
    expect(r.variants.find((v) => v.family === '-or/-our')!.preferred).toBe('behavior');
  });

  it('never throws on odd input', () => {
    expect(() => terminologyReport([], [])).not.toThrow();
    expect(() => terminologyReport(null as unknown as ConsistencyUnit[], null as unknown as TermEntry[])).not.toThrow();
    expect(() => terminologyReport(unitsOf('a.tex', '(((( ABC- -- ---( )) \\cite{'), [term('-'), term('  ')])).not.toThrow();
  });
});
