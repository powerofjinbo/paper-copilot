/**
 * WebSocket protocol hardening (real server, real DocService, fixture project):
 *  - per-socket epoch: a doc.change from a socket that was never sent a snapshot of the file, whose
 *    baseVersion predates the last snapshot/replace sent to that socket, or whose own `epoch` field does,
 *    is never applied; the socket gets a fresh doc.snapshot instead;
 *  - doc.remoteChange: an accepted change is relayed at once to every OTHER socket (not echoed), in order
 *    with the sentences.patch that follows, and a rejected one is not relayed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ChangeSet, Text } from '@codemirror/state';
import { ServerMessage } from '@paper-copilot/core';
import { createCtx, type AppCtx } from '../src/ctx';
import { createServer, type PaperServer } from '../src/server';
import { initProject } from '../src/project/init';
import { makeTempProject, SKILL_DIR, type TempProject } from './helpers/ctx';

type Msg<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

class Client {
  msgs: ServerMessage[] = [];
  all: ServerMessage[] = [];
  private waiters: Array<{ pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  constructor(public ws: WebSocket) {
    ws.on('message', (d) => {
      const m = ServerMessage.parse(JSON.parse(String(d)));
      this.all.push(m);
      this.msgs.push(m);
      for (const w of [...this.waiters])
        if (w.pred(m)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(m);
        }
    });
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  next<T extends ServerMessage['type']>(type: T, pred: (m: Msg<T>) => boolean = () => true, timeoutMs = 5000): Promise<Msg<T>> {
    const seen = this.msgs.find((m) => m.type === type && pred(m as Msg<T>));
    if (seen) {
      this.msgs.splice(this.msgs.indexOf(seen), 1);
      return Promise.resolve(seen as Msg<T>);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
      this.waiters.push({
        pred: (m) => m.type === type && pred(m as Msg<T>),
        resolve: (m) => {
          clearTimeout(t);
          const i = this.msgs.indexOf(m);
          if (i >= 0) this.msgs.splice(i, 1);
          resolve(m as Msg<T>);
        },
      });
    });
  }
  /** Resolves after the server answered every message sent so far (doc.flush is handled in order). */
  async settle(file = 'main.tex'): Promise<void> {
    this.send({ type: 'doc.flush', file, version: 0 });
    await this.next('doc.ack', () => true);
  }
}

function connect(port: number, token: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    const c = new Client(ws);
    ws.once('open', () => resolve(c));
    ws.once('error', reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ws protocol: per-socket epoch and doc.remoteChange', () => {
  let project: TempProject;
  let ctx: AppCtx;
  let server: PaperServer;
  let port: number;
  const open: Client[] = [];

  beforeAll(async () => {
    project = await makeTempProject();
    await initProject(project.root, { repo: project.repoDir, skill: SKILL_DIR });
    ctx = await createCtx({ root: project.root, fake: true, logLevel: 'error', watch: false, lintSidecar: false, docs: { segmentDebounceMs: 20, writeDebounceMs: 50 } });
    server = await createServer({ ctx, port: 0, pingIntervalMs: 60_000 });
    port = server.port;
  });

  afterAll(async () => {
    for (const c of open) c.ws.close();
    await server?.close();
    await ctx?.close();
    project?.cleanup();
  });

  async function tab(id: string, file = 'main.tex'): Promise<{ c: Client; snap: Msg<'doc.snapshot'> }> {
    const c = await connect(port, ctx.token);
    open.push(c);
    c.send({ type: 'hello', clientId: id });
    await c.next('welcome');
    c.send({ type: 'doc.open', file });
    const snap = await c.next('doc.snapshot', (m) => m.file === file);
    return { c, snap };
  }

  const serverText = () => ctx.docs.get('main.tex')!.text;
  const serverVersion = () => ctx.docs.get('main.tex')!.version;

  it('relays an accepted change to the other tab at once (no echo to the sender); applying it converges', async () => {
    const a = await tab('tab-a');
    const b = await tab('tab-b');
    expect(b.snap.version).toBe(a.snap.version);
    const text = a.snap.text;
    const at = text.indexOf('This lead holds');
    expect(at).toBeGreaterThan(0);
    const cs = ChangeSet.of([{ from: at, insert: 'Indeed, ' }], text.length);
    a.c.send({ type: 'doc.change', file: 'main.tex', baseVersion: a.snap.version, changes: cs.toJSON(), annotation: null, epoch: a.snap.version });
    const ack = await a.c.next('doc.ack');
    expect(ack.version).toBe(a.snap.version + 1);
    const rc = await b.c.next('doc.remoteChange');
    expect(rc).toMatchObject({ file: 'main.tex', version: a.snap.version + 1 });
    expect(rc.originClientId.startsWith('tab-a:')).toBe(true);
    const bText = ChangeSet.fromJSON(rc.changes).apply(Text.of(b.snap.text.split('\n'))).toString();
    expect(bText).toBe(serverText());
    // the patch for the new version reaches B after the relayed change, never before it
    await b.c.next('sentences.patch', (m) => m.version === rc.version);
    const iRc = b.c.all.indexOf(rc);
    const iPatch = b.c.all.findIndex((m) => m.type === 'sentences.patch' && m.version >= rc.version);
    expect(iRc).toBeLessThan(iPatch);
    await a.c.settle();
    expect(a.c.all.some((m) => m.type === 'doc.remoteChange')).toBe(false);

    // B continues on top of the relayed change: accepted, relayed back to A
    const cs2 = ChangeSet.of([{ from: 0, insert: '% b\n' }], bText.length);
    b.c.send({ type: 'doc.change', file: 'main.tex', baseVersion: rc.version, changes: cs2.toJSON(), annotation: null, epoch: b.snap.version });
    expect((await b.c.next('doc.ack')).version).toBe(rc.version + 1);
    const back = await a.c.next('doc.remoteChange');
    expect(back.version).toBe(rc.version + 1);
    expect(back.originClientId.startsWith('tab-b:')).toBe(true);
    // an empty change (a version bump) is relayed too, so the other tab's version numbers stay in step
    const empty = ChangeSet.empty(serverText().length);
    a.c.send({ type: 'doc.change', file: 'main.tex', baseVersion: back.version, changes: empty.toJSON(), annotation: null });
    expect((await a.c.next('doc.ack')).version).toBe(back.version + 1);
    expect((await b.c.next('doc.remoteChange')).version).toBe(back.version + 1);
    a.c.ws.close();
    b.c.ws.close();
  });

  it('a rejected (stale) change is not relayed and the sender gets a fresh snapshot', async () => {
    const a = await tab('tab-a2');
    const b = await tab('tab-b2');
    const v = a.snap.version;
    const len = a.snap.text.length;
    a.c.send({ type: 'doc.change', file: 'main.tex', baseVersion: v, changes: ChangeSet.of([{ from: 0, insert: 'A' }], len).toJSON(), annotation: null });
    await a.c.next('doc.ack');
    await b.c.next('doc.remoteChange');
    // B has not applied A's change yet and sends a change on the old version: rejected, not relayed
    b.c.send({ type: 'doc.change', file: 'main.tex', baseVersion: v, changes: ChangeSet.of([{ from: 0, insert: 'B' }], len).toJSON(), annotation: null });
    const snap = await b.c.next('doc.snapshot');
    expect(snap.version).toBe(v + 1);
    expect(snap.text.startsWith('A')).toBe(true);
    await a.c.settle();
    expect(a.c.all.filter((m) => m.type === 'doc.remoteChange')).toHaveLength(0);
    expect(serverText().startsWith('AB')).toBe(false);
    a.c.ws.close();
    b.c.ws.close();
  });

  it('a socket that was never sent a snapshot of the file cannot change it (a change from an older lineage)', async () => {
    const c = await connect(port, ctx.token);
    open.push(c);
    c.send({ type: 'hello', clientId: 'restarted-tab' });
    await c.next('welcome');
    const before = serverText();
    const v = serverVersion();
    // version and length match the server by coincidence: without the epoch rule this would be applied
    c.send({ type: 'doc.change', file: 'main.tex', baseVersion: v, changes: ChangeSet.of([{ from: 0, insert: 'X' }], before.length).toJSON(), annotation: null });
    const snap = await c.next('doc.snapshot');
    expect(snap.version).toBe(v);
    expect(snap.text).toBe(before);
    expect(serverText()).toBe(before);
    // after the snapshot the same change is accepted
    c.send({ type: 'doc.change', file: 'main.tex', baseVersion: snap.version, changes: ChangeSet.of([{ from: 0, insert: '%x\n' }], before.length).toJSON(), annotation: null, epoch: snap.version });
    expect((await c.next('doc.ack')).version).toBe(v + 1);
    // a later change based before that snapshot is refused by the epoch rule
    c.send({ type: 'doc.change', file: 'main.tex', baseVersion: snap.version - 1, changes: ChangeSet.empty(before.length).toJSON(), annotation: null });
    expect((await c.next('doc.snapshot')).version).toBe(v + 1);
    c.ws.close();
  });

  it('a change made before the client saw a doc.replace is refused even when version and length match (epoch field)', async () => {
    const a = await tab('tab-a3');
    await ctx.docs.flush('main.tex');
    const v0 = a.snap.version;
    const disk = join(ctx.paths.tex, 'main.tex');
    const raw = readFileSync(disk, 'utf8');
    // a co-author's same-length edit: "every" -> "EVERY"
    const i = raw.indexOf('every particle species');
    expect(i).toBeGreaterThan(0);
    writeFileSync(disk, raw.slice(0, i) + 'EVERY' + raw.slice(i + 5));
    await ctx.docs.reloadFromDisk('main.tex', 'external');
    const rep = await a.c.next('doc.replace');
    expect(rep.version).toBe(v0 + 1);
    const replaced = serverText();
    expect(replaced.length).toBe(a.snap.text.length);
    // The client typed one character at v0 (rejected: wrong base) and, in violation of one-change-in-flight,
    // a second one based on v0 + 1 of ITS OWN lineage. Version and length match the replaced text.
    a.c.send({ type: 'doc.change', file: 'main.tex', baseVersion: v0, changes: ChangeSet.of([{ from: 5, insert: 'q' }], a.snap.text.length).toJSON(), annotation: null, epoch: v0 });
    const lenAfterQ = a.snap.text.length + 1;
    expect(lenAfterQ).not.toBe(replaced.length);
    // same length as the server text: delete one character and insert one
    a.c.send({ type: 'doc.change', file: 'main.tex', baseVersion: v0 + 1, changes: ChangeSet.of([{ from: 10, to: 11, insert: 'Z' }], replaced.length).toJSON(), annotation: null, epoch: v0 });
    const s1 = await a.c.next('doc.snapshot');
    const s2 = await a.c.next('doc.snapshot');
    expect(s1.version).toBe(v0 + 1);
    expect(s2.version).toBe(v0 + 1);
    expect(serverText()).toBe(replaced);
    expect(serverVersion()).toBe(v0 + 1);
    // once the client has applied the replace (its epoch is the replace version) it can edit again
    a.c.send({ type: 'doc.change', file: 'main.tex', baseVersion: v0 + 1, changes: ChangeSet.of([{ from: 10, to: 11, insert: 'Z' }], replaced.length).toJSON(), annotation: null, epoch: v0 + 1 });
    expect((await a.c.next('doc.ack')).version).toBe(v0 + 2);
    a.c.ws.close();
  });

  it('a change without the epoch field (older client) is still checked against baseVersion only', async () => {
    const a = await tab('tab-a4');
    const v = a.snap.version;
    const t = a.snap.text;
    a.c.send({ type: 'doc.change', file: 'main.tex', baseVersion: v, changes: ChangeSet.of([{ from: 0, insert: '%' }], t.length).toJSON(), annotation: null });
    expect((await a.c.next('doc.ack')).version).toBe(v + 1);
    await sleep(10);
    a.c.ws.close();
  });
});
