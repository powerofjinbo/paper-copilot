/** Fixture fact loader for review-2 integrity tests (copied from test/derived.test.ts so the tests share its fact ids). */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashString } from '../../src/text/hash';
import type { Fact } from '../../src/schemas';

export const FX = (p: string): string => fileURLToPath(new URL(`../../../../fixtures/${p}`, import.meta.url));
const STEMS: Record<string, string> = { addendum_g_g1_v1_claim: 'g1', addendum_g_g1_v1: 'g1csv', headline_claim: 'headline' };
const UNIT_SUFFIX: Array<[RegExp, string]> = [[/_ms$/, 'ms'], [/_mm$/, 'mm'], [/_gev$/i, 'GeV'], [/_tev$/i, 'TeV'], [/_mrad$/, 'mrad'], [/_points$/, 'points']];
const unitOf = (name: string): string => UNIT_SUFFIX.find(([re]) => re.test(name))?.[1] ?? '';

export function mk(p: Partial<Fact> & Pick<Fact, 'id' | 'value' | 'artifact' | 'locator'>): Fact {
  return { kind: 'number', sigfigs: null, unit: '', uncertainties: {}, definition: '', definitionSource: 'test loader', artifactSha256: 'sha', fingerprint: hashString(`${p.locator}|${String(p.value)}`), stale: false, validationState: 'candidate', aliases: [], confirmed: true, excluded: false, proseOnly: false, tags: [], ...p };
}

export function loadFacts(repo: string): Fact[] {
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
      const parsed = JSON.parse(src) as Record<string, unknown>;
      const before = out.length;
      walk(parsed, [], '');
      // like the real fact service: a claim's string fields (claim, A, B, population, ...) describe every
      // number of the claim ("eff_A (claim=G1; A=Canto-L (ttbar); B=acorn (HNL) + LM; ...)")
      const strMeta = Object.entries(parsed).filter(([k, v]) => typeof v === 'string' && !/^(?:split|outcome)$/.test(k)).map(([k, v]) => `${k}=${String(v)}`).join('; ');
      if (name.endsWith('_claim.json') && strMeta) for (const f of out.slice(before)) f.definition = `${f.definition} (${strMeta})`;
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
