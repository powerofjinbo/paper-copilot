/**
 * LlmService with the fake client and fake ctx services: ghost (happy path, regenerate on gate
 * failure, double failure, prefix stripping, cancellation, stale drop, plan by-product), sentence
 * actions (instruct with diff/notes/issues, LaTeX invariance, alternatives, grammar, intent rendering),
 * the re-planner (only downstream proposed units), systemFor byte stability, cost accounting and the
 * REST routes. Everything from @paper-copilot/core (prompt builders, gate, cost meter) is the real
 * implementation; only the LLM and the other services are fakes.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ROUTES,
  hashString,
  normalizeForHash,
  type Fact,
  type Outline,
  type PlanStep,
  type ServerMessage,
  type SentenceUnit,
  type SentenceVersion,
} from '@paper-copilot/core';
import { HttpError, type Ctx, type DocService, type DocState, type FactService, type LitService, type LlmRequest, type PaperDb, type VoiceService } from '../src/contracts';
import { registerLlmRoutes } from '../src/routes/llm';
import { createFakeLlmClient, createLlmService, type FakeOutput } from '../src/services/llm';
import { makeTempProject, makeTestCtx, type TempProject } from './helpers/ctx';

/* ------------------------------------------------------------------------------------ */
/* Fixtures: facts, documents, outline                                                   */
/* ------------------------------------------------------------------------------------ */

function fact(p: Partial<Fact> & Pick<Fact, 'id' | 'value'>): Fact {
  return {
    kind: 'number',
    sigfigs: null,
    unit: '',
    uncertainties: {},
    definition: '',
    definitionSource: 'test',
    artifact: 'results/addendum_g_g1_v1_claim.json',
    locator: `#/${p.id.split('.').pop()}`,
    artifactSha256: 'sha',
    fingerprint: 'fp',
    stale: false,
    validationState: 'candidate',
    aliases: [],
    confirmed: true,
    excluded: false,
    proseOnly: false,
    tags: [],
    ...p,
  };
}

const FACTS: Fact[] = [
  fact({ id: 'f.g1.delta_points', value: 2.3191733639494783, unit: 'points', uncertainties: { total: 0.27929769909842683 }, aliases: ['2.32~points'], definition: 'Efficiency difference, Canto-L minus acorn' }),
  fact({ id: 'f.g1.n_targets', value: 8710, tags: ['count'] }),
  fact({ id: 'f.excluded', value: 4.7, excluded: true }),
];

function unitAt(file: string, text: string, sub: string, id: string, over: Partial<SentenceUnit> = {}): SentenceUnit {
  const start = text.indexOf(sub);
  if (start < 0) throw new Error(`not in text: ${sub}`);
  return {
    id,
    file,
    start,
    end: start + sub.length,
    line: text.slice(0, start).split('\n').length,
    hash: hashString(normalizeForHash(sub)),
    ctxHash: '',
    textNorm: normalizeForHash(sub),
    sectionId: 'sec:results',
    paragraphId: 'sec:results/p0',
    part: 'body',
    kind: 'prose',
    move: null,
    state: 'human',
    everAi: false,
    grammarFixed: false,
    imported: false,
    model: null,
    promptHash: null,
    createdAt: '2026-11-06T00:00:00Z',
    acceptedAt: null,
    editDistance: null,
    intentNote: null,
    facts: [],
    cites: [],
    claims: [],
    placeholders: [],
    orphaned: false,
    splitFrom: null,
    ...over,
  };
}

const MAIN = 'main.tex';
const U1 = 'We compare the two trackers on the same events, as in Ref.~\\cite{Wang2022LRT}.';
const PREFIX = 'The efficiency gain is';
const MAIN_TEXT = `\\section{Results}\\label{sec:results}\n\n${U1}\n${PREFIX}`;

const DRAFT = 'draft.tex';
const D = [
  'We train the tracker on simulated events.',
  'The training uses the same seeds for both models.',
  'This choice removes one source of variance.',
  'The efficiency then rises by 2.32~points.',
  'We return to this point below.',
];
const DRAFT_TEXT = `\\section{Results}\n\n${D.join('\n')}\n`;

function makeDoc(file: string, text: string, units: SentenceUnit[], intentLines: DocState['intentLines'] = []): DocState {
  return { file, version: 1, text, units, seg: {} as DocState['seg'], intentLines };
}

interface FakeDocs extends DocService {
  docs: Map<string, DocState>;
}

function fakeDocs(initial: DocState[], versions: Map<string, SentenceVersion[]>): FakeDocs {
  const docs = new Map(initial.map((d) => [d.file, d]));
  const findUnit = (id: string) => {
    for (const d of docs.values()) {
      const u = d.units.find((x) => x.id === id);
      if (u) return { d, u };
    }
    return null;
  };
  const text = (id: string) => {
    const f = findUnit(id);
    return f ? f.d.text.slice(f.u.start, f.u.end) : null;
  };
  void versions;
  return {
    docs,
    files: async () => [...docs.keys()],
    open: async (file) => {
      const d = docs.get(file);
      if (!d) throw new HttpError(404, `no such file ${file}`);
      return d;
    },
    get: (file) => docs.get(file),
    applyClientChange: async () => true,
    flush: async () => {},
    reloadFromDisk: async () => ({ unchanged: 0, edited: [], created: [], orphaned: [], split: [] }),
    unit: (id) => findUnit(id)?.u,
    updateUnit: () => {
      throw new Error('not used');
    },
    allUnits: () => [...docs.values()].flatMap((d) => d.units),
    unitText: text,
    context: (id) => {
      const f = findUnit(id);
      if (!f) return null;
      const para = f.d.units.filter((u) => u.paragraphId === f.u.paragraphId).sort((a, b) => a.start - b.start);
      const i = para.findIndex((u) => u.id === id);
      const t = (u: SentenceUnit) => f.d.text.slice(u.start, u.end);
      return {
        before: i > 0 ? t(para[i - 1]!) : '',
        after: i < para.length - 1 ? t(para[i + 1]!) : '',
        paragraphBefore: para.slice(0, i).map(t).join(' '),
        paragraphAfter: para.slice(i + 1).map(t).join(' '),
        previousParagraphs: [],
        sectionId: f.u.sectionId,
        sectionTitle: 'Results',
        part: f.u.part,
      };
    },
    labels: () => ['sec:results', 'fig:eff'],
    onUnitsChanged: () => () => {},
    snapshotMessage: () => {
      throw new Error('not used');
    },
  };
}

function fakeFacts(): FactService {
  const usable = () => FACTS.filter((f) => !f.excluded);
  return {
    all: () => FACTS,
    get: (id: string) => FACTS.find((f) => f.id === id),
    forPrompt: ({ factIds, limit }: { factIds?: string[]; limit?: number }) => {
      const out: Fact[] = [];
      for (const id of factIds ?? []) {
        const f = usable().find((x) => x.id === id);
        if (f && !out.includes(f)) out.push(f);
      }
      for (const f of usable()) if (!out.includes(f)) out.push(f);
      return out.slice(0, limit ?? 50);
    },
    terminology: () => [],
  } as unknown as FactService;
}

function fakeLit(): LitService {
  return { allowedKeys: () => [{ key: 'Wang2022LRT', title: 'Tracking with GNNs' }], brief: () => 'LIT BRIEF' } as unknown as LitService;
}

function fakeVoice(): VoiceService {
  return { memo: () => 'MEMO', authorNormsTable: () => 'NORMS', exemplars: (_st: string, _q: string, k: number) => ['We measure the efficiency on the test sample.', 'The tracker finds more tracks.'].slice(0, k) } as unknown as VoiceService;
}

function fakeDb(versions: Map<string, SentenceVersion[]>): PaperDb & { kv: Map<string, string> } {
  const kv = new Map<string, string>();
  return {
    kv,
    kvGet: (k: string) => kv.get(k),
    kvSet: (k: string, v: string) => void kv.set(k, v),
    transaction: <T>(fn: () => T) => fn(),
    versions: (id: string) => versions.get(id) ?? [],
  } as unknown as PaperDb & { kv: Map<string, string> };
}

const STEP: PlanStep = { id: 'step-gain', intent: 'state the efficiency gain over the baseline', factIds: ['f.g1.delta_points'], citeKeys: [], move: 'result' };

function outline(over: { ghostMode?: 'complete-my-sentence' | 'auto-propose' | 'questions-only'; remaining?: PlanStep[] } = {}): Outline {
  return {
    story: { text: '', keyPhrase: '', provenance: 'author' },
    gap: { text: '', provenance: 'author' },
    enabler: { text: '', provenance: 'author' },
    contrast: { text: '', provenance: 'author' },
    ladder: [],
    claimFigures: [],
    headline: { factId: null, baselineFactId: null, condition: '', text: '', provenance: 'author' },
    framings: [],
    sections: [
      {
        id: 'sec:results',
        title: 'Results',
        question: 'How much better is the tracker?',
        template: 'results',
        ghostMode: over.ghostMode ?? 'auto-propose',
        paragraphs: [
          {
            pid: 'sec:results/p0',
            job: 'State the gain',
            moves: ['result'],
            claimIds: [],
            intentNotes: [],
            plan: { job: 'State the gain', claimIds: [], said: {}, remaining: over.remaining ?? [STEP, { id: 'step-next', intent: 'say why the gain matters', factIds: [], citeKeys: [], move: 'implication' }] },
            provenance: 'author',
          },
        ],
        provenance: 'author',
      },
    ],
    authorFilled: true,
  };
}

/* ------------------------------------------------------------------------------------ */
/* Harness                                                                               */
/* ------------------------------------------------------------------------------------ */

let project: TempProject;
let ctx: Ctx & { events: ServerMessage[] };
let docs: FakeDocs;
let db: ReturnType<typeof fakeDb>;
let versions: Map<string, SentenceVersion[]>;
let script: ((req: LlmRequest, attempt: number) => FakeOutput | undefined) | undefined;
let fake: ReturnType<typeof createFakeLlmClient>;
let latencyMs = 0;

function build(): ReturnType<typeof createLlmService> {
  fake = createFakeLlmClient({ latencyMs, respond: (r, a) => script?.(r, a) });
  const svc = createLlmService(ctx, { client: fake, skillCheckIntervalMs: 0 });
  (ctx as { llm: unknown }).llm = svc;
  return svc;
}

function ghostMsg(over: Partial<{ requestId: string; cursor: number; prefix: string; trigger: 'boundary' | 'pause' | 'manual'; version: number; file: string }> = {}) {
  return { type: 'ghost.request' as const, requestId: 'g1', file: MAIN, version: 1, cursor: MAIN_TEXT.length, trigger: 'pause' as const, prefix: PREFIX, ...over };
}

const ghostJson = (text: string, extra: Partial<{ fact_ids: string[]; cite_keys: string[]; fulfilled_move_ids: string[] }> = {}): FakeOutput => ({ json: { text, fact_ids: [], cite_keys: [], fulfilled_move_ids: [], ...extra } });

beforeEach(async () => {
  project = await makeTempProject();
  versions = new Map();
  const mainUnits = [unitAt(MAIN, MAIN_TEXT, U1, 'u1', { cites: ['Wang2022LRT'] })];
  const draftUnits = D.map((s, i) =>
    unitAt(DRAFT, DRAFT_TEXT, s, `d${i}`, {
      state: i === 0 ? 'ai-edited' : i === 2 ? 'ai-drafted' : 'proposed',
      facts: i === 3 ? ['f.g1.delta_points'] : [],
    }),
  );
  docs = fakeDocs([makeDoc(MAIN, MAIN_TEXT, mainUnits), makeDoc(DRAFT, DRAFT_TEXT, draftUnits)], versions);
  db = fakeDb(versions);
  ctx = makeTestCtx(project, { docs, facts: fakeFacts(), lit: fakeLit(), voice: fakeVoice(), db });
  await ctx.files.writeJson(ctx.paths.outline, outline());
  script = undefined;
  latencyMs = 0;
});

afterEach(() => project.cleanup());

async function ghost(svc: ReturnType<typeof createLlmService>, msg = ghostMsg()): Promise<ServerMessage[]> {
  const sent: ServerMessage[] = [];
  await svc.handleGhostRequest(msg, (m) => sent.push(m));
  return sent;
}

/* ------------------------------------------------------------------------------------ */
/* Ghost                                                                                 */
/* ------------------------------------------------------------------------------------ */

describe('ghost', () => {
  it('happy path: Haiku route settings, gated sentence, only the continuation is sent, facts and moves reported', async () => {
    script = () => ghostJson(`${PREFIX} 2.32~points over the baseline.`, { fact_ids: ['f.g1.delta_points'], fulfilled_move_ids: ['step-gain', 'bogus-step'] });
    const svc = build();
    const sent = await ghost(svc);
    expect(sent).toHaveLength(1);
    const r = sent[0]!;
    expect(r.type).toBe('ghost.result');
    if (r.type !== 'ghost.result') return;
    // text = the continuation only: the prefix is already in the document.
    expect(r.text).toBe(' 2.32~points over the baseline.');
    expect(r.requestId).toBe('g1');
    expect(r.version).toBe(1);
    expect(r.cursor).toBe(MAIN_TEXT.length);
    expect(r.factIds).toEqual(['f.g1.delta_points']);
    expect(r.fulfilledMoveIds).toEqual(['step-gain']);
    expect(r.issues.filter((i) => i.severity === 'block')).toEqual([]);
    expect(r.model).toBe('fake-claude-haiku-5-5');
    expect(r.promptHash).toMatch(/\S/);

    expect(fake.calls).toHaveLength(1);
    const req = fake.calls[0]!;
    expect(req).toMatchObject({ route: 'ghost', task: 'ghost', model: 'claude-haiku-5-5', maxTokens: 200, thinking: 'disabled', effort: 'low' });
    expect(req.schema).toBeTruthy();
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]!.role).toBe('user');
    expect(req.messages[0]!.content).toContain(PREFIX);
    // The cached blocks come from systemFor with the same inputs (byte-identical).
    expect(JSON.stringify(req.system)).toBe(JSON.stringify(svc.systemFor('ghost', { sectionType: 'results', template: 'results' })));

    // Cost: recorded, emitted, persisted.
    expect(svc.costTotals().requests).toBe(1);
    expect(ctx.events.some((e) => e.type === 'cost.update')).toBe(true);
    await new Promise((r2) => setTimeout(r2, 20));
    const log = ctx.files.readText(ctx.paths.costLog) ?? '';
    expect(log).toContain('"route":"ghost"');
    expect(log).toContain('fake-claude-haiku-5-5');
  });

  it('the default fake (no script) yields a grounded, gate-passing ghost from the plan step', async () => {
    const svc = build();
    const sent = await ghost(svc);
    expect(sent[0]?.type).toBe('ghost.result');
    if (sent[0]?.type !== 'ghost.result') return;
    expect(sent[0].text.startsWith(' ')).toBe(true);
    expect(sent[0].text).toContain('2.32~points');
    expect(sent[0].factIds).toContain('f.g1.delta_points');
  });

  it('gate failure -> regenerates once with the issues in the tail -> success', async () => {
    script = (_r, attempt) => (attempt === 0 ? ghostJson(`${PREFIX} 4.7 points over the baseline.`) : ghostJson(`${PREFIX} 2.32~points over the baseline.`, { fact_ids: ['f.g1.delta_points'] }));
    const svc = build();
    const sent = await ghost(svc);
    expect(fake.calls).toHaveLength(2);
    const retryTail = fake.calls[1]!.messages[0]!.content;
    expect(retryTail.startsWith(fake.calls[0]!.messages[0]!.content)).toBe(true);
    expect(retryTail).toContain('<previous_attempt_rejected>');
    expect(retryTail).toContain('unmatched_number');
    expect(retryTail).toContain('4.7 points');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'ghost.result', text: ' 2.32~points over the baseline.' });
    expect(svc.costTotals().requests).toBe(2);
  });

  it('double failure -> ghost.empty with a reason; the ungrounded number is never shown', async () => {
    script = () => ghostJson(`${PREFIX} 4.7 points over the baseline.`);
    const svc = build();
    const sent = await ghost(svc);
    expect(fake.calls).toHaveLength(2);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('ghost.empty');
    if (sent[0]!.type === 'ghost.empty') expect(sent[0]!.reason).toMatch(/no grounded suggestion.*unmatched_number/i);
    expect(JSON.stringify(sent)).not.toContain('4.7');
  });

  it("a number from the skill's invented examples is blocked even when the model claims it", async () => {
    script = () => ghostJson(`${PREFIX} 1.2 points over the baseline.`, { fact_ids: ['f.g1.delta_points'] });
    const svc = build();
    expect(svc.skillLoader.fictionalNumbers()).toContain('1.2');
    const sent = await ghost(svc);
    expect(sent[0]!.type).toBe('ghost.empty');
    expect(fake.calls[1]!.messages[0]!.content).toMatch(/fictional_number|unmatched_number/);
  });

  it('prefix rule: whitespace differences are tolerated, a changed prefix is rejected and regenerated', async () => {
    script = (_r, a) => (a === 0 ? ghostJson('The efficiency  GAIN is large.') : ghostJson('The  efficiency gain is   large for every sample.'));
    const svc = build();
    const sent = await ghost(svc);
    expect(fake.calls[1]!.messages[0]!.content).toContain('prefix_mismatch');
    expect(sent[0]).toMatchObject({ type: 'ghost.result', text: ' large for every sample.' });

    // A prefix ending in a space: the continuation starts without one.
    script = () => ghostJson('The efficiency gain is large.');
    const sent2 = await ghost(svc, ghostMsg({ requestId: 'g2', prefix: `${PREFIX} ` }));
    expect(sent2[0]).toMatchObject({ type: 'ghost.result', text: 'large.' });
  });

  it("issues inside the author's own prefix are not the AI's: an author-typed number does not block the ghost", async () => {
    const text = `${MAIN_TEXT.slice(0, MAIN_TEXT.length - PREFIX.length)}We saw 4.7 events`;
    docs.docs.set(MAIN, makeDoc(MAIN, text, docs.docs.get(MAIN)!.units));
    script = () => ghostJson('We saw 4.7 events in the control region.');
    const svc = build();
    const sent = await ghost(svc, ghostMsg({ prefix: 'We saw 4.7 events', cursor: text.length }));
    expect(sent[0]).toMatchObject({ type: 'ghost.result', text: ' in the control region.' });
  });

  it('cancellation by requestId aborts the call and sends nothing', async () => {
    latencyMs = 100;
    const svc = build();
    const sent: ServerMessage[] = [];
    const p = svc.handleGhostRequest(ghostMsg(), (m) => sent.push(m));
    await new Promise((r) => setTimeout(r, 10));
    svc.cancelGhost('g1');
    await p;
    expect(sent).toEqual([]);
    expect(fake.calls[0]!.signal?.aborted).toBe(true);

    // A cancel that arrives before its request drops the request.
    svc.cancelGhost('g-early');
    const sent2 = await ghost(svc, ghostMsg({ requestId: 'g-early' }));
    expect(sent2).toEqual([]);
    expect(fake.calls).toHaveLength(1);
  });

  it('stale requests are dropped: superseded by a newer request, or the text around the cursor changed', async () => {
    latencyMs = 60;
    const svc = build();
    const a: ServerMessage[] = [];
    const b: ServerMessage[] = [];
    const pa = svc.handleGhostRequest(ghostMsg({ requestId: 'old' }), (m) => a.push(m));
    await new Promise((r) => setTimeout(r, 10));
    const pb = svc.handleGhostRequest(ghostMsg({ requestId: 'new' }), (m) => b.push(m));
    await Promise.all([pa, pb]);
    expect(a).toEqual([]);
    expect(b[0]?.type).toBe('ghost.result');

    latencyMs = 0;
    const svc2 = build();
    script = () => {
      // The author deleted the sentence while the request was in flight.
      docs.docs.set(MAIN, { ...docs.docs.get(MAIN)!, version: 2, text: MAIN_TEXT.slice(0, MAIN_TEXT.length - PREFIX.length) + 'Something else entirely' });
      return ghostJson(`${PREFIX} large.`);
    };
    const sent = await ghost(svc2, ghostMsg({ requestId: 'stale' }));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('ghost.empty');
    if (sent[0]!.type === 'ghost.empty') expect(sent[0]!.reason).toMatch(/^stale/);
  });

  it('section modes: questions-only never calls the model; complete-my-sentence waits for three words unless manual', async () => {
    await ctx.files.writeJson(ctx.paths.outline, outline({ ghostMode: 'questions-only' }));
    const svc = build();
    let sent = await ghost(svc);
    expect(sent[0]).toMatchObject({ type: 'ghost.empty' });
    expect(fake.calls).toHaveLength(0);

    await ctx.files.writeJson(ctx.paths.outline, outline({ ghostMode: 'complete-my-sentence' }));
    const short = `${MAIN_TEXT.slice(0, MAIN_TEXT.length - PREFIX.length)}The gain`;
    docs.docs.set(MAIN, makeDoc(MAIN, short, docs.docs.get(MAIN)!.units));
    sent = await ghost(svc, ghostMsg({ prefix: 'The gain', cursor: short.length }));
    expect(sent[0]).toMatchObject({ type: 'ghost.empty' });
    expect(fake.calls).toHaveLength(0);
    script = () => ghostJson('The gain is 2.32~points.');
    sent = await ghost(svc, ghostMsg({ prefix: 'The gain', cursor: short.length, trigger: 'manual' }));
    expect(sent[0]).toMatchObject({ type: 'ghost.result', text: ' is 2.32~points.' });
  });

  it('an intent-note prefix is refused; a model error becomes ghost.error', async () => {
    const svc = build();
    let sent = await ghost(svc, ghostMsg({ prefix: '这里说明效率提高' }));
    expect(sent[0]).toMatchObject({ type: 'ghost.empty' });
    script = () => {
      throw new Error('boom');
    };
    sent = await ghost(svc);
    expect(sent[0]).toMatchObject({ type: 'ghost.error', requestId: 'g1' });
  });

  it('feedback: counters in kv, a line in the cost log; an accepted ghost marks its plan steps said (plan.updated)', async () => {
    script = () => ghostJson(`${PREFIX} 2.32~points over the baseline.`, { fact_ids: ['f.g1.delta_points'], fulfilled_move_ids: ['step-gain'] });
    const svc = build();
    await ghost(svc);
    svc.ghostFeedback({ type: 'ghost.feedback', requestId: 'g1', outcome: 'accepted', acceptedText: ' 2.32~points over the baseline.' });
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'plan.updated')).toBe(true));
    const o = ctx.files.readJson(ctx.paths.outline, (await import('@paper-copilot/core')).Outline, outline());
    const plan = o.sections[0]!.paragraphs[0]!.plan;
    expect(plan.remaining.map((s) => s.id)).toEqual(['step-next']);
    expect(Object.keys(plan.said)).toEqual(['step-gain']);
    expect(db.kv.get('llm.ghost.outcome.accepted')).toBe('1');
    svc.ghostFeedback({ type: 'ghost.feedback', requestId: 'zzz', outcome: 'dismissed', acceptedText: null });
    expect(db.kv.get('llm.ghost.outcome.dismissed')).toBe('1');
    expect(db.kv.get('llm.ghost.outcome.total')).toBe('2');
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.files.readText(ctx.paths.costLog)).toContain('"kind":"ghost.feedback"');
  });

  it('a dismissed ghost does not advance the plan', async () => {
    script = () => ghostJson(`${PREFIX} 2.32~points over the baseline.`, { fulfilled_move_ids: ['step-gain'] });
    const svc = build();
    await ghost(svc);
    svc.ghostFeedback({ type: 'ghost.feedback', requestId: 'g1', outcome: 'dismissed', acceptedText: null });
    await new Promise((r) => setTimeout(r, 30));
    expect(ctx.events.some((e) => e.type === 'plan.updated')).toBe(false);
  });
});

/* ------------------------------------------------------------------------------------ */
/* Actions                                                                               */
/* ------------------------------------------------------------------------------------ */

describe('sentence actions', () => {
  it('instruct: Sonnet route settings; proposal with word diff, notes, drift, no issues when LaTeX is intact', async () => {
    script = () => ({
      json: {
        text: 'We compare both trackers on the same events, as in Ref.~\\cite{Wang2022LRT}.',
        notes: '把 “the two” 改为 “both”，更简洁。',
        drift: { actor: false, scope: false, direction: false, condition: false },
        fact_ids: [],
        cite_keys: ['Wang2022LRT'],
      },
    });
    const svc = build();
    const p = await svc.instruct('u1', '更简洁', 'zh');
    const req = fake.calls[0]!;
    expect(req).toMatchObject({ route: 'actions', task: 'instruct', model: 'claude-sonnet-5-5', thinking: 'between_tools', effort: 'low' });
    expect(p.sentenceId).toBe('u1');
    expect(p.origin).toBe('ai_rewrite');
    expect(p.model).toBe('fake-claude-sonnet-5-5');
    expect(p.text).toBe('We compare both trackers on the same events, as in Ref.~\\cite{Wang2022LRT}.');
    expect(p.notes).toContain('更简洁');
    expect(p.drift).toEqual({ actor: false, scope: false, direction: false, condition: false });
    expect(p.issues.filter((i) => i.severity === 'block')).toEqual([]);
    expect(p.citeKeys).toEqual(['Wang2022LRT']);
    expect(p.diff.some(([op, t]) => op === -1 && t.includes('the two'))).toBe(true);
    expect(p.diff.some(([op, t]) => op === 1 && t.includes('both'))).toBe(true);
    expect(p.diff.filter(([op]) => op !== 1).map(([, t]) => t).join('')).toBe(U1);
    expect(p.promptHash).toMatch(/\S/);
  });

  it('instruct: a rewrite that drops the \\cite is surfaced as a latex_changed issue (block)', async () => {
    script = () => ({ json: { text: 'We compare the two trackers on the same events.', notes: 'n', drift: { actor: false, scope: true, direction: false, condition: false }, fact_ids: [], cite_keys: [] } });
    const svc = build();
    const p = await svc.instruct('u1', 'shorter', 'en');
    expect(p.issues.some((i) => i.code === 'latex_changed' && i.severity === 'block')).toBe(true);
    expect(p.drift?.scope).toBe(true);
  });

  it('instruct: an invented number is replaced by a visible placeholder in the offered text', async () => {
    script = () => ({ json: { text: 'We compare the two trackers on 9999 events, as in Ref.~\\cite{Wang2022LRT}.', notes: 'n', drift: { actor: false, scope: false, direction: false, condition: false }, fact_ids: [], cite_keys: [] } });
    const svc = build();
    const p = await svc.instruct('u1', 'add the event count', 'en');
    expect(p.issues.some((i) => i.code === 'unmatched_number')).toBe(true);
    expect(p.text).not.toContain('9999');
    expect(p.text).toContain('[fact?');
  });

  it('instruct: unknown sentence -> 404; empty instruction -> 400; invalid model output -> 502', async () => {
    const svc = build();
    await expect(svc.instruct('nope', 'x', null)).rejects.toMatchObject({ status: 404 });
    await expect(svc.instruct('u1', '  ', null)).rejects.toMatchObject({ status: 400 });
    script = () => ({ text: 'not json' });
    await expect(svc.instruct('u1', 'x', null)).rejects.toMatchObject({ status: 502 });
  });

  it('alternatives: n proposals, deduplicated, each gated; origin ai_rewrite', async () => {
    script = () => ({
      json: {
        alternatives: [
          { text: 'We compare both trackers on the same events, as in Ref.~\\cite{Wang2022LRT}.', note: 'a' },
          { text: 'We compare both trackers on the same events, as in Ref.~\\cite{Wang2022LRT}.', note: 'dup' },
          { text: 'Both trackers run on the same events, as in Ref.~\\cite{Wang2022LRT}.', note: 'b' },
          { text: 'Both trackers run on identical events, as in Ref.~\\cite{Unknown2020}.', note: 'c' },
        ],
      },
    });
    const svc = build();
    const ps = await svc.alternatives('u1', 3);
    expect(ps).toHaveLength(3);
    expect(new Set(ps.map((p) => p.proposalId)).size).toBe(3);
    expect(ps.every((p) => p.origin === 'ai_rewrite' && p.drift === null)).toBe(true);
    expect(ps[2]!.issues.some((i) => i.code === 'unknown_cite' || i.code === 'latex_changed')).toBe(true);
  });

  it('grammar: minimal fix proposal with origin grammar_fix and the changes as notes', async () => {
    script = () => ({ json: { text: 'We compare the two trackers on the same events, as in Ref.~\\cite{Wang2022LRT}.', changes: ['无修改'] } });
    const svc = build();
    const p = await svc.grammar('u1');
    expect(fake.calls[0]).toMatchObject({ task: 'grammar', route: 'actions', thinking: 'between_tools' });
    expect(p.origin).toBe('grammar_fix');
    expect(p.notes).toBe('无修改');
    expect(p.diff.every(([op]) => op === 0)).toBe(true);
    expect(p.issues.filter((i) => i.severity === 'block')).toEqual([]);
  });

  it('intent rendering: proposals from a Chinese note, origin ai_intent; a number typed in the note passes as unlinked', async () => {
    const withIntent = makeDoc(MAIN, `${MAIN_TEXT}\n效率提高 2.32 个点，另有 3.5 个误判\n`, docs.docs.get(MAIN)!.units, [{ start: MAIN_TEXT.length + 1, end: MAIN_TEXT.length + 18, line: 5, text: '效率提高 2.32 个点，另有 3.5 个误判' }]);
    docs.docs.set(MAIN, withIntent);
    script = () => ({
      json: {
        proposals: [
          { text: 'The efficiency rises by 2.32~points, with 3.5 extra fakes.', fact_ids: ['f.g1.delta_points'], cite_keys: [], note: '第一种' },
          { text: 'The tracker gains 2.32~points.', fact_ids: ['f.g1.delta_points'], cite_keys: [], note: '第二种' },
        ],
      },
    });
    const svc = build();
    const ps = await svc.renderIntent({ file: MAIN, line: 5, text: '效率提高 2.32 个点，另有 3.5 个误判', n: 2 });
    expect(fake.calls[0]).toMatchObject({ task: 'intent', route: 'actions', model: 'claude-sonnet-5-5' });
    expect(ps).toHaveLength(2);
    expect(ps.every((p) => p.origin === 'ai_intent' && p.sentenceId === null)).toBe(true);
    expect(ps[0]!.factIds).toContain('f.g1.delta_points');
    expect(ps[0]!.issues.some((i) => i.code === 'unlinked_number' && i.severity === 'warn')).toBe(true);
    expect(ps[0]!.issues.some((i) => i.severity === 'block')).toBe(false);
    expect(ps[1]!.notes).toBe('第二种');
    await expect(svc.renderIntent({ file: MAIN, line: 5, text: ' ', n: 1 })).rejects.toMatchObject({ status: 400 });
    await expect(svc.renderIntent({ file: 'missing.tex', line: 1, text: '说明', n: 1 })).rejects.toMatchObject({ status: 404 });
  });
});

/* ------------------------------------------------------------------------------------ */
/* Re-plan                                                                               */
/* ------------------------------------------------------------------------------------ */

describe('replanAfterEdit', () => {
  it('only downstream proposed units of the same paragraph may change; revisions are gated; the plan is updated', async () => {
    await ctx.files.writeJson(ctx.paths.outline, outline({ remaining: [STEP, { id: 'step-next', intent: 'say why the gain matters', factIds: [], citeKeys: [], move: 'implication' }] }));
    versions.set('d0', [
      { sentenceId: 'd0', version: 0, ts: 't', text: 'We train the model on simulated events.', origin: 'ai_draft', model: 'm', promptHash: null, instruction: null, lang: null, parentVersion: null, editDistance: null },
      { sentenceId: 'd0', version: 1, ts: 't', text: D[0]!, origin: 'human_edit', model: null, promptHash: null, instruction: null, lang: null, parentVersion: 0, editDistance: 0.1 },
    ]);
    script = (req) => {
      expect(req.task).toBe('replan');
      return {
        json: {
          items: [
            { sentence_id: 'd0', action: 'revise', text: 'Edited upstream.', reason: 'must be ignored' },
            { sentence_id: 'd1', action: 'revise', text: 'The training uses one seed set for both trackers.', reason: 'match the new subject' },
            { sentence_id: 'd2', action: 'drop', text: null, reason: 'accepted: must be ignored' },
            { sentence_id: 'd3', action: 'revise', text: 'The efficiency then rises by 7.7 points.', reason: 'ungrounded' },
            { sentence_id: 'd4', action: 'drop', text: null, reason: 'repeats the previous sentence' },
            { sentence_id: 'zz', action: 'drop', text: null, reason: 'unknown id' },
          ],
          remaining: [{ intent: 'say why the gain matters', fact_ids: ['f.unknown'], move: 'implication' }],
          paragraph_complete: false,
          next_opener: null,
        },
      };
    };
    const svc = build();
    await svc.replanAfterEdit(DRAFT, 'd0');
    expect(fake.calls).toHaveLength(1);
    const ev = ctx.events.find((e) => e.type === 'replan.proposed');
    expect(ev).toBeTruthy();
    if (ev?.type !== 'replan.proposed') return;
    expect(ev.file).toBe(DRAFT);
    expect(ev.items.map((i) => i.sentenceId).sort()).toEqual(['d1', 'd3', 'd4']);
    expect(ev.items.find((i) => i.sentenceId === 'd1')).toMatchObject({ action: 'revise', text: 'The training uses one seed set for both trackers.' });
    // An ungrounded revision is withheld (kept), never shown.
    expect(ev.items.find((i) => i.sentenceId === 'd3')).toMatchObject({ action: 'keep', text: null });
    expect(ev.items.find((i) => i.sentenceId === 'd3')!.reason).toMatch(/faithfulness/);
    expect(ev.items.find((i) => i.sentenceId === 'd4')).toMatchObject({ action: 'drop' });
    // The tail told the model which sentences it may revise.
    const tail = fake.calls[0]!.messages[0]!.content;
    expect(tail).toContain('d1');
    expect(tail).toContain('d3');

    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'plan.updated')).toBe(true));
    const pu = ctx.events.find((e) => e.type === 'plan.updated');
    if (pu?.type !== 'plan.updated') return;
    const plan = pu.outline.sections[0]!.paragraphs[0]!.plan;
    expect(plan.remaining).toEqual([{ id: 'step-next', intent: 'say why the gain matters', factIds: [], citeKeys: [], move: 'implication' }]);
  });

  it('a failed re-plan (model error or invalid output) leaves everything unchanged and does not throw', async () => {
    script = () => ({ text: 'garbage' });
    const svc = build();
    await expect(svc.replanAfterEdit(DRAFT, 'd0')).resolves.toBeUndefined();
    expect(ctx.events.some((e) => e.type === 'replan.proposed' || e.type === 'plan.updated')).toBe(false);
  });

  it('no downstream proposed unit -> no model call', async () => {
    const svc = build();
    await svc.replanAfterEdit(DRAFT, 'd4');
    await svc.replanAfterEdit(DRAFT, 'missing');
    expect(fake.calls).toHaveLength(0);
    expect(ctx.events.some((e) => e.type === 'replan.proposed')).toBe(false);
  });

  it('a step whose fact a sentence so far states is marked said when it leaves the plan', async () => {
    script = () => ({ json: { items: [{ sentence_id: 'd4', action: 'keep', text: null, reason: 'fine' }], remaining: [], paragraph_complete: true, next_opener: 'The next paragraph compares fake rates.' } });
    const svc = build();
    await svc.replanAfterEdit(DRAFT, 'd3');
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'plan.updated')).toBe(true));
    const pu = ctx.events.find((e) => e.type === 'plan.updated');
    if (pu?.type !== 'plan.updated') return;
    const plan = pu.outline.sections[0]!.paragraphs[0]!.plan;
    expect(plan.remaining).toEqual([]);
    expect(plan.said['step-gain']).toBe('d3');
  });
});

/* ------------------------------------------------------------------------------------ */
/* systemFor, pre-warm, cost, routes                                                     */
/* ------------------------------------------------------------------------------------ */

describe('systemFor, pre-warm and cost', () => {
  it('systemFor is byte-stable across calls with the same state and changes when the state changes', async () => {
    const svc = build();
    const a = svc.systemFor('ghost', { sectionType: 'results', template: 'results' });
    const b = svc.systemFor('ghost', { sectionType: 'results', template: 'results' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.length).toBeGreaterThanOrEqual(2);
    expect(a[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(a[1]!.cache_control?.type).toBe('ephemeral');
    expect(a[1]!.cache_control?.ttl ?? '5m').toBe('5m');
    const all = JSON.stringify(a);
    for (const needle of ['f.g1.delta_points', 'Wang2022LRT', 'MEMO', 'NORMS', 'LIT BRIEF', 'sentences-and-words.md']) expect(all).toContain(needle);
    expect(all).not.toContain('f.excluded');
    const svc2 = build();
    expect(JSON.stringify(svc2.systemFor('ghost', { sectionType: 'results', template: 'results' }))).toBe(JSON.stringify(a));
    await ctx.files.writeText(ctx.paths.repoBrief, '# Repo brief\nCanto tracks displaced particles.\n');
    const c = svc.systemFor('ghost', { sectionType: 'results', template: 'results' });
    expect(JSON.stringify(c)).not.toBe(JSON.stringify(a));
    expect(JSON.stringify(c)).toContain('Canto tracks displaced particles.');
  });

  it('pre-warm is skipped in fake mode', async () => {
    const svc = build();
    const spy = vi.spyOn(fake, 'prewarm');
    await svc.prewarm();
    expect(spy).not.toHaveBeenCalled();
    expect(svc.skill()?.version).toMatch(/^[0-9a-f]{64}$/);
  });

  it('pre-warm with a real-looking client sends blocks A+B of each route with the route settings, and records usage', async () => {
    const calls: LlmRequest[] = [];
    const client = { fake: false, complete: async () => Promise.reject(new Error('unused')), prewarm: async (r: LlmRequest) => (calls.push(r), { input_tokens: 3, output_tokens: 0, cache_creation_input_tokens: 9000 }) };
    const svc = createLlmService(ctx, { client, skillCheckIntervalMs: 0 });
    await svc.prewarm();
    expect(calls.map((c) => [c.route, c.model, c.thinking, c.effort])).toEqual([
      ['ghost', 'claude-haiku-5-5', 'disabled', 'low'],
      ['actions', 'claude-sonnet-5-5', 'between_tools', 'low'],
    ]);
    for (const c of calls) {
      expect(c.system.length).toBe(2);
      expect(JSON.stringify(c.system)).toBe(JSON.stringify(svc.systemFor(c.task, { sectionType: 'body', template: null }).slice(0, 2)));
    }
    expect(svc.costTotals().requests).toBe(2);
  });

  it('recordUsage (agents report here): totals, cost.update, cost.jsonl; totals survive a restart', async () => {
    const svc = build();
    svc.recordUsage('claude-opus-5-5', { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 5000 }, 'drafter');
    const t = svc.costTotals();
    expect(t.requests).toBe(1);
    expect(t.cacheReadTokens).toBe(5000);
    expect(Object.keys(t.byRoute)).toContain('drafter');
    expect(ctx.events.filter((e) => e.type === 'cost.update')).toHaveLength(1);
    await vi.waitFor(() => expect(ctx.files.readText(ctx.paths.costLog) ?? '').toContain('"route":"drafter"'));
    const again = build();
    expect(again.costTotals().requests).toBe(1);
    expect(again.costTotals().cacheReadTokens).toBe(5000);
  });
});

describe('routes', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function mk(): Promise<FastifyInstance> {
    build();
    const a = Fastify();
    a.setErrorHandler((err, _req, reply) => {
      if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
      return reply.status(500).send({ error: String(err) });
    });
    registerLlmRoutes(a, ctx);
    await a.ready();
    return a;
  }

  it('instruct / alternatives / grammar / intent render / cost', async () => {
    app = await mk();
    let r = await app.inject({ method: 'POST', url: ROUTES.sentenceInstruct.replace(':id', 'u1'), payload: { instruction: 'verb first', lang: 'en' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ sentenceId: 'u1', origin: 'ai_rewrite' });
    r = await app.inject({ method: 'POST', url: ROUTES.sentenceInstruct.replace(':id', 'u1'), payload: { instruction: 5 } });
    expect(r.statusCode).toBe(400);
    r = await app.inject({ method: 'POST', url: ROUTES.sentenceInstruct.replace(':id', 'nope'), payload: { instruction: 'x', lang: null } });
    expect(r.statusCode).toBe(404);
    r = await app.inject({ method: 'POST', url: ROUTES.sentenceAlternatives.replace(':id', 'u1'), payload: { n: 2 } });
    expect(r.statusCode).toBe(200);
    expect(r.json().proposals).toHaveLength(2);
    r = await app.inject({ method: 'POST', url: ROUTES.sentenceAlternatives.replace(':id', 'u1'), payload: { n: 50 } });
    expect(r.statusCode).toBe(400);
    r = await app.inject({ method: 'POST', url: ROUTES.sentenceGrammar.replace(':id', 'u1'), payload: {} });
    expect(r.statusCode).toBe(200);
    expect(r.json().origin).toBe('grammar_fix');
    r = await app.inject({ method: 'POST', url: ROUTES.intentRender, payload: { file: MAIN, line: 3, text: '说明效率', n: 1 } });
    expect(r.statusCode).toBe(200);
    expect(r.json().proposals[0].origin).toBe('ai_intent');
    r = await app.inject({ method: 'POST', url: ROUTES.intentRender, payload: { file: MAIN, line: 3, text: '说明效率', n: 9 } });
    expect(r.statusCode).toBe(400);
    r = await app.inject({ method: 'GET', url: ROUTES.cost });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ requests: 4 });
  });
});
