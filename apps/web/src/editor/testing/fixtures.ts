/** Helpers for the editor unit tests (apps/web/test/editor-*.test.ts; node environment, no DOM). Not used by the app. */
import { EditorState, type Extension } from '@codemirror/state';
import type { SentenceState, SentenceUnit } from '@paper-copilot/core';
import { ctxField, draftNotesField, replanField } from '../context';
import { setUnitsEffect, unitsField } from '../units';

export function unit(id: string, start: number, end: number, extra: Partial<SentenceUnit> = {}): SentenceUnit {
  return {
    id,
    file: 'main.tex',
    start,
    end,
    line: 1,
    hash: `h-${id}`,
    ctxHash: '',
    textNorm: '',
    sectionId: 'sec:results',
    paragraphId: 'sec:results/p0',
    part: 'body',
    kind: 'prose',
    move: null,
    state: 'human' as SentenceState,
    everAi: false,
    grammarFixed: false,
    imported: false,
    model: null,
    promptHash: null,
    createdAt: '2026-11-06T10:00:00.000Z',
    acceptedAt: null,
    editDistance: null,
    intentNote: null,
    facts: [],
    cites: [],
    claims: [],
    placeholders: [],
    orphaned: false,
    splitFrom: null,
    ...extra,
  };
}

/** Units for every sentence of `doc` given as [text, extra] pieces located by indexOf. */
export function unitsFor(doc: string, specs: Array<[string, Partial<SentenceUnit>?]>): SentenceUnit[] {
  return specs.map(([text, extra], i) => {
    const start = doc.indexOf(text);
    if (start < 0) throw new Error(`not in doc: ${text}`);
    return unit(`u${i + 1}`, start, start + text.length, extra ?? {});
  });
}

export function stateWith(doc: string, units: SentenceUnit[], extensions: Extension[] = []): EditorState {
  const s = EditorState.create({ doc, extensions: [EditorState.lineSeparator.of('\n'), unitsField, ctxField, replanField, draftNotesField, ...extensions] });
  return s.update({ effects: setUnitsEffect.of(units) }).state;
}
