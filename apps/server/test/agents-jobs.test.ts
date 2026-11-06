/**
 * Fake-mode end-to-end tests of every agent job: the SDK is never loaded (ctx.fakeLlm), the services the
 * agents call (facts, lit, docs, voice, db, llm) are in-file fakes, and outputs go through the real
 * post-processing, gate, storage and events.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractFictionalNumbers, gateSentence, Outline, emptyOutline } from '@paper-copilot/core';
import type { EditPair, Fact, FigureEntry, GateContext, GateIssue, GateResult, LitRecord, OutlineParagraph, RepoBriefOutput, SentenceUnit, ServerMessage, TermEntry } from '@paper-copilot/core';
import type { Ctx, DocService, DocState, FactService, LitService, LlmService, PaperDb, VoiceService } from '../src/contracts';
import { HttpError } from '../src/contracts';
import { createAgentService, DRAFTER_SESSION_KEY, MEMO_CURSOR_KEY, insertionPoint, matchSentenceHint, capWords } from '../src/services/agents/service';
import { skillLinkPath } from '../src/services/agents/skill';
import { makeTempProject, makeTestCtx, SKILL_DIR, type TempProject } from './helpers/ctx';

/* ------------------------------------------------------------------------------------ */
/* Fakes                                                                                 */
/* ------------------------------------------------------------------------------------ */

function fact(id: string, value: number, aliases: string[], unit = '', extra: Partial<Fact> = {}): Fact {
  return {
    id,
    kind: 'number',
    value,
    sigfigs: null,
    unit,
    uncertainties: {},
    definition: `definition of ${id}`,
    definitionSource: 'metadata',
    artifact: 'results/addendum_g_g1_v1_claim.json',
    locator: `#/${id.split('.').pop()}`,
    artifactSha256: 'sha',
    fingerprint: 'fp',
    stale: false,
    validationState: 'candidate',
    aliases,
    confirmed: false,
    excluded: false,
    proseOnly: false,
    tags: [],
    ...extra,
  };
}

const FACTS: Fact[] = [
  fact('f.g1.delta_points', 2.3191733639494783, ['2.32 points', '2.3 points'], 'points', { uncertainties: { total: 0.27929769909842683 } }),
  fact('f.g1.n_targets', 8710, ['8,710']),
  fact('f.g1.eff_A', 0.9694221201683888, ['96.94%', '96.9%']),
  fact('f.g1.fake_rate_A', 0.0054838384739537, ['0.55%']),
  fact('f.g1.fake_rate_B', 0.0137682493250558, ['1.38%']),
  fact('f.g1.excluded', 0.123, ['0.123'], '', { excluded: true }),
];

function resolvePointer(obj: unknown, pointer: string): unknown {
  const parts = pointer.replace(/^#\/?/, '').split('/').filter((p) => p.length).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: unknown = obj;
  for (const p of parts) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[p] : undefined;
  return cur;
}

function makeFacts(repoDir: string) {
  let figures: FigureEntry[] = [];
  let terms: TermEntry[] = [{ term: 'Efficiency', definition: 'the author wrote this one', acronym: null, firstUseSentenceId: null, variants: [], symbol: null }];
  const candidates: RepoBriefOutput['fact_candidates'] = [];
  const svc = {
    all: () => FACTS,
    get: (id: string) => FACTS.find((f) => f.id === id),
    forPrompt: (o: { factIds?: string[]; limit?: number }) => {
      const usable = FACTS.filter((f) => !f.excluded);
      const first = usable.filter((f) => o.factIds?.includes(f.id));
      return [...first, ...usable.filter((f) => !first.includes(f))].slice(0, o.limit ?? 40);
    },
    async addCandidates(cs: RepoBriefOutput['fact_candidates']) {
      candidates.push(...cs);
      const added: Fact[] = [];
      const rejected: Array<{ candidate: unknown; reason: string }> = [];
      for (const c of cs) {
        const data = JSON.parse(readFileSync(join(repoDir, c.artifact), 'utf8'));
        const v = resolvePointer(data, c.locator);
        if (typeof v === 'number') added.push(fact(c.proposed_id, v, [String(v)]));
        else rejected.push({ candidate: c, reason: 'locator does not resolve to a number' });
      }
      return { added, rejected };
    },
    figures: () => figures,
    terminology: () => terms,
    saveFigures: async (f: FigureEntry[]) => {
      figures = f;
    },
    saveTerminology: async (t: TermEntry[]) => {
      terms = t;
    },
  };
  return { svc: svc as unknown as FactService, candidates, terms: () => terms, figures: () => figures };
}

function unit(id: string, sectionId: string, start: number, end: number, line: number): SentenceUnit {
  return {
    id, file: 'main.tex', start, end, line, hash: id, ctxHash: '', textNorm: '', sectionId, paragraphId: `${sectionId}/p0`, part: 'body', kind: 'prose', move: null,
    state: 'human', everAi: false, grammarFixed: false, imported: true, model: null, promptHash: null, createdAt: '2026-11-06T00:00:00Z', acceptedAt: null,
    editDistance: null, intentNote: null, facts: [], cites: [], claims: [], placeholders: [], orphaned: false, splitFrom: null,
  };
}

/** One unit per prose line of the fixture, section from the \label that follows each \section. */
function makeDocs(project: TempProject) {
  const text = readFileSync(join(project.paths.tex, 'main.tex'), 'utf8');
  const units: SentenceUnit[] = [];
  const sections: DocState['seg']['sections'] = [];
  let section = 'front';
  let inBody = false;
  let env = 0;
  let offset = 0;
  text.split('\n').forEach((line, i) => {
    const start = offset;
    offset += line.length + 1;
    const t = line.trim();
    const label = t.match(/^\\label\{((?:sec|app):[^}]+)\}/);
    if (/^\\section\{/.test(t)) sections.push({ id: '?', title: t.slice(9, -1), level: 1, start, line: i + 1, part: 'body', label: null });
    if (label) {
      section = label[1]!;
      const s = sections[sections.length - 1];
      if (s && s.id === '?') {
        s.id = section;
        s.label = section;
      }
    }
    if (/^\\begin\{document\}/.test(t)) inBody = true;
    if (/^\\begin\{(figure|table|abstract|equation)/.test(t)) env++;
    if (/^\\end\{(figure|table|abstract|equation)/.test(t)) env--;
    if (!inBody || env > 0 || !t || t.startsWith('\\') || t.startsWith('%') || t.startsWith('}')) return;
    const s0 = start + line.indexOf(t);
    units.push(unit(`u${i + 1}`, section, s0, s0 + t.length, i + 1));
  });
  const state: DocState = {
    file: 'main.tex',
    version: 7,
    text,
    units,
    seg: { sentences: [], sections, paragraphs: [], intentLines: [], labels: [], refs: [], cites: [], fragment: false },
    intentLines: [],
  };
  let opened = false;
  const svc = {
    get: (f: string) => (f === 'main.tex' && opened ? state : undefined),
    open: async (f: string) => {
      if (f !== 'main.tex') throw new Error(`no such file ${f}`);
      opened = true;
      return state;
    },
    allUnits: () => (opened ? units : []),
    unit: (id: string) => units.find((u) => u.id === id),
    unitText: (id: string) => {
      const u = units.find((x) => x.id === id);
      return u ? text.slice(u.start, u.end) : null;
    },
    labels: () => ['sec:intro', 'sec:method', 'sec:results', 'sec:concl', 'app:val', 'fig:eff', 'tab:eff', 'eq:eff'],
  };
  return { svc: svc as unknown as DocService, state, units };
}

function makeLit(): LitService {
  const records: LitRecord[] = [
    { key: 'Wang2022LRT', status: 'resolved', texkey: 'Wang:2022oer', recid: 1, arxiv: '2203.08800', doi: null, title: 'Reconstruction of Large Radius Tracks with the Exa.TrkX pipeline', authors: 'Wang et al.', year: 2023, abstract: null, quotable: [], usableFor: [], source: 'inspire' },
  ];
  return {
    records: () => records,
    allowedKeys: () => [{ key: 'Wang2022LRT', title: records[0]!.title }],
    bibKeys: () => ['Wang2022LRT', 'Ju2022Zenodo'],
  } as unknown as LitService;
}

function makeVoice(pairs: EditPair[]) {
  let memo = '- Prefers "we find" over "it is found".\n';
  const sets: string[] = [];
  const svc = {
    editPairs: () => pairs,
    memo: () => memo,
    setMemo: async (t: string) => {
      memo = t;
      sets.push(t);
    },
  };
  return { svc: svc as unknown as VoiceService, sets, memo: () => memo };
}

function makeDb() {
  const kv = new Map<string, string>();
  return { svc: { kvGet: (k: string) => kv.get(k), kvSet: (k: string, v: string) => void kv.set(k, v) } as unknown as PaperDb, kv };
}

function makeLlm() {
  const usage: Array<{ model: string; route: string }> = [];
  return { svc: { recordUsage: (model: string, _u: unknown, route: string) => void usage.push({ model, route }), systemFor: () => [{ type: 'text', text: 'sys' }] } as unknown as LlmService, usage };
}

function pair(i: number, over: Partial<EditPair> = {}): EditPair {
  return { sentenceId: `s${i}`, ts: `2026-11-06T00:00:${String(i).padStart(2, '0')}Z`, aiText: `ai ${i}`, humanText: `human ${i}`, instruction: i % 2 ? 'verb first' : null, sectionType: i % 3 ? 'results' : 'intro', grammarOnly: false, editDistance: 0.3, ...over };
}


/** Deterministic stand-in for core gateSentence (numbers must be fact aliases, cites must be allowed). */
function stubGate(text: string, c: GateContext): GateResult {
  const issues: GateIssue[] = [];
  let repaired = text;
  const factIds: string[] = [];
  const citeKeys: string[] = [];
  let scan = text.replace(/\\(?:ref|eqref|label)\{[^}]*\}/g, ' ');
  for (const m of text.matchAll(/\\cite\{([^}]*)\}/g)) {
    scan = scan.replace(m[0], ' ');
    const keys = m[1]!.split(',').map((k) => k.trim());
    citeKeys.push(...keys.filter((k) => c.allowedCiteKeys.includes(k)));
    if (keys.some((k) => !c.allowedCiteKeys.includes(k))) {
      issues.push({ code: 'unknown_cite', severity: 'block', message: 'unknown cite', raw: m[0] });
      repaired = repaired.replace(m[0], '[ref]');
    }
  }
  for (const f of c.facts) for (const a of f.aliases) if (scan.includes(a)) (factIds.push(f.id), (scan = scan.split(a).join(' ')));
  scan = scan.replace(/\[[^\]]*\?[^\]]*\]/g, ' ');
  for (const m of scan.matchAll(/\d+(?:[.,]\d+)*/g)) {
    if (c.intentText?.includes(m[0])) continue;
    issues.push({ code: 'unmatched_number', severity: 'block', message: `${m[0]} matches no fact`, raw: m[0] });
    repaired = repaired.replace(m[0], '[fact?: number]');
  }
  const placeholders = [...repaired.matchAll(/\[(?:fact\?|ref)[^\]]*\]/g)].map((m) => m[0]);
  return { ok: !issues.some((i) => i.severity === 'block'), issues, repaired, factIds, citeKeys, unlinked: [], placeholders };
}

let gateReady = true;
try {
  gateSentence('A sentence.', { mode: 'draft', facts: [], allowedCiteKeys: [], knownLabels: [], fictionalNumbers: [] });
} catch (e) {
  gateReady = !String(e).includes('not implemented');
}
let fictionalReady = true;
try {
  extractFictionalNumbers({});
} catch (e) {
  fictionalReady = !String(e).includes('not implemented');
}
const coreGateReady = gateReady && fictionalReady;

/* ------------------------------------------------------------------------------------ */
/* Setup                                                                                 */
/* ------------------------------------------------------------------------------------ */

interface World {
  project: TempProject;
  ctx: Ctx & { events: ServerMessage[] };
  facts: ReturnType<typeof makeFacts>;
  docs: ReturnType<typeof makeDocs>;
  voice: ReturnType<typeof makeVoice>;
  db: ReturnType<typeof makeDb>;
  llm: ReturnType<typeof makeLlm>;
  pairs: EditPair[];
}

let w: World;

beforeEach(async () => {
  const project = await makeTempProject();
  const facts = makeFacts(project.repoDir);
  const docs = makeDocs(project);
  const pairs: EditPair[] = [];
  const voice = makeVoice(pairs);
  const db = makeDb();
  const llm = makeLlm();
  const ctx = makeTestCtx(project, { facts: facts.svc, docs: docs.svc, lit: makeLit(), voice: voice.svc, db: db.svc, llm: llm.svc });
  ctx.agents = createAgentService(ctx);
  w = { project, ctx, facts, docs, voice, db, llm, pairs };
});

afterEach(() => w.project.cleanup());

async function settle(jobId: string): Promise<{ state: string; message: string; result: unknown }> {
  for (let i = 0; i < 1000; i++) {
    const j = w.ctx.jobs.get(jobId);
    if (j && (j.state === 'done' || j.state === 'error')) return { state: j.state, message: j.message, result: j.result };
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job did not finish');
}

async function done<T = Record<string, unknown>>(jobId: string): Promise<T> {
  const j = await settle(jobId);
  if (j.state !== 'done') throw new Error(`job failed: ${j.message}`);
  return j.result as T;
}

function httpStatus(fn: () => unknown): number | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof HttpError ? e.status : -1;
  }
}

function writeOutline(o: Outline) {
  return w.ctx.files.writeJson(w.project.paths.outline, o);
}

function para(pid: string, job: string, steps: Array<{ intent: string; factIds?: string[]; citeKeys?: string[]; move?: string }>, intentNotes: string[] = []): OutlineParagraph {
  return {
    pid,
    job,
    moves: ['result'],
    claimIds: [],
    intentNotes,
    provenance: 'author',
    plan: {
      job,
      claimIds: [],
      said: {},
      remaining: steps.map((s, i) => ({ id: `${pid}.s${i}`, intent: s.intent, factIds: s.factIds ?? [], citeKeys: s.citeKeys ?? [], move: s.move ?? 'result' })),
    },
  };
}

function filledOutline(): Outline {
  const o = emptyOutline();
  o.story = { text: 'We show that a tracker trained only on generic events finds more displaced particles than a signal-trained one.', keyPhrase: 'trained without the signal', provenance: 'author' };
  o.gap = { text: 'Graph-neural-network trackers have always been trained on the signal they are meant to find', provenance: 'author' };
  o.enabler = { text: 'Generic simulated events now cover displaced topologies', provenance: 'author' };
  o.contrast = { text: 'The standard approach assumes the training sample must contain the signal', provenance: 'author' };
  o.headline = { factId: 'f.g1.delta_points', baselineFactId: null, condition: 'within this simulation', text: 'The efficiency gain over the signal-trained baseline', provenance: 'author' };
  o.authorFilled = true;
  o.sections = [
    {
      id: 'sec:results',
      title: 'Results',
      question: 'How much better is the generic tracker?',
      template: 'results',
      ghostMode: 'auto-propose',
      provenance: 'author',
      paragraphs: [
        para('p1', 'State the headline efficiency gain over the baseline', [
          { intent: 'Report the efficiency difference against the signal-trained baseline', factIds: ['f.g1.delta_points'] },
          { intent: 'Give the size of the test set in targets', factIds: ['f.g1.n_targets'] },
          { intent: 'Credit the earlier large-radius tracking study', citeKeys: ['Wang2022LRT', 'NotInBib2020'], move: 'context' },
        ]),
        para('p2', 'Compare the fake-track rates of the two trackers', [{ intent: 'Compare the fake-track rate of the new tracker with the baseline rate', factIds: ['f.g1.fake_rate_A', 'f.g1.fake_rate_B'] }], ['假率要和基线一起给']),
      ],
    },
  ];
  return Outline.parse(o);
}

const proposed = () => w.ctx.events.filter((e): e is Extract<ServerMessage, { type: 'draft.proposed' }> => e.type === 'draft.proposed');

/* ------------------------------------------------------------------------------------ */
/* Tests                                                                                 */
/* ------------------------------------------------------------------------------------ */

describe('readRepo (fake mode)', () => {
  it('writes the brief, registers locator-only candidates, merges terms and links the skill', async () => {
    const r = await done<{ facts: { added: string[]; rejected: unknown[] }; terms: number; simulated: boolean }>(w.ctx.agents.readRepo());
    const brief = readFileSync(w.project.paths.repoBrief, 'utf8');
    expect(brief).toContain('（模拟）');
    expect(brief).toContain('Fixture analysis repository'); // README heading
    expect(brief).toContain('results/addendum_g_g1_v1_claim.json'); // file inventory
    // Candidates are JSON pointers into the real claim file; the facts service reads every value.
    expect(w.facts.candidates.length).toBeGreaterThan(10);
    expect(w.facts.candidates.every((c) => c.locator.startsWith('#/') && c.artifact === 'results/addendum_g_g1_v1_claim.json')).toBe(true);
    expect(w.facts.candidates.map((c) => c.locator)).toEqual(expect.arrayContaining(['#/delta_points', '#/eff_A', '#/n_targets', '#/eff_A_seeds/0']));
    expect(r.facts.rejected).toEqual([]);
    expect(r.facts.added.length).toBe(w.facts.candidates.length);
    // Terminology from docs/definitions.md; the author's own entry is kept, not overwritten.
    const terms = w.facts.terms();
    expect(terms.find((t) => t.term === 'Double majority')?.acronym).toBe('DM');
    expect(terms.filter((t) => t.term.toLowerCase() === 'efficiency')).toEqual([expect.objectContaining({ definition: 'the author wrote this one' })]);
    expect(r.simulated).toBe(true);
    // Skill discovery layout.
    const link = skillLinkPath(w.project.paths.claudeCwd);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(SKILL_DIR));
    // Progress went through the job registry.
    expect(w.ctx.events.some((e) => e.type === 'job.progress' && e.kind === 'read-repo' && /fact candidates/.test(e.message))).toBe(true);
  });

  it('refuses without an analysis repository and reuses a running job', async () => {
    await w.ctx.saveConfig({ ...w.ctx.config, repoDir: null });
    expect(httpStatus(() => w.ctx.agents.readRepo())).toBe(409);
    await w.ctx.saveConfig({ ...w.ctx.config, repoDir: w.project.repoDir });
    const a = w.ctx.agents.readRepo();
    expect(w.ctx.agents.readRepo()).toBe(a);
    await done(a);
  });
});

describe('framings (fake mode)', () => {
  it('runs only after the author filled the five items', async () => {
    expect(httpStatus(() => w.ctx.agents.framings())).toBe(409);
  });

  it('appends three ai-proposed framings built from the author\'s own items and emits plan.updated', async () => {
    await writeOutline(filledOutline());
    const r = await done<{ framings: Array<{ text: string; why: string }> }>(w.ctx.agents.framings());
    const o = w.ctx.files.readJson(w.project.paths.outline, Outline, emptyOutline());
    expect(o.framings).toHaveLength(3);
    for (const f of o.framings) {
      expect(f.provenance).toBe('ai-proposed');
      expect(f.adopted).toBe(false);
      expect(f.text.startsWith('（模拟）')).toBe(true);
      expect(f.text).not.toMatch(/\d/); // nothing invented: the author's text has no numbers
    }
    expect(o.framings[0]!.text).toContain('Graph-neural-network trackers have always been trained');
    expect(o.story.provenance).toBe('author');
    expect(r.framings[0]!.why).toContain('（模拟）');
    const ev = w.ctx.events.filter((e) => e.type === 'plan.updated');
    expect(ev).toHaveLength(1);
    // A second pass adds nothing identical.
    await done(w.ctx.agents.framings());
    expect(w.ctx.files.readJson(w.project.paths.outline, Outline, emptyOutline()).framings).toHaveLength(3);
  });
});

describe.each([
  { gateName: 'core gate', ready: coreGateReady, testing: undefined },
  { gateName: 'stub gate', ready: true, testing: { gate: stubGate, extractFictionalNumbers: () => [] } },
])('draft (fake mode, $gateName)', ({ ready, testing }) => {
  beforeEach(() => {
    w.ctx.agents = createAgentService(w.ctx, { testing });
  });
  const req = { sectionId: 'sec:results', paragraphIds: null as string[] | null, fromNotes: false, file: 'main.tex', afterSentenceId: null as string | null };

  it('validates the request before starting a job', async () => {
    await writeOutline(filledOutline());
    expect(httpStatus(() => w.ctx.agents.draft({ ...req, sectionId: 'sec:nope' }))).toBe(404);
    expect(httpStatus(() => w.ctx.agents.draft({ ...req, paragraphIds: ['p9'] }))).toBe(400);
    expect(httpStatus(() => w.ctx.agents.draft({ ...req, file: '../etc/passwd' }))).toBe(400);
    const o = filledOutline();
    o.sections[0]!.paragraphs = [];
    await writeOutline(o);
    expect(httpStatus(() => w.ctx.agents.draft(req))).toBe(409);
  });

  it.skipIf(!ready)('emits ONE draft.proposed with gated paragraphs built from plan intents and fact renderings', async () => {
    await writeOutline(filledOutline());
    const jobId = w.ctx.agents.draft(req);
    expect(httpStatus(() => w.ctx.agents.draft(req))).toBe(409); // one drafting job at a time
    const r = await done<{ paragraphs: number; unsupported: number; partial: boolean }>(jobId);
    expect(r).toMatchObject({ paragraphs: 2, unsupported: 0, partial: false });
    const ev = proposed();
    expect(ev).toHaveLength(1);
    const e = ev[0]!;
    expect(e.jobId).toBe(jobId);
    expect(e.file).toBe('main.tex');
    expect(e.version).toBe(7);
    expect(e.afterSentenceId).toBeNull();
    // Inserted after the last sentence of the Results section.
    const results = w.docs.units.filter((u) => u.sectionId === 'sec:results');
    expect(e.insertAt).toBe(Math.max(...results.map((u) => u.end)));
    expect(e.paragraphs.map((p) => p.pid)).toEqual(['p1', 'p2']);
    expect(e.paragraphs[0]!.job).toBe('State the headline efficiency gain over the baseline');
    const sentences = e.paragraphs.flatMap((p) => p.sentences);
    expect(sentences.every((s) => s.state === 'proposed')).toBe(true);
    const all = sentences.map((s) => s.text).join(' ');
    expect(all).toContain('2.32 points');
    expect(all).toContain('8,710');
    expect(all).toContain('0.55%');
    expect(all).toContain('\\cite{Wang2022LRT}');
    expect(all).not.toContain('NotInBib2020'); // only resolved keys are cited
    expect(sentences.flatMap((s) => s.factIds)).toEqual(expect.arrayContaining(['f.g1.delta_points', 'f.g1.n_targets']));
    expect(sentences.every((s) => s.noteZh?.startsWith('（模拟）'))).toBe(true);
    expect(e.paragraphs[1]!.sentences[0]!.noteZh).toBe('（模拟）依据段落计划：Compare the fake-track rates of the two trackers');
    // Fake mode never touches the drafter session or the cost meter.
    expect(w.db.kv.has(DRAFTER_SESSION_KEY)).toBe(false);
    expect(w.llm.usage).toEqual([]);
  });

  it.skipIf(!ready)('keeps a sentence that fails the gate twice as unsupported, with its issues and a placeholder', async () => {
    await writeOutline(filledOutline());
    const jobId = w.ctx.agents.draft({ ...req, paragraphIds: ['p1'], fakeHint: { unsupported: true } } as typeof req);
    const r = await done<{ unsupported: number }>(jobId);
    expect(r.unsupported).toBe(1);
    const s = proposed()[0]!.paragraphs[0]!.sentences.find((x) => x.state === 'unsupported')!;
    expect(s.issues.some((i) => i.code === 'unmatched_number' && i.severity === 'block')).toBe(true);
    expect(s.text).not.toMatch(/7\.77|8\.88|9\.99/); // the unmatched number never reaches the .tex
    expect(s.text).toContain('[fact?');
    // The gate verdicts went through the job's progress: first a retry, then acceptance.
    const msgs = w.ctx.events.filter((e) => e.type === 'job.progress' && e.jobId === jobId).map((e) => (e as { message: string }).message);
    expect(msgs.some((m) => /p1: retry/.test(m))).toBe(true);
    expect(msgs.some((m) => /p1: accepted/.test(m))).toBe(true);
  });

  it.skipIf(!ready)('accepts a sentence the model fixes on the retry', async () => {
    await writeOutline(filledOutline());
    await done(w.ctx.agents.draft({ ...req, paragraphIds: ['p1'], fakeHint: { retryFixes: true } } as typeof req));
    const ss = proposed()[0]!.paragraphs[0]!.sentences;
    expect(ss.every((x) => x.state === 'proposed')).toBe(true);
    expect(ss.some((x) => x.text.includes('[fact?'))).toBe(true);
  });

  it.skipIf(!ready)('anchors after the requested sentence when it exists', async () => {
    await writeOutline(filledOutline());
    const anchor = w.docs.units.find((u) => u.sectionId === 'sec:results')!.id;
    await done(w.ctx.agents.draft({ ...req, afterSentenceId: anchor }));
    expect(proposed()[0]).toMatchObject({ afterSentenceId: anchor, insertAt: null });
  });
});

describe('referee (fake mode)', () => {
  it('saves at most four questions for the section, anchored to sentences, and questions() reads them', async () => {
    const r = await done<{ questions: Array<{ sentenceId: string | null }> }>(w.ctx.agents.referee('sec:results'));
    const qs = w.ctx.agents.questions('sec:results');
    expect(qs.length).toBeGreaterThan(0);
    expect(qs.length).toBeLessThanOrEqual(4);
    expect(qs).toEqual(r.questions);
    expect(qs.every((q) => q.sectionId === 'sec:results' && q.question.startsWith('（模拟）'))).toBe(true);
    // The baseline question points at the first sentence with a number.
    const first = w.docs.units.find((u) => u.sectionId === 'sec:results' && /\d/.test(w.docs.state.text.slice(u.start, u.end)))!;
    expect(qs[0]!.sentenceId).toBe(first.id);
    const file = JSON.parse(readFileSync(w.project.paths.questions, 'utf8'));
    expect(Object.keys(file)).toEqual(['sec:results']);
    // Another section is stored beside it; questions() without a section lists both.
    await done(w.ctx.agents.referee('sec:intro'));
    expect(w.ctx.agents.questions().length).toBe(qs.length + w.ctx.agents.questions('sec:intro').length);
    expect(w.ctx.agents.questions('sec:none')).toEqual([]);
  });

  it('fails a section with no text', async () => {
    const j = await settle(w.ctx.agents.referee('sec:missing'));
    expect(j.state).toBe('error');
    expect(j.message).toMatch(/no sentences/);
    expect(existsSync(w.project.paths.questions)).toBe(false);
  });
});

describe('updateMemo (fake mode)', () => {
  it('needs ten new substantive edit pairs, then updates the memo once', async () => {
    for (let i = 0; i < 9; i++) w.pairs.push(pair(i));
    w.pairs.push(pair(20, { grammarOnly: true }), pair(21, { editDistance: 0.05 }));
    const a = await done<{ updated: boolean; reason: string }>(w.ctx.agents.updateMemo());
    expect(a).toMatchObject({ updated: false, reason: 'not enough new edits' });
    expect(w.voice.sets).toEqual([]);

    w.pairs.push(pair(30));
    const b = await done<{ updated: boolean; pairs: number }>(w.ctx.agents.updateMemo());
    expect(b).toMatchObject({ updated: true, pairs: 10 });
    expect(w.voice.memo()).toContain('（模拟）根据 10 条编辑对更新');
    expect(w.voice.memo()).toContain('verb first');
    expect(w.voice.memo()).toContain('Prefers "we find"'); // the author's own bullet is kept
    expect(w.db.kv.get(MEMO_CURSOR_KEY)).toBe(String(w.pairs.length));

    const c = await done<{ updated: boolean }>(w.ctx.agents.updateMemo());
    expect(c.updated).toBe(false); // the same pairs are not counted twice
  });
});

describe('helpers', () => {
  it('matches referee hints to sentences and caps memo length at line boundaries', () => {
    const units = [
      { id: 'a', text: 'The test set holds 8,710 targets.' },
      { id: 'b', text: 'The fake-track rate is 0.55\\% against 1.38\\% for the baseline.' },
    ];
    expect(matchSentenceHint('The fake-track rate is 0.55', units)).toBe('b');
    expect(matchSentenceHint('fake track rate baseline', units)).toBe('b');
    expect(matchSentenceHint('something unrelated entirely', units)).toBeNull();
    expect(matchSentenceHint(null, units)).toBeNull();
    const memo = Array.from({ length: 50 }, (_, i) => `- bullet ${i} with five more words here`).join('\n');
    const capped = capWords(memo, 400);
    expect(capped.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(400);
    expect(capped.endsWith('here\n')).toBe(true);
  });

  it('inserts after the heading (and its label) when a section has no sentences', () => {
    const text = '\\begin{document}\n\\section{Empty}\n\\label{sec:empty}\n\n\\end{document}\n';
    const state = { file: 'x.tex', version: 1, text, units: [], intentLines: [], seg: { sentences: [], sections: [{ id: 'sec:empty', title: 'Empty', level: 1, start: text.indexOf('\\section'), line: 2, part: 'body' as const, label: 'sec:empty' }], paragraphs: [], intentLines: [], labels: [], refs: [], cites: [], fragment: false } };
    expect(insertionPoint(state, 'sec:empty')).toBe(text.indexOf('}\n\n') + 1);
    expect(insertionPoint(state, 'sec:other')).toBe(text.indexOf('\\end{document}'));
  });
});
