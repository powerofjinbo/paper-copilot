/**
 * Review round 2 (data safety): two tabs on one file, typing in both, co-author edits reloaded from disk
 * (doc.replace) and socket drops + reconnects, all at once. Real server (createServer: Fastify + ws hub +
 * DocService), the REAL web DocSync / SyncCore over real WebSockets (only the EditorView is replaced by an
 * EditorState holder). No doc.flush (see data-flush-ack.test.ts) and no debounced disk write during the run
 * (see data-disk-overwrite.test.ts), so neither known problem is involved.
 *
 * At the end every token typed in either tab and every co-author line must be in the server text (or in a
 * .paper/conflicts copy), and both tabs must show the server text.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import { afterAll, expect, it } from 'vitest';
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


/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let project: TempProject;
let ctx: AppCtx;
let server: PaperServer;
const apis: WsApi[] = [];

const busNotices: string[] = [];
async function fresh(): Promise<void> {
  for (const a of apis.splice(0)) a.close();
  await server?.close();
  await ctx?.close();
  project?.cleanup();
  busNotices.length = 0;
  project = await makeTempProject();
  await initProject(project.root, { repo: project.repoDir, skill: SKILL_DIR });
  ctx = await createCtx({ root: project.root, fake: true, logLevel: 'error', watch: false, lintSidecar: false, docs: { segmentDebounceMs: 20, writeDebounceMs: 600_000 } });
  server = await createServer({ ctx, port: 0, pingIntervalMs: 600_000 });
  ctx.bus.subscribe((m) => {
    if (m.type === 'notice') busNotices.push(m.message);
  });
}

afterAll(async () => {
  for (const a of apis) a.close();
  await server?.close();
  await ctx?.close();
  project?.cleanup();
});

interface Tab {
  name: string;
  api: WsApi;
  ed: Editor;
  notices: string[];
  down: boolean;
}

async function openTab(name: string): Promise<Tab> {
  const api = new WsApi(`ws://127.0.0.1:${server.port}/ws?token=${encodeURIComponent(ctx.token)}`, name);
  apis.push(api);
  await api.ready();
  const ed = new Editor();
  const notices: string[] = [];
  ed.sync = new DocSync(api as never, 'main.tex', { view: () => ed as never, loaded: () => (ed.loaded = true), notice: (_l, m) => notices.push(m) });
  ed.sync.start();
  for (let i = 0; i < 300 && !ed.loaded; i++) await sleep(10);
  expect(ed.loaded).toBe(true);
  if (process.env.R2_LOGDIR) {
    // capture the inputs of a reconcile that removes a typed token from the editor (diagnostics only)
    const core = ed.sync.core as unknown as Record<string, unknown> & { reconcile: (...a: unknown[]) => { remote: { apply: (t: unknown) => { toString(): string } } | null; mode: string } };
    const orig = core.reconcile.bind(core);
    core.reconcile = (snap: unknown, local: unknown, opts: unknown) => {
      const before = {
        snapshot: snap,
        localText: local,
        ackedText: String(core.ackedText),
        diskText: String(core.diskText),
        ackedVersion: core.ackedVersion,
        log: (core.log as Array<{ baseVersion: number; changes: { toJSON(): unknown }; sent: boolean }>).map((e) => ({ baseVersion: e.baseVersion, changes: e.changes.toJSON(), sent: e.sent })),
        reconnect: (opts as { reconnect: boolean }).reconnect,
      };
      const res = orig(snap, local, opts);
      const after = res.remote ? res.remote.apply(ed.state.doc).toString() : String(local);
      const toks = (String(local).match(/zq[ab]\d+x\d+q/g) ?? []).filter((t) => !after.includes(t));
      if (toks.length) writeFileSync(join(process.env.R2_LOGDIR!, `reconcile-${name}-${Date.now()}.json`), JSON.stringify({ toks, mode: res.mode, before }));
      return res;
    };
  }
  return { name, api, ed, notices, down: false };
}

const settled = (t: Tab) => t.ed.sync.core.pending().length === 0 && !t.ed.sync.core.queuedReplace && !t.ed.sync.core.behind;

const SEEDS = (process.env.R2_SEEDS ?? '1,2,3,4,5,6').split(',').map(Number);

it.each(SEEDS)('seed %i: two tabs + co-author reloads + reconnects keep every text', async (seed) => {
  await fresh();
  const rand = rng(seed);
  const tabs = [await openTab(`a${seed}`), await openTab(`b${seed}`)];
  const disk = join(ctx.paths.tex, 'main.tex');
  const tokens: string[] = [];
  const coLines: string[] = [];
  const log: string[] = [];
  const reloads: Promise<unknown>[] = [];
  let n = 0;
  for (let step = 0; step < 160; step++) {
    const r = rand();
    const t = tabs[Math.floor(rand() * tabs.length)]!;
    if (r < 0.62) {
      // type a unique token after a random space
      const text = t.ed.text;
      const spaces: number[] = [];
      for (let i = text.indexOf(' '); i >= 0; i = text.indexOf(' ', i + 1)) spaces.push(i);
      const at = spaces[Math.floor(rand() * spaces.length)]! + 1;
      const tok = `zq${t.name}x${n++}q`;
      t.ed.dispatch({ changes: { from: at, insert: `${tok} ` } });
      tokens.push(tok);
      log.push(`${step} type ${tok}@${at} ${t.name}${t.down ? ' (offline)' : ''}`);
    } else if (r < 0.77) {
      // a co-author line lands on disk and is reloaded (what the watcher does)
      const raw = readFileSync(disk, 'utf8');
      const line = `Coauthor sentence number c${seed}y${coLines.length}w is here.`;
      coLines.push(`c${seed}y${coLines.length}w`);
      writeFileSync(disk, raw.replace('\\end{document}', `${line}\n\n\\end{document}`));
      reloads.push(ctx.docs.reloadFromDisk('main.tex', 'external').catch((e) => log.push(`reload failed ${String(e)}`)));
      log.push(`${step} coauthor ${coLines[coLines.length - 1]}`);
    } else if (r < 0.87) {
      if (!t.down) {
        t.api.drop();
        t.down = true;
        log.push(`${step} drop ${t.name}`);
      } else {
        await t.api.reconnect();
        t.down = false;
        log.push(`${step} reconnect ${t.name}`);
      }
    }
    await sleep(Math.floor(rand() * 25));
  }
  for (const t of tabs)
    if (t.down) {
      await t.api.reconnect();
      t.down = false;
    }
  await Promise.all(reloads);
  for (let i = 0; i < 500 && !tabs.every(settled); i++) await sleep(10);
  await sleep(300);
  const serverText = ctx.docs.get('main.tex')!.text;
  const dir = join(ctx.paths.paper, 'conflicts');
  const copies = existsSync(dir) ? readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')) : [];
  const where = (s: string) => (serverText.includes(s) ? 'server' : copies.some((c) => c.includes(s)) ? 'conflict copy' : 'LOST');
  const lostTokens = tokens.filter((x) => where(x) === 'LOST');
  const lostCo = coLines.filter((x) => where(x) === 'LOST');
  const dup = tokens.filter((x) => serverText.split(x).length > 2);
  const report = {
    lostTokens,
    lostCoauthor: lostCo,
    duplicated: dup,
    tabsMatchServer: tabs.map((t) => t.ed.text === serverText),
  };
  const ctxLog = `${log.join('\n')}\nnotices: ${tabs.map((t) => t.notices.join(' | ')).join(' || ')}`;
  if (process.env.R2_LOGDIR) writeFileSync(join(process.env.R2_LOGDIR, `fuzz-${seed}.log`), `${ctxLog}\n\nREPORT ${JSON.stringify(report)}\n\nSERVER\n${serverText}`);
  expect(report, ctxLog.slice(-4000)).toEqual({ lostTokens: [], lostCoauthor: [], duplicated: [], tabsMatchServer: [true, true] });
}, 120_000);
