/**
 * Unit spans stay true to the text through the real WebSocket path (doc.change -> mapUnits -> debounced
 * re-segmentation). Found by e2e/soak.mjs (seed 11): an undo replaced "\nThe gain" (the first characters of
 * a sentence plus the newline before it) with " "; the change's new range ended exactly on the sentence's
 * new start, the segmentation pass took its untouched fast path and kept the old textNorm, so the unit's
 * span no longer held its own text.
 *
 * After every change (seeded, edits concentrated on sentence edges): every unit span is a valid slice that
 * normalizes to the unit's textNorm, the spans are exactly the sentences of a fresh segmentation, ids are
 * unique, and everAi never goes from true to false.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ChangeSet } from '@codemirror/state';
import { normalizeForHash, segment, ServerMessage } from '@paper-copilot/core';
import { createCtx, type AppCtx } from '../src/ctx';
import { createServer, type PaperServer } from '../src/server';
import { initProject } from '../src/project/init';
import { makeTempProject, SKILL_DIR, type TempProject } from './helpers/ctx';

type Msg<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

class Client {
  private msgs: ServerMessage[] = [];
  private waiters: Array<{ pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  constructor(public ws: WebSocket) {
    ws.on('message', (d) => {
      const m = ServerMessage.parse(JSON.parse(String(d)));
      const w = this.waiters.find((x) => x.pred(m));
      if (w) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(m);
      } else this.msgs.push(m);
    });
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  next<T extends ServerMessage['type']>(type: T, timeoutMs = 5000): Promise<Msg<T>> {
    const i = this.msgs.findIndex((m) => m.type === type);
    if (i >= 0) return Promise.resolve(this.msgs.splice(i, 1)[0] as Msg<T>);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
      this.waiters.push({
        pred: (m) => m.type === type,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m as Msg<T>);
        },
      });
    });
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('ws protocol: unit spans hold their own text after every change', () => {
  let project: TempProject;
  let ctx: AppCtx;
  let server: PaperServer;
  let c: Client;

  beforeAll(async () => {
    project = await makeTempProject();
    await initProject(project.root, { repo: project.repoDir, skill: SKILL_DIR });
    ctx = await createCtx({ root: project.root, fake: true, logLevel: 'error', watch: false, lintSidecar: false, docs: { segmentDebounceMs: 5, writeDebounceMs: 10_000 } });
    server = await createServer({ ctx, port: 0, pingIntervalMs: 60_000 });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${encodeURIComponent(ctx.token)}`);
    c = new Client(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    c.send({ type: 'hello', clientId: 'units' });
    await c.next('welcome');
  });

  afterAll(async () => {
    c?.ws.close();
    await server?.close();
    await ctx?.close();
    project?.cleanup();
  });

  let version = 0;
  let text = '';
  const everAi = new Set<string>();

  async function openDoc(): Promise<void> {
    c.send({ type: 'doc.open', file: 'main.tex' });
    const snap = await c.next('doc.snapshot');
    version = snap.version;
    text = snap.text;
  }

  /** Send one change and wait until the server applied and segmented it (doc.flush is answered in order). */
  async function change(from: number, to: number, insert: string): Promise<void> {
    const cs = ChangeSet.of([{ from, to, insert }], text.length);
    c.send({ type: 'doc.change', file: 'main.tex', baseVersion: version, changes: cs.toJSON(), annotation: null, epoch: 0 });
    const ack = await c.next('doc.ack');
    expect(ack.version).toBe(version + 1);
    version = ack.version;
    text = text.slice(0, from) + insert + text.slice(to);
    c.send({ type: 'doc.flush', file: 'main.tex', version: 0 });
    await c.next('doc.ack');
  }

  function check(step: string): void {
    const st = ctx.docs.get('main.tex')!;
    expect(st.text, step).toBe(text);
    const ids = new Set<string>();
    for (const u of st.units) {
      expect(ids.has(u.id), `${step}: duplicate id ${u.id}`).toBe(false);
      ids.add(u.id);
      expect(u.start >= 0 && u.start <= u.end && u.end <= text.length, `${step}: span ${u.start}-${u.end}`).toBe(true);
      expect(normalizeForHash(text.slice(u.start, u.end)), `${step}: unit ${u.id} ${u.start}-${u.end}`).toBe(u.textNorm);
      if (u.everAi) everAi.add(u.id);
      else expect(everAi.has(u.id), `${step}: everAi cleared on ${u.id}`).toBe(false);
    }
    const want = segment(text)
      .sentences.map((s) => `${s.start}-${s.end}`)
      .sort();
    const have = st.units.map((u) => `${u.start}-${u.end}`).sort();
    expect(have, step).toEqual(want);
  }

  it('a replacement that swallows the first characters of a sentence updates its textNorm (soak seed 11)', async () => {
    await openDoc();
    check('open');
    // Two sentences glued without a space, as an accepted ghost left them, then the undo of the typed prefix.
    const at = text.indexOf('This lead holds');
    expect(at).toBeGreaterThan(0);
    await change(at, at, 'The gain');
    check('glued prefix');
    await change(at - 1, at + 'The gain'.length, ' ');
    check('prefix removed by a replacement');
    // the mirror image: a replacement that swallows the last characters of a sentence and the space after it
    const u = ctx.docs.get('main.tex')!.units.find((x) => x.kind === 'prose' && x.end - x.start > 30 && text[x.end] === ' ')!;
    await change(u.end - 3, u.end + 1, '.');
    check('suffix removed by a replacement');
  });

  it('seeded random edits at sentence edges keep every span, textNorm and id valid', async () => {
    const rand = mulberry32(20261106);
    const ri = (n: number) => Math.floor(rand() * n);
    const INSERTS = ['', ' ', '\n', '. ', 'The gain', ' more words', '.', 'x', '\n\n', 'Fig.~\\ref{fig:eff}. ', ' and the rate'];
    for (let step = 0; step < 120; step++) {
      const st = ctx.docs.get('main.tex')!;
      const prose = st.units.filter((u) => u.kind === 'prose');
      const u = prose[ri(prose.length)]!;
      const edge = rand() < 0.5 ? u.start : u.end;
      const from = Math.max(0, Math.min(text.length, edge - ri(4)));
      const to = Math.min(text.length, from + (rand() < 0.3 ? 0 : ri(12)));
      await change(from, to, INSERTS[ri(INSERTS.length)]!);
      check(`step ${step} (${from}-${to})`);
    }
  });
});
