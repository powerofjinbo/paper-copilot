/**
 * Fake ctx services for LlmService tests that drive the REAL client (real-llm.test.ts): two documents
 * (main.tex with one sentence and a typed prefix, draft.tex with a paragraph of proposed sentences),
 * two usable facts, one allowed citation key, a voice layer and a key-value store. Everything the LLM
 * service reads that is not the LLM itself; the same shapes as test/llm.service.test.ts.
 */
import { hashString, normalizeForHash, type Fact, type Outline, type PlanStep, type SentenceUnit, type SentenceVersion } from '@paper-copilot/core';
import { HttpError, type DocService, type DocState, type FactService, type LitService, type PaperDb, type VoiceService } from '../../src/contracts';

export function fact(p: Partial<Fact> & Pick<Fact, 'id' | 'value'>): Fact {
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

export const FACTS: Fact[] = [
  fact({ id: 'f.g1.delta_points', value: 2.3191733639494783, unit: 'points', uncertainties: { total: 0.27929769909842683 }, aliases: ['2.32~points'], definition: 'Efficiency difference, Canto-L minus acorn' }),
  fact({ id: 'f.g1.n_targets', value: 8710, tags: ['count'] }),
  fact({ id: 'f.excluded', value: 4.7, excluded: true }),
];

export function unitAt(file: string, text: string, sub: string, id: string, over: Partial<SentenceUnit> = {}): SentenceUnit {
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

export const MAIN = 'main.tex';
export const U1 = 'We compare the two trackers on the same events, as in Ref.~\\cite{Wang2022LRT}.';
export const PREFIX = 'The efficiency gain is';
export const MAIN_TEXT = `\\section{Results}\\label{sec:results}\n\n${U1}\n${PREFIX}`;

export const DRAFT = 'draft.tex';
export const D = [
  'We train the tracker on simulated events.',
  'The training uses the same seeds for both models.',
  'This choice removes one source of variance.',
  'The efficiency then rises by 2.32~points.',
  'We return to this point below.',
];
export const DRAFT_TEXT = `\\section{Results}\n\n${D.join('\n')}\n`;

export function makeDoc(file: string, text: string, units: SentenceUnit[], intentLines: DocState['intentLines'] = []): DocState {
  return { file, version: 1, text, units, seg: {} as DocState['seg'], intentLines };
}

export interface FakeDocs extends DocService {
  docs: Map<string, DocState>;
}

export function fakeDocs(initial: DocState[]): FakeDocs {
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
  } as FakeDocs;
}

export function fakeFacts(): FactService {
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

export function fakeLit(): LitService {
  return { allowedKeys: () => [{ key: 'Wang2022LRT', title: 'Tracking with GNNs' }], brief: () => 'LIT BRIEF' } as unknown as LitService;
}

export function fakeVoice(): VoiceService {
  return { memo: () => 'MEMO', authorNormsTable: () => 'NORMS', exemplars: (_st: string, _q: string, k: number) => ['We measure the efficiency on the test sample.', 'The tracker finds more tracks.'].slice(0, k) } as unknown as VoiceService;
}

export function fakeDb(versions: Map<string, SentenceVersion[]>): PaperDb & { kv: Map<string, string> } {
  const kv = new Map<string, string>();
  return {
    kv,
    kvGet: (k: string) => kv.get(k),
    kvSet: (k: string, v: string) => void kv.set(k, v),
    transaction: <T>(fn: () => T) => fn(),
    versions: (id: string) => versions.get(id) ?? [],
  } as unknown as PaperDb & { kv: Map<string, string> };
}

export const STEP: PlanStep = { id: 'step-gain', intent: 'state the efficiency gain over the baseline', factIds: ['f.g1.delta_points'], citeKeys: [], move: 'result' };

export function outline(over: { ghostMode?: 'complete-my-sentence' | 'auto-propose' | 'questions-only'; remaining?: PlanStep[] } = {}): Outline {
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

/** main.tex + draft.tex as in llm.service.test.ts (draft: d0 ai-edited, d2 ai-drafted, the rest proposed). */
export function standardDocs(): FakeDocs {
  const mainUnits = [unitAt(MAIN, MAIN_TEXT, U1, 'u1', { cites: ['Wang2022LRT'] })];
  const draftUnits = D.map((s, i) =>
    unitAt(DRAFT, DRAFT_TEXT, s, `d${i}`, {
      state: i === 0 ? 'ai-edited' : i === 2 ? 'ai-drafted' : 'proposed',
      facts: i === 3 ? ['f.g1.delta_points'] : [],
    }),
  );
  return fakeDocs([makeDoc(MAIN, MAIN_TEXT, mainUnits), makeDoc(DRAFT, DRAFT_TEXT, draftUnits)]);
}
