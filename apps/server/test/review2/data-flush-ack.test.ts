/**
 * Review round 2 (data safety): Cmd/Ctrl+S (doc.flush) during a disk reload erases the next keystrokes.
 *
 * ws.ts answers doc.flush with `doc.ack { version: st.version }`: the server's CURRENT version, read after
 * `await ctx.docs.flush(file)`. That await waits for an external reload in progress (DocService.writeNow:
 * "an external reload owns the mirror until it has replaced it"), and the reload bumps the version and
 * broadcasts doc.replace. The ack therefore covers a version the client did not produce. SyncCore.ack(v)
 * treats every pending entry with baseVersion < v as acknowledged; a keystroke typed right after Cmd+S
 * (sent after the flush, so the server will reject it as stale) is marked acknowledged, the doc.replace
 * that was queued behind it is applied (drainReplace -> applyReplace diffs the editor text to the replace
 * text), and the keystroke disappears from the editor; the snapshot that answers the rejected change then
 * matches the editor and nothing brings the text back. No notice, no conflict copy.
 *
 * Real server (createServer: Fastify + ws hub + DocService) and the REAL web DocSync / SyncCore over a real
 * WebSocket; only the EditorView is replaced by an EditorState holder (DocSync uses state + dispatch).
 * The co-author's edit reaches disk and DocService.reloadFromDisk runs exactly as the file watcher calls it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
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
  private ws: WebSocket;
  private readyP: Promise<void>;
  constructor(url: string, id: string) {
    this.clientId = id;
    this.ws = new WebSocket(url);
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
      this.ws.once('open', () => this.ws.send(JSON.stringify({ type: 'hello', clientId: id })));
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
    this.ws.send(JSON.stringify(m));
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
  server = await createServer({ ctx, port: 0, pingIntervalMs: 60_000 });
});

afterAll(async () => {
  for (const a of apis) a.close();
  await server?.close();
  await ctx?.close();
  project?.cleanup();
});

async function openTab(id: string): Promise<{ api: WsApi; ed: Editor; notices: string[] }> {
  const api = new WsApi(`ws://127.0.0.1:${server.port}/ws?token=${encodeURIComponent(ctx.token)}`, id);
  apis.push(api);
  await api.ready();
  const ed = new Editor();
  const notices: string[] = [];
  ed.sync = new DocSync(api as never, 'main.tex', {
    view: () => ed as never,
    loaded: () => (ed.loaded = true),
    notice: (_l, m) => notices.push(m),
  });
  ed.sync.start();
  for (let i = 0; i < 200 && !ed.loaded; i++) await sleep(10);
  expect(ed.loaded).toBe(true);
  return { api, ed, notices };
}

async function quiet(ed: Editor): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (ed.sync.core.pending().length === 0 && !ed.sync.core.queuedReplace) return;
    await sleep(10);
  }
}

it('a keystroke typed right after Cmd+S, while a co-author edit is being reloaded from disk, is kept', async () => {
  const { api, ed, notices } = await openTab('tab-a');
  const disk = join(ctx.paths.tex, 'main.tex');
  const results: Array<{ attempt: number; kept: boolean; flushAck: number | null; replace: number | null; order: string }> = [];

  for (let attempt = 0; attempt < 3; attempt++) {
    // the author types a word and waits for its ack (an unsaved edit in the mirror)
    ed.type('This lead holds', `w${attempt} `);
    await quiet(ed);
    const before = api.received.length;

    // a co-author's edit lands on disk (Overleaf sync / git pull in a terminal); the watcher reloads it
    const raw = readFileSync(disk, 'utf8');
    const sentence = raw.includes('every particle species') ? 'every particle species' : 'each particle species';
    writeFileSync(disk, raw.replace(sentence, sentence.startsWith('every') ? 'each particle species' : 'every particle species'));
    const reload = ctx.docs.reloadFromDisk('main.tex', 'external');

    // meanwhile: Cmd+S (ops.flush -> doc.flush), then the next keystrokes
    ed.sync.sendOrdered({ type: 'doc.flush', file: 'main.tex', version: ed.sync.core.localVersion });
    const marker = `keptmarker${attempt}`;
    ed.type('This lead holds', `${marker} `);

    await reload;
    await sleep(300);
    await quiet(ed);
    await ctx.docs.flush('main.tex');
    const msgs = api.received.slice(before);
    const flushAck = msgs.filter((m) => m.type === 'doc.ack').map((m) => (m as { version: number }).version).pop() ?? null;
    const replace = msgs.find((m) => m.type === 'doc.replace') as { version: number } | undefined;
    const serverText = ctx.docs.get('main.tex')!.text;
    // observed order on the tab's socket: doc.replace v (without the marker), doc.ack v (the flush), doc.snapshot v
    const order = msgs.filter((m) => ['doc.replace', 'doc.ack', 'doc.snapshot'].includes(m.type)).map((m) => `${m.type}@${(m as { version: number }).version}`);
    results.push({ attempt, kept: serverText.includes(marker) && ed.text.includes(marker), flushAck, replace: replace?.version ?? null, order: order.join(' ') });
    // the editor and the server always agree (so the loss is silent: nothing is left to reconcile)
    expect(ed.text).toBe(serverText);
  }
  const conflicts = (() => {
    try {
      return readFileSync(join(ctx.paths.paper, 'conflicts'), 'utf8');
    } catch {
      return '';
    }
  })();
  expect(conflicts).toBe('');
  // today: the attempts in which the flush ack covered the reload's version lose the marker
  expect(results.filter((r) => !r.kept), `${JSON.stringify(results)}; notices: ${JSON.stringify(notices)}`).toEqual([]);
}, 60_000);
