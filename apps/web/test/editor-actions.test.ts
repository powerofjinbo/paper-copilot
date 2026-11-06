/**
 * Every way AI text enters the document is ONE annotated transaction (or one per drafted sentence):
 * inspect the produced ChangeSets and ChangeAnnotations.
 */
import { EditorState, type TransactionSpec } from '@codemirror/state';
import type { ChangeAnnotation, Proposal } from '@paper-copilot/core';
import { describe, expect, it } from 'vitest';
import { draftInsertionPoint, draftSentenceSpecs, proposalSpec, rejectSpec, replanDropSpec, replanInsertBeforeSpec, replanReviseSpec, type DraftMsg } from '../src/editor/actions';
import { changeAnnotation, makeAnnotation } from '../src/editor/annotations';
import { ghostField, ghostMetaEffect } from '../src/editor/ghost/ghostField';
import { ghostInsertSpec } from '../src/editor/ghost/ghostPlugin';
import { finishRewriteSpec, rewritableLength, rewriteEffect, rewriteExtension, rewriteField } from '../src/editor/rewrite';
import { stateWith, unitsFor } from '../src/editor/testing/fixtures';

function run(state: EditorState, spec: TransactionSpec | null) {
  expect(spec).not.toBeNull();
  const tr = state.update(spec!);
  return { tr, state: tr.state, annotation: tr.annotation(changeAnnotation) ?? null };
}

const DOC = 'Intro sentence.\nThe tracker finds 2.32 points more than acorn.\nThe test set holds 8,710 targets.\n\nNext paragraph starts here.';

function proposal(p: Partial<Proposal>): Proposal {
  return {
    proposalId: 'p1',
    sentenceId: 'u2',
    text: 'With the same builder, the tracker finds 2.32 points more than acorn.',
    diff: [],
    notes: '',
    drift: null,
    issues: [],
    factIds: ['f.g1.delta_points'],
    citeKeys: [],
    origin: 'ai_rewrite',
    model: 'claude-sonnet-5-5',
    promptHash: 'ph-1',
    ...p,
  };
}

const units = () =>
  unitsFor(DOC, [
    ['Intro sentence.', { paragraphId: 'p0' }],
    ['The tracker finds 2.32 points more than acorn.', { paragraphId: 'p1', state: 'proposed', intentNote: '先说基线', move: 'result' }],
    ['The test set holds 8,710 targets.', { paragraphId: 'p1', state: 'proposed' }],
    ['Next paragraph starts here.', { paragraphId: 'p2' }],
  ]);

describe('applyProposal', () => {
  it('replaces the unit text in one transaction with origin ai_rewrite, state ai-drafted, and keeps the intent note', () => {
    const state = stateWith(DOC, units());
    const { tr, state: next, annotation } = run(state, proposalSpec(state, proposal({}), { instruction: '把基线放在前面', lang: 'zh' }));
    expect(next.doc.line(2).text).toBe('With the same builder, the tracker finds 2.32 points more than acorn.');
    let count = 0;
    tr.changes.iterChanges((fromA, toA, _fb, _tb, ins) => {
      count++;
      expect([fromA, toA]).toEqual([DOC.indexOf('The tracker'), DOC.indexOf('acorn.') + 6]);
      expect(ins.toString()).toBe(proposal({}).text);
    });
    expect(count).toBe(1);
    expect(annotation).toEqual(
      makeAnnotation({
        origin: 'ai_rewrite',
        sentenceIds: ['u2'],
        state: 'ai-drafted',
        model: 'claude-sonnet-5-5',
        promptHash: 'ph-1',
        factIds: ['f.g1.delta_points'],
        instruction: '把基线放在前面',
        lang: 'zh',
        intentNote: '先说基线',
        move: 'result',
      }),
    );
  });

  it('a grammar fix keeps the current state; a re-plan revision stays proposed', () => {
    const state = stateWith(DOC, units());
    expect(run(state, proposalSpec(state, proposal({ origin: 'grammar_fix' }))).annotation!.state).toBe('proposed');
    expect(run(state, proposalSpec(state, proposal({ origin: 'replan' }))).annotation!.state).toBe('proposed');
    expect(run(state, proposalSpec(state, proposal({ origin: 'ai_rewrite' }), { state: 'ai-from-intent' })).annotation!.state).toBe('ai-from-intent');
  });

  it('returns null for a unit that no longer exists', () => {
    const state = stateWith(DOC, units());
    expect(proposalSpec(state, proposal({ sentenceId: 'gone' }))).toBeNull();
    expect(proposalSpec(state, proposal({ sentenceId: null }))).toBeNull();
  });
});

describe('reject and re-plan actions', () => {
  it('reject replaces the sentence with the claim placeholder (human_edit, placeholder)', () => {
    const state = stateWith(DOC, units());
    const { state: next, annotation } = run(state, rejectSpec(state, 'u3', '[claim: The test set holds 8,710 targets?]'));
    expect(next.doc.line(3).text).toBe('[claim: The test set holds 8,710 targets?]');
    expect(annotation).toMatchObject({ origin: 'human_edit', state: 'placeholder', sentenceIds: ['u3'] });
  });

  it('revise keeps the unit proposed (origin replan); drop deletes the whole line; insert_before adds its own line', () => {
    const state = stateWith(DOC, units());
    const rev = run(state, replanReviseSpec(state, { sentenceId: 'u3', action: 'revise', text: 'The test set has 8,710 targets.', reason: '' }));
    expect(rev.state.doc.line(3).text).toBe('The test set has 8,710 targets.');
    expect(rev.annotation).toMatchObject({ origin: 'replan', state: 'proposed', sentenceIds: ['u3'] });

    const drop = run(state, replanDropSpec(state, { sentenceId: 'u3', action: 'drop', text: null, reason: '' }));
    expect(drop.state.doc.toString()).toBe('Intro sentence.\nThe tracker finds 2.32 points more than acorn.\n\nNext paragraph starts here.');
    expect(drop.annotation).toMatchObject({ origin: 'human_edit', state: null, sentenceIds: ['u3'] });

    const ins = run(state, replanInsertBeforeSpec(state, { sentenceId: 'u3', action: 'insert_before', text: 'Both use one builder.', reason: '' }));
    expect(ins.state.doc.line(3).text).toBe('Both use one builder.');
    expect(ins.state.doc.line(4).text).toBe('The test set holds 8,710 targets.');
    expect(ins.annotation).toMatchObject({ origin: 'replan', state: 'proposed', sentenceIds: [] });
  });
});

describe('insertDraft', () => {
  const msg = (afterSentenceId: string | null, insertAt: number | null = null): DraftMsg => ({
    type: 'draft.proposed',
    jobId: 'j',
    file: 'main.tex',
    afterSentenceId,
    insertAt,
    version: 1,
    paragraphs: [
      {
        pid: 'a',
        job: 'job a',
        sentences: [
          { text: 'Drafted one.', move: 'result', factIds: ['f1'], citeKeys: ['k1'], placeholders: [], noteZh: null, refereeQuestion: null, state: 'proposed', issues: [] },
          { text: 'Drafted two.', move: 'cause', factIds: [], citeKeys: [], placeholders: [], noteZh: null, refereeQuestion: null, state: 'unsupported', issues: [] },
        ],
      },
      {
        pid: 'b',
        job: 'job b',
        sentences: [{ text: 'Second paragraph.', move: null, factIds: [], citeKeys: [], placeholders: [], noteZh: null, refereeQuestion: null, state: 'proposed', issues: [] }],
      },
    ],
  });

  it('goes after the paragraph that holds afterSentenceId', () => {
    const state = stateWith(DOC, units());
    expect(draftInsertionPoint(state, msg('u2'))).toBe(DOC.indexOf('targets.') + 'targets.'.length);
    expect(draftInsertionPoint(state, msg(null, DOC.indexOf('Intro') + 3))).toBe(DOC.indexOf('Intro sentence.') + 'Intro sentence.'.length);
  });

  it('one transaction per sentence, each on its own line, paragraphs separated by a blank line, annotated ai_draft', () => {
    let state = stateWith(DOC, units());
    const specs = draftSentenceSpecs(draftInsertionPoint(state, msg('u3')), msg('u3'));
    expect(specs.length).toBe(3);
    const annotations: ChangeAnnotation[] = [];
    for (const spec of specs) {
      const r = run(state, spec);
      annotations.push(r.annotation!);
      let changes = 0;
      r.tr.changes.iterChanges(() => changes++);
      expect(changes).toBe(1);
      state = r.state;
    }
    expect(state.doc.toString()).toBe(
      'Intro sentence.\nThe tracker finds 2.32 points more than acorn.\nThe test set holds 8,710 targets.\n\nDrafted one.\nDrafted two.\n\nSecond paragraph.\n\nNext paragraph starts here.',
    );
    expect(annotations.map((a) => [a.origin, a.state, a.move])).toEqual([
      ['ai_draft', 'proposed', 'result'],
      ['ai_draft', 'unsupported', 'cause'],
      ['ai_draft', 'proposed', null],
    ]);
    expect(annotations[0]).toMatchObject({ factIds: ['f1'], citeKeys: ['k1'], sentenceIds: [] });
  });
});

describe('ghost accept', () => {
  it('inserts the accepted text with origin ai_ghost, state ai-drafted, the unit at the cursor and the result metadata', () => {
    let state = stateWith(DOC, units(), [ghostField]);
    state = state.update({ effects: ghostMetaEffect.of({ requestId: 'g1', model: 'claude-haiku-5-5', promptHash: 'ph-g', factIds: ['f.g1.n_targets'], citeKeys: [], issues: [] }) }).state;
    const at = DOC.indexOf('8,710 targets.') + '8,710 targets'.length; // inside u3 (before the period)
    const { state: next, annotation, tr } = run(state, ghostInsertSpec(state, { type: 'insert', pos: at, text: ' in total', requestId: 'g1', partial: false }));
    expect(next.doc.line(3).text).toBe('The test set holds 8,710 targets in total.');
    expect(next.selection.main.head).toBe(at + ' in total'.length);
    expect(annotation).toEqual(
      makeAnnotation({ origin: 'ai_ghost', state: 'ai-drafted', sentenceIds: ['u3'], model: 'claude-haiku-5-5', promptHash: 'ph-g', factIds: ['f.g1.n_targets'], requestId: 'g1' }),
    );
    expect(tr.isUserEvent('input.complete')).toBe(true);
  });

  it('a new sentence after a finished one belongs to no unit (sentenceIds: [])', () => {
    const state = stateWith('Done here. ', unitsFor('Done here. ', [['Done here.']]), [ghostField]);
    const { annotation } = run(state, ghostInsertSpec(state, { type: 'insert', pos: 11, text: 'Next.', requestId: 'g2', partial: false }));
    expect(annotation!.sentenceIds).toEqual([]);
  });
});

describe('rewrite myself', () => {
  const u3Text = 'The test set holds 8,710 targets.';
  const words = { from: DOC.indexOf(u3Text), to: DOC.indexOf(u3Text) + rewritableLength(u3Text) };

  function armed() {
    let state = stateWith(DOC, units(), [rewriteExtension()]);
    state = state.update({
      selection: { anchor: words.from, head: words.to },
      effects: rewriteEffect.of({ id: 'u3', phase: 'selected', armed: true, newFrom: words.from, oldFrom: words.from, oldTo: words.to, note: null, facts: [] }),
    }).state;
    return state;
  }

  it('selects the words but keeps the sentence ending', () => {
    expect(rewritableLength('The test set holds 8,710 targets.')).toBe('The test set holds 8,710 targets'.length);
    expect(rewritableLength('As shown before.\\cite{Wang2022LRT}')).toBe('As shown before'.length);
    expect(rewritableLength('Is it “stricter?”')).toBe('Is it “stricter'.length);
    expect(rewritableLength('No terminal punctuation')).toBe('No terminal punctuation'.length);
  });

  it('the first keystroke carries human_typed / human with the id and goes before the old words, which stay as a struck reference', () => {
    let state = armed();
    // the browser replaces the selection with the typed character...
    const first = state.update({ changes: { from: words.from, to: words.to, insert: 'O' }, selection: { anchor: words.from + 1 }, userEvent: 'input.type' });
    // ...the filter turns it into an insertion before the old words, so the sentence never shrinks to one letter
    expect(first.annotation(changeAnnotation)).toEqual(makeAnnotation({ origin: 'human_typed', state: 'human', sentenceIds: ['u3'] }));
    expect(first.state.doc.line(3).text).toBe('OThe test set holds 8,710 targets.');
    expect(first.state.selection.main.head).toBe(words.from + 1);
    expect(first.state.field(rewriteField)).toMatchObject({ phase: 'typing', armed: false, oldFrom: words.from + 1, oldTo: words.to + 1 });
    state = first.state;
    const second = state.update({ changes: { from: words.from + 1, insert: 'ur set' }, selection: { anchor: words.from + 7 }, userEvent: 'input.type' });
    expect(second.annotation(changeAnnotation)).toBeUndefined();
    state = second.state;
    // typing the final period right before the struck words finishes: one transaction removes them
    const fin = state.update({ changes: { from: words.from + 7, insert: '.' }, selection: { anchor: words.from + 8 }, userEvent: 'input.type' });
    expect(fin.state.doc.line(3).text).toBe('Our set.');
    expect(fin.state.field(rewriteField)).toBeNull();
    let changes = 0;
    fin.changes.iterChanges(() => changes++);
    expect(changes).toBe(1);
  });

  it('a different final punctuation replaces the old one; Esc removes the struck words', () => {
    let state = armed();
    state = state.update({ changes: { from: words.from, to: words.to, insert: 'Why' }, userEvent: 'input.type' }).state;
    const q = state.update({ changes: { from: words.from + 3, insert: '?' }, userEvent: 'input.type' });
    expect(q.state.doc.line(3).text).toBe('Why?');

    state = armed();
    state = state.update({ changes: { from: words.from, to: words.to, insert: 'Mine' }, userEvent: 'input.type' }).state;
    const esc = state.update(finishRewriteSpec(state)!);
    expect(esc.state.doc.line(3).text).toBe('Mine.');
    expect(esc.state.field(rewriteField)).toBeNull();
  });

  it('typing outside the sentence takes no annotation; moving the selection away cancels before anything was typed', () => {
    const state = armed();
    const tr = state.update({ changes: { from: 0, insert: 'X' }, userEvent: 'input.type' });
    expect(tr.annotation(changeAnnotation)).toBeUndefined();
    expect(state.update({ selection: { anchor: 0 } }).state.field(rewriteField)).toBeNull();
  });
});
