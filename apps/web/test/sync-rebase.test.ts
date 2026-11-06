/**
 * Regression tests for review findings F1, F2, F4 (anchoring lens): a server-side text change (pull,
 * disk edit, semantic-lines rewrite, another tab) that races with unacknowledged typing must be rebased,
 * never reverted by a diff; AI annotations must survive the rebase; a restarted server must not take the
 * author's text nor silently drop a disk edit.
 *
 * The server is a faithful model of DocService.applyClientChange / reloadFromDisk / a restart (version
 * check, length check, doc.replace with a version bump, version 0 after a restart). The tab drives the
 * REAL SyncCore exactly as DocSync does (including applying `remote` and adopting relayed changes).
 * apps/server/test/review/anchoring.test.ts runs the same scenarios against the real DocService.
 */
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { diffChanges, type ChangeAnnotation } from '@paper-copilot/core';
import { SyncCore, textOf, type DocChangeMsg, type ReplaceMsg } from '../src/editor/sync/syncCore';
import { lineHunks, merge3, splitLines } from '../src/editor/sync/merge3';
import { reconcileNotice } from '../src/editor/sync/docSync';

type Snapshot = { version: number; text: string };

class FakeServer {
  version = 0;
  text: string;
  disk: string;
  /** Every change the server applied, with its annotation (what DocService records as provenance). */
  applied: Array<{ inserted: string[]; annotation: ChangeAnnotation | null }> = [];
  constructor(text: string) {
    this.text = text;
    this.disk = text;
  }
  snapshot(): Snapshot {
    return { version: this.version, text: this.text };
  }
  /** DocService.applyClientChange: only a change on the current version and length is applied. */
  apply(msg: DocChangeMsg): boolean {
    if (msg.baseVersion !== this.version) return false;
    let cs: ChangeSet;
    try {
      cs = ChangeSet.fromJSON(msg.changes);
    } catch {
      return false;
    }
    if (cs.length !== this.text.length) return false;
    const inserted: string[] = [];
    cs.iterChanges((_a, _b, _c, _d, ins) => inserted.push(ins.toString()));
    this.text = cs.apply(textOf(this.text)).toString();
    this.applied.push({ inserted, annotation: msg.annotation });
    this.version++;
    return true;
  }
  /** A pull / external edit / semantic-lines rewrite: the server re-reads the file and broadcasts doc.replace. */
  replace(newText: string): ReplaceMsg {
    this.text = newText;
    this.disk = newText;
    this.version++;
    return { type: 'doc.replace', file: 'main.tex', version: this.version, text: newText, units: [], intentLines: [], report: { unchanged: 0, edited: [], created: [], orphaned: [], split: [] } };
  }
  save(): void {
    this.disk = this.text;
  }
  /** kill -9 and start again: unsaved text is gone, versions restart at 0. */
  restart(disk = this.disk): void {
    this.disk = disk;
    this.text = disk;
    this.version = 0;
  }
}

/** A browser tab: an editor text + the real SyncCore, wired like DocSync. */
class Tab {
  core = new SyncCore('main.tex');
  doc: Text;
  outbox: DocChangeMsg[] = [];
  notices: Array<{ level: string; message: string }> = [];
  constructor(s: Snapshot) {
    this.doc = textOf(s.text);
    this.core.reset(s.version, [], s.text);
  }
  get text(): string {
    return this.doc.toString();
  }
  /** A local transaction; returns its doc.change (which goes on the wire once nothing else is in flight). */
  type(specs: ChangeSpec | ChangeSpec[], annotation: ChangeAnnotation | null = null): DocChangeMsg {
    const cs = ChangeSet.of(specs, this.doc.length);
    this.doc = cs.apply(this.doc);
    const msg = JSON.parse(JSON.stringify(this.core.local(cs, annotation, false))) as DocChangeMsg;
    this.pump();
    return msg;
  }
  /** DocSync.pump: one change on the wire at a time. */
  pump(): void {
    const m = this.core.takeNext();
    if (m) this.outbox.push(JSON.parse(JSON.stringify(m)) as DocChangeMsg);
  }
  insertAt(anchor: string, insert: string, annotation: ChangeAnnotation | null = null): DocChangeMsg {
    const at = this.text.indexOf(anchor);
    if (at < 0) throw new Error(`no "${anchor}"`);
    return this.type({ from: at, insert }, annotation);
  }
  onAck(version: number): ReturnType<SyncCore['ack']> {
    const done = this.core.ack(version);
    const next = this.core.drainReplace();
    if (next && 'apply' in next) this.applyReplace(next.apply);
    this.pump();
    return done;
  }
  onReplace(m: ReplaceMsg): void {
    if (this.core.offerReplace(m) === 'queued') return;
    this.applyReplace(m);
  }
  applyReplace(m: ReplaceMsg): void {
    if (this.text !== m.text) this.doc = diffChanges(this.text, m.text).apply(this.doc);
    this.core.reset(m.version, [], m.text);
  }
  onSnapshot(s: Snapshot, reconnect = false): void {
    const res = this.core.reconcile(s, this.text, { reconnect, connected: true, diff: diffChanges, oneInFlight: true });
    if (res.remote) this.doc = res.remote.apply(this.doc);
    const n = reconcileNotice('main.tex', res, 'en');
    if (n) this.notices.push(n);
    this.pump();
  }
  /** A sentences.patch at the server version: DocSync notes it, which trims the acknowledged log. */
  patched(version: number): void {
    this.core.notePatch(version);
  }
}

/** The server's answer to one doc.change, as ws.ts produces it. */
function deliver(server: FakeServer, tab: Tab, msg: DocChangeMsg): void {
  if (server.apply(msg)) tab.onAck(msg.baseVersion + 1);
  else tab.onSnapshot(server.snapshot());
}
function deliverAll(server: FakeServer, tab: Tab): void {
  for (let guard = 0; tab.outbox.length && guard < 1000; guard++) deliver(server, tab, tab.outbox.shift()!);
}

const PAPER = [
  '\\section{Introduction}',
  'Searches for long-lived particles look for tracks that do not point back to the beam line.',
  'Trackers tuned on prompt particles lose many of them. However, the trigger keeps a few.',
  'This lead holds for every particle species.',
  'The test set holds 8,710 targets.',
  'We report the efficiency at large displacement.',
  '',
].join('\n');

const aiAnn = (p: Partial<ChangeAnnotation> = {}): ChangeAnnotation => ({
  origin: 'ai_draft',
  sentenceIds: [],
  state: 'proposed',
  model: 'claude-sonnet-5-5',
  promptHash: 'ph1',
  instruction: null,
  lang: null,
  intentNote: null,
  factIds: [],
  citeKeys: [],
  move: null,
  requestId: null,
  ...p,
});

describe('F1: a co-author edit racing with unacknowledged typing is rebased, not reverted', () => {
  it('pull lands while a doc.change is in flight: both the author text and the co-author edit survive, silently', () => {
    const server = new FakeServer(PAPER);
    const tab = new Tab(server.snapshot());
    const inFlight = tab.insertAt('The test set holds', 'LOCAL ');
    tab.outbox.length = 0;
    tab.onReplace(server.replace(server.text.replace('every particle species.', 'all three species.')));
    deliver(server, tab, inFlight); // rejected -> snapshot -> rebase
    deliverAll(server, tab);
    expect(server.text).toBe(tab.text);
    expect(server.text).toContain('LOCAL The test set holds');
    expect(server.text).toContain('This lead holds for all three species.');
    expect(server.text).not.toContain('every particle species');
    expect(tab.notices).toEqual([]);
    expect(tab.core.pending()).toEqual([]);
  });

  it('several pending changes and several in-flight rejections (duplicate snapshots) converge', () => {
    const server = new FakeServer(PAPER);
    const tab = new Tab(server.snapshot());
    tab.insertAt('The test set', 'A1 ');
    tab.insertAt('We report', 'A2 ');
    tab.insertAt('Searches for', 'A3 ');
    const inFlight = tab.outbox.splice(0);
    tab.onReplace(server.replace(server.text.replace('However, the trigger keeps a few.', 'However, the trigger keeps a handful.')));
    for (const m of inFlight) deliver(server, tab, m); // three rejections, three snapshots
    deliverAll(server, tab);
    expect(server.text).toBe(tab.text);
    for (const s of ['A1 The test', 'A2 We report', 'A3 Searches', 'keeps a handful.']) expect(server.text).toContain(s);
    expect(tab.notices).toEqual([]);
  });

  it('a queued replace that resolves to "resync" (snapshot) keeps the replaced text instead of reverting it', () => {
    const server = new FakeServer(PAPER);
    const tab = new Tab(server.snapshot());
    const first = tab.insertAt('The test set', 'X ');
    deliver(server, tab, first); // acked: v1
    const second = tab.insertAt('We report', 'Y ');
    tab.outbox.length = 0;
    tab.onReplace(server.replace(server.text.replace('every particle species.', 'all species.'))); // v2, queued
    deliver(server, tab, second); // rejected (v2) -> snapshot
    deliverAll(server, tab);
    expect(server.text).toBe(tab.text);
    expect(server.text).toContain('all species.');
    expect(server.text).toContain('Y We report');
  });

  it('overlapping edits keep both texts and are reported with the line number (never silent)', () => {
    const server = new FakeServer(PAPER);
    const tab = new Tab(server.snapshot());
    const target = 'This lead holds for every particle species.';
    const at = tab.text.indexOf('every');
    const inFlight = tab.type({ from: at, to: at + 'every'.length, insert: 'each' });
    tab.outbox.length = 0;
    tab.onReplace(server.replace(server.text.replace(target, 'This lead holds for most particle species.')));
    deliver(server, tab, inFlight);
    deliverAll(server, tab);
    expect(server.text).toBe(tab.text);
    const line = tab.text.split('\n').findIndex((l) => l.startsWith('This lead')) + 1;
    expect(tab.text).toContain('each');
    expect(tab.text).toContain('most');
    expect(tab.notices).toHaveLength(1);
    expect(tab.notices[0]!.level).toBe('warn');
    expect(tab.notices[0]!.message).toContain(`line ${line}`);
    expect(tab.notices[0]!.message).not.toMatch(/your text was kept/);
  });

  it('without a patch, a restart replays the still-logged changes with their annotations (no merge needed)', () => {
    const server = new FakeServer(PAPER);
    const tab = new Tab(server.snapshot());
    tab.insertAt('We report', 'Drafted. ', aiAnn());
    deliverAll(server, tab);
    server.restart();
    tab.onSnapshot(server.snapshot(), true);
    deliverAll(server, tab);
    expect(server.text).toBe(tab.text);
    expect(server.applied.at(-1)!.annotation?.origin).toBe('ai_draft');
  });

  it('after a reconnect with a lost ack, a change the server already applied is not applied twice', () => {
    const server = new FakeServer(PAPER);
    const tab = new Tab(server.snapshot());
    const m = tab.insertAt('The test set', 'ONCE ');
    tab.outbox.length = 0;
    expect(server.apply(m)).toBe(true); // applied, but the ack is lost with the socket
    server.replace(server.text.replace('every particle species.', 'all species.')); // pull while offline
    tab.onSnapshot(server.snapshot(), true); // reconnect
    deliverAll(server, tab);
    expect(server.text).toBe(tab.text);
    expect(server.text.split('ONCE ').length - 1).toBe(1);
    expect(server.text).toContain('all species.');
  });
});

describe('F2: provenance of an in-flight AI draft survives a doc.replace', () => {
  it('the rebased draft insert keeps its ai_draft annotation; the semantic-lines normalization is kept', () => {
    const server = new FakeServer(PAPER);
    const tab = new Tab(server.snapshot());
    const ai = ' This result holds for all three training seeds.';
    const anchor = 'The test set holds 8,710 targets.';
    const inFlight = tab.type({ from: tab.text.indexOf(anchor) + anchor.length, insert: ai }, aiAnn());
    tab.outbox.length = 0;
    // "one sentence per line" (POST /api/doc/semantic-lines) while the draft insert is in flight
    tab.onReplace(server.replace(server.text.replace('lose many of them. However,', 'lose many of them.\nHowever,')));
    deliver(server, tab, inFlight);
    deliverAll(server, tab);
    expect(server.text).toBe(tab.text);
    expect(server.text).toContain('lose many of them.\nHowever,');
    const withDraft = server.applied.filter((a) => a.inserted.some((s) => s.includes(ai.trim())));
    expect(withDraft).toHaveLength(1);
    expect(withDraft[0]!.annotation).toMatchObject({ origin: 'ai_draft', state: 'proposed' });
    // nothing carrying the drafted text ever reaches the server unannotated
    expect(server.applied.filter((a) => a.annotation === null && a.inserted.some((s) => s.includes('training seeds')))).toEqual([]);
  });
});

describe('F4: two tabs on the same file', () => {
  it('typing in the second (stale) tab does not revert what the first typed', () => {
    const server = new FakeServer(PAPER);
    const a = new Tab(server.snapshot());
    const b = new Tab(server.snapshot());
    a.insertAt('The test set holds', 'FROM-A ');
    deliverAll(server, a);
    b.insertAt('This lead holds', 'FROM-B ');
    deliverAll(server, b);
    expect(server.text).toContain('FROM-A ');
    expect(server.text).toContain('FROM-B ');
    expect(b.text).toBe(server.text); // B now shows A's text too
    expect(b.notices).toEqual([]);
    // A's next change rebases over B's
    a.insertAt('We report', 'AGAIN-A ');
    deliverAll(server, a);
    expect(a.text).toBe(server.text);
    for (const s of ['FROM-A ', 'FROM-B ', 'AGAIN-A ']) expect(server.text).toContain(s);
  });

  it('the same-browser relay: the idle tab adopts the acknowledged change at once and stays at the server version', () => {
    const server = new FakeServer(PAPER);
    const a = new Tab(server.snapshot());
    const b = new Tab(server.snapshot());
    const m = a.insertAt('The test set holds', 'FROM-A ');
    a.outbox.length = 0;
    server.apply(m);
    const done = a.onAck(m.baseVersion + 1);
    // what DocSync posts on the BroadcastChannel, and what the other tab does with it
    for (const e of done) {
      const cs = ChangeSet.fromJSON(e.changes.toJSON());
      expect(b.core.localVersion).toBe(e.baseVersion);
      expect(b.core.adoptRemote(cs)).toBe(true);
      b.doc = cs.apply(b.doc);
    }
    expect(b.text).toBe(server.text);
    expect(b.core.localVersion).toBe(server.version);
    b.insertAt('This lead', 'FROM-B ');
    deliverAll(server, b); // accepted directly (no rejection)
    expect(server.text).toBe(b.text);
    expect(server.text).toContain('FROM-A ');
  });

  it('adoptRemote refuses while the tab has its own pending typing (the rebase path handles it)', () => {
    const core = new SyncCore('main.tex');
    core.reset(0, [], 'abc');
    core.local(ChangeSet.of([{ from: 0, insert: 'x' }], 3), null, true);
    expect(core.adoptRemote(ChangeSet.of([{ from: 3, insert: 'y' }], 3))).toBe(false);
  });
});

describe('server restart (new version lineage)', () => {
  it('acknowledged but unsaved edits lost by a crash are re-sent; the AI draft that was still pending keeps its annotation', () => {
    const server = new FakeServer(PAPER);
    const tab = new Tab(server.snapshot());
    tab.insertAt('The test set', 'Typed. ');
    deliverAll(server, tab); // acked, not saved
    tab.patched(server.version);
    const draft = tab.insertAt('We report', 'Drafted sentence here. ', aiAnn());
    tab.outbox.length = 0;
    void draft; // lost with the crash
    server.restart();
    tab.onSnapshot(server.snapshot(), true);
    deliverAll(server, tab);
    expect(server.text).toBe(tab.text);
    expect(server.text).toContain('Typed. The test set');
    expect(server.text).toContain('Drafted sentence here. We report');
    const d = server.applied.filter((a) => a.inserted.some((s) => s.includes('Drafted sentence')));
    expect(d.map((x) => x.annotation?.origin)).toEqual(['ai_draft']);
    expect(tab.notices.map((n) => n.level)).toEqual(['info']);
  });

  it('a file pulled while the server was down keeps the co-author edit AND the lost unsaved edit', () => {
    const server = new FakeServer(PAPER);
    const tab = new Tab(server.snapshot());
    tab.insertAt('The test set', 'Unsaved. ');
    deliverAll(server, tab);
    tab.patched(server.version);
    // the server died before writing; meanwhile `paper pull` brought a co-author edit on another line
    server.restart(server.disk.replace('every particle species.', 'all three species.'));
    tab.onSnapshot(server.snapshot(), true);
    deliverAll(server, tab);
    expect(server.text).toBe(tab.text);
    expect(server.text).toContain('Unsaved. The test set');
    expect(server.text).toContain('all three species.');
    expect(tab.notices.map((n) => n.level)).toEqual(['info']);
  });

  it('edits saved before a graceful restart are not duplicated; a pulled edit is applied to the editor', () => {
    const server = new FakeServer(PAPER);
    const tab = new Tab(server.snapshot());
    tab.insertAt('The test set', 'Saved. ');
    deliverAll(server, tab);
    tab.patched(server.version);
    server.save();
    server.restart(server.disk.replace('every particle species.', 'all three species.'));
    tab.onSnapshot(server.snapshot(), true);
    deliverAll(server, tab);
    expect(tab.text).toBe(server.text);
    expect(server.text.split('Saved. ').length - 1).toBe(1);
    expect(tab.text).toContain('all three species.');
    expect(tab.notices).toEqual([]);
  });

  it('a line changed both on disk and in the editor keeps the editor version and says so', () => {
    const server = new FakeServer(PAPER);
    const tab = new Tab(server.snapshot());
    tab.insertAt('every particle', 'nearly ');
    deliverAll(server, tab);
    tab.patched(server.version);
    server.restart(server.disk.replace('every particle species.', 'all three species.'));
    tab.onSnapshot(server.snapshot(), true);
    deliverAll(server, tab);
    expect(server.text).toBe(tab.text);
    expect(tab.text).toContain('This lead holds for nearly every particle species.');
    expect(tab.notices).toHaveLength(1);
    expect(tab.notices[0]!.level).toBe('warn');
    const line = tab.text.split('\n').findIndex((l) => l.startsWith('This lead')) + 1;
    expect(tab.notices[0]!.message).toContain(`line ${line}`);
  });
});

describe('fuzz: random typing, random server-side rewrites, random delivery', () => {
  // xorshift: deterministic
  const rng = (seed: number) => () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 1_000_000) / 1_000_000;
  };
  for (const seed of [1, 7, 42, 2026, 31337]) {
    it(`seed ${seed}: every marker typed in the tab and every marker written on disk survives; server == tab`, () => {
      const r = rng(seed);
      const server = new FakeServer(PAPER);
      const tab = new Tab(server.snapshot());
      const local: string[] = [];
      const remote: string[] = [];
      const inFlight: DocChangeMsg[] = [];
      // insert only after whitespace (or at 0): a later insert never splits an earlier marker
      const pick = (t: string) => {
        const ok = [0];
        for (let i = 1; i <= t.length; i++) if (/\s/.test(t[i - 1]!)) ok.push(i);
        return ok[Math.floor(r() * ok.length)]!;
      };
      for (let step = 0; step < 120; step++) {
        const x = r();
        if (x < 0.45) {
          const mk = ` L${step} `;
          const pos = pick(tab.text);
          tab.type({ from: pos, insert: mk }, r() < 0.2 ? aiAnn() : null);
          local.push(mk.trim());
          inFlight.push(...tab.outbox.splice(0));
        } else if (x < 0.6) {
          const mk = ` R${step} `;
          const pos = pick(server.text);
          tab.onReplace(server.replace(server.text.slice(0, pos) + mk + server.text.slice(pos)));
          remote.push(mk.trim());
        } else if (inFlight.length) {
          deliver(server, tab, inFlight.shift()!);
          inFlight.push(...tab.outbox.splice(0));
        }
      }
      while (inFlight.length) {
        deliver(server, tab, inFlight.shift()!);
        inFlight.push(...tab.outbox.splice(0));
      }
      expect(server.text).toBe(tab.text);
      for (const mk of [...local, ...remote]) expect(server.text, mk).toContain(mk);
      expect(tab.core.pending()).toEqual([]);
    });
  }
});

describe('merge3', () => {
  const B = 'a\nb\nc\nd\ne\n';
  it('takes one-sided changes from both sides', () => {
    expect(merge3(B, 'a\nB\nc\nd\ne\n', 'a\nb\nc\nD\ne\n')).toEqual({ text: 'a\nB\nc\nD\ne\n', conflicts: [] });
  });
  it('takes an identical change once', () => {
    expect(merge3(B, 'a\nX\nc\nd\ne\n', 'a\nX\nc\nd\ne\nf\n')).toEqual({ text: 'a\nX\nc\nd\ne\nf\n', conflicts: [] });
  });
  it('keeps ours on a conflict and reports its line', () => {
    expect(merge3(B, 'a\nb\nOURS\nd\ne\n', 'a\nb\nTHEIRS\nd\ne\n')).toEqual({ text: 'a\nb\nOURS\nd\ne\n', conflicts: [3] });
  });
  it('handles insertions at the ends and deletions', () => {
    expect(merge3(B, 'top\na\nb\nc\nd\ne\n', 'a\nb\nd\ne\nend')).toEqual({ text: 'top\na\nb\nd\ne\nend', conflicts: [] });
  });
  it('lineHunks reproduces the target', () => {
    const a = splitLines('x\ny\nz\nw\n');
    const b = splitLines('x\nq\nz\nw\nv\n');
    const hs = lineHunks(a, b);
    let out: string[] = [];
    let pos = 0;
    for (const h of hs) {
      out = out.concat(a.slice(pos, h.aStart), b.slice(h.bStart, h.bEnd));
      pos = h.aEnd;
    }
    out = out.concat(a.slice(pos));
    expect(out.join('')).toBe(b.join(''));
  });
});

describe('merge3: neighbouring sentences', () => {
  const B = 'a\nb\nc\nd\n';
  it('edits of adjacent lines by the two sides both apply', () => {
    expect(merge3(B, 'a\nB\nc\nd\n', 'a\nb\nC\nd\n')).toEqual({ text: 'a\nB\nC\nd\n', conflicts: [] });
  });
  it('a line inserted by theirs right before a line we edited keeps both', () => {
    expect(merge3(B, 'a\nB\nc\nd\n', 'a\nnew\nb\nc\nd\n')).toEqual({ text: 'a\nnew\nB\nc\nd\n', conflicts: [] });
  });
  it('an inserted line that ours already contains (saved before a crash) is not duplicated', () => {
    expect(merge3(B, 'a\nnew\nB\nc\nd\n', 'a\nnew\nb\nc\nd\n')).toEqual({ text: 'a\nnew\nB\nc\nd\n', conflicts: [] });
  });
});

describe('fuzz: two tabs typing at once, plus pulls', () => {
  const rng = (seed: number) => () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 1_000_000) / 1_000_000;
  };
  for (const seed of [3, 11, 99, 4242]) {
    it(`seed ${seed}: no tab ever deletes another tab's (or the disk's) text`, () => {
      const r = rng(seed);
      const server = new FakeServer(PAPER);
      const tabs = [new Tab(server.snapshot()), new Tab(server.snapshot())];
      const wire: Array<DocChangeMsg[]> = [[], []];
      const markers: string[] = [];
      const pick = (t: string) => {
        const ok = [0];
        for (let i = 1; i <= t.length; i++) if (/\s/.test(t[i - 1]!)) ok.push(i);
        return ok[Math.floor(r() * ok.length)]!;
      };
      for (let step = 0; step < 150; step++) {
        const k = r() < 0.5 ? 0 : 1;
        const tab = tabs[k]!;
        const x = r();
        if (x < 0.4) {
          const mk = ` T${k}s${step} `;
          tab.type({ from: pick(tab.text), insert: mk });
          markers.push(mk.trim());
        } else if (x < 0.47) {
          const mk = ` D${step} `;
          const pos = pick(server.text);
          const rep = server.replace(server.text.slice(0, pos) + mk + server.text.slice(pos));
          for (const t of tabs) t.onReplace(rep);
          markers.push(mk.trim());
        } else if (wire[k]!.length) {
          deliver(server, tab, wire[k]!.shift()!);
        }
        for (let j = 0; j < 2; j++) wire[j]!.push(...tabs[j]!.outbox.splice(0));
      }
      for (let guard = 0; guard < 500 && (wire[0]!.length || wire[1]!.length); guard++) {
        for (let j = 0; j < 2; j++) {
          if (wire[j]!.length) deliver(server, tabs[j]!, wire[j]!.shift()!);
          wire[j]!.push(...tabs[j]!.outbox.splice(0));
        }
      }
      for (const mk of markers) expect(server.text, mk).toContain(mk);
      for (const t of tabs) expect(t.core.pending()).toEqual([]);
    });
  }
});
