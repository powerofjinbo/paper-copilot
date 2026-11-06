/**
 * Web client contracts shared by the shell (layout, panels, store, API client), the editor
 * (CodeMirror extensions, sentence card, ghost text) and the PDF pane. See docs/design.md
 * "UI layout" and "Core loops".
 *
 * Text ownership: the Editor is the only writer of document text. It sends every transaction to
 * the server as `doc.change` and maps server-sent unit spans through local changes the server has
 * not yet acknowledged. AI text enters the document only through EditorHandle methods, as one
 * transaction carrying a ChangeAnnotation (provenance is recorded on the same path as typing).
 */
import type {
  ChangeAnnotation,
  ClientMessage,
  CostTotals,
  DisclosureResponse,
  Fact,
  FactsResponse,
  HistoryResponse,
  LintFlag,
  Outline,
  PanelsResponse,
  ProjectInfo,
  Proposal,
  PushCheck,
  ReanchorReport,
  RefereeQuestion,
  SentenceState,
  SentenceUnit,
  ServerMessage,
  StyleDistanceResponse,
  Venue,
  CorpusEntry,
  EditPair,
} from '@paper-copilot/core';

export type ServerMessageOf<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

/** REST + WebSocket client. One instance per page (created by the shell, passed to the editor and panels). */
export interface ApiClient {
  readonly connected: boolean;
  /** Resolves once the token is known and the WebSocket is open (re-connects with backoff; re-sends hello and doc.open). */
  ready(): Promise<void>;
  send(msg: ClientMessage): void;
  on<T extends ServerMessage['type']>(type: T, fn: (msg: ServerMessageOf<T>) => void): () => void;
  onConnection(fn: (connected: boolean) => void): () => void;

  project(): Promise<ProjectInfo>;
  facts(): Promise<FactsResponse>;
  patchFact(id: string, patch: Partial<Pick<Fact, 'confirmed' | 'excluded' | 'definition' | 'unit' | 'sigfigs' | 'tags'>>): Promise<Fact>;
  rescanFacts(): Promise<{ count: number; stale: string[] }>;
  panels(): Promise<PanelsResponse>;
  outline(): Promise<Outline>;
  saveOutline(outline: Outline): Promise<Outline>;
  history(sentenceId: string): Promise<HistoryResponse>;
  instruct(sentenceId: string, instruction: string, lang: string | null): Promise<Proposal>;
  alternatives(sentenceId: string, n: number): Promise<Proposal[]>;
  grammar(sentenceId: string): Promise<Proposal>;
  /** Marks a proposed/unsupported unit accepted (state becomes ai-drafted). */
  accept(sentenceId: string): Promise<SentenceUnit>;
  /** Returns the placeholder text that replaces a rejected sentence: `[claim: <text>?]`. */
  reject(sentenceId: string): Promise<{ replacement: string }>;
  renderIntent(file: string, line: number, text: string, n: number): Promise<Proposal[]>;
  readRepo(): Promise<{ jobId: string }>;
  framings(): Promise<{ jobId: string }>;
  draft(req: { sectionId: string; paragraphIds: string[] | null; fromNotes: boolean; file: string; afterSentenceId: string | null }): Promise<{ jobId: string }>;
  referee(sectionId: string): Promise<{ jobId: string }>;
  questions(sectionId?: string): Promise<RefereeQuestion[]>;
  compile(): Promise<void>;
  /** URL of the compiled PDF (includes the token as a query parameter). */
  pdfUrl(pdfVersion: number): string;
  synctexForward(file: string, line: number): Promise<{ page: number; x: number; y: number; w: number; h: number } | null>;
  synctexInverse(page: number, x: number, y: number): Promise<{ file: string; line: number } | null>;
  pull(): Promise<ReanchorReport[]>;
  pushCheck(): Promise<PushCheck>;
  push(message: string): Promise<{ ok: boolean; output: string; check: PushCheck }>;
  disclosure(venue: Venue): Promise<DisclosureResponse>;
  styleDistance(scope: 'document' | 'section' | 'paragraph', id?: string): Promise<StyleDistanceResponse>;
  voice(): Promise<{ memo: string; corpus: CorpusEntry[]; editPairs: EditPair[] }>;
  setMemo(text: string): Promise<void>;
  addCorpus(entries: Array<Omit<CorpusEntry, 'id'>>): Promise<CorpusEntry[]>;
  cost(): Promise<CostTotals>;
  /** Dismiss a lint flag (persisted on the server; a lint.update with the full list follows). */
  dismissLint(flagId: string): Promise<void>;
}

/** Imperative handle the Editor exposes to the shell and panels. */
export interface EditorHandle {
  focus(): void;
  /** Scroll to a unit, select it, and open its sentence card if `openCard`. */
  revealSentence(id: string, opts?: { openCard?: boolean }): void;
  revealLine(line: number): void;
  /** Replace the unit's current text with the proposal text as ONE transaction carrying provenance. Returns false if the unit is gone. */
  applyProposal(p: Proposal, opts?: { state?: SentenceState }): boolean;
  /** Insert drafted paragraphs as `proposed`/`unsupported` sentences, one sentence per line, one transaction per paragraph. */
  insertDraft(msg: ServerMessageOf<'draft.proposed'>): void;
  /** Replace a unit's text (e.g. with the reject placeholder) as one annotated transaction. */
  replaceUnitText(id: string, text: string, annotation: ChangeAnnotation): boolean;
  getText(): string;
  activeSentenceId(): string | null;
  currentLine(): number;
}

export interface EditorProps {
  api: ApiClient;
  file: string;
  onReady(handle: EditorHandle): void;
}

/** Imperative handle of the PDF pane. */
export interface PdfHandle {
  /** Scroll to and briefly highlight a SyncTeX box (PDF points, origin top-left as synctex reports). */
  showBox(box: { page: number; x: number; y: number; w: number; h: number }): void;
}

export interface PdfPaneProps {
  api: ApiClient;
  /** Increments after every successful compile; null = no PDF yet. */
  pdfVersion: number | null;
  /** Called when the user clicks in the PDF (inverse search resolved by the pane through api.synctexInverse). */
  onInverse(target: { file: string; line: number }): void;
  onReady?(handle: PdfHandle): void;
}

export type LeftTab = 'outline' | 'facts' | 'review' | 'placeholders' | 'questions' | 'voice' | 'sync';

/** Shared UI state (zustand store in state/store.ts). */
export interface WorkspaceState {
  project: ProjectInfo | null;
  connected: boolean;
  file: string | null;
  /** Units of the open file in CURRENT editor coordinates (published by the editor after mapping). */
  units: SentenceUnit[];
  lint: LintFlag[];
  activeSentenceId: string | null;
  facts: Fact[];
  unresolved: FactsResponse['unresolved'];
  outline: Outline | null;
  compile: { state: 'idle' | 'running' | 'ok' | 'error'; pdfVersion: number | null; errors: Array<{ file: string; line: number | null; message: string }>; logTail: string };
  cost: CostTotals | null;
  jobs: Record<string, { kind: string; state: string; message: string }>;
  notices: Array<{ id: number; level: 'info' | 'warn' | 'error'; message: string }>;
  questions: RefereeQuestion[];
  leftTab: LeftTab;
  rightPane: 'pdf' | 'none';
  editor: EditorHandle | null;

  setProject(p: ProjectInfo | null): void;
  setConnected(c: boolean): void;
  setFile(f: string | null): void;
  setUnits(units: SentenceUnit[]): void;
  setLint(flags: LintFlag[]): void;
  setActiveSentence(id: string | null): void;
  setFacts(facts: Fact[], unresolved: FactsResponse['unresolved']): void;
  setOutline(o: Outline | null): void;
  setCompile(c: WorkspaceState['compile']): void;
  setCost(c: CostTotals | null): void;
  upsertJob(id: string, job: { kind: string; state: string; message: string }): void;
  pushNotice(level: 'info' | 'warn' | 'error', message: string): void;
  dismissNotice(id: number): void;
  setQuestions(q: RefereeQuestion[]): void;
  setLeftTab(t: LeftTab): void;
  setRightPane(p: 'pdf' | 'none'): void;
  setEditor(e: EditorHandle | null): void;
}
