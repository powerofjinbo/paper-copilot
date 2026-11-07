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
 * which the client applies only when it has no unacknowledged changes. With several tabs on one file,
 * every accepted doc.change is relayed to the other sockets as `doc.remoteChange`.
 */
import { z } from 'zod';
import {
  Claim,
  Fact,
  FigureEntry,
  LintFlag,
  LitRecord,
  Outline,
  Part,
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
    /**
     * Version of the last doc.snapshot / doc.replace the client had applied when it sent this change (its
     * text lineage). Optional (older clients omit it). The server rejects a change whose epoch, or whose
     * baseVersion, predates the last snapshot or replace it SENT TO THIS SOCKET, and answers with a fresh
     * doc.snapshot: a change made before the client saw that text can only be applied in the wrong place.
     */
    epoch: z.number().int().optional(),
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
  /**
   * A doc.change the server accepted from ANOTHER socket (another tab or window on the same file), sent to
   * every other socket at the moment it is applied, so they converge at once. `version` is the server version
   * after the change (`changes` apply to `version - 1`). A client applies it as a remote change (not undoable,
   * no doc.change echo) when it is at `version - 1`, rebasing its own unacknowledged changes over it; anything
   * else is resolved by the snapshot the server sends when the client's next change is rejected.
   */
  z.object({ type: z.literal('doc.remoteChange'), file: z.string(), version: z.number().int(), changes: ChangeSetJSON, originClientId: z.string() }),
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

/**
 * `unresolved`: numerals of the paper's text that match no fact (or several). `file`, `line` and `text`
 * (optional, added for multi-file papers) say where: the list covers every typeset file, not only the
 * file open in the editor.
 */
export const FactsResponse = z.object({
  facts: z.array(Fact),
  unresolved: z.array(
    z.object({ sentenceId: z.string(), raw: z.string(), candidates: z.array(z.string()), file: z.string().optional(), line: z.number().int().optional(), text: z.string().optional() }),
  ),
});
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

/* ------------------------------------------------------------------------------------ */
/* Batch B: consistency, terminology, figure plan, derived relations, submission check   */
/* (pure core logic in src/consistency, src/meta/derived.ts, src/meta/submission.ts; the  */
/* server computes these on demand and the web panels render them)                       */
/* ------------------------------------------------------------------------------------ */

/** Where a sentence is, for every report row (enough to jump to it and show it). */
export const SentenceRef = z.object({
  sentenceId: z.string().nullable(),
  file: z.string(),
  line: z.number().int().nullable(),
  part: Part.nullable(),
  /** The sentence's LaTeX source, shortened to at most 200 characters. */
  text: z.string(),
});
export type SentenceRef = z.infer<typeof SentenceRef>;

/**
 * Every flag kind the Consistency, Terminology and Figure-plan reports can raise. Labels and one-line
 * explanations in Chinese and English: `t('consistency.<kind>', lang)` (src/i18n).
 */
export const ConsistencyFlagKind = z.enum([
  // echo check (numbers across abstract, body, conclusions, captions)
  'drift_precision',
  'drift_form',
  'drift_value',
  'factor_percent',
  'condition_dropped',
  'stale_fact',
  'ambiguous_number',
  'key_phrase_missing',
  'key_phrase_partial',
  'no_contribution_sentence',
  'headline_missing',
  'headline_baseline',
  'headline_condition',
  // terminology
  'acronym_before_definition',
  'acronym_undefined',
  'acronym_abstract_only',
  'acronym_abstract_undefined',
  'acronym_redefined',
  'acronym_defined_unused',
  'variant_hyphen',
  'variant_case',
  'variant_spelling',
  // figure plan
  'float_uncited',
  'float_order',
  'float_no_label',
  'float_no_caption',
  'caption_anatomy',
  'claim_figure_missing',
  'claim_figure_uncited',
]);
export type ConsistencyFlagKind = z.infer<typeof ConsistencyFlagKind>;

export const ConsistencyFlag = z.object({
  /** Stable id: hashString(kind + subject + sentence ids). */
  id: z.string(),
  kind: ConsistencyFlagKind,
  severity: z.enum(['warn', 'info']),
  /** True when the flag comes from a wording heuristic (shown with a "heuristic" label, never as a fact). */
  heuristic: z.boolean(),
  /** English explanation with the specifics (values, terms, labels). */
  message: z.string(),
  factIds: z.array(z.string()),
  sentenceIds: z.array(z.string()),
  /** The term, acronym or key phrase concerned, if any. */
  term: z.string().nullable(),
  /** The float label concerned, if any. */
  label: z.string().nullable(),
});
export type ConsistencyFlag = z.infer<typeof ConsistencyFlag>;

/** How a number is written in the text. */
export const NumberForm = z.enum(['percent', 'points', 'factor', 'fraction', 'plain', 'unit', 'ratio', 'words']);
export type NumberForm = z.infer<typeof NumberForm>;

/** One numeral in one sentence that stands for a fact (or a derived relation of two facts). */
export const NumberOccurrence = SentenceRef.extend({
  /** As written, e.g. "96.94". */
  raw: z.string(),
  /** As read with its form, e.g. "96.94%", "2.32 points", "2.5 times", "nine out of ten". */
  rendering: z.string(),
  /** Value as written (percent numbers stay in percent: 96.94). */
  value: z.number(),
  decimals: z.number().int(),
  sigfigs: z.number().int(),
  form: NumberForm,
  /** 'value' or 'unc:<name>' (the numeral states an uncertainty of the fact). */
  field: z.string(),
  /** Set when the numeral matches a derived relation (ratio, difference, relative change) instead of a fact. */
  derived: z.string().nullable(),
  /** The numeral matches facts with different values (it is listed under the first; see `candidates`). */
  ambiguous: z.boolean(),
  candidates: z.array(z.string()),
  /**
   * Set when the numeral fit several facts and the report picked one without a link (the gate still
   * sees it as unlinked): 'same_value': every candidate holds this very number (an uncertainty of one
   * fact and the standalone sigma fact); 'row': exactly one candidate shares the result row or claim
   * object of a number linked in the same sentence; 'context' (heuristic): exactly one candidate's name
   * words appear in the sentence ("duplicate rate"). Absent/null: linked, unique or still ambiguous.
   */
  resolvedBy: z.enum(['same_value', 'row', 'context']).nullable().optional(),
});
export type NumberOccurrence = z.infer<typeof NumberOccurrence>;

/** A quantity: one fact (with the facts that hold the identical value, e.g. the same number in a CSV and a claim JSON). */
export const EchoQuantity = z.object({
  /** primaryFactId + '#' + field, or 'derived:<a>|<b>:<kind>' for a derived relation. */
  key: z.string(),
  primaryFactId: z.string(),
  /** All facts with this value and unit (the primary first). */
  factIds: z.array(z.string()),
  field: z.string(),
  definition: z.string(),
  stale: z.boolean(),
  occurrences: z.array(NumberOccurrence),
  /** Parts it appears in, in the order abstract, intro, body, caption, concl, app, footnote. */
  parts: z.array(Part),
  /** Distinct renderings, in document order. */
  renderings: z.array(z.string()),
});
export type EchoQuantity = z.infer<typeof EchoQuantity>;

export const KeyPhraseLocation = z.object({
  where: z.enum(['title', 'abstract', 'contribution', 'conclusions']),
  /** present: the phrase (up to inflection and hyphenation); partial: its content words but not the phrase; absent: there is no such place (no contribution sentence, no conclusions). */
  status: z.enum(['present', 'partial', 'missing', 'absent']),
  sentenceIds: z.array(z.string()),
  /** The matching text (plain), if any. */
  matched: z.string().nullable(),
});
export type KeyPhraseLocation = z.infer<typeof KeyPhraseLocation>;

export const HeadlinePlace = z.object({
  where: z.enum(['abstract', 'conclusions']),
  present: z.boolean(),
  sentenceIds: z.array(z.string()),
  /** The baseline fact appears in the same sentence (or the next one); null when the outline names no baseline. */
  baselinePresent: z.boolean().nullable(),
  /** Other facts of the same kind stated next to the headline instead of the baseline. */
  otherBaselines: z.array(z.string()),
  /** The outline's headline condition is stated nearby (content words); null when the outline gives none. */
  conditionPresent: z.boolean().nullable(),
});
export type HeadlinePlace = z.infer<typeof HeadlinePlace>;

/** Result of `echoCheck` (Consistency panel). */
export const EchoReport = z.object({
  quantities: z.array(EchoQuantity),
  /** Numerals that match no fact (per part, so a stale or mistyped headline is visible). */
  unmatched: z.array(NumberOccurrence),
  stale: z.array(z.object({ factId: z.string(), definition: z.string(), sentences: z.array(SentenceRef) })),
  keyPhrase: z.object({ phrase: z.string(), locations: z.array(KeyPhraseLocation) }),
  contribution: SentenceRef.nullable(),
  headline: z.object({
    factId: z.string().nullable(),
    baselineFactId: z.string().nullable(),
    condition: z.string(),
    places: z.array(HeadlinePlace),
  }),
  flags: z.array(ConsistencyFlag),
});
export type EchoReport = z.infer<typeof EchoReport>;

export const AcronymRow = z.object({
  acronym: z.string(),
  /** Long form from the definition ("graph neural network"), or from the terminology list. */
  longForm: z.string().nullable(),
  known: z.boolean(),
  uses: z.number().int(),
  firstUse: SentenceRef.nullable(),
  /** First definition in the main text (not the abstract). */
  definition: SentenceRef.nullable(),
  definitions: z.number().int(),
  definedInAbstract: z.boolean(),
  status: z.enum(['ok', 'used_before_definition', 'undefined', 'defined_only_in_abstract', 'abstract_undefined', 'defined_unused', 'redefined', 'known']),
});
export type AcronymRow = z.infer<typeof AcronymRow>;

export const TermForm = z.object({ form: z.string(), count: z.number().int(), sentenceIds: z.array(z.string()), first: SentenceRef.nullable() });
export type TermForm = z.infer<typeof TermForm>;

export const TermVariantRow = z.object({
  /** The term (from the terminology list, or the majority spelling of a discovered term). */
  term: z.string(),
  kind: z.enum(['hyphen', 'case', 'spelling']),
  /** Spelling family for kind 'spelling' ('-ize/-ise', '-or/-our', ...). */
  family: z.string().nullable(),
  forms: z.array(TermForm),
  /** The form to keep: the terminology list's spelling, else the majority. */
  preferred: z.string(),
  fromList: z.boolean(),
});
export type TermVariantRow = z.infer<typeof TermVariantRow>;

/** Result of `terminologyReport` (Terminology panel). */
export const TerminologyReport = z.object({
  acronyms: z.array(AcronymRow),
  variants: z.array(TermVariantRow),
  /** US or UK spelling, by majority of the spelling families found (null: none found). */
  spelling: z.object({ us: z.number().int(), uk: z.number().int(), majority: z.enum(['US', 'UK']).nullable() }),
  flags: z.array(ConsistencyFlag),
});
export type TerminologyReport = z.infer<typeof TerminologyReport>;

export const CaptionCheckKey = z.enum(['quantity', 'conditions', 'encoding', 'panels', 'takeaway']);
export type CaptionCheckKey = z.infer<typeof CaptionCheckKey>;

export const CaptionCheck = z.object({
  key: CaptionCheckKey,
  /** ok: found; missing: not found; na: not applicable (single-panel figure for 'panels'; tables for 'encoding'). */
  status: z.enum(['ok', 'missing', 'na']),
  /** The words that satisfied it. */
  evidence: z.string().nullable(),
});
export type CaptionCheck = z.infer<typeof CaptionCheck>;

export const FloatPlanRow = z.object({
  kind: z.enum(['figure', 'table']),
  /** 1-based number LaTeX will print (figures and tables counted separately, in document order). */
  number: z.number().int(),
  label: z.string().nullable(),
  labels: z.array(z.string()),
  file: z.string(),
  line: z.number().int(),
  graphics: z.array(z.string()),
  captionSentenceIds: z.array(z.string()),
  caption: z.string(),
  /** First \ref to any of its labels outside the float itself, or null (uncited). */
  firstRef: SentenceRef.nullable(),
  refCount: z.number().int(),
  /** 1-based rank of its first citation among floats of the same kind (null: uncited). */
  citeRank: z.number().int().nullable(),
  /** Cited for the first time after a float that LaTeX numbers later. */
  outOfOrder: z.boolean(),
  checklist: z.array(CaptionCheck),
  claimIds: z.array(z.string()),
});
export type FloatPlanRow = z.infer<typeof FloatPlanRow>;

/** Result of `figurePlan` (Figure plan panel). */
export const FigurePlanReport = z.object({
  floats: z.array(FloatPlanRow),
  claims: z.array(z.object({ claimId: z.string(), figureId: z.string(), label: z.string().nullable(), found: z.boolean(), cited: z.boolean(), claimText: z.string().nullable() })),
  flags: z.array(ConsistencyFlag),
});
export type FigurePlanReport = z.infer<typeof FigurePlanReport>;

/** A number derived from two facts that the gate accepts (meta/derived.ts). Superset of the gate's DerivedRelation. */
export const DerivedRelationSchema = z.object({
  value: z.number(),
  raw: z.string(),
  factIds: z.array(z.string()),
  description: z.string(),
  /** ratio: a / b >= 1 ("2.5 times", "a factor of 2.5"); difference: (a - b) in points; relative: (a - b) / b in percent; share: a / b of two counts ("9 out of 10", "91%"). */
  kind: z.enum(['ratio', 'difference', 'relative', 'share']).optional(),
  /** How the number must be written to match: factor, points, percent, or fraction (ratio / percent / decimal). */
  form: z.enum(['factor', 'points', 'percent', 'fraction']).optional(),
  /** A numeral with more significant figures than this does not match (a ratio is quoted to 1-2). */
  maxSigfigs: z.number().int().optional(),
  renderings: z.array(z.string()).optional(),
});
export type DerivedRelationData = z.infer<typeof DerivedRelationSchema>;

export const SubmissionItemId = z.enum([
  'unreviewed',
  'unsupported',
  'placeholders',
  'intent_lines',
  'cjk',
  'merge_conflicts',
  'compile_errors',
  'undefined_cites',
  'ai_unmatched_numbers',
  'stale_facts',
  'disclosure',
  'unresolved_cites',
  'unmatched_numbers',
  'echo_drift',
  'uncited_floats',
  'acronyms_before_definition',
  'lint_warnings',
  'ambiguous_numbers',
]);
export type SubmissionItemId = z.infer<typeof SubmissionItemId>;

export const SubmissionEntry = z.object({ file: z.string(), sentenceId: z.string().nullable(), line: z.number().int().nullable(), text: z.string() });
export type SubmissionEntry = z.infer<typeof SubmissionEntry>;

export const SubmissionItem = z.object({
  id: SubmissionItemId,
  ok: z.boolean(),
  /** block: submission is not ready while it fails; warn: reread; info: for the record. */
  severity: z.enum(['block', 'warn', 'info']),
  count: z.number().int(),
  /** At most `SUBMISSION_MAX_ENTRIES` entries; `count` is the full number. */
  items: z.array(SubmissionEntry),
  /** Extra English detail (e.g. "not compiled yet", the venue's required phrase). */
  note: z.string().nullable(),
});
export type SubmissionItem = z.infer<typeof SubmissionItem>;

/** Result of `submissionCheck`: ok only if no 'block' item fails. Items in display order (blockers first). */
export const SubmissionReport = z.object({ ok: z.boolean(), blockers: z.number().int(), warnings: z.number().int(), items: z.array(SubmissionItem) });
export type SubmissionReport = z.infer<typeof SubmissionReport>;

/** Routes for the batch B reports (GET, computed on demand from the current texts and stores). */
export const REPORT_ROUTES = {
  consistency: '/api/reports/consistency',
  terminology: '/api/reports/terminology',
  figurePlan: '/api/reports/figure-plan',
  submission: '/api/reports/submission',
  derived: '/api/facts/derived',
} as const;

/* ------------------------------------------------------------------------------------ */
/* Batch B server routes (apps/server/src/routes/reports.ts, routes/restore.ts)            */
/* ------------------------------------------------------------------------------------ */

/**
 * Report and project-tree routes. The reports are computed on demand over every .tex file of the \input
 * tree (the server opens the included files it has not opened yet). The REPORT_ROUTES paths above are
 * served as aliases of the first four.
 *   GET  consistency        EchoReport
 *   GET  terminologyReport  TerminologyReport
 *   GET  figurePlan         FigurePlanReport
 *   GET  submissionCheck    SubmissionReport   (?venue= overrides the project's venue)
 *   GET  factsDerived       DerivedRelationData[] (the relations every gate call accepts)
 *   GET  files              ProjectFilesResponse (an array of ProjectFileEntry)
 *   POST sentenceRestore    RestoreRequest -> RestoreResponse
 */
export const FEATURE_ROUTES = {
  consistency: '/api/consistency',
  terminologyReport: '/api/terminology-report',
  figurePlan: '/api/figure-plan',
  submissionCheck: '/api/submission-check',
  factsDerived: '/api/facts/derived',
  files: '/api/files',
  sentenceRestore: '/api/sentences/:id/restore',
} as const;

/** One .tex file of the project, in document order (the \input tree first, then files nothing inputs). */
export const ProjectFileEntry = z.object({
  file: z.string(),
  /** The project's main file. */
  main: z.boolean(),
  /** The file that \input-s it (null for the main file and for files nothing reaches). */
  parent: z.string().nullable(),
  /** 0 for the main file, 1 for a file it inputs, ...; files nothing reaches: 0. */
  depth: z.number().int(),
  /** Reached from the main file through \input / \include / \subfile (LaTeX typesets it). */
  included: z.boolean(),
  /** Typeset after \appendix. */
  appendix: z.boolean(),
  /** Mirrored by the server right now (a client has it open, or a report needed it). */
  open: z.boolean(),
  /** Sentence units (for a file never opened: the sentences the segmenter finds; all the author's). */
  units: z.number().int(),
  /** AI sentences waiting for review. */
  proposed: z.number().int(),
  /** AI sentences that failed the faithfulness gate. */
  unsupported: z.number().int(),
  /** Sentences holding a placeholder ([fact?: ...], [ref], [claim: ...?]). */
  placeholders: z.number().int(),
  /** Sentences any AI origin ever touched. */
  aiTouched: z.number().int(),
});
export type ProjectFileEntry = z.infer<typeof ProjectFileEntry>;

/** GET /api/files: every .tex file, the main file first, then the \input tree in document order, then files nothing inputs (sorted). */
export const ProjectFilesResponse = z.array(ProjectFileEntry);
export type ProjectFilesResponse = z.infer<typeof ProjectFilesResponse>;

/** Restore an earlier version of a sentence (`version` from GET history). */
export const RestoreRequest = z.object({ version: z.number().int().min(0) });
export type RestoreRequest = z.infer<typeof RestoreRequest>;

/**
 * What the client applies as ONE annotated change: replace [start, end) of document version `docVersion`
 * (the unit's current text, `current`) with `text`, carrying `annotation`. The server never writes the
 * text itself, so provenance is recorded on the same path as every other edit. Origin: 'human_edit'
 * when the restored version is the author's (or a co-author's) text, else the version's own AI origin
 * with its model and prompt hash. `state` is what the unit becomes: AI text the author edited stays
 * 'ai-edited', a draft or re-plan text is 'proposed' again (it needs a review), and restored AI text that
 * no longer passes the faithfulness gate (a fact changed since) is 'unsupported'. everAi is never
 * cleared. `noop`: the sentence already reads exactly like that version (nothing to apply).
 */
export const RestoreResponse = z.object({
  sentenceId: z.string(),
  file: z.string(),
  version: z.number().int(),
  docVersion: z.number().int(),
  start: z.number().int(),
  end: z.number().int(),
  current: z.string(),
  text: z.string(),
  origin: VersionOrigin,
  state: SentenceState,
  annotation: ChangeAnnotation,
  /** Gate issues of restored AI text (empty for the author's own text). */
  issues: z.array(GateIssueWire),
  noop: z.boolean(),
});
export type RestoreResponse = z.infer<typeof RestoreResponse>;
