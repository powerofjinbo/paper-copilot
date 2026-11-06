import type { Proposal } from '@paper-copilot/core';
import { describe, expect, it } from 'vitest';
import { changeAnnotation, makeAnnotation } from '../src/editor/annotations';
import { intentAcceptSpec, intentContentRange, intentLineAt, intentLinesField, intentRenderEffect, intentRenderField, type IntentRender } from '../src/editor/intent';
import { stateWith } from '../src/editor/testing/fixtures';

const NOTE = '这里补一句：双重多数比单一多数更严格。';
const DOC = `A reconstructed track matches a particle.\n  ${NOTE}  \nThe efficiency is defined below.`;

function rendering(state: ReturnType<typeof stateWith>): IntentRender {
  const line = intentLineAt(state, DOC.indexOf(NOTE))!;
  const r = intentContentRange(state, line);
  return { from: r.from, to: r.to, line: 2, note: r.note, status: 'ready', proposals: [proposal], selected: 0, n: 1, error: null, req: 1 };
}

const proposal: Proposal = {
  proposalId: 'i1',
  sentenceId: null,
  text: 'Double majority is stricter than a single majority.',
  diff: [[1, 'Double majority is stricter than a single majority.']],
  notes: '',
  drift: null,
  issues: [],
  factIds: [],
  citeKeys: ['Wang2022LRT'],
  origin: 'ai_intent',
  model: 'claude-sonnet-5-5',
  promptHash: 'ph-i',
};

describe('intent lines', () => {
  it('finds the intent line at the cursor and its trimmed content (indentation kept)', () => {
    const state = stateWith(DOC, [], [intentLinesField, intentRenderField]);
    expect(intentLineAt(state, 3)).toBeNull();
    const line = intentLineAt(state, DOC.indexOf(NOTE) + 2)!;
    expect(line.line).toBe(2);
    const r = intentContentRange(state, line);
    expect(r.note).toBe(NOTE);
    expect(DOC.slice(r.from, r.to)).toBe(NOTE);
  });

  it('accept replaces the note with the sentence in ONE transaction with origin ai_intent and the Chinese note', () => {
    let state = stateWith(DOC, [], [intentLinesField, intentRenderField]);
    const r = rendering(state);
    state = state.update({ effects: intentRenderEffect.of(r) }).state;
    const tr = state.update(intentAcceptSpec(r, proposal));
    expect(tr.state.doc.toString()).toBe(`A reconstructed track matches a particle.\n  ${proposal.text}  \nThe efficiency is defined below.`);
    let changes = 0;
    tr.changes.iterChanges(() => changes++);
    expect(changes).toBe(1);
    expect(tr.annotation(changeAnnotation)).toEqual(
      makeAnnotation({
        origin: 'ai_intent',
        state: 'ai-from-intent',
        intentNote: NOTE,
        sentenceIds: [],
        model: 'claude-sonnet-5-5',
        promptHash: 'ph-i',
        citeKeys: ['Wang2022LRT'],
        lang: 'zh',
      }),
    );
    expect(tr.state.field(intentRenderField)).toBeNull();
    // the line is no longer an intent line
    expect(intentLineAt(tr.state, tr.state.doc.line(2).from)).toBeNull();
  });

  it('editing the note makes a shown rendering stale (it is discarded)', () => {
    let state = stateWith(DOC, [], [intentLinesField, intentRenderField]);
    const r = rendering(state);
    state = state.update({ effects: intentRenderEffect.of(r) }).state;
    state = state.update({ changes: { from: r.to, insert: '再想想' } }).state;
    expect(state.field(intentRenderField)).toBeNull();
  });

  it('edits elsewhere keep the rendering and map its range', () => {
    let state = stateWith(DOC, [], [intentLinesField, intentRenderField]);
    const r = rendering(state);
    state = state.update({ effects: intentRenderEffect.of(r) }).state;
    state = state.update({ changes: { from: 0, insert: 'X ' } }).state;
    const cur = state.field(intentRenderField)!;
    expect(state.doc.sliceString(cur.from, cur.to)).toBe(NOTE);
  });
});
