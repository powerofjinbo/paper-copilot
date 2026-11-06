/**
 * Document sync wiring: ApiClient messages <-> SyncCore <-> EditorView. See syncCore.ts for the rules.
 *
 * Tabs of the same browser that edit the same file relay the changes the server acknowledged to each
 * other (BroadcastChannel, same origin = same server), so a second tab shows the first tab's typing at
 * once instead of only at its next (rejected, then rebased) change.
 */
import { ChangeSet, Transaction } from '@codemirror/state';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import type { ClientMessage } from '@paper-copilot/core';
import type { ApiClient } from '../../contracts';
import { isMockClient } from '../../api/extras';
import { changeAnnotation, remoteChange } from '../annotations';
import { setCtxEffect } from '../context';
import { currentLang, edText } from '../i18n';
import { diffChangesOf } from '../safe';
import { patchUnitsEffect, setUnitsEffect, unitsField, updateUnitMetaEffect } from '../units';
import { SyncCore, type LogEntry, type PatchMsg, type ReplaceMsg, type ReconcileResult, type SnapshotMsg } from './syncCore';

const SNAPSHOT_WAIT_MS = 5000;

interface RelayMsg {
  kind: 'applied';
  tab: string;
  file: string;
  entries: Array<{ baseVersion: number; changes: unknown }>;
}

/** Minimal BroadcastChannel surface (absent in some test environments). */
interface Channel {
  postMessage(m: unknown): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

function openChannel(name: string): Channel | null {
  try {
    const BC = (globalThis as { BroadcastChannel?: new (name: string) => Channel }).BroadcastChannel;
    return BC ? new BC(name) : null;
  } catch {
    return null;
  }
}

/** User-facing notices for a reconcile result (null if the sync was silent). */
export function reconcileNotice(file: string, res: ReconcileResult, lang = currentLang()): { level: 'info' | 'warn'; message: string } | null {
  const lines = res.conflicts.slice(0, 5).join(', ') + (res.conflicts.length > 5 ? ', …' : '');
  if (res.mode === 'restart') {
    if (res.conflicts.length) return { level: 'warn', message: edText(lang, 'syncRestoredConflict', { file, lines }) };
    return res.diff ? { level: 'info', message: edText(lang, 'syncRestored', { file }) } : null;
  }
  if (res.conflicts.length) return { level: 'warn', message: edText(lang, 'syncConflict', { file, lines }) };
  if (res.mode === 'legacy' && res.diff) return { level: 'warn', message: edText(lang, 'syncLegacy', { file }) };
  return null;
}

export interface DocSyncHooks {
  view(): EditorView | null;
  /** The first snapshot was applied (editing can start). */
  loaded(): void;
  notice(level: 'info' | 'warn' | 'error', message: string): void;
}

export class DocSync {
  readonly core: SyncCore;
  private offs: Array<() => void> = [];
  private reconnecting = false;
  private openSent = false;
  private stopped = false;
  private readonly tabId = Math.random().toString(36).slice(2);
  private channel: Channel | null = null;
  /** A patch from a version this tab has not reached yet (another tab's change, relayed shortly). */
  private deferredPatch: PatchMsg | null = null;
  /** Messages that refer to the local text (ghost.request, doc.flush): sent after the changes before them. */
  private ordered: ClientMessage[] = [];
  /**
   * A doc.open is waiting for its snapshot: no change is sent meanwhile (after a server restart a change
   * based on the old version numbers could be accepted in the wrong coordinates). Cleared by the snapshot,
   * or after SNAPSHOT_WAIT_MS so typing is never held back for good.
   */
  private awaitingSnapshot = false;
  private awaitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly api: ApiClient,
    readonly file: string,
    private readonly hooks: DocSyncHooks,
  ) {
    this.core = new SyncCore(file);
  }

  start(): void {
    const api = this.api;
    this.offs.push(
      api.on('doc.snapshot', (m) => {
        if (m.file === this.file) this.onSnapshot(m);
      }),
      api.on('doc.ack', (m) => {
        if (m.file === this.file) this.onAck(m.version);
      }),
      api.on('sentences.patch', (m) => {
        if (m.file === this.file) this.onPatch(m);
      }),
      api.on('doc.replace', (m) => {
        if (m.file === this.file) this.onReplace(m);
      }),
      api.onConnection((connected) => this.onConnection(connected)),
    );
    // only tabs talking to the same server relay changes (a ?mock=1 demo runs its own server in each tab)
    this.channel = isMockClient(api) ? null : openChannel(`paper-copilot:doc:${this.file}`);
    if (this.channel) this.channel.onmessage = (ev) => this.onRelay(ev.data);
    if (api.connected) this.open();
    api
      .ready()
      .then(() => {
        if (!this.stopped && !this.openSent) this.open();
      })
      .catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    if (this.awaitTimer) clearTimeout(this.awaitTimer);
    for (const off of this.offs) off();
    this.offs = [];
    try {
      this.channel?.close();
    } catch {
      /* already closed */
    }
    this.channel = null;
  }

  private open(): void {
    this.openSent = true;
    this.awaitingSnapshot = true;
    if (this.awaitTimer) clearTimeout(this.awaitTimer);
    this.awaitTimer = setTimeout(() => {
      this.awaitTimer = null;
      if (!this.awaitingSnapshot) return;
      this.awaitingSnapshot = false;
      this.pump();
    }, SNAPSHOT_WAIT_MS);
    this.api.send({ type: 'doc.open', file: this.file });
  }

  private onConnection(connected: boolean): void {
    if (this.stopped) return;
    if (!connected) {
      this.openSent = false;
      // ghost requests and flushes refer to a socket that is gone (the ghost machine times out on its own)
      this.ordered = [];
      return;
    }
    if (this.core.initialized) this.reconnecting = true;
    if (!this.openSent) this.open();
  }

  /** Every local transaction that changed the document becomes one doc.change. */
  onUpdate(u: ViewUpdate): void {
    if (!this.core.initialized) return;
    let changed = false;
    for (const tr of u.transactions) {
      if (!tr.docChanged || tr.annotation(remoteChange)) continue;
      this.core.local(tr.changes, tr.annotation(changeAnnotation) ?? null, false);
      changed = true;
    }
    if (changed) this.pump();
  }

  /**
   * Send a message that refers to the current local text (ghost.request with a cursor, doc.flush) after
   * every change made before it; messages keep their order among themselves.
   */
  sendOrdered(msg: ClientMessage): void {
    if (this.ordered.length || this.core.unsent().length) this.ordered.push(msg);
    else this.api.send(msg);
  }

  /** One change on the wire at a time (see syncCore.ts); ordered messages follow the changes before them. */
  private pump(): void {
    if (this.stopped || !this.api.connected || this.awaitingSnapshot) return;
    const msg = this.core.takeNext();
    if (msg) this.api.send(msg);
    if (this.core.unsent().length === 0 && this.ordered.length) {
      const out = this.ordered;
      this.ordered = [];
      for (const m of out) this.api.send(m);
    }
  }

  private onSnapshot(m: SnapshotMsg): void {
    const view = this.hooks.view();
    if (!view) return;
    this.awaitingSnapshot = false;
    if (!this.core.initialized) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: m.text },
        selection: { anchor: 0 },
        annotations: [remoteChange.of(true), Transaction.addToHistory.of(false)],
        effects: [setUnitsEffect.of(m.units), setCtxEffect.of({ serverIntentLines: m.intentLines })],
      });
      this.core.reset(m.version, [], m.text);
      this.hooks.loaded();
      return;
    }
    const localText = view.state.doc.toString();
    const reconnect = this.reconnecting;
    this.reconnecting = false;
    const res = this.core.reconcile(m, localText, { reconnect, connected: this.api.connected, diff: diffChangesOf, oneInFlight: true });
    // Server-side text this editor had not seen (pull, disk edit, semantic lines, another tab), rebased over
    // the unsent typing: applied before the units are mapped (they refer to snapshot + rebased entries).
    if (res.remote) view.dispatch({ changes: res.remote, annotations: [remoteChange.of(true), Transaction.addToHistory.of(false)] });
    this.deferredPatch = null;
    const doc = view.state.doc;
    const units = this.core.mapUnits(m.units, m.version, doc) ?? [];
    const lines = this.core.mapIntentLines(m.intentLines, m.version, doc) ?? [];
    view.dispatch({ effects: [setUnitsEffect.of(units), setCtxEffect.of({ serverIntentLines: lines })] });
    const note = reconcileNotice(this.file, res);
    if (note) this.hooks.notice(note.level, note.message);
    this.pump();
  }

  private onAck(version: number): void {
    const done = this.core.ack(version);
    this.relay(done);
    const next = this.core.drainReplace();
    if (next) {
      if ('apply' in next) this.applyReplace(next.apply);
      else this.open();
    }
    this.pump();
  }

  private onPatch(m: PatchMsg): void {
    const view = this.hooks.view();
    if (!view) return;
    if (!this.core.acceptsPatch(m.version)) {
      // another tab's change: its relay usually follows; apply the patch once this tab has caught up
      if (this.core.initialized && m.version > this.core.localVersion && !this.core.queuedReplace) this.deferredPatch = m;
      return;
    }
    const doc = view.state.doc;
    const upserts = this.core.mapUnits(m.upserts, m.version, doc);
    if (!upserts) {
      // Too old to map positions: keep the metadata of units we know, drop removed ones.
      const known = view.state.field(unitsField).byId;
      view.dispatch({
        effects: [
          ...m.upserts.filter((u) => known.has(u.id)).map((u) => updateUnitMetaEffect.of(u)),
          patchUnitsEffect.of({ upserts: [], removed: m.removed }),
        ],
      });
      return;
    }
    const lines = this.core.mapIntentLines(m.intentLines, m.version, doc);
    view.dispatch({ effects: [patchUnitsEffect.of({ upserts, removed: m.removed }), ...(lines ? [setCtxEffect.of({ serverIntentLines: lines })] : [])] });
    this.core.notePatch(m.version);
  }

  private onReplace(m: ReplaceMsg): void {
    if (!this.core.initialized) return;
    if (this.core.offerReplace(m) === 'queued') return;
    this.applyReplace(m);
  }

  private applyReplace(m: ReplaceMsg): void {
    const view = this.hooks.view();
    if (!view) return;
    const cur = view.state.doc.toString();
    view.dispatch({
      changes: cur === m.text ? undefined : diffChangesOf(cur, m.text),
      annotations: [remoteChange.of(true), Transaction.addToHistory.of(false)],
      effects: [setUnitsEffect.of(m.units), setCtxEffect.of({ serverIntentLines: m.intentLines })],
    });
    this.core.reset(m.version, [], m.text);
    this.deferredPatch = null;
    // The server sends one notice per re-anchoring (pull or external edit, with its source); the
    // Sync panel shows the report. No second toast here.
  }

  /* ------------------------------------------------------------------ same-browser tabs */

  private relay(done: LogEntry[]): void {
    if (!this.channel || done.length === 0) return;
    const msg: RelayMsg = { kind: 'applied', tab: this.tabId, file: this.file, entries: done.map((e) => ({ baseVersion: e.baseVersion, changes: e.changes.toJSON() })) };
    try {
      this.channel.postMessage(msg);
    } catch {
      /* the other tabs catch up through the snapshot path */
    }
  }

  /** Another tab's acknowledged changes: adopt them when this tab is exactly at their base version. */
  private onRelay(data: unknown): void {
    const m = data as Partial<RelayMsg> | null;
    if (this.stopped || !m || m.kind !== 'applied' || m.tab === this.tabId || m.file !== this.file || !Array.isArray(m.entries)) return;
    const view = this.hooks.view();
    if (!view || !this.core.initialized) return;
    for (const e of m.entries) {
      // anything else (own pending typing, a gap) is reconciled by the server's next snapshot (rebase)
      if (e.baseVersion !== this.core.localVersion || this.core.pending().length > 0) continue;
      let cs: ChangeSet;
      try {
        cs = ChangeSet.fromJSON(e.changes);
      } catch {
        return;
      }
      if (cs.length !== view.state.doc.length || !this.core.adoptRemote(cs)) return;
      view.dispatch({ changes: cs, annotations: [remoteChange.of(true), Transaction.addToHistory.of(false)] });
    }
    const p = this.deferredPatch;
    if (p && p.version <= this.core.localVersion) {
      this.deferredPatch = null;
      this.onPatch(p);
    }
  }
}
