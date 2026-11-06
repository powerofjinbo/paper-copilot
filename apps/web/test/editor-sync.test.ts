import { ChangeSet, EditorState, Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { patchUnitsEffect, unitsField } from '../src/editor/units';
import { diffChangesOf, prefixSuffixChanges } from '../src/editor/safe';
import { SyncCore, textOf, type ReplaceMsg } from '../src/editor/sync/syncCore';
import { stateWith, unit } from '../src/editor/testing/fixtures';

/** Apply changes to a state as a local transaction; return the new state and the change set. */
function edit(state: EditorState, spec: { from: number; to?: number; insert?: string }) {
  const tr = state.update({ changes: spec });
  return { state: tr.state, changes: tr.changes };
}

describe('SyncCore: versions and acks', () => {
  it('numbers local changes sequentially and serializes them', () => {
    const core = new SyncCore('main.tex');
    core.reset(7);
    const cs = ChangeSet.of([{ from: 0, insert: 'A' }], 5);
    const m1 = core.local(cs, null, true);
    expect(m1).toEqual({ type: 'doc.change', file: 'main.tex', baseVersion: 7, changes: cs.toJSON(), annotation: null });
    const m2 = core.local(ChangeSet.of([{ from: 6, insert: 'B' }], 6), null, true);
    expect(m2.baseVersion).toBe(8);
    expect(core.localVersion).toBe(9);
    expect(core.pending().map((e) => e.baseVersion)).toEqual([7, 8]);
    core.ack(8);
    expect(core.pending().map((e) => e.baseVersion)).toEqual([8]);
    core.ack(9);
    expect(core.pending()).toEqual([]);
  });

  it('keeps acknowledged changes in the log until a patch at a newer version arrives (they are still needed for mapping)', () => {
    const core = new SyncCore('main.tex');
    core.reset(1);
    core.local(ChangeSet.of([{ from: 0, insert: 'x' }], 3), null, true);
    core.local(ChangeSet.of([{ from: 0, insert: 'y' }], 4), null, true);
    core.ack(3);
    expect(core.log.length).toBe(2);
    expect(core.changesSince(1, 5)).not.toBeNull();
    core.notePatch(2);
    expect(core.log.map((e) => e.baseVersion)).toEqual([2]);
    expect(core.changesSince(1, 5)).toBeNull();
    core.notePatch(3);
    expect(core.log).toEqual([]);
  });

  it('refuses to map from a future version', () => {
    const core = new SyncCore('main.tex');
    core.reset(4);
    expect(core.changesSince(5, 10)).toBeNull();
    expect(core.changesSince(4, 10)!.empty).toBe(true);
    expect(core.acceptsPatch(5)).toBe(false);
    expect(core.acceptsPatch(4)).toBe(true);
  });
});

describe('SyncCore: span mapping through pending changes', () => {
  const doc = 'Alpha one. Beta two. Gamma three.';

  it('maps server spans through one pending change (start assoc +1, end assoc -1)', () => {
    const core = new SyncCore('main.tex');
    core.reset(10);
    // local: insert "New " exactly at the start of "Beta"
    const beta = doc.indexOf('Beta');
    const cs = ChangeSet.of([{ from: beta, insert: 'New ' }], doc.length);
    core.local(cs, null, true);
    const now = cs.apply(textOf(doc));
    const server = [unit('a', 0, 10), unit('b', beta, beta + 'Beta two.'.length)];
    const mapped = core.mapUnits(server, 10, now)!;
    expect(now.sliceString(mapped[0]!.start, mapped[0]!.end)).toBe('Alpha one.');
    // inserted text at the sentence start is NOT part of the sentence
    expect(now.sliceString(mapped[1]!.start, mapped[1]!.end)).toBe('Beta two.');
  });

  it('text appended exactly at a sentence end stays outside it until the next patch', () => {
    const core = new SyncCore('main.tex');
    core.reset(0);
    const end = doc.indexOf('Beta two.') + 'Beta two.'.length;
    const cs = ChangeSet.of([{ from: end, insert: ' And more.' }], doc.length);
    core.local(cs, null, true);
    const now = cs.apply(textOf(doc));
    const [b] = core.mapUnits([unit('b', doc.indexOf('Beta'), end)], 0, now)!;
    expect(now.sliceString(b!.start, b!.end)).toBe('Beta two.');
  });

  it('composes several pending changes, and maps a patch tagged with an older version correctly', () => {
    let state = stateWith(doc, [unit('a', 0, 10), unit('b', 11, 20), unit('c', 21, 33)]);
    const core = new SyncCore('main.tex');
    core.reset(5);
    // three local edits: v5 -> v6 -> v7 -> v8
    const e1 = edit(state, { from: 0, insert: '>> ' });
    state = e1.state;
    core.local(e1.changes, null, true);
    const e2 = edit(state, { from: state.doc.toString().indexOf('two'), to: state.doc.toString().indexOf('two') + 3, insert: '2' });
    state = e2.state;
    core.local(e2.changes, null, true);
    const e3 = edit(state, { from: state.doc.length, insert: ' Delta.' });
    state = e3.state;
    core.local(e3.changes, null, true);
    expect(state.doc.toString()).toBe('>> Alpha one. Beta 2. Gamma three. Delta.');

    // The server describes version 6 (it has applied e1 only): positions are in the v6 text.
    const v6 = '>> ' + doc;
    const upserts = [unit('b', v6.indexOf('Beta'), v6.indexOf('Beta') + 'Beta two.'.length, { state: 'ai-edited' }), unit('d', v6.indexOf('Gamma'), v6.length)];
    const mapped = core.mapUnits(upserts, 6, state.doc)!;
    const cur = state.doc.toString();
    expect(cur.slice(mapped[0]!.start, mapped[0]!.end)).toBe('Beta 2.');
    expect(cur.slice(mapped[1]!.start, mapped[1]!.end)).toBe('Gamma three.');

    // Applying it through the units field keeps the other units in local coordinates.
    state = state.update({ effects: patchUnitsEffect.of({ upserts: mapped, removed: ['c'] }) }).state;
    const units = state.field(unitsField).units;
    expect(units.map((u) => u.id)).toEqual(['a', 'b', 'd']);
    expect(units.map((u) => cur.slice(u.start, u.end))).toEqual(['Alpha one.', 'Beta 2.', 'Gamma three.']);
    expect(units[1]!.state).toBe('ai-edited');
  });

  it('maps units locally through every transaction (decorations follow typing)', () => {
    let state = stateWith(doc, [unit('a', 0, 10), unit('b', 11, 20)]);
    state = state.update({ changes: { from: 0, insert: 'XYZ ' } }).state;
    const [a, b] = state.field(unitsField).units;
    expect(state.doc.sliceString(a!.start, a!.end)).toBe('Alpha one.');
    expect(state.doc.sliceString(b!.start, b!.end)).toBe('Beta two.');
    // deleting a whole sentence collapses it (kept until the server removes it)
    state = state.update({ changes: { from: b!.start, to: b!.end } }).state;
    const b2 = state.field(unitsField).byId.get('b')!;
    expect(b2.start).toBe(b2.end);
  });
});

describe('SyncCore: reconnect and rejected changes', () => {
  const base = 'One. Two. Three.';

  function setup() {
    const core = new SyncCore('main.tex');
    core.reset(3);
    let text = base;
    const changes: ChangeSet[] = [];
    for (const [from, insert] of [
      [0, 'A '],
      [2, 'B '],
    ] as Array<[number, string]>) {
      const cs = ChangeSet.of([{ from, insert }], text.length);
      text = cs.apply(Text.of(text.split('\n'))).toString();
      changes.push(cs);
    }
    return { core, changes, text };
  }

  it('re-sends the remaining changes after a reconnect when snapshot + log reproduces the local text', () => {
    const { core, changes, text } = setup();
    core.local(changes[0]!, null, true); // v3, applied by the server before the disconnect
    core.local(changes[1]!, null, true); // v4, lost
    const afterFirst = changes[0]!.apply(Text.of(base.split('\n'))).toString();
    const res = core.reconcile({ version: 4, text: afterFirst }, text, { reconnect: true, connected: true, diff: prefixSuffixChanges });
    expect(res.replayed).toBe(true);
    expect(res.send.map((m) => m.baseVersion)).toEqual([4]);
    expect(core.localVersion).toBe(5);
    expect(core.ackedVersion).toBe(4);
  });

  it('does not re-send in-flight changes for an unsolicited snapshot', () => {
    const { core, changes, text } = setup();
    core.local(changes[0]!, null, true);
    core.local(changes[1]!, null, true);
    const res = core.reconcile({ version: 3, text: base }, text, { reconnect: false, connected: true, diff: prefixSuffixChanges });
    expect(res.replayed).toBe(true);
    expect(res.send).toEqual([]);
    expect(core.pending().length).toBe(2);
  });

  it('sends one diff change when the server lost or rejected changes, so the local text is never lost', () => {
    const { core, changes, text } = setup();
    core.local(changes[0]!, null, true);
    core.local(changes[1]!, null, true);
    // The server restarted from disk: version 9, text without our edits and with a stale tail.
    const serverText = 'One. Two.';
    const res = core.reconcile({ version: 9, text: serverText }, text, { reconnect: true, connected: true, diff: diffChangesOf });
    expect(res.replayed).toBe(false);
    expect(res.send.length).toBe(1);
    const m = res.send[0]!;
    expect(m.baseVersion).toBe(9);
    expect(m.annotation).toBeNull();
    const healed = ChangeSet.fromJSON(m.changes).apply(Text.of(serverText.split('\n'))).toString();
    expect(healed).toBe(text);
    expect(core.localVersion).toBe(10);
    // units of the snapshot (v9) map through the diff into local coordinates
    const [u] = core.mapUnits([unit('t', serverText.indexOf('Two.'), serverText.indexOf('Two.') + 4)], 9, Text.of([text]))!;
    expect(text.slice(u!.start, u!.end)).toBe('Two.');
  });

  it('sends nothing when the snapshot already equals the local text', () => {
    const { core, changes, text } = setup();
    core.local(changes[0]!, null, true);
    core.local(changes[1]!, null, true);
    const res = core.reconcile({ version: 5, text }, text, { reconnect: true, connected: true, diff: prefixSuffixChanges });
    expect(res.send).toEqual([]);
    expect(core.localVersion).toBe(5);
  });

  it('keeps unsent changes (made offline) and sends them once connected', () => {
    const { core, changes, text } = setup();
    core.local(changes[0]!, null, false);
    expect(core.unsent().length).toBe(1);
    const afterFirst = changes[0]!.apply(Text.of(base.split('\n'))).toString();
    const res = core.reconcile({ version: 3, text: base }, afterFirst, { reconnect: false, connected: true, diff: prefixSuffixChanges });
    expect(res.send.map((m) => m.baseVersion)).toEqual([3]);
    void text;
  });
});

describe('SyncCore: doc.replace', () => {
  const replace = (version: number): ReplaceMsg => ({
    type: 'doc.replace',
    file: 'main.tex',
    version,
    text: 'x',
    units: [],
    intentLines: [],
    report: { unchanged: 0, edited: [], created: [], orphaned: [], split: [] },
  });

  it('applies at once without pending changes', () => {
    const core = new SyncCore('main.tex');
    core.reset(2);
    expect(core.offerReplace(replace(3))).toBe('apply');
  });

  it('queues while changes are unacknowledged, then applies when the acks drain', () => {
    const core = new SyncCore('main.tex');
    core.reset(2);
    core.local(ChangeSet.of([{ from: 0, insert: 'a' }], 1), null, true);
    expect(core.offerReplace(replace(4))).toBe('queued');
    expect(core.drainReplace()).toBeNull();
    core.ack(3);
    const next = core.drainReplace();
    expect(next && 'apply' in next ? next.apply.version : null).toBe(4);
  });

  it('asks for a re-sync when the server accepted a change on top of the replaced text', () => {
    const core = new SyncCore('main.tex');
    core.reset(2);
    core.local(ChangeSet.of([{ from: 0, insert: 'a' }], 1), null, true);
    core.local(ChangeSet.of([{ from: 0, insert: 'b' }], 2), null, true);
    core.offerReplace(replace(3));
    core.ack(4);
    expect(core.drainReplace()).toEqual({ resync: true });
  });

  it('drops a queued replace superseded by a snapshot', () => {
    const core = new SyncCore('main.tex');
    core.reset(2);
    core.local(ChangeSet.of([{ from: 0, insert: 'a' }], 1), null, true);
    core.offerReplace(replace(3));
    core.reconcile({ version: 5, text: 'ax' }, 'ax', { reconnect: false, connected: true, diff: prefixSuffixChanges });
    expect(core.queuedReplace).toBeNull();
  });
});

describe('prefixSuffixChanges (diff fallback)', () => {
  it('produces a change set turning a into b', () => {
    for (const [a, b] of [
      ['abc', 'abXc'],
      ['hello world', 'hello brave new world'],
      ['same', 'same'],
      ['', 'new'],
      ['old', ''],
    ]) {
      const cs = prefixSuffixChanges(a!, b!);
      expect(cs.length).toBe(a!.length);
      expect(cs.apply(Text.of(a!.split('\n'))).toString()).toBe(b);
    }
  });
});
