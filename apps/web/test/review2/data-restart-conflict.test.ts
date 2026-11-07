/**
 * Review round 2 (data safety): after a server restart, a line that changed BOTH in the editor (edits the
 * old process acknowledged but never wrote) and on disk (an edit made while the server was down: another
 * editor, a terminal `git pull`, a sync tool) must not lose either text.
 *
 * SyncCore.restartMerge keeps OUR line (merge3 prefer 'ours') and only reports the line number; the
 * restore change then makes the new server process write the merged text to disk (1 s debounce). The disk
 * version of the line is kept nowhere: not in the editor, not in the text the server writes, not in the
 * ReconcileResult. The notice tells the author to "compare it with the disk / Overleaf version", which the
 * restore itself overwrites. Contrast: the same-process path keeps BOTH texts on an overlap ("Both texts
 * were kept"), and the server's own reload saves the losing side to .paper/conflicts/.
 */
import { ChangeSet } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { diffChanges } from '@paper-copilot/core';
import { SyncCore, textOf } from '../../src/editor/sync/syncCore';

describe('review2 data: restart merge conflict', () => {
  it('keeps the disk version of a line that both the editor and the disk changed while the server was down', () => {
    const disk0 = 'Intro line.\nThe efficiency is high at small radius.\nClosing line.\n';
    const core = new SyncCore('main.tex');
    core.reset(0, [], disk0); // first snapshot of the old process (read from disk)

    // the author edits line 2; the old process acknowledges it but is killed before its 1 s disk write
    const at = disk0.indexOf('high');
    const edit = ChangeSet.of([{ from: at, to: at + 4, insert: 'very high' }], disk0.length);
    core.local(edit, null, true);
    core.ack(1);
    const local = edit.apply(textOf(disk0)).toString();

    // meanwhile a co-author's edit of the same line reaches the disk
    const disk1 = 'Intro line.\nThe efficiency is high at small transverse radius.\nClosing line.\n';

    // the new process starts at version 0 with the disk text; the tab reconnects
    const res = core.reconcile({ version: 0, text: disk1 }, local, { reconnect: true, connected: true, diff: diffChanges, oneInFlight: true });
    expect(res.mode).toBe('restart');

    // what the new server process holds (and writes to disk) once the restore change is applied
    let server = textOf(disk1);
    for (const e of core.log) server = e.changes.apply(server);
    const editor = res.remote ? res.remote.apply(textOf(local)).toString() : local;
    expect(editor).toBe(server.toString());

    // the author's edit is kept ...
    expect(server.toString()).toContain('very high');
    // ... and so must the co-author's (both texts on the line, as the same-process rebase does)
    const where = { server: server.toString().includes('transverse'), editor: editor.includes('transverse'), result: JSON.stringify(res).includes('transverse') };
    expect(where, `conflict lines ${JSON.stringify(res.conflicts)}; the disk text of the line is kept nowhere`).not.toEqual({ server: false, editor: false, result: false });
  });
});

describe('review2 data: restart when the disk holds an OLDER copy of the editor text (soak seed 11)', () => {
  it('keeps the editor line alone (no duplicate line, no split word) when the server wrote an earlier state of it', () => {
    const disk0 = 'Intro line.\nWe find the result.\nClosing line.\n';
    const core = new SyncCore('main.tex');
    core.reset(0, [], disk0);
    let text = textOf(disk0);
    const type = (s: string, sent: boolean) => {
      const at = text.toString().indexOf('\nClosing');
      const cs = ChangeSet.of([{ from: at, insert: s }], text.length);
      core.local(cs, null, sent);
      text = cs.apply(text);
      return text.toString();
    };
    type(' tracke', true);
    core.ack(1);
    const written = text.toString(); // the debounced disk write of the old process saw this state
    type('r displaced', true);
    core.ack(2);
    // kill -9 with one change unsent; the new process reads `written` from disk
    const local = type(' we kb8', false);
    const res = core.reconcile({ version: 0, text: written }, local, { reconnect: true, connected: true, diff: diffChanges, oneInFlight: true });
    let server = textOf(written);
    for (const e of core.log) server = e.changes.apply(server);
    const editor = res.remote ? res.remote.apply(textOf(local)).toString() : local;
    expect(editor).toBe(server.toString());
    expect(editor).toBe(local);
    expect(res.conflicts).toEqual([]);
  });
});
