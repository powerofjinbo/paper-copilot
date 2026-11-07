/**
 * MockApiClient: the whole ApiClient implemented in the browser for a no-backend demo (`?mock=1`).
 *
 * It mirrors the server protocol of packages/core/src/api.ts on the fixture paper:
 * - `doc.open` -> `doc.snapshot` (units from core segment + assignUnits, imported as `human`);
 * - `doc.change` -> mirror the text (ChangeSet.fromJSON), map units (core mapUnits), `doc.ack` with the
 *   new version, then after a 300 ms debounce (immediately for annotated AI changes) re-segment and
 *   send `sentences.patch` tagged with the version it describes; a stale `baseVersion` gets a fresh
 *   `doc.snapshot` instead, exactly like the server.
 * - facts from the fixture claim JSON, an outline with the fixture's sections, deterministic
 *   "simulated" AI (ghost, rewrites, drafts, framings, referee questions; every note says so), the
 *   push guard, disclosure stats, style distance. `fakeLlm` is always true. No TeX here: a compile shows the
 *   example PDF compiled from the fixture (mockPdf.ts), which does not follow edits.
 */
import { ChangeSet, Text } from '@codemirror/state';
import {
  ClientMessage,
  DEFAULT_MODEL_ROUTES,
  Outline,
  ServerMessage,
  SKILL_CORPUS_NORMS,
  aieseFlags,
  assignUnits,
  changedRanges,
  computeDisclosureStats,
  findIntentLines,
  furthestSentences,
  gateSentence,
  hashString,
  linkSentenceFacts,
  mapUnits,
  nowIso,
  plainText,
  renderDisclosure,
  segment,
  shortId,
  styleDistance,
  styleFeatures,
  wordDiff,
  wordTokens,
  type ChangeAnnotation,
  type CorpusEntry,
  type CostTotals,
  type DisclosureResponse,
  type DraftSentence,
  type EditPair,
  type Fact,
  type FactsResponse,
  type GateContext,
  type GateMode,
  type GateResult,
  type HistoryResponse,
  type IntentLineInfo,
  type JobKind,
  type LintFlag,
  type LitRecord,
  type NotesLanguage,
  type PanelsResponse,
  type ProjectConfig,
  type ProjectInfo,
  type Proposal,
  type PushCheck,
  type ReanchorReport,
  type RefereeQuestion,
  type Segmentation,
  type SentenceUnit,
  type SentenceVersion,
  type StyleDistanceResponse,
  type StyleFeatures,
  type Venue,
  type VersionOrigin,
  type Claim,
  type FigureEntry,
  derivedRelations,
  echoCheck,
  extractTitle,
  figurePlan,
  orderUnits,
  projectFileOrder,
  submissionCheck,
  terminologyReport,
  unitsWithText,
  type CompileError,
  type ConsistencyUnit,
  type EchoReport,
  type FigurePlanReport,
  type ProjectFileEntry,
  type RestoreResponse,
  type SubmissionReport,
  type TerminologyReport,
} from '@paper-copilot/core';
import mainTex from '../../../../fixtures/canto-demo/tex/main.tex?raw';
import claimJson from '../../../../fixtures/canto-demo/repo/results/addendum_g_g1_v1_claim.json?raw';
import refsBib from '../../../../fixtures/canto-demo/tex/refs.bib?raw';
import type { ApiClient, ServerMessageOf } from '../contracts';
import { ApiError, errorText } from './errors';
import type { ApiClientExtras } from './extras';
import {
  buildClaimFacts,
  buildClaims,
  buildLitFromBib,
  cjkLines,
  factBySuffix,
  figuresFromSource,
  outlineWithSections,
  sectionsFromSource,
  sha256Hex,
  unifiedDiff,
  type SectionHead,
} from './mockData';
import {
  SIM_MODEL,
  draftSeeds,
  factWords,
  ghostCandidates,
  simTag,
  simulatedAlternatives,
  simulatedFramings,
  simulatedGrammar,
  simulatedIntent,
  simulatedReferee,
  simulatedRewrite,
  type Rewrite,
} from './mockAi';
import { DEMO_PDF_URL, demoForward, demoInverse, demoSynctexAvailable } from './mockPdf';

export const MOCK_ARTIFACT = 'results/addendum_g_g1_v1_claim.json';
export const MOCK_FILE = 'main.tex';

export interface MockOptions {
  tex?: string;
  /** Multi-file project: file -> text (overrides `tex`/`file`); `mainFile` names the root. */
  files?: Record<string, string>;
  mainFile?: string;
  projectName?: string;
  /** Repository path of the claim JSON (default MOCK_ARTIFACT). */
  claimArtifact?: string;
  /** Extra facts beside the claim JSON's (the large fixture's results/*.json, *.csv). */
  extraFacts?: (sha: (raw: string) => Promise<string>) => Promise<Fact[]>;
  claimJson?: string;
  bib?: string;
  file?: string;
  /** Delivery delay of server messages (ms). */
  latencyMs?: number;
  /** Delay of REST answers (ms). */
  restLatencyMs?: number;
  /** Re-segmentation debounce after unannotated typing (ms); the server uses 300. */
  debounceMs?: number;
  ghostDelayMs?: number;
  jobStepMs?: number;
  notesLanguage?: NotesLanguage;
  log?: (msg: string, data?: unknown) => void;
  /** The example PDF a compile shows (default: the canto-demo one when the fixture text is the default). */
  demoPdf?: DemoPdf | null;
}

/** An example PDF for the demo's "compile", with approximate SyncTeX over the current text. */
export interface DemoPdf {
  url: string;
  forward(text: string, line: number): { page: number; x: number; y: number; w: number; h: number } | null;
  inverse(text: string, page: number, x: number, y: number): number | null;
}

export const CANTO_DEMO_PDF: DemoPdf = {
  url: DEMO_PDF_URL,
  forward: (text, line) => (demoSynctexAvailable() ? demoForward(text, line) : null),
  inverse: (text, page, x, y) => (demoSynctexAvailable() ? demoInverse(text, page, x, y) : null),
};

/** The log line of a demo compile (the PDF pane and the compile pill say the same in the UI language). */
export const DEMO_PDF_NOTE = 'Example PDF: the browser demo has no LaTeX, so this PDF does not follow your edits. `pnpm paper open` compiles for real.';

type Range = { from: number; to: number };

/** One mirrored .tex file of the demo project. */
interface MockDoc {
  file: string;
  text: string;
  /** Text at the last (simulated) sync: the push diff is against this. */
  baseText: string;
  version: number;
  units: SentenceUnit[];
  intentLines: IntentLineInfo[];
  labels: string[];
  dirty: Range[];
  pendingAnn: { annotation: ChangeAnnotation; range: Range } | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

function newDoc(file: string, text: string): MockDoc {
  return { file, text, baseText: text, version: 0, units: [], intentLines: [], labels: [], dirty: [], pendingAnn: null, debounceTimer: null };
}
type AnyListener = (msg: ServerMessage) => void;

const IMPORT_ANNOTATION: ChangeAnnotation = {
  origin: 'import',
  sentenceIds: [],
  state: 'human',
  model: null,
  promptHash: null,
  instruction: null,
  lang: null,
  intentNote: null,
  factIds: [],
  citeKeys: [],
  move: null,
  requestId: null,
};

const AI_ORIGINS_SET = new Set<VersionOrigin>(['ai_ghost', 'ai_intent', 'ai_draft', 'ai_rewrite', 'grammar_fix', 'replan']);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function zeroCost(): CostTotals {
  return { usd: 0, byRoute: {}, byModel: {}, requests: 0, cacheReadTokens: 0, inputTokens: 0, outputTokens: 0 };
}

/** Text of a sentence suitable inside `[claim: ...?]`: no cite/label commands, no brackets, one line. */
function claimContent(latex: string): string {
  const t = latex
    .replace(/~?\\(?:cite[a-z]*|label)\s*(?:\[[^\]]*\])?\{[^}]*\}/g, '')
    .replace(/[[\]]/g, (c) => (c === '[' ? '(' : ')'))
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.?!]+$/, '');
  return t.length > 150 ? `${t.slice(0, 149).trimEnd()}…` : t;
}

export class MockApiClient implements ApiClient, ApiClientExtras {
  readonly isMock = true;
  /** Messages the mock produced that failed the core ServerMessage schema (tests assert this stays empty). */
  readonly invalidMessages: Array<{ msg: unknown; issues: unknown }> = [];

  private readonly claimRaw: string;
  private readonly bibRaw: string;
  private readonly latency: number;
  private readonly restLatency: number;
  private readonly debounceMs: number;
  private readonly ghostDelay: number;
  private readonly jobStep: number;
  private readonly notesLanguage: NotesLanguage;
  private readonly log: (msg: string, data?: unknown) => void;
  private readonly extraFacts: MockOptions['extraFacts'];
  private readonly claimArtifact: string;

  private _connected = false;
  private initPromise: Promise<void> | null = null;
  private readonly listeners = new Map<string, Set<AnyListener>>();
  private readonly connListeners = new Set<(c: boolean) => void>();
  private readonly coreFailures = new Set<string>();

  /** Every .tex file of the demo project (main first, then the files it inputs). */
  private readonly docs = new Map<string, MockDoc>();
  private readonly mainFile: string;
  /** The document the current call works on (selected per message / per sentence). */
  private cur!: MockDoc;
  private readonly projectName: string;
  private readonly versions = new Map<string, SentenceVersion[]>();
  private readonly pendingDrafts = new Map<string, DraftSentence>();
  private readonly ghostTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private factsState: Fact[] = [];
  private factSha = '';
  private lit: LitRecord[] = [];
  private claims: Claim[] = [];
  private figures: FigureEntry[] = [];
  private outlineState: Outline = outlineWithSections([]);
  private questionsState: RefereeQuestion[] = [];
  private memo = '';
  private corpus: CorpusEntry[] = [];
  private editPairs: EditPair[] = [];
  private costTotals: CostTotals = zeroCost();
  private lastCompile: { state: 'idle' | 'running' | 'ok' | 'error'; errors: CompileError[] } | null = null;
  /** The example PDF (null: this fixture has none) and the version of the last "compile" that showed it. */
  private readonly demoPdf: DemoPdf | null;
  private pdfVersion: number | null = null;
  private jobSeq = 0;

  constructor(opts: MockOptions = {}) {
    const files: Record<string, string> = opts.files ?? { [opts.file ?? MOCK_FILE]: opts.tex ?? mainTex };
    this.mainFile = opts.mainFile ?? opts.file ?? Object.keys(files)[0] ?? MOCK_FILE;
    for (const [file, text] of Object.entries(files)) this.docs.set(file, newDoc(file, text));
    if (!this.docs.has(this.mainFile)) this.docs.set(this.mainFile, newDoc(this.mainFile, ''));
    this.cur = this.docs.get(this.mainFile)!;
    this.projectName = opts.projectName ?? 'canto-demo';
    this.claimRaw = opts.claimJson ?? claimJson;
    this.bibRaw = opts.bib ?? refsBib;
    this.latency = opts.latencyMs ?? 12;
    this.restLatency = opts.restLatencyMs ?? 60;
    this.debounceMs = opts.debounceMs ?? 300;
    this.ghostDelay = opts.ghostDelayMs ?? 380;
    this.jobStep = opts.jobStepMs ?? 450;
    this.notesLanguage = opts.notesLanguage ?? 'zh';
    this.extraFacts = opts.extraFacts;
    this.claimArtifact = opts.claimArtifact ?? MOCK_ARTIFACT;
    // the example PDF belongs to the canto-demo fixture text only
    this.demoPdf = opts.demoPdf !== undefined ? opts.demoPdf : opts.files || opts.tex !== undefined ? null : CANTO_DEMO_PDF;
    this.log = opts.log ?? ((msg, data) => console.warn(`[mock] ${msg}`, data ?? ''));
  }

  /* The current document's state (this.text, this.units ... read and write `cur`). */
  private get file(): string {
    return this.cur.file;
  }
  private get text(): string {
    return this.cur.text;
  }
  private set text(v: string) {
    this.cur.text = v;
  }
  private get baseText(): string {
    return this.cur.baseText;
  }
  private set baseText(v: string) {
    this.cur.baseText = v;
  }
  private get version(): number {
    return this.cur.version;
  }
  private set version(v: number) {
    this.cur.version = v;
  }
  private get units(): SentenceUnit[] {
    return this.cur.units;
  }
  private set units(v: SentenceUnit[]) {
    this.cur.units = v;
  }
  private get intentLines(): IntentLineInfo[] {
    return this.cur.intentLines;
  }
  private set intentLines(v: IntentLineInfo[]) {
    this.cur.intentLines = v;
  }
  private get labels(): string[] {
    return this.cur.labels;
  }
  private set labels(v: string[]) {
    this.cur.labels = v;
  }
  private get dirty(): Range[] {
    return this.cur.dirty;
  }
  private set dirty(v: Range[]) {
    this.cur.dirty = v;
  }
  private get pendingAnn(): { annotation: ChangeAnnotation; range: Range } | null {
    return this.cur.pendingAnn;
  }
  private set pendingAnn(v: { annotation: ChangeAnnotation; range: Range } | null) {
    this.cur.pendingAnn = v;
  }
  private get debounceTimer(): ReturnType<typeof setTimeout> | null {
    return this.cur.debounceTimer;
  }
  private set debounceTimer(v: ReturnType<typeof setTimeout> | null) {
    this.cur.debounceTimer = v;
  }

  /** Make `file` the current document; false when the demo has no such file. */
  private select(file: string): boolean {
    const d = this.docs.get(file);
    if (!d) return false;
    this.cur = d;
    return true;
  }

  /** Select the document that holds sentence `id` (404 when none does). */
  private selectUnit(id: string): SentenceUnit {
    for (const d of this.docs.values()) {
      const u = d.units.find((x) => x.id === id);
      if (u) {
        this.cur = d;
        return u;
      }
    }
    throw new ApiError('No such sentence (it may have been edited away).', 404);
  }

  /** All documents in project order (main first). */
  private allDocs(): MockDoc[] {
    const main = this.docs.get(this.mainFile);
    return [...(main ? [main] : []), ...[...this.docs.values()].filter((d) => d !== main)];
  }

  /** Run `fn` with `doc` selected, then restore the previous selection. */
  private withDoc<T>(doc: MockDoc, fn: () => T): T {
    const prev = this.cur;
    this.cur = doc;
    try {
      return fn();
    } finally {
      this.cur = prev;
    }
  }

  /* ---------------------------------------------------------------------------------- */
  /* Connection and messages                                                            */
  /* ---------------------------------------------------------------------------------- */

  get connected(): boolean {
    return this._connected;
  }

  async ready(): Promise<void> {
    await this.init();
    if (this._connected) return;
    this._connected = true;
    for (const fn of [...this.connListeners]) fn(true);
    this.emit(this.welcome());
  }

  on<T extends ServerMessage['type']>(type: T, fn: (msg: ServerMessageOf<T>) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const l = fn as unknown as AnyListener;
    set.add(l);
    return () => {
      set.delete(l);
    };
  }

  onConnection(fn: (connected: boolean) => void): () => void {
    this.connListeners.add(fn);
    return () => {
      this.connListeners.delete(fn);
    };
  }

  send(msg: ClientMessage): void {
    void this.init().then(() => this.handleClient(msg));
  }

  /** Stop timers (tests). */
  dispose(): void {
    for (const d of this.docs.values()) if (d.debounceTimer) clearTimeout(d.debounceTimer);
    for (const t of this.ghostTimers.values()) clearTimeout(t);
    this.ghostTimers.clear();
    this.listeners.clear();
  }

  private emit(msg: ServerMessage, delay = this.latency): void {
    const check = ServerMessage.safeParse(msg);
    if (!check.success) {
      // The real client drops invalid frames; so does the mock (and it records them).
      this.invalidMessages.push({ msg, issues: check.error.issues });
      this.log(`invalid ${msg.type} message dropped`, check.error.issues.slice(0, 3));
      return;
    }
    setTimeout(() => {
      const set = this.listeners.get(msg.type);
      if (!set) return;
      for (const fn of [...set]) {
        try {
          fn(msg);
        } catch (e) {
          this.log(`listener for ${msg.type} failed`, e);
        }
      }
    }, delay);
  }

  private notice(level: 'info' | 'warn' | 'error', message: string): void {
    this.emit({ type: 'notice', level, message });
  }

  /** Run a core function; on failure (e.g. a module still being implemented) log once and degrade. */
  private core<T>(name: string, fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (e) {
      if (!this.coreFailures.has(name)) {
        this.coreFailures.add(name);
        this.log(`core ${name} failed`, e);
        if (this.coreFailures.size === 1) this.notice('warn', `Demo: core ${name} is unavailable (${errorText(e)}); the demo continues without it.`);
      }
      return fallback;
    }
  }

  private handleClient(raw: ClientMessage): void {
    const parsed = ClientMessage.safeParse(raw);
    if (!parsed.success) {
      this.notice('error', `The demo server rejected a malformed ${String((raw as { type?: unknown }).type)} message.`);
      return;
    }
    const msg = parsed.data;
    switch (msg.type) {
      case 'hello':
        this.emit(this.welcome());
        return;
      case 'doc.open':
        if (!this.select(msg.file)) {
          this.notice('error', `No such file in the demo: ${msg.file}`);
          return;
        }
        this.emit(this.snapshot());
        this.emitLint();
        return;
      case 'doc.change':
        if (!this.select(msg.file)) {
          this.notice('error', `No such file in the demo: ${msg.file}`);
          return;
        }
        this.applyChange(msg);
        return;
      case 'doc.flush':
        for (const d of this.docs.values()) this.withDoc(d, () => this.flushPending());
        return;
      case 'ghost.request':
        this.ghostRequest(msg);
        return;
      case 'ghost.cancel': {
        const t = this.ghostTimers.get(msg.requestId);
        if (t) clearTimeout(t);
        this.ghostTimers.delete(msg.requestId);
        return;
      }
      case 'ghost.feedback':
        return;
    }
  }

  /* ---------------------------------------------------------------------------------- */
  /* Document mirror                                                                    */
  /* ---------------------------------------------------------------------------------- */

  private init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        this.factSha = await sha256Hex(this.claimRaw);
        this.factsState = await this.buildFacts();
        this.lit = buildLitFromBib(this.bibRaw);
        for (const d of this.allDocs()) this.withDoc(d, () => this.importDocument());
        this.claims = buildClaims(this.claimRaw, this.factsState);
        this.figures = this.allDocs().flatMap((d) => figuresFromSource(d.text, this.claims.map((c) => c.claimId)));
        this.outlineState = outlineWithSections(this.sectionHeads());
      })();
    }
    return this.initPromise;
  }

  private async buildFacts(): Promise<Fact[]> {
    const claim = buildClaimFacts(this.claimRaw, this.claimArtifact, this.factSha);
    if (!this.extraFacts) return claim;
    const extra = await this.extraFacts(sha256Hex);
    const seen = new Set(claim.map((f) => f.id));
    return [...claim, ...extra.filter((f) => !seen.has(f.id))];
  }

  private segmentNow(): Segmentation | null {
    return this.core('segment', () => segment(this.text), null);
  }

  private importDocument(): void {
    const seg = this.segmentNow();
    this.intentLines = this.core('findIntentLines', () => findIntentLines(this.text), []);
    if (!seg) return;
    this.labels = seg.labels;
    const res = this.core(
      'assignUnits',
      () =>
        assignUnits({
          file: this.file,
          text: this.text,
          seg,
          prev: [],
          lastVersion: () => undefined,
          lastAiVersion: () => undefined,
          changeSource: 'external',
          annotation: IMPORT_ANNOTATION,
          annotatedRange: { from: 0, to: this.text.length },
          now: nowIso(),
        }),
      null,
    );
    if (!res) return;
    this.units = res.units.map((u) => this.withLinkedFacts(u, []));
    this.appendVersions(res.versions);
  }

  private sectionHeads(): SectionHead[] {
    const heads: SectionHead[] = [];
    for (const d of this.allDocs()) for (const h of this.withDoc(d, () => this.docSectionHeads())) if (!heads.some((x) => x.id === h.id)) heads.push(h);
    return heads;
  }

  private docSectionHeads(): SectionHead[] {
    const seg = this.segmentNow();
    if (seg && seg.sections.length) {
      const heads: SectionHead[] = [];
      for (const s of seg.sections) if (s.level <= 1 && !heads.some((h) => h.id === s.id)) heads.push({ id: s.id, title: s.title });
      if (!heads.some((h) => h.id === 'abstract') && seg.sentences.some((s) => s.sectionId === 'abstract')) heads.unshift({ id: 'abstract', title: 'Abstract' });
      return heads;
    }
    return this.text.includes('\\section') || this.text.includes('\\begin{abstract}') ? sectionsFromSource(this.text) : [];
  }

  private appendVersions(rows: SentenceVersion[]): void {
    for (const v of rows) {
      const list = this.versions.get(v.sentenceId) ?? [];
      list.push(v);
      this.versions.set(v.sentenceId, list);
    }
  }

  private lastVersion(id: string): SentenceVersion | undefined {
    const l = this.versions.get(id);
    return l ? l[l.length - 1] : undefined;
  }

  private lastAiVersion(id: string): SentenceVersion | undefined {
    const l = this.versions.get(id) ?? [];
    for (let i = l.length - 1; i >= 0; i--) {
      const v = l[i]!;
      if (['ai_ghost', 'ai_intent', 'ai_draft', 'ai_rewrite', 'replan'].includes(v.origin)) return v;
    }
    return undefined;
  }

  private unitText(u: SentenceUnit): string {
    return this.text.slice(u.start, u.end);
  }

  private promptFacts(): Fact[] {
    return this.factsState.filter((f) => !f.excluded);
  }

  private withLinkedFacts(u: SentenceUnit, extra: string[]): SentenceUnit {
    const text = this.unitText(u);
    const linked = this.core('linkSentenceFacts', () => linkSentenceFacts(text, this.promptFacts(), uniq([...extra, ...u.facts])).linked, [] as string[]);
    const facts = uniq([...extra, ...linked]);
    return sameList(facts, u.facts) ? u : { ...u, facts };
  }

  private snapshot(): ServerMessageOf<'doc.snapshot'> {
    return { type: 'doc.snapshot', file: this.file, version: this.version, text: this.text, units: this.units, intentLines: this.intentLines };
  }

  private welcome(): ServerMessageOf<'welcome'> {
    return { type: 'welcome', serverVersion: 'mock-0.1.0', fakeLlm: true, project: this.config() };
  }

  private applyChange(msg: Extract<ClientMessage, { type: 'doc.change' }>): void {
    if (msg.baseVersion !== this.version) {
      // Same as the server: reject and send a fresh snapshot.
      this.flushPending();
      this.emit(this.snapshot());
      return;
    }
    let cs: ChangeSet;
    try {
      cs = ChangeSet.fromJSON(msg.changes);
    } catch (e) {
      this.notice('error', `The demo server could not read a change: ${errorText(e)}`);
      this.emit(this.snapshot());
      return;
    }
    if (cs.length !== this.text.length) {
      this.flushPending();
      this.emit(this.snapshot());
      return;
    }
    const next = cs.apply(Text.of(this.text.split('\n'))).toString();
    this.units = this.core('mapUnits', () => mapUnits(this.units, cs, next), this.units);
    this.dirty = this.dirty.map((r) => ({ from: cs.mapPos(r.from, -1), to: cs.mapPos(r.to, 1) }));
    const touched = this.core('changedRanges', () => changedRanges(cs), [] as Range[]);
    this.dirty.push(...touched);
    if (this.pendingAnn) {
      const r = this.pendingAnn.range;
      this.pendingAnn = { ...this.pendingAnn, range: { from: cs.mapPos(r.from, -1), to: cs.mapPos(r.to, 1) } };
    }
    if (msg.annotation) {
      const from = touched.length ? Math.min(...touched.map((r) => r.from)) : 0;
      const to = touched.length ? Math.max(...touched.map((r) => r.to)) : 0;
      this.pendingAnn = { annotation: msg.annotation, range: { from, to } };
    }
    this.text = next;
    this.version += 1;
    this.emit({ type: 'doc.ack', file: this.file, version: this.version });
    if (msg.annotation) {
      this.resegment();
    } else {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      const doc = this.cur;
      this.debounceTimer = setTimeout(() => this.withDoc(doc, () => this.resegment()), this.debounceMs);
    }
  }

  private flushPending(): void {
    if (this.debounceTimer || this.dirty.length || this.pendingAnn) this.resegment();
  }

  private resegment(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    const ann = this.pendingAnn;
    const dirty = this.dirty;
    this.pendingAnn = null;
    this.dirty = [];
    this.intentLines = this.core('findIntentLines', () => findIntentLines(this.text), this.intentLines);
    const seg = this.segmentNow();
    const res = seg
      ? this.core(
          'assignUnits',
          () =>
            assignUnits({
              file: this.file,
              text: this.text,
              seg,
              prev: this.units,
              lastVersion: (id) => this.lastVersion(id),
              lastAiVersion: (id) => this.lastAiVersion(id),
              dirty,
              changeSource: 'local',
              annotation: ann?.annotation ?? null,
              annotatedRange: ann?.range ?? null,
              now: nowIso(),
            }),
          null,
        )
      : null;
    if (!seg || !res) {
      this.emit({ type: 'sentences.patch', file: this.file, version: this.version, upserts: [], removed: [], intentLines: this.intentLines });
      return;
    }
    this.labels = seg.labels;
    const changed = new Map<string, SentenceUnit>();
    for (const u of res.upserts) changed.set(u.id, u);
    for (const [id, u0] of changed) {
      let u = u0;
      // The annotation's facts belong to the units it wrote, not to neighbours re-hashed by the change.
      const inAnn = !!ann && u.start < Math.max(ann.range.to, ann.range.from + 1) && u.end > ann.range.from;
      let extra = inAnn ? (ann?.annotation.factIds ?? []) : [];
      if (ann?.annotation.origin === 'ai_draft') {
        const key = this.unitText(u).trim();
        const d = this.pendingDrafts.get(key);
        if (d) {
          this.pendingDrafts.delete(key);
          extra = d.factIds;
          u = {
            ...u,
            state: d.state === 'unsupported' ? 'unsupported' : u.state,
            cites: d.citeKeys.length ? uniq([...u.cites, ...d.citeKeys]) : u.cites,
            move: d.move ?? u.move,
          };
        }
      }
      changed.set(id, this.withLinkedFacts(u, extra));
    }
    this.units = res.units.map((u) => changed.get(u.id) ?? u);
    const upserts = res.upserts.map((u) => changed.get(u.id) ?? u);
    this.appendVersions(res.versions);
    this.editPairs.push(...res.editPairs);
    this.emit({ type: 'sentences.patch', file: this.file, version: this.version, upserts, removed: res.removed, intentLines: this.intentLines });
    this.emitLint();
  }

  /* ---------------------------------------------------------------------------------- */
  /* Lint (the server runs the skill's style_check in a sidecar; the demo uses core only) */
  /* ---------------------------------------------------------------------------------- */

  private readonly dismissedLint = new Set<string>();

  private lintFlags(): LintFlag[] {
    const flags: LintFlag[] = [];
    const mk = (u: SentenceUnit, text: string, check: string, source: LintFlag['source'], msg: string, word: string | null, severity: LintFlag['severity']): LintFlag => ({
      id: hashString(source + check + u.id + (word ?? '') + msg),
      sentenceId: u.id,
      check,
      source,
      msg,
      word,
      line: u.line,
      excerpt: text.slice(0, 120),
      corpusRate: null,
      userRate: null,
      severity,
      dismissed: this.dismissedLint.has(hashString(source + check + u.id + (word ?? '') + msg)),
    });
    const facts = this.promptFacts();
    for (const u of this.units) {
      const text = this.unitText(u);
      const plain = this.core('plainText', () => plainText(text), text);
      const words = this.core('wordTokens', () => wordTokens(plain), plain.split(/\s+/).filter(Boolean));
      if (u.kind === 'prose' && words.length > 40) {
        flags.push(mk(u, text, 'long', 'heuristic', `${words.length} words; the skill's corpus median is 23 and about 11% of its sentences exceed 40.`, null, 'hint'));
      }
      for (const f of this.core('aieseFlags', () => aieseFlags(plain), [])) {
        const msg = f.kind === 'excess_vocab' ? `"${f.word}" is on the excess-vocabulary list${f.ratio ? ` (excess ratio ${f.ratio})` : ''} (Kobak et al. 2025)` : `${f.label} (heuristic, no measured rate)`;
        flags.push(mk(u, text, f.kind, 'aiese', msg, f.word, 'hint'));
      }
      const link = this.core('linkSentenceFacts', () => linkSentenceFacts(text, facts, u.facts), null);
      for (const tok of link?.unmatched ?? []) flags.push(mk(u, text, 'unmatched_number', 'gate', `"${tok.raw}" matches no fact in the fact store`, tok.raw, 'warn'));
    }
    return flags;
  }

  private emitLint(): void {
    this.emit({ type: 'lint.update', file: this.file, version: this.version, flags: this.lintFlags(), scope: 'document', sentenceIds: this.units.map((u) => u.id) });
  }

  /* ---------------------------------------------------------------------------------- */
  /* Simulated AI                                                                       */
  /* ---------------------------------------------------------------------------------- */

  private gate(text: string, mode: GateMode, extra: Partial<GateContext> = {}): GateResult | null {
    return this.core(
      'gateSentence',
      () =>
        gateSentence(text, {
          mode,
          facts: this.promptFacts(),
          allowedCiteKeys: this.lit.map((l) => l.key),
          knownLabels: this.labels,
          fictionalNumbers: [],
          maxWords: null,
          ...extra,
        }),
      null,
    );
  }

  private countRequest(route: string): void {
    const t = this.costTotals;
    this.costTotals = {
      ...t,
      requests: t.requests + 1,
      byRoute: { ...t.byRoute, [route]: t.byRoute[route] ?? 0 },
      byModel: { ...t.byModel, [SIM_MODEL]: 0 },
    };
    this.emit({ type: 'cost.update', totals: this.costTotals });
  }

  private ghostRequest(msg: Extract<ClientMessage, { type: 'ghost.request' }>): void {
    const old = this.ghostTimers.get(msg.requestId);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      this.ghostTimers.delete(msg.requestId);
      if (!this.select(msg.file)) {
        this.emit({ type: 'ghost.error', requestId: msg.requestId, message: `No such file: ${msg.file}` });
        return;
      }
      const charBefore = msg.version === this.version && msg.cursor > 0 ? this.text.charAt(msg.cursor - 1) : '';
      const needsSpace = msg.prefix.length > 0 ? !/\s$/.test(msg.prefix) : charBefore !== '' && !/\s/.test(charBefore);
      const words = factWords(this.promptFacts());
      this.countRequest('ghost');
      for (const cont of ghostCandidates(msg.prefix, words, needsSpace)) {
        const g = this.gate(msg.prefix + cont, 'ghost', { maxWords: 35 });
        if (g && !g.ok) continue;
        this.emit({
          type: 'ghost.result',
          requestId: msg.requestId,
          version: msg.version,
          cursor: msg.cursor,
          text: cont,
          factIds: g?.factIds ?? Object.values(words.ids),
          citeKeys: g?.citeKeys ?? [],
          fulfilledMoveIds: [],
          issues: g ? g.issues : [{ code: 'gate_unavailable', severity: 'warn', message: 'The faithfulness gate is not available in this build.' }],
          model: SIM_MODEL,
          promptHash: hashString(`ghost|${msg.prefix}|${cont}`),
        });
        return;
      }
      this.emit({ type: 'ghost.empty', requestId: msg.requestId, reason: `no grounded suggestion ${simTag(this.notesLanguage)}` });
    }, this.ghostDelay);
    this.ghostTimers.set(msg.requestId, timer);
  }

  private notes(r: Rewrite, kind: 'rewrite' | 'grammar' | 'alternative' | 'intent', instruction: string | null): string {
    const zh = this.notesLanguage === 'zh';
    const tag = simTag(this.notesLanguage);
    if (kind === 'intent') {
      return zh ? `${tag}没有调用模型：这是根据你的意图笔记生成的示例句子，数字来自事实库。` : `${tag} No model was called: an example sentence rendered from your intent note; its numbers come from the fact store.`;
    }
    const what = zh ? r.zh : r.en;
    if (kind === 'grammar') {
      return zh ? `${tag}只改语法：${what || '没有发现语法问题'}。` : `${tag} Grammar only: ${what || 'no grammar issues found'}.`;
    }
    const instr = instruction ? (zh ? `指令“${instruction}”。` : `Instruction: "${instruction}". `) : '';
    if (!what) return zh ? `${tag}${instr}没有调用模型，这句话不需要改动。` : `${tag} ${instr}No model was called; this sentence needs no change.`;
    return zh ? `${tag}${instr}没有调用模型。示例改写：${what}。数字、引用和数学式保持不变。` : `${tag} ${instr}No model was called. Example rewrite: ${what}. Numbers, citations and math are unchanged.`;
  }

  private proposal(sentenceId: string | null, original: string, r: Rewrite, origin: VersionOrigin, mode: GateMode, kind: 'rewrite' | 'grammar' | 'alternative' | 'intent', instruction: string | null): Proposal {
    const g = this.gate(r.text, mode, mode === 'rewrite' || mode === 'grammar' ? { original } : mode === 'intent' ? { intentText: instruction } : {});
    const fallbackDiff: Array<[number, string]> = original === r.text ? [[0, original]] : original ? [[-1, original], [1, r.text]] : [[1, r.text]];
    const diff = this.core('wordDiff', () => wordDiff(original, r.text), fallbackDiff);
    return {
      proposalId: shortId('prop-'),
      sentenceId,
      text: r.text,
      diff,
      notes: this.notes(r, kind, instruction),
      drift: kind === 'rewrite' || kind === 'alternative' ? { actor: false, scope: false, direction: false, condition: false } : null,
      issues: g?.issues ?? [],
      factIds: g?.factIds ?? [],
      citeKeys: g?.citeKeys ?? [],
      origin,
      model: SIM_MODEL,
      promptHash: hashString(`${origin}|${original}|${instruction ?? ''}|${r.text}`),
    };
  }

  private unitOr404(id: string): SentenceUnit {
    return this.selectUnit(id);
  }

  private async rest(): Promise<void> {
    await this.init();
    await sleep(this.restLatency);
  }

  /* ---------------------------------------------------------------------------------- */
  /* Jobs                                                                               */
  /* ---------------------------------------------------------------------------------- */

  private startJob(kind: JobKind, run: (progress: (message: string) => void) => Promise<unknown>): string {
    const jobId = `job-demo-${++this.jobSeq}`;
    this.emit({ type: 'job.progress', jobId, kind, state: 'queued', message: 'queued' });
    setTimeout(() => {
      this.emit({ type: 'job.progress', jobId, kind, state: 'running', message: 'running' });
      run((message) => this.emit({ type: 'job.progress', jobId, kind, state: 'running', message })).then(
        (result) => this.emit({ type: 'job.progress', jobId, kind, state: 'done', message: 'done', result }),
        (e: unknown) => this.emit({ type: 'job.progress', jobId, kind, state: 'error', message: errorText(e) }),
      );
    }, Math.round(this.jobStep / 3));
    return jobId;
  }

  private sim(en: string, zh: string): string {
    return this.notesLanguage === 'zh' ? `${zh}${simTag('zh')}` : `${en} ${simTag('en')}`;
  }

  /* ---------------------------------------------------------------------------------- */
  /* ApiClient REST                                                                     */
  /* ---------------------------------------------------------------------------------- */

  private config(): ProjectConfig {
    return {
      schemaVersion: 1,
      name: this.projectName,
      texRoot: `/demo/${this.projectName}/tex`,
      mainFile: this.mainFile,
      repoDir: `/demo/${this.projectName}/repo`,
      skillDir: '/demo/hep-paper-writing',
      bibFiles: ['refs.bib'],
      venue: 'aps',
      notesLanguage: this.notesLanguage,
      factGlobs: ['results/**/*.json', 'results/**/*.csv', 'docs/definitions.md'],
      readerGlobs: ['README.md', 'docs/**/*.md', 'results/**/*.{json,csv,md}'],
      models: { ...DEFAULT_MODEL_ROUTES },
      sync: { mode: 'git', remote: 'overleaf (simulated)', branch: 'master' },
      maxBudgetUsd: 5,
      semanticLines: true,
    };
  }

  async project(): Promise<ProjectInfo> {
    await this.rest();
    return {
      config: this.config(),
      files: this.allDocs().map((d) => d.file),
      fakeLlm: true,
      skill: {
        found: true,
        dir: '/demo/hep-paper-writing',
        version: 'demo',
        references: ['story-and-structure.md', 'layering-and-flow.md', 'sentences-and-words.md', 'figures-and-evidence.md'],
      },
      stats: {
        units: this.allUnits().length,
        proposed: this.allUnits().filter((u) => u.state === 'proposed').length,
        facts: this.factsState.length,
        placeholders: this.allUnits().reduce((n, u) => n + u.placeholders.length, 0),
      },
    };
  }

  /** Units of every file (main first). */
  private allUnits(): SentenceUnit[] {
    return this.allDocs().flatMap((d) => d.units);
  }

  private docText(file: string): string {
    return this.docs.get(file)?.text ?? '';
  }

  /** A unit's text in its own file. */
  private anyUnitText(u: SentenceUnit): string {
    return this.docText(u.file).slice(u.start, u.end);
  }

  private unresolved(): FactsResponse['unresolved'] {
    const facts = this.promptFacts();
    const out: FactsResponse['unresolved'] = [];
    for (const u of this.allUnits()) {
      const link = this.core('linkSentenceFacts', () => linkSentenceFacts(this.anyUnitText(u), facts, u.facts), null);
      if (!link) continue;
      for (const t of link.unmatched) out.push({ sentenceId: u.id, raw: t.raw, candidates: [] });
      for (const a of link.ambiguous) out.push({ sentenceId: u.id, raw: a.token.raw, candidates: a.candidates });
    }
    return out;
  }

  async facts(): Promise<FactsResponse> {
    await this.rest();
    return { facts: this.factsState.map((f) => ({ ...f })), unresolved: this.unresolved() };
  }

  async patchFact(id: string, patch: Partial<Pick<Fact, 'confirmed' | 'excluded' | 'definition' | 'unit' | 'sigfigs' | 'tags'>>): Promise<Fact> {
    await this.rest();
    const i = this.factsState.findIndex((f) => f.id === id);
    if (i < 0) throw new ApiError(`No such fact: ${id}`, 404);
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<Fact>;
    const next: Fact = { ...this.factsState[i]!, ...clean };
    this.factsState[i] = next;
    this.emit({ type: 'facts.updated', count: this.factsState.length, stale: [] });
    return { ...next };
  }

  async rescanFacts(): Promise<{ count: number; stale: string[] }> {
    await this.rest();
    await sleep(this.jobStep / 2);
    const prev = new Map(this.factsState.map((f) => [f.id, f]));
    const fresh = await this.buildFacts();
    const stale: string[] = [];
    this.factsState = fresh.map((f) => {
      const p = prev.get(f.id);
      if (!p) return f;
      if (p.fingerprint !== f.fingerprint) stale.push(f.id);
      return { ...f, confirmed: p.confirmed, excluded: p.excluded, definition: p.definition, tags: p.tags, stale: p.fingerprint !== f.fingerprint };
    });
    this.emit({ type: 'facts.updated', count: this.factsState.length, stale });
    return { count: this.factsState.length, stale };
  }

  async panels(): Promise<PanelsResponse> {
    await this.rest();
    return { claims: this.claims, figures: this.figures, terminology: [], lit: this.lit };
  }

  async outline(): Promise<Outline> {
    await this.rest();
    return structuredClone(this.outlineState);
  }

  async saveOutline(outline: Outline): Promise<Outline> {
    await this.rest();
    const parsed = Outline.safeParse(outline);
    if (!parsed.success) throw new ApiError(`Invalid outline: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`, 400);
    this.outlineState = structuredClone(parsed.data);
    return structuredClone(this.outlineState);
  }

  async history(sentenceId: string): Promise<HistoryResponse> {
    await this.rest();
    const unit = this.unitOr404(sentenceId);
    return { unit, versions: [...(this.versions.get(sentenceId) ?? [])] };
  }

  async instruct(sentenceId: string, instruction: string, _lang: string | null): Promise<Proposal> {
    await this.rest();
    const text = this.unitText(this.unitOr404(sentenceId));
    await sleep(this.jobStep);
    this.countRequest('actions');
    return this.proposal(sentenceId, text, simulatedRewrite(text, instruction), 'ai_rewrite', 'rewrite', 'rewrite', instruction);
  }

  async alternatives(sentenceId: string, n: number): Promise<Proposal[]> {
    await this.rest();
    const text = this.unitText(this.unitOr404(sentenceId));
    await sleep(this.jobStep);
    this.countRequest('actions');
    const alts = simulatedAlternatives(text, Math.max(1, Math.min(3, n)));
    const list = alts.length ? alts : [{ text, en: '', zh: '' }];
    return list.map((r) => this.proposal(sentenceId, text, r, 'ai_rewrite', 'rewrite', 'alternative', null));
  }

  async grammar(sentenceId: string): Promise<Proposal> {
    await this.rest();
    const text = this.unitText(this.unitOr404(sentenceId));
    await sleep(this.jobStep / 2);
    this.countRequest('actions');
    return this.proposal(sentenceId, text, simulatedGrammar(text), 'grammar_fix', 'grammar', 'grammar', null);
  }

  async accept(sentenceId: string): Promise<SentenceUnit> {
    await this.rest();
    const u = this.unitOr404(sentenceId);
    if (u.state !== 'proposed' && u.state !== 'unsupported') throw new ApiError(`Only proposed or unsupported sentences can be accepted (this one is ${u.state}).`, 409);
    const next: SentenceUnit = { ...u, state: 'ai-drafted', everAi: true, acceptedAt: nowIso() };
    this.units = this.units.map((x) => (x.id === u.id ? next : x));
    this.emit({ type: 'sentences.patch', file: this.file, version: this.version, upserts: [next], removed: [], intentLines: this.intentLines });
    return next;
  }

  async reject(sentenceId: string): Promise<{ replacement: string }> {
    await this.rest();
    const u = this.unitOr404(sentenceId);
    return { replacement: `[claim: ${claimContent(this.unitText(u))}?]` };
  }

  async renderIntent(_file: string, _line: number, text: string, n: number): Promise<Proposal[]> {
    await this.rest();
    await sleep(this.jobStep);
    this.countRequest('actions');
    const cands = simulatedIntent(text, factWords(this.promptFacts())).slice(0, Math.max(1, Math.min(3, n)));
    return cands.map((t) => this.proposal(null, '', { text: t, en: '', zh: '' }, 'ai_intent', 'intent', 'intent', text));
  }

  async readRepo(): Promise<{ jobId: string }> {
    await this.rest();
    const jobId = this.startJob('read-repo', async (progress) => {
      progress(this.sim('Reading README.md and docs/', '正在阅读 README.md 和 docs/'));
      await sleep(this.jobStep);
      progress(this.sim(`Reading ${this.claimArtifact}`, `正在读取 ${this.claimArtifact}`));
      await sleep(this.jobStep);
      const r = await this.rescanFacts();
      return { facts: r.count, candidates: 0 };
    });
    return { jobId };
  }

  async framings(): Promise<{ jobId: string }> {
    await this.rest();
    if (!this.outlineState.authorFilled) {
      throw new ApiError('Write the five items yourself and tick "I wrote these myself" first: the AI never proposes a framing before the author writes (anti-anchoring).', 409);
    }
    const jobId = this.startJob('outline-framings', async (progress) => {
      progress(this.sim('Proposing three framings', '正在提出三种叙述框架'));
      await sleep(this.jobStep * 2);
      this.countRequest('drafter');
      const texts = simulatedFramings(this.outlineState, factWords(this.promptFacts()));
      const o = structuredClone(this.outlineState);
      o.framings = [...o.framings.filter((f) => f.adopted), ...texts.map((text) => ({ id: shortId('fr-'), text, provenance: 'ai-proposed' as const, adopted: false }))];
      this.outlineState = o;
      this.emit({ type: 'plan.updated', outline: structuredClone(o) });
      return { count: texts.length };
    });
    return { jobId };
  }

  private sectionInsertOffset(sectionId: string): number {
    const t = this.text;
    let at = -1;
    if (sectionId === 'abstract') {
      const i = t.indexOf('\\begin{abstract}');
      if (i >= 0) at = t.indexOf('\n', i);
    } else {
      const s = this.segmentNow()?.sections.find((x) => x.id === sectionId);
      if (s) {
        at = t.indexOf('\n', s.start);
        if (at >= 0) {
          const m = /^[ \t]*\\label\{[^}]*\}[^\n]*/.exec(t.slice(at + 1));
          if (m) at = at + 1 + m[0].length;
        }
      }
    }
    if (at < 0) {
      const e = t.indexOf('\\end{document}');
      at = e >= 0 ? e : t.length;
    }
    return at;
  }

  async draft(req: { sectionId: string; paragraphIds: string[] | null; fromNotes: boolean; file: string; afterSentenceId: string | null }): Promise<{ jobId: string }> {
    await this.rest();
    // anti-anchoring, as for framings(): the AI drafts only after the author wrote the five items
    if (!this.outlineState.authorFilled) {
      throw new ApiError('Write the five items yourself and tick "I wrote these myself" first: the AI never drafts before the author writes (anti-anchoring).', 409);
    }
    const section = this.outlineState.sections.find((s) => s.id === req.sectionId);
    const title = section?.title ?? req.sectionId;
    const jobId = this.startJob('draft', async (progress) => {
      progress(this.sim(`Planning a paragraph for "${title}"`, `正在为“${title}”规划段落`));
      await sleep(this.jobStep);
      progress(this.sim('Drafting three sentences and checking every number', '正在起草三句话并核对每个数字'));
      await sleep(this.jobStep);
      this.countRequest('drafter');
      const w = factWords(this.promptFacts());
      const sentences: DraftSentence[] = draftSeeds(w).map((s) => {
        const g = this.gate(s.text, 'draft');
        const ok = g ? g.ok : !s.expectUnsupported;
        const text = ok ? s.text : g?.repaired ?? s.text.replace(/\d+(?:\.\d+)?\s*(points|mm)/g, '[fact?: $1 not in the fact store]');
        return {
          text,
          move: s.move,
          factIds: g?.factIds ?? s.factKeys.map((k) => w.ids[k]).filter((x): x is string => !!x),
          citeKeys: g?.citeKeys ?? [],
          placeholders: g?.placeholders ?? [],
          noteZh: s.noteZh,
          refereeQuestion: s.refereeQuestion,
          state: ok ? 'proposed' : 'unsupported',
          issues: g?.issues ?? (ok ? [] : [{ code: 'unmatched_number', severity: 'block', message: 'A number matches no fact.' }]),
        };
      });
      for (const s of sentences) this.pendingDrafts.set(s.text.trim(), s);
      // the file that holds the section (an \\input file of a multi-file project), else the requested one
      const home = this.allDocs().find((d) => d.units.some((u) => u.sectionId === req.sectionId)) ?? this.docs.get(req.file) ?? this.cur;
      this.cur = home;
      const inSection = this.units.filter((u) => u.sectionId === req.sectionId && u.kind === 'prose');
      const afterSentenceId = req.afterSentenceId ?? inSection[inSection.length - 1]?.id ?? null;
      const pid = (req.paragraphIds && section?.paragraphs.find((p) => req.paragraphIds?.includes(p.pid))?.pid) || `${req.sectionId}/draft-${this.jobSeq}`;
      const job = section?.paragraphs.find((p) => p.pid === pid)?.job || (this.notesLanguage === 'zh' ? '用数字和基线给出主要结果' : 'State the main result as a number against the baseline');
      this.emit({
        type: 'draft.proposed',
        jobId,
        file: this.file,
        afterSentenceId,
        insertAt: afterSentenceId ? null : this.sectionInsertOffset(req.sectionId),
        version: this.version,
        paragraphs: [{ pid, job, sentences }],
      });
      this.planAfterDraft(req.sectionId, pid, job, w);
      return { paragraphs: 1, sentences: sentences.length, unsupported: sentences.filter((s) => s.state === 'unsupported').length };
    });
    return { jobId };
  }

  private planAfterDraft(sectionId: string, pid: string, job: string, w: ReturnType<typeof factWords>): void {
    const o = structuredClone(this.outlineState);
    const s = o.sections.find((x) => x.id === sectionId);
    if (!s) return;
    const claimIds = this.claims.map((c) => c.claimId);
    let p = s.paragraphs.find((x) => x.pid === pid);
    if (!p) {
      p = { pid, job, moves: ['result', 'significance', 'mechanism'], claimIds, intentNotes: [], plan: { job, claimIds, said: {}, remaining: [] }, provenance: 'ai-proposed' };
      s.paragraphs.push(p);
    }
    const fakeIds = [w.ids.fake_rate_A, w.ids.fake_rate_B].filter((x): x is string => !!x);
    p.plan.remaining = [
      { id: shortId('step-'), intent: this.notesLanguage === 'zh' ? '给出假轨迹率并与基线比较' : 'State the fake-track rate against the baseline', factIds: fakeIds, citeKeys: [], move: 'result' },
      { id: shortId('step-'), intent: this.notesLanguage === 'zh' ? '说明主要局限，以及结果是否仍然成立' : 'Name the principal limitation and whether the result survives it', factIds: [], citeKeys: [], move: 'limitation' },
    ];
    this.outlineState = o;
    this.emit({ type: 'plan.updated', outline: structuredClone(o) });
  }

  async referee(sectionId: string): Promise<{ jobId: string }> {
    await this.rest();
    const section = this.outlineState.sections.find((s) => s.id === sectionId);
    const jobId = this.startJob('referee', async (progress) => {
      progress(this.sim(`Reading "${section?.title ?? sectionId}" as a referee`, `正在以审稿人的角度阅读“${section?.title ?? sectionId}”`));
      await sleep(this.jobStep * 2);
      this.countRequest('drafter');
      const first = this.allUnits().find((u) => u.sectionId === sectionId)?.id ?? null;
      const qs = simulatedReferee(sectionId, section?.title ?? sectionId, this.notesLanguage, factWords(this.promptFacts()), first)
        .slice(0, 4)
        .map((q) => ({ ...q, id: shortId('q-') }));
      this.questionsState = [...this.questionsState.filter((q) => q.sectionId !== sectionId), ...qs];
      return { count: qs.length };
    });
    return { jobId };
  }

  async questions(sectionId?: string): Promise<RefereeQuestion[]> {
    await this.rest();
    return this.questionsState.filter((q) => !sectionId || q.sectionId === sectionId);
  }

  /**
   * The demo has no LaTeX: a compile "succeeds" and shows the example PDF compiled from the fixture
   * (fixtures/canto-demo/demo, see mockPdf.ts). It does not follow the author's edits, and the log and the
   * PDF pane say so. A demo on another fixture (no example PDF) compiles without a PDF.
   */
  async compile(): Promise<void> {
    await this.rest();
    this.lastCompile = { state: 'ok', errors: [] };
    const prev = this.pdfVersion;
    this.emit({ type: 'compile.status', state: 'running', pdfVersion: prev, errors: [], logTail: '' });
    setTimeout(() => {
      if (this.demoPdf) this.pdfVersion = (this.pdfVersion ?? 0) + 1;
      this.emit({
        type: 'compile.status',
        state: 'ok',
        pdfVersion: this.pdfVersion,
        errors: [],
        logTail: this.demoPdf
          ? `${DEMO_PDF_NOTE}\nExample PDF: fixtures/canto-demo/demo/main.pdf (latexmk -pdf -synctex=1 on fixtures/canto-demo/tex/main.tex).`
          : 'Simulated compile: the browser demo has no LaTeX, so there is no PDF. Run `paper open` on your laptop for latexmk and SyncTeX.',
      });
    }, this.jobStep);
  }

  pdfUrl(_pdfVersion: number): string {
    return this.demoPdf ? this.demoPdf.url : 'about:blank';
  }

  /** Approximate: the example PDF is the fixture's, the line is matched by its text (mockPdf.ts). */
  async synctexForward(file: string, line: number): Promise<{ page: number; x: number; y: number; w: number; h: number } | null> {
    await this.rest();
    const d = this.docs.get(file);
    if (!this.demoPdf || this.pdfVersion === null || !d || file !== this.mainFile) return null;
    return this.demoPdf.forward(d.text, line);
  }

  async synctexInverse(page: number, x: number, y: number): Promise<{ file: string; line: number } | null> {
    await this.rest();
    const d = this.docs.get(this.mainFile);
    if (!this.demoPdf || this.pdfVersion === null || !d) return null;
    const line = this.demoPdf.inverse(d.text, page, x, y);
    return line === null ? null : { file: this.mainFile, line };
  }

  async pull(): Promise<ReanchorReport[]> {
    await this.rest();
    for (const d of this.docs.values()) this.withDoc(d, () => this.flushPending());
    await sleep(this.jobStep);
    this.notice('info', this.sim('Pulled: no co-author changes in the browser demo.', '已拉取：浏览器演示中没有合作者的修改。'));
    return this.allDocs().map((d) => ({ unchanged: d.units.length, edited: [], created: [], orphaned: [], split: [] }));
  }

  private computePushCheck(): PushCheck {
    const per = this.allDocs().map((d) => this.withDoc(d, () => this.docPushCheck()));
    const diff = per.map((p) => p.diff).filter(Boolean).join('');
    const blockers = per.flatMap((p) => p.blockers);
    return { ok: blockers.length === 0, blockers, diff, files: per.flatMap((p) => p.files) };
  }

  private docPushCheck(): PushCheck {
    this.flushPending();
    const blockers: PushCheck['blockers'] = [];
    for (const u of this.units) {
      if (u.state === 'proposed' || u.state === 'unsupported' || u.state === 'placeholder') {
        blockers.push({ kind: u.state, sentenceId: u.id, line: u.line, text: this.unitText(u).slice(0, 160) });
      } else if (u.placeholders.length) {
        blockers.push({ kind: 'placeholder', sentenceId: u.id, line: u.line, text: u.placeholders.join(' ') });
      }
    }
    const intentLineNos = new Set(this.intentLines.map((l) => l.line));
    for (const l of this.intentLines) blockers.push({ kind: 'intent_line', sentenceId: null, line: l.line, text: l.text.slice(0, 160) });
    for (const c of cjkLines(this.text)) if (!intentLineNos.has(c.line)) blockers.push({ kind: 'cjk', sentenceId: null, line: c.line, text: c.text.slice(0, 160) });
    const diff = unifiedDiff(this.baseText, this.text, this.file);
    return { ok: blockers.length === 0, blockers, diff, files: diff ? [this.file] : [] };
  }

  async pushCheck(): Promise<PushCheck> {
    await this.rest();
    return this.computePushCheck();
  }

  async push(message: string): Promise<{ ok: boolean; output: string; check: PushCheck }> {
    await this.rest();
    const check = this.computePushCheck();
    if (!check.ok) return { ok: false, output: `Push refused: ${check.blockers.length} blocker(s) remain.`, check };
    if (!check.diff) return { ok: true, output: 'Nothing to push: no changes since the last sync.', check };
    await sleep(this.jobStep);
    for (const d of this.docs.values()) d.baseText = d.text;
    return {
      ok: true,
      output: `(simulated) git commit -m ${JSON.stringify(message || 'Update')} && git push\nNothing left the browser: this is the demo.`,
      check: this.computePushCheck(),
    };
  }

  private allVersions(): SentenceVersion[] {
    return [...this.versions.values()].flat().sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }

  async disclosure(venue: Venue): Promise<DisclosureResponse> {
    await this.rest();
    try {
      const stats = computeDisclosureStats(this.allUnits(), this.allVersions());
      const d = renderDisclosure(venue, stats, { toolName: 'paper-copilot', toolVersion: '0.1.0 (browser demo, simulated AI)', recordPath: '.paper/history.jsonl' });
      return { venue, latex: d.latex, plain: d.plain, placement: d.placement, stats: stats as unknown as Record<string, unknown> };
    } catch (e) {
      throw new ApiError(`The disclosure generator is unavailable: ${errorText(e)}`, 501);
    }
  }

  private corpusSentences(): string[] {
    const out: string[] = [];
    for (const c of this.corpus) {
      if (!c.unassisted) continue;
      const seg = this.core('segment', () => segment(c.text), null);
      if (seg) for (const s of seg.sentences) out.push(this.core('plainText', () => plainText(s.text), s.text));
      else out.push(...c.text.split(/(?<=[.?!])\s+(?=[A-Z])/));
    }
    return out.filter((s) => s.trim());
  }

  async styleDistance(scope: 'document' | 'section' | 'paragraph', id?: string): Promise<StyleDistanceResponse> {
    await this.rest();
    try {
      const units = this.allUnits().filter((u) => u.kind === 'prose' && (scope === 'document' || !id || (scope === 'section' ? u.sectionId === id : u.paragraphId === id)));
      const sents = units.map((u) => ({ id: u.id, text: plainText(this.anyUnitText(u)) }));
      const features = styleFeatures(sents.map((s) => s.text));
      const own = this.corpusSentences();
      const authorFeatures: StyleFeatures | null = own.length ? styleFeatures(own) : null;
      const toCorpus = styleDistance(features, SKILL_CORPUS_NORMS).distance;
      const toAuthor = authorFeatures ? styleDistance(features, authorFeatures).distance : null;
      const furthest = furthestSentences(sents, authorFeatures ?? SKILL_CORPUS_NORMS, 3).map((f) => ({ sentenceId: f.id, contribution: f.contribution, why: f.why }));
      return {
        scope: scope === 'document' ? 'document' : `${scope}:${id ?? ''}`,
        toAuthor,
        toCorpus,
        corpusSize: own.length,
        furthest,
        features: features as unknown as Record<string, number>,
        authorFeatures: authorFeatures as unknown as Record<string, number> | null,
        corpusFeatures: SKILL_CORPUS_NORMS as unknown as Record<string, number>,
      };
    } catch (e) {
      throw new ApiError(`Style distance is unavailable: ${errorText(e)}`, 501);
    }
  }

  async voice(): Promise<{ memo: string; corpus: CorpusEntry[]; editPairs: EditPair[] }> {
    await this.rest();
    return { memo: this.memo, corpus: this.corpus.map((c) => ({ ...c })), editPairs: [...this.editPairs] };
  }

  async setMemo(text: string): Promise<void> {
    await this.rest();
    this.memo = text;
  }

  async addCorpus(entries: Array<Omit<CorpusEntry, 'id'>>): Promise<CorpusEntry[]> {
    await this.rest();
    const added = entries.filter((e) => e.text.trim()).map((e) => ({ ...e, id: shortId('corpus-') }));
    this.corpus.push(...added);
    return added;
  }

  async setCorpusUnassisted(id: string, unassisted: boolean): Promise<CorpusEntry | null> {
    await this.rest();
    const i = this.corpus.findIndex((c) => c.id === id);
    if (i < 0) throw new ApiError('No such corpus entry.', 404);
    const next = { ...this.corpus[i]!, unassisted };
    this.corpus[i] = next;
    return next;
  }

  async cost(): Promise<CostTotals> {
    await this.rest();
    return { ...this.costTotals };
  }

  async dismissLint(flagId: string): Promise<void> {
    await this.rest();
    this.dismissedLint.add(flagId);
    this.emitLint();
  }

  /* ---------------------------------------------------------------------------------- */
  /* Batch B: files, reports (core functions over every file), literature, restore     */
  /* ---------------------------------------------------------------------------------- */

  private projectFiles(): Array<{ file: string; text: string }> {
    return this.allDocs().map((d) => ({ file: d.file, text: d.text }));
  }

  private order() {
    return this.core('projectFileOrder', () => projectFileOrder(this.mainFile, this.projectFiles()), this.allDocs().map((d) => ({ file: d.file, appendix: false, included: true })));
  }

  /** Units of every file with their source text, in document order. */
  private consistencyUnits(): ConsistencyUnit[] {
    for (const d of this.docs.values()) this.withDoc(d, () => this.flushPending());
    const texts = Object.fromEntries(this.allDocs().map((d) => [d.file, d.text]));
    const all = unitsWithText(this.allUnits(), texts);
    return this.core('orderUnits', () => orderUnits(all, this.order()), all);
  }

  async files(): Promise<ProjectFileEntry[]> {
    await this.rest();
    const order = this.order();
    return order.map((o) => {
      const d = this.docs.get(o.file);
      const units = d?.units ?? [];
      return {
        file: o.file,
        main: o.file === this.mainFile,
        parent: null,
        depth: o.file === this.mainFile ? 0 : 1,
        included: o.included,
        appendix: o.appendix,
        open: true,
        units: units.length,
        proposed: units.filter((u) => u.state === 'proposed').length,
        unsupported: units.filter((u) => u.state === 'unsupported').length,
        placeholders: units.filter((u) => u.placeholders.length > 0).length,
        aiTouched: units.filter((u) => u.everAi).length,
      };
    });
  }

  private title(): string | null {
    return this.core('extractTitle', () => extractTitle(this.docText(this.mainFile)), null);
  }

  async consistency(): Promise<EchoReport> {
    await this.rest();
    const facts = this.factsState.filter((f) => !f.excluded);
    try {
      return echoCheck(this.consistencyUnits(), facts, this.outlineState, { title: this.title(), derived: this.core('derivedRelations', () => derivedRelations(facts), []) });
    } catch (e) {
      throw new ApiError(`The echo check is unavailable: ${errorText(e)}`, 501);
    }
  }

  async terminologyReport(): Promise<TerminologyReport> {
    await this.rest();
    try {
      return terminologyReport(this.consistencyUnits(), []);
    } catch (e) {
      throw new ApiError(`The terminology report is unavailable: ${errorText(e)}`, 501);
    }
  }

  async figurePlan(): Promise<FigurePlanReport> {
    await this.rest();
    try {
      return figurePlan(this.projectFiles(), this.consistencyUnits(), this.outlineState, { order: this.order(), figures: this.figures, claims: this.claims });
    } catch (e) {
      throw new ApiError(`The figure plan is unavailable: ${errorText(e)}`, 501);
    }
  }

  async submissionCheck(venue?: Venue): Promise<SubmissionReport> {
    await this.rest();
    try {
      const flags = this.allDocs().flatMap((d) => this.withDoc(d, () => this.lintFlags()));
      return submissionCheck({
        mainFile: this.mainFile,
        files: this.projectFiles(),
        units: this.consistencyUnits(),
        facts: this.factsState,
        venue: venue ?? 'aps',
        bibKeys: this.lit.map((l) => l.key),
        lit: this.lit,
        compile: this.lastCompile,
        lintFlags: flags,
        outline: this.outlineState,
        terms: [],
      });
    } catch (e) {
      throw new ApiError(`The submission check is unavailable: ${errorText(e)}`, 501);
    }
  }

  async resolveLit(keys?: string[]): Promise<{ jobId: string }> {
    await this.rest();
    const want = keys ? new Set(keys) : null;
    const jobId = this.startJob('resolve-lit', async (progress) => {
      progress(this.sim('Looking the keys up on INSPIRE-HEP', '正在 INSPIRE-HEP 上查找引用键'));
      await sleep(this.jobStep);
      // The demo cannot reach INSPIRE: a key with an arXiv id or DOI counts as found, the rest stays unresolved.
      let resolved = 0;
      this.lit = this.lit.map((l) => {
        if ((want && !want.has(l.key)) || l.status === 'user_confirmed') return l;
        if (l.arxiv || l.doi) {
          resolved++;
          return { ...l, status: 'resolved', texkey: l.texkey ?? l.key };
        }
        return { ...l, status: 'unresolved' };
      });
      return { resolved, total: this.lit.length };
    });
    return { jobId };
  }

  async confirmLit(key: string, confirmed: boolean): Promise<LitRecord> {
    await this.rest();
    const i = this.lit.findIndex((l) => l.key === key);
    if (i < 0) throw new ApiError(`No such bib key: ${key}`, 404);
    const cur = this.lit[i]!;
    const next: LitRecord = { ...cur, status: confirmed ? 'user_confirmed' : cur.arxiv || cur.doi ? 'resolved' : 'unresolved' };
    this.lit[i] = next;
    return { ...next };
  }

  async restoreVersion(sentenceId: string, version: number): Promise<RestoreResponse> {
    await this.rest();
    const u = this.selectUnit(sentenceId);
    this.flushPending();
    const unit = this.selectUnit(sentenceId);
    const v = (this.versions.get(sentenceId) ?? []).find((x) => x.version === version);
    if (!v) throw new ApiError(`Sentence ${sentenceId} has no version ${version}.`, 404);
    const current = this.unitText(unit);
    const ai = AI_ORIGINS_SET.has(v.origin);
    let state: SentenceUnit['state'] = ai ? (v.origin === 'ai_draft' || v.origin === 'replan' ? 'proposed' : 'ai-edited') : 'human';
    const issues = ai ? (this.gate(v.text, 'rewrite', { original: current })?.issues ?? []) : [];
    if (ai && issues.some((x) => x.severity === 'block')) state = 'unsupported';
    if (!ai && u.everAi) state = 'ai-edited';
    const annotation: ChangeAnnotation = {
      origin: ai ? v.origin : 'human_edit',
      sentenceIds: [sentenceId],
      state,
      model: ai ? v.model : null,
      promptHash: ai ? v.promptHash : null,
      instruction: `restore v${version}`,
      lang: null,
      intentNote: null,
      factIds: [],
      citeKeys: [],
      move: null,
      requestId: null,
    };
    return {
      sentenceId,
      file: this.file,
      version,
      docVersion: this.version,
      start: unit.start,
      end: unit.end,
      current,
      text: v.text,
      origin: annotation.origin,
      state,
      annotation,
      issues,
      noop: current === v.text,
    };
  }

  /* Convenience for tests and the demo. */
  get currentText(): string {
    return this.text;
  }
  get currentVersion(): number {
    return this.version;
  }
  get currentUnits(): SentenceUnit[] {
    return this.units;
  }
  /** The fact store (for tests). */
  factById(id: string): Fact | undefined {
    return this.factsState.find((f) => f.id === id);
  }
  factIdFor(suffix: string): string | undefined {
    return factBySuffix(this.factsState, suffix)?.id;
  }
}
