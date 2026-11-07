/**
 * Review round 2 (data safety): two tabs on one file, typing in both, co-author edits reloaded from disk
 * (doc.replace) and socket drops + reconnects, all at once. Real server (createServer: Fastify + ws hub +
 * DocService), the REAL web DocSync / SyncCore over real WebSockets (only the EditorView is replaced by an
 * EditorState holder). No doc.flush (see data-flush-ack.test.ts) and no debounced disk write during the run
 * (see data-disk-overwrite.test.ts), so neither known problem is involved.
 *
 * At the end every token typed in either tab and every co-author line must be in the server text (or in a
 * .paper/conflicts copy), and both tabs must show the server text. Tokens are only ever inserted right
 * after a space, so a token found inside another word was put at the wrong place by a rebase.
 *
 * Observed (timing-dependent, seeds 1-40, ~5 of 40 fail per run):
 *  - a single never-sent token lost on reconnect (seeds 8, 19, 21, 22, 27: data-reconnect-unsent.test.ts);
 *  - typed tokens placed INSIDE a co-author's word ("c15y11zqa15x95q zqa15x94q w"), which then fails the
 *    co-author check (seeds 14, 15, 18): the tab's rebased change is applied by the server at a position
 *    that, in the server's text, is inside another word;
 *  - in about half of the seeds an append before \end{document} cannot be merged into the unsaved mirror
 *    (diff-match-patch locates a hunk only within Match_Distance * Match_Threshold = 500 characters of
 *    its disk position) and the disk text replaces the editor text (local text in .paper/conflicts).
 * R2_SEEDS=1,2,... picks seeds; R2_LOGDIR=<dir> writes per-seed logs and diagnostics.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChangeSet, EditorState, type TransactionSpec } from '@codemirror/state';
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
  sentLog: string[] = [];
  /** Diagnostics: the sender's state when each doc.change went out (keyed by the change JSON). */
  static sentState = new Map<string, unknown>();
  core: { ackedVersion: number; ackedText: unknown; localVersion: number; epoch: number; log: Array<{ baseVersion: number; sent: boolean }> } | null = null;
  send(m: ClientMessage): void {
    if (process.env.R2_LOGDIR && m.type === 'doc.change' && this.core) {
      const c = this.core;
      WsApi.sentState.set(JSON.stringify(m.changes), { tab: this.clientId, base: m.baseVersion, epoch: m.epoch, ackedVersion: c.ackedVersion, localVersion: c.localVersion, coreEpoch: c.epoch, ackedText: String(c.ackedText), log: c.log.map((e) => [e.baseVersion, e.sent]), at: Date.now() });
    }
    if (process.env.R2_LOGDIR && m.type === 'doc.change') {
      const j = JSON.stringify(m.changes);
      // a change that deletes text (the fuzz only types insertions)
      const dels = (m.changes as unknown[]).filter((x) => Array.isArray(x) && (x as unknown[]).length >= 1 && (x as unknown[])[0] !== 0 && typeof (x as unknown[])[0] === 'number');
      if (dels.length) this.sentLog.push(`base=${m.baseVersion} epoch=${m.epoch} DELETES ${j.slice(0, 300)} @ ${(new Error().stack ?? '').split('\n').slice(2, 8).join(' <- ')}`);
    }
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
  /** Diagnostics (R2_LOGDIR): every dispatch that removes a typed token or a co-author line, with its stack. */
  vanished: Array<{ gone: string[]; stack: string }> = [];
  dispatch(spec: TransactionSpec): void {
    const tr = this.state.update(spec);
    if (process.env.R2_LOGDIR && tr.docChanged) {
      const re = /zq[ab]\d+x\d+q|c\d+y\d+w/g;
      const after = new Set(tr.state.doc.toString().match(re) ?? []);
      const gone = [...new Set(this.state.doc.toString().match(re) ?? [])].filter((t) => !after.has(t));
      if (gone.length) this.vanished.push({ gone, stack: (new Error().stack ?? '').split('\n').slice(2, 9).join(' <- ') });
    }
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
const misplaced: unknown[] = [];
const serverHistory: Record<number, string> = {};
async function fresh(): Promise<void> {
  for (const a of apis.splice(0)) a.close();
  await server?.close();
  await ctx?.close();
  project?.cleanup();
  busNotices.length = 0;
  misplaced.length = 0;
  for (const k of Object.keys(serverHistory)) delete serverHistory[Number(k)];
  project = await makeTempProject();
  await initProject(project.root, { repo: project.repoDir, skill: SKILL_DIR });
  ctx = await createCtx({ root: project.root, fake: true, logLevel: 'error', watch: false, lintSidecar: false, docs: { segmentDebounceMs: 20, writeDebounceMs: 600_000 } });
  server = await createServer({ ctx, port: 0, pingIntervalMs: 600_000 });
  ctx.bus.subscribe((m) => {
    if (m.type === 'notice') busNotices.push(m.message);
    if (process.env.R2_LOGDIR && (m.type === 'doc.replace' || m.type === 'doc.remoteChange')) {
      const st = ctx.docs.get('main.tex');
      if (st) serverHistory[st.version] = `${m.type}: ${st.text}`;
    }
  });
  if (process.env.R2_LOGDIR) {
    // diagnostics: a typed token must land right after a space (the fuzz types only there)
    const docs = ctx.docs as unknown as { applyClientChange: (msg: { changes: unknown; baseVersion: number; epoch?: number; file: string }, o?: { clientId: string }) => Promise<boolean> };
    const orig = docs.applyClientChange.bind(docs);
    docs.applyClientChange = async (msg, o) => {
      const before = ctx.docs.get('main.tex')?.text ?? '';
      const ok = await orig(msg, o);
      if (ok) {
        const cs = ChangeSet.fromJSON(msg.changes);
        cs.iterChanges((fromA, _toA, _fromB, _toB, ins) => {
          const t = ins.toString();
          if (/^zq[ab]\d+x\d+q $/.test(t) && fromA > 0 && before[fromA - 1] !== ' ') {
            misplaced.push({ token: t, from: fromA, around: before.slice(fromA - 30, fromA + 30), base: msg.baseVersion, epoch: msg.epoch, origin: o?.clientId, sender: WsApi.sentState.get(JSON.stringify(msg.changes)) });
          }
        });
      }
      return ok;
    };
  }
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
  api.core = ed.sync.core as never;
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
      // R2_FIXK=1 (diagnostics): what the reconnect heuristic would do if it only considered sent entries
      const pend0 = (core.log as Array<{ baseVersion: number; sent: boolean }>).find((e) => e.baseVersion >= (core.ackedVersion as number));
      const o2 = process.env.R2_FIXK && pend0 && !pend0.sent ? { ...(opts as object), reconnect: false } : opts;
      const res = orig(snap, local, o2);
      ed.vanished.push({ gone: [], stack: `reconcile mode=${res.mode} snapV=${(snap as { version: number }).version} acked=${before.ackedVersion} ackedText=${before.ackedText === 'null' ? 'null' : 'set'} pending=${before.log.filter((e) => e.baseVersion >= (before.ackedVersion as number)).length} send=${JSON.stringify((res as unknown as { send: unknown[] }).send).slice(0, 200)} diff=${JSON.stringify((res as unknown as { diff: { toJSON(): unknown } | null }).diff?.toJSON() ?? null).slice(0, 300)}` });
      const after = res.remote ? res.remote.apply(ed.state.doc).toString() : String(local);
      const toks = (String(local).match(/zq[ab]\d+x\d+q/g) ?? []).filter((t) => !after.includes(t));
      if (toks.length) writeFileSync(join(process.env.R2_LOGDIR!, `reconcile-${name}-${Date.now()}.json`), JSON.stringify({ toks, mode: res.mode, before }));
      return res;
    };
  }
  return { name, api, ed, notices, down: false };
}

const settled = (t: Tab) => t.ed.sync.core.pending().length === 0 && !t.ed.sync.core.queuedReplace && !t.ed.sync.core.behind;

const SEEDS = (process.env.R2_SEEDS ?? '8,14,15,18,19,21,22,27').split(',').map(Number);

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
  const vanished = tabs.map((t) => `${t.name}: ${t.ed.vanished.map((v) => `${v.gone.length ? 'GONE ' : ''}${v.gone.slice(0, 6).join(',')}${v.gone.length > 6 ? `(+${v.gone.length - 6})` : ''} @ ${v.stack}`).join('\n   ')}`).join('\n');
  const sent = tabs.map((t) => `${t.name} sent:\n   ${t.api.sentLog.join('\n   ')}`).join('\n');
  if (process.env.R2_LOGDIR && misplaced.length) writeFileSync(join(process.env.R2_LOGDIR, `misplaced-${seed}.json`), JSON.stringify({ misplaced, serverHistory }, null, 1));
  const ctxLog = `vanished:\n${vanished}\n${sent}\n${log.join('\n')}\nnotices: ${tabs.map((t) => t.notices.join(' | ')).join(' || ')}\nserver notices: ${busNotices.join(' | ')}\nconflict copies: ${copies.length}`;
  if (process.env.R2_LOGDIR) writeFileSync(join(process.env.R2_LOGDIR, `fuzz-${seed}.log`), `${ctxLog}\n\nREPORT ${JSON.stringify(report)}\n\nSERVER\n${serverText}`);
  expect(report, ctxLog.slice(-4000)).toEqual({ lostTokens: [], lostCoauthor: [], duplicated: [], tabsMatchServer: [true, true] });
}, 120_000);
