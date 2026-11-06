/**
 * HttpApiClient: request building (token, headers, routes, bodies), error surfacing, WebSocket
 * dispatch with zod validation, the send queue, hello + doc.open on (re)connect, backoff.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROUTES, type ServerMessage } from '@paper-copilot/core';
import { HttpApiClient, SESSION_PATH, type WebSocketLike } from '../src/api/client';
import { ApiError } from '../src/api/errors';

class FakeWS implements WebSocketLike {
  static instances: FakeWS[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(data: unknown): void {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
  get messages(): Array<{ type: string } & Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s));
  }
}

type Call = { url: string; init: RequestInit };

function json(body: unknown, status = 200): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function makeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const i = init ?? {};
    calls.push({ url, init: i });
    return handler(url, i);
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function header(init: RequestInit, name: string): string | undefined {
  const h = init.headers as Record<string, string> | undefined;
  return h ? h[name] : undefined;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  FakeWS.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('HttpApiClient REST', () => {
  it('uses the <meta> token and sends x-paper-token on every call', async () => {
    const f = makeFetch(() => json({ facts: [], unresolved: [] }));
    const api = new HttpApiClient({ fetch: f.fn, metaToken: () => 'meta-tok', WebSocket: FakeWS, log: () => {} });
    await api.facts();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(ROUTES.facts);
    expect(f.calls[0]!.init.method).toBe('GET');
    expect(header(f.calls[0]!.init, 'x-paper-token')).toBe('meta-tok');
    expect(f.calls.some((c) => c.url === SESSION_PATH)).toBe(false);
  });

  it('falls back to GET /api/session with x-paper-client: 1', async () => {
    const f = makeFetch((url) => (url === SESSION_PATH ? json({ token: 'sess-tok' }) : json([])));
    const api = new HttpApiClient({ fetch: f.fn, metaToken: () => null, WebSocket: FakeWS, log: () => {} });
    await api.questions();
    await api.questions('sec:results');
    expect(f.calls[0]!.url).toBe(SESSION_PATH);
    expect(header(f.calls[0]!.init, 'x-paper-client')).toBe('1');
    expect(header(f.calls[0]!.init, 'x-paper-token')).toBeUndefined();
    // The token is fetched once and reused.
    expect(f.calls.filter((c) => c.url === SESSION_PATH)).toHaveLength(1);
    expect(f.calls[1]!.url).toBe(ROUTES.questions);
    expect(f.calls[2]!.url).toBe(`${ROUTES.questions}?sectionId=sec%3Aresults`);
    expect(header(f.calls[2]!.init, 'x-paper-token')).toBe('sess-tok');
  });

  it('builds routes with params, methods and JSON bodies', async () => {
    const f = makeFetch((url) => {
      if (url.includes('/instruct')) return json({ proposalId: 'p1' });
      if (url.includes('/alternatives')) return json({ proposals: [{ proposalId: 'a' }, { proposalId: 'b' }] });
      if (url.startsWith('/api/facts/')) return json({ id: 'f.g1/x', value: 1 });
      if (url.startsWith(ROUTES.synctexForward)) return json({ page: 2, x: 1, y: 2, w: 3, h: 4 });
      return json({ jobId: 'job-1' });
    });
    const api = new HttpApiClient({ fetch: f.fn, metaToken: () => 't', WebSocket: FakeWS, log: () => {} });

    await api.patchFact('f.g1/x', { confirmed: true });
    let c = f.calls.at(-1)!;
    expect(c.url).toBe('/api/facts/f.g1%2Fx');
    expect(c.init.method).toBe('PATCH');
    expect(header(c.init, 'content-type')).toBe('application/json');
    expect(JSON.parse(String(c.init.body))).toEqual({ confirmed: true });

    await api.instruct('01HX', '把基线放在前面', 'zh');
    c = f.calls.at(-1)!;
    expect(c.url).toBe('/api/sentences/01HX/instruct');
    expect(c.init.method).toBe('POST');
    expect(JSON.parse(String(c.init.body))).toEqual({ instruction: '把基线放在前面', lang: 'zh' });

    const alts = await api.alternatives('01HX', 3);
    expect(alts.map((a) => a.proposalId)).toEqual(['a', 'b']);
    expect(JSON.parse(String(f.calls.at(-1)!.init.body))).toEqual({ n: 3 });

    const draftReq = { sectionId: 'sec:results', paragraphIds: null, fromNotes: false, file: 'main.tex', afterSentenceId: null };
    expect(await api.draft(draftReq)).toEqual({ jobId: 'job-1' });
    c = f.calls.at(-1)!;
    expect(c.url).toBe(ROUTES.agentsDraft);
    expect(JSON.parse(String(c.init.body))).toEqual(draftReq);

    await api.referee('sec:intro');
    expect(JSON.parse(String(f.calls.at(-1)!.init.body))).toEqual({ sectionId: 'sec:intro' });

    const box = await api.synctexForward('main.tex', 42);
    expect(box).toEqual({ page: 2, x: 1, y: 2, w: 3, h: 4 });
    expect(f.calls.at(-1)!.url).toBe(`${ROUTES.synctexForward}?file=main.tex&line=42`);

    await api.setMemo('- plain verbs');
    c = f.calls.at(-1)!;
    expect(c.url).toBe(ROUTES.voiceMemo);
    expect(c.init.method).toBe('PUT');
    expect(JSON.parse(String(c.init.body))).toEqual({ text: '- plain verbs' });

    await api.styleDistance('section', 'sec:results');
    expect(f.calls.at(-1)!.url).toBe(`${ROUTES.styleDistance}?scope=section&id=sec%3Aresults`);

    await api.disclosure('elsevier');
    expect(f.calls.at(-1)!.url).toBe(`${ROUTES.disclosure}?venue=elsevier`);

    await api.setCorpusUnassisted('c 1', true);
    c = f.calls.at(-1)!;
    expect(c.url).toBe(`${ROUTES.voiceCorpus}/c%201`);
    expect(c.init.method).toBe('PATCH');
  });

  it('pdfUrl carries the version and the token', async () => {
    const f = makeFetch(() => json({}));
    const api = new HttpApiClient({ fetch: f.fn, metaToken: () => 'a b', WebSocket: FakeWS, log: () => {} });
    expect(api.pdfUrl(7)).toBe('/api/pdf?v=7&token=a%20b');
  });

  it('surfaces JSON errors as ApiError(message) with the status', async () => {
    const f = makeFetch(() => json({ statusCode: 409, error: 'Conflict', message: 'write the five items first' }, 409));
    const api = new HttpApiClient({ fetch: f.fn, metaToken: () => 't', WebSocket: FakeWS, log: () => {} });
    const err = await api.framings().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe('write the five items first');
    expect((err as ApiError).status).toBe(409);
  });

  it('uses `error` when there is no message, and the status text otherwise', async () => {
    let n = 0;
    const f = makeFetch(() => (n++ === 0 ? json({ error: 'nope' }, 500) : new Response('', { status: 502, statusText: 'Bad Gateway' })));
    const api = new HttpApiClient({ fetch: f.fn, metaToken: () => 't', WebSocket: FakeWS, log: () => {} });
    await expect(api.cost()).rejects.toMatchObject({ message: 'nope', status: 500 });
    await expect(api.cost()).rejects.toMatchObject({ status: 502 });
  });

  it('refetches a dev-session token once on 401', async () => {
    let tokens = 0;
    const f = makeFetch((url, init) => {
      if (url === SESSION_PATH) return json({ token: `tok-${++tokens}` });
      return header(init, 'x-paper-token') === 'tok-1' ? json({ message: 'bad token' }, 401) : json({ usd: 0 });
    });
    const api = new HttpApiClient({ fetch: f.fn, metaToken: () => null, WebSocket: FakeWS, log: () => {} });
    await expect(api.cost()).resolves.toEqual({ usd: 0 });
    expect(tokens).toBe(2);
  });

  it('treats 404 from SyncTeX as "no location"', async () => {
    const f = makeFetch(() => json({ message: 'no PDF yet' }, 404));
    const api = new HttpApiClient({ fetch: f.fn, metaToken: () => 't', WebSocket: FakeWS, log: () => {} });
    await expect(api.synctexForward('main.tex', 3)).resolves.toBeNull();
  });
});

describe('HttpApiClient WebSocket', () => {
  function client(log = vi.fn()) {
    // after a dropped socket the page's <meta> token may be stale (server restart): /api/session answers
    const f = makeFetch((url, init) => (url.endsWith('/api/session') && header(init, 'x-paper-client') === '1' ? json({ token: 'tok/2' }) : json({})));
    const api = new HttpApiClient({ fetch: f.fn, metaToken: () => 'tok/1', WebSocket: FakeWS, wsBase: 'ws://127.0.0.1:5173', clientId: 'web-test', log, backoff: { initialMs: 100, maxMs: 5000 } });
    return { api, log };
  }

  it('connects to /ws?token=..., says hello, re-opens files and flushes the queue', async () => {
    const { api } = client();
    const conn = vi.fn();
    api.onConnection(conn);
    api.send({ type: 'doc.open', file: 'main.tex' });
    api.send({ type: 'doc.change', file: 'main.tex', baseVersion: 0, changes: [5, [0, 'x'], 10], annotation: null });
    const ready = api.ready();
    await flush();
    expect(FakeWS.instances).toHaveLength(1);
    const ws = FakeWS.instances[0]!;
    expect(ws.url).toBe('ws://127.0.0.1:5173/ws?token=tok%2F1');
    expect(api.connected).toBe(false);
    ws.open();
    await ready;
    expect(api.connected).toBe(true);
    expect(conn).toHaveBeenCalledWith(true);
    expect(ws.messages.map((m) => m.type)).toEqual(['hello', 'doc.open', 'doc.change']);
    expect(ws.messages[0]).toEqual({ type: 'hello', clientId: 'web-test' });
    // Connected: sends go straight out.
    api.send({ type: 'ghost.cancel', requestId: 'r1' });
    expect(ws.messages.at(-1)).toEqual({ type: 'ghost.cancel', requestId: 'r1' });
  });

  it('dispatches valid messages to on(type) listeners only', async () => {
    const { api } = client();
    void api.ready();
    await flush();
    const ws = FakeWS.instances[0]!;
    ws.open();
    const notices: Array<Extract<ServerMessage, { type: 'notice' }>> = [];
    const acks = vi.fn();
    const off = api.on('notice', (m) => notices.push(m));
    api.on('doc.ack', acks);
    ws.receive({ type: 'notice', level: 'warn', message: 'careful' });
    ws.receive({ type: 'doc.ack', file: 'main.tex', version: 3 });
    expect(notices).toEqual([{ type: 'notice', level: 'warn', message: 'careful' }]);
    expect(acks).toHaveBeenCalledWith({ type: 'doc.ack', file: 'main.tex', version: 3 });
    off();
    ws.receive({ type: 'notice', level: 'info', message: 'after off' });
    expect(notices).toHaveLength(1);
  });

  it('drops malformed frames (zod) without calling listeners', async () => {
    const { api, log } = client();
    void api.ready();
    await flush();
    const ws = FakeWS.instances[0]!;
    ws.open();
    const any = vi.fn();
    for (const t of ['notice', 'doc.ack', 'compile.status', 'sentences.patch'] as const) api.on(t, any);
    ws.receive({ type: 'notice', level: 'loud', message: 'bad level' });
    ws.receive({ type: 'doc.ack', file: 'main.tex' });
    ws.receive({ type: 'compile.status', state: 'ok' });
    ws.receive({ type: 'sentences.patch', file: 'main.tex', version: 1, upserts: [{ id: 'x' }], removed: [], intentLines: [] });
    ws.receive({ type: 'no.such.type' });
    ws.receive('this is not json');
    ws.onmessage?.({ data: new Uint8Array([1, 2]) });
    expect(any).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
    // A listener that throws does not break dispatch to the others.
    const good = vi.fn();
    api.on('notice', () => {
      throw new Error('boom');
    });
    api.on('notice', good);
    ws.receive({ type: 'notice', level: 'info', message: 'ok' });
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('reconnects with exponential backoff capped at 5 s and re-sends hello + doc.open', async () => {
    vi.useFakeTimers();
    const { api } = client();
    const conn = vi.fn();
    api.onConnection(conn);
    void api.ready();
    await vi.advanceTimersByTimeAsync(0);
    FakeWS.instances[0]!.open();
    api.send({ type: 'doc.open', file: 'main.tex' });
    FakeWS.instances[0]!.drop();
    expect(api.connected).toBe(false);
    expect(conn).toHaveBeenLastCalledWith(false);
    // Messages sent while disconnected are queued.
    api.send({ type: 'doc.flush', file: 'main.tex', version: 4 });

    // Failed attempts: 100, 200, 400, 800, 1600, 3200, then capped at 5000.
    const expected = [100, 200, 400, 800, 1600, 3200, 5000, 5000];
    for (const delay of expected) {
      const before = FakeWS.instances.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(FakeWS.instances.length).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeWS.instances.length).toBe(before + 1);
      FakeWS.instances.at(-1)!.drop();
    }
    await vi.advanceTimersByTimeAsync(5000);
    const ws = FakeWS.instances.at(-1)!;
    // the reconnect uses the server's current token, not the page's stale <meta> one
    expect(ws.url).toBe('ws://127.0.0.1:5173/ws?token=tok%2F2');
    ws.open();
    expect(api.connected).toBe(true);
    expect(ws.messages.map((m) => m.type)).toEqual(['hello', 'doc.open', 'doc.flush']);
    // The editor's own re-open right after the reconnect is absorbed once (no duplicate snapshot)...
    api.send({ type: 'doc.open', file: 'main.tex' });
    expect(ws.messages.filter((m) => m.type === 'doc.open')).toHaveLength(1);
    // ...but a later explicit open goes out.
    api.send({ type: 'doc.open', file: 'main.tex' });
    expect(ws.messages.filter((m) => m.type === 'doc.open')).toHaveLength(2);
    // After a successful open the backoff starts over.
    ws.drop();
    const n = FakeWS.instances.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeWS.instances.length).toBe(n + 1);
    api.dispose();
  });

  it('dispose stops reconnecting', async () => {
    vi.useFakeTimers();
    const { api } = client();
    void api.ready();
    await vi.advanceTimersByTimeAsync(0);
    FakeWS.instances[0]!.open();
    api.dispose();
    expect(api.connected).toBe(false);
    await vi.advanceTimersByTimeAsync(20000);
    expect(FakeWS.instances).toHaveLength(1);
  });
});
