import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { echoCheck } from '../src/consistency/echo';
import { terminologyReport } from '../src/consistency/terms';
import { figurePlan } from '../src/consistency/figures';
import { orderUnits, projectFileOrder, extractTitle, type ConsistencyUnit } from '../src/consistency/common';
import { derivedRelations } from '../src/meta/derived';
import { segment } from '../src/latex/segment';
import { hashString } from '../src/text/hash';
import { type Fact } from '../src/schemas';
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
function unitsOf(file: string, text: string): ConsistencyUnit[] {
  const seg = segment(text);
  return seg.sentences.map((s, i) => ({ id: `${file}#${i}`, file, line: s.line, part: s.part, kind: s.kind, sectionId: s.sectionId, text: s.text, start: s.start, end: s.end }));
}
const show = (name: string, flags: Array<{ kind: string; severity: string; message: string }>) => {
  console.log(`\n===== ${name}: ${flags.length}`);
  for (const f of flags) console.log(`[${f.kind}/${f.severity}] ${f.message}`);
};
it('probe', () => {
  const canto = readFileSync(FX('canto-demo/tex/main.tex'), 'utf8');
  const cf = loadFacts(FX('canto-demo/repo'));
  const cu = unitsOf('main.tex', canto);
  const d = derivedRelations(cf);
  const e = echoCheck(cu, cf, null, { derived: d, title: extractTitle(canto) });
  show('canto echo', e.flags);
  console.log('quantities', e.quantities.map((q) => `${q.key}:${q.renderings.join('/')}:${q.parts.join(',')}`).join('\n'));
  console.log('unmatched', e.unmatched.map((o) => `${o.part}:${o.rendering}`).join(' | '));
  show('canto terms', terminologyReport(cu).flags);
  const fp = figurePlan([{ file: 'main.tex', text: canto }], cu, null);
  show('canto figs', fp.flags);
  const LF = ['main.tex', 'sections/intro.tex', 'sections/method.tex', 'sections/results.tex', 'sections/appendix.tex'];
  const files = LF.map((f) => ({ file: f, text: readFileSync(FX(`large-multifile/tex/${f}`), 'utf8') }));
  const order = projectFileOrder('main.tex', files);
  const lu = orderUnits(files.flatMap((f) => unitsOf(f.file, f.text)), order);
  const lf = loadFacts(FX('large-multifile/repo'));
  const t0 = performance.now();
  const le = echoCheck(lu, lf, null, { derived: derivedRelations(lf), title: extractTitle(files[0]!.text) });
  console.log('large echo ms', performance.now() - t0, 'units', lu.length, 'facts', lf.length);
  show('large echo', le.flags);
  console.log('unmatched', le.unmatched.map((o) => `${o.part}:${o.rendering}`).join(' | '));
  show('large terms', terminologyReport(lu).flags);
  show('large figs', figurePlan(files, lu, null, { order }).flags);
});
