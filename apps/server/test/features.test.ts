/**
 * Batch B server features through the REAL services (createCtx, simulated AI) on both fixtures:
 * the report routes (consistency, terminology, figure plan, submission check, derived relations), the
 * project file tree, restoring a sentence version, and derived relations in the gate and in linkUnit.
 */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { ChangeSet } from '@codemirror/state';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ClientMessage,
  DerivedRelationSchema,
  EchoReport,
  FEATURE_ROUTES,
  FigurePlanReport,
  ProjectFilesResponse,
  REPORT_ROUTES,
  RestoreResponse,
  SubmissionReport,
  TerminologyReport,
  gateSentence,
  route,
  type ChangeAnnotation,
  type SentenceUnit,
} from '@paper-copilot/core';
import { createCtx, type AppCtx } from '../src/ctx';
import { initProject } from '../src/project/init';
import { registerReportsRoutes } from '../src/routes/reports';
import { registerRestoreRoutes, restorePlan } from '../src/routes/restore';
import { ROUTE_MODULES } from '../src/server';
import { createLlmService } from '../src/services/llm/llmService';
import { createFakeLlmClient } from '../src/services/llm/fake';
import { DraftCollector } from '../src/services/agents/collector';
import { REPO_ROOT, SKILL_DIR } from './helpers/ctx';

const PERF_SLACK = process.env.CI ? 3 : 1;

interface Fixture {
  name: 'canto-demo' | 'large-multifile';
  files: string[];
  /** A file whose sentences the restore tests edit. */
  editFile: string;
  floats: number;
  /** Two facts whose relative difference the derived-number tests state, and that difference in percent. */
  pair: [string, string];
  relative: string;
}

const FIXTURES: Fixture[] = [
  { name: 'canto-demo', files: ['main.tex'], editFile: 'main.tex', floats: 2, pair: ['f.g1.eff_A', 'f.g1.eff_B'], relative: '2.45' },
  {
    name: 'large-multifile',
    files: ['main.tex', 'sections/intro.tex', 'sections/method.tex', 'sections/results.tex', 'sections/appendix.tex'],
    editFile: 'sections/results.tex',
    floats: 16,
    pair: ['f.headline.eff_A', 'f.headline.eff_B'],
    relative: '2.67',
  },
];

function ann(p: Partial<ChangeAnnotation>): ChangeAnnotation {
  return { origin: 'ai_rewrite', sentenceIds: [], state: null, model: 'claude-sonnet-5-5', promptHash: 'ph-test', instruction: null, lang: null, intentNote: null, factIds: [], citeKeys: [], move: null, requestId: null, ...p };
}

describe.each(FIXTURES)('features on $name', (fx) => {
  let root: string;
  let ctx: AppCtx;
  let app: FastifyInstance;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'paper-features-'));
    cpSync(join(REPO_ROOT, 'fixtures', fx.name, 'tex'), join(root, 'tex'), { recursive: true });
    cpSync(join(REPO_ROOT, 'fixtures', fx.name, 'repo'), join(root, 'repo'), { recursive: true });
    await initProject(root, { repo: join(root, 'repo'), skill: SKILL_DIR });
    ctx = await createCtx({ root, fake: true, logLevel: 'error', watch: false, lintSidecar: false, docs: { segmentDebounceMs: 20, writeDebounceMs: 50 } });
    await ctx.start();
    await ctx.facts.rescan();
    app = Fastify();
    registerReportsRoutes(app, ctx);
    registerRestoreRoutes(app, ctx);
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await ctx?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const get = async (url: string) => {
    const res = await app.inject({ method: 'GET', url });
    return { status: res.statusCode, body: res.json() as unknown };
  };

  /** Apply a change as the client would (one transaction), then let the server segment it. */
  async function edit(file: string, specs: Array<{ from: number; to?: number; insert?: string }>, annotation: ChangeAnnotation | null = null, baseVersion?: number): Promise<void> {
    const st = ctx.docs.get(file)!;
    const cs = ChangeSet.of(specs, st.text.length);
    const msg = ClientMessage.parse(JSON.parse(JSON.stringify({ type: 'doc.change', file, baseVersion: baseVersion ?? st.version, changes: cs.toJSON(), annotation })));
    const ok = await ctx.docs.applyClientChange(msg as Extract<ClientMessage, { type: 'doc.change' }>);
    expect(ok).toBe(true);
    await ctx.docs.flush(file);
  }
  const unitText = (id: string) => ctx.docs.unitText(id);
  const unit = (id: string) => ctx.docs.unit(id) as SentenceUnit;

  async function restore(id: string, version: number) {
    const res = await app.inject({ method: 'POST', url: route(FEATURE_ROUTES.sentenceRestore, { id }), payload: { version } });
    expect(res.statusCode, res.body).toBe(200);
    return RestoreResponse.parse(res.json());
  }
  async function applyRestore(r: RestoreResponse): Promise<void> {
    await edit(r.file, [{ from: r.start, to: r.end, insert: r.text }], r.annotation, r.docVersion);
  }

  it('is registered with the server', () => {
    const names = ROUTE_MODULES.map(([n]) => n);
    expect(names).toEqual(expect.arrayContaining(['reports', 'restore']));
  });

  it('GET /api/files lists the \\input tree in document order with counts, without opening files', async () => {
    const { status, body } = await get(FEATURE_ROUTES.files);
    expect(status).toBe(200);
    const files = ProjectFilesResponse.parse(body);
    expect(files.map((f) => f.file)).toEqual(fx.files);
    expect(files[0]).toMatchObject({ file: 'main.tex', main: true, parent: null, depth: 0, included: true });
    for (const f of files.slice(1)) expect(f).toMatchObject({ main: false, parent: 'main.tex', depth: 1, included: true });
    if (fx.name === 'large-multifile') expect(files.find((f) => f.file === 'sections/appendix.tex')?.appendix).toBe(true);
    for (const f of files) {
      expect(f.units).toBeGreaterThan(0);
      expect(f).toMatchObject({ proposed: 0, unsupported: 0, aiTouched: 0 });
    }
    // nothing was opened (and so nothing imported) just to count
    expect(ctx.docs.openFiles()).toEqual([]);
  });

  it('GET /api/consistency covers every file of the tree (and its alias answers the same)', async () => {
    const t0 = performance.now();
    const { status, body } = await get(FEATURE_ROUTES.consistency);
    const ms = performance.now() - t0;
    expect(status).toBe(200);
    const echo = EchoReport.parse(body);
    expect(echo.quantities.length).toBeGreaterThan(5);
    const files = new Set(echo.quantities.flatMap((q) => q.occurrences.map((o) => o.file)));
    if (fx.name === 'large-multifile') {
      for (const f of ['sections/intro.tex', 'sections/results.tex']) expect(files).toContain(f);
      // the included files were opened (imported) for the report
      expect([...ctx.docs.openFiles()].sort()).toEqual([...fx.files].sort());
    } else expect([...files]).toEqual(['main.tex']);
    expect(echo.unmatched).toEqual([]);
    expect(ms).toBeLessThan(5000 * PERF_SLACK);
    const alias = await get(REPORT_ROUTES.consistency);
    expect(alias.body).toEqual(body);
  });

  it('GET /api/terminology-report and /api/figure-plan', async () => {
    const term = await get(FEATURE_ROUTES.terminologyReport);
    expect(term.status).toBe(200);
    const tr = TerminologyReport.parse(term.body);
    expect(Array.isArray(tr.acronyms)).toBe(true);
    expect(tr.acronyms.length).toBeGreaterThan(0);
    expect((await get(REPORT_ROUTES.terminology)).body).toEqual(term.body);

    const fig = await get(FEATURE_ROUTES.figurePlan);
    expect(fig.status).toBe(200);
    const plan = FigurePlanReport.parse(fig.body);
    expect(plan.floats).toHaveLength(fx.floats);
    // floats of every file, numbered in document order
    const figs = plan.floats.filter((f) => f.kind === 'figure');
    expect(figs.map((f) => f.number)).toEqual(figs.map((_f, i) => i + 1));
    if (fx.name === 'large-multifile') expect(new Set(plan.floats.map((f) => f.file)).size).toBeGreaterThan(1);
    expect((await get(REPORT_ROUTES.figurePlan)).body).toEqual(fig.body);
  });

  it('GET /api/submission-check: compile status, literature, venue', async () => {
    const t0 = performance.now();
    const { status, body } = await get(FEATURE_ROUTES.submissionCheck);
    expect(performance.now() - t0).toBeLessThan(8000 * PERF_SLACK);
    expect(status).toBe(200);
    const rep = SubmissionReport.parse(body);
    const item = (id: string) => rep.items.find((i) => i.id === id)!;
    // never compiled in this launch: a blocker with a note
    expect(item('compile_errors')).toMatchObject({ ok: false, severity: 'block' });
    expect(item('compile_errors').note).toMatch(/not compiled/i);
    expect(rep.ok).toBe(false);
    // offline: every cited key is unresolved (a warning, not a blocker)
    expect(item('unresolved_cites')).toMatchObject({ ok: false, severity: 'warn' });
    expect(item('undefined_cites').ok).toBe(true);
    // the imported paper is the author's: nothing unreviewed, no AI numbers
    expect(item('unreviewed').ok).toBe(true);
    expect(item('ai_unmatched_numbers').ok).toBe(true);
    expect(item('unmatched_numbers').ok).toBe(true);
    const els = await get(`${FEATURE_ROUTES.submissionCheck}?venue=elsevier`);
    expect(els.status).toBe(200);
    SubmissionReport.parse(els.body);
    expect((await get(`${FEATURE_ROUTES.submissionCheck}?venue=nature`)).status).toBe(400);
    // labels from core i18n, in the requested language
    const zh = (await get(`${FEATURE_ROUTES.submissionCheck}?lang=zh&token=ignored`)).body as { labels: Record<string, { label: string; explain: string }> };
    expect(zh.labels['submission.compile_errors']).toEqual({ label: '编译错误', explain: expect.stringContaining('编译') });
    expect(Object.keys(zh.labels)).toHaveLength(rep.items.length);
    const fig = (await get(`${FEATURE_ROUTES.figurePlan}?lang=en`)).body as { labels: Record<string, { label: string }> };
    expect(Object.keys(fig.labels).some((k) => k.startsWith('caption.'))).toBe(true);
    expect((await get(`${FEATURE_ROUTES.consistency}?lang=fr`)).status).toBe(400);
    expect(body).not.toHaveProperty('labels');
    expect((await get(REPORT_ROUTES.submission)).status).toBe(200);
  });

  it('GET /api/facts/derived: the relations the gate accepts', async () => {
    const { status, body } = await get(FEATURE_ROUTES.factsDerived);
    expect(status).toBe(200);
    const rels = DerivedRelationSchema.array().parse(body);
    expect(rels.length).toBeGreaterThan(10);
    expect(rels.length).toBe(ctx.facts.derived!().length);
    expect(rels.some((r) => r.kind === 'relative' && r.factIds.includes(fx.pair[0]) && r.factIds.includes(fx.pair[1]))).toBe(true);
  });

  it('linkUnit and every gate accept a derived number (relative difference of two facts)', async () => {
    const text = `The efficiency is ${fx.relative}\\% higher than that of the baseline.`;
    const facts = ctx.facts.all().filter((f) => !f.excluded);
    // without the derived relations the number has no source
    expect(gateSentence(text, { mode: 'draft', facts, allowedCiteKeys: [], knownLabels: [], fictionalNumbers: [] }).ok).toBe(false);
    expect(gateSentence(text, { mode: 'draft', facts, allowedCiteKeys: [], knownLabels: [], fictionalNumbers: [], derived: ctx.facts.derived!() }).ok).toBe(true);

    // linkUnit: linked to both facts, not listed as unmatched
    const anyUnit = ctx.docs.allUnits()[0]!;
    const link = ctx.facts.linkUnit({ ...anyUnit, id: 'probe-derived', facts: [] }, text);
    expect(link.unmatched).toEqual([]);
    expect(link.factIds).toEqual(expect.arrayContaining(fx.pair));

    // the rewrite gate of the LLM service (same gate context as the ghost and the intent rendering)
    const client = createFakeLlmClient({
      respond: (req) => (req.task === 'instruct' ? { json: { text: text.replace('\\%', ' percent'), notes: 'simulated', drift: { actor: false, scope: false, direction: false, condition: false }, fact_ids: [], cite_keys: [] } } : undefined),
    });
    const llm = createLlmService(ctx, { client });
    // a rewrite must keep the original's LaTeX, so the number is written with the word "percent" here
    const target = ctx.docs.allUnits().find((u) => u.kind === 'prose' && !/[\d\\$]/.test(unitText(u.id) ?? '1'))!;
    const p = await llm.instruct(target.id, 'state the relative gain', 'en');
    expect(p.issues.filter((i) => i.severity === 'block')).toEqual([]);
    expect(p.factIds).toEqual(expect.arrayContaining(fx.pair));
    await llm.close?.();

    // the draft hook (the collector the drafter's tool calls go through)
    const env = { facts, allowedCiteKeys: [], knownLabels: [], fictionalNumbers: [] };
    const proposal = { pid: 'p1', job: 'job', sentences: [{ text, move: null, fact_ids: [], cite_keys: [], placeholders: [], note_zh: null, referee_question: null }] };
    expect(new DraftCollector([{ pid: 'p1', job: 'job', intentNotes: [] }], () => ({ ...env, derived: ctx.facts.derived!() })).propose(proposal).status).toBe('accepted');
    expect(new DraftCollector([{ pid: 'p1', job: 'job', intentNotes: [] }], () => env).propose(proposal).status).toBe('retry');
  });

  describe('POST /api/sentences/:id/restore', () => {
    let id: string;
    let original: string;

    beforeAll(async () => {
      if (!ctx.docs.get(fx.editFile)) await ctx.docs.open(fx.editFile);
      const u = ctx.docs.get(fx.editFile)!.units.find((x) => x.kind === 'prose' && x.state === 'human' && (unitText(x.id) ?? '').split(' ').length > 8 && !/\$|\\cite/.test(unitText(x.id) ?? ''))!;
      id = u.id;
      original = unitText(id)!;
    });

    it('restores the author’s own version as a human edit', async () => {
      const u = unit(id);
      const k = original.indexOf(' ') + 1;
      await edit(fx.editFile, [{ from: u.start + k, insert: 'really ' }]);
      expect(unitText(id)).toBe(original.slice(0, k) + 'really ' + original.slice(k));
      expect(ctx.db.versions(id).map((v) => v.origin)).toEqual(['import', 'human_edit']);

      const r = await restore(id, 0);
      expect(r).toMatchObject({ sentenceId: id, file: fx.editFile, version: 0, origin: 'human_edit', state: 'human', noop: false, text: original, issues: [] });
      expect(r.current).toBe(unitText(id));
      expect(r.annotation).toMatchObject({ origin: 'human_edit', sentenceIds: [id], state: 'human', model: null });
      await applyRestore(r);
      expect(unitText(id)).toBe(original);
      expect(unit(id)).toMatchObject({ state: 'human', everAi: false });
      const vs = ctx.db.versions(id);
      expect(vs).toHaveLength(3);
      expect(vs[2]).toMatchObject({ origin: 'human_edit', text: original });
      // restoring what is already there is a no-op
      expect((await restore(id, 2)).noop).toBe(true);
    });

    it('restores AI text with its own origin, never launders everAi, and re-checks it with the gate', async () => {
      const factText = `The tracker finds ${fx.relative}\\% more targets than the baseline.`;
      // v3: an accepted AI rewrite
      let u = unit(id);
      await edit(fx.editFile, [{ from: u.start, to: u.end, insert: factText }], ann({ origin: 'ai_rewrite', sentenceIds: [id], state: 'ai-drafted', model: 'claude-sonnet-5-5', promptHash: 'ph-rw', instruction: 'shorter' }));
      expect(unit(id)).toMatchObject({ state: 'ai-drafted', everAi: true });
      const vAi = ctx.db.versions(id).at(-1)!;
      expect(vAi.origin).toBe('ai_rewrite');
      // v4: the author edits the AI text
      u = unit(id);
      await edit(fx.editFile, [{ from: u.start + 'The tracker'.length, insert: ' indeed' }]);
      expect(unit(id).state).toBe('ai-edited');
      const vEdited = ctx.db.versions(id).at(-1)!;
      expect(vEdited.origin).toBe('human_edit');

      // the AI version comes back as AI text with its model and instruction
      const rAi = await restore(id, vAi.version);
      expect(rAi).toMatchObject({ origin: 'ai_rewrite', state: 'ai-drafted', text: factText });
      expect(rAi.annotation).toMatchObject({ origin: 'ai_rewrite', model: 'claude-sonnet-5-5', promptHash: 'ph-rw', instruction: 'shorter' });
      expect(rAi.issues.filter((i) => i.severity === 'block')).toEqual([]);
      expect(rAi.annotation.factIds).toEqual(expect.arrayContaining(fx.pair));

      // the author's original text: human again, but everAi stays set
      const rOrig = await restore(id, 0);
      expect(rOrig).toMatchObject({ origin: 'human_edit', state: 'human' });
      await applyRestore(rOrig);
      expect(unitText(id)).toBe(original);
      expect(unit(id)).toMatchObject({ state: 'human', everAi: true });

      // the author's edit of AI text is still AI text the author edited
      const rEdited = await restore(id, vEdited.version);
      expect(rEdited).toMatchObject({ origin: 'human_edit', state: 'ai-edited' });
      await applyRestore(rEdited);
      expect(unit(id)).toMatchObject({ state: 'ai-edited', everAi: true });
    });

    it('marks restored AI text unsupported when its number no longer has a source', async () => {
      let u = unit(id);
      const bad = 'The tracker finds 77.7\\% more targets than the baseline.';
      await edit(fx.editFile, [{ from: u.start, to: u.end, insert: bad }], ann({ origin: 'ai_rewrite', sentenceIds: [id], state: 'ai-drafted' }));
      const vBad = ctx.db.versions(id).at(-1)!;
      u = unit(id);
      await edit(fx.editFile, [{ from: u.start, to: u.end, insert: original }]);
      const r = await restore(id, vBad.version);
      expect(r).toMatchObject({ origin: 'ai_rewrite', state: 'unsupported' });
      expect(r.annotation.state).toBe('unsupported');
      expect(r.issues.some((i) => i.code === 'unmatched_number' && i.severity === 'block')).toBe(true);
      await applyRestore(r);
      expect(unit(id)).toMatchObject({ state: 'unsupported', everAi: true });
    });

    it('a restored draft needs a review again', () => {
      const u = unit(id);
      const versions = [
        { sentenceId: id, version: 0, ts: 't0', text: 'Draft text.', origin: 'ai_draft' as const, model: 'claude-opus-5-5', promptHash: 'pd', instruction: null, lang: null, parentVersion: null, editDistance: null },
        { sentenceId: id, version: 1, ts: 't1', text: 'Draft text, fixed.', origin: 'grammar_fix' as const, model: 'claude-sonnet-5-5', promptHash: 'pg', instruction: null, lang: null, parentVersion: 0, editDistance: 0.1 },
        { sentenceId: id, version: 2, ts: 't2', text: 'My text.', origin: 'human_edit' as const, model: null, promptHash: null, instruction: null, lang: null, parentVersion: 1, editDistance: 0.5 },
      ];
      expect(restorePlan(u, versions[0]!, versions)).toMatchObject({ origin: 'ai_draft', state: 'proposed', aiText: true });
      // the grammar fix of an AI draft is still that draft
      expect(restorePlan(u, versions[1]!, versions)).toMatchObject({ origin: 'ai_draft', state: 'proposed', model: 'claude-sonnet-5-5' });
      expect(restorePlan(u, versions[2]!, versions)).toMatchObject({ origin: 'human_edit', state: 'ai-edited' });
    });

    it('rejects unknown sentences, unknown versions and bad bodies', async () => {
      const post = (sid: string, payload: unknown) => app.inject({ method: 'POST', url: route(FEATURE_ROUTES.sentenceRestore, { id: sid }), payload: payload as object });
      expect((await post('nope', { version: 0 })).statusCode).toBe(404);
      expect((await post(id, { version: 999 })).statusCode).toBe(404);
      expect((await post(id, { version: -1 })).statusCode).toBe(400);
      expect((await post(id, { version: 'one' })).statusCode).toBe(400);
    });
  });

  it('GET /api/files reflects AI sentences after edits', async () => {
    const files = ProjectFilesResponse.parse((await get(FEATURE_ROUTES.files)).body);
    const f = files.find((x) => x.file === fx.editFile)!;
    expect(f.open).toBe(true);
    expect(f.aiTouched).toBeGreaterThan(0);
    expect(f.unsupported).toBe(1);
    // the submission check sees the unsupported sentence in that file
    const rep = SubmissionReport.parse((await get(FEATURE_ROUTES.submissionCheck)).body);
    const unsup = rep.items.find((i) => i.id === 'unsupported')!;
    expect(unsup.ok).toBe(false);
    expect(unsup.items[0]?.file).toBe(fx.editFile);
  });
});
