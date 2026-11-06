/**
 * Ghost text host logic that does not depend on the client-core reducer: which machine events a
 * transaction implies, and which ghost mode applies at the cursor.
 */
import { EditorSelection } from '@codemirror/state';
import { initialGhost } from '@paper-copilot/client-core';
import { emptyOutline, type Outline } from '@paper-copilot/core';
import { describe, expect, it } from 'vitest';
import { changeAnnotation, ghostInsert, makeAnnotation, remoteChange } from '../src/editor/annotations';
import { setCtxEffect } from '../src/editor/context';
import { eventsFromTransaction, ghostModeAt } from '../src/editor/ghost/ghostField';
import { stateWith, unitsFor } from '../src/editor/testing/fixtures';

const DOC = 'We train on generic events. The tracker finds';

function base() {
  const units = unitsFor(DOC, [['We train on generic events.', { sectionId: 'sec:intro', part: 'intro' }], ['The tracker finds', { sectionId: 'sec:results', part: 'body' }]]);
  return stateWith(DOC, units).update({ selection: EditorSelection.cursor(DOC.length) }).state;
}

describe('ghost events from transactions', () => {
  const machine = initialGhost();

  it('typing reports the inserted text, the English words of the sentence so far and the boundary', () => {
    const s = base();
    const tr = s.update({ changes: { from: DOC.length, insert: ' 2' }, selection: EditorSelection.cursor(DOC.length + 2), userEvent: 'input.type' });
    expect(eventsFromTransaction(tr, machine)).toEqual([{ type: 'typed', pos: DOC.length + 2, inserted: ' 2', sentenceWords: 3, endsSentence: false }]);
    const end = s.update({ changes: { from: DOC.length, insert: ' more. ' }, selection: EditorSelection.cursor(DOC.length + 7), userEvent: 'input.type' });
    expect(eventsFromTransaction(end, machine)[0]).toMatchObject({ type: 'typed', endsSentence: true });
    const abbr = s.update({ changes: { from: DOC.length, insert: ' in Fig. ' }, selection: EditorSelection.cursor(DOC.length + 9), userEvent: 'input.type' });
    expect(eventsFromTransaction(abbr, machine)[0]).toMatchObject({ type: 'typed', endsSentence: false });
  });

  it('deleting, moving the cursor, remote and AI changes map to deleted / cursor / external', () => {
    const s = base();
    expect(eventsFromTransaction(s.update({ changes: { from: DOC.length - 1, to: DOC.length }, userEvent: 'delete.backward' }), machine)).toEqual([{ type: 'deleted', pos: DOC.length - 1 }]);
    expect(eventsFromTransaction(s.update({ selection: EditorSelection.cursor(3) }), machine)).toEqual([{ type: 'cursor', pos: 3 }]);
    expect(eventsFromTransaction(s.update({ changes: { from: 0, insert: 'x' }, annotations: remoteChange.of(true) }), machine)).toEqual([{ type: 'external' }]);
    const ai = s.update({ changes: { from: 0, insert: 'x' }, annotations: changeAnnotation.of(makeAnnotation({ origin: 'ai_rewrite' })) });
    expect(eventsFromTransaction(ai, machine)).toEqual([{ type: 'external' }]);
    expect(eventsFromTransaction(s.update({ changes: { from: 0, insert: 'x' }, userEvent: 'input.paste' }), machine)).toEqual([{ type: 'external' }]);
  });

  it('the ghost insert itself and IME composition steps are not typing', () => {
    const s = base();
    const insert = s.update({ changes: { from: DOC.length, insert: ' more' }, annotations: [ghostInsert.of('g1'), changeAnnotation.of(makeAnnotation({ origin: 'ai_ghost' }))] });
    expect(eventsFromTransaction(insert, machine)).toEqual([]);
    const compose = s.update({ changes: { from: DOC.length, insert: 'zh' }, userEvent: 'input.type.compose' });
    expect(eventsFromTransaction(compose, machine)).toEqual([]);
    const composing = { ...machine, composing: true };
    expect(eventsFromTransaction(s.update({ changes: { from: DOC.length, insert: 'a' }, userEvent: 'input.type' }), composing)).toEqual([]);
  });
});

describe('ghost mode at the cursor', () => {
  it('comes from the outline section, else from the part (abstract/intro/concl: complete-my-sentence)', () => {
    let s = base();
    expect(ghostModeAt(s, 3)).toBe('complete-my-sentence');
    expect(ghostModeAt(s, DOC.length)).toBe('auto-propose');
    const outline: Outline = {
      ...emptyOutline(),
      sections: [{ id: 'sec:results', title: 'Results', question: '', template: 'results', ghostMode: 'questions-only', paragraphs: [], provenance: 'author' }],
    };
    s = s.update({ effects: setCtxEffect.of({ outline }) }).state;
    expect(ghostModeAt(s, DOC.length)).toBe('questions-only');
  });
});
