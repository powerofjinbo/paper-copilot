import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkSentenceFacts, Bm25Index, nowIso, type Claim, type SentenceUnit } from '@paper-copilot/core';
import type { DocService, FactService } from '../src/contracts';
import { HttpError } from '../src/contracts';
import { createFactService, type FactServiceImpl } from '../src/services/facts/factService';
import { makeTempProject, makeTestCtx, type TempProject } from './helpers/ctx';

function notImplemented(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return String(e).includes('not implemented');
  }
}
const linkReady = !notImplemented(() => linkSentenceFacts('x 1.5 y', []));
const bm25Ready = !notImplemented(() => new Bm25Index([]).search('x', 1));

function unit(id: string, facts: string[] = []): SentenceUnit {
  return {
    id,
    file: 'main.tex',
    start: 0,
    end: 10,
    line: 1,
    hash: 'h',
    ctxHash: '',
    textNorm: '',
    sectionId: 'sec:results',
    paragraphId: 'p1',
    part: 'body',
    kind: 'prose',
    move: null,
    state: 'human',
    everAi: false,
    grammarFixed: false,
    imported: true,
    model: null,
    promptHash: null,
    createdAt: nowIso(),
    acceptedAt: null,
    editDistance: null,
    intentNote: null,
    facts,
    cites: [],
    claims: [],
    placeholders: [],
    orphaned: false,
    splitFrom: null,
  };
}

function fakeDocs(units: SentenceUnit[], texts: Record<string, string>) {
  const updates: Array<{ id: string; patch: Partial<SentenceUnit> }> = [];
  const docs = {
    allUnits: () => units,
    unitText: (id: string) => texts[id] ?? null,
    updateUnit: (id: string, patch: Partial<SentenceUnit>) => {
      updates.push({ id, patch });
      const u = units.find((x) => x.id === id);
      if (!u) throw new Error(`unknown unit ${id}`);
      Object.assign(u, patch);
      return u;
    },
  } as unknown as DocService;
  return { docs, updates };
}

let project: TempProject;
let created: FactServiceImpl[] = [];
beforeEach(async () => {
  project = await makeTempProject();
  created = [];
});
afterEach(async () => {
  await Promise.all(created.map((f) => f.flush()));
  project.cleanup();
});

function track(f: FactServiceImpl): FactServiceImpl {
  created.push(f);
  return f;
}

function setup(overrides: Parameters<typeof makeTestCtx>[1] = {}) {
  const ctx = makeTestCtx(project, overrides);
  const facts = track(createFactService(ctx));
  (ctx as { facts: FactService }).facts = facts;
  return { ctx, facts };
}

const CLAIM = 'results/addendum_g_g1_v1_claim.json';

function editClaim(fn: (o: Record<string, unknown>) => void) {
  const p = join(project.repoDir, CLAIM);
  const o = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  fn(o);
  writeFileSync(p, JSON.stringify(o, null, 1));
}

describe('FactService.rescan', () => {
  it('scans the repository, persists facts.json and emits facts.updated', async () => {
    const { ctx, facts } = setup();
    expect(facts.all()).toEqual([]);
    const r = await facts.rescan();
    expect(r.count).toBeGreaterThan(100);
    expect(r.stale).toEqual([]);
    const d = facts.get('f.g1.delta_points')!;
    expect(d).toMatchObject({ value: 2.3191733639494783, unit: 'points', stale: false, confirmed: false, excluded: false, validationState: 'candidate', sigfigs: null });
    expect(d.uncertainties.total).toBe(0.27929769909842683);
    expect(ctx.events.filter((e) => e.type === 'facts.updated')).toEqual([{ type: 'facts.updated', count: r.count, stale: [] }]);
    await facts.flush();
    const stored = JSON.parse(readFileSync(ctx.paths.facts, 'utf8'));
    expect(stored.schemaVersion).toBe(1);
    expect(stored.stems['results/addendum_g_g1_v1_claim.json']).toBe('g1');
    expect(stored.facts.length).toBe(r.count);
    // A second service instance starts from the stored state, without scanning.
    const again = track(createFactService(ctx));
    expect(again.get('f.g1.delta_points')?.value).toBe(2.3191733639494783);
    expect(again.scannedAt()).not.toBeNull();
  });

  it('marks only the edited fact stale, revokes its confirmation, and confirm clears it', async () => {
    const { ctx, facts } = setup();
    await facts.rescan();
    facts.patch('f.g1.eff_A', { confirmed: true });
    facts.patch('f.g1.eff_B', { confirmed: true });
    const shaBefore = facts.get('f.g1.eff_B')!.artifactSha256;
    editClaim((o) => {
      o.eff_A = 0.9711;
    });
    ctx.events.length = 0;
    const r = await facts.rescan();
    expect(r.stale).toEqual(['f.g1.eff_A']);
    const a = facts.get('f.g1.eff_A')!;
    expect(a).toMatchObject({ value: 0.9711, stale: true, confirmed: false });
    // Same value, new artifact hash: updated, not stale, still confirmed.
    const b = facts.get('f.g1.eff_B')!;
    expect(b.stale).toBe(false);
    expect(b.confirmed).toBe(true);
    expect(b.artifactSha256).not.toBe(shaBefore);
    expect(ctx.events.find((e) => e.type === 'facts.updated')).toEqual({ type: 'facts.updated', count: r.count, stale: ['f.g1.eff_A'] });
    // Stale is sticky across rescans until the author confirms the new value.
    expect((await facts.rescan()).stale).toEqual(['f.g1.eff_A']);
    const c = facts.patch('f.g1.eff_A', { confirmed: true });
    expect(c.stale).toBe(false);
    expect((await facts.rescan()).stale).toEqual([]);
  });

  it('keeps a patched fact whose field disappeared as missing (stale, excluded) and drops unused ones', async () => {
    const { facts } = setup();
    await facts.rescan();
    facts.patch('f.g1.margin', { definition: 'the preregistered margin' });
    editClaim((o) => {
      delete o.margin;
      delete o.fake_rate_B;
    });
    const r = await facts.rescan();
    const m = facts.get('f.g1.margin')!;
    expect(m).toMatchObject({ stale: true, excluded: true, definition: 'the preregistered margin' });
    expect(m.tags).toContain('missing');
    expect(r.stale).toContain('f.g1.margin');
    expect(facts.get('f.g1.fake_rate_B')).toBeUndefined();
    expect(facts.forPrompt({ factIds: ['f.g1.margin'] }).some((f) => f.id === 'f.g1.margin')).toBe(false);
    // The field comes back with the same value: no longer missing; the author's definition stays.
    editClaim((o) => {
      o.margin = 1.0;
    });
    await facts.rescan();
    expect(facts.get('f.g1.margin')).toMatchObject({ stale: false, excluded: false, definition: 'the preregistered margin' });
  });

  it('treats a deleted or unparsable artifact as missing for patched and linked facts', async () => {
    const units = [unit('u1', ['f.g1csv.generic_iso.P_G.canto_l_ttbar.mean'])];
    const { docs } = fakeDocs(units, { u1: 'x' });
    const { facts } = setup({ docs });
    await facts.rescan();
    facts.patch('f.g1.delta_points', { confirmed: true });
    writeFileSync(join(project.repoDir, CLAIM), '{"broken": ');
    rmSync(join(project.repoDir, 'results/addendum_g_g1_v1.csv'));
    await facts.rescan();
    expect(facts.get('f.g1.delta_points')).toMatchObject({ stale: true, excluded: true });
    expect(facts.get('f.g1csv.generic_iso.P_G.canto_l_ttbar.mean')).toMatchObject({ stale: true, excluded: true });
    expect(facts.get('f.g1.eff_A')).toBeUndefined();
    expect(facts.get('f.g1csv.generic_iso.P_G.acorn_hnl_lm.mean')).toBeUndefined();
  });

  it('coalesces concurrent rescans and survives a missing repository', async () => {
    const { ctx, facts } = setup();
    const [a, b, c] = await Promise.all([facts.rescan(), facts.rescan(), facts.rescan()]);
    expect(a.count).toBe(b.count);
    expect(b.count).toBe(c.count);
    await ctx.saveConfig({ ...ctx.config, repoDir: join(project.root, 'nope') });
    const r = await facts.rescan();
    expect(r.count).toBe(a.count); // facts kept as they are
  });

  it('respects config.factGlobs, including exclusions', async () => {
    const { ctx, facts } = setup();
    await ctx.saveConfig({ ...ctx.config, factGlobs: ['results/**/*.json', '!results/**/*_claim.json', 'docs/*.md'] });
    await facts.rescan();
    expect(facts.all().some((f) => f.artifact === CLAIM)).toBe(false);
    expect(facts.get('f.definitions.pT_gt_1GeV')).toBeDefined();
  });

  it('moves a corrupt facts.json aside instead of losing it', async () => {
    const { ctx } = setup();
    writeFileSync(ctx.paths.facts, '{"schemaVersion": 1, "facts": [');
    const facts = track(createFactService(ctx));
    expect(facts.all()).toEqual([]);
    expect(readdirSync(ctx.paths.paper).some((f) => f.startsWith('facts.json.corrupt-'))).toBe(true);
  });
});

describe('FactService.patch', () => {
  it('persists patches across instances and rescans; empty definition reverts', async () => {
    const { ctx, facts } = setup();
    await facts.rescan();
    const original = facts.get('f.g1.delta_points')!.definition;
    const p = facts.patch('f.g1.delta_points', { confirmed: true, definition: 'Efficiency difference, Canto-L minus acorn', unit: 'percentage points', sigfigs: 2, tags: ['headline', 'headline', ' '] });
    expect(p).toMatchObject({ confirmed: true, definition: 'Efficiency difference, Canto-L minus acorn', unit: 'percentage points', sigfigs: 2, tags: ['headline'] });
    expect(p.definitionSource).toMatch(/^author/);
    facts.patch('f.g1.eff_B', { excluded: true });
    await facts.flush();
    const second = track(createFactService(ctx));
    expect(second.get('f.g1.delta_points')).toMatchObject({ confirmed: true, unit: 'percentage points', sigfigs: 2 });
    await second.rescan();
    expect(second.get('f.g1.delta_points')).toMatchObject({ confirmed: true, definition: 'Efficiency difference, Canto-L minus acorn' });
    expect(second.get('f.g1.eff_B')!.excluded).toBe(true);
    const reverted = second.patch('f.g1.delta_points', { definition: '' });
    expect(reverted.definition).toBe(original);
  });

  it('rejects unknown ids and invalid patches with HTTP errors', async () => {
    const { facts } = setup();
    await facts.rescan();
    expect(() => facts.patch('f.nope', { confirmed: true })).toThrow(HttpError);
    try {
      facts.patch('f.nope', {});
    } catch (e) {
      expect((e as HttpError).status).toBe(404);
    }
    try {
      facts.patch('f.g1.eff_A', { sigfigs: 0 });
    } catch (e) {
      expect((e as HttpError).status).toBe(400);
    }
    expect(() => facts.patch('f.g1.eff_A', { confirmed: 'yes' } as never)).toThrow(/invalid fact patch/);
  });

  it('keeps patched facts through the caps', async () => {
    const ctx = makeTestCtx(project);
    const facts = track(createFactService(ctx, { maxFactsPerArtifact: 5 }));
    await facts.rescan();
    expect(facts.get('f.g1.fake_rate_diff_points')).toBeUndefined();
    // Not extracted yet, so it cannot be patched; register it through a candidate, then patch.
    const big = track(createFactService(ctx));
    await big.rescan();
    big.patch('f.g1.fake_rate_diff_points', { confirmed: true });
    await big.flush();
    const small = track(createFactService(ctx, { maxFactsPerArtifact: 5 }));
    await small.rescan();
    expect(small.get('f.g1.fake_rate_diff_points')?.confirmed).toBe(true);
  });
});

describe('FactService.addManual', () => {
  it('adds an author fact (confirmed, candidate), refuses id clashes and bad input', async () => {
    const { facts } = setup();
    await facts.rescan();
    const f = facts.addManual({ id: 'manual.lumi', kind: 'setting', value: 139, unit: 'fb^-1', definition: 'Integrated luminosity of Run 2', uncertainties: { total: 2.4 } });
    expect(f).toMatchObject({ id: 'f.manual.lumi', artifact: '(manual)', confirmed: true, validationState: 'candidate', tags: ['manual'] });
    expect(() => facts.addManual({ id: 'f.g1.eff_A', kind: 'number', value: 1, unit: '', definition: 'x', uncertainties: {} })).toThrow(/already exists/);
    expect(() => facts.addManual({ id: 'f.bad id', kind: 'number', value: 1, unit: '', definition: 'x', uncertainties: {} })).toThrow(/invalid fact id/);
    expect(() => facts.addManual({ id: 'f.x', kind: 'number', value: 1, unit: '', definition: ' ', uncertainties: {} })).toThrow(/definition/);
    // Updating the same manual fact is allowed and survives rescans.
    facts.addManual({ id: 'f.manual.lumi', kind: 'setting', value: 140, unit: 'fb^-1', definition: 'Integrated luminosity of Run 2', uncertainties: {} });
    await facts.rescan();
    expect(facts.get('f.manual.lumi')?.value).toBe(140);
  });
});

describe('FactService.addCandidates', () => {
  it('reads values at locators, maps duplicates to existing facts, rejects what does not resolve', async () => {
    const { facts } = setup();
    await facts.rescan();
    writeFileSync(join(project.repoDir, 'README.md'), '# Canto\nThe tracker finds 96.94% of the isolated targets.\nIt finds 96.94% against 94.62%.\n');
    writeFileSync(join(project.repoDir, 'docs', 'extra.json'), JSON.stringify({ label: 'extra run', lumi_fb: 3.2, nested: { k: 7 } }));
    const base = { definition_paraphrase: 'model text', kind: 'number' as const, condition: 'within this simulation' };
    const res = await facts.addCandidates([
      { ...base, proposed_id: 'g1.delta', artifact: CLAIM, locator: '#/delta_points' },
      { ...base, proposed_id: 'g1.sigma', artifact: CLAIM, locator: '#/sigma_points' },
      { ...base, proposed_id: 'readme.headline_eff', artifact: 'README.md', locator: 'md:line=2' },
      { ...base, proposed_id: 'readme.two', artifact: 'README.md', locator: 'md:line=3' },
      { ...base, proposed_id: 'extra.lumi', artifact: 'docs/extra.json', locator: '#/lumi_fb' },
      { ...base, proposed_id: 'nope', artifact: CLAIM, locator: '#/does_not_exist' },
      { ...base, proposed_id: 'escape', artifact: '../outside.json', locator: '#/x' },
      { ...base, proposed_id: 'abs', artifact: '/etc/passwd', locator: 'md:line=1' },
      { ...base, proposed_id: 'yaml', artifact: CLAIM, locator: 'yaml:a.b' },
      { proposed_id: 'junk' },
    ] as never);
    const ids = res.added.map((f) => f.id);
    expect(ids).toContain('f.g1.delta_points');
    expect(ids.filter((x) => x === 'f.g1.delta_points').length).toBe(2); // sigma_points belongs to delta_points
    const readme = res.added.find((f) => f.artifact === 'README.md')!;
    expect(readme).toMatchObject({ id: 'f.README.headline_eff', value: 96.94, proseOnly: true, validationState: 'candidate', locator: 'md:line=2' });
    expect(readme.tags).toEqual(expect.arrayContaining(['candidate', 'prose-only']));
    expect(readme.definition).toBe('The tracker finds 96.94% of the isolated targets.');
    expect(readme.definition).not.toContain('model text');
    const extra = res.added.find((f) => f.artifact === 'docs/extra.json')!;
    expect(extra).toMatchObject({ value: 3.2, locator: '#/lumi_fb' });
    expect(extra.definition).toContain('label=extra run');
    const reasons = res.rejected.map((r) => r.reason).join('\n');
    expect(reasons).toMatch(/2 numbers/);
    expect(reasons).toMatch(/not found/);
    expect(reasons).toMatch(/escapes the repository/);
    expect(reasons).toMatch(/absolute paths/);
    expect(reasons).toMatch(/YAML/);
    expect(reasons).toMatch(/invalid candidate/);
    expect(res.rejected.length).toBe(6);
    // Candidates are re-read on rescan: a change marks them stale.
    writeFileSync(join(project.repoDir, 'docs', 'extra.json'), JSON.stringify({ label: 'extra run', lumi_fb: 3.3, nested: { k: 7 } }));
    const r = await facts.rescan();
    expect(r.stale).toContain(extra.id);
    expect(facts.get(extra.id)?.value).toBe(3.3);
    expect(facts.get(readme.id)?.value).toBe(96.94);
  });

  it('rejects everything when no repository is configured', async () => {
    const { ctx, facts } = setup();
    await ctx.saveConfig({ ...ctx.config, repoDir: null });
    const res = await facts.addCandidates([{ proposed_id: 'x', definition_paraphrase: '', artifact: CLAIM, locator: '#/eff_A', kind: 'number', condition: '' }]);
    expect(res.added).toEqual([]);
    expect(res.rejected[0]!.reason).toMatch(/no analysis repository/);
  });
});

describe('FactService id stability across configuration changes', () => {
  it('a repo-reader fact keeps its id when the scanner starts extracting its artifact', async () => {
    const { ctx, facts } = setup();
    await facts.rescan();
    writeFileSync(join(project.repoDir, 'docs', 'extra.json'), JSON.stringify({ label: 'extra run', lumi_fb: 3.2 }));
    const res = await facts.addCandidates([{ proposed_id: 'x', definition_paraphrase: '', artifact: 'docs/extra.json', locator: '#/lumi_fb', kind: 'number', condition: '' }]);
    const id = res.added[0]!.id;
    expect(id).toBe('f.extra.lumi_fb');
    facts.patch(id, { confirmed: true });
    await ctx.saveConfig({ ...ctx.config, factGlobs: [...ctx.config.factGlobs, 'docs/*.json'] });
    await facts.rescan();
    expect(facts.get(id)).toMatchObject({ value: 3.2, confirmed: true, stale: false });
    expect(facts.get(`${id}~2`)).toBeUndefined();
    expect(facts.all().filter((f) => f.artifact === 'docs/extra.json').map((f) => f.id)).toEqual([id]);
  });

  it('facts linked from sentences survive the caps', async () => {
    const units = [unit('u1', ['f.g1.fake_rate_diff_points'])];
    const { docs } = fakeDocs(units, { u1: 'x' });
    const ctx = makeTestCtx(project, { docs });
    const big = track(createFactService(ctx));
    await big.rescan();
    await big.flush();
    const small = track(createFactService(ctx, { maxFactsPerArtifact: 3 }));
    await small.rescan();
    expect(small.get('f.g1.fake_rate_diff_points')).toMatchObject({ stale: false, excluded: false });
    expect(small.get('f.g1.fake_rate_B')).toBeUndefined();
  });

  it('a patched fact whose artifact leaves factGlobs is verified at its locator, not marked missing', async () => {
    const { ctx, facts } = setup();
    await facts.rescan();
    facts.patch('f.g1.delta_points', { confirmed: true });
    await ctx.saveConfig({ ...ctx.config, factGlobs: ['results/**/*.csv'] });
    await facts.rescan();
    expect(facts.get('f.g1.delta_points')).toMatchObject({ value: 2.3191733639494783, stale: false, excluded: false, confirmed: true });
    expect(facts.get('f.g1.eff_A')).toBeUndefined();
    editClaim((o) => {
      o.delta_points = 2.4;
    });
    const r = await facts.rescan();
    expect(r.stale).toEqual(['f.g1.delta_points']);
    expect(facts.get('f.g1.delta_points')).toMatchObject({ value: 2.4, confirmed: false });
  });
});

describe('FactService.forPrompt', () => {
  it('puts plan facts first, never returns excluded facts, and honours the limit', async () => {
    const { facts } = setup();
    await facts.rescan();
    facts.patch('f.g1.eff_B', { excluded: true });
    const out = facts.forPrompt({ factIds: ['f.definitions.pT_gt_1GeV', 'f.g1.eff_B', 'f.g1.delta_points', 'f.nope'], limit: 5 });
    expect(out.map((f) => f.id).slice(0, 2)).toEqual(['f.definitions.pT_gt_1GeV', 'f.g1.delta_points']);
    expect(out.length).toBe(5);
    expect(out.some((f) => f.excluded)).toBe(false);
    // Without a query the rest is filled by priority: confirmed, claim facts, cuts...
    facts.patch('f.g1csv.generic_iso.P_G.acorn_hnl_lm.mean', { confirmed: true });
    const fill = facts.forPrompt({ limit: 3 });
    expect(fill[0]!.id).toBe('f.g1csv.generic_iso.P_G.acorn_hnl_lm.mean');
    expect(fill[1]!.tags).toContain('claim');
  });

  it('ranks by text for a query (BM25, or token overlap while core is a stub)', async () => {
    const { facts } = setup();
    await facts.rescan();
    const hits = facts.forPrompt({ query: 'fake rate of the baseline', limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((f) => f.id.startsWith('f.g1.fake_rate'))).toBe(true);
    const eff = facts.forPrompt({ query: 'efficiency difference delta points', limit: 3 });
    expect(eff.map((f) => f.id)).toContain('f.g1.delta_points');
  });

  it.skipIf(!bm25Ready)('uses core BM25 when it is available', async () => {
    const { facts } = setup();
    await facts.rescan();
    expect(facts.forPrompt({ query: 'pT GeV target particle', limit: 5 }).map((f) => f.id)).toContain('f.definitions.pT_gt_1GeV');
  });
});

describe.skipIf(!linkReady)('FactService.linkUnit / unresolved (core linkSentenceFacts)', () => {
  const S1 = 'On the isolated gun particles, the tracker finds 2.32~$\\pm$~0.28 points more than acorn (HNL) with the same track builder; see Fig.~\\ref{fig:eff}.';
  const S2 = 'The fake-track rate is 0.55\\% against 1.38\\% for the baseline.';
  const S3 = 'We find 3.1415 points of gain.';

  it('links "2.32~$\\pm$~0.28 points" to f.g1.delta_points and stores it on the unit once', async () => {
    const units = [unit('u1'), unit('u2'), unit('u3')];
    const { docs, updates } = fakeDocs(units, { u1: S1, u2: S2, u3: S3 });
    const { facts } = setup({ docs });
    await facts.rescan();
    const r = facts.linkUnit(units[0]!, S1, []);
    expect(r.factIds).toContain('f.g1.delta_points');
    expect(r.unmatched).toEqual([]);
    expect(updates).toEqual([{ id: 'u1', patch: { facts: r.factIds } }]);
    facts.linkUnit(units[0]!, S1, []);
    expect(updates.length).toBe(1); // unchanged -> no second update
    const r2 = facts.linkUnit(units[1]!, S2, ['f.g1.fake_rate_A', 'f.g1.fake_rate_B']);
    expect(r2.factIds).toEqual(expect.arrayContaining(['f.g1.fake_rate_A', 'f.g1.fake_rate_B']));
    const r3 = facts.linkUnit(units[2]!, S3, []);
    expect(r3.unmatched).toEqual(['3.1415']);
  });

  it('prefiltered linking gives exactly the result of core linking over all facts', async () => {
    const units = [unit('u1')];
    const { docs } = fakeDocs(units, {});
    const { facts } = setup({ docs });
    await facts.rescan();
    const all = facts.all().filter((f) => !f.excluded);
    const sentences = [
      S1,
      S2,
      S3,
      'The test set holds 8,710 targets and $p_T > 1$~GeV.',
      'It finds 96.94\\% of the targets, compared with 94.62\\% for the baseline.',
      'The difference is $-0.83$ points, i.e. $1.2\\times10^{-2}$ in rate, with 3 seeds and 0.97 efficiency.',
      'Nothing numeric here.',
    ];
    for (const s of sentences) {
      const core = linkSentenceFacts(s, all, []);
      const mine = facts.linkUnit(unit('probe'), s, []);
      expect(mine.factIds.slice().sort()).toEqual([...new Set(core.linked)].sort());
      expect(mine.unmatched).toEqual(core.unmatched.map((t) => t.raw));
      expect(mine.ambiguous.map((a) => [a.raw, a.candidates.slice().sort()])).toEqual(core.ambiguous.map((a) => [a.token.raw, a.candidates.slice().sort()]));
    }
  });

  it('lists unmatched and ambiguous numerals across the document', async () => {
    const units = [unit('u1'), unit('u3'), unit('u4')];
    const { docs } = fakeDocs(units, { u1: S1, u3: S3, u4: 'The test set holds 8,710 targets.' });
    const { facts } = setup({ docs });
    await facts.rescan();
    const un = facts.unresolved();
    expect(un).toContainEqual({ sentenceId: 'u3', raw: '3.1415', candidates: [], file: units[1]!.file, line: units[1]!.line, text: S3 });
    const amb = un.find((x) => x.sentenceId === 'u4');
    expect(amb?.candidates.length).toBeGreaterThan(1);
    expect(amb?.candidates).toContain('f.g1.n_targets');
    expect(un.some((x) => x.sentenceId === 'u1')).toBe(false);
    // A confirmed candidate breaks the tie.
    facts.patch('f.g1.n_targets', { confirmed: true });
    expect(facts.unresolved().some((x) => x.sentenceId === 'u4')).toBe(false);
  });
});

describe('FactService without core linking', () => {
  it('leaves units untouched and reports nothing when linking is unavailable', async () => {
    const units = [unit('u1', ['f.g1.delta_points'])];
    const { docs, updates } = fakeDocs(units, { u1: 'x 2.32 points' });
    const { facts } = setup({ docs });
    await facts.rescan();
    const r = facts.linkUnit(units[0]!, 'x 2.32 points');
    if (!linkReady) {
      expect(r.factIds).toEqual(['f.g1.delta_points']);
      expect(updates).toEqual([]);
    } else {
      expect(r.factIds).toContain('f.g1.delta_points');
    }
  });
});

describe('claims / figures / terminology stores and evidence', () => {
  it('round-trips the JSON stores with validation', async () => {
    const { ctx, facts } = setup();
    expect(facts.claims()).toEqual([]);
    const claim: Claim = { claimId: 'G1', text: 'The ttbar-trained tracker finds more isolated displaced targets', evidence: ['f.g1.delta_points'], citations: [], qualification: 'within this simulation', status: 'supported', sentenceIds: [], section: 'sec:results', move: 'result' };
    await facts.saveClaims([claim, { ...claim, text: 'updated' }]);
    expect(facts.claims()).toEqual([{ ...claim, text: 'updated' }]);
    await facts.saveFigures([{ figureId: 'fig:eff', label: 'fig:eff', path: 'figures/eff.pdf', sha256: null, producerScript: null, claimIds: ['G1'], captionSentenceIds: [], status: 'needs_run', job: 'efficiency vs d0' }]);
    await facts.saveTerminology([{ term: 'double majority', definition: 'matching rule', acronym: 'DM', firstUseSentenceId: null, variants: [], symbol: null }]);
    await expect(facts.saveClaims([{ claimId: 'x' } as never])).rejects.toThrow(/claims\[0\]/);
    const fresh = track(createFactService(ctx));
    expect(fresh.claims()[0]!.text).toBe('updated');
    expect(fresh.figures()[0]!.figureId).toBe('fig:eff');
    expect(fresh.terminology()[0]!.acronym).toBe('DM');
    // One bad row on disk does not hide the others.
    writeFileSync(ctx.paths.claims, JSON.stringify([claim, { broken: true }]));
    expect(track(createFactService(ctx)).claims()).toEqual([claim]);
  });

  it('raises validationState only through matching evidence records', async () => {
    const { ctx, facts } = setup();
    await facts.rescan();
    const sha = facts.get('f.g1.delta_points')!.artifactSha256;
    await facts.addEvidence({ ts: nowIso(), factIds: ['f.g1.delta_points'], command: 'python scripts/g1.py', artifact: CLAIM, sha256: 'other', note: null });
    expect(facts.get('f.g1.delta_points')!.validationState).toBe('candidate');
    await facts.addEvidence({ ts: nowIso(), factIds: ['f.g1.delta_points'], command: 'python scripts/g1.py', artifact: CLAIM, sha256: sha, note: null });
    expect(facts.get('f.g1.delta_points')!.validationState).toBe('reproduced');
    await facts.addEvidence({ ts: nowIso(), factIds: ['f.g1.eff_A'], command: 'notebook', artifact: 'checks/x.csv', sha256: 'x', note: 'Independent re-computation by a co-author' });
    expect(facts.get('f.g1.eff_A')!.validationState).toBe('independently_validated');
    expect(existsSync(ctx.paths.evidence)).toBe(true);
    expect(track(createFactService(ctx)).get('f.g1.delta_points')!.validationState).toBe('reproduced');
    await expect(facts.addEvidence({ ts: 'x' } as never)).rejects.toThrow(/invalid evidence/);
  });
});
