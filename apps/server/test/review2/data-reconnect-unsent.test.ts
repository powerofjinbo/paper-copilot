/**
 * Review round 2 (data safety): after a socket reconnect, a change the tab NEVER SENT is thrown away when
 * another tab (or a disk reload) changed the file meanwhile.
 *
 * SyncCore.reconcileInner, same-process reconnect: "some pending entries may have been applied with their
 * acks lost: assume the k first were applied when that explains the snapshot best (k <= V - ackedVersion)".
 * The candidates are not limited to entries that were actually sent (`sent: true`, at most the one in
 * flight): an entry typed while the socket was down (or queued behind the change in flight) can never have
 * reached the server, yet it is taken as "applied" whenever the dmp diff from "acked + entry" to the snapshot
 * happens to be smaller than the diff from "acked" -- e.g. the other tab typed similar text near the same
 * place ("nearly " vs "clearly ": replacing "cl" by "n" is cheaper than inserting "nearly "). The rebase then
 * computes the server side from that wrong base, and the remote change it applies to the editor DELETES the
 * author's word. Tabs and server agree afterwards; no notice, no conflict copy.
 *
 * Real server (createServer: Fastify + ws hub + DocService) and the REAL web DocSync / SyncCore over real
 * WebSockets (only the EditorView is replaced by an EditorState holder). Found by data-two-tabs-fuzz
 * (seeds 8, 19, 21, 22, 27 lose single tokens through this path).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import { afterAll, beforeAll, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ClientMessage, ServerMessage } from '@paper-copilot/core';
import { createCtx, type AppCtx } from '../../src/ctx';
import { createServer, type PaperServer } from '../../src/server';
import { initProject } from '../../src/project/init';
import { makeTempProject, SKILL_DIR, type TempProject } from '../helpers/ctx';
import { DocSync } from '../../../web/src/editor/sync/docSync';
import { unitsField } from '../../../web/src/editor/units';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The subset of the web ApiClient that DocSync uses, over a real WebSocket. */
class WsApi {
  connected = false;
  readonly clientId: string;
  received: ServerMessage[] = [];
  private handlers = new Map<string, Set<(m: never) => void>>();
  private conn = new Set<(c: boolean) => void>();
  private ws!: WebSocket;
  private readyP!: Promise<void>;
  constructor(
    private readonly url: string,
    id: string,
  ) {
    this.clientId = id;
    this.connect();
  }
  /** Drop the socket (a network blip, laptop sleep): DocSync sees connected=false. */
  drop(): void {
    const ws = this.ws;
    ws.removeAllListeners('message');
    ws.terminate();
    this.connected = false;
    for (const f of this.conn) f(false);
  }
  /** A new socket to the same server (DocSync re-opens the file and reconciles the snapshot). */
  reconnect(): Promise<void> {
    this.connect();
    return this.readyP;
  }
  private connect(): void {
    this.ws = new WebSocket(this.url);
    this.readyP = new Promise((resolve, reject) => {
      this.ws.once('error', reject);
      this.ws.on('message', (d) => {
        const m = JSON.parse(String(d)) as ServerMessage;
        this.received.push(m);
        if (m.type === 'welcome') {
          this.connected = true;
          for (const f of this.conn) f(true);
          resolve();
        }
        for (const h of this.handlers.get(m.type) ?? []) h(m as never);
      });
      this.ws.once('open', () => this.ws.send(JSON.stringify({ type: 'hello', clientId: this.clientId })));
    });
  }
  ready(): Promise<void> {
    return this.readyP;
  }
  on(type: string, fn: (m: never) => void): () => void {
    let s = this.handlers.get(type);
    if (!s) this.handlers.set(type, (s = new Set()));
    s.add(fn);
    return () => s!.delete(fn);
  }
  onConnection(fn: (c: boolean) => void): () => void {
    this.conn.add(fn);
    return () => this.conn.delete(fn);
  }
  send(m: ClientMessage): void {
    if (this.connected && this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(m));
  }
  close(): void {
    this.ws.close();
  }
}

/** An editor: the EditorState DocSync reads and dispatches to; local transactions go to DocSync.onUpdate. */
class Editor {
  state = EditorState.create({ doc: '', extensions: [unitsField, EditorState.lineSeparator.of('\n')] });
  sync!: DocSync;
  loaded = false;
  dispatch(spec: TransactionSpec): void {
    const tr = this.state.update(spec);
    this.state = tr.state;
    this.sync?.onUpdate({ transactions: [tr] } as never);
  }
  get text(): string {
    return this.state.doc.toString();
  }
  /** The author types `s` at the position of `before` (one transaction, like one keystroke burst). */
  type(before: string, s: string): void {
    const at = this.text.indexOf(before);
    expect(at).toBeGreaterThanOrEqual(0);
    this.dispatch({ changes: { from: at, insert: s } });
  }
}


let project: TempProject;
let ctx: AppCtx;
let server: PaperServer;
const apis: WsApi[] = [];

beforeAll(async () => {
  project = await makeTempProject();
  await initProject(project.root, { repo: project.repoDir, skill: SKILL_DIR });
  ctx = await createCtx({ root: project.root, fake: true, logLevel: 'error', watch: false, lintSidecar: false, docs: { segmentDebounceMs: 20, writeDebounceMs: 1000 } });
  server = await createServer({ ctx, port: 0, pingIntervalMs: 600_000 });
});

afterAll(async () => {
  for (const a of apis) a.close();
  await server?.close();
  await ctx?.close();
  project?.cleanup();
});

async function openTab(name: string): Promise<{ api: WsApi; ed: Editor; notices: string[] }> {
  const api = new WsApi(`ws://127.0.0.1:${server.port}/ws?token=${encodeURIComponent(ctx.token)}`, name);
  apis.push(api);
  await api.ready();
  const ed = new Editor();
  const notices: string[] = [];
  ed.sync = new DocSync(api as never, 'main.tex', { view: () => ed as never, loaded: () => (ed.loaded = true), notice: (_l, m) => notices.push(m) });
  ed.sync.start();
  for (let i = 0; i < 300 && !ed.loaded; i++) await sleep(10);
  expect(ed.loaded).toBe(true);
  return { api, ed, notices };
}

async function settle(ed: Editor): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const c = ed.sync.core;
    if (c.pending().length === 0 && !c.queuedReplace && !c.behind) return;
    await sleep(10);
  }
}

it('a word typed while the socket was down survives the reconnect when the other tab typed nearby', async () => {
  const a = await openTab('tab-a');
  const b = await openTab('tab-b');
  const anchor = 'The fake-track rate is';
  expect(a.ed.text).toContain(anchor);

  // tab A loses its socket (laptop lid closed and opened, a dropped keep-alive ping, a send-queue overflow)
  a.api.drop();
  // the author keeps typing in tab A: the change cannot be sent
  a.ed.type(anchor, 'clearly ');
  expect(a.ed.sync.core.pending().map((e) => e.sent)).toEqual([false]);
  // meanwhile the same sentence is edited in tab B (or arrives from disk / a pull) and the server applies it
  b.ed.type(anchor, 'nearly ');
  await settle(b.ed);
  expect(ctx.docs.get('main.tex')!.text).toContain('nearly The fake-track rate is');

  // tab A reconnects: DocSync re-opens the file and reconciles the snapshot with its unsent change
  await a.api.reconnect();
  await sleep(300);
  await settle(a.ed);
  await settle(b.ed);
  await sleep(200);

  const server = ctx.docs.get('main.tex')!.text;
  const dir = join(ctx.paths.paper, 'conflicts');
  const copies = existsSync(dir) ? readdirSync(dir).length : 0;
  const line = (t: string) => t.split('\n').find((l) => l.includes(anchor)) ?? '';
  // both tabs and the server agree ...
  expect([a.ed.text === server, b.ed.text === server]).toEqual([true, true]);
  // ... and both words must be there (today: "nearly The fake-track rate is", A's "clearly" is gone, no notice, no copy)
  expect({ clearly: server.includes('clearly'), nearly: server.includes('nearly'), line: line(server).slice(0, 60) }, `notices: ${JSON.stringify(a.notices)}; conflict copies: ${copies}`).toMatchObject({ clearly: true, nearly: true });
}, 30_000);
