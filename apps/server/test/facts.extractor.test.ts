import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashString } from '@paper-copilot/core';
import { parseCsv } from '../src/services/facts/csv';
import {
  assignStems,
  buildCsvModel,
  classifyUncertainty,
  extractArtifactText,
  extractRepo,
  pairUncertainties,
  parseJsonLenient,
  parseLocator,
  resolveLocatorInText,
  sha256Hex,
  stemParts,
  unitFromName,
} from '../src/services/facts/extractor';
import { compileGlob, listMatchingFiles, matchAny, matchGlob } from '../src/services/facts/glob';
import { findComparisons, parseDefinitionsMarkdown, plainMdLine } from '../src/services/facts/markdown';
import { FIXTURE } from './helpers/ctx';

/** Shared CI runners are slower and noisier than a laptop: timing budgets get 3x slack there. */
const PERF_SLACK = process.env.CI ? 3 : 1;

const REPO = join(FIXTURE, 'repo');
const GLOBS = ['results/**/*.json', 'results/**/*.csv', 'docs/definitions.md'];
const CANTO = '/tmp/claude-0/-home-user/ee5dec42-8975-54cc-ab2d-58a63ecab31c/scratchpad/repos/Displaced_tracks_GNN';
const quiet = { info: () => undefined, warn: () => undefined, debug: () => undefined };

describe('glob matcher', () => {
  it('handles **, *, ?, {a,b} and classes', () => {
    expect(matchGlob('results/**/*.json', 'results/a.json')).toBe(true);
    expect(matchGlob('results/**/*.json', 'results/x/y/a.json')).toBe(true);
    expect(matchGlob('results/**/*.json', 'other/a.json')).toBe(false);
    expect(matchGlob('results/*.json', 'results/x/a.json')).toBe(false);
    expect(matchGlob('results/**/*.{json,csv,md}', 'results/t/a.csv')).toBe(true);
    expect(matchGlob('results/**/*.{json,csv,md}', 'results/t/a.txt')).toBe(false);
    expect(matchGlob('{results,docs}/**/*.md', 'docs/definitions.md')).toBe(true);
    expect(matchGlob('docs/definitions.md', 'docs/definitions.md')).toBe(true);
    expect(matchGlob('docs/definitions.md', 'docs/definitionsXmd')).toBe(false);
    expect(matchGlob('r?n.csv', 'run.csv')).toBe(true);
    expect(matchGlob('r?n.csv', 'r/n.csv')).toBe(false);
    expect(matchGlob('x_[ab].csv', 'x_a.csv')).toBe(true);
    expect(matchGlob('x_[!ab].csv', 'x_a.csv')).toBe(false);
    expect(matchGlob('**/*.json', 'a.json')).toBe(true);
    expect(matchGlob('**', 'deep/er/file')).toBe(true);
    expect(matchGlob('./results/*.json', 'results/a.json')).toBe(true);
  });

  it('does not match hidden files unless the pattern names them', () => {
    expect(matchGlob('results/**/*.json', 'results/.cache/a.json')).toBe(false);
    expect(matchGlob('results/*.json', 'results/.hidden.json')).toBe(false);
    expect(matchGlob('results/.cache/*.json', 'results/.cache/a.json')).toBe(true);
  });

  it('supports negated patterns and static bases', () => {
    const globs = ['results/**/*.csv', '!results/**/*_particles.csv'].map(compileGlob);
    expect(matchAny(globs, 'results/a.csv')).toBe(true);
    expect(matchAny(globs, 'results/x_particles.csv')).toBe(false);
    expect(compileGlob('results/**/*.json').base).toBe('results');
    expect(compileGlob('{a,b}/*.json').base).toBe('');
    expect(compileGlob('docs/definitions.md').base).toBe('docs');
  });

  it('lists matching files of the fixture repository, sorted', () => {
    const r = listMatchingFiles(REPO, GLOBS);
    expect(r.files).toEqual(['docs/definitions.md', 'results/addendum_g_g1_v1.csv', 'results/addendum_g_g1_v1_claim.json']);
    expect(listMatchingFiles(join(REPO, 'nope'), GLOBS).files).toEqual([]);
  });
});

describe('CSV parsing', () => {
  it('handles quotes, embedded commas/newlines, CRLF, BOM and ragged rows', () => {
    const t = parseCsv('﻿a,b,c\r\n1,"x, y",3\r\n"multi\nline","he said ""hi""",\r\n\r\n4,5\n');
    expect(t.header).toEqual(['a', 'b', 'c']);
    expect(t.rows).toEqual([
      ['1', 'x, y', '3'],
      ['multi\nline', 'he said "hi"', ''],
      ['4', '5', ''],
    ]);
    expect(t.ragged).toBe(1);
  });

  it('detects TSV and semicolon delimiters, de-duplicates header names', () => {
    expect(parseCsv('a\tb\n1\t2').rows).toEqual([['1', '2']]);
    expect(parseCsv('a;b\n1;2').rows).toEqual([['1', '2']]);
    expect(parseCsv('x,x,,y\n1,2,3,4').header).toEqual(['x', 'x_2', 'col3', 'y']);
  });

  it('labels rows by the shortest unique run of string columns', () => {
    const m = buildCsvModel(parseCsv('sample,model,label,mean,sigma\ns1,a,A,0.5,0.1\ns1,b,B,0.6,0.1\n'));
    expect(m.rowLabels).toEqual(['s1.a', 's1.b']);
    const dup = buildCsvModel(parseCsv('model,x\na,1\na,2\nb,3\n'));
    expect(dup.rowLabels).toEqual(['a.r1', 'a.r2', 'b']);
    const none = buildCsvModel(parseCsv('x,y\n1,2\n3,4\n'));
    expect(none.rowLabels).toEqual(['r1', 'r2']);
  });
});

describe('uncertainty pairing and names', () => {
  it('pairs sigma_points with delta_points (adjacent), not fake_rate_diff_points', () => {
    const names = ['n_targets', 'eff_A', 'eff_B', 'delta_points', 'sigma_points', 'sigma_boot_points', 'sigma_seeds_points', 'delta_minus_2sigma', 'margin', 'fake_rate_diff_points'];
    const p = pairUncertainties(names);
    expect(p.get('sigma_points')).toEqual({ value: 'delta_points', label: 'total' });
    expect(p.get('sigma_boot_points')).toEqual({ value: 'delta_points', label: 'boot' });
    expect(p.get('sigma_seeds_points')).toEqual({ value: 'delta_points', label: 'seeds' });
    expect(p.has('delta_minus_2sigma')).toBe(false);
  });

  it('pairs CSV mean with sigma_boot, s_seeds, sigma and ceiling with ceiling_sigma', () => {
    const p = pairUncertainties(['n', 'eff_s0', 'mean', 'sigma_boot', 's_seeds', 'sigma', 'n_seeds', 'ceiling', 'ceiling_sigma']);
    expect(p.get('sigma_boot')).toEqual({ value: 'mean', label: 'boot' });
    expect(p.get('s_seeds')).toEqual({ value: 'mean', label: 'seeds' });
    expect(p.get('sigma')).toEqual({ value: 'mean', label: 'total' });
    expect(p.get('ceiling_sigma')).toEqual({ value: 'ceiling', label: 'total' });
    expect(p.has('eff_s0')).toBe(false);
  });

  it('leaves ambiguous or unrelated fields unpaired', () => {
    // Two values end in _points and the uncertainty is not next to either.
    expect(pairUncertainties(['a_points', 'x', 'b_points', 'y', 'sigma_points']).size).toBe(0);
    // A suffix uncertainty without its value.
    expect(pairUncertainties(['eff', 'ceiling_sigma']).size).toBe(0);
    expect(classifyUncertainty('n_sigma')).toBeNull();
    expect(classifyUncertainty('nsig')).toBeNull();
    expect(classifyUncertainty('seed_sd')).toEqual({ form: 'prefix', qualifiers: ['seed'], remainder: [], base: [] });
  });

  it('infers units from field names only', () => {
    expect(unitFromName('delta_points')).toBe('points');
    expect(unitFromName('sigma_boot_points')).toBe('points');
    expect(unitFromName('pt_min_gev')).toBe('GeV');
    expect(unitFromName('d0_mm_max')).toBe('mm');
    expect(unitFromName('elapsed_s')).toBe('s');
    expect(unitFromName('eff_s0')).toBe('');
    expect(unitFromName('eff_A')).toBe('');
  });
});

describe('stems', () => {
  it('derives short stems and resolves collisions deterministically', () => {
    expect(stemParts('results/addendum_g_g1_v1_claim.json').short).toBe('g1');
    expect(stemParts('results/addendum_g_g1_v1.csv').short).toBe('g1');
    const s = assignStems(['results/addendum_g_g1_v1.csv', 'results/addendum_g_g1_v1_claim.json', 'docs/definitions.md']);
    expect(s).toEqual({ 'results/addendum_g_g1_v1_claim.json': 'g1', 'results/addendum_g_g1_v1.csv': 'g1csv', 'docs/definitions.md': 'definitions' });
    const v = assignStems(['results/r/ranking_val_v1.csv', 'results/r/ranking_val_v2.csv']);
    expect(v).toEqual({ 'results/r/ranking_val_v1.csv': 'ranking_val_v1', 'results/r/ranking_val_v2.csv': 'ranking_val_v2' });
  });

  it('keeps pinned stems and never hands them to a newcomer', () => {
    const pinned = { 'results/x_v1.csv': 'x' };
    const s = assignStems(['results/x_v1.csv', 'results/x_claim.json'], pinned);
    expect(s['results/x_v1.csv']).toBe('x');
    expect(s['results/x_claim.json']).not.toBe('x');
  });
});

describe('markdown definitions', () => {
  it('splits a definition line into cut facts with unit and comparison', () => {
    const plain = plainMdLine('- **Target (reconstructable) particle**: pT > 1 GeV, |eta| < 4 (table values) and >= 5 space points');
    const c = findComparisons(plain);
    expect(c.map((x) => [x.qty, x.op, x.value, x.unit, x.noun])).toEqual([
      ['pT', '>', 1, 'GeV', null],
      ['|eta|', '<', 4, '', null],
      [null, '>=', 5, '', 'space points'],
    ]);
  });

  it('ignores ranges, expressions and bare bounds', () => {
    expect(findComparisons('90 % below 0.052-0.061 mm')).toEqual([]);
    expect(findComparisons('fixed R = 1000 pT / (0.3 x 2.0) mm = 1666.67 mm x pT[GeV]')).toEqual([]);
    expect(findComparisons('[100, 300), and >= 300 shown as overflow')).toEqual([]);
    expect(findComparisons('T matches P if |T n P| > |T| / 2')).toEqual([]);
    expect(findComparisons('500 events -> /tmp/x')).toEqual([]);
    const set = findComparisons('Field: uniform B = 2 T along +z');
    expect(set.map((x) => [x.qty, x.op, x.value, x.unit])).toEqual([['B', '=', 2, 'T']]);
  });

  it('finds comparisons wrapped across lines and keeps the operator line', () => {
    const md = '- Comparison: 113 W muons have |eta| > 4 and >= 5\n  forward hits.\n';
    const facts = parseDefinitionsMarkdown(md, 'docs/d.md');
    const fwd = facts.find((f) => f.idPart === 'forward_hits_ge_5');
    expect(fwd?.line).toBe(1);
    expect(facts.find((f) => f.idPart === 'eta_gt_4')?.value).toBe(4);
  });

  it('reads markdown tables (escaped bars), HTML entities and Greek quantities', () => {
    const facts = parseDefinitionsMarkdown('| Target | pT > 1.0 GeV, \\|η\\| < 4.0 |\n| Cut | E &gt; 5 GeV |\n', 'docs/paper_facts.md');
    const eta = facts.find((f) => f.idPart === 'eta_lt_4p0')!;
    expect(eta).toMatchObject({ value: 4, unit: '' });
    expect(eta.definition).toMatch(/^\|η\| < 4\.0/);
    expect(facts.find((f) => f.idPart === 'pT_gt_1p0GeV')?.value).toBe(1);
    expect(facts.find((f) => f.idPart === 'E_gt_5GeV')?.unit).toBe('GeV');
  });

  it('skips fenced code and records sections', () => {
    const md = '# 2. Cuts\n\n```\npT > 99 GeV\n```\n- Jets: pT > 30 GeV\n';
    const facts = parseDefinitionsMarkdown(md, 'docs/d.md');
    expect(facts.some((f) => f.value === 99)).toBe(false);
    const cut = facts.find((f) => f.kind === 'cut')!;
    expect(cut.idPart).toBe('pT_gt_30GeV');
    expect(cut.definition).toContain('section "2. Cuts"');
    expect(cut.line).toBe(6);
  });
});

describe('extractor on fixtures/canto-demo/repo', () => {
  it('extracts the G1 claim facts with pointer locators, uncertainties and metadata definitions', async () => {
    const r = await extractRepo(REPO, GLOBS, { log: quiet });
    expect(r.stems['results/addendum_g_g1_v1_claim.json']).toBe('g1');
    const byId = new Map(r.facts.map((f) => [f.id, f]));
    const claimPath = join(REPO, 'results/addendum_g_g1_v1_claim.json');
    const sha = sha256Hex(readFileSync(claimPath));
    const d = byId.get('f.g1.delta_points')!;
    expect(d).toBeDefined();
    expect(d.kind).toBe('number');
    expect(d.value).toBe(2.3191733639494783);
    expect(d.unit).toBe('points');
    expect(d.locator).toBe('#/delta_points');
    expect(d.artifact).toBe('results/addendum_g_g1_v1_claim.json');
    expect(d.artifactSha256).toBe(sha);
    expect(d.fingerprint).toBe(hashString(sha + '|#/delta_points|' + String(2.3191733639494783)));
    expect(d.uncertainties).toEqual({ total: 0.27929769909842683, boot: 0.16394439763346172, seeds: 0.22611819742399497 });
    for (const piece of ['claim=G1', 'A=Canto-L (ttbar)', 'B=acorn (HNL) + LM', 'population=P_G', 'split=generic_iso union test (T1 deviation 13a)', 'n_targets=8710']) {
      expect(d.definition).toContain(piece);
    }
    expect(d.definitionSource).toMatch(/^metadata: claim, A, B, population, split/);
    // Paired uncertainties are not facts of their own.
    expect(byId.has('f.g1.sigma_points')).toBe(false);
    expect(byId.has('f.g1.sigma_boot_points')).toBe(false);
    // Fractions are kept as stored, unit '' and tagged.
    const effA = byId.get('f.g1.eff_A')!;
    expect(effA.value).toBe(0.9694221201683888);
    expect(effA.unit).toBe('');
    expect(effA.tags).toContain('fraction');
    expect(byId.get('f.g1.fake_rate_A')!.tags).toContain('fraction');
    expect(byId.get('f.g1.fake_rate_diff_points')!.tags).not.toContain('fraction');
    expect(byId.get('f.g1.n_targets')!.value).toBe(8710);
    expect(byId.get('f.g1.n_targets')!.tags).toContain('count');
    expect(byId.get('f.g1.n_targets')!.definition).not.toContain('n_targets=8710');
    expect(byId.get('f.g1.eff_A_seeds.1')!.locator).toBe('#/eff_A_seeds/1');
    // Booleans and strings are metadata only.
    expect([...byId.keys()].some((id) => /fake_rate_guard_ok|outcome|underpowered/.test(id))).toBe(false);
  });

  it('extracts CSV cells labelled by their string columns, with paired uncertainties', async () => {
    const r = await extractRepo(REPO, GLOBS, { log: quiet });
    const byId = new Map(r.facts.map((f) => [f.id, f]));
    const mean = byId.get('f.g1csv.generic_iso.P_G.canto_l_ttbar.mean')!;
    expect(mean).toBeDefined();
    expect(mean.value).toBe(0.9694221201683888);
    expect(mean.locator).toBe('csv:row=1;col=mean');
    expect(mean.uncertainties).toEqual({ boot: 0.0018096711939944463, seeds: 0.0025603870927941213, total: 0.0023366865112851992 });
    expect(mean.definition).toContain('label=Canto-L (ttbar)');
    expect(mean.definition).toContain('n=8710');
    const ceiling = byId.get('f.g1csv.generic_iso.P_G.acorn_hnl_lm.ceiling')!;
    expect(ceiling.locator).toBe('csv:row=2;col=ceiling');
    expect(ceiling.uncertainties).toEqual({ total: 0.002564828571078461 });
    // Row 7 has a population with a space; empty seed cells give no facts.
    expect(byId.has('f.g1csv.generic_iso.displaced-source_targets.canto_l_ttbar.mean')).toBe(true);
    expect(byId.has('f.g1csv.generic_iso.P_G.canto_l_hnl.eff_s1')).toBe(false);
    expect(byId.get('f.g1csv.generic_iso.P_G.canto_l_hnl.eff_s0')!.tags).toContain('fraction');
    expect([...byId.keys()].some((id) => id.startsWith('f.g1csv.') && /\.(sigma|sigma_boot|s_seeds|ceiling_sigma)$/.test(id))).toBe(false);
  });

  it('extracts the definitions cuts with md:line locators', async () => {
    const r = await extractRepo(REPO, GLOBS, { log: quiet });
    const byId = new Map(r.facts.map((f) => [f.id, f]));
    const pt = byId.get('f.definitions.pT_gt_1GeV')!;
    expect(pt).toMatchObject({ kind: 'cut', value: 1, unit: 'GeV', locator: 'md:line=60' });
    expect(pt.tags).toEqual(['cut', 'cmp:>']);
    expect(pt.definition).toContain('Target (reconstructable) particle');
    expect(byId.get('f.definitions.eta_lt_4')).toMatchObject({ kind: 'cut', value: 4, unit: '', locator: 'md:line=60' });
    expect(byId.get('f.definitions.space_points_ge_5')).toMatchObject({ kind: 'cut', value: 5, unit: '', locator: 'md:line=60' });
    expect(byId.get('f.definitions.pixel_hits_ge_3')).toMatchObject({ value: 3, locator: 'md:line=61' });
    expect(byId.get('f.definitions.B_eq_2T')).toMatchObject({ kind: 'setting', value: 2, unit: 'T' });
    const target = byId.get('f.definitions.Target_reconstructable_particle')!;
    expect(target.kind).toBe('definition');
    expect(String(target.value)).toContain('pT > 1 GeV, |eta| < 4 (table values) and >= 5 space points');
    // Repeated cuts get suffixes in document order.
    expect(byId.has('f.definitions.T_ge_5')).toBe(true);
    expect(byId.has('f.definitions.T_ge_5~2')).toBe(true);
  });

  it('is deterministic and ids are unique', async () => {
    const a = await extractRepo(REPO, GLOBS, { log: quiet });
    const b = await extractRepo(REPO, GLOBS, { log: quiet });
    expect(a.facts.map((f) => f.id)).toEqual(b.facts.map((f) => f.id));
    expect(new Set(a.facts.map((f) => f.id)).size).toBe(a.facts.length);
    expect(a.facts.length).toBeGreaterThan(100);
  });

  it('respects the per-artifact and total caps, keeping patched ids', async () => {
    const capped = await extractRepo(REPO, GLOBS, { log: quiet, maxFactsPerArtifact: 10 });
    expect(capped.facts.filter((f) => f.artifact.endsWith('.csv')).length).toBe(10);
    expect(capped.cappedArtifacts).toContain('results/addendum_g_g1_v1.csv');
    const keep = new Set(['f.g1csv.generic_iso.displaced-source_targets.canto_l_tthnl.ceiling']);
    const kept = await extractRepo(REPO, GLOBS, { log: quiet, maxFactsPerArtifact: 10, keepIds: keep });
    expect(kept.facts.some((f) => keep.has(f.id))).toBe(true);
    const total = await extractRepo(REPO, GLOBS, { log: quiet, maxFactsTotal: 10 });
    expect(total.facts.length).toBe(10);
    // Claim JSON is served first; the remaining artifacts are not read at all.
    expect(total.facts.every((f) => f.artifact === 'results/addendum_g_g1_v1_claim.json')).toBe(true);
    expect(total.skippedForBudget.sort()).toEqual(['docs/definitions.md', 'results/addendum_g_g1_v1.csv']);
    // With room for 20, the small markdown file comes before the larger CSV table.
    const twenty = await extractRepo(REPO, GLOBS, { log: quiet, maxFactsTotal: 20 });
    expect([...new Set(twenty.facts.map((f) => f.artifact))].sort()).toEqual(['docs/definitions.md', 'results/addendum_g_g1_v1_claim.json']);
  });
});

describe('JSON details', () => {
  it('accepts NaN / Infinity written by Python and skips long numeric arrays', () => {
    expect(parseJsonLenient('{"a": NaN, "b": [1, Infinity, -Infinity], "c": "NaN"}')).toEqual({ a: null, b: [1, null, null], c: 'NaN' });
    const text = JSON.stringify({ label: 'x', events: Array.from({ length: 100 }, (_, i) => i), eff: 0.5, deep: { list: [{ name: 'k', v_mm: 3 }] } });
    const r = extractArtifactText('results/t.json', text, 'sha', 't');
    expect(r.skippedArrays).toBe(1);
    expect(r.facts.map((f) => f.id)).toEqual(['f.t.eff', 'f.t.deep.list.0.v_mm']);
    const v = r.facts[1]!;
    expect(v.locator).toBe('#/deep/list/0/v_mm');
    expect(v.unit).toBe('mm');
    expect(v.definition).toBe('deep.list[0].v_mm (name=k; label=x)');
  });

  it('handles a file that holds a single number, and huge objects without quadratic pairing', () => {
    const one = extractArtifactText('results/n.json', '42.5\n', 'sha', 'n');
    expect(one.facts.map((f) => [f.id, f.locator, f.value])).toEqual([['f.n.value', '#', 42.5]]);
    const r = resolveLocatorInText('results/n.json', '42.5', '#', false);
    expect(r.ok && [r.r.idPath, r.r.locator, r.r.value]).toEqual(['value', '#', 42.5]);
    const big: Record<string, number> = {};
    for (let i = 0; i < 20000; i++) big[`sigma_${i}`] = i;
    const t0 = Date.now();
    const res = extractArtifactText('results/big.json', JSON.stringify(big), 'sha', 'big');
    expect(Date.now() - t0).toBeLessThan(2000 * PERF_SLACK);
    expect(res.facts.length).toBe(5000);
    expect(res.droppedByCap).toBe(15000);
  });

  it('escapes pointer tokens and reports unreadable files', () => {
    const r = extractArtifactText('results/t.json', JSON.stringify({ 'a/b': { 'c~d': 1 } }), 'sha', 't');
    expect(r.facts[0]!.locator).toBe('#/a~1b/c~0d');
    expect(r.facts[0]!.id).toBe('f.t.a_b.c_d');
    expect(extractArtifactText('results/bad.json', '{"a": ', 'sha', 'bad').status).toBe('unreadable');
  });
});

describe('locators', () => {
  const claimText = readFileSync(join(REPO, 'results/addendum_g_g1_v1_claim.json'), 'utf8');
  const csvText = readFileSync(join(REPO, 'results/addendum_g_g1_v1.csv'), 'utf8');

  it('parses the three locator forms', () => {
    expect(parseLocator('#/a/b~1c/0')).toEqual({ type: 'json', tokens: ['a', 'b/c', '0'] });
    expect(parseLocator('csv:row=3;col=eff')).toEqual({ type: 'csv', row: 3, col: 'eff' });
    expect(parseLocator('md:line=12;match=96.94%25')).toEqual({ type: 'md', line: 12, match: '96.94%', occurrence: null });
    expect(parseLocator('yaml:a.b').type).toBe('invalid');
    expect(parseLocator('somewhere').type).toBe('invalid');
  });

  it('reads values at JSON pointers and CSV cells by code', () => {
    const j = resolveLocatorInText('results/addendum_g_g1_v1_claim.json', claimText, '#/eff_B', false);
    expect(j.ok && j.r.value).toBe(0.946230386528894);
    const u = resolveLocatorInText('results/addendum_g_g1_v1_claim.json', claimText, '#/sigma_points', false);
    expect(u.ok && u.r.coveredBy).toBe('#/delta_points');
    expect(resolveLocatorInText('results/addendum_g_g1_v1_claim.json', claimText, '#/nope', false).ok).toBe(false);
    expect(resolveLocatorInText('results/addendum_g_g1_v1_claim.json', claimText, '#/A', false).ok).toBe(false);
    const s = resolveLocatorInText('results/addendum_g_g1_v1_claim.json', claimText, '#/A', true);
    expect(s.ok && s.r.value).toBe('Canto-L (ttbar)');
    const c = resolveLocatorInText('results/addendum_g_g1_v1.csv', csvText, 'csv:row=2;col=mean', false);
    expect(c.ok && c.r.value).toBe(0.946230386528894);
    expect(c.ok && c.r.idPath).toBe('generic_iso.P_G.acorn_hnl_lm.mean');
    expect(resolveLocatorInText('results/addendum_g_g1_v1.csv', csvText, 'csv:row=99;col=mean', false).ok).toBe(false);
    expect(resolveLocatorInText('results/addendum_g_g1_v1.csv', csvText, 'csv:row=1;col=nope', false).ok).toBe(false);
  });

  it('reads one number from a markdown line, and refuses an ambiguous line', () => {
    const md = 'Intro\nThe tracker finds 96.94% of the targets.\nIt finds 96.94% against 94.62%.\n';
    const one = resolveLocatorInText('README.md', md, 'md:line=2', false);
    expect(one.ok && one.r.value).toBe(96.94);
    const amb = resolveLocatorInText('README.md', md, 'md:line=3', false);
    expect(amb.ok).toBe(false);
    if (!amb.ok) expect(amb.reason).toMatch(/2 numbers/);
    const picked = resolveLocatorInText('README.md', md, 'md:line=3;match=94.62%25', false);
    expect(picked.ok && picked.r.value).toBe(94.62);
  });
});

describe.skipIf(!existsSync(CANTO))('extractor on the full Canto repository (read-only)', () => {
  it('extracts within the caps, with unique ids, in under 3 s', async () => {
    const warnings: string[] = [];
    const t0 = Date.now();
    const r = await extractRepo(CANTO, GLOBS, { log: { ...quiet, warn: (m) => warnings.push(m) } });
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(3000 * PERF_SLACK);
    expect(r.facts.length).toBeGreaterThan(1000);
    expect(r.facts.length).toBeLessThanOrEqual(50000);
    expect(new Set(r.facts.map((f) => f.id)).size).toBe(r.facts.length);
    const perArtifact = new Map<string, number>();
    for (const f of r.facts) perArtifact.set(f.artifact, (perArtifact.get(f.artifact) ?? 0) + 1);
    expect(Math.max(...perArtifact.values())).toBeLessThanOrEqual(5000);
    // The headline claim is there, with its uncertainties.
    const d = r.facts.find((f) => f.id === 'f.g1.delta_points');
    expect(d?.uncertainties.total).toBeCloseTo(0.2793, 4);
    // Python NaN/Infinity files parse; nothing is unreadable.
    expect(r.artifacts.filter((a) => a.status === 'unreadable')).toEqual([]);
    expect(warnings.some((w) => w.includes('total cap'))).toBe(true);
    expect(Object.values(r.stems).length).toBe(new Set(Object.values(r.stems)).size);
  });
});
