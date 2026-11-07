/**
 * `?mock=1&fixture=large`: the browser demo on fixtures/large-multifile (main.tex \input-s four section
 * files; 442 sentences, 12 figures, 4 tables). Loaded as its own chunk, only when asked for.
 *
 * The server extracts facts with its Node extractor (apps/server/src/services/facts); the demo uses the
 * small reader below: one fact per numeric JSON leaf and per numeric CSV cell (rows named by their first
 * column), `<col>_sigma` columns as the uncertainty of `<col>`, units from the key suffix. Simulated
 * like the rest of the demo, but deterministic and enough for the reports and the gate.
 */
import { factAliases, hashString, type Fact } from '@paper-copilot/core';
import { MockApiClient, type MockOptions } from './mock';

import mainTex from '../../../../fixtures/large-multifile/tex/main.tex?raw';
import introTex from '../../../../fixtures/large-multifile/tex/sections/intro.tex?raw';
import methodTex from '../../../../fixtures/large-multifile/tex/sections/method.tex?raw';
import resultsTex from '../../../../fixtures/large-multifile/tex/sections/results.tex?raw';
import appendixTex from '../../../../fixtures/large-multifile/tex/sections/appendix.tex?raw';
import refsBib from '../../../../fixtures/large-multifile/tex/refs.bib?raw';
import headlineJson from '../../../../fixtures/large-multifile/repo/results/headline_claim.json?raw';

const RESULTS = import.meta.glob('../../../../fixtures/large-multifile/repo/results/*.{json,csv}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export const LARGE_FILES: Record<string, string> = {
  'main.tex': mainTex,
  'sections/intro.tex': introTex,
  'sections/method.tex': methodTex,
  'sections/results.tex': resultsTex,
  'sections/appendix.tex': appendixTex,
};

/** Unit of a result key from its suffix (the fixture's naming convention). */
export function unitOfKey(key: string): string {
  const k = key.toLowerCase();
  if (k.endsWith('_points')) return 'points';
  if (k.endsWith('_mm')) return 'mm';
  if (k.endsWith('_gev')) return 'GeV';
  if (k.endsWith('_mrad')) return 'mrad';
  if (k.endsWith('_ns')) return 'ns';
  if (k.endsWith('_ms')) return 'ms';
  if (k.endsWith('_s')) return 's';
  return '';
}

function words(key: string): string {
  return key.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

function aliasesOf(f: Fact): string[] {
  try {
    return factAliases(f);
  } catch {
    return [];
  }
}

function makeFact(stem: string, artifact: string, sha: string, idPath: string, locator: string, value: number, unit: string, definition: string, uncertainties: Record<string, number> = {}): Fact {
  const f: Fact = {
    id: `f.${stem}.${idPath}`.replace(/[^A-Za-z0-9_.-]+/g, '_'),
    kind: 'number',
    value,
    sigfigs: null,
    unit,
    uncertainties,
    definition,
    definitionSource: `key names of ${artifact}`,
    artifact,
    locator,
    artifactSha256: sha,
    fingerprint: hashString(`${sha}|${locator}|${String(value)}`),
    stale: false,
    validationState: 'candidate',
    aliases: [],
    confirmed: false,
    excluded: false,
    proseOnly: false,
    tags: [`artifact:${artifact}`],
  };
  f.aliases = aliasesOf(f);
  return f;
}

/** Facts of one JSON result file: every numeric leaf (arrays by index). */
export function jsonFacts(raw: string, artifact: string, sha: string): Fact[] {
  const stem = artifact.replace(/^.*\//, '').replace(/\.json$/, '');
  const out: Fact[] = [];
  const walk = (v: unknown, path: string[]) => {
    if (typeof v === 'number' && Number.isFinite(v)) {
      const key = path[path.length - 1] ?? stem;
      const named = path.filter((p) => !/^\d+$/.test(p)).pop() ?? key;
      out.push(makeFact(stem, artifact, sha, path.join('.'), `#/${path.join('/')}`, v, unitOfKey(named), `${words(stem)}: ${path.map(words).join(' / ')}`));
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, String(i)]));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, [...path, k]);
  };
  try {
    walk(JSON.parse(raw), []);
  } catch {
    /* not JSON: no facts */
  }
  return out;
}

/** Facts of one CSV result file: numeric cells, rows named by the first column, `x_sigma` as x's uncertainty. */
export function csvFacts(raw: string, artifact: string, sha: string): Fact[] {
  const stem = artifact.replace(/^.*\//, '').replace(/\.csv$/, '');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const head = (lines[0] ?? '').split(',').map((h) => h.trim());
  const out: Fact[] = [];
  lines.slice(1).forEach((line, r) => {
    const cells = line.split(',').map((c) => c.trim());
    const rowName = cells[0] ?? String(r);
    head.forEach((col, c) => {
      if (c === 0 || col.endsWith('_sigma')) return;
      const v = Number(cells[c]);
      if (cells[c] === '' || !Number.isFinite(v)) return;
      const sigIdx = head.indexOf(`${col}_sigma`);
      const sig = sigIdx >= 0 ? Number(cells[sigIdx]) : NaN;
      out.push(makeFact(stem, artifact, sha, `${rowName}.${col}`, `csv:row=${r + 1};col=${col}`, v, unitOfKey(col), `${words(stem)}, ${words(head[0] ?? 'row')} ${rowName}: ${words(col)}`, Number.isFinite(sig) ? { total: sig } : {}));
    });
  });
  return out;
}

export function largeMockOptions(base: MockOptions = {}): MockOptions {
  return {
    ...base,
    files: LARGE_FILES,
    mainFile: 'main.tex',
    projectName: 'large-multifile',
    bib: refsBib,
    claimJson: headlineJson,
    claimArtifact: 'results/headline_claim.json',
    extraFacts: async (sha) => {
      const facts: Fact[] = [];
      for (const [path, raw] of Object.entries(RESULTS).sort(([a], [b]) => a.localeCompare(b))) {
        const artifact = `results/${path.replace(/^.*\//, '')}`;
        if (artifact === 'results/headline_claim.json') continue;
        const h = await sha(raw);
        facts.push(...(artifact.endsWith('.csv') ? csvFacts(raw, artifact, h) : jsonFacts(raw, artifact, h)));
      }
      return facts;
    },
  };
}

export function createLargeMock(base: MockOptions = {}): MockApiClient {
  return new MockApiClient(largeMockOptions(base));
}
