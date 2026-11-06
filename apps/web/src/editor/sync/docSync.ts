/**
 * Document sync wiring: ApiClient messages <-> SyncCore <-> EditorView. See syncCore.ts for the rules.
 */
import { Transaction } from '@codemirror/state';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import type { ApiClient } from '../../contracts';
import { changeAnnotation, remoteChange } from '../annotations';
import { setCtxEffect } from '../context';
import { diffChangesOf } from '../safe';
import { patchUnitsEffect, setUnitsEffect, unitsField, updateUnitMetaEffect } from '../units';
import { SyncCore, type PatchMsg, type ReplaceMsg, type SnapshotMsg } from './syncCore';

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
    for (const off of this.offs) off();
    this.offs = [];
  }

  private open(): void {
    this.openSent = true;
    this.api.send({ type: 'doc.open', file: this.file });
  }

  private onConnection(connected: boolean): void {
    if (this.stopped) return;
    if (!connected) {
      this.openSent = false;
      return;
    }
    if (this.core.initialized) this.reconnecting = true;
    if (!this.openSent) this.open();
  }

  /** Every local transaction that changed the document becomes one doc.change. */
  onUpdate(u: ViewUpdate): void {
    if (!this.core.initialized) return;
    for (const tr of u.transactions) {
      if (!tr.docChanged || tr.annotation(remoteChange)) continue;
      const connected = this.api.connected;
      const msg = this.core.local(tr.changes, tr.annotation(changeAnnotation) ?? null, connected);
      if (connected) this.api.send(msg);
    }
  }

  private onSnapshot(m: SnapshotMsg): void {
    const view = this.hooks.view();
    if (!view) return;
    if (!this.core.initialized) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: m.text },
        selection: { anchor: 0 },
        annotations: [remoteChange.of(true), Transaction.addToHistory.of(false)],
        effects: [setUnitsEffect.of(m.units), setCtxEffect.of({ serverIntentLines: m.intentLines })],
      });
      this.core.reset(m.version);
      this.hooks.loaded();
      return;
    }
    const localText = view.state.doc.toString();
    const reconnect = this.reconnecting;
    this.reconnecting = false;
    const res = this.core.reconcile(m, localText, { reconnect, connected: this.api.connected, diff: diffChangesOf });
    for (const msg of res.send) this.api.send(msg);
    const doc = view.state.doc;
    const units = this.core.mapUnits(m.units, m.version, doc) ?? [];
    const lines = this.core.mapIntentLines(m.intentLines, m.version, doc) ?? [];
    view.dispatch({ effects: [setUnitsEffect.of(units), setCtxEffect.of({ serverIntentLines: lines })] });
    if (res.diff) this.hooks.notice('info', `Re-synced ${this.file} with the server; your text was kept.`);
  }

  private onAck(version: number): void {
    this.core.ack(version);
    const next = this.core.drainReplace();
    if (!next) return;
    if ('apply' in next) this.applyReplace(next.apply);
    else this.open();
  }

  private onPatch(m: PatchMsg): void {
    const view = this.hooks.view();
    if (!view || !this.core.acceptsPatch(m.version)) return;
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
    this.core.reset(m.version);
    const r = m.report;
    const changed = r.edited.length + r.created.length;
    this.hooks.notice(
      r.orphaned.length ? 'warn' : 'info',
      `${this.file} changed outside the app: ${changed} sentence${changed === 1 ? '' : 's'} marked external` +
        (r.orphaned.length ? `, ${r.orphaned.length} could not be re-anchored` : '') +
        '.',
    );
  }
}
