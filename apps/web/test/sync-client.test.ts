/**
 * HttpApiClient and document sync across a reconnect: a doc.change that was queued because the socket was
 * already closing (or closed) belongs to the dead socket's text lineage. It is NOT replayed on the next
 * socket (the editor's sync re-sends it from its log after reconciling the new snapshot); every other
 * queued message still is. A change queued before the very first connection is sent as before.
 * Also: the client id the server uses to tag doc.remoteChange is the one sent in `hello`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpApiClient, type WebSocketLike } from '../src/api/client';

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
  get messages(): Array<{ type: string } & Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s));
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const change = (baseVersion: number) => ({ type: 'doc.change' as const, file: 'main.tex', baseVersion, changes: [5, [0, 'x'], 10] as Array<number | Array<number | string>>, annotation: null, epoch: 0 });

describe('HttpApiClient: queued doc.change across a reconnect', () => {
  afterEach(() => {
    FakeWS.instances = [];
    vi.useRealTimers();
  });

  function client() {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ token: 'tok2' }), { status: 200 })) as unknown as typeof fetch;
    return new HttpApiClient({ fetch: fetchFn, metaToken: () => 'tok1', WebSocket: FakeWS, wsBase: 'ws://127.0.0.1:1', clientId: 'web-x', log: () => undefined, backoff: { initialMs: 10, maxMs: 10 } });
  }

  it('a change sent while the socket is closing is dropped at the next open; other queued messages are sent', async () => {
    vi.useFakeTimers();
    const api = client();
    api.send({ type: 'doc.open', file: 'main.tex' });
    void api.ready();
    await flush();
    const ws1 = FakeWS.instances[0]!;
    ws1.open();
    expect(api.connected).toBe(true);
    expect(ws1.messages.map((m) => m.type)).toEqual(['hello', 'doc.open']);
    expect(ws1.messages[0]).toEqual({ type: 'hello', clientId: 'web-x' });
    expect(api.clientId).toBe('web-x');
    // the server died: the browser reports CLOSING before the close event
    ws1.readyState = 2;
    api.send(change(41));
    api.send({ type: 'ghost.cancel', requestId: 'g1' });
    ws1.close();
    expect(api.connected).toBe(false);
    api.send(change(42)); // typed while disconnected (the editor never does this, but the queue must not replay it)
    await vi.advanceTimersByTimeAsync(50);
    const ws2 = FakeWS.instances[1]!;
    expect(ws2).toBeTruthy();
    ws2.open();
    expect(ws2.messages.map((m) => m.type)).toEqual(['hello', 'doc.open', 'ghost.cancel']);
    // later changes on the new socket go out normally
    api.send(change(0));
    expect(ws2.messages.at(-1)?.type).toBe('doc.change');
    api.dispose();
  });

  it('a change queued before the first connection is still sent (no earlier lineage exists)', async () => {
    const api = client();
    api.send({ type: 'doc.open', file: 'main.tex' });
    api.send(change(0));
    void api.ready();
    await flush();
    const ws = FakeWS.instances[0]!;
    ws.open();
    expect(ws.messages.map((m) => m.type)).toEqual(['hello', 'doc.open', 'doc.change']);
    api.dispose();
  });
});
