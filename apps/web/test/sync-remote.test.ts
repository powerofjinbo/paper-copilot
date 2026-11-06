/**
 * Several tabs on one file: doc.remoteChange (the server relays every accepted change to the other sockets)
 * and the per-socket epoch (a change based before the last snapshot/replace sent to that socket is
 * refused with a fresh snapshot).
 *
 * The server below is a faithful model of apps/server/src/ws.ts + DocService.applyClientChange (per-socket
 * FIFO queues, epoch rule, version and length check, relay to the other sockets, doc.replace). Each tab
 * drives the REAL SyncCore exactly as DocSync does: one change in flight, snapshot reconcile (applying
 * `remote`), doc.remoteChange through SyncCore.remote, and a fresh doc.open when it is "behind".
 * A seeded random schedule interleaves typing in every tab with message delivery in any order the
 * sockets allow; at quiescence every tab must hold the server text and no typed text may be lost or
 * duplicated. apps/server/test/protocol.test.ts checks the same rules against the real server.
 */
import { ChangeSet, Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { diffChanges, type ChangeAnnotation, type ServerMessage } from '@paper-copilot/core';
import { SyncCore, textOf, type DocChangeMsg } from '../src/editor/sync/syncCore';
import { merge3 } from '../src/editor/sync/merge3';

type SMsg = ServerMessage;
type CMsg = DocChangeMsg | { type: 'doc.open'; file: string };

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

interface Sock {
  id: string;
  epoch: number | undefined;
  /** server -> tab */
  down: SMsg[];
  /** tab -> server */
  up: CMsg[];
}

class Server {
  version = 0;
  text: string;
  socks: Sock[] = [];
  applied: Array<{ by: string; annotation: ChangeAnnotation | null }> = [];
  snapshots = 0;
  constructor(text: string) {
    this.text = text;
    this.disk = text;
  }
  connect(id: string): Sock {
    const s: Sock = { id, epoch: undefined, down: [], up: [] };
    this.socks.push(s);
    return s;
  }
  private send(s: Sock, m: SMsg): void {
    if (m.type === 'doc.snapshot' || m.type === 'doc.replace') s.epoch = m.version;
    s.down.push(m);
  }
  private snapshot(s: Sock): void {
    this.snapshots++;
    this.send(s, { type: 'doc.snapshot', file: 'main.tex', version: this.version, text: this.text, units: [], intentLines: [] });
  }
  /** Handle the next message a socket sent (ws.ts handles a socket's messages in order). */
  step(s: Sock): void {
    const m = s.up.shift();
    if (!m) return;
    if (m.type === 'doc.open') return this.snapshot(s);
    if (s.epoch === undefined || m.baseVersion < s.epoch || (m.epoch !== undefined && m.epoch < s.epoch)) return this.snapshot(s);
    if (m.baseVersion !== this.version) return this.snapshot(s);
    let cs: ChangeSet;
    try {
      cs = ChangeSet.fromJSON(m.changes);
    } catch {
      return this.snapshot(s);
    }
    if (cs.length !== this.text.length) return this.snapshot(s);
    this.text = cs.apply(textOf(this.text)).toString();
    this.version++;
    this.applied.push({ by: s.id, annotation: m.annotation });
    for (const o of this.socks) if (o !== s) this.send(o, { type: 'doc.remoteChange', file: 'main.tex', version: this.version, changes: m.changes, originClientId: `${s.id}:x` });
    this.send(s, { type: 'doc.ack', file: 'main.tex', version: m.baseVersion + 1 });
  }
  /** The file as last written to disk. */
  disk = '';
  save(): void {
    this.disk = this.text;
  }
  /** kill -9 and start again: unsaved text is gone, versions restart at 0, every socket is gone. */
  restart(): void {
    this.text = this.disk;
    this.version = 0;
    this.socks = [];
  }
  /** A pull: doc.replace to every socket. */
  replace(text: string): void {
    this.text = text;
    this.version++;
    for (const s of this.socks) this.send(s, { type: 'doc.replace', file: 'main.tex', version: this.version, text, units: [], intentLines: [], report: { unchanged: 0, edited: [], created: [], orphaned: [], split: [] } });
  }
}

/** A tab wired like DocSync (doc = the editor text). */
class Tab {
  core = new SyncCore('main.tex');
  doc: Text = Text.empty;
  synced = false;
  awaiting = false;
  reconnecting = false;
  applied = 0;
  notes: string[] = [];
  constructor(
    readonly id: string,
    public sock: Sock,
  ) {
    this.open();
  }
  /** The socket died (nothing on it arrives any more). */
  disconnect(): void {
    this.sock = { id: this.id, epoch: undefined, down: [], up: [] };
    this.synced = false;
    this.awaiting = true;
  }
  /** A new socket to a (restarted) server: DocSync re-opens the file and reconciles the snapshot. */
  reconnect(server: Server): void {
    this.sock = server.connect(this.id);
    this.reconnecting = true;
    this.open();
  }
  get text(): string {
    return this.doc.toString();
  }
  open(): void {
    this.awaiting = true;
    this.sock.up.push({ type: 'doc.open', file: 'main.tex' });
  }
  pump(): void {
    if (this.awaiting) return;
    const m = this.core.takeNext();
    if (m) this.sock.up.push(JSON.parse(JSON.stringify(m)) as DocChangeMsg);
  }
  type(from: number, to: number, insert: string, annotation: ChangeAnnotation | null = null): void {
    const cs = ChangeSet.of([{ from, to, insert }], this.doc.length);
    this.doc = cs.apply(this.doc);
    if (this.core.initialized) this.core.local(cs, annotation, false);
    this.pump();
  }
  private resyncIfBehind(): void {
    if (this.core.behind && !this.awaiting && this.core.pending().length === 0) this.open();
  }
  /** Deliver the next server message. */
  receive(): boolean {
    const m = this.sock.down.shift();
    if (!m) return false;
    switch (m.type) {
      case 'doc.snapshot': {
        this.awaiting = false;
        this.synced = true;
        if (!this.core.initialized) {
          this.doc = textOf(m.text);
          this.core.reset(m.version, [], m.text);
        } else {
          const res = this.core.reconcile(m, this.text, { reconnect: this.reconnecting, connected: true, diff: diffChanges, oneInFlight: true });
          this.reconnecting = false;
          if (res.remote) this.doc = res.remote.apply(this.doc);
          this.notes.push(`${res.mode}${res.conflicts.length ? ` conflicts ${res.conflicts.join(',')}` : ''}`);
        }
        this.pump();
        break;
      }
      case 'doc.ack': {
        this.core.ack(m.version);
        const next = this.core.drainReplace();
        if (next && 'apply' in next) {
          this.doc = this.text === next.apply.text ? this.doc : diffChanges(this.text, next.apply.text).apply(this.doc);
          this.core.reset(next.apply.version, [], next.apply.text);
        } else if (next) this.open();
        this.resyncIfBehind();
        this.pump();
        break;
      }
      case 'doc.replace': {
        if (!this.core.initialized || this.core.offerReplace(m) === 'queued') break;
        this.doc = this.text === m.text ? this.doc : diffChanges(this.text, m.text).apply(this.doc);
        this.core.reset(m.version, [], m.text);
        break;
      }
      case 'doc.remoteChange': {
        if (!this.synced || !this.core.initialized) break;
        const res = this.core.remote(ChangeSet.fromJSON(m.changes), m.version);
        if (res.kind === 'apply') {
          expect(res.change.length).toBe(this.doc.length);
          this.doc = res.change.apply(this.doc);
          this.applied++;
        }
        this.resyncIfBehind();
        break;
      }
      default:
        break;
    }
    return true;
  }
}

/** Move `at` to the start of the word token (` w<seed>x<n>q`) it falls strictly inside, if any. */
function outsideTokens(text: string, at: number): number {
  for (const m of text.matchAll(/ w\d+x\d+q/g)) if (m.index < at && at < m.index + m[0].length) return m.index;
  return at;
}

const START = ['\\section{Results}', 'The tracker finds more displaced particles.', 'The fake-track rate stays low.', ''].join('\n');

function quiesce(server: Server, tabs: Tab[]): void {
  for (let guard = 0; guard < 100_000; guard++) {
    let moved = false;
    for (const t of tabs) {
      if (t.sock.up.length) {
        server.step(t.sock);
        moved = true;
      }
      if (t.receive()) moved = true;
    }
    if (!moved) return;
  }
  throw new Error('no quiescence');
}

const ann = (sentenceIds: string[]): ChangeAnnotation => ({ origin: 'ai_rewrite', sentenceIds, state: 'ai-drafted', model: 'm', promptHash: 'h', instruction: null, lang: null, intentNote: null, factIds: [], citeKeys: [], move: null, requestId: null });

describe('doc.remoteChange: other tabs converge at once', () => {
  it('an idle tab applies the other tab\'s change from the relay alone (no snapshot), with no echo', () => {
    const server = new Server(START);
    const a = new Tab('a', server.connect('a'));
    const b = new Tab('b', server.connect('b'));
    quiesce(server, [a, b]);
    const snaps = server.snapshots;
    a.type(a.text.indexOf('The tracker'), a.text.indexOf('The tracker'), 'Indeed, ');
    server.step(a.sock); // applied: ack to A, remoteChange to B
    expect(b.sock.down.map((m) => m.type)).toEqual(['doc.remoteChange']);
    b.receive();
    expect(b.text).toBe(server.text);
    expect(b.core.localVersion).toBe(server.version);
    a.receive();
    expect(a.sock.down).toHaveLength(0);
    expect(a.sock.up).toHaveLength(0);
    // B types right away on top of it: accepted first time, no snapshot anywhere
    b.type(0, 0, '% b\n');
    quiesce(server, [a, b]);
    expect(server.snapshots).toBe(snaps);
    expect(a.text).toBe(server.text);
    expect(b.text).toBe(server.text);
    expect(server.text.startsWith('% b\n')).toBe(true);
  });

  it('a tab with a change in flight rebases it over the relayed change, keeps its annotation, and the server applies it once', () => {
    const server = new Server(START);
    const a = new Tab('a', server.connect('a'));
    const b = new Tab('b', server.connect('b'));
    quiesce(server, [a, b]);
    const i = START.indexOf('The fake-track');
    a.type(0, 0, 'A1 ');
    b.type(i, START.indexOf('.', i) + 1, 'The fake-track rate is small.', ann(['s2']));
    b.type(b.text.length, b.text.length, 'B2'); // queued behind the one in flight
    server.step(a.sock); // A's change wins the race
    server.step(b.sock); // B's in-flight change: wrong base -> snapshot
    b.receive(); // the relayed change first: B rebases its pending changes, the editor shows A's text now
    expect(b.text.startsWith('A1 ')).toBe(true);
    expect(b.text).toContain('The fake-track rate is small.');
    expect(b.text.endsWith('B2')).toBe(true);
    quiesce(server, [a, b]);
    expect(a.text).toBe(server.text);
    expect(b.text).toBe(server.text);
    expect(server.text.split('A1 ').length).toBe(2);
    expect(server.text.split('The fake-track rate is small.').length).toBe(2);
    expect(server.text.split('B2').length).toBe(2);
    const rewrite = server.applied.filter((x) => x.by === 'b' && x.annotation);
    expect(rewrite).toHaveLength(1);
    expect(rewrite[0]!.annotation!.sentenceIds).toEqual(['s2']);
  });

  it('a relayed change older than the acknowledged version is ignored; a gap makes the tab ask for a snapshot', () => {
    const server = new Server(START);
    const a = new Tab('a', server.connect('a'));
    const b = new Tab('b', server.connect('b'));
    quiesce(server, [a, b]);
    a.type(0, 0, 'x');
    server.step(a.sock);
    a.type(1, 1, 'y');
    a.receive(); // ack
    server.step(a.sock);
    // B loses the first relayed change (as when it arrived before B's first snapshot on a new socket)
    const lost = b.sock.down.shift()!;
    expect(lost.type).toBe('doc.remoteChange');
    b.receive(); // the second one: a gap -> behind -> doc.open
    expect(b.core.behind).toBe(true);
    expect(b.sock.up.map((m) => m.type)).toEqual(['doc.open']);
    quiesce(server, [a, b]);
    expect(b.text).toBe(server.text);
    expect(b.core.behind).toBe(false);
    // a stale relay (already contained) changes nothing
    const v = b.core.localVersion;
    expect(b.core.remote(ChangeSet.of([{ from: 0, insert: 'z' }], 3), v - 1).kind).toBe('stale');
    expect(b.text).toBe(server.text);
  });

  it('a relayed change while a doc.replace is queued is left to the snapshot path', () => {
    const server = new Server(START);
    const a = new Tab('a', server.connect('a'));
    const b = new Tab('b', server.connect('b'));
    quiesce(server, [a, b]);
    b.type(0, 0, 'B');
    server.replace(START.replace('more displaced', 'MORE displaced')); // a pull
    b.receive(); // replace queued (B has a change in flight)
    expect(b.core.queuedReplace).not.toBeNull();
    a.receive();
    a.type(0, 0, 'A');
    server.step(a.sock);
    b.receive(); // relayed change: behind (the replace is queued)
    expect(b.core.behind).toBe(true);
    quiesce(server, [a, b]);
    expect(a.text).toBe(server.text);
    expect(b.text).toBe(server.text);
    expect(server.text).toContain('MORE displaced');
    expect(server.text.split('B').length - START.split('B').length).toBe(1);
  });

  it('every doc.change carries the epoch; the server refuses a change made before a replace even when version and length match', () => {
    const server = new Server('abc');
    const a = new Tab('a', server.connect('a'));
    quiesce(server, [a]);
    expect(a.core.epoch).toBe(0);
    server.replace('abd'); // same length, version 1, epoch of A's socket = 1
    // A does not know yet; a non-compliant client sends two changes: base 0 and base 1 (its own lineage)
    a.sock.up.push(a.core.local(ChangeSet.of([{ from: 0, to: 1, insert: 'X' }], 3), null, true));
    a.sock.up.push(a.core.local(ChangeSet.of([{ from: 1, to: 2, insert: 'Y' }], 3), null, true));
    expect((a.sock.up[1] as DocChangeMsg).epoch).toBe(0);
    server.step(a.sock);
    server.step(a.sock);
    expect(server.text).toBe('abd'); // neither applied in the wrong place
    expect(server.applied).toHaveLength(0);
  });
});

describe('server restart with two tabs', () => {
  it('an idle tab that reconnects after another tab restored and kept typing does not delete that tab\'s new text', () => {
    // Found by e2e/soak.mjs (seed 2): the idle tab's acknowledged copy of the line ("…at eac") was merged as
    // "ours wins" against the server line the first tab had restored and extended ("…at each tracker"), and
    // its restore change deleted "h ".
    const server = new Server(START);
    const a = new Tab('a', server.connect('a'));
    const b = new Tab('b', server.connect('b'));
    quiesce(server, [a, b]);
    /** Type one character after the first occurrence of `marker`. */
    const typeAfter = (t: Tab, marker: string, ch: string) => {
      const at = t.text.indexOf(marker) + marker.length;
      t.type(at, at, ch);
    };
    // a long session first (saved): the tabs' version numbers are far above a restarted server's
    for (const ch of '% notes\n') {
      t0(a, ch);
      quiesce(server, [a, b]);
    }
    function t0(t: Tab, ch: string) {
      t.type(t.text.length, t.text.length, ch);
    }
    server.save();
    let typed = 'particles.';
    for (const ch of ' at eac') {
      typeAfter(a, typed, ch);
      typed += ch;
      quiesce(server, [a, b]);
    }
    expect(b.text).toBe(a.text);
    expect(server.text).toContain('particles. at eac');
    const ackedB = b.core.ackedVersion;
    // kill -9 before the debounced write: the disk has none of it; A types on while the server is down
    server.restart();
    a.disconnect();
    b.disconnect();
    typeAfter(a, 'particles. at eac', 'h');
    // A reconnects first: version 0, the text read from disk -> A restores " at eac" and sends its "h"
    a.reconnect(server);
    quiesce(server, [a]);
    expect(a.notes.at(-1)).toBe('restart');
    expect(server.text).toContain('particles. at each');
    typed = 'particles. at each';
    for (const ch of ' tracker') {
      typeAfter(a, typed, ch);
      typed += ch;
    }
    quiesce(server, [a]);
    expect(server.text).toContain('particles. at each tracker');
    expect(server.version).toBeLessThan(ackedB);
    // B (idle, its copy ends at "…at eac") reconnects: the server is past version 0
    b.reconnect(server);
    quiesce(server, [a, b]);
    expect(server.text).toContain('particles. at each tracker');
    expect(a.text).toBe(server.text);
    expect(b.text).toBe(server.text);
    expect(b.notes.at(-1)).toBe('restart');
  });

  it('two tabs that both restore the same lost text after a restart do not insert it twice', () => {
    // Found by e2e/soak.mjs (seed 2): both tabs got the fresh (version 0) snapshot and both sent a restore;
    // the second one was rebased like typing over the first (relayed, then in the snapshot) and the text
    // appeared twice, splitting the first tab's next word ("t and he").
    const server = new Server(START);
    const a = new Tab('a', server.connect('a'));
    const b = new Tab('b', server.connect('b'));
    quiesce(server, [a, b]);
    for (const ch of '% long session\n') {
      a.type(a.text.length, a.text.length, ch);
      quiesce(server, [a, b]);
    }
    server.save();
    let typed = 'particles.';
    for (const ch of ' and ') {
      const at = a.text.indexOf(typed) + typed.length;
      a.type(at, at, ch);
      typed += ch;
      quiesce(server, [a, b]);
    }
    server.restart();
    a.disconnect();
    b.disconnect();
    a.reconnect(server);
    b.reconnect(server);
    server.step(a.sock); // doc.open
    server.step(b.sock); // doc.open
    a.receive(); // snapshot v0 -> restore " and "
    b.receive(); // snapshot v0 -> restore " and "
    expect(a.sock.up).toHaveLength(1);
    expect(b.sock.up).toHaveLength(1);
    server.step(a.sock); // A's restore applied, relayed to B
    // A types on at once
    for (const ch of 'the') {
      a.receive();
      const at = a.text.indexOf(typed) + typed.length;
      a.type(at, at, ch);
      typed += ch;
      server.step(a.sock);
    }
    server.step(b.sock); // B's restore: rejected (wrong base) -> snapshot
    quiesce(server, [a, b]);
    expect(server.text).toContain('particles. and the\n');
    expect(server.text.split(' and ').length).toBe(2);
    expect(a.text).toBe(server.text);
    expect(b.text).toBe(server.text);
  });

  it('the first tab back still restores the lost text over a fresh disk read (ours wins on a conflict line)', () => {
    const server = new Server(START);
    const a = new Tab('a', server.connect('a'));
    quiesce(server, [a]);
    server.save();
    const at = START.indexOf('The fake-track rate stays low.');
    a.type(at, at + 'The fake-track rate stays low.'.length, 'The fake-track rate stays below one percent.');
    quiesce(server, [a]);
    server.restart();
    server.disk = START.replace('The fake-track rate stays low.', 'The fake-track rate stays small.'); // edited on disk meanwhile
    server.text = server.disk;
    a.disconnect();
    a.reconnect(server);
    quiesce(server, [a]);
    expect(server.text).toContain('The fake-track rate stays below one percent.');
    expect(a.text).toBe(server.text);
    expect(a.notes.at(-1)).toMatch(/^restart conflicts/);
  });

  it('merge3 prefer: theirs keeps their line on a conflict and reports nothing; non-conflicting edits of ours survive', () => {
    const base = 'a\nb\nc\n';
    const ours = 'a\nb at eac\nc!\n';
    const theirs = 'a\nb at each tracker\nc\n';
    expect(merge3(base, ours, theirs)).toEqual({ text: 'a\nb at eac\nc!\n', conflicts: [2] });
    expect(merge3(base, ours, theirs, { prefer: 'theirs' })).toEqual({ text: 'a\nb at each tracker\nc!\n', conflicts: [] });
  });
});

describe('seeded random multi-tab schedule (typing, deletes, AI rewrites, pulls; any delivery order)', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`seed ${seed}: every tab converges to the server text; typed words are never lost or duplicated`, () => {
      const r = rng(seed);
      const server = new Server(START);
      const tabs = [0, 1, 2].map((k) => new Tab(`t${k}`, server.connect(`t${k}`)));
      quiesce(server, tabs);
      let word = 0;
      const words: string[] = [];
      let deletes = 0;
      for (let step = 0; step < 1500; step++) {
        const x = r();
        const t = tabs[Math.floor(r() * tabs.length)]!;
        if (x < 0.25 && t.core.initialized) {
          const at = outsideTokens(t.text, Math.floor(r() * (t.doc.length + 1)));
          const w = ` w${seed}x${word++}q`;
          words.push(w.trim());
          t.type(at, at, w, r() < 0.15 ? ann([]) : null);
        } else if (x < 0.31 && t.core.initialized && t.doc.length > 40) {
          // delete a short range that holds no word token (so the exactly-once check stays exact)
          const at = outsideTokens(t.text, Math.floor(r() * (t.doc.length - 5)));
          const slice = t.doc.sliceString(at, at + 3);
          if (!/[wxq0-9]/.test(slice) && outsideTokens(t.text, at + 3) === at + 3) {
            t.type(at, at + 3, '');
            deletes++;
          }
        } else if (x < 0.32) {
          const s = server.text;
          server.replace(s.replace('\\section{Results}', `\\section{Results}%${step}`));
        } else if (x < 0.65) {
          if (t.sock.up.length) server.step(t.sock);
        } else {
          t.receive();
        }
      }
      quiesce(server, tabs);
      for (const t of tabs) {
        expect(t.text).toBe(server.text);
        expect(t.core.pending()).toHaveLength(0);
        expect(t.core.localVersion).toBe(server.version);
      }
      for (const w of words) expect(server.text.split(w).length - 1, w).toBe(1);
      expect(words.length).toBeGreaterThan(200);
      expect(deletes).toBeGreaterThan(5);
      // the relay did most of the converging (a snapshot only for a lost race or a replace)
      expect(tabs.reduce((n, t) => n + t.applied, 0)).toBeGreaterThan(words.length / 2);
    });
  }
});
