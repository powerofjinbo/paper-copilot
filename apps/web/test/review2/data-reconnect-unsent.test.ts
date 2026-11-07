/**
 * Review round 2 (R2-DATA-2): after a reconnect, SyncCore guessed which pending changes the server had
 * applied with lost acks from the size of a diff, and considered changes that were never sent. A co-author's
 * 'nearly ' at the spot where this tab typed 'clearly ' offline was "explained" by 'clearly ' (a smaller diff)
 * and the rebase deleted 'clearly '. Only entries that were on the wire (sent=true) can have been applied.
 */
import { ChangeSet } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { diffChanges } from '@paper-copilot/core';
import { SyncCore, textOf } from '../../src/editor/sync/syncCore';

describe('review2 data: reconnect with a change that was never sent', () => {
  it('keeps the offline word when the other tab typed a similar word at the same spot', () => {
    const t0 = 'The result is consistent with the prediction.\n';
    const core = new SyncCore('main.tex');
    core.reset(3, [], t0);
    const at = t0.indexOf('consistent');
    // typed while the socket was down: never sent
    const mine = ChangeSet.of([{ from: at, insert: 'clearly ' }], t0.length);
    core.local(mine, null, false);
    const local = mine.apply(textOf(t0)).toString();
    // the other tab inserted 'nearly ' at the same spot (server now at version 4)
    const server = t0.slice(0, at) + 'nearly ' + t0.slice(at);
    const res = core.reconcile({ version: 4, text: server }, local, { reconnect: true, connected: true, diff: diffChanges, oneInFlight: true });
    const editor = res.remote ? res.remote.apply(textOf(local)).toString() : local;
    let s = textOf(server);
    for (const e of core.pending()) s = e.changes.apply(s);
    expect(editor).toBe(s.toString());
    expect(editor).toContain('clearly ');
    expect(editor).toContain('nearly ');
  });

  it('still recognises a sent change whose ack was lost', () => {
    const t0 = 'Alpha beta gamma.\n';
    const core = new SyncCore('main.tex');
    core.reset(0, [], t0);
    const c = ChangeSet.of([{ from: 6, insert: 'big ' }], t0.length);
    core.local(c, null, true); // on the wire
    const local = c.apply(textOf(t0)).toString();
    // the server applied it, the ack was lost
    const res = core.reconcile({ version: 1, text: local }, local, { reconnect: true, connected: true, diff: diffChanges, oneInFlight: true });
    expect(res.remote).toBeNull();
    expect(core.pending()).toHaveLength(0);
  });
});
