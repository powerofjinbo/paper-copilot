/**
 * The real ApiClient: REST under /api plus one WebSocket at /ws (docs/design.md "Architecture";
 * packages/core/src/api.ts for the wire protocol).
 *
 * - Token: `<meta name="paper-token">` (production build served by the server), else
 *   `GET /api/session` with the custom header `x-paper-client: 1` (Vite dev mode).
 * - Every REST call carries `x-paper-token`; JSON error bodies become ApiError(message, status).
 * - WebSocket `/ws?token=...` on the page's own origin. Incoming frames are validated with the core
 *   zod schema `ServerMessage`; malformed frames are dropped, never dispatched.
 * - Reconnects with exponential backoff (capped at 5 s). On every open it sends `hello`, re-sends
 *   `doc.open` for every file opened so far, then flushes messages queued while disconnected.
 */
import {
  ROUTES,
  route,
  ServerMessage,
  shortId,
  type ClientMessage,
  type CorpusEntry,
  type CostTotals,
  type DisclosureResponse,
  type Fact,
  type FactsResponse,
  type HistoryResponse,
  type Outline,
  type PanelsResponse,
  type ProjectInfo,
  type Proposal,
  type PushCheck,
  type ReanchorReport,
  type RefereeQuestion,
  type SentenceUnit,
  type StyleDistanceResponse,
  type Venue,
  type EditPair,
} from '@paper-copilot/core';
import type { ApiClient, ServerMessageOf } from '../contracts';
import { ApiError, messageOf, unwrapArray, unwrapObject } from './errors';
import type { ApiClientExtras } from './extras';

/** The subset of the browser WebSocket the client uses (so tests can pass a fake). */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

const WS_OPEN = 1;
/** Path of the dev-mode token endpoint (server contracts, SECURITY). */
export const SESSION_PATH = '/api/session';
const MAX_QUEUE = 5000;

export interface HttpApiOptions {
  /** Prefix for REST URLs; '' = same origin (default). */
  baseUrl?: string;
  /** `ws://host` / `wss://host` for the socket; default: the page's own origin. */
  wsBase?: string;
  fetch?: typeof fetch;
  WebSocket?: WebSocketCtor;
  /** Reads the launch token injected into index.html; default reads `<meta name="paper-token">`. */
  metaToken?: () => string | null;
  clientId?: string;
  backoff?: { initialMs?: number; maxMs?: number };
  /** Diagnostics sink (dropped frames, listener errors). Default: console.warn. */
  log?: (msg: string, data?: unknown) => void;
}

type Query = Record<string, string | number | boolean | null | undefined>;
type AnyListener = (msg: ServerMessage) => void;

function defaultMetaToken(): string | null {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector('meta[name="paper-token"]');
  const v = el?.getAttribute('content')?.trim();
  return v ? v : null;
}

function defaultWsBase(): string {
  if (typeof location === 'undefined') return 'ws://127.0.0.1';
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
}

function queryString(q?: Query): string {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export class HttpApiClient implements ApiClient, ApiClientExtras {
  readonly isMock = false;
  private readonly baseUrl: string;
  private readonly wsBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly WS: WebSocketCtor | null;
  private readonly readMeta: () => string | null;
  /** Sent in `hello`; the server tags relayed changes with it (doc.remoteChange.originClientId). */
  readonly clientId: string;
  private readonly initialMs: number;
  private readonly maxMs: number;
  private readonly log: (msg: string, data?: unknown) => void;

  private token: string | null = null;
  private tokenSource: 'meta' | 'session' | null = null;
  /** The page's <meta> token was rejected or its server went away: use GET /api/session from now on. */
  private metaStale = false;
  private tokenPromise: Promise<string> | null = null;

  private ws: WebSocketLike | null = null;
  private _connected = false;
  private connecting = false;
  private disposed = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly queue: ClientMessage[] = [];
  /**
   * An open socket went away: queued doc.change messages belong to its text lineage (they were sent in the
   * closing window, or while disconnected) and are dropped at the next open. The editor's sync owns them and
   * re-sends them from its log once the new socket's snapshot is reconciled; replayed here, they could be
   * applied by a restarted server whose version and length happen to match, in the wrong place.
   */
  private dropQueuedChanges = false;
  private readonly openFiles = new Set<string>();
  /** Files re-opened automatically on the current connection; absorbs one echoed doc.open each. */
  private reopened = new Set<string>();
  private reopenedTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Map<string, Set<AnyListener>>();
  private readonly connListeners = new Set<(c: boolean) => void>();
  private readyWaiters: Array<() => void> = [];

  constructor(opts: HttpApiOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? '').replace(/\/$/, '');
    this.wsBase = (opts.wsBase ?? defaultWsBase()).replace(/\/$/, '');
    const f = opts.fetch ?? (typeof fetch !== 'undefined' ? fetch : undefined);
    if (!f) throw new Error('fetch is not available');
    // Bind so that `this` is never the client (some fetch implementations require window).
    this.fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => f(input, init)) as typeof fetch;
    this.WS = opts.WebSocket ?? ((typeof WebSocket !== 'undefined' ? WebSocket : null) as unknown as WebSocketCtor | null);
    this.readMeta = opts.metaToken ?? defaultMetaToken;
    this.clientId = opts.clientId ?? shortId('web-');
    this.initialMs = opts.backoff?.initialMs ?? 250;
    this.maxMs = Math.min(opts.backoff?.maxMs ?? 5000, 5000);
    this.log = opts.log ?? ((msg, data) => console.warn(`[api] ${msg}`, data ?? ''));
  }

  /* ---------------------------------------------------------------------------------- */
  /* Connection                                                                         */
  /* ---------------------------------------------------------------------------------- */

  get connected(): boolean {
    return this._connected;
  }

  ready(): Promise<void> {
    void this.connect();
    if (this._connected) return Promise.resolve();
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  onConnection(fn: (connected: boolean) => void): () => void {
    this.connListeners.add(fn);
    return () => {
      this.connListeners.delete(fn);
    };
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

  send(msg: ClientMessage): void {
    if (msg.type === 'doc.open') {
      this.openFiles.add(msg.file);
      // A client that re-opens its file right after a reconnect would only get a second identical snapshot.
      if (this._connected && this.reopened.delete(msg.file)) return;
    }
    const ws = this.ws;
    if (this._connected && ws && ws.readyState === WS_OPEN) {
      this.rawSend(msg);
      return;
    }
    if (this.queue.length >= MAX_QUEUE) this.queue.shift();
    this.queue.push(msg);
    void this.connect();
  }

  /** Stop reconnecting and close the socket (tests, hot reload). */
  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.reopenedTimer) clearTimeout(this.reopenedTimer);
    this.reopenedTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      try {
        ws.close(1000, 'client disposed');
      } catch {
        /* already closed */
      }
    }
    this.setConnected(false);
  }

  private rawSend(msg: ClientMessage): void {
    try {
      this.ws?.send(JSON.stringify(msg));
    } catch (e) {
      this.log('send failed; queued', e);
      this.queue.push(msg);
    }
  }

  private setConnected(c: boolean): void {
    if (this._connected === c) return;
    this._connected = c;
    for (const fn of [...this.connListeners]) {
      try {
        fn(c);
      } catch (e) {
        this.log('connection listener failed', e);
      }
    }
    if (c) {
      const w = this.readyWaiters;
      this.readyWaiters = [];
      for (const r of w) r();
    }
  }

  private async connect(): Promise<void> {
    if (this.disposed || this.connecting || this.ws || this.reconnectTimer) return;
    if (!this.WS) {
      this.log('WebSocket is not available in this environment');
      return;
    }
    this.connecting = true;
    let token: string;
    try {
      token = await this.getToken();
    } catch (e) {
      this.connecting = false;
      this.log('cannot get the session token; retrying', e instanceof Error ? e.message : e);
      this.scheduleReconnect();
      return;
    }
    if (this.disposed) {
      this.connecting = false;
      return;
    }
    let ws: WebSocketLike;
    try {
      ws = new this.WS(`${this.wsBase}${ROUTES.ws}?token=${encodeURIComponent(token)}`);
    } catch (e) {
      this.connecting = false;
      this.log('WebSocket construction failed', e);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.connecting = false;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempts = 0;
      this.rawSend({ type: 'hello', clientId: this.clientId });
      for (const file of this.openFiles) this.rawSend({ type: 'doc.open', file });
      this.reopened = new Set(this.openFiles);
      if (this.reopenedTimer) clearTimeout(this.reopenedTimer);
      this.reopenedTimer = setTimeout(() => {
        this.reopened.clear();
        this.reopenedTimer = null;
      }, 2000);
      const pending = this.queue.splice(0, this.queue.length);
      const dropChanges = this.dropQueuedChanges;
      this.dropQueuedChanges = false;
      for (const m of pending) {
        if (m.type === 'hello' || m.type === 'doc.open') continue; // just sent
        if (m.type === 'doc.change' && dropChanges) continue; // re-sent by the editor after the snapshot
        this.rawSend(m);
      }
      this.setConnected(true);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.handleFrame(ev.data);
    };
    ws.onerror = () => {
      /* a close event follows */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      if (this._connected) this.dropQueuedChanges = true;
      this.ws = null;
      this.setConnected(false);
      // A launch token dies with the server process. After a restart the page's <meta> token is stale,
      // so reconnects ask GET /api/session (same origin, custom header) for the current one; the editor
      // then re-sends its queued changes and nothing typed while the server was down is lost.
      if (this.tokenSource === 'session' || this.tokenSource === 'meta') {
        if (this.tokenSource === 'meta') this.metaStale = true;
        this.token = null;
        this.tokenSource = null;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const delay = Math.min(this.maxMs, this.initialMs * 2 ** this.attempts);
    this.attempts = Math.min(this.attempts + 1, 30);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  /** Parse, validate and dispatch one frame. Exposed for tests through the fake socket. */
  private handleFrame(data: unknown): void {
    if (typeof data !== 'string') {
      this.log('dropping a non-text frame');
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      this.log('dropping a frame that is not JSON', data.slice(0, 200));
      return;
    }
    const parsed = ServerMessage.safeParse(json);
    if (!parsed.success) {
      const t = json && typeof json === 'object' ? (json as { type?: unknown }).type : undefined;
      this.log(`dropping a malformed server message (type ${String(t)})`, parsed.error.issues.slice(0, 3));
      return;
    }
    this.dispatch(parsed.data);
  }

  private dispatch(msg: ServerMessage): void {
    const set = this.listeners.get(msg.type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(msg);
      } catch (e) {
        this.log(`listener for ${msg.type} failed`, e);
      }
    }
  }

  /* ---------------------------------------------------------------------------------- */
  /* Token and REST                                                                     */
  /* ---------------------------------------------------------------------------------- */

  private getToken(): Promise<string> {
    if (this.token) return Promise.resolve(this.token);
    if (this.tokenPromise) return this.tokenPromise;
    const p = (async () => {
      const meta = this.metaStale ? null : this.readMeta();
      if (meta) {
        this.token = meta;
        this.tokenSource = 'meta';
        return meta;
      }
      const res = await this.fetchImpl(`${this.baseUrl}${SESSION_PATH}`, {
        method: 'GET',
        headers: { 'x-paper-client': '1' },
        credentials: 'same-origin',
        cache: 'no-store',
      });
      const body = await readBody(res);
      if (!res.ok) throw new ApiError(messageOf(body, `Cannot reach the paper-copilot server (session request failed with HTTP ${res.status}).`), res.status, body);
      const tok = body && typeof body === 'object' ? (body as { token?: unknown }).token : undefined;
      if (typeof tok !== 'string' || !tok) throw new ApiError('the session response has no token', res.status, body);
      this.token = tok;
      this.tokenSource = 'session';
      return tok;
    })();
    this.tokenPromise = p;
    p.then(
      () => {
        if (this.tokenPromise === p) this.tokenPromise = null;
      },
      () => {
        if (this.tokenPromise === p) this.tokenPromise = null;
      },
    );
    return p;
  }

  private async request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, opts: { query?: Query; body?: unknown } = {}, retried = false): Promise<T> {
    const token = await this.getToken();
    const headers: Record<string, string> = { 'x-paper-token': token, accept: 'application/json' };
    const init: RequestInit = { method, headers, credentials: 'same-origin', cache: 'no-store' };
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}${queryString(opts.query)}`, init);
    const body = await readBody(res);
    if (res.status === 401 && !retried && (this.tokenSource === 'session' || this.tokenSource === 'meta')) {
      // The server restarted with a new token: fetch it once and retry.
      if (this.tokenSource === 'meta') this.metaStale = true;
      this.token = null;
      this.tokenSource = null;
      return this.request<T>(method, path, opts, true);
    }
    if (!res.ok) throw new ApiError(messageOf(body, `${method} ${path} failed (${res.status} ${res.statusText || ''})`.trim()), res.status, body);
    return body as T;
  }

  /* ---------------------------------------------------------------------------------- */
  /* ApiClient REST methods                                                             */
  /* ---------------------------------------------------------------------------------- */

  project(): Promise<ProjectInfo> {
    return this.request('GET', ROUTES.project);
  }

  facts(): Promise<FactsResponse> {
    return this.request<FactsResponse>('GET', ROUTES.facts).then((d) => ({
      facts: unwrapArray<Fact>(d, 'facts'),
      unresolved: d && typeof d === 'object' && Array.isArray((d as FactsResponse).unresolved) ? (d as FactsResponse).unresolved : [],
    }));
  }

  async patchFact(id: string, patch: Partial<Pick<Fact, 'confirmed' | 'excluded' | 'definition' | 'unit' | 'sigfigs' | 'tags'>>): Promise<Fact> {
    const d = await this.request<unknown>('PATCH', route(ROUTES.fact, { id }), { body: patch });
    return unwrapObject<Fact>(d, 'fact', (o) => typeof o.id === 'string' && 'value' in o);
  }

  async rescanFacts(): Promise<{ count: number; stale: string[] }> {
    const d = await this.request<{ count?: number; stale?: string[] } | null>('POST', ROUTES.factsRescan, { body: {} });
    return { count: typeof d?.count === 'number' ? d.count : 0, stale: Array.isArray(d?.stale) ? d.stale : [] };
  }

  async panels(): Promise<PanelsResponse> {
    const [claims, figures, terminology, lit] = await Promise.all([
      this.request<unknown>('GET', ROUTES.claims),
      this.request<unknown>('GET', ROUTES.figures),
      this.request<unknown>('GET', ROUTES.terminology),
      this.request<unknown>('GET', ROUTES.lit),
    ]);
    return {
      claims: unwrapArray(claims, 'claims'),
      figures: unwrapArray(figures, 'figures'),
      terminology: unwrapArray(terminology, 'terminology', 'terms'),
      lit: unwrapArray(lit, 'lit', 'records'),
    };
  }

  async outline(): Promise<Outline> {
    const d = await this.request<unknown>('GET', ROUTES.outline);
    return unwrapObject<Outline>(d, 'outline', (o) => 'story' in o && 'sections' in o);
  }

  async saveOutline(outline: Outline): Promise<Outline> {
    const d = await this.request<unknown>('PUT', ROUTES.outline, { body: outline });
    if (!d) return outline;
    return unwrapObject<Outline>(d, 'outline', (o) => 'story' in o && 'sections' in o);
  }

  history(sentenceId: string): Promise<HistoryResponse> {
    return this.request('GET', route(ROUTES.sentenceHistory, { id: sentenceId }));
  }

  instruct(sentenceId: string, instruction: string, lang: string | null): Promise<Proposal> {
    return this.request('POST', route(ROUTES.sentenceInstruct, { id: sentenceId }), { body: { instruction, lang } });
  }

  async alternatives(sentenceId: string, n: number): Promise<Proposal[]> {
    const d = await this.request<unknown>('POST', route(ROUTES.sentenceAlternatives, { id: sentenceId }), { body: { n } });
    return unwrapArray<Proposal>(d, 'proposals', 'alternatives');
  }

  grammar(sentenceId: string): Promise<Proposal> {
    return this.request('POST', route(ROUTES.sentenceGrammar, { id: sentenceId }), { body: {} });
  }

  async accept(sentenceId: string): Promise<SentenceUnit> {
    const d = await this.request<unknown>('POST', route(ROUTES.sentenceAccept, { id: sentenceId }), { body: {} });
    return unwrapObject<SentenceUnit>(d, 'unit', (o) => typeof o.id === 'string' && 'state' in o);
  }

  reject(sentenceId: string): Promise<{ replacement: string }> {
    return this.request('POST', route(ROUTES.sentenceReject, { id: sentenceId }), { body: {} });
  }

  async renderIntent(file: string, line: number, text: string, n: number): Promise<Proposal[]> {
    const d = await this.request<unknown>('POST', ROUTES.intentRender, { body: { file, line, text, n } });
    return unwrapArray<Proposal>(d, 'proposals');
  }

  readRepo(): Promise<{ jobId: string }> {
    return this.request('POST', ROUTES.agentsReadRepo, { body: {} });
  }

  framings(): Promise<{ jobId: string }> {
    return this.request('POST', ROUTES.agentsFramings, { body: {} });
  }

  draft(req: { sectionId: string; paragraphIds: string[] | null; fromNotes: boolean; file: string; afterSentenceId: string | null }): Promise<{ jobId: string }> {
    return this.request('POST', ROUTES.agentsDraft, { body: req });
  }

  referee(sectionId: string): Promise<{ jobId: string }> {
    return this.request('POST', ROUTES.agentsReferee, { body: { sectionId } });
  }

  async questions(sectionId?: string): Promise<RefereeQuestion[]> {
    const d = await this.request<unknown>('GET', ROUTES.questions, { query: { sectionId } });
    return unwrapArray<RefereeQuestion>(d, 'questions');
  }

  async compile(): Promise<void> {
    await this.request<unknown>('POST', ROUTES.compile, { body: {} });
  }

  pdfUrl(pdfVersion: number): string {
    return `${this.baseUrl}${ROUTES.pdf}?v=${encodeURIComponent(String(pdfVersion))}&token=${encodeURIComponent(this.token ?? (this.metaStale ? '' : this.readMeta()) ?? '')}`;
  }

  async synctexForward(file: string, line: number): Promise<{ page: number; x: number; y: number; w: number; h: number } | null> {
    try {
      const d = await this.request<unknown>('GET', ROUTES.synctexForward, { query: { file, line } });
      return d && typeof d === 'object' && typeof (d as { page?: unknown }).page === 'number' ? (d as { page: number; x: number; y: number; w: number; h: number }) : null;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }

  async synctexInverse(page: number, x: number, y: number): Promise<{ file: string; line: number } | null> {
    try {
      const d = await this.request<unknown>('GET', ROUTES.synctexInverse, { query: { page, x, y } });
      return d && typeof d === 'object' && typeof (d as { line?: unknown }).line === 'number' ? (d as { file: string; line: number }) : null;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }

  async pull(): Promise<ReanchorReport[]> {
    const d = await this.request<unknown>('POST', ROUTES.syncPull, { body: {} });
    return unwrapArray<ReanchorReport>(d, 'reports');
  }

  pushCheck(): Promise<PushCheck> {
    return this.request('GET', ROUTES.syncPushCheck);
  }

  push(message: string): Promise<{ ok: boolean; output: string; check: PushCheck }> {
    return this.request('POST', ROUTES.syncPush, { body: { message } });
  }

  disclosure(venue: Venue): Promise<DisclosureResponse> {
    return this.request('GET', ROUTES.disclosure, { query: { venue } });
  }

  styleDistance(scope: 'document' | 'section' | 'paragraph', id?: string): Promise<StyleDistanceResponse> {
    return this.request('GET', ROUTES.styleDistance, { query: { scope, id } });
  }

  async voice(): Promise<{ memo: string; corpus: CorpusEntry[]; editPairs: EditPair[] }> {
    const d = await this.request<{ memo?: unknown; corpus?: unknown; editPairs?: unknown } | null>('GET', ROUTES.voice);
    return {
      memo: typeof d?.memo === 'string' ? d.memo : '',
      corpus: unwrapArray<CorpusEntry>(d?.corpus ?? []),
      editPairs: unwrapArray<EditPair>(d?.editPairs ?? []),
    };
  }

  async setMemo(text: string): Promise<void> {
    await this.request<unknown>('PUT', ROUTES.voiceMemo, { body: { text } });
  }

  async addCorpus(entries: Array<Omit<CorpusEntry, 'id'>>): Promise<CorpusEntry[]> {
    const d = await this.request<unknown>('POST', ROUTES.voiceCorpus, { body: { entries } });
    return unwrapArray<CorpusEntry>(d, 'entries', 'corpus', 'added');
  }

  async setCorpusUnassisted(id: string, unassisted: boolean): Promise<CorpusEntry | null> {
    const d = await this.request<unknown>('PATCH', `${ROUTES.voiceCorpus}/${encodeURIComponent(id)}`, { body: { unassisted } });
    return d && typeof d === 'object' && typeof (d as { id?: unknown }).id === 'string' ? (d as CorpusEntry) : null;
  }

  cost(): Promise<CostTotals> {
    return this.request('GET', ROUTES.cost);
  }

  async dismissLint(flagId: string): Promise<void> {
    await this.request<unknown>('POST', route(ROUTES.lintDismiss, { id: flagId }), { body: {} });
  }
}

async function readBody(res: Response): Promise<unknown> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    return null;
  }
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
