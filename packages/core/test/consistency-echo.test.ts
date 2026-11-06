/**
 * Echo check (consistency/echo.ts) on the fixture papers: fact-backed numbers per part with sentence
 * ids, drift (precision, form, value), factor versus percent, dropped conditions, stale facts, the key
 * phrase in title/abstract/contribution/conclusions and the headline with its baseline. Facts are read
 * from the fixtures' result files by a small loader shaped like the server's extractor (claim JSON
 * first, then JSON, then CSV rows; ids f.<stem>.<path>; units from name suffixes; delta_points carries
 * its sigma_*_points as uncertainties).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EchoReport } from '../src/api';
import { echoCheck, conditionPhrases } from '../src/consistency/echo';
import { extractTitle, matchPhrase, orderUnits, projectFileOrder, unitsWithText, type ConsistencyUnit } from '../src/consistency/common';
import { derivedRelations } from '../src/meta/derived';
import { segment } from '../src/latex/segment';
import { hashString } from '../src/text/hash';
import { emptyOutline, type Fact, type Outline, type SentenceUnit } from '../src/schemas';

const PERF_SLACK = process.env.CI ? 3 : 1;
const FX = (p: string): string => fileURLToPath(new URL(`../../../fixtures/${p}`, import.meta.url));

/* ------------------------------------------------------------------------------------ */
/* Fixture loading                                                                       */
/* ------------------------------------------------------------------------------------ */

const STEMS: Record<string, string> = { addendum_g_g1_v1_claim: 'g1', addendum_g_g1_v1: 'g1csv', headline_claim: 'headline' };
const UNIT_SUFFIX: Array<[RegExp, string]> = [[/_ms$/, 'ms'], [/_mm$/, 'mm'], [/_gev$/i, 'GeV'], [/_tev$/i, 'TeV'], [/_mrad$/, 'mrad'], [/_points$/, 'points']];
const unitOf = (name: string): string => UNIT_SUFFIX.find(([re]) => re.test(name))?.[1] ?? '';

function mk(p: Partial<Fact> & Pick<Fact, 'id' | 'value' | 'artifact' | 'locator'>): Fact {
  return { kind: 'number', sigfigs: null, unit: '', uncertainties: {}, definition: '', definitionSource: 'test loader', artifactSha256: 'sha', fingerprint: hashString(`${p.locator}|${String(p.value)}`), stale: false, validationState: 'candidate', aliases: [], confirmed: true, excluded: false, proseOnly: false, tags: [], ...p };
}

function loadFacts(repo: string): Fact[] {
  const dir = join(repo, 'results');
  const names = readdirSync(dir).sort((a, b) => Number(!a.endsWith('_claim.json')) - Number(!b.endsWith('_claim.json')) || Number(a.endsWith('.csv')) - Number(b.endsWith('.csv')) || (a < b ? -1 : 1));
  const out: Fact[] = [];
  for (const name of names) {
    const rel = `results/${name}`;
    const src = readFileSync(join(dir, name), 'utf8');
    const base = name.replace(/\.(json|csv)$/, '');
    const stem = STEMS[base] ?? base.replace(/_claim$/, '');
    if (name.endsWith('.json')) {
      const walk = (v: unknown, path: string[], label: string): void => {
        if (typeof v === 'number') {
          out.push(mk({ id: `f.${stem}.${path.join('.')}`, value: v, unit: unitOf(label), definition: label, artifact: rel, locator: `#/${path.join('/')}`, tags: /^n_/.test(label) && Number.isInteger(v) ? ['count'] : [] }));
        } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, String(i)], `${label}[${i}]`));
        else if (v && typeof v === 'object') {
          const obj = v as Record<string, unknown>;
          for (const [k, x] of Object.entries(obj)) walk(x, [...path, k], path.length && /^\d+$/.test(path[path.length - 1]!) ? `${label}.${k}` : k);
          // uncertainties of a difference in points: sigma_points (total), sigma_<name>_points
          for (const k of Object.keys(obj).filter((k) => /^delta.*_points$/.test(k))) {
            const f = out.find((x) => x.id === `f.${stem}.${[...path, k].join('.')}`);
            if (!f) continue;
            for (const [s, x] of Object.entries(obj)) {
              const m = /^sigma(?:_([a-z]+))?_points$/.exec(s);
              if (m && typeof x === 'number') f.uncertainties[m[1] ?? 'total'] = x;
            }
          }
        }
      };
      walk(JSON.parse(src), [], '');
    } else {
      const [head, ...rows] = src.trim().split('\n').map((l) => l.split(','));
      const cols = head!;
      const numeric = (c: string): boolean => /^-?\d+(?:\.\d+)?(?:e-?\d+)?$/i.test(c);
      const metaCols = cols.map((_, j) => j).filter((j) => !numeric(rows[0]![j] ?? ''));
      rows.forEach((r, i) => {
        const key = metaCols.length ? metaCols.map((j) => r[j]).join('.') : `r${i + 1}`;
        const meta = metaCols.map((j) => `${cols[j]}=${r[j]}`).join('; ');
        cols.forEach((c, j) => {
          if (metaCols.includes(j) || !numeric(r[j] ?? '') || /_sigma$/.test(c)) return;
          const sig = cols.indexOf(`${c}_sigma`);
          out.push(mk({ id: `f.${stem}.${key}.${c}`, value: Number(r[j]), unit: unitOf(c), definition: `${c}${meta ? ` (${meta})` : ''}`, artifact: rel, locator: `csv:row=${i + 1};col=${c}`, tags: c === 'n' ? ['count'] : [], uncertainties: sig >= 0 ? { total: Number(r[sig]) } : {} }));
        });
      });
    }
  }
  return out;
}

function unitsOf(file: string, text: string): ConsistencyUnit[] {
  const seg = segment(text);
  return seg.sentences.map((s, i) => ({ id: `${file}#${i}`, file, line: s.line, part: s.part, kind: s.kind, sectionId: s.sectionId, text: s.text, start: s.start, end: s.end }));
}

const CANTO_MAIN = readFileSync(FX('canto-demo/tex/main.tex'), 'utf8');
const CANTO_FACTS = loadFacts(FX('canto-demo/repo'));
const LARGE_FILES = ['main.tex', 'sections/intro.tex', 'sections/method.tex', 'sections/results.tex', 'sections/appendix.tex'];
const LARGE: Record<string, string> = Object.fromEntries(LARGE_FILES.map((f) => [f, readFileSync(FX(`large-multifile/tex/${f}`), 'utf8')]));
const LARGE_FACTS = loadFacts(FX('large-multifile/repo'));

function canto(text = CANTO_MAIN): ConsistencyUnit[] {
  return unitsOf('main.tex', text);
}

function outline(p: { keyPhrase?: string; factId?: string | null; baselineFactId?: string | null; condition?: string } = {}): Outline {
  const o = emptyOutline();
  o.story.keyPhrase = p.keyPhrase ?? '';
  o.headline.factId = p.factId ?? null;
  o.headline.baselineFactId = p.baselineFactId ?? null;
  o.headline.condition = p.condition ?? '';
  return o;
}

const kinds = (r: EchoReport): string[] => r.flags.map((f) => f.kind);
const ABSTRACT_FAKE = 'at a fake-track rate of 0.55\\% against 1.38\\%.';

/* ------------------------------------------------------------------------------------ */

describe('echoCheck on fixtures/canto-demo', () => {
  const units = canto();
  const report = echoCheck(units, CANTO_FACTS, outline({ keyPhrase: 'trained without the signal', factId: 'f.g1.eff_A', baselineFactId: 'f.g1.eff_B' }), { title: extractTitle(CANTO_MAIN) });

  it('the loader reads the fixture facts the server extracts', () => {
    const ids = CANTO_FACTS.map((f) => f.id);
    expect(ids).toContain('f.g1.eff_A');
    expect(ids).toContain('f.g1csv.generic_iso.P_G.canto_l_ttbar.Canto-L (ttbar).main.mean');
    expect(CANTO_FACTS.find((f) => f.id === 'f.g1.delta_points')!.uncertainties).toMatchObject({ total: expect.closeTo(0.2793, 3), boot: expect.any(Number), seeds: expect.any(Number) });
  });

  it('is a valid EchoReport and deterministic', () => {
    expect(() => EchoReport.parse(report)).not.toThrow();
    const again = echoCheck(units, CANTO_FACTS, outline({ keyPhrase: 'trained without the signal', factId: 'f.g1.eff_A', baselineFactId: 'f.g1.eff_B' }), { title: extractTitle(CANTO_MAIN) });
    expect(again).toEqual(report);
  });

  it('lists every fact-backed number with its parts and per-occurrence sentence ids', () => {
    const q = (id: string) => report.quantities.find((x) => x.key === `${id}#value`);
    const effA = q('f.g1.eff_A')!;
    expect(effA.parts).toEqual(['abstract']);
    expect(effA.renderings).toEqual(['96.94%']);
    // the same value in the CSV row is the same quantity, listed with it
    expect(effA.factIds).toContain('f.g1csv.generic_iso.P_G.canto_l_ttbar.Canto-L (ttbar).main.mean');
    const fake = q('f.g1.fake_rate_A')!;
    expect(fake.parts).toEqual(['abstract', 'body']);
    expect(fake.occurrences.map((o) => o.sentenceId)).toHaveLength(2);
    for (const o of fake.occurrences) expect(units.find((u) => u.id === o.sentenceId)!.text).toContain('0.55');
    expect(q('f.g1.n_targets')!.occurrences[0]!.rendering).toBe('8,710');
    // an uncertainty is its own quantity (field unc:total)
    expect(report.quantities.find((x) => x.key === 'f.g1.delta_points#unc:total')!.occurrences[0]!.raw).toBe('0.28');
    expect(report.unmatched.filter((u) => u.part !== 'body')).toEqual([]);
  });

  it('finds no drift in the consistent fixture', () => {
    expect(kinds(report).filter((k) => k.startsWith('drift') || k === 'factor_percent' || k === 'condition_dropped')).toEqual([]);
  });

  it('finds the contribution sentence and the key phrase', () => {
    expect(report.contribution!.text).toMatch(/^In this paper, we train on generic events only/);
    const loc = Object.fromEntries(report.keyPhrase.locations.map((l) => [l.where, l.status]));
    expect(loc).toEqual({ title: 'missing', abstract: 'present', contribution: 'missing', conclusions: 'present' });
    expect(kinds(report).filter((k) => k === 'key_phrase_missing')).toHaveLength(2);
  });

  it('checks the headline and its baseline in abstract and conclusions', () => {
    const [abs, concl] = report.headline.places;
    expect(abs).toMatchObject({ where: 'abstract', present: true, baselinePresent: true });
    expect(concl).toMatchObject({ where: 'conclusions', present: false });
    expect(report.flags.filter((f) => f.kind === 'headline_missing').map((f) => f.message)).toEqual([expect.stringMatching(/not stated in the conclusions/)]);
  });
});

describe('echoCheck flags', () => {
  it('drift_precision: one quantity at two precisions across parts (warn), inside one part (info)', () => {
    const text = CANTO_MAIN.replace('The fake-track rate is 0.55\\% against', 'The fake-track rate is 0.548\\% against');
    const r = echoCheck(canto(text), CANTO_FACTS, null);
    const f = r.flags.find((x) => x.kind === 'drift_precision')!;
    expect(f.severity).toBe('warn');
    expect(f.factIds).toEqual(['f.g1.fake_rate_A']);
    expect(f.message).toMatch(/"0\.55%" \(abstract\) vs "0\.548%" \(body\)/);
    expect(f.sentenceIds).toHaveLength(2);
    const inBody = CANTO_MAIN.replace('This lead holds for every particle species.', 'This lead holds for every particle species at a fake-track rate of 0.548\\%.');
    const r2 = echoCheck(canto(inBody), CANTO_FACTS, null);
    expect(r2.flags.filter((x) => x.kind === 'drift_precision').map((x) => x.severity).sort()).toEqual(['warn']);
  });

  it('drift_form: a percent in the abstract, a fraction in the body', () => {
    const text = CANTO_MAIN.replace('The fake-track rate is 0.55\\% against', 'The fake-track rate is 0.0055 against');
    const r = echoCheck(canto(text), CANTO_FACTS, null);
    expect(r.flags.find((x) => x.kind === 'drift_form')!.message).toMatch(/percent in one place and as a fraction/);
  });

  it('drift_value (heuristic): an unmatched copy close to a stated quantity', () => {
    const text = CANTO_MAIN.replace('it finds 96.94\\% of the targets', 'it finds 96.49\\% of the targets').replace(
      'We have shown that a tracker trained without the signal finds more displaced particles than one trained on it.',
      'We have shown that a tracker trained without the signal finds 96.94\\% of the displaced particles.',
    );
    const r = echoCheck(canto(text), CANTO_FACTS, null);
    const f = r.flags.find((x) => x.kind === 'drift_value')!;
    expect(f.heuristic).toBe(true);
    expect(f.factIds).toEqual(['f.g1.eff_A']);
    expect(f.message).toMatch(/"96\.49%" \(abstract\).*"96\.94%" \(concl\)/);
    expect(r.unmatched.map((u) => u.rendering)).toContain('96.49%');
  });

  it('factor_percent: one fact pair as a factor and as a percent (through derived relations)', () => {
    const text = CANTO_MAIN.replace(ABSTRACT_FAKE, 'with 2.5 times fewer fake tracks.').replace('This lead holds for every particle species.', 'The baseline makes 151\\% more fake tracks.');
    const derived = derivedRelations(CANTO_FACTS);
    const r = echoCheck(canto(text), CANTO_FACTS, null, { derived });
    const f = r.flags.find((x) => x.kind === 'factor_percent')!;
    expect(f.factIds.sort()).toEqual(['f.g1.fake_rate_A', 'f.g1.fake_rate_B']);
    expect(f.message).toMatch(/"2\.5 times", abstract.*"151%", body/);
    const q = r.quantities.find((x) => x.key.startsWith('derived:') && x.renderings.includes('2.5 times'))!;
    expect(q.occurrences[0]!.derived).toMatch(/f\.g1\.fake_rate_B \/ f\.g1\.fake_rate_A/);
    // without the relations the numbers are unmatched, not silently linked
    const plain = echoCheck(canto(text), CANTO_FACTS, null);
    expect(plain.unmatched.map((u) => u.rendering)).toEqual(expect.arrayContaining(['2.5 times', '151%']));
  });

  it('condition_dropped (heuristic): the body states a condition the abstract lacks', () => {
    const text = CANTO_MAIN.replace(
      'On isolated displaced particles that neither model saw in training, it finds 96.94\\% of the targets, compared with 94.62\\% for the signal-trained baseline, ' + ABSTRACT_FAKE,
      'It finds 96.94\\% of the targets.',
    ).replace('The test set holds 8,710 targets.', 'On the isolated gun particles, it finds 96.94\\% of the targets.');
    const r = echoCheck(canto(text), CANTO_FACTS, null);
    const f = r.flags.find((x) => x.kind === 'condition_dropped')!;
    expect(f.heuristic).toBe(true);
    expect(f.message).toMatch(/"96\.94%".*abstract.*"On the isolated gun particles"/);
    // the abstract (or the sentence before it) naming the condition clears the flag
    const ok = text.replace('It finds 96.94\\% of the targets.', 'We test on isolated gun particles. It finds 96.94\\% of the targets.');
    expect(kinds(echoCheck(canto(ok), CANTO_FACTS, null))).not.toContain('condition_dropped');
  });

  it('condition phrases skip idioms and compared objects', () => {
    expect(conditionPhrases('On the isolated gun particles, the tracker finds more than the baseline.').map((c) => c.phrase)).toEqual(['On the isolated gun particles']);
    expect(conditionPhrases('The lead is in favour of the tracker, for the baseline, at least.')).toEqual([]);
    expect(conditionPhrases('The efficiency at $\\mu = 200$ pile-up stays high.').map((c) => c.stems)).toEqual([['pile', 'up']]);
  });

  it('stale_fact: a stale fact stated in the text, with its sentences', () => {
    const facts = CANTO_FACTS.map((f) => (f.id === 'f.g1.fake_rate_A' ? { ...f, stale: true } : f));
    const r = echoCheck(canto(), facts, null);
    expect(r.stale).toHaveLength(1);
    expect(r.stale[0]!.factId).toBe('f.g1.fake_rate_A');
    expect(r.stale[0]!.sentences.map((s) => s.part)).toEqual(['abstract', 'body']);
    expect(r.flags.find((f) => f.kind === 'stale_fact')!.sentenceIds).toHaveLength(2);
    expect(r.quantities.find((q) => q.key === 'f.g1.fake_rate_A#value')!.stale).toBe(true);
    // a stale fact linked by the server (unit.facts) but written in words still counts
    const units = canto().map((u) => (u.part === 'concl' && u.text.startsWith('We have shown') ? { ...u, facts: ['f.g1.fake_rate_A'] } : u));
    expect(echoCheck(units, facts, null).stale[0]!.sentences.map((s) => s.part)).toEqual(['abstract', 'body', 'concl']);
  });

  it('headline_baseline: the conclusions give the headline with another baseline', () => {
    const text = CANTO_MAIN.replace('We have shown that a tracker trained without the signal finds more displaced particles than one trained on it.', 'We have shown that the tracker finds 96.94\\% of the targets, against 91.37\\% for acorn (ttbar).');
    const r = echoCheck(canto(text), CANTO_FACTS, outline({ factId: 'f.g1.eff_A', baselineFactId: 'f.g1.eff_B', condition: 'isolated displaced particles' }));
    const concl = r.headline.places.find((p) => p.where === 'conclusions')!;
    expect(concl).toMatchObject({ present: true, baselinePresent: false, conditionPresent: false });
    expect(concl.otherBaselines).toEqual(['f.g1csv.generic_iso.P_G.acorn_ttbar_lm.acorn (ttbar) + LM.main.mean']);
    expect(kinds(r)).toEqual(expect.arrayContaining(['headline_baseline', 'headline_condition']));
    expect(r.headline.places.find((p) => p.where === 'abstract')).toMatchObject({ present: true, baselinePresent: true, conditionPresent: true });
  });

  it('key phrase: present across hyphens and inflection, partial, missing; no contribution sentence', () => {
    expect(matchPhrase('graph neural network', 'However, graph-neural-network trackers have not been trained.').status).toBe('present');
    expect(matchPhrase('never saw the signal', 'A tracker that never sees the signal can serve a search.').status).toBe('present');
    expect(matchPhrase('never saw the signal', 'It never trained on any signal.').status).toBe('partial');
    expect(matchPhrase('displaced vertices', 'It finds tracks.').status).toBe('missing');
    const text = CANTO_MAIN.replace('In this paper, we train on generic events only', 'The study trains on generic events only');
    const r = echoCheck(canto(text), CANTO_FACTS, outline({ keyPhrase: 'generic events' }));
    expect(r.contribution).toBeNull();
    expect(kinds(r)).toContain('no_contribution_sentence');
    expect(r.keyPhrase.locations.find((l) => l.where === 'contribution')!.status).toBe('absent');
    // no title given: the title is reported absent but not flagged
    expect(r.keyPhrase.locations.find((l) => l.where === 'title')!.status).toBe('absent');
    expect(r.flags.filter((f) => f.kind === 'key_phrase_missing').map((f) => f.message).join(' ')).not.toMatch(/is not in the title/);
  });

  it('never throws on odd input', () => {
    expect(() => echoCheck([], [], null)).not.toThrow();
    const bad = [{ id: 'x', file: 'a.tex', line: 1, part: 'abstract', kind: 'prose', sectionId: 'abstract', text: '$$ \\begin{ 1.2\\% ±± [[ ' }] as ConsistencyUnit[];
    expect(() => echoCheck(bad, CANTO_FACTS, outline({ keyPhrase: '???', factId: 'nope', baselineFactId: 'nope2', condition: '...' }), { title: '\\title{' })).not.toThrow();
    expect(() => echoCheck(null as unknown as ConsistencyUnit[], null as unknown as Fact[], undefined)).not.toThrow();
  });
});

describe('echoCheck on fixtures/large-multifile (five \\input files)', () => {
  const order = projectFileOrder('main.tex', LARGE);
  const units = orderUnits(LARGE_FILES.flatMap((f) => unitsOf(f, LARGE[f]!)), order);
  const derived = derivedRelations(LARGE_FACTS);
  const o = outline({ keyPhrase: 'never saw the signal', factId: 'f.headline.delta_points', baselineFactId: 'f.headline.eff_B', condition: 'displaced targets' });

  it('orders the files as main.tex inputs them, appendix included after \\appendix', () => {
    expect(order.map((e) => e.file)).toEqual(LARGE_FILES);
    expect(order.find((e) => e.file === 'sections/appendix.tex')!.appendix).toBe(true);
    expect(units.filter((u) => u.file === 'sections/appendix.tex').every((u) => u.part === 'app' || u.part === 'caption' || u.part === 'footnote')).toBe(true);
    expect(units.findIndex((u) => u.file === 'sections/intro.tex')).toBeLessThan(units.findIndex((u) => u.text.startsWith('We asked whether')));
  });

  it('reports every abstract number in the body too, with no drift, within budget', () => {
    let r = echoCheck(units, LARGE_FACTS, o, { title: extractTitle(LARGE['main.tex']!), derived });
    const t0 = performance.now();
    for (let k = 0; k < 3; k++) r = echoCheck(units, LARGE_FACTS, o, { title: extractTitle(LARGE['main.tex']!), derived });
    const ms = (performance.now() - t0) / 3;
    expect(ms).toBeLessThan(600 * PERF_SLACK);
    expect(() => EchoReport.parse(r)).not.toThrow();
    const abs = r.quantities.filter((q) => q.parts.includes('abstract'));
    expect(abs.map((q) => q.primaryFactId)).toEqual(['f.headline.eff_A', 'f.headline.eff_B', 'f.headline.fake_rate_A', 'f.headline.fake_rate_B']);
    for (const q of abs) expect(q.parts).toContain('body');
    expect(r.quantities.length).toBeGreaterThan(80);
    expect(kinds(r).filter((k) => ['drift_form', 'drift_value', 'factor_percent', 'condition_dropped', 'stale_fact'].includes(k))).toEqual([]);
    expect(r.flags.filter((f) => f.kind === 'drift_precision' && f.severity === 'warn')).toEqual([]);
    expect(r.unmatched.filter((u) => u.part === 'abstract' || u.part === 'concl')).toEqual([]);
  });

  it('the headline difference counts as stated through its two terms; the summary lacks the baseline', () => {
    const r = echoCheck(units, LARGE_FACTS, o, { title: extractTitle(LARGE['main.tex']!), derived });
    const [abs, concl] = r.headline.places;
    expect(abs).toMatchObject({ present: true, baselinePresent: true, conditionPresent: true });
    expect(concl).toMatchObject({ present: true, baselinePresent: false });
    expect(units.find((u) => u.id === concl!.sentenceIds[0])!.text).toMatch(/2\.49 points more displaced targets/);
    expect(kinds(r)).toContain('headline_baseline');
    const loc = Object.fromEntries(r.keyPhrase.locations.map((l) => [l.where, l.status]));
    expect(loc).toEqual({ title: 'present', abstract: 'present', contribution: 'missing', conclusions: 'partial' });
    expect(r.contribution!.text).toMatch(/^We ask whether a tracker trained only on Standard Model events/);
  });

  it('a co-author changes one copy of a headline number in an \\input file: drift is reported with both sentences', () => {
    const results = LARGE['sections/results.tex']!;
    const i = results.indexOf('95.52');
    expect(i).toBeGreaterThan(0);
    const changed = results.slice(0, i) + '95.5' + results.slice(i + 5);
    const us = orderUnits(LARGE_FILES.flatMap((f) => unitsOf(f, f === 'sections/results.tex' ? changed : LARGE[f]!)), order);
    const r = echoCheck(us, LARGE_FACTS, o, { derived });
    const f = r.flags.find((x) => x.kind === 'drift_precision' && x.factIds[0] === 'f.headline.eff_A')!;
    expect(f.severity).toBe('warn');
    expect(f.sentenceIds.map((id) => us.find((u) => u.id === id)!.file)).toEqual(expect.arrayContaining(['main.tex', 'sections/results.tex']));
  });
});

describe('unitsWithText and projectFileOrder', () => {
  it('slices unit text from the file texts', () => {
    const seg = segment(CANTO_MAIN);
    const s = seg.sentences[3]!;
    const unit = { id: 'u1', file: 'main.tex', start: s.start, end: s.end, line: s.line, part: s.part, kind: s.kind, sectionId: s.sectionId, textNorm: 'norm' } as unknown as SentenceUnit;
    expect(unitsWithText([unit], { 'main.tex': CANTO_MAIN })[0]!.text).toBe(s.text);
    expect(unitsWithText([unit], new Map())[0]!.text).toBe('norm');
  });

  it('ignores commented inputs, resolves relative paths, survives cycles and lists unreached files last', () => {
    const files = { 'main.tex': '\\input{a}\n% \\input{b}\n\\include{sub/c}\n\\appendix\n\\input d', 'a.tex': '\\input{main}', 'b.tex': '', 'sub/c.tex': '\\input{e}', 'sub/e.tex': '', 'd.tex': '' };
    expect(projectFileOrder('main.tex', files).map(({ anchor: _a, ...e }) => e)).toEqual([
      { file: 'main.tex', appendix: false, included: true },
      { file: 'a.tex', appendix: false, included: true },
      { file: 'sub/c.tex', appendix: false, included: true },
      { file: 'sub/e.tex', appendix: false, included: true },
      { file: 'd.tex', appendix: true, included: true },
      { file: 'b.tex', appendix: false, included: false },
    ]);
  });
});
