/**
 * Wire protocol between the web client and the local server.
 *
 * Text ownership: the web client (CodeMirror) is the only writer of document text while a
 * file is open. It sends every transaction to the server as a `doc.change` with a
 * sequential version. The server mirrors the text, maps sentence spans through each change,
 * re-segments dirty paragraphs on a debounce, persists, lints and answers with
 * `sentences.patch` tagged with the version it describes. AI text (ghost, rewrites, drafts)
 * reaches the document only as client transactions carrying a `ChangeAnnotation`, so
 * provenance is recorded on the same path as typing.
 *
 * The only server-initiated text change is `doc.replace` (after a pull or an external edit),
 * which the client applies only when it has no unacknowledged changes.
 */
import { z } from 'zod';
import {
  Claim,
  Fact,
  FigureEntry,
  LintFlag,
  LitRecord,
  Outline,
  ProjectConfig,
  SentenceState,
  SentenceUnit,
  SentenceVersion,
  TermEntry,
  VersionOrigin,
} from './schemas';

/* ------------------------------------------------------------------------------------ */
/* Shared pieces                                                                         */
/* ------------------------------------------------------------------------------------ */

/** JSON form of a CodeMirror ChangeSet (`ChangeSet.toJSON()`), relative to `baseVersion`. */
export const ChangeSetJSON = z.array(z.union([z.number(), z.array(z.union([z.number(), z.string()]))]));
export type ChangeSetJSON = z.infer<typeof ChangeSetJSON>;

/** Provenance attached to a client transaction that inserts AI text or changes a unit's state. */
export const ChangeAnnotation = z.object({
  origin: VersionOrigin,
  /** Units the change belongs to (for a rewrite: the rewritten unit; for a draft: empty, new units). */
  sentenceIds: z.array(z.string()),
  /** State the resulting unit(s) should get, e.g. 'proposed' for drafts, 'ai-drafted' for accepted ghost text. */
  state: SentenceState.nullable(),
  model: z.string().nullable(),
  promptHash: z.string().nullable(),
  instruction: z.string().nullable(),
  lang: z.string().nullable(),
  intentNote: z.string().nullable(),
  factIds: z.array(z.string()),
  citeKeys: z.array(z.string()),
  move: z.string().nullable(),
  /** For ghost acceptance: the request id, so the server can log the outcome. */
  requestId: z.string().nullable(),
});
export type ChangeAnnotation = z.infer<typeof ChangeAnnotation>;

export const IntentLineInfo = z.object({
  start: z.number().int(),
  end: z.number().int(),
  line: z.number().int(),
  text: z.string(),
});
export type IntentLineInfo = z.infer<typeof IntentLineInfo>;

export const GateIssueWire = z.object({
  code: z.string(),
  severity: z.enum(['block', 'warn']),
  message: z.string(),
  start: z.number().int().optional(),
  end: z.number().int().optional(),
  raw: z.string().optional(),
});
export type GateIssueWire = z.infer<typeof GateIssueWire>;

/** One AI proposal for a sentence (rewrite, alternative, grammar fix, intent rendering). */
export const Proposal = z.object({
  proposalId: z.string(),
  sentenceId: z.string().nullable(),
  text: z.string(),
  /** Word-level diff against the current text: [op, text] with op -1 delete, 0 equal, 1 insert. */
  diff: z.array(z.tuple([z.number().int(), z.string()])),
  /** Change notes in the author's notes language (Chinese by default). */
  notes: z.string(),
  /** The skill's drift checklist after a rewrite: did actor/scope/direction/condition change? */
  drift: z.object({ actor: z.boolean(), scope: z.boolean(), direction: z.boolean(), condition: z.boolean() }).nullable(),
  issues: z.array(GateIssueWire),
  factIds: z.array(z.string()),
  citeKeys: z.array(z.string()),
  origin: VersionOrigin,
  model: z.string(),
  promptHash: z.string(),
});
export type Proposal = z.infer<typeof Proposal>;

export const DraftSentence = z.object({
  text: z.string(),
  move: z.string().nullable(),
  factIds: z.array(z.string()),
  citeKeys: z.array(z.string()),
  placeholders: z.array(z.string()),
  noteZh: z.string().nullable(),
  refereeQuestion: z.string().nullable(),
  /** 'proposed' if the gate passed, 'unsupported' if it still failed after retries. */
  state: z.enum(['proposed', 'unsupported']),
  issues: z.array(GateIssueWire),
});
export type DraftSentence = z.infer<typeof DraftSentence>;

export const DraftParagraph = z.object({
  pid: z.string(),
  job: z.string(),
  sentences: z.array(DraftSentence),
});
export type DraftParagraph = z.infer<typeof DraftParagraph>;

export const RefereeQuestion = z.object({
  id: z.string(),
  sectionId: z.string(),
  sentenceId: z.string().nullable(),
  question: z.string(),
  /** A quick estimate that settles the point, for the notes only (never inserted into the paper). */
  estimate: z.string().nullable(),
});
export type RefereeQuestion = z.infer<typeof RefereeQuestion>;

export const CompileError = z.object({ file: z.string(), line: z.number().int().nullable(), message: z.string() });
export type CompileError = z.infer<typeof CompileError>;

export const PushCheck = z.object({
  ok: z.boolean(),
  /** Why a push is refused: unreviewed sentences, placeholders, intent lines, uncompiled changes. */
  blockers: z.array(z.object({ kind: z.enum(['proposed', 'unsupported', 'placeholder', 'intent_line', 'cjk', 'conflict']), sentenceId: z.string().nullable(), line: z.number().int().nullable(), text: z.string() })),
  /** Unified diff of what co-authors will see. */
  diff: z.string(),
  files: z.array(z.string()),
  /**
   * Set when pushing is impossible whatever the blockers (sync mode "none": no remote to push to);
   * `ok` is then false. Optional so older servers and fixtures stay valid.
   */
  unavailable: z.string().nullable().optional(),
});
export type PushCheck = z.infer<typeof PushCheck>;

export const ReanchorReport = z.object({
  unchanged: z.number().int(),
  edited: z.array(z.string()),
  created: z.array(z.string()),
  orphaned: z.array(z.string()),
  split: z.array(z.object({ from: z.string(), into: z.string() })),
});
export type ReanchorReport = z.infer<typeof ReanchorReport>;

export const CostTotals = z.object({
  usd: z.number(),
  byRoute: z.record(z.string(), z.number()),
  byModel: z.record(z.string(), z.number()),
  requests: z.number().int(),
  cacheReadTokens: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
});
export type CostTotals = z.infer<typeof CostTotals>;

export const JobKind = z.enum(['read-repo', 'resolve-lit', 'outline-framings', 'draft', 'referee', 'memo', 'compile', 'pull', 'push', 'import']);
export type JobKind = z.infer<typeof JobKind>;

/* ------------------------------------------------------------------------------------ */
/* WebSocket: client -> server                                                           */
/* ------------------------------------------------------------------------------------ */

export const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), clientId: z.string() }),
  z.object({ type: z.literal('doc.open'), file: z.string() }),
  z.object({
    type: z.literal('doc.change'),
    file: z.string(),
    /** Version the changes apply to; the server's version becomes baseVersion + 1. */
    baseVersion: z.number().int(),
    changes: ChangeSetJSON,
    annotation: ChangeAnnotation.nullable(),
  }),
  z.object({ type: z.literal('doc.flush'), file: z.string(), version: z.number().int() }),
  z.object({
    type: z.literal('ghost.request'),
    requestId: z.string(),
    file: z.string(),
    version: z.number().int(),
    cursor: z.number().int(),
    trigger: z.enum(['boundary', 'pause', 'manual']),
    /** Text typed so far in the current sentence (prefix the ghost must continue verbatim). */
    prefix: z.string(),
  }),
  z.object({ type: z.literal('ghost.cancel'), requestId: z.string() }),
  z.object({
    type: z.literal('ghost.feedback'),
    requestId: z.string(),
    outcome: z.enum(['accepted', 'accepted_partial', 'dismissed', 'expired']),
    acceptedText: z.string().nullable(),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/* ------------------------------------------------------------------------------------ */
/* WebSocket: server -> client                                                           */
/* ------------------------------------------------------------------------------------ */

export const ServerMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('welcome'), serverVersion: z.string(), fakeLlm: z.boolean(), project: ProjectConfig }),
  z.object({
    type: z.literal('doc.snapshot'),
    file: z.string(),
    version: z.number().int(),
    text: z.string(),
    units: z.array(SentenceUnit),
    intentLines: z.array(IntentLineInfo),
  }),
  z.object({
    type: z.literal('sentences.patch'),
    file: z.string(),
    /** The document version these spans refer to. Clients map them through later local changes. */
    version: z.number().int(),
    upserts: z.array(SentenceUnit),
    removed: z.array(z.string()),
    intentLines: z.array(IntentLineInfo),
  }),
  z.object({ type: z.literal('doc.ack'), file: z.string(), version: z.number().int() }),
  z.object({
    type: z.literal('doc.replace'),
    file: z.string(),
    version: z.number().int(),
    text: z.string(),
    units: z.array(SentenceUnit),
    intentLines: z.array(IntentLineInfo),
    report: ReanchorReport,
  }),
  z.object({ type: z.literal('lint.update'), file: z.string(), version: z.number().int(), flags: z.array(LintFlag), scope: z.enum(['sentences', 'document']), sentenceIds: z.array(z.string()) }),
  z.object({
    type: z.literal('ghost.result'),
    requestId: z.string(),
    version: z.number().int(),
    cursor: z.number().int(),
    text: z.string(),
    factIds: z.array(z.string()),
    citeKeys: z.array(z.string()),
    fulfilledMoveIds: z.array(z.string()),
    issues: z.array(GateIssueWire),
    model: z.string(),
    promptHash: z.string(),
  }),
  z.object({ type: z.literal('ghost.empty'), requestId: z.string(), reason: z.string() }),
  z.object({ type: z.literal('ghost.error'), requestId: z.string(), message: z.string() }),
  z.object({ type: z.literal('plan.updated'), outline: Outline }),
  z.object({
    type: z.literal('draft.proposed'),
    jobId: z.string(),
    file: z.string(),
    /** Insert after this unit (null: at `insertAt` offset of `version`). */
    afterSentenceId: z.string().nullable(),
    insertAt: z.number().int().nullable(),
    version: z.number().int(),
    paragraphs: z.array(DraftParagraph),
  }),
  z.object({
    type: z.literal('replan.proposed'),
    file: z.string(),
    /** Revisions for downstream `proposed` sentences only; accepted sentences are never changed. */
    items: z.array(z.object({ sentenceId: z.string(), action: z.enum(['keep', 'revise', 'drop', 'insert_before']), text: z.string().nullable(), reason: z.string() })),
  }),
  z.object({ type: z.literal('compile.status'), state: z.enum(['idle', 'running', 'ok', 'error']), pdfVersion: z.number().int().nullable(), errors: z.array(CompileError), logTail: z.string() }),
  z.object({ type: z.literal('job.progress'), jobId: z.string(), kind: JobKind, state: z.enum(['queued', 'running', 'done', 'error']), message: z.string(), result: z.unknown().optional() }),
  z.object({ type: z.literal('facts.updated'), count: z.number().int(), stale: z.array(z.string()) }),
  z.object({ type: z.literal('cost.update'), totals: CostTotals }),
  z.object({ type: z.literal('notice'), level: z.enum(['info', 'warn', 'error']), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/* ------------------------------------------------------------------------------------ */
/* REST (all under /api)                                                                 */
/* ------------------------------------------------------------------------------------ */

export const ProjectInfo = z.object({
  config: ProjectConfig,
  files: z.array(z.string()),
  fakeLlm: z.boolean(),
  skill: z.object({ found: z.boolean(), dir: z.string(), version: z.string().nullable(), references: z.array(z.string()) }),
  stats: z.object({ units: z.number().int(), proposed: z.number().int(), facts: z.number().int(), placeholders: z.number().int() }),
});
export type ProjectInfo = z.infer<typeof ProjectInfo>;

export const InstructRequest = z.object({ instruction: z.string(), lang: z.string().nullable() });
export const AlternativesRequest = z.object({ n: z.number().int() });
export const IntentRenderRequest = z.object({ file: z.string(), line: z.number().int(), text: z.string(), n: z.number().int() });
export const DraftRequest = z.object({ sectionId: z.string(), paragraphIds: z.array(z.string()).nullable(), fromNotes: z.boolean(), file: z.string(), afterSentenceId: z.string().nullable() });
export const RefereeRequest = z.object({ sectionId: z.string() });
export const FactPatch = z.object({ confirmed: z.boolean().optional(), excluded: z.boolean().optional(), definition: z.string().optional(), unit: z.string().optional(), sigfigs: z.number().int().nullable().optional(), tags: z.array(z.string()).optional() });
export const ManualFact = z.object({ id: z.string(), kind: Fact.shape.kind, value: z.union([z.number(), z.string()]), unit: z.string(), definition: z.string(), uncertainties: z.record(z.string(), z.number()) });
export const RejectResponse = z.object({ replacement: z.string() });
export const PushRequest = z.object({ message: z.string() });

/** Route table, so both sides use the same paths. `:id` is a sentence id. */
export const ROUTES = {
  project: '/api/project',
  doc: '/api/doc', // ?file=
  facts: '/api/facts',
  fact: '/api/facts/:id',
  factsRescan: '/api/facts/rescan',
  factsManual: '/api/facts/manual',
  claims: '/api/claims',
  figures: '/api/figures',
  terminology: '/api/terminology',
  lit: '/api/lit',
  litResolve: '/api/lit/resolve',
  outline: '/api/outline',
  sentenceHistory: '/api/sentences/:id/history',
  sentenceInstruct: '/api/sentences/:id/instruct',
  sentenceAlternatives: '/api/sentences/:id/alternatives',
  sentenceGrammar: '/api/sentences/:id/grammar',
  sentenceAccept: '/api/sentences/:id/accept',
  sentenceReject: '/api/sentences/:id/reject',
  intentRender: '/api/intent/render',
  agentsReadRepo: '/api/agents/read-repo',
  agentsFramings: '/api/agents/outline-framings',
  agentsDraft: '/api/agents/draft',
  agentsReferee: '/api/agents/referee',
  compile: '/api/compile',
  pdf: '/api/pdf',
  synctexForward: '/api/synctex/forward', // ?file=&line=
  synctexInverse: '/api/synctex/inverse', // ?page=&x=&y=
  syncPull: '/api/sync/pull',
  syncPushCheck: '/api/sync/push-check',
  syncPush: '/api/sync/push',
  disclosure: '/api/disclosure', // ?venue=
  styleDistance: '/api/style/distance', // ?scope=document|section&id=
  voice: '/api/voice',
  voiceMemo: '/api/voice/memo',
  voiceCorpus: '/api/voice/corpus',
  cost: '/api/cost',
  questions: '/api/questions', // ?sectionId=
  lintDismiss: '/api/lint/:id/dismiss',
  ws: '/ws',
} as const;

/** Response of GET history. */
export const HistoryResponse = z.object({ unit: SentenceUnit, versions: z.array(SentenceVersion) });
export type HistoryResponse = z.infer<typeof HistoryResponse>;

export const FactsResponse = z.object({ facts: z.array(Fact), unresolved: z.array(z.object({ sentenceId: z.string(), raw: z.string(), candidates: z.array(z.string()) })) });
export type FactsResponse = z.infer<typeof FactsResponse>;

export const PanelsResponse = z.object({ claims: z.array(Claim), figures: z.array(FigureEntry), terminology: z.array(TermEntry), lit: z.array(LitRecord) });
export type PanelsResponse = z.infer<typeof PanelsResponse>;

export const StyleDistanceResponse = z.object({
  scope: z.string(),
  toAuthor: z.number().nullable(),
  toCorpus: z.number(),
  corpusSize: z.number().int(),
  furthest: z.array(z.object({ sentenceId: z.string(), contribution: z.number(), why: z.string() })),
  features: z.record(z.string(), z.number()),
  authorFeatures: z.record(z.string(), z.number()).nullable(),
  corpusFeatures: z.record(z.string(), z.number()),
});
export type StyleDistanceResponse = z.infer<typeof StyleDistanceResponse>;

export const DisclosureResponse = z.object({ venue: z.string(), latex: z.string(), plain: z.string(), placement: z.string(), stats: z.record(z.string(), z.unknown()) });
export type DisclosureResponse = z.infer<typeof DisclosureResponse>;

export function route(path: string, params: Record<string, string>): string {
  return path.replace(/:([a-zA-Z]+)/g, (_m, k: string) => encodeURIComponent(params[k] ?? ''));
}
