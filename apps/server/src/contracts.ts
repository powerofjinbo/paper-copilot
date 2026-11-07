/**
 * Server-side contracts: the service container (Ctx) and every service interface.
 *
 * Each service lives in its own module and exports a factory `createXService(ctx: Ctx): XService`.
 * Services reference each other only through `ctx` (resolved lazily at call time), so they can be
 * built and tested independently. Route modules export `registerXRoutes(app, ctx)`.
 *
 * SECURITY (non-negotiable; the server can spend API credits, read the analysis repo and push to
 * Overleaf): bind to 127.0.0.1 only; every /api request and the /ws upgrade must carry the per-launch
 * token (header `x-paper-token`, or `?token=` for the PDF URL and the WebSocket); WebSocket upgrades
 * must also come from the server's own origin (or the Vite dev origin in dev mode). The token is
 * generated at launch (crypto.randomBytes(24).toString('base64url')) and injected into the served
 * index.html as `<meta name="paper-token" content="...">`. In dev mode (Vite serves index.html) the
 * client gets it from `GET /api/session`, which answers only when the request carries the custom
 * header `x-paper-client: 1` (forces a CORS preflight, which the server never approves) and a Host
 * header of 127.0.0.1:<port> or localhost:<port> (defeats DNS rebinding). Every request with any other
 * Host header is rejected with 421. No CORS headers are ever sent. Never log the token or the API key.
 * File paths received from the client are relative to texRoot and must be resolved and checked to stay
 * inside it (no `..`, no absolute paths, no symlink escape).
 */
import type { FastifyInstance } from 'fastify';
import type {
  Claim,
  ClientMessage,
  CompileError,
  CorpusEntry,
  CostTotals,
  DraftRequest,
  EditPair,
  EvidenceRecord,
  Fact,
  FactPatch,
  FactsResponse,
  FigureEntry,
  IntentLineInfo,
  IntentRenderRequest,
  JobKind,
  LintFlag,
  LitRecord,
  ManualFact,
  Outline,
  ProjectConfig,
  Proposal,
  PushCheck,
  ReanchorReport,
  RefereeQuestion,
  RepoBriefOutput,
  Segmentation,
  SentenceUnit,
  SentenceVersion,
  ServerMessage,
  SkillBundle,
  StyleDistanceResponse,
  StyleFeatures,
  TaskKind,
  TermEntry,
  Usage,
  PromptBlock,
  DerivedRelation,
} from '@paper-copilot/core';
import type { z } from 'zod';

/* ------------------------------------------------------------------------------------ */
/* Paths (.paper sidecar layout; docs/design.md "Data model")                            */
/* ------------------------------------------------------------------------------------ */

export interface PaperPaths {
  /** Project root, e.g. ~/papers/canto. */
  root: string;
  /** The LaTeX tree (Overleaf clone). Only this is ever synced. */
  tex: string;
  /** root/.paper */
  paper: string;
  config: string; // .paper/project.json
  db: string; // .paper/paper.db
  history: string; // .paper/history.jsonl
  outline: string; // .paper/outline.json
  facts: string; // .paper/facts.json
  claims: string; // .paper/claims.json
  figures: string; // .paper/figures.json
  terminology: string; // .paper/terminology.json
  evidence: string; // .paper/evidence.jsonl
  questions: string; // .paper/questions.json
  briefDir: string; // .paper/brief
  repoBrief: string; // .paper/brief/repo_brief.md
  litBrief: string; // .paper/brief/lit_brief.md
  litDir: string; // .paper/lit
  litIndex: string; // .paper/lit/index.json
  voiceDir: string; // .paper/voice
  corpus: string; // .paper/voice/corpus.jsonl
  voiceStats: string; // .paper/voice/stats.json
  memo: string; // .paper/voice/memo.md
  editPairs: string; // .paper/voice/edit_pairs.jsonl
  syncBase: string; // .paper/sync/base
  build: string; // .paper/build
  /** cwd for Agent SDK sessions: .paper/claude (contains .claude/skills/hep-paper-writing -> skillDir symlink). */
  claudeCwd: string;
  costLog: string; // .paper/cost.jsonl
  aiUseRecord: string; // .paper/ai_use_record.json
}

/* ------------------------------------------------------------------------------------ */
/* Infrastructure                                                                        */
/* ------------------------------------------------------------------------------------ */

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

export interface EventBus {
  /** Broadcast to every connected client. */
  emit(msg: ServerMessage): void;
  subscribe(fn: (msg: ServerMessage) => void): () => void;
}

export interface JobInfo {
  id: string;
  kind: JobKind;
  state: 'queued' | 'running' | 'done' | 'error';
  message: string;
  startedAt: string;
  finishedAt: string | null;
  result: unknown;
}

export interface JobRegistry {
  /** Runs `run` in the background; emits job.progress events; returns the job id immediately. */
  start(kind: JobKind, run: (progress: (message: string) => void) => Promise<unknown>): string;
  get(id: string): JobInfo | undefined;
  list(): JobInfo[];
}

/** node:sqlite-backed store (DatabaseSync). Tables: units, versions, lint, orphans, kv. */
export interface PaperDb {
  units(file: string): SentenceUnit[];
  unit(id: string): SentenceUnit | undefined;
  upsertUnits(units: SentenceUnit[]): void;
  /** Removed units are kept (removed = 1) so their history stays queryable; they are not returned by units(). */
  markRemoved(ids: string[]): void;
  saveOrphans(units: SentenceUnit[]): void;
  orphans(file: string): SentenceUnit[];
  appendVersions(versions: SentenceVersion[]): void;
  versions(id: string): SentenceVersion[];
  lastVersion(id: string): SentenceVersion | undefined;
  lastAiVersion(id: string): SentenceVersion | undefined;
  allVersions(): SentenceVersion[];
  setLint(file: string, flags: LintFlag[], scope: 'sentences' | 'document', sentenceIds: string[]): void;
  lint(file: string): LintFlag[];
  /** The stored flags split by the pass that produced them (seeds the lint service after a restart). */
  lintByScope?(file: string): { sentences: LintFlag[]; document: LintFlag[] };
  dismissLint(id: string): void;
  kvGet(key: string): string | undefined;
  kvSet(key: string, value: string): void;
  transaction<T>(fn: () => T): T;
  close(): void;
}

/** JSON / JSONL files in .paper (atomic writes: temp file + rename). */
export interface PaperFiles {
  readJson<T>(path: string, schema: z.ZodType<T>, fallback: T): T;
  writeJson(path: string, value: unknown): Promise<void>;
  appendJsonl(path: string, value: unknown): Promise<void>;
  readJsonl<T>(path: string, schema: z.ZodType<T>): T[];
  readText(path: string): string | null;
  writeText(path: string, text: string): Promise<void>;
}

/* ------------------------------------------------------------------------------------ */
/* Documents and sentence units                                                          */
/* ------------------------------------------------------------------------------------ */

export interface DocState {
  /** Relative to texRoot. */
  file: string;
  version: number;
  text: string;
  units: SentenceUnit[];
  seg: Segmentation;
  intentLines: IntentLineInfo[];
}

export interface DocService {
  /** .tex files under texRoot, relative, sorted, main file first. */
  files(): Promise<string[]>;
  /**
   * Load a file: read disk; if the sidecar has units and a last-saved snapshot for it, re-anchor them
   * against the disk text (external changes while the app was closed); otherwise import (all units
   * 'human', imported = true, version origin 'import'). Idempotent.
   */
  open(file: string): Promise<DocState>;
  get(file: string): DocState | undefined;
  /**
   * Apply a client transaction. If msg.baseVersion !== current version, reject by returning false (the
   * caller then sends a fresh doc.snapshot). Otherwise: apply ChangeSet.fromJSON to the mirror text,
   * mapUnits, remember dirty ranges and the annotation (with its range), bump the version, send doc.ack,
   * and schedule a debounced (300 ms) re-segmentation -> assignUnits -> persist units/versions/history,
   * write the file to disk (debounced 1 s, atomic, self-write remembered so the watcher ignores it),
   * emit sentences.patch, feed edit pairs to the voice service, ask lint for the changed units and
   * schedule the document lint pass. Annotated changes are re-segmented immediately (no debounce) so
   * provenance is attached to the exact text the AI produced.
   * When `origin` is given, an accepted change is also emitted on the bus as `doc.remoteChange` (in the
   * same synchronous step that applies it, so no later message about the file can overtake it); the
   * WebSocket hub delivers it to every socket except the one whose client id is `origin.clientId`.
   */
  applyClientChange(msg: Extract<ClientMessage, { type: 'doc.change' }>, origin?: { clientId: string }): Promise<boolean>;
  /** Run any pending re-segmentation and disk write now. */
  flush(file: string): Promise<void>;
  /** After a pull or an external edit: diff + reanchor, persist, emit doc.replace. */
  reloadFromDisk(file: string, source: 'pull' | 'external'): Promise<ReanchorReport>;
  unit(id: string): SentenceUnit | undefined;
  /** Change a unit's metadata (state, move, claims...) without changing text; optional version row; emits sentences.patch. */
  updateUnit(id: string, patch: Partial<SentenceUnit>, version?: Omit<SentenceVersion, 'sentenceId' | 'version' | 'ts' | 'parentVersion'> | null): SentenceUnit;
  /** Units of all open files, document order per file. */
  allUnits(): SentenceUnit[];
  /** Source text of a unit (current mirror). */
  unitText(id: string): string | null;
  /** The paragraph text before/after a unit and the previous paragraphs (for prompts). */
  context(id: string): { before: string; after: string; paragraphBefore: string; paragraphAfter: string; previousParagraphs: string[]; sectionId: string; sectionTitle: string; part: string } | null;
  /** Labels of the whole project (all open files). */
  labels(): string[];
  /** Subscribe to unit changes (lint, facts and voice hook into this). */
  onUnitsChanged(cb: (file: string, upserts: SentenceUnit[], removed: string[]) => void): () => void;
  snapshotMessage(file: string): Extract<ServerMessage, { type: 'doc.snapshot' }>;
}

/* ------------------------------------------------------------------------------------ */
/* Grounding                                                                             */
/* ------------------------------------------------------------------------------------ */

export interface FactService {
  all(): Fact[];
  get(id: string): Fact | undefined;
  /**
   * Deterministic extractor over config.factGlobs in repoDir (default ['results/**\/*.json',
   * 'results/**\/*.csv', 'docs/definitions.md']): every numeric JSON leaf -> fact with JSON pointer
   * locator; every numeric CSV cell -> fact with `csv:row=<n>;col=<name>` locator; cut/definition facts
   * from definitions-style markdown (lines like "pT > 1 GeV"). Definitions come from artifact metadata
   * (sibling string fields, CSV label columns + header), never from a model. Values are read by code.
   * Re-scan keeps user edits (confirmed/excluded/definition overrides) by id and marks facts stale when
   * their fingerprint changed; emits facts.updated.
   */
  rescan(): Promise<{ count: number; stale: string[] }>;
  patch(id: string, patch: z.infer<typeof FactPatch>): Fact;
  addManual(fact: z.infer<typeof ManualFact>): Fact;
  /** Register repo-reader candidates: read the value at each locator in code; reject candidates whose locator does not resolve. */
  addCandidates(candidates: RepoBriefOutput['fact_candidates']): Promise<{ added: Fact[]; rejected: Array<{ candidate: unknown; reason: string }> }>;
  /** Facts usable in prompts (not excluded), ranked for a paragraph: plan facts first, then BM25 by text. */
  forPrompt(opts: { factIds?: string[]; query?: string; limit?: number }): Fact[];
  /** Link numerals of a unit to facts (core linkSentenceFacts) and store the result on the unit. */
  linkUnit(unit: SentenceUnit, text: string, prefer?: string[]): { factIds: string[]; unmatched: string[]; ambiguous: Array<{ raw: string; candidates: string[] }> };
  /** Numerals in the document with no or ambiguous facts (retro-grounding of an imported draft). */
  unresolved(): FactsResponse['unresolved'];
  claims(): Claim[];
  figures(): FigureEntry[];
  terminology(): TermEntry[];
  saveClaims(claims: Claim[]): Promise<void>;
  saveFigures(figures: FigureEntry[]): Promise<void>;
  saveTerminology(terms: TermEntry[]): Promise<void>;
  addEvidence(rec: EvidenceRecord): Promise<void>;
  /**
   * Numbers derived from two facts that the gate accepts (core derivedRelations, cached). Passed to every
   * gate call (ghost, rewrite, draft) and used by linkUnit. Optional (additive): callers fall back to
   * core derivedRelations(all()).
   */
  derived?(): DerivedRelation[];
  /**
   * Sentences that still state a value the analysis no longer gives (R2-I-2, R2-I-10): a numeral that
   * matches the PREVIOUS value of a fact that changed on a rescan (confirmed since or not), or the value of
   * a fact whose artifact field disappeared, and that no current CONFIRMED fact holds. Read from the text, not from
   * the stored links, so a re-link (restart, an edit elsewhere in the sentence), an ambiguous numeral or
   * an excluded/missing fact cannot hide it; it ends when the sentence no longer states that number.
   * Optional (additive).
   */
  staleStatements?(units: ReadonlyArray<{ id: string; text: string }>): Array<{ factId: string; sentenceIds: string[] }>;
}

export interface LitService {
  /** Records for every key in the .bib files (parsed with @retorquere/bibtex-parser), merged with resolutions. */
  records(): LitRecord[];
  /** Keys the AI may cite: status resolved or user_confirmed, with titles. */
  allowedKeys(): Array<{ key: string; title: string }>;
  /** All keys present in the .bib files. */
  bibKeys(): string[];
  /** Re-read the .bib files. */
  reloadBib(): Promise<void>;
  /**
   * Resolve keys against INSPIRE-HEP (by arXiv eprint or DOI from the bib entry, else title search):
   * token bucket of 15 requests per 5 s, batched queries, cache in .paper/lit/<key>.json, offline-safe
   * (network failure leaves status unresolved and never throws). Runs as a job.
   */
  resolveAll(): Promise<LitRecord[]>;
  confirm(key: string): LitRecord;
  /** Short literature brief for prompts (titles and one-line descriptions of resolved keys). */
  brief(): string;
}

/* ------------------------------------------------------------------------------------ */
/* Lint, LLM, agents                                                                     */
/* ------------------------------------------------------------------------------------ */

export interface LintService {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Sentence-local pass (sidecar lint.sentences + AI-ese + gate warnings); emits lint.update scope 'sentences'. */
  lintUnits(file: string, units: SentenceUnit[]): Promise<void>;
  /** Debounced (2 s) whole-document pass (sidecar lint.document on the flattened, shadowed text); emits lint.update scope 'document'. */
  scheduleDocument(file: string): void;
  lintDocumentNow(file: string): Promise<void>;
  /** The FULL current list for a file (both passes merged, flags of removed sentences dropped); every lint.update carries it. */
  flags(file: string): LintFlag[];
  /** Mark a flag dismissed (persisted); emits lint.update with the full list of each file that holds it. Returns whether the flag was known. */
  dismiss(flagId: string): boolean;
  status(): { sidecar: boolean; reason: string | null; styleCheckVersion: string | null };
}

export interface LlmRequest {
  route: 'ghost' | 'actions' | 'drafter' | 'reader' | 'memo';
  task: TaskKind;
  model: string;
  system: PromptBlock[];
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens: number;
  /** 'disabled' (Haiku ghost), 'between_tools' (Sonnet no up-front thinking), 'adaptive' (default). */
  thinking: 'disabled' | 'between_tools' | 'adaptive';
  effort: 'low' | 'medium' | 'high';
  /** JSON schema for output_config.format (null = plain text). */
  schema: Record<string, unknown> | null;
  stopSequences?: string[];
  signal?: AbortSignal;
  /** Structured data the fake client uses to craft deterministic, schema-valid output. Ignored by the real client. */
  fakeHint?: unknown;
}

export interface LlmResponse {
  text: string;
  /** Parsed JSON when a schema was given and the output parsed; else null. */
  json: unknown;
  model: string;
  usage: Usage;
  stopReason: string | null;
  requestId: string | null;
  ms: number;
  ttftMs: number | null;
  costUsd: number;
}

export interface LlmClient {
  readonly fake: boolean;
  complete(req: LlmRequest): Promise<LlmResponse>;
  /** Cache pre-warm: same system + config, max_tokens 0 (or the documented minimum); returns usage. */
  prewarm(req: LlmRequest): Promise<Usage | null>;
}

export interface LlmService {
  readonly client: LlmClient;
  /** Handle a ghost.request: build prompt (blocks A/B/C + ghost tail), call the ghost route, gate, regenerate once on failure, reply via `send`. Cancellable. */
  handleGhostRequest(msg: Extract<ClientMessage, { type: 'ghost.request' }>, send: (m: ServerMessage) => void): Promise<void>;
  cancelGhost(requestId: string): void;
  ghostFeedback(msg: Extract<ClientMessage, { type: 'ghost.feedback' }>): void;
  instruct(sentenceId: string, instruction: string, lang: string | null): Promise<Proposal>;
  alternatives(sentenceId: string, n: number): Promise<Proposal[]>;
  grammar(sentenceId: string): Promise<Proposal>;
  renderIntent(req: z.infer<typeof IntentRenderRequest>): Promise<Proposal[]>;
  /** Re-plan downstream proposed sentences after an edit; emits replan.proposed and plan.updated. */
  replanAfterEdit(file: string, sentenceId: string): Promise<void>;
  /** Pre-warm caches for the ghost and actions routes (on document open; the template is the open file's dominant one). */
  prewarm(file?: string): Promise<void>;
  /** The author did something (any client message): keeps the cache keep-alive running. */
  noteActivity?(): void;
  /** Stop timers (keep-alive) and wait for the queued cost-log writes. */
  close?(): void | Promise<void>;
  skill(): SkillBundle | null;
  /** Build the shared system blocks for a task (same code path for every route). */
  systemFor(task: TaskKind, opts: { sectionType: string; template?: string | null; query?: string; factIds?: string[] }): PromptBlock[];
  costTotals(): CostTotals;
  /** Record usage from any route (agents report SDK usage here too). */
  recordUsage(model: string, usage: Usage, route: string): void;
}

export interface AgentService {
  /** Read-only repo reader (Agent SDK, Sonnet): writes repo_brief.md, registers fact candidates by locator. Returns a job id. */
  readRepo(): string;
  /** Three alternative framings after the author filled the five items. Job id. */
  framings(): string;
  /** Draft paragraphs of a section; emits draft.proposed with gated sentences. Job id. */
  draft(req: z.infer<typeof DraftRequest>): string;
  /** At most four referee questions for a section; stored in questions.json. Job id. */
  referee(sectionId: string): string;
  /** Refresh the voice memo from new edit pairs (>= 10 pairs with edit distance > 0.1, grammar-only excluded). Job id. */
  updateMemo(): string;
  questions(sectionId?: string): RefereeQuestion[];
}

/* ------------------------------------------------------------------------------------ */
/* Build, sync, voice                                                                    */
/* ------------------------------------------------------------------------------------ */

export interface CompileStatus {
  state: 'idle' | 'running' | 'ok' | 'error';
  pdfVersion: number | null;
  errors: CompileError[];
  logTail: string;
  durationMs: number | null;
}

export interface BuildService {
  available(): { latexmk: boolean; synctex: boolean };
  /** Compile the shadow copy (intent lines blanked) with latexmk -pdf -synctex=1 -interaction=nonstopmode into .paper/build; emits compile.status. Concurrent calls coalesce. */
  compile(reason: 'save' | 'manual'): Promise<CompileStatus>;
  /** Debounced (2 s) compile after saves. */
  scheduleCompile(): void;
  status(): CompileStatus;
  /**
   * The files of `texts` (texRoot-relative path -> current text) whose text differs from what the last
   * finished compile typeset; null when nothing was compiled in this launch. Optional (additive).
   */
  changedSinceCompile?(texts: ReadonlyMap<string, string>): string[] | null;
  pdfPath(): string | null;
  forward(file: string, line: number): Promise<{ page: number; x: number; y: number; w: number; h: number } | null>;
  inverse(page: number, x: number, y: number): Promise<{ file: string; line: number } | null>;
  /** Shutdown: cancel a scheduled compile, stop a running latexmk and wait for it; later compile() calls do nothing. Optional (additive). */
  close?(): Promise<void>;
}

export interface SyncService {
  status(): Promise<{ mode: 'git' | 'ols' | 'none'; remote: string | null; branch: string; ahead: number; behind: number; dirty: boolean }>;
  /** git pull --rebase (or ols), then reloadFromDisk for every changed .tex file; updates sync/base. */
  pull(): Promise<ReanchorReport[]>;
  /** Blockers: proposed/unsupported/placeholder units, intent lines, CJK in .tex; plus the diff co-authors will see. */
  pushCheck(): Promise<PushCheck>;
  /** Refuses unless pushCheck().ok. Commits only texRoot changes, never force-pushes, never renames files. */
  push(message: string): Promise<{ ok: boolean; output: string; check: PushCheck }>;
}

export interface VoiceService {
  corpus(): CorpusEntry[];
  addCorpus(entries: Array<Omit<CorpusEntry, 'id'>>): Promise<CorpusEntry[]>;
  setUnassisted(id: string, unassisted: boolean): Promise<void>;
  memo(): string;
  setMemo(text: string): Promise<void>;
  editPairs(): EditPair[];
  addEditPairs(pairs: EditPair[]): Promise<void>;
  /** BM25 over the UNASSISTED corpus, restricted to a section type when enough entries exist. */
  exemplars(sectionType: string, query: string, k: number): string[];
  authorNorms(): StyleFeatures | null;
  /** Short table "you vs corpus" for block A. */
  authorNormsTable(): string;
  styleDistance(scope: 'document' | 'section' | 'paragraph', id?: string): StyleDistanceResponse;
  /** Wait for background writes (the stats.json cache) to land. Optional (additive). */
  flush?(): Promise<void>;
}

/* ------------------------------------------------------------------------------------ */
/* The container                                                                         */
/* ------------------------------------------------------------------------------------ */

export interface Ctx {
  paths: PaperPaths;
  config: ProjectConfig;
  saveConfig(next: ProjectConfig): Promise<void>;
  /** Per-launch API token (see SECURITY above). */
  token: string;
  /** True when no ANTHROPIC_API_KEY is configured or PAPER_FAKE_LLM=1: deterministic simulated AI, clearly labelled in the UI. */
  fakeLlm: boolean;
  log: Logger;
  bus: EventBus;
  jobs: JobRegistry;
  db: PaperDb;
  files: PaperFiles;
  docs: DocService;
  facts: FactService;
  lit: LitService;
  lint: LintService;
  llm: LlmService;
  agents: AgentService;
  build: BuildService;
  sync: SyncService;
  voice: VoiceService;
}

export type RegisterRoutes = (app: FastifyInstance, ctx: Ctx) => void | Promise<void>;

/** Helper type for route handlers that may fail with an HTTP status. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
