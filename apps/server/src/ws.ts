/**
 * The one WebSocket (/ws): client messages are validated with core ClientMessage and handled in
 * order per socket (a doc.change is always applied before the next message of the same socket);
 * server messages go through a per-socket send queue with backpressure. Every bus event is broadcast
 * to every socket.
 *
 *   hello           -> welcome { serverVersion, fakeLlm, project }
 *   doc.open        -> doc.snapshot (and a cache pre-warm of the AI routes)
 *   doc.change      -> doc.ack (to the sender) or, on a version mismatch / unreadable change, a fresh
 *                      doc.snapshot; sentences.patch follows on the bus after re-segmentation
 *   doc.flush       -> pending segmentation and disk write now; then doc.ack with the current version
 *   ghost.request   -> ctx.llm.handleGhostRequest (not awaited: never blocks the document queue)
 *   ghost.cancel    -> ctx.llm.cancelGhost;  ghost.feedback -> ctx.llm.ghostFeedback
 *
 * Keepalive: a ping every 30 s; a socket that did not answer the previous ping is terminated.
 * Authentication (token, Host, Origin) happens in server.ts before the upgrade.
 */
import type { WebSocket } from 'ws';
import { ClientMessage, type ServerMessage } from '@paper-copilot/core';
import { HttpError, type Ctx } from './contracts';
import { SERVER_VERSION } from './version';

export interface WsHubOptions {
  pingIntervalMs?: number;
  /** Close a socket whose unsent queue exceeds this many messages (a stuck client). */
  maxQueue?: number;
  /** Pause sending while ws.bufferedAmount is above this. */
  highWaterBytes?: number;
}

export interface WsHub {
  attach(socket: WebSocket): void;
  readonly size: number;
  close(): void;
}

interface Client {
  socket: WebSocket;
  queue: string[];
  /** Waiting for the socket buffer to drain. */
  waiting: boolean;
  alive: boolean;
  inbox: Promise<void>;
  closed: boolean;
}

const MAX_FRAME = 32 * 1024 * 1024;

export function createWsHub(ctx: Ctx, opts: WsHubOptions = {}): WsHub {
  const clients = new Set<Client>();
  const maxQueue = opts.maxQueue ?? 20_000;
  const high = opts.highWaterBytes ?? 8 * 1024 * 1024;
  const log = ctx.log;

  const pump = (c: Client): void => {
    if (c.closed || c.waiting) return;
    while (c.queue.length) {
      if (c.socket.readyState !== c.socket.OPEN) return;
      if (c.socket.bufferedAmount > high) {
        c.waiting = true;
        setTimeout(() => {
          c.waiting = false;
          pump(c);
        }, 20);
        return;
      }
      c.socket.send(c.queue.shift()!, (err) => {
        if (err) log.debug('ws: send failed', String(err));
      });
    }
  };

  const send = (c: Client, msg: ServerMessage): void => {
    if (c.closed) return;
    if (c.queue.length >= maxQueue) {
      log.warn('ws: client is not reading; closing it');
      c.closed = true;
      try {
        c.socket.close(1013, 'send queue overflow');
      } catch {
        c.socket.terminate();
      }
      return;
    }
    let frame: string;
    try {
      frame = JSON.stringify(msg);
    } catch (e) {
      log.error('ws: cannot serialize a message', String(e));
      return;
    }
    c.queue.push(frame);
    pump(c);
  };

  const unsubscribe = ctx.bus.subscribe((msg) => {
    for (const c of clients) send(c, msg);
  });

  const notice = (c: Client, level: 'info' | 'warn' | 'error', message: string) => send(c, { type: 'notice', level, message });

  const snapshotOrNotice = (c: Client, file: string): void => {
    try {
      send(c, ctx.docs.snapshotMessage(file));
    } catch (e) {
      notice(c, 'error', `Cannot send ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handle = async (c: Client, msg: ClientMessage): Promise<void> => {
    switch (msg.type) {
      case 'hello':
        send(c, { type: 'welcome', serverVersion: SERVER_VERSION, fakeLlm: ctx.fakeLlm, project: ctx.config });
        return;
      case 'doc.open': {
        const st = await ctx.docs.open(msg.file);
        snapshotOrNotice(c, st.file);
        try {
          void Promise.resolve(ctx.llm.prewarm()).catch((e) => log.debug('prewarm failed', String(e)));
        } catch (e) {
          log.debug('prewarm failed', String(e));
        }
        return;
      }
      case 'doc.change': {
        const ok = await ctx.docs.applyClientChange(msg);
        if (ok) {
          // ack before the re-segmentation pass of an annotated change (it runs on the next macrotask)
          send(c, { type: 'doc.ack', file: msg.file, version: msg.baseVersion + 1 });
        } else {
          if (!ctx.docs.get(msg.file)) await ctx.docs.open(msg.file);
          snapshotOrNotice(c, msg.file);
        }
        return;
      }
      case 'doc.flush': {
        await ctx.docs.flush(msg.file);
        const st = ctx.docs.get(msg.file);
        if (st) send(c, { type: 'doc.ack', file: st.file, version: st.version });
        return;
      }
      case 'ghost.request':
        void ctx.llm
          .handleGhostRequest(msg, (m) => send(c, m))
          .catch((e) => send(c, { type: 'ghost.error', requestId: msg.requestId, message: e instanceof Error ? e.message : String(e) }));
        return;
      case 'ghost.cancel':
        ctx.llm.cancelGhost(msg.requestId);
        return;
      case 'ghost.feedback':
        ctx.llm.ghostFeedback(msg);
        return;
    }
  };

  const onFrame = (c: Client, data: unknown, isBinary: boolean): void => {
    if (isBinary) {
      notice(c, 'warn', 'binary frames are not supported');
      return;
    }
    const raw = Array.isArray(data) ? Buffer.concat(data as Buffer[]).toString('utf8') : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      notice(c, 'error', 'malformed message (not JSON)');
      return;
    }
    const parsed = ClientMessage.safeParse(json);
    if (!parsed.success) {
      const t = json && typeof json === 'object' ? String((json as { type?: unknown }).type) : '?';
      notice(c, 'error', `invalid ${t} message: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
      return;
    }
    const msg = parsed.data;
    c.inbox = c.inbox
      .then(() => handle(c, msg))
      .catch((e) => {
        const m = e instanceof HttpError || e instanceof Error ? e.message : String(e);
        log.warn(`ws: ${msg.type} failed`, m);
        notice(c, 'error', `${msg.type} failed: ${m}`);
        if (msg.type === 'doc.change' && ctx.docs.get(msg.file)) snapshotOrNotice(c, msg.file);
      });
  };

  const timer = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.closed = true;
        c.socket.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.socket.ping();
      } catch {
        /* closing */
      }
    }
  }, opts.pingIntervalMs ?? 30_000);
  timer.unref();

  return {
    attach(socket) {
      const c: Client = { socket, queue: [], waiting: false, alive: true, inbox: Promise.resolve(), closed: false };
      clients.add(c);
      socket.on('pong', () => (c.alive = true));
      socket.on('message', (data, isBinary) => {
        c.alive = true;
        const size = Buffer.isBuffer(data) ? data.length : Array.isArray(data) ? data.reduce((a, b) => a + b.length, 0) : (data as ArrayBuffer).byteLength;
        if (size > MAX_FRAME) {
          notice(c, 'error', 'message too large');
          return;
        }
        onFrame(c, data, isBinary);
      });
      socket.on('close', () => {
        c.closed = true;
        clients.delete(c);
      });
      socket.on('error', (e) => log.debug('ws: socket error', String(e)));
    },
    get size() {
      return clients.size;
    },
    close() {
      clearInterval(timer);
      unsubscribe();
      for (const c of clients) {
        c.closed = true;
        try {
          c.socket.close(1001, 'server shutting down');
        } catch {
          c.socket.terminate();
        }
      }
      clients.clear();
    },
  };
}
