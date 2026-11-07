/**
 * The demo server's batch-B surface: the reports validate against the core schemas, the large
 * multi-file fixture (files, cross-file doc.open, per-file counts, deterministic facts), literature
 * confirm, and restore (one annotated change; provenance kept; a stale `current` applies nothing).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EchoReport, FigurePlanReport, ProjectFilesResponse, RestoreResponse, SubmissionReport, TerminologyReport, type ServerMessage } from '@paper-copilot/core';
import { MockApiClient } from '../src/api/mock';
import { createLargeMock, csvFacts, jsonFacts, unitOfKey } from '../src/api/mockLarge';
import { restoreSpec } from '../src/editor/actions';
import { stateWith, unitsFor } from '../src/editor/testing/fixtures';

const opts = { latencyMs: 1, restLatencyMs: 1, debounceMs: 20, ghostDelayMs: 5, jobStepMs: 10, log: () => {} };
const made: MockApiClient[] = [];
function track<T extends MockApiClient>(m: T): T {
  made.push(m);
  return m;
}
afterEach(() => {
  for (const m of made.splice(0)) m.dispose();
});

function waitFor<T extends ServerMessage['type']>(api: MockApiClient, type: T, pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true, ms = 3000): Promise<Extract<ServerMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
    const off = api.on(type, (m) => {
      if (!pred(m as Extract<ServerMessage, { type: T }>)) return;
      clearTimeout(timer);
      off();
      resolve(m as Extract<ServerMessage, { type: T }>);
    });
  });
}

describe('mock reports (canto-demo)', () => {
  it('returns schema-valid consistency, terminology, figure-plan and submission reports', async () => {
    const api = track(new MockApiClient(opts));
    await api.ready();
    expect(EchoReport.safeParse(await api.consistency()).success).toBe(true);
    expect(TerminologyReport.safeParse(await api.terminologyReport()).success).toBe(true);
    const fig = await api.figurePlan();
    expect(FigurePlanReport.safeParse(fig).success).toBe(true);
    expect(fig.floats.length).toBeGreaterThan(0);
    const sub = await api.submissionCheck('aps');
    expect(SubmissionReport.safeParse(sub).success).toBe(true);
    // not compiled yet: a blocker until the (simulated) compile ran
    expect(sub.items.find((i) => i.id === 'compile_errors')?.ok).toBe(false);
    await api.compile();
    expect((await api.submissionCheck('aps')).items.find((i) => i.id === 'compile_errors')?.ok).toBe(true);
    expect(ProjectFilesResponse.safeParse(await api.files()).success).toBe(true);
  });

  it('confirms and un-confirms a bib key', async () => {
    const api = track(new MockApiClient(opts));
    await api.ready();
    const lit = (await api.panels()).lit;
    const key = lit[0]!.key;
    expect((await api.confirmLit(key, true)).status).toBe('user_confirmed');
    expect((await api.confirmLit(key, false)).status).not.toBe('user_confirmed');
    await expect(api.confirmLit('no-such-key', true)).rejects.toThrow(/No such bib key/);
  });

  it('restores an earlier version as one annotated change, keeping AI provenance', async () => {
    const api = track(new MockApiClient(opts));
    await api.ready();
    const snap = waitFor(api, 'doc.snapshot');
    api.send({ type: 'doc.open', file: 'main.tex' });
    const s = await snap;
    const u = s.units.find((x) => x.kind === 'prose' && x.part === 'body')!;
    const original = s.text.slice(u.start, u.end);
    // an AI rewrite of the sentence (annotated change, like the editor's applyProposal)
    const rewritten = `${original.replace(/\.$/, '')} (rewritten).`;
    const { ChangeSet } = await import('@codemirror/state');
    const cs = ChangeSet.of([{ from: u.start, to: u.end, insert: rewritten }], s.text.length);
    const patched = waitFor(api, 'sentences.patch');
    api.send({
      type: 'doc.change',
      file: 'main.tex',
      baseVersion: s.version,
      changes: cs.toJSON(),
      annotation: { origin: 'ai_rewrite', sentenceIds: [u.id], state: 'ai-drafted', model: 'sim', promptHash: 'h', instruction: 'x', lang: null, intentNote: null, factIds: [], citeKeys: [], move: null, requestId: null },
    });
    await patched;
    const hist = await api.history(u.id);
    expect(hist.versions.length).toBeGreaterThanOrEqual(2);
    const first = hist.versions[0]!;
    const r = await api.restoreVersion(u.id, first.version);
    expect(RestoreResponse.safeParse(r).success).toBe(true);
    expect(r.noop).toBe(false);
    expect(r.text).toBe(original);
    expect(r.current).toBe(rewritten);
    expect(r.annotation.origin).toBe('human_edit');
    // the sentence was AI-touched: restoring the author's text never claims it is untouched
    expect(r.state).toBe('ai-edited');
    const ai = await api.restoreVersion(u.id, hist.versions[hist.versions.length - 1]!.version);
    expect(ai.noop).toBe(true);
    await expect(api.restoreVersion(u.id, 999)).rejects.toThrow(/no version/);
  });
});

describe('restoreSpec', () => {
  const doc = 'Hello Old sentence. Tail';
  const state = stateWith(doc, unitsFor(doc, [['Old sentence']]));
  const annotation = { origin: 'human_edit', sentenceIds: [], state: 'human', model: null, promptHash: null, instruction: 'restore v0', lang: null, intentNote: null, factIds: [], citeKeys: [], move: null, requestId: null } as const;
  it('replaces the unit when it still reads like `current`', () => {
    const spec = restoreSpec(state, { sentenceId: 'u1', current: 'Old sentence', text: 'New text', annotation: { ...annotation } });
    expect(spec).not.toBeNull();
    const next = state.update(spec!).state;
    expect(next.doc.toString()).toBe('Hello New text. Tail');
  });
  it('applies nothing when the author changed the sentence meanwhile', () => {
    expect(restoreSpec(state, { sentenceId: 'u1', current: 'Something else', text: 'New text', annotation: { ...annotation } })).toBeNull();
    expect(restoreSpec(state, { sentenceId: 'nope', current: 'Old sentence', text: 'x', annotation: { ...annotation } })).toBeNull();
  });
});

describe('large multi-file fixture', () => {
  it('reads deterministic facts from JSON and CSV results', () => {
    const j = jsonFacts('{"a_mm": 1.5, "nested": {"eff": [0.9, 0.8]}}', 'results/x.json', 'sha');
    expect(j.map((f) => [f.id, f.value, f.unit])).toEqual([
      ['f.x.a_mm', 1.5, 'mm'],
      ['f.x.nested.eff.0', 0.9, ''],
      ['f.x.nested.eff.1', 0.8, ''],
    ]);
    const c = csvFacts('species,n,eff_A,eff_A_sigma\nmuon,10,0.97,0.01\n', 'results/s.csv', 'sha');
    expect(c.map((f) => [f.id, f.value, f.uncertainties])).toEqual([
      ['f.s.muon.n', 10, {}],
      ['f.s.muon.eff_A', 0.97, { total: 0.01 }],
    ]);
    expect(unitOfKey('mass_gev')).toBe('GeV');
    expect(jsonFacts('not json', 'results/y.json', 'sha')).toEqual([]);
  });

  it('serves every \\input file with per-file counts, and opens any of them', async () => {
    const api = track(createLargeMock(opts));
    await api.ready();
    const files = await api.files();
    expect(files.map((f) => f.file)).toEqual(['main.tex', 'sections/intro.tex', 'sections/method.tex', 'sections/results.tex', 'sections/appendix.tex']);
    expect(files[0]!.main).toBe(true);
    expect(files.find((f) => f.file === 'sections/appendix.tex')!.appendix).toBe(true);
    expect(files.reduce((n, f) => n + f.units, 0)).toBeGreaterThan(400);
    const info = await api.project();
    expect(info.files).toHaveLength(5);
    expect(info.config.mainFile).toBe('main.tex');
    const snap = waitFor(api, 'doc.snapshot', (m) => m.file === 'sections/results.tex');
    api.send({ type: 'doc.open', file: 'sections/results.tex' });
    const s = await snap;
    expect(s.units.length).toBeGreaterThan(50);
    expect(s.units.every((u) => u.file === 'sections/results.tex')).toBe(true);
    // reports span all files
    const echo = await api.consistency();
    const filesSeen = new Set(echo.quantities.flatMap((q) => q.occurrences.map((o) => o.file)));
    expect(filesSeen.size).toBeGreaterThan(1);
    const fig = await api.figurePlan();
    expect(fig.floats.length).toBe(16);
    expect((await api.facts()).facts.length).toBeGreaterThan(50);
    expect(api.invalidMessages).toEqual([]);
  });
});
