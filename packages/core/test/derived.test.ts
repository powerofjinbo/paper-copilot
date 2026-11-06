/**
 * Derived relations (meta/derived.ts) and their acceptance by the gate: ratios ("2.5 times", "a factor
 * of 3"), differences in points, relative changes in percent, shares of two counts ("9 out of 10"),
 * bounded and deterministic, on the fixtures' result files; plus "N out of M" ratios linking to the one
 * fraction fact they state.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DerivedRelationSchema } from '../src/api';
import { DEFAULT_MAX_DERIVED, definitionStem, derivedRelations } from '../src/meta/derived';
import { gateSentence, type DerivedRelation, type GateContext } from '../src/gate/gate';
import { hashString } from '../src/text/hash';
import type { Fact } from '../src/schemas';

const PERF_SLACK = process.env.CI ? 3 : 1;
const FX = (p: string): string => fileURLToPath(new URL(`../../../fixtures/${p}`, import.meta.url));

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

const CANTO = loadFacts(FX('canto-demo/repo'));
const LARGE = loadFacts(FX('large-multifile/repo'));
const gate = (text: string, facts: Fact[], derived: DerivedRelation[], extra: Partial<GateContext> = {}) =>
  gateSentence(text, { mode: 'draft', facts, allowedCiteKeys: [], knownLabels: [], fictionalNumbers: [], derived, ...extra });
const pair = (r: DerivedRelation): string => [...r.factIds].sort().join('|');

describe('derivedRelations on fixtures/canto-demo', () => {
  const rel = derivedRelations(CANTO);

  it('are valid, deterministic and bounded', () => {
    for (const r of rel) expect(() => DerivedRelationSchema.parse(r)).not.toThrow();
    expect(derivedRelations(CANTO)).toEqual(rel);
    expect(rel.length).toBeGreaterThan(50);
    expect(rel.length).toBeLessThanOrEqual(DEFAULT_MAX_DERIVED);
  });

  it('ratio, difference and relative change of the two fake rates', () => {
    const fake = rel.filter((r) => pair(r) === 'f.g1.fake_rate_A|f.g1.fake_rate_B');
    expect(fake.map((r) => [r.kind, r.raw, r.form])).toEqual([
      ['difference', '0.83', 'points'],
      ['relative', '60', 'percent'],
      ['relative', '151', 'percent'],
      ['ratio', '2.5', 'factor'],
    ]);
    const ratio = fake.find((r) => r.kind === 'ratio')!;
    expect(ratio.factIds).toEqual(['f.g1.fake_rate_B', 'f.g1.fake_rate_A']);
    expect(ratio.value).toBeCloseTo(0.0137682493250558 / 0.0054838384739537, 12);
    expect(ratio.renderings).toEqual(['2.5 times', '3 times']);
    expect(ratio.maxSigfigs).toBe(2);
    const eff = rel.find((r) => pair(r) === 'f.g1.eff_A|f.g1.eff_B' && r.kind === 'difference')!;
    expect(eff.value).toBeCloseTo(2.3191733639, 8);
    // eff_A / eff_B = 1.02 is below the factor threshold
    expect(rel.some((r) => pair(r) === 'f.g1.eff_A|f.g1.eff_B' && r.kind === 'ratio')).toBe(false);
  });

  it('never pairs different quantities, per-seed values or uncertainties', () => {
    expect(rel.some((r) => pair(r) === 'f.g1.eff_A|f.g1.fake_rate_A')).toBe(false);
    expect(rel.some((r) => r.factIds.some((id) => /seeds|_s\d$|sigma/.test(id)))).toBe(false);
    for (const r of rel) {
      const [a, b] = r.factIds.map((id) => CANTO.find((f) => f.id === id)!);
      expect(definitionStem(a!) === definitionStem(b!) || (a!.artifact === b!.artifact && (r.kind === 'share' || a!.tags.includes('count')))).toBe(true);
    }
  });

  it('definition stems drop the sample/model designator', () => {
    const stem = (id: string, definition: string) => definitionStem({ id, definition });
    expect(stem('f.g1.eff_A', 'eff_A (claim=G1; A=...)')).toBe('eff');
    expect(stem('f.pileup.scan.2.fake_rate_B', 'scan[2].fake_rate_B')).toBe('fake_rate');
    expect(stem('f.x.eff_s0', 'eff_s0 (sample=...)')).toBe('eff');
    expect(stem('f.timing.time_lrt_ms', 'time_lrt_ms')).toBe('time_lrt');
    expect(stem('f.h.delta_points', '')).toBe('delta');
  });
});

describe('derivedRelations on fixtures/large-multifile', () => {
  it('is bounded, tier by tier, within budget', () => {
    let rel = derivedRelations(LARGE);
    const t0 = performance.now();
    for (let k = 0; k < 5; k++) rel = derivedRelations(LARGE);
    expect((performance.now() - t0) / 5).toBeLessThan(150 * PERF_SLACK);
    expect(rel.length).toBeGreaterThan(500);
    expect(rel.length).toBeLessThan(DEFAULT_MAX_DERIVED);
    // same row/object first: the headline comparison comes before anything else
    expect(rel.slice(0, 7).every((r) => r.factIds.every((id) => id.startsWith('f.headline.')))).toBe(true);
    expect(derivedRelations(LARGE, { maxRelations: 10 })).toEqual(rel.slice(0, 10));
    expect(derivedRelations(LARGE, { maxRelations: 0 })).toEqual([]);
    // a bigger repository hits the cap: 20 copies of the result tables
    const many = Array.from({ length: 20 }, (_, k) => LARGE.map((f) => ({ ...f, id: `${f.id}~${k}`, artifact: `${f.artifact}.${k}` }))).flat();
    expect(derivedRelations(many).length).toBe(DEFAULT_MAX_DERIVED);
  });

  it('rows of one table pair only when they differ in one factor; across artifacts only with a headline value', () => {
    const rel = derivedRelations(LARGE, { maxRelations: 1e9 });
    // the same displacement bin, generic vs signal-trained: yes; two bins of one model: yes
    expect(rel.some((r) => pair(r) === 'f.displacement.r3.eff_A|f.displacement.r3.eff_B')).toBe(true);
    expect(rel.some((r) => pair(r) === 'f.displacement.r1.eff_A|f.displacement.r8.eff_A')).toBe(true);
    // a headline value against a breakdown in another artifact: yes; two breakdowns of different artifacts: no
    expect(rel.some((r) => pair(r) === 'f.displacement.r8.eff_A|f.headline.eff_A')).toBe(true);
    expect(rel.some((r) => pair(r) === 'f.displacement.r8.eff_A|f.pt_bins.r1.eff_A')).toBe(false);
  });

  it('counts of one artifact give ratios and shares; physical values of one artifact give ratios', () => {
    const rel = derivedRelations(LARGE, { maxRelations: 1e9 });
    const share = rel.find((r) => r.kind === 'share' && pair(r) === 'f.training.n_test_events|f.training.n_train_events')!;
    expect(share.value).toBeCloseTo(1000 / 8000, 12);
    const ratio = rel.find((r) => r.kind === 'ratio' && pair(r) === 'f.training.n_test_events|f.training.n_train_events')!;
    expect(ratio.raw).toBe('8.0');
    const t = rel.find((r) => r.kind === 'ratio' && pair(r) === 'f.lrt_comparison.time_lrt_ms|f.timing.total_time_ms');
    expect(t).toBeUndefined(); // different artifacts, different stems
    expect(rel.find((r) => r.kind === 'ratio' && pair(r) === 'f.timing.inference_time_ms|f.timing.track_build_time_ms')!.raw).toBe('7.4');
    // no fraction pairs of different stems
    expect(rel.some((r) => pair(r) === 'f.headline.eff_A|f.headline.fake_rate_A')).toBe(false);
  });
});

describe('the gate accepts derived relations and links both facts', () => {
  const rel = derivedRelations(CANTO);

  it('a factor of two fake rates', () => {
    for (const s of ['The baseline makes 2.5 times more fake tracks.', 'The fake-track rate is lower by a factor of 2.5.', 'The baseline makes 2.5-fold more fake tracks.']) {
      const r = gate(s, CANTO, rel);
      expect(r.ok, s).toBe(true);
      expect(r.factIds.sort()).toEqual(['f.g1.fake_rate_A', 'f.g1.fake_rate_B']);
    }
    // without relations the factor is an invention
    expect(gate('The baseline makes 2.5 times more fake tracks.', CANTO, []).ok).toBe(false);
  });

  it('respects the form and the precision of the relation', () => {
    expect(gate('The baseline makes 2.51 times more fake tracks.', CANTO, rel).issues.map((i) => i.code)).toContain('unmatched_number');
    expect(gate('The fake-track rate is 2.5 points lower.', CANTO, rel).ok).toBe(false);
    expect(gate('The fake-track rate of the baseline is 2.5.', CANTO, rel).ok).toBe(false);
    // a chance match between unrelated rows (two ceilings of different models on different populations) is not offered
    expect(gate('The fake-track rate is 2.5 points lower.', CANTO, derivedRelations(CANTO, { maxRelations: 1e9 })).ok).toBe(false);
    const r = gate('The fake-track rate is 60\\% lower.', CANTO, rel);
    expect(r.ok).toBe(true);
    expect(r.factIds.sort()).toEqual(['f.g1.fake_rate_A', 'f.g1.fake_rate_B']);
    expect(gate('The baseline makes 151\\% more fake tracks.', CANTO, rel).ok).toBe(true);
    expect(gate('The fake-track rate is 61\\% lower.', CANTO, rel).ok).toBe(false);
    expect(gate('The difference is 0.83 points.', CANTO, rel).factIds).toContain('f.g1.fake_rate_diff_points');
  });

  it('warns when a relative change also reads as a points fact written as a percent', () => {
    const f = (id: string, value: number, unit = ''): Fact => mk({ id, value, unit, artifact: 'r.json', locator: `#/${id}`, definition: id.split('.').pop()! });
    const facts = [f('f.r.eff_A', 0.55), f('f.r.eff_B', 0.5), f('f.r.gain_points', 10, 'points')];
    const r = gate('The efficiency is 10\\% higher.', facts, derivedRelations(facts));
    expect(r.ok).toBe(true);
    expect(r.issues.find((i) => i.code === 'percent_scale')).toMatchObject({ severity: 'warn' });
  });

  it('a share of two counts: "9 out of 10", a percent, a fraction', () => {
    const f = (id: string, value: number): Fact => mk({ id, value, artifact: 'counts.json', locator: `#/${id}`, definition: id.split('.').pop()!, tags: ['count'] });
    const facts = [f('f.c.n_matched', 7920), f('f.c.n_targets', 8710)];
    const d = derivedRelations(facts);
    expect(d.map((r) => r.kind)).toEqual(['relative', 'relative', 'share']);
    for (const s of ['The tracker finds 9 out of 10 targets.', 'The tracker finds 91\\% of the targets.', 'The tracker finds a fraction 0.91 of the targets.']) {
      const r = gate(s, facts, d);
      expect(r.ok, s).toBe(true);
      expect(r.factIds.sort(), s).toEqual(['f.c.n_matched', 'f.c.n_targets']);
    }
    expect(gate('The tracker finds 8 out of 10 targets.', facts, d).ok).toBe(false);
    // an untyped relation of value 9 is not "9 out of 10"
    expect(gate('The tracker finds 9 out of 10 targets.', facts, [{ value: 9, raw: '9', factIds: ['f.c.n_matched'], description: 'nine' }]).ok).toBe(false);
  });
});

describe('"N out of M" links the one fraction fact it states', () => {
  const f = (id: string, value: number, locator = `#/${id.split('.').pop()}`): Fact => mk({ id, value, artifact: 'claim.json', locator, definition: id });
  const effA = f('f.g1.eff_A', 0.9694221201683888);
  const seeds = [0.9684, 0.9723, 0.9675].map((v, i) => f(`f.g1.eff_A_seeds.${i}`, v, `#/eff_A_seeds/${i}`));
  const csvMean = mk({ id: 'f.csv.canto.mean', value: 0.9694221201683888, artifact: 'table.csv', locator: 'csv:row=1;col=mean', definition: 'mean' });
  const csvSeed = mk({ id: 'f.csv.canto.eff_s1', value: 0.9723, artifact: 'table.csv', locator: 'csv:row=1;col=eff_s1', definition: 'eff_s1' });

  it('per-seed values and identical copies yield to the aggregate', () => {
    const r = gate('It finds 97 out of 100 targets.', [effA, ...seeds, csvMean, csvSeed], []);
    expect(r.ok).toBe(true);
    expect(r.factIds).toEqual(['f.g1.eff_A']);
    expect(r.issues.map((i) => i.code)).toEqual(['loose_number']);
  });

  it('stays ambiguous between two different quantities', () => {
    const ceiling = f('f.g1.ceiling', 0.9732);
    const r = gate('It finds 97 out of 100 targets.', [effA, ceiling], []);
    expect(r.ok).toBe(true);
    expect(r.factIds).toEqual([]);
  });

  it('the fixture: "97 out of 100" is ambiguous between the efficiency and its ceiling; with the claimed fact it links', () => {
    expect(gate('It finds 97 out of 100 targets.', CANTO, []).factIds).toEqual([]);
    expect(gate('It finds 97 out of 100 targets.', CANTO, [], { claimedFactIds: ['f.g1.eff_A'] }).factIds).toEqual(['f.g1.eff_A']);
  });
});
