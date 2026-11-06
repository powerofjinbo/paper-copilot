/**
 * MockApiClient: the in-browser demo server. Protocol behaviour (snapshot -> change -> ack ->
 * debounced patch, stale base versions, annotated changes), the review flow (draft -> insert ->
 * accept / reject), the anti-anchoring guard, ghost text, the push guard, and schema validity of
 * every message it emits. Plus the pure demo-data builders.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeSet, Text } from '@codemirror/state';
import { extractNumerals, type ChangeAnnotation, type ServerMessage, type SentenceUnit } from '@paper-copilot/core';
import { MockApiClient } from '../src/api/mock';
import { buildClaimFacts, buildLitFromBib, sectionsFromSource, unifiedDiff, outlineWithSections } from '../src/api/mockData';
import { factWords, ghostCandidates, simulatedRewrite, verbFirst, baselineFirst } from '../src/api/mockAi';
import mainTex from '../../../fixtures/canto-demo/tex/main.tex?raw';
import claimJson from '../../../fixtures/canto-demo/repo/results/addendum_g_g1_v1_claim.json?raw';
import refsBib from '../../../fixtures/canto-demo/tex/refs.bib?raw';

type Msg<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

const TYPES: Array<ServerMessage['type']> = [
  'welcome', 'doc.snapshot', 'sentences.patch', 'doc.ack', 'doc.replace', 'lint.update', 'ghost.result', 'ghost.empty', 'ghost.error',
  'plan.updated', 'draft.proposed', 'replan.proposed', 'compile.status', 'job.progress', 'facts.updated', 'cost.update', 'notice',
];

function record(api: MockApiClient) {
  const msgs: ServerMessage[] = [];
  for (const t of TYPES) api.on(t, (m) => msgs.push(m as ServerMessage));
  return {
    msgs,
    all<T extends ServerMessage['type']>(type: T): Array<Msg<T>> {
      return msgs.filter((m): m is Msg<T> => m.type === type);
    },
    last<T extends ServerMessage['type']>(type: T): Msg<T> | undefined {
      const l = msgs.filter((m): m is Msg<T> => m.type === type);
      return l[l.length - 1];
    },
  };
}

function demo() {
  return new MockApiClient({ latencyMs: 2, restLatencyMs: 1, debounceMs: 300, ghostDelayMs: 20, jobStepMs: 30, log: () => {} });
}

/** Advance fake time, then resolve (or reject with) the promise; handlers attach at once (no unhandled rejections). */
async function settle<T>(p: Promise<T>, ms = 50): Promise<T> {
  const r = p.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  );
  await vi.advanceTimersByTimeAsync(ms);
  const x = await r;
  if (x.ok) return x.v;
  throw x.e;
}

/** Core numeral matching is implemented by another workflow; skip the retro-grounding assertion until it is. */
const numbersReady = (() => {
  try {
    extractNumerals('8,710 targets');
    return true;
  } catch {
    return false;
  }
})();

const textOf = (snapText: string, u: SentenceUnit) => snapText.slice(u.start, u.end);

async function opened(api: MockApiClient, rec: ReturnType<typeof record>) {
  await api.ready();
  api.send({ type: 'doc.open', file: 'main.tex' });
  await vi.advanceTimersByTimeAsync(10);
  const snap = rec.last('doc.snapshot');
  if (!snap) throw new Error('no snapshot');
  return snap;
}

function annotation(over: Partial<ChangeAnnotation>): ChangeAnnotation {
  return {
    origin: 'ai_draft',
    sentenceIds: [],
    state: 'proposed',
    model: 'simulated',
    promptHash: null,
    instruction: null,
    lang: null,
    intentNote: null,
    factIds: [],
    citeKeys: [],
    move: null,
    requestId: null,
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('MockApiClient document protocol', () => {
  it('welcome on ready; doc.open answers with a version-0 snapshot of the fixture', async () => {
    const api = demo();
    const rec = record(api);
    const snap = await opened(api, rec);
    expect(api.connected).toBe(true);
    expect(rec.last('welcome')?.fakeLlm).toBe(true);
    expect(snap.version).toBe(0);
    expect(snap.file).toBe('main.tex');
    expect(snap.text).toBe(mainTex);
    expect(snap.units.length).toBe(26);
    expect(snap.units.every((u) => u.state === 'human' && u.imported)).toBe(true);
    // Retro-grounding: the results sentence with 8,710 links the n_targets fact.
    const size = snap.units.find((u) => textOf(snap.text, u).startsWith('The test set holds'));
    if (numbersReady) expect(size?.facts).toContain(api.factIdFor('n_targets'));
    expect(api.invalidMessages).toEqual([]);
  });

  it('change -> ack (version+1) at once, sentences.patch after the 300 ms debounce', async () => {
    const api = demo();
    const rec = record(api);
    const snap = await opened(api, rec);
    const target = snap.units.find((u) => textOf(snap.text, u).startsWith('The test set holds'))!;
    const at = target.start + 'The test set'.length;
    const cs = ChangeSet.of([{ from: at, insert: ' finally' }], snap.text.length);
    api.send({ type: 'doc.change', file: 'main.tex', baseVersion: 0, changes: cs.toJSON(), annotation: null });
    await vi.advanceTimersByTimeAsync(10);
    expect(rec.last('doc.ack')).toEqual({ type: 'doc.ack', file: 'main.tex', version: 1 });
    expect(rec.all('sentences.patch')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(rec.all('sentences.patch')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(80);
    const patch = rec.last('sentences.patch')!;
    expect(patch.version).toBe(1);
    const up = patch.upserts.find((u) => u.id === target.id)!;
    expect(up).toBeDefined();
    expect(api.currentText.slice(up.start, up.end)).toBe('The test set finally holds 8,710 targets.');
    expect(up.state).toBe('human');
    expect(patch.removed).toEqual([]);
    expect(api.invalidMessages).toEqual([]);
  });

  it('coalesces rapid typing into one patch tagged with the last version', async () => {
    const api = demo();
    const rec = record(api);
    const snap = await opened(api, rec);
    let text = snap.text;
    const u = snap.units[0]!;
    for (let v = 0; v < 5; v++) {
      const cs = ChangeSet.of([{ from: u.start, insert: 'x' }], text.length);
      api.send({ type: 'doc.change', file: 'main.tex', baseVersion: v, changes: cs.toJSON(), annotation: null });
      text = cs.apply(Text.of(text.split('\n'))).toString();
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(rec.all('doc.ack').map((a) => a.version)).toEqual([1, 2, 3, 4, 5]);
    expect(rec.all('sentences.patch')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(rec.all('sentences.patch').map((p) => p.version)).toEqual([5]);
    expect(api.currentText).toBe(text);
  });

  it('a stale baseVersion is refused with a fresh snapshot (no ack, no version bump)', async () => {
    const api = demo();
    const rec = record(api);
    const snap = await opened(api, rec);
    const cs = ChangeSet.of([{ from: 0, insert: '% hi\n' }], snap.text.length);
    api.send({ type: 'doc.change', file: 'main.tex', baseVersion: 7, changes: cs.toJSON(), annotation: null });
    await vi.advanceTimersByTimeAsync(10);
    expect(rec.all('doc.ack')).toHaveLength(0);
    expect(rec.all('doc.snapshot')).toHaveLength(2);
    expect(rec.last('doc.snapshot')!.version).toBe(0);
    expect(api.currentVersion).toBe(0);
  });

  it('an annotated AI change is re-segmented immediately and carries the annotation state', async () => {
    const api = demo();
    const rec = record(api);
    const snap = await opened(api, rec);
    const anchor = snap.units.find((u) => textOf(snap.text, u).startsWith('This lead holds'))!;
    const sentence = 'The fake-track rate is 0.55\\% against 1.38\\% for the baseline.';
    const cs = ChangeSet.of([{ from: anchor.end, insert: `\n${sentence}` }], snap.text.length);
    api.send({ type: 'doc.change', file: 'main.tex', baseVersion: 0, changes: cs.toJSON(), annotation: annotation({ origin: 'ai_ghost', state: 'ai-drafted', model: 'simulated' }) });
    await vi.advanceTimersByTimeAsync(10);
    const patch = rec.last('sentences.patch')!;
    expect(patch.version).toBe(1);
    const created = patch.upserts.find((u) => api.currentText.slice(u.start, u.end) === sentence)!;
    expect(created).toBeDefined();
    expect(created.state).toBe('ai-drafted');
    expect(created.everAi).toBe(true);
  });
});

describe('MockApiClient review flow', () => {
  async function drafted() {
    const api = demo();
    const rec = record(api);
    const snap = await opened(api, rec);
    const { jobId } = await settle(api.draft({ sectionId: 'sec:results', paragraphIds: null, fromNotes: false, file: 'main.tex', afterSentenceId: null }));
    await vi.advanceTimersByTimeAsync(400);
    const d = rec.last('draft.proposed')!;
    expect(d.jobId).toBe(jobId);
    expect(rec.all('job.progress').filter((j) => j.jobId === jobId).at(-1)?.state).toBe('done');
    // What the editor does: insert one sentence per line after the anchor unit, as one annotated transaction.
    const anchor = snap.units.find((u) => u.id === d.afterSentenceId)!;
    const sentences = d.paragraphs[0]!.sentences;
    const insert = sentences.map((s) => `\n${s.text}`).join('');
    const cs = ChangeSet.of([{ from: anchor.end, insert }], snap.text.length);
    api.send({ type: 'doc.change', file: 'main.tex', baseVersion: d.version, changes: cs.toJSON(), annotation: annotation({}) });
    await vi.advanceTimersByTimeAsync(10);
    const patch = rec.last('sentences.patch')!;
    return { api, rec, d, patch, sentences };
  }

  it('draft.proposed holds two proposed sentences and one unsupported; units take those states', async () => {
    const { d, patch, sentences, api } = await drafted();
    expect(d.afterSentenceId).not.toBeNull();
    expect(sentences.map((s) => s.state)).toEqual(['proposed', 'proposed', 'unsupported']);
    const states = sentences.map((s) => patch.upserts.find((u) => api.currentText.slice(u.start, u.end) === s.text)?.state);
    expect(states).toEqual(['proposed', 'proposed', 'unsupported']);
    // No number outside the fact store survives in the unsupported sentence.
    expect(sentences[2]!.text).not.toMatch(/3\.1|300/);
    expect(api.invalidMessages).toEqual([]);
  });

  it('accept: proposed -> ai-drafted with a sentences.patch; accepting a human unit is refused', async () => {
    const { api, rec, patch } = await drafted();
    const proposed = patch.upserts.find((u) => u.state === 'proposed')!;
    const unit = await settle(api.accept(proposed.id));
    expect(unit.state).toBe('ai-drafted');
    expect(unit.acceptedAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(10);
    expect(rec.last('sentences.patch')!.upserts).toEqual([unit]);
    const human = api.currentUnits.find((u) => u.state === 'human')!;
    await expect(settle(api.accept(human.id))).rejects.toMatchObject({ status: 409 });
  });

  it('reject returns a [claim: ...?] placeholder of the sentence', async () => {
    const { api, patch } = await drafted();
    const proposed = patch.upserts.find((u) => u.state === 'proposed')!;
    const { replacement } = await settle(api.reject(proposed.id));
    expect(replacement.startsWith('[claim: ')).toBe(true);
    expect(replacement.endsWith('?]')).toBe(true);
    expect(replacement).toContain('targets');
  });

  it('push check lists the unreviewed sentences and refuses the push', async () => {
    const { api } = await drafted();
    const check = await settle(api.pushCheck());
    expect(check.ok).toBe(false);
    expect(check.blockers.map((b) => b.kind)).toEqual(expect.arrayContaining(['proposed', 'unsupported']));
    expect(check.diff).toContain('+++ b/main.tex');
    const res = await settle(api.push('Results draft'), 100);
    expect(res.ok).toBe(false);
  });
});

describe('MockApiClient AI guards', () => {
  it('framings are refused until the author wrote the five items', async () => {
    const api = demo();
    const rec = record(api);
    await opened(api, rec);
    await expect(settle(api.framings())).rejects.toMatchObject({ status: 409 });
    const o = await settle(api.outline());
    expect(o.authorFilled).toBe(false);
    expect(o.sections.map((s) => s.id)).toEqual(['abstract', 'sec:intro', 'sec:method', 'sec:results', 'sec:concl', 'app:val']);
    expect(o.sections.every((s) => s.paragraphs.length === 0 && s.question === '')).toBe(true);
    o.story.text = 'We show that a tracker trained without the signal finds more displaced particles.';
    o.authorFilled = true;
    await settle(api.saveOutline(o));
    const { jobId } = await settle(api.framings());
    await vi.advanceTimersByTimeAsync(400);
    const plan = rec.last('plan.updated')!;
    expect(plan.outline.framings).toHaveLength(3);
    expect(plan.outline.framings.every((f) => f.provenance === 'ai-proposed' && !f.adopted)).toBe(true);
    expect(rec.all('job.progress').filter((j) => j.jobId === jobId).at(-1)?.state).toBe('done');
  });

  it('ghost continues the typed prefix (only the continuation is sent) with a real fact number', async () => {
    const api = demo();
    const rec = record(api);
    const snap = await opened(api, rec);
    const cursor = snap.text.indexOf('This lead holds');
    api.send({ type: 'ghost.request', requestId: 'g1', file: 'main.tex', version: 0, cursor, trigger: 'manual', prefix: 'The new tracker' });
    await vi.advanceTimersByTimeAsync(60);
    const g = rec.last('ghost.result')!;
    expect(g.requestId).toBe('g1');
    expect(g.text.startsWith(' ')).toBe(true);
    expect(g.text).toMatch(/96\.94|94\.62|2\.32/);
    expect(g.model).toBe('simulated');
  });

  it('instruct returns a word diff and a simulated note in the notes language', async () => {
    const api = demo();
    const rec = record(api);
    const snap = await opened(api, rec);
    const u = snap.units.find((x) => textOf(snap.text, x).startsWith('On the isolated gun particles'))!;
    const p = await settle(api.instruct(u.id, '动词提前', 'zh'), 600);
    expect(p.text.startsWith('The tracker finds')).toBe(true);
    expect(p.notes).toContain('（模拟）');
    expect(p.origin).toBe('ai_rewrite');
    const before = p.diff.filter(([op]) => op <= 0).map(([, s]) => s).join('');
    const after = p.diff.filter(([op]) => op >= 0).map(([, s]) => s).join('');
    expect(before).toBe(textOf(snap.text, u));
    expect(after).toBe(p.text);
  });
});

describe('demo data builders', () => {
  it('builds one fact per numeric leaf with locators, units and uncertainties', () => {
    const facts = buildClaimFacts(claimJson, 'results/x.json', 'abc');
    const delta = facts.find((f) => f.id === 'f.g1.delta_points')!;
    expect(delta.locator).toBe('#/delta_points');
    expect(delta.unit).toBe('points');
    expect(delta.uncertainties.total).toBeCloseTo(0.2793, 4);
    expect(delta.validationState).toBe('candidate');
    expect(facts.find((f) => f.id === 'f.g1.eff_A_seeds.2')?.locator).toBe('#/eff_A_seeds/2');
    expect(facts.some((f) => f.id.endsWith('.outcome') || f.id.endsWith('fake_rate_guard_ok'))).toBe(false);
    expect(facts.find((f) => f.id === 'f.g1.eff_A')!.definition).toContain('Canto-L (ttbar)');
  });

  it('reads bib keys and the fixture sections', () => {
    const lit = buildLitFromBib(refsBib);
    expect(lit.map((l) => l.key)).toEqual(expect.arrayContaining(['Wang2022LRT']));
    expect(lit.find((l) => l.key === 'Wang2022LRT')!.title).toContain('Exa.TrkX');
    const heads = sectionsFromSource(mainTex);
    expect(heads.map((h) => h.id)).toEqual(['abstract', 'sec:intro', 'sec:method', 'sec:results', 'sec:concl', 'app:val']);
    const o = outlineWithSections(heads);
    expect(o.sections.find((s) => s.id === 'sec:intro')!.ghostMode).toBe('complete-my-sentence');
    expect(o.sections.find((s) => s.id === 'sec:results')!.ghostMode).toBe('auto-propose');
  });

  it('writes a unified diff', () => {
    expect(unifiedDiff('a\nb\nc\n', 'a\nb\nc\n', 'm.tex')).toBe('');
    const d = unifiedDiff('a\nb\nc\nd\n', 'a\nB\nc\nd\n', 'm.tex');
    expect(d).toContain('--- a/m.tex');
    expect(d).toContain('-b\n+B');
  });

  it('simulated text uses fact renderings and keeps LaTeX tokens', () => {
    const w = factWords(buildClaimFacts(claimJson, 'r.json', 'x'));
    expect(w.effA).toBe('96.94\\%');
    expect(w.delta).toBe('2.32');
    expect(ghostCandidates('', w, false)[0]).toContain('2.32 points');
    const s = 'On the isolated gun particles, the tracker finds 2.32~$\\pm$~0.28 points more than acorn (HNL) with the same track builder; see Fig.~\\ref{fig:eff}.';
    expect(verbFirst(s).text).toBe('The tracker finds 2.32~$\\pm$~0.28 points more than acorn (HNL) with the same track builder on the isolated gun particles; see Fig.~\\ref{fig:eff}.');
    const b = baselineFirst('It finds 96.94\\% of the targets, compared with 94.62\\% for the baseline.');
    expect(b.text).toBe('Compared with 94.62\\% for the baseline, it finds 96.94\\% of the targets.');
    expect(simulatedRewrite('In order to compare, we utilize the same seeds.', '').text).toBe('To compare, we use the same seeds.');
  });
});
