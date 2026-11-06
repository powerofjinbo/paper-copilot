/**
 * Pure bookkeeping for document sync (docs: packages/core/src/api.ts, "Text ownership").
 *
 * The editor is the only writer of the text. Every local transaction becomes one `doc.change` with a
 * sequential `baseVersion` and is kept in a contiguous log until both (a) the server acknowledged it and
 * (b) a unit patch at a newer version arrived. The log serves two purposes:
 *  - mapping: server spans tagged with version v are mapped into current coordinates through the log
 *    entries with baseVersion >= v (the changes the server had not seen at v);
 *  - recovery: after a reconnect (or a rejected change), the server snapshot is compared with
 *    "snapshot + remaining log"; if that does not reproduce the local text, one diff change is sent, so the
 *    author's text is never lost.
 * No DOM, no network: unit-tested in apps/web/test/editor-sync.test.ts.
 */
import { ChangeSet, Text } from '@codemirror/state';
import type { ChangeAnnotation, ClientMessage, IntentLineInfo, SentenceUnit, ServerMessage } from '@paper-copilot/core';
import { mapUnitList } from '../units';

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
}

export interface ReconcileResult {
  /** Messages to send, in order (re-sent log entries, or one diff change). */
  send: DocChangeMsg[];
  /** True if "snapshot + remaining log" reproduced the local text. */
  replayed: boolean;
  /** The diff change that replaces the log when the replay failed (null if none was needed). */
  diff: ChangeSet | null;
}

/** Build a CodeMirror Text exactly as the editor stores it (the editor uses "\n" as its only line separator). */
export function textOf(s: string): Text {
  return Text.of(s.split('\n'));
}

export function toMessage(file: string, e: LogEntry): DocChangeMsg {
  return { type: 'doc.change', file, baseVersion: e.baseVersion, changes: e.changes.toJSON(), annotation: e.annotation };
}

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

  constructor(readonly file: string) {}

  /** Start over at a server version, keeping `keep` (contiguous from `version`) as unacknowledged changes. */
  reset(version: number, keep: LogEntry[] = []): void {
    this.initialized = true;
    this.log = keep;
    this.localVersion = version + keep.length;
    this.ackedVersion = version;
    this.unitsVersion = version;
  }

  /** Record one local transaction; returns the doc.change to send. */
  local(changes: ChangeSet, annotation: ChangeAnnotation | null, sent: boolean): DocChangeMsg {
    const entry: LogEntry = { baseVersion: this.localVersion, changes, annotation, sent };
    this.log.push(entry);
    this.localVersion++;
    return toMessage(this.file, entry);
  }

  /** Changes the server has not acknowledged yet. */
  pending(): LogEntry[] {
    return this.log.filter((e) => e.baseVersion >= this.ackedVersion);
  }

  /** Unsent changes (made while disconnected). */
  unsent(): LogEntry[] {
    return this.log.filter((e) => !e.sent && e.baseVersion >= this.ackedVersion);
  }

  /** doc.ack(v): the server is at version v. */
  ack(version: number): void {
    const v = Math.min(version, this.localVersion);
    if (v > this.ackedVersion) this.ackedVersion = v;
    this.trim();
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
   * A snapshot arrived after the first one (reconnect, or the server rejected a change). Entries with
   * baseVersion < snapshot.version are taken as applied. If the snapshot text plus the remaining entries
   * reproduces `localText`, the remaining entries stay pending (re-sent after a reconnect, or if they were
   * never sent); otherwise one diff change from the snapshot text to the local text replaces them.
   */
  reconcile(
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
      this.reset(V, remaining);
      const resend = remaining.filter((e) => opts.reconnect || !e.sent);
      for (const e of resend) e.sent = opts.connected;
      return { send: opts.connected ? resend.map((e) => toMessage(this.file, e)) : [], replayed: true, diff: null };
    }
    this.reset(V, []);
    if (snapshot.text === localText) return { send: [], replayed: false, diff: null };
    const cs = opts.diff(snapshot.text, localText);
    const msg = this.local(cs, null, opts.connected);
    return { send: opts.connected ? [msg] : [], replayed: false, diff: cs };
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
