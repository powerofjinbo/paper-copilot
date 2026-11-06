/**
 * "Rewrite myself" (card key `r`).
 *
 * The sentence's words are selected (its ending, e.g. "." or ".\cite{x}", stays) and a gray hint line
 * shows its intent note and fact chips. The next typing transaction inside the sentence carries
 * {origin: 'human_typed', state: 'human', sentenceIds: [id]}, so the server keeps the id and everAi while
 * the text becomes the author's.
 *
 * One refinement keeps that promise robust: the first keystroke over the selection is inserted BEFORE
 * the old words instead of replacing them, and the old words stay visible, struck through, as a
 * reference. Replacing them at once would leave a one-letter fragment ("E.") that the segmenter does not
 * treat as a sentence, so the server's immediate re-segmentation of the annotated change would drop the
 * unit and its id. Typing the sentence's final punctuation right before the struck words (or Esc, or
 * leaving the sentence) removes them in one transaction.
 */
import { EditorSelection, EditorState, StateEffect, StateField, Transaction, type Extension, type TransactionSpec } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { SentenceUnit } from '@paper-copilot/core';
import { changeAnnotation, makeAnnotation, remoteChange } from './annotations';
import { unitsField } from './units';
import { currentLang, edText } from './i18n';

export interface RewriteState {
  id: string;
  /** 'selected': the words are selected, nothing typed yet; 'typing': the author types before the struck old words. */
  phase: 'selected' | 'typing';
  /** True until a change inside the sentence carried the human_typed annotation. */
  armed: boolean;
  /** Where the author's new text starts (mapped so text typed there stays after it). */
  newFrom: number;
  /** The old words (selected, then struck). */
  oldFrom: number;
  oldTo: number;
  note: string | null;
  facts: readonly string[];
}

export const rewriteEffect = StateEffect.define<RewriteState | null>();

/**
 * Length of the part of a sentence the author retypes: everything before its terminal punctuation and
 * whatever trails it (closing quotes/brackets, \cite{..}, \footnote{..}).
 */
export function rewritableLength(text: string): number {
  const m = /[.?!]["”’)\]]*(?:\\(?:cite[a-zA-Z]*|footnote)(?:\[[^\]]*\])?\{[^}]*\})*\s*$/.exec(text);
  return m && m.index > 0 ? m.index : text.length;
}

function humanTyped(u: SentenceUnit | undefined, id: string) {
  return changeAnnotation.of(makeAnnotation({ origin: 'human_typed', state: 'human', sentenceIds: [id], intentNote: u?.intentNote ?? null, move: u?.move ?? null }));
}

export const rewriteField = StateField.define<RewriteState | null>({
  create: () => null,
  update(v, tr) {
    let next = v;
    let explicit = false;
    for (const e of tr.effects)
      if (e.is(rewriteEffect)) {
        next = e.value;
        explicit = true;
      }
    if (!next || explicit) return next;
    const u = tr.state.field(unitsField).byId.get(next.id);
    if (!u) return null;
    if (tr.docChanged) {
      if (next.phase === 'typing') {
        // an edit inside the struck words means the author is editing the old text after all: stop
        let inside = false;
        tr.changes.iterChangedRanges((fromA, toA) => {
          if ((fromA > next!.oldFrom && fromA < next!.oldTo) || (toA > next!.oldFrom && toA <= next!.oldTo && fromA < toA)) inside = true;
        });
        if (inside) return null;
      }
      next = { ...next, newFrom: tr.changes.mapPos(next.newFrom, -1), oldFrom: tr.changes.mapPos(next.oldFrom, 1), oldTo: tr.changes.mapPos(next.oldTo, -1) };
      if (next.oldTo < next.oldFrom || next.oldFrom < next.newFrom) return null;
    }
    const ann = tr.annotation(changeAnnotation);
    if (next.armed && ann && ann.origin === 'human_typed' && ann.sentenceIds[0] === next.id) next = { ...next, armed: false };
    if (next.phase === 'selected' && tr.selection && !tr.docChanged) {
      const sel = tr.state.selection.main;
      if (sel.from !== next.oldFrom || sel.to !== next.oldTo) return null; // selection moved: nothing to rewrite
    }
    return next;
  },
});

/** Turns the first keystroke over the selected words into "type before them", and the final period into the finish. */
const rewriteFilter = EditorState.transactionFilter.of((tr) => {
  const r = tr.startState.field(rewriteField, false);
  if (!r || !tr.docChanged || tr.annotation(changeAnnotation) || tr.annotation(remoteChange)) return tr;
  if (!tr.isUserEvent('input') && !tr.isUserEvent('delete')) return tr;
  const list: Array<{ fromA: number; toA: number; text: string }> = [];
  tr.changes.iterChanges((fromA, toA, _fb, _tb, ins) => list.push({ fromA, toA, text: ins.toString() }));
  if (list.length !== 1) return tr;
  const c = list[0]!;
  const u = tr.startState.field(unitsField).byId.get(r.id);
  const userEvent = tr.annotation(Transaction.userEvent);
  if (r.phase === 'selected' && c.fromA === r.oldFrom && c.toA === r.oldTo) {
    const ins = c.text;
    return {
      changes: ins ? { from: r.oldFrom, insert: ins } : [],
      selection: EditorSelection.cursor(r.oldFrom + ins.length),
      annotations: ins ? [humanTyped(u, r.id), ...(userEvent ? [Transaction.userEvent.of(userEvent)] : [])] : [],
      effects: rewriteEffect.of({ ...r, phase: 'typing', armed: !ins, newFrom: r.oldFrom, oldFrom: r.oldFrom + ins.length, oldTo: r.oldTo + ins.length }),
      scrollIntoView: true,
    };
  }
  if (r.phase === 'typing' && tr.isUserEvent('input.type') && c.fromA === r.oldFrom && c.toA === r.oldFrom && /^[.?!]$/.test(c.text) && r.oldFrom > r.newFrom) {
    const doc = tr.startState.doc;
    const ending = doc.sliceString(r.oldTo, r.oldTo + 1);
    const changes: Array<{ from: number; to?: number; insert?: string }> = [{ from: r.oldFrom, to: r.oldTo }];
    if (/[.?!]/.test(ending)) {
      if (ending !== c.text) changes.push({ from: r.oldTo, to: r.oldTo + 1, insert: c.text });
    } else changes.push({ from: r.oldTo, insert: c.text });
    return {
      changes,
      selection: EditorSelection.cursor(r.oldFrom + 1),
      annotations: [...(r.armed ? [humanTyped(u, r.id)] : []), Transaction.userEvent.of('input.type')],
      effects: rewriteEffect.of(null),
    };
  }
  return tr;
});

/** Adds the human_typed annotation to the first typing transaction inside the sentence (if the filter did not). */
export const rewriteExtender = EditorState.transactionExtender.of((tr) => {
  const r = tr.startState.field(rewriteField, false);
  if (!r || !r.armed || !tr.docChanged || tr.annotation(changeAnnotation) || tr.annotation(remoteChange)) return null;
  if (!tr.isUserEvent('input') && !tr.isUserEvent('delete')) return null;
  const u = tr.startState.field(unitsField).byId.get(r.id);
  if (!u) return null;
  const region = rewriteRegion(r, u);
  let inside = true;
  tr.changes.iterChangedRanges((fromA, toA) => {
    if (fromA < region.from || toA > region.to) inside = false;
  });
  if (!inside) return null;
  return { annotations: humanTyped(u, r.id) };
});

/** The text being rewritten: the author's new words, the struck old words and the sentence ending. */
export function rewriteRegion(r: RewriteState, u: SentenceUnit): { from: number; to: number } {
  return { from: Math.min(r.newFrom, u.start), to: Math.max(u.end, r.oldTo) };
}

/** Esc or leaving the sentence: drop the struck words if the author typed a new version, else just stop. */
export function finishRewriteSpec(state: EditorState): TransactionSpec | null {
  const r = state.field(rewriteField, false);
  if (!r) return null;
  const u = state.field(unitsField).byId.get(r.id);
  if (r.phase === 'typing' && u && r.oldFrom > r.newFrom && r.oldTo > r.oldFrom) {
    return {
      changes: { from: r.oldFrom, to: r.oldTo },
      annotations: [...(r.armed ? [humanTyped(u, r.id)] : []), Transaction.userEvent.of('delete.rewrite')],
      effects: rewriteEffect.of(null),
    };
  }
  return { effects: rewriteEffect.of(null) };
}

class RewriteHintWidget extends WidgetType {
  constructor(readonly r: RewriteState) {
    super();
  }
  override eq(other: RewriteHintWidget): boolean {
    return other.r.id === this.r.id && other.r.phase === this.r.phase && other.r.note === this.r.note && other.r.facts.join('|') === this.r.facts.join('|');
  }
  override toDOM(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'pc-rewrite-hint';
    el.setAttribute('role', 'note');
    const lead = document.createElement('span');
    lead.className = 'pc-rewrite-lead';
    lead.textContent = edText(currentLang(), this.r.phase === 'selected' ? 'rwSelected' : 'rwTyping');
    el.appendChild(lead);
    if (this.r.note) {
      const n = document.createElement('span');
      n.className = 'pc-rewrite-note';
      n.lang = 'zh';
      n.textContent = `${edText(currentLang(), 'rwIntent')}: ${this.r.note}`;
      el.appendChild(n);
    }
    for (const f of this.r.facts) {
      const c = document.createElement('span');
      c.className = 'pc-chip pc-chip-fact';
      c.textContent = f;
      el.appendChild(c);
    }
    const esc = document.createElement('span');
    esc.className = 'pc-rewrite-keys';
    esc.textContent = edText(currentLang(), 'rwEsc');
    el.appendChild(esc);
    return el;
  }
  override get estimatedHeight(): number {
    return 26;
  }
}

const oldWordsMark = Decoration.mark({ class: 'pc-rewrite-old', attributes: { title: 'Your earlier text, kept as a reference while you rewrite' } });

/** Leaving the sentence while rewriting finishes the rewrite (deferred: no dispatch inside an update). */
const rewriteWatcher = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {}
    update(u: ViewUpdate) {
      const r = u.state.field(rewriteField);
      if (!r || r.phase !== 'typing' || !u.selectionSet) return;
      const unit = u.state.field(unitsField).byId.get(r.id);
      const head = u.state.selection.main.head;
      if (unit) {
        const region = rewriteRegion(r, unit);
        if (head >= region.from && head <= region.to + 1) return;
      }
      queueMicrotask(() => {
        const spec = finishRewriteSpec(this.view.state);
        if (spec) this.view.dispatch(spec);
      });
    }
  },
);

export function rewriteExtension(): Extension {
  return [
    rewriteField,
    rewriteFilter,
    rewriteExtender,
    rewriteWatcher,
    EditorView.decorations.compute([rewriteField, unitsField], (state): DecorationSet => {
      const r = state.field(rewriteField);
      if (!r) return Decoration.none;
      const u = state.field(unitsField).byId.get(r.id);
      if (!u) return Decoration.none;
      const ranges = [];
      if (r.phase === 'typing' && r.oldTo > r.oldFrom) ranges.push(oldWordsMark.range(r.oldFrom, r.oldTo));
      const at = state.doc.lineAt(Math.min(rewriteRegion(r, u).to, state.doc.length)).to;
      ranges.push(Decoration.widget({ widget: new RewriteHintWidget(r), block: true, side: 1 }).range(at));
      return Decoration.set(ranges, true);
    }),
  ];
}
