/**
 * Transaction builders for every way AI text (or a review decision) enters the document. Pure: each takes
 * an EditorState and returns TransactionSpecs, so the produced ChangeSets and annotations are unit-tested.
 * Every spec carries a ChangeAnnotation; the document sync forwards it with the doc.change.
 */
import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state';
import type { ChangeAnnotation, Proposal, SentenceState, SentenceUnit, ServerMessage, VersionOrigin } from '@paper-copilot/core';
import { changeAnnotation, makeAnnotation } from './annotations';
import type { ReplanItem } from './context';
import { unitsField } from './units';

export type DraftMsg = Extract<ServerMessage, { type: 'draft.proposed' }>;

/** State a unit gets when a proposal of this origin is applied (grammar keeps it; re-plan stays proposed). */
export function defaultStateFor(origin: VersionOrigin, unit: SentenceUnit): SentenceState | null {
  switch (origin) {
    case 'grammar_fix':
      return unit.state;
    case 'replan':
      return 'proposed';
    case 'ai_intent':
      return 'ai-from-intent';
    case 'ai_rewrite':
    case 'ai_ghost':
    case 'ai_draft':
      return 'ai-drafted';
    default:
      return null;
  }
}

/** Replace a unit's whole text as one annotated transaction. */
export function replaceUnitSpec(state: EditorState, id: string, text: string, annotation: ChangeAnnotation): TransactionSpec | null {
  const u = state.field(unitsField).byId.get(id);
  if (!u || u.end < u.start || u.end > state.doc.length) return null;
  return {
    changes: { from: u.start, to: u.end, insert: text },
    selection: EditorSelection.cursor(u.start + text.length),
    annotations: [changeAnnotation.of(annotation)],
    userEvent: 'input.ai',
    scrollIntoView: true,
  };
}

/**
 * Restore an earlier version (POST /api/sentences/:id/restore): the server's text and annotation, applied
 * as ONE transaction, only while the unit still reads exactly like the text the server saw (`current`);
 * null otherwise (the author typed meanwhile) so nothing is overwritten.
 */
export function restoreSpec(state: EditorState, r: { sentenceId: string; current: string; text: string; annotation: ChangeAnnotation }): TransactionSpec | null {
  const u = state.field(unitsField).byId.get(r.sentenceId);
  if (!u || u.end < u.start || u.end > state.doc.length) return null;
  if (state.doc.sliceString(u.start, u.end) !== r.current) return null;
  return replaceUnitSpec(state, r.sentenceId, r.text, { ...r.annotation, sentenceIds: r.annotation.sentenceIds.length ? r.annotation.sentenceIds : [r.sentenceId] });
}

/** handle.applyProposal: the proposal text replaces its unit; origin from the proposal (ai_rewrite, grammar_fix, replan...). */
export function proposalSpec(
  state: EditorState,
  p: Proposal,
  opts: { state?: SentenceState; instruction?: string | null; lang?: string | null } = {},
): TransactionSpec | null {
  if (!p.sentenceId) return null;
  const u = state.field(unitsField).byId.get(p.sentenceId);
  if (!u) return null;
  const annotation = makeAnnotation({
    origin: p.origin,
    sentenceIds: [u.id],
    state: opts.state ?? defaultStateFor(p.origin, u),
    model: p.model,
    promptHash: p.promptHash,
    factIds: p.factIds,
    citeKeys: p.citeKeys,
    instruction: opts.instruction ?? null,
    lang: opts.lang ?? null,
    // keep the author's note: the server copies intentNote from AI annotations
    intentNote: u.intentNote,
    move: u.move,
  });
  return replaceUnitSpec(state, u.id, p.text, annotation);
}

/** Reject: the sentence becomes the server's `[claim: ...?]` placeholder. */
export function rejectSpec(state: EditorState, id: string, replacement: string): TransactionSpec | null {
  const u = state.field(unitsField).byId.get(id);
  if (!u) return null;
  return replaceUnitSpec(state, id, replacement, makeAnnotation({ origin: 'human_edit', state: 'placeholder', sentenceIds: [id], intentNote: u.intentNote, move: u.move }));
}

/* ------------------------------------------------------------------------------------ */
/* Drafts                                                                                */
/* ------------------------------------------------------------------------------------ */

/** Where a draft goes: end of the line of the last sentence of the paragraph holding `afterSentenceId`, else the mapped `insertAt`, else before \end{document}. */
export function draftInsertionPoint(state: EditorState, msg: DraftMsg, mapInsertAt?: (pos: number, version: number) => number | null): number {
  const { units, byId } = state.field(unitsField);
  const doc = state.doc;
  if (msg.afterSentenceId) {
    const u = byId.get(msg.afterSentenceId);
    if (u) {
      let last = u;
      const i = units.indexOf(u);
      for (let k = i + 1; k < units.length && units[k]!.paragraphId === u.paragraphId; k++) last = units[k]!;
      return doc.lineAt(last.end).to;
    }
  }
  if (msg.insertAt !== null) {
    const p = mapInsertAt ? mapInsertAt(msg.insertAt, msg.version) : msg.insertAt;
    if (p !== null && p >= 0 && p <= doc.length) return doc.lineAt(p).to;
  }
  const end = doc.toString().lastIndexOf('\\end{document}');
  if (end >= 0) {
    const lineFrom = doc.lineAt(end).from;
    return lineFrom > 0 ? lineFrom - 1 : 0;
  }
  return doc.length;
}

/** One transaction per drafted sentence, each on its own line; paragraphs separated by a blank line. */
export function draftSentenceSpecs(at: number, msg: DraftMsg): TransactionSpec[] {
  const specs: TransactionSpec[] = [];
  let pos = at;
  for (const para of msg.paragraphs) {
    para.sentences.forEach((s, i) => {
      const insert = (i === 0 ? '\n\n' : '\n') + s.text;
      specs.push({
        changes: { from: pos, insert },
        annotations: [
          changeAnnotation.of(
            makeAnnotation({
              origin: 'ai_draft',
              state: s.state,
              sentenceIds: [],
              factIds: s.factIds,
              citeKeys: s.citeKeys,
              move: s.move,
            }),
          ),
        ],
        userEvent: 'input.ai.draft',
      });
      pos += insert.length;
    });
  }
  return specs;
}

/* ------------------------------------------------------------------------------------ */
/* Re-plan proposals                                                                     */
/* ------------------------------------------------------------------------------------ */

/** revise: new text for a downstream proposed sentence (stays proposed). */
export function replanReviseSpec(state: EditorState, item: ReplanItem): TransactionSpec | null {
  const u = state.field(unitsField).byId.get(item.sentenceId);
  if (!u || item.text === null) return null;
  return replaceUnitSpec(state, u.id, item.text, makeAnnotation({ origin: 'replan', state: 'proposed', sentenceIds: [u.id], intentNote: u.intentNote, move: u.move }));
}

/** drop: delete the sentence (and its line when it was alone on it); the author's decision. */
export function replanDropSpec(state: EditorState, item: ReplanItem): TransactionSpec | null {
  const u = state.field(unitsField).byId.get(item.sentenceId);
  if (!u) return null;
  const line = state.doc.lineAt(u.start);
  let from = u.start;
  let to = u.end;
  if (line.text.trim() === state.doc.sliceString(u.start, u.end).trim() && u.end <= line.to) {
    from = line.from;
    to = line.to < state.doc.length ? line.to + 1 : line.to;
    if (to === line.to && from > 0) from -= 1;
  }
  return {
    changes: { from, to },
    annotations: [changeAnnotation.of(makeAnnotation({ origin: 'human_edit', state: null, sentenceIds: [u.id] }))],
    userEvent: 'delete.ai',
  };
}

/** insert_before: a new proposed sentence before this one (own line when the sentence starts its line). */
export function replanInsertBeforeSpec(state: EditorState, item: ReplanItem): TransactionSpec | null {
  const u = state.field(unitsField).byId.get(item.sentenceId);
  if (!u || !item.text) return null;
  const line = state.doc.lineAt(u.start);
  const startsLine = state.doc.sliceString(line.from, u.start).trim() === '';
  const insert = startsLine ? `${item.text}\n` : `${item.text} `;
  return {
    changes: { from: u.start, insert },
    annotations: [changeAnnotation.of(makeAnnotation({ origin: 'replan', state: 'proposed', sentenceIds: [], move: u.move }))],
    userEvent: 'input.ai',
  };
}
