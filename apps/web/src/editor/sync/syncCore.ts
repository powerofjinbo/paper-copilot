/**
 * Pure bookkeeping for document sync (docs: packages/core/src/api.ts, "Text ownership").
 *
 * The editor is the only writer of the text. Every local transaction becomes one `doc.change` with a
 * sequential `baseVersion` and is kept in a contiguous log until both (a) the server acknowledged it and
 * (b) a unit patch at a newer version arrived. The log serves two purposes:
 *  - mapping: server spans tagged with version v are mapped into current coordinates through the log
 *    entries with baseVersion >= v (the changes the server had not seen at v);
 *  - recovery: after a reconnect (or a rejected change), the server snapshot is compared with
 *    "snapshot + remaining log". If that does not reproduce the local text, the server has text the editor
 *    has not seen (a pull, a disk edit, a semantic-lines rewrite, another tab): the unacknowledged entries
 *    are REBASED onto the snapshot (each keeps its ChangeAnnotation, so AI provenance survives), and the
 *    server's changes, mapped over them, are applied to the editor (`ReconcileResult.remote`). Nobody's text
 *    is overwritten by a diff. Overlapping edits keep both texts and are reported (`conflicts`).
 *  - restart: a snapshot older than the acknowledged version comes from a new server process that lost
 *    its unsaved text. The acknowledged text is three-way merged (merge3.ts) with the snapshot, on the last
 *    text known to come from disk: edits made on disk meanwhile are kept, the server's lost edits are
 *    re-sent as one change (`diff`), conflicting lines keep the editor's version and are reported; unless
 *    the snapshot is past version 0 (another tab already restored and edited it): then its lines win.
 * One change in flight (DocSync uses `takeNext`): the server applies a doc.change whenever its baseVersion
 * and length match its own, so a second change sent before a rejection could be applied to the REPLACED
 * text in the wrong coordinates when the lengths happen to agree (a co-author's one-character fix vs one
 * typed character). With at most one unacknowledged change on the wire, a rejected change is the only one
 * in flight, and every later change is based on the snapshot.
 * The core keeps the server text at the acknowledged version (`ackedText`); callers pass the text to
 * `reset`. Without it (legacy callers) the old "one diff to the local text" recovery is used.
 * No DOM, no network: unit-tested in apps/web/test/editor-sync.test.ts.
 */
import { ChangeSet, Text } from '@codemirror/state';
import type { ChangeAnnotation, ClientMessage, IntentLineInfo, SentenceUnit, ServerMessage } from '@paper-copilot/core';
import { mapUnitList } from '../units';
import { merge3 } from './merge3';

export type DocChangeMsg = Extract<ClientMessage, { type: 'doc.change' }>;
export type SnapshotMsg = Extract<ServerMessage, { type: 'doc.snapshot' }>;
export type PatchMsg = Extract<ServerMessage, { type: 'sentences.patch' }>;
export type ReplaceMsg = Extract<ServerMessage, { type: 'doc.replace' }>;

export interface LogEntry {
  baseVersion: number;
  changes: ChangeSet;
  annotation: ChangeAnnotation | null;
  /** False if the change was made while disconnected (it must be sent after the reconnect snapshot). */
  sent: boolean;
  /**
   * The change that re-sends text a restarted server lost (not the author's typing). Until it is acknowledged,
   * a newer server text (another tab restored first) makes the core RECOMPUTE it rather than rebase it:
   * rebased like typing, the same lost text would be inserted twice.
   */
  restore?: boolean;
}

export interface ReconcileResult {
  /** Messages to send, in order (re-sent or rebased log entries, after a restart the restore change first). */
  send: DocChangeMsg[];
  /** True if "snapshot + remaining log" reproduced the local text. */
  replayed: boolean;
  /**
   * Server-side text the editor had not seen, in CURRENT local coordinates: the caller must apply it to the
   * editor (as a remote change, outside the undo history) before mapping the snapshot's units. Null if none.
   */
  remote: ChangeSet | null;
  /**
   * A change re-sending text the server lost (it restarted without the acknowledged, unsaved edits), or,
   * for a caller that never passed the text to `reset`, the legacy diff to the local text. Null if none.
   */
  diff: ChangeSet | null;
  /** 1-based line numbers (in the resulting local text) where local and server-side edits overlapped. */
  conflicts: number[];
  /** How the snapshot was reconciled. */
  mode: 'replay' | 'rebase' | 'restart' | 'legacy';
}

/** Build a CodeMirror Text exactly as the editor stores it (the editor uses "\n" as its only line separator). */
export function textOf(s: string): Text {
  return Text.of(s.split('\n'));
}

/** `epoch`: the version of the last snapshot/replace the core was reset to (see api.ts doc.change). */
export function toMessage(file: string, e: LogEntry, epoch?: number): DocChangeMsg {
  const msg: DocChangeMsg = { type: 'doc.change', file, baseVersion: e.baseVersion, changes: e.changes.toJSON(), annotation: e.annotation };
  if (epoch !== undefined) msg.epoch = epoch;
  return msg;
}

/** What SyncCore.remote did with a doc.remoteChange. */
export type RemoteResult =
  /** Integrated: apply `change` (current local coordinates) to the editor as a remote change. */
  | { kind: 'apply'; change: ChangeSet }
  /** Already contained in the local text (older than the acknowledged version). */
  | { kind: 'stale' }
  /** Not integrated (a gap, a queued replace, unknown text): the tab is behind until the next snapshot. */
  | { kind: 'behind' };

export class SyncCore {
  initialized = false;
  /** Version of the current local text = baseVersion of the next local change. */
  localVersion = 0;
  /** The server has applied every change with baseVersion < ackedVersion. */
  ackedVersion = 0;
  /** Version of the newest unit information applied (snapshot or patch). */
  unitsVersion = 0;
  /** Contiguous: log[i].baseVersion === log[0].baseVersion + i. */
  log: LogEntry[] = [];
  /** A doc.replace that arrived while local changes were unacknowledged. */
  queuedReplace: ReplaceMsg | null = null;
  /** The server text at `ackedVersion` (null if the caller never told the core the text). */
  ackedText: Text | null = null;
  /**
   * The last text known to come from the server's disk read (initial snapshot, doc.replace, the snapshot of
   * a restarted server): the merge base after a restart.
   */
  diskText: Text | null = null;
  /** Version of the last snapshot / replace the core was reset to: sent with every doc.change. */
  epoch = 0;
  /**
   * A doc.remoteChange could not be integrated: the server has text this tab has not seen. Cleared by the
   * next snapshot or replace; DocSync asks for a snapshot once nothing of its own is pending.
   */
  behind = false;
  /**
   * While a restore change is unacknowledged: the old server's text it restores (`ours`) and the disk text the
   * merge is based on, so a newer snapshot can recompute the restore (see LogEntry.restore).
   */
  private restartInfo: { ours: string; diskBase: string } | null = null;

  constructor(readonly file: string) {}

  /**
   * Start over at a server version, keeping `keep` (contiguous from `version`) as unacknowledged changes.
   * `text` is the server text at `version`; `fromDisk` marks it as read from disk (snapshot of a fresh open,
   * doc.replace), so it becomes the merge base after a server restart.
   */
  reset(version: number, keep: LogEntry[] = [], text?: string | Text, fromDisk = text !== undefined): void {
    this.initialized = true;
    this.log = keep;
    this.localVersion = version + keep.length;
    this.ackedVersion = version;
    this.unitsVersion = version;
    this.ackedText = text === undefined ? null : typeof text === 'string' ? textOf(text) : text;
    if (fromDisk && this.ackedText) this.diskText = this.ackedText;
    this.epoch = version;
    this.behind = false;
  }

  /**
   * A change the server applied on behalf of another tab (doc.remoteChange): it is recorded as an
   * acknowledged entry, so later server spans map through it. Only valid when nothing is
   * pending and the change starts at `localVersion`.
   */
  adoptRemote(changes: ChangeSet): boolean {
    if (!this.initialized || this.pending().length > 0 || this.queuedReplace) return false;
    if (this.ackedText && changes.length !== this.ackedText.length) return false;
    this.log.push({ baseVersion: this.localVersion, changes, annotation: null, sent: true });
    this.localVersion++;
    this.ackedVersion = this.localVersion;
    if (this.ackedText) this.ackedText = changes.apply(this.ackedText);
    this.trim();
    return true;
  }

  /** Record one local transaction; returns the doc.change to send. */
  local(changes: ChangeSet, annotation: ChangeAnnotation | null, sent: boolean): DocChangeMsg {
    const entry: LogEntry = { baseVersion: this.localVersion, changes, annotation, sent };
    this.log.push(entry);
    this.localVersion++;
    return toMessage(this.file, entry, this.epoch);
  }

  /**
   * doc.remoteChange: the server applied `changes` (another tab's) at `version - 1`.
   *  - at the acknowledged version with nothing pending: adopted as an acknowledged entry;
   *  - at the acknowledged version with pending local changes: the pending entries are REBASED over it
   *    (annotations kept; the one in flight stays "in flight": the server is past its base version, so it
   *    rejects it and sends the snapshot that the replay path then reconciles), and the remote change, mapped
   *    over them, is returned for the editor. Same insertion-order rule as the snapshot rebase (remote first);
   *  - older than the acknowledged version: already contained ('stale');
   *  - anything else (a gap, a queued replace, no known server text): 'behind'.
   */
  remote(changes: ChangeSet, version: number): RemoteResult {
    const base = version - 1;
    if (!this.initialized) return { kind: 'behind' };
    if (base < this.ackedVersion) return { kind: 'stale' };
    if (this.queuedReplace || base !== this.ackedVersion) {
      this.behind = true;
      return { kind: 'behind' };
    }
    const pending = this.pending();
    if (pending[0]?.restore) {
      // another tab restored first: our restore is rejected, and the snapshot that follows recomputes it
      this.behind = true;
      return { kind: 'behind' };
    }
    if (pending.length === 0) {
      if (this.ackedText && changes.length !== this.ackedText.length) {
        this.behind = true;
        return { kind: 'behind' };
      }
      if (!this.adoptRemote(changes)) {
        this.behind = true;
        return { kind: 'behind' };
      }
      return { kind: 'apply', change: changes };
    }
    const acked = this.ackedText;
    if (!acked || changes.length !== acked.length) {
      this.behind = true;
      return { kind: 'behind' };
    }
    const kept = this.log.filter((e) => e.baseVersion < this.ackedVersion);
    const out: LogEntry[] = [...kept, { baseVersion: base, changes, annotation: null, sent: true }];
    let v = base + 1;
    let mapped = changes;
    for (const e of pending) {
      out.push({ baseVersion: v++, changes: e.changes.map(mapped), annotation: e.annotation, sent: e.sent });
      mapped = mapped.map(e.changes, true);
    }
    this.log = out;
    this.ackedText = changes.apply(acked);
    this.ackedVersion = base + 1;
    this.localVersion = v;
    this.trim();
    return { kind: 'apply', change: mapped };
  }

  /** Changes the server has not acknowledged yet. */
  pending(): LogEntry[] {
    return this.log.filter((e) => e.baseVersion >= this.ackedVersion);
  }

  /** Unsent changes (made while disconnected, or waiting for the change in flight). */
  unsent(): LogEntry[] {
    return this.log.filter((e) => !e.sent && e.baseVersion >= this.ackedVersion);
  }

  /** Is a change on the wire (sent, not acknowledged)? */
  inFlight(): boolean {
    return this.log.some((e) => e.sent && e.baseVersion >= this.ackedVersion);
  }

  /** The next change to send under the one-in-flight rule (marked sent), or null. */
  takeNext(): DocChangeMsg | null {
    if (!this.initialized || this.inFlight()) return null;
    const e = this.log.find((x) => !x.sent && x.baseVersion >= this.ackedVersion);
    if (!e) return null;
    e.sent = true;
    return toMessage(this.file, e, this.epoch);
  }

  /** doc.ack(v): the server is at version v. Returns the entries this ack acknowledged. */
  ack(version: number): LogEntry[] {
    const v = Math.min(version, this.localVersion);
    const done = this.log.filter((e) => e.baseVersion >= this.ackedVersion && e.baseVersion < v);
    if (done.some((e) => e.restore)) this.restartInfo = null;
    if (v > this.ackedVersion) {
      if (this.ackedText) {
        let t: Text | null = this.ackedText;
        for (const e of done) {
          if (!t || e.changes.length !== t.length) {
            t = null;
            break;
          }
          t = e.changes.apply(t);
        }
        this.ackedText = t;
      }
      this.ackedVersion = v;
    }
    this.trim();
    return done;
  }

  /** Oldest version whose positions can still be mapped to the present. */
  get logStart(): number {
    return this.log.length ? this.log[0]!.baseVersion : this.localVersion;
  }

  /** The composition of local changes made after `version`, or null if the log does not cover it. */
  changesSince(version: number, docLength: number): ChangeSet | null {
    if (version > this.localVersion || version < this.logStart) return null;
    let cs: ChangeSet | null = null;
    for (const e of this.log) {
      if (e.baseVersion < version) continue;
      cs = cs ? cs.compose(e.changes) : e.changes;
    }
    return cs ?? ChangeSet.empty(docLength);
  }

  /** Map spans that refer to server version `version` into the current document `doc`. */
  mapUnits(units: readonly SentenceUnit[], version: number, doc: Text): SentenceUnit[] | null {
    const cs = this.changesSince(version, doc.length);
    if (!cs) return null;
    return mapUnitList(units, cs, doc);
  }

  mapIntentLines(lines: readonly IntentLineInfo[], version: number, doc: Text): IntentLineInfo[] | null {
    const cs = this.changesSince(version, doc.length);
    if (!cs) return null;
    const out: IntentLineInfo[] = [];
    for (const l of lines) {
      if (l.end > cs.length) continue;
      const start = cs.mapPos(l.start, 1);
      const end = cs.mapPos(l.end, -1);
      if (end <= start) continue;
      out.push({ ...l, start, end, line: doc.lineAt(start).number, text: doc.sliceString(start, end) });
    }
    return out;
  }

  /** A patch for `version` was applied. */
  notePatch(version: number): void {
    if (version > this.unitsVersion) this.unitsVersion = version;
    this.trim();
  }

  /** Should a sentences.patch tagged `version` be applied? (Not from a future or diverged lineage.) */
  acceptsPatch(version: number): boolean {
    if (!this.initialized || version > this.localVersion) return false;
    if (this.queuedReplace && version >= this.queuedReplace.version) return false;
    return true;
  }

  private trim(): void {
    const keep = Math.min(this.unitsVersion, this.ackedVersion);
    let i = 0;
    while (i < this.log.length && this.log[i]!.baseVersion < keep) i++;
    if (i) this.log = this.log.slice(i);
  }

  /**
   * A snapshot arrived after the first one (reconnect, or the server rejected a change).
   *  1. replay: if the snapshot text plus the log entries with baseVersion >= snapshot.version reproduces
   *     `localText`, those entries stay pending (re-sent after a reconnect, or if they were never sent);
   *  2. rebase (same server process): the unacknowledged entries are rebased onto the snapshot, keeping their
   *     annotations; `remote` brings the editor to "snapshot + rebased entries";
   *  3. restart (snapshot.version < ackedVersion): see the header; `diff` re-sends the lost text;
   *  4. legacy (no `ackedText`): one diff change from the snapshot text to the local text.
   */
  reconcile(
    snapshot: { version: number; text: string },
    localText: string,
    opts: {
      reconnect: boolean;
      connected: boolean;
      diff: (a: string, b: string) => ChangeSet;
      /** DocSync: leave every pending entry unsent (send them with `takeNext`); `send` is then empty. */
      oneInFlight?: boolean;
    },
  ): ReconcileResult {
    const res = this.reconcileInner(snapshot, localText, opts);
    if (!opts.oneInFlight) return res;
    // nothing is on the wire after a snapshot: a rejected change is gone, a reconnect has a new socket
    for (const e of this.pending()) e.sent = false;
    return { ...res, send: [] };
  }

  private reconcileInner(
    snapshot: { version: number; text: string },
    localText: string,
    opts: { reconnect: boolean; connected: boolean; diff: (a: string, b: string) => ChangeSet },
  ): ReconcileResult {
    const V = snapshot.version;
    if (this.queuedReplace && this.queuedReplace.version <= V) this.queuedReplace = null;
    const remaining = this.log.filter((e) => e.baseVersion >= V);
    let ok = remaining.length === 0 || remaining[0]!.baseVersion === V;
    if (ok) {
      let doc = textOf(snapshot.text);
      for (const e of remaining) {
        if (e.changes.length !== doc.length) {
          ok = false;
          break;
        }
        doc = e.changes.apply(doc);
      }
      ok = ok && doc.toString() === localText;
    }
    if (ok) {
      this.reset(V, remaining, snapshot.text, false);
      const resend = remaining.filter((e) => opts.reconnect || !e.sent);
      for (const e of resend) e.sent = opts.connected;
      return { send: opts.connected ? resend.map((e) => toMessage(this.file, e, this.epoch)) : [], replayed: true, remote: null, diff: null, conflicts: [], mode: 'replay' };
    }

    const pending = this.pending();
    const acked = this.ackedText;
    if (!acked || !this.consistent(acked, pending, localText)) return this.legacy(snapshot, localText, opts);

    if (this.restartInfo && pending[0]?.restore && pending[0].changes.length === acked.length) {
      // our restore was not applied (another tab restored first, or the server restarted again): recompute it
      // against the server's current text, from the same old server text and disk base
      const { ours, diskBase } = this.restartInfo;
      const restored = pending[0].changes.apply(acked);
      return this.restartMerge(snapshot, ours, diskBase, restored, pending.slice(1), opts);
    }
    if (V < this.ackedVersion) return this.restart(snapshot, acked, pending, opts);

    // Same server process. After a reconnect some pending entries may have been applied with their acks
    // lost: assume the k first were applied when that explains the snapshot best (k <= V - ackedVersion).
    let k = 0;
    let base = acked;
    let serverSide = opts.diff(acked.toString(), snapshot.text);
    if (opts.reconnect) {
      let t = acked;
      for (let i = 0; i < Math.min(pending.length, V - this.ackedVersion); i++) {
        t = pending[i]!.changes.apply(t);
        const d = opts.diff(t.toString(), snapshot.text);
        if (changeSize(d) < changeSize(serverSide)) {
          k = i + 1;
          base = t;
          serverSide = d;
        }
      }
    }
    const res = this.rebase(V, snapshot.text, base, pending.slice(k), serverSide, null, opts);
    return { ...res, mode: 'rebase' };
  }

  /** Does `start` + `entries` reproduce `localText`? (Guards the stored text against drift.) */
  private consistent(start: Text, entries: LogEntry[], localText: string): boolean {
    let t = start;
    for (const e of entries) {
      if (e.changes.length !== t.length) return false;
      t = e.changes.apply(t);
    }
    return t.length === localText.length && t.toString() === localText;
  }

  /**
   * Rebase `entries` (starting at `base`) over `serverSide` (base -> the server's text). `restore` (already a
   * change on the snapshot text) is sent first. The editor receives `serverSide` mapped over the entries.
   */
  private rebase(
    V: number,
    snapshotText: string,
    base: Text,
    entries: LogEntry[],
    serverSide: ChangeSet,
    restore: ChangeSet | null,
    opts: { connected: boolean },
  ): Omit<ReconcileResult, 'mode'> {
    const out: LogEntry[] = [];
    let version = V;
    if (restore && !restore.empty) out.push({ baseVersion: version++, changes: restore, annotation: null, sent: opts.connected });
    let remote = serverSide;
    // positions of overlapping edits, kept in the coordinates of the local text processed so far
    let conflictAt: number[] = [];
    for (const e of entries) {
      const hit = firstTouch(e.changes, remote);
      conflictAt = conflictAt.map((p) => e.changes.mapPos(p, 1));
      if (hit >= 0) conflictAt.push(e.changes.mapPos(hit, 1));
      out.push({ baseVersion: version++, changes: e.changes.map(remote), annotation: e.annotation, sent: opts.connected });
      remote = remote.map(e.changes, true);
    }
    this.reset(V, out, snapshotText, false);
    const local = remote.empty ? null : remote;
    let conflicts: number[] = [];
    if (conflictAt.length) {
      let result = textOf(snapshotText);
      for (const e of out) result = e.changes.apply(result);
      const after = local ? conflictAt.map((p) => local.mapPos(p, 1)) : conflictAt;
      conflicts = [...new Set(after.map((p) => result.lineAt(Math.min(p, result.length)).number))].sort((x, y) => x - y);
    }
    return {
      send: opts.connected ? out.map((e) => toMessage(this.file, e, this.epoch)) : [],
      replayed: false,
      remote: local,
      diff: restore && !restore.empty ? restore : null,
      conflicts,
    };
  }

  /** A restarted server (new version lineage) lost its unsaved text: merge, restore, rebase. */
  private restart(
    snapshot: { version: number; text: string },
    acked: Text,
    pending: LogEntry[],
    opts: { connected: boolean; diff: (a: string, b: string) => ChangeSet },
  ): ReconcileResult {
    const diskBase = this.diskText ? this.diskText.toString() : snapshot.text;
    return this.restartMerge(snapshot, acked.toString(), diskBase, acked, pending, opts);
  }

  /**
   * Merge `ours` (the old server's text) with the snapshot on `diskBase`, restore what the server lacks, and
   * rebase `entries` (the author's typing, based on `entriesBase`) onto the result.
   */
  private restartMerge(
    snapshot: { version: number; text: string },
    ours: string,
    diskBase: string,
    entriesBase: Text,
    entries: LogEntry[],
    opts: { connected: boolean; diff: (a: string, b: string) => ChangeSet },
  ): ReconcileResult {
    // A restarted server starts at version 0 with the text it read from disk. A snapshot past 0 means another
    // tab already reconnected, restored the lost text from ITS log and may have typed on: where both sides
    // changed a line, the server's line descends from ours (same old server state + newer typing), so ours
    // must not overwrite it (an idle tab would otherwise "restore" an older copy of the line and delete the
    // other tab's latest characters). Lines only we changed are still restored.
    const merged = merge3(diskBase, ours, snapshot.text, { prefer: snapshot.version > 0 ? 'theirs' : 'ours' });
    const restore = merged.text === snapshot.text ? null : opts.diff(snapshot.text, merged.text);
    const serverSide = opts.diff(entriesBase.toString(), merged.text);
    const res = this.rebase(snapshot.version, snapshot.text, entriesBase, entries, serverSide, restore, opts);
    if (restore && !restore.empty && this.log[0]) {
      this.log[0].restore = true;
      this.restartInfo = { ours, diskBase };
    } else this.restartInfo = null;
    // a fresh process read this text from disk
    if (snapshot.version === 0) this.diskText = textOf(snapshot.text);
    let conflicts = res.conflicts;
    if (merged.conflicts.length) {
      // merge3 line numbers refer to the merged acknowledged text: map them through the rebased entries
      const mergedDoc = textOf(merged.text);
      let positions = merged.conflicts.map((l) => mergedDoc.line(Math.min(l, mergedDoc.lines)).from);
      for (const e of this.log.slice(restore ? 1 : 0)) positions = positions.map((p) => e.changes.mapPos(p, 1));
      let doc = textOf(snapshot.text);
      for (const e of this.log) doc = e.changes.apply(doc);
      conflicts = [...new Set([...conflicts, ...positions.map((p) => doc.lineAt(Math.min(p, doc.length)).number)])].sort((a, b) => a - b);
    }
    return { ...res, conflicts, mode: 'restart' };
  }

  /** No stored text: one diff change from the snapshot text to the local text (the author's text wins). */
  private legacy(snapshot: { version: number; text: string }, localText: string, opts: { connected: boolean; diff: (a: string, b: string) => ChangeSet }): ReconcileResult {
    const V = snapshot.version;
    this.reset(V, [], snapshot.text, false);
    if (snapshot.text === localText) return { send: [], replayed: false, remote: null, diff: null, conflicts: [], mode: 'legacy' };
    const cs = opts.diff(snapshot.text, localText);
    const msg = this.local(cs, null, opts.connected);
    return { send: opts.connected ? [msg] : [], replayed: false, remote: null, diff: cs, conflicts: [], mode: 'legacy' };
  }

  /** doc.replace: 'apply' now, or 'queued' until the pending changes are acknowledged. */
  offerReplace(msg: ReplaceMsg): 'apply' | 'queued' {
    if (this.pending().length > 0) {
      this.queuedReplace = msg;
      return 'queued';
    }
    return 'apply';
  }

  /** After an ack: a queued replace to apply now, a request to re-sync, or nothing. */
  drainReplace(): { apply: ReplaceMsg } | { resync: true } | null {
    const r = this.queuedReplace;
    if (!r || this.pending().length > 0) return null;
    this.queuedReplace = null;
    // The server applied our changes before the replace: the replace text already contains them.
    if (r.version >= this.ackedVersion) return { apply: r };
    // The server accepted a change on top of the replaced text: ask for a fresh snapshot.
    return { resync: true };
  }
}

/** Characters deleted + inserted by a change set (to compare candidate explanations of a snapshot). */
function changeSize(cs: ChangeSet): number {
  let n = 0;
  cs.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    n += toA - fromA + inserted.length;
  });
  return n;
}

/** Changed ranges in A coordinates. */
function rangesA(cs: ChangeSet): Array<[number, number, boolean]> {
  const out: Array<[number, number, boolean]> = [];
  cs.iterChanges((fromA, toA, fromB, toB) => out.push([fromA, toA, toB > fromB]));
  return out;
}

/**
 * Where two change sets on the same document edit the same text (-1 if nowhere): overlapping replaced
 * ranges, an insertion strictly inside the other's replaced range, or two insertions at the same point.
 */
function firstTouch(a: ChangeSet, b: ChangeSet): number {
  const ra = rangesA(a);
  const rb = rangesA(b);
  for (const [af, at, ai] of ra) {
    for (const [bf, bt, bi] of rb) {
      const overlap = Math.min(at, bt) - Math.max(af, bf);
      if (overlap > 0) return Math.max(af, bf);
      if (af === at && ai && bf < af && af < bt) return af;
      if (bf === bt && bi && af < bf && bf < at) return bf;
      if (af === at && bf === bt && af === bf && ai && bi) return af;
    }
  }
  return -1;
}
