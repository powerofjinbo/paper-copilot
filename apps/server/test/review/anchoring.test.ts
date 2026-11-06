/**
 * Review (anchoring lens): DocService text safety and sentence identity under concurrency, version
 * mismatches, a crash mid-debounce and external edits while the editor holds pending changes.
 *
 * The browser side is the REAL web sync bookkeeping (apps/web/src/editor/sync/syncCore.ts, the code
 * DocSync runs in the editor), driven exactly as DocSync drives it: every local transaction becomes a
 * doc.change, one at a time; a doc.replace is queued while changes are unacknowledged; a later
 * doc.snapshot is reconciled (replay, rebase of the unacknowledged changes with their annotations, or
 * the restart merge), and the server text the editor had not seen is applied. The server side is the real DocService on a temp copy of
 * the fixture project, with fake downstream services.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import { ClientMessage, diffChanges, normalizeForHash, segment, type ChangeAnnotation, type EditPair, type SentenceUnit, type ServerMessage } from '@paper-copilot/core';
import type { Ctx } from '../../src/contracts';
import { createDocService, type DocServiceExt } from '../../src/docs/docService';
import { createPaperDb, type PaperDbExt } from '../../src/store/db';
import { makeTempProject, makeTestCtx, type TempProject } from '../helpers/ctx';
import { applySemanticLines } from '../../src/project/semanticLines';
import { SyncCore, textOf } from '../../../web/src/editor/sync/syncCore';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

function fakeServices(): Partial<Ctx> {
  return {
    facts: { linkUnit: (u: SentenceUnit) => ({ factIds: u.facts, unmatched: [], ambiguous: [] }) } as unknown as Ctx['facts'],
    lint: { lintUnits: async () => undefined, scheduleDocument: () => undefined } as unknown as Ctx['lint'],
    voice: { addEditPairs: async (_p: EditPair[]) => undefined } as unknown as Ctx['voice'],
    build: { scheduleCompile: () => undefined } as unknown as Ctx['build'],
    llm: { replanAfterEdit: async () => undefined } as unknown as Ctx['llm'],
  };
}

function aiAnn(p: Partial<ChangeAnnotation>): ChangeAnnotation {
  return { origin: 'ai_draft', sentenceIds: [], state: 'proposed', model: 'claude-sonnet-5-5', promptHash: 'ph1', instruction: null, lang: null, intentNote: null, factIds: [], citeKeys: [], move: null, requestId: null, ...p };
}

type DocChange = Extract<ClientMessage, { type: 'doc.change' }>;
type Snapshot = Extract<ServerMessage, { type: 'doc.snapshot' }>;
type Replace = Extract<ServerMessage, { type: 'doc.replace' }>;

/**
 * A browser tab: an editor text + the real SyncCore, wired exactly like DocSync (no DOM): the server text
 * is passed to `reset` (so a rejected change is REBASED onto the snapshot, keeping its annotation), at most
 * one change is on the wire (`takeNext`), server-side text from a reconcile (`remote`) is applied to the
 * editor, and a queued replace that the server overtook asks for a fresh snapshot (DocSync re-opens).
 */
class Tab {
  core = new SyncCore('main.tex');
  doc: Text = Text.empty;
  outbox: DocChange[] = [];
  notices: string[] = [];
  /** drainReplace() asked for a re-sync (DocSync sends doc.open, the server answers with a snapshot). */
  wantsResync = false;
  constructor(snapshot: Snapshot) {
    this.doc = textOf(snapshot.text);
    this.core.reset(snapshot.version, [], snapshot.text);
  }
  get text(): string {
    return this.doc.toString();
  }
  private wire(msg: DocChange): DocChange {
    // the wire form, validated like ws.ts does
    return ClientMessage.parse(JSON.parse(JSON.stringify(msg))) as DocChange;
  }
  /** DocSync.pump: one change on the wire at a time. */
  pump(): void {
    const msg = this.core.takeNext();
    if (msg) this.outbox.push(this.wire(msg));
  }
  /** A local transaction (typing, or an AI insert carrying its ChangeAnnotation). Returns its doc.change. */
  type(specs: ChangeSpec | ChangeSpec[], annotation: ChangeAnnotation | null = null): DocChange {
    const cs = ChangeSet.of(specs, this.doc.length);
    this.doc = cs.apply(this.doc);
    const msg = this.core.local(cs, annotation, false);
    this.pump();
    return this.wire(msg);
  }
  onAck(version: number): void {
    this.core.ack(version);
    const next = this.core.drainReplace();
    if (next && 'apply' in next) this.applyReplace(next.apply);
    else if (next) this.wantsResync = true;
    this.pump();
  }
  onReplace(m: Replace): void {
    if (this.core.offerReplace(m) === 'queued') return;
    this.applyReplace(m);
  }
  applyReplace(m: Replace): void {
    const cur = this.text;
    if (cur !== m.text) this.doc = diffChanges(cur, m.text).apply(this.doc);
    this.core.reset(m.version, [], m.text);
  }
  private reconciled(m: Snapshot, reconnect: boolean): void {
    this.wantsResync = false;
    const res = this.core.reconcile(m, this.text, { reconnect, connected: true, diff: diffChanges, oneInFlight: true });
    if (res.remote) this.doc = res.remote.apply(this.doc);
    // the cases DocSync's reconcileNotice reports to the author
    if (res.conflicts.length) this.notices.push(`Conflicting edits in main.tex at lines ${res.conflicts.join(', ')}.`);
    else if (res.mode === 'legacy' && res.diff) this.notices.push(`Re-synced main.tex with the server; your text was kept.`);
    this.pump();
  }
  onSnapshot(m: Snapshot): void {
    this.reconciled(m, false);
  }
  /** After a reconnect to a restarted server (DocSync: reconnecting = true). */
  onReconnectSnapshot(m: Snapshot): void {
    this.reconciled(m, true);
  }
}

describe('DocService review: can the user text (or a co-author edit, or provenance) be lost?', () => {
  let project: TempProject;
  let ctx: ReturnType<typeof makeTestCtx>;
  let db: PaperDbExt;
  let docs: DocServiceExt;
  const extra: Array<{ docs: DocServiceExt; db: PaperDbExt }> = [];

  const make = (o: { writeDebounceMs?: number } = {}) => {
    db = createPaperDb(project.paths.db);
    ctx = makeTestCtx(project, { db, ...fakeServices() });
    docs = createDocService(ctx, { segmentDebounceMs: 30, writeDebounceMs: o.writeDebounceMs ?? 60, replanDelayMs: 10_000 });
    ctx.docs = docs;
  };

  /** The server's answer to one doc.change, exactly as ws.ts produces it. */
  const deliver = async (tab: Tab, msg: DocChange): Promise<void> => {
    const ok = await docs.applyClientChange(msg);
    if (ok) tab.onAck(msg.baseVersion + 1);
    else tab.onSnapshot(docs.snapshotMessage(msg.file));
    if (tab.wantsResync) tab.onSnapshot(docs.snapshotMessage(msg.file));
  };
  const deliverAll = async (tab: Tab): Promise<void> => {
    while (tab.outbox.length) await deliver(tab, tab.outbox.shift()!);
  };
  const lastReplace = (): Replace => {
    const r = ctx.events.filter((e): e is Replace => e.type === 'doc.replace').at(-1);
    if (!r) throw new Error('no doc.replace');
    return r;
  };
  const mainPath = () => join(project.paths.tex, 'main.tex');

  beforeEach(async () => {
    project = await makeTempProject();
    make();
  });
  afterEach(async () => {
    await docs.close();
    db.close();
    for (const e of extra.splice(0)) {
      await e.docs.close();
      e.db.close();
    }
    project.cleanup();
  });

  /* ---------------------------------------------------------------------------------- */
  /* Baselines that hold (regression tests)                                              */
  /* ---------------------------------------------------------------------------------- */

  it('in-order typing from one tab: every change acked, server text == editor text == disk text', async () => {
    await docs.open('main.tex');
    const tab = new Tab(docs.snapshotMessage('main.tex'));
    for (let i = 0; i < 40; i++) {
      const at = tab.text.indexOf('The test set holds') + 4;
      tab.type({ from: at, insert: i % 7 === 6 ? '. New sentence ' : 'x' });
      if (i % 3 === 0) await deliverAll(tab);
    }
    await deliverAll(tab);
    await docs.flush('main.tex');
    expect(docs.get('main.tex')!.text).toBe(tab.text);
    expect(readFileSync(mainPath(), 'utf8')).toBe(tab.text);
    expect(tab.core.pending()).toHaveLength(0);
  });

  it('changes lost with a dropped socket are re-sent after the reconnect snapshot (the author text is kept)', async () => {
    await docs.open('main.tex');
    const tab = new Tab(docs.snapshotMessage('main.tex'));
    tab.type({ from: 0, insert: '% one\n' });
    tab.type({ from: 0, insert: '% two\n' });
    tab.outbox.length = 0; // the socket dropped: neither change reached the server
    // reconnect: doc.open -> snapshot (version 0) -> DocSync reconciles with reconnect = true
    tab.onReconnectSnapshot(docs.snapshotMessage('main.tex'));
    await deliverAll(tab);
    expect(docs.get('main.tex')!.text).toBe(tab.text);
  });

  it('external edit while the server holds unsaved (acked) edits: both survive (merge), disk == editor', async () => {
    make({ writeDebounceMs: 60_000 });
    await docs.open('main.tex');
    const tab = new Tab(docs.snapshotMessage('main.tex'));
    const at = tab.text.indexOf('The test set holds');
    tab.type({ from: at, insert: 'LOCAL ' });
    await deliverAll(tab);
    const disk = readFileSync(mainPath(), 'utf8').replace('This lead holds for every particle species.', 'This lead holds for all species.');
    writeFileSync(mainPath(), disk);
    await docs.reloadFromDisk('main.tex', 'external');
    tab.onReplace(lastReplace());
    expect(tab.text).toContain('LOCAL The test set holds');
    expect(tab.text).toContain('This lead holds for all species.');
    expect(docs.get('main.tex')!.text).toBe(tab.text);
    await docs.flush('main.tex');
    expect(readFileSync(mainPath(), 'utf8')).toBe(tab.text);
  });

  it('CRLF + BOM file: typing keeps the disk convention byte for byte; external reload round-trips', async () => {
    const lf = readFileSync(mainPath(), 'utf8');
    writeFileSync(mainPath(), '\ufeff' + lf.replace(/\n/g, '\r\n'));
    await docs.open('main.tex');
    const tab = new Tab(docs.snapshotMessage('main.tex'));
    expect(tab.text).toBe(lf);
    tab.type({ from: tab.text.indexOf('The test set holds'), insert: 'Here.\nThe split line. ' });
    await deliverAll(tab);
    await docs.flush('main.tex');
    const disk = readFileSync(mainPath(), 'utf8');
    expect(disk).toBe('\ufeff' + tab.text.replace(/\n/g, '\r\n'));
    expect(/[^\r]\n/.test(disk)).toBe(false);
    const report = await docs.reloadFromDisk('main.tex', 'external');
    expect(report.edited.length + report.created.length + report.orphaned.length).toBe(0);
  });

  /* ---------------------------------------------------------------------------------- */
  /* Findings                                                                            */
  /* ---------------------------------------------------------------------------------- */

  it('a co-author edit (pull / disk change) is NOT silently reverted when the editor had a change in flight', async () => {
    await docs.open('main.tex');
    const tab = new Tab(docs.snapshotMessage('main.tex'));
    // 1. the author types; the doc.change is on the wire
    const at = tab.text.indexOf('The test set holds');
    const inFlight = tab.type({ from: at, insert: 'LOCAL ' });
    tab.outbox.length = 0;
    // 2. meanwhile a pull / Overleaf sync rewrites a sentence on disk; the server re-anchors and
    //    broadcasts doc.replace (version 1). The tab still has the unacknowledged change -> queued.
    writeFileSync(mainPath(), readFileSync(mainPath(), 'utf8').replace('This lead holds for every particle species.', 'This lead holds for all three species.'));
    await docs.reloadFromDisk('main.tex', 'pull');
    tab.onReplace(lastReplace());
    // 3. the in-flight change (baseVersion 0) reaches the server at version 1 -> rejected -> snapshot
    await deliver(tab, inFlight);
    await deliverAll(tab);
    await docs.flush('main.tex');
    const server = docs.get('main.tex')!.text;
    expect(server).toBe(tab.text);
    expect(server).toContain('LOCAL The test set holds'); // the author's text is kept ...
    // ... and so must be the co-author's edit (it is now silently reverted, and the next push would
    // revert it on Overleaf too)
    expect(server).toContain('This lead holds for all three species.');
    expect(tab.notices).toEqual([]);
  });

  it('an AI draft in flight during a doc.replace keeps its provenance (not re-sent as unannotated human typing)', async () => {
    // a co-author's layout: two sentences on one line
    writeFileSync(mainPath(), readFileSync(mainPath(), 'utf8').replace('lose many of them.\nHowever,', 'lose many of them. However,'));
    await docs.open('main.tex');
    const tab = new Tab(docs.snapshotMessage('main.tex'));
    const ai = ' This result holds for all three training seeds.';
    const anchor = 'The test set holds 8,710 targets.';
    const inFlight = tab.type({ from: tab.text.indexOf(anchor) + anchor.length, insert: ai }, aiAnn({ origin: 'ai_draft', state: 'proposed' }));
    tab.outbox.length = 0;
    // at the same time the author clicks "one sentence per line" (POST /api/doc/semantic-lines): the
    // server flushes, rewrites the file and reloads it (doc.replace); the draft insert is still in flight
    const sem = await applySemanticLines(project.paths, 'main.tex', docs);
    expect(sem.changed).toBeGreaterThan(0);
    tab.onReplace(lastReplace());
    await deliver(tab, inFlight);
    await deliverAll(tab);
    await sleep(80);
    const st = docs.get('main.tex')!;
    const u = st.units.find((x) => st.text.slice(x.start, x.end) === ai.trim());
    expect(u, 'the drafted sentence is in the document').toBeTruthy();
    // unreviewed AI text must stay 'proposed' (push guard) and everAi
    expect.soft(u).toMatchObject({ state: 'proposed', everAi: true });
    // and the normalization the author asked for is not silently undone
    expect.soft(st.text).toContain('Trackers tuned on prompt particles lose many of them.\nHowever,');
  });

  it('two tabs on the same file: typing in the second tab does not revert what was typed in the first', async () => {
    await docs.open('main.tex');
    const a = new Tab(docs.snapshotMessage('main.tex'));
    const b = new Tab(docs.snapshotMessage('main.tex'));
    a.type({ from: a.text.indexOf('The test set holds'), insert: 'FROM-A ' });
    await deliverAll(a);
    // tab B never hears about A's text (doc.change is not broadcast); B types:
    b.type({ from: b.text.indexOf('This lead holds'), insert: 'FROM-B ' });
    await deliverAll(b); // rejected (base 0 != 1) -> snapshot -> B reconciles with ONE diff to its own text
    await deliverAll(b);
    const server = docs.get('main.tex')!.text;
    expect(server).toContain('FROM-B ');
    expect(server).toContain('FROM-A '); // A's typing must not be silently deleted
  });

  it('crash before the 1 s disk write: after restart + reconnect the AI draft is still proposed/everAi', async () => {
    make({ writeDebounceMs: 600_000 }); // the write never happens before the "crash"
    await docs.open('main.tex');
    const tab = new Tab(docs.snapshotMessage('main.tex'));
    const anchor = 'The test set holds 8,710 targets.';
    const ai = 'This result holds for all three training seeds.';
    tab.type({ from: tab.text.indexOf(anchor) + anchor.length, insert: ' ' + ai }, aiAnn({ origin: 'ai_draft', state: 'proposed' }));
    tab.type({ from: tab.text.indexOf('Searches for'), insert: 'Typed. ' });
    await deliverAll(tab);
    await sleep(80); // annotated pass + typing debounce ran: units (with new spans) are in paper.db
    const before = docs.get('main.tex')!;
    expect(before.units.find((u) => before.text.slice(u.start, u.end) === ai)).toMatchObject({ state: 'proposed' });
    expect(readFileSync(mainPath(), 'utf8')).not.toContain(ai); // not yet on disk

    // "kill -9" / crash / power loss: a NEW process (new db connection, new DocService) on the same project
    const old = { docs, db };
    extra.push(old); // closed (and flushed) only after the test
    make();
    await docs.open('main.tex');
    // the editor reconnects; DocSync reconciles the new snapshot (version 0) with its text
    tab.onReconnectSnapshot(docs.snapshotMessage('main.tex'));
    await deliverAll(tab);
    await sleep(80);
    const st = docs.get('main.tex')!;
    expect(st.text).toBe(tab.text); // the text survives (the editor still had it)
    // every unit's stored normalized text matches its slice (no unit carries another sentence's metadata)
    const mismatched = st.units.filter((u) => u.textNorm !== normalizeForHash(st.text.slice(u.start, u.end)));
    expect(mismatched.map((u) => st.text.slice(u.start, u.end).slice(0, 40))).toEqual([]);
    const u = st.units.find((x) => st.text.slice(x.start, x.end) === ai);
    expect(u).toBeTruthy();
    expect(u).toMatchObject({ state: 'proposed', everAi: true });
  });

  it('crash before the disk write: reopen + reconnect keep the human sentence human and the AI draft proposed', async () => {
    make({ writeDebounceMs: 600_000 });
    const st0 = await docs.open('main.tex');
    const anchor = 'Searches for long-lived particles look for tracks that do not point back to the beam line~\\cite{Ju2022Zenodo}.';
    const humanId = st0.units.find((u) => st0.text.slice(u.start, u.end) === anchor)!.id;
    const tab = new Tab(docs.snapshotMessage('main.tex'));
    const ai = 'This draft sentence was written by the model.';
    tab.type({ from: tab.text.indexOf(anchor), insert: ai + ' ' }, aiAnn({ origin: 'ai_draft', state: 'proposed' }));
    await deliverAll(tab);
    await sleep(80);
    extra.push({ docs, db });
    make();
    const st = await docs.open('main.tex'); // disk text == last snapshot, but paper.db holds the unsaved spans
    const reopened = st.units.find((u) => st.text.slice(u.start, u.end) === anchor)!;
    const afterOpen = { id: reopened.id, state: reopened.state, everAi: reopened.everAi };
    tab.onReconnectSnapshot(docs.snapshotMessage('main.tex'));
    await deliverAll(tab);
    await sleep(80);
    const fin = docs.get('main.tex')!;
    expect(fin.text).toBe(tab.text);
    const h = fin.units.find((u) => fin.text.slice(u.start, u.end) === anchor)!;
    const d = fin.units.find((u) => fin.text.slice(u.start, u.end) === ai)!;
    expect({ afterOpen, human: { id: h.id, state: h.state, everAi: h.everAi }, draft: { state: d.state, everAi: d.everAi } }).toEqual({
      afterOpen: { id: humanId, state: 'human', everAi: false },
      human: { id: humanId, state: 'human', everAi: false },
      draft: { state: 'proposed', everAi: true },
    });
  });

  it('typing during the conflict-copy write of an unmergeable external change is kept (mirror or conflict copy)', async () => {
    // Window: reloadFromDisk awaits saveConflictCopy(mirror) and then replaces the mirror with the disk
    // text. A doc.change applied during that await is acked, is not in the copy, and is overwritten.
    let lost = 0;
    let tried = 0;
    for (let k = 0; k < 12 && lost === 0; k++) {
      await docs.close();
      db.close();
      project.cleanup();
      project = await makeTempProject();
      make({ writeDebounceMs: 60_000 });
      await docs.open('main.tex');
      const tab = new Tab(docs.snapshotMessage('main.tex'));
      const target = 'The fake-track rate is 0.55\\% against 1.38\\% for the baseline.';
      // unsaved local edit of a sentence ...
      tab.type({ from: tab.text.indexOf(target), to: tab.text.indexOf(target) + target.length, insert: 'The fake rate drops from 1.38\\% to 0.55\\%.' });
      await deliverAll(tab);
      // ... that a co-author rewrote too (diff-match-patch cannot apply the patch -> conflict copy)
      writeFileSync(mainPath(), readFileSync(mainPath(), 'utf8').replace(target, 'Fakes: 0.55 vs 1.38 percent, a factor of 2.5 fewer, see the table below for all numbers.'));
      const reload = docs.reloadFromDisk('main.tex', 'external');
      for (let i = 0; i < k; i++) await tick();
      const typed = 'TYPED-DURING-RELOAD ';
      const msg = tab.type({ from: 0, insert: '% ' + typed + '\n' });
      tab.outbox.length = 0;
      const ok = await docs.applyClientChange(msg);
      await reload;
      tried++;
      if (!ok) continue; // landed after the reload: rejected and recovered by the snapshot path
      tab.onAck(msg.baseVersion + 1);
      tab.onReplace(lastReplace());
      const dir = join(project.paths.paper, 'conflicts');
      const copies = existsSync(dir) ? readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')) : [];
      const inMirror = docs.get('main.tex')!.text.includes(typed);
      const inCopy = copies.some((c) => c.includes(typed));
      if (!inMirror && !inCopy) lost++;
    }
    expect(tried).toBeGreaterThan(0);
    expect(lost, 'an acknowledged keystroke vanished: not in the editor, the server mirror, nor any conflict copy').toBe(0);
  });
});

/** Helper used only to keep `segment` imported for ad-hoc debugging of this file. */
export const _seg = segment;
