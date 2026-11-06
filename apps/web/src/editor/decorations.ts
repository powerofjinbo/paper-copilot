/**
 * Sentence decorations. Builders are pure functions of the EditorState (unit-tested without a DOM):
 * - one mark per unit: class `pc-s pc-s-<state>` (+ data-unit / data-state attributes),
 * - the active sentence (cursor inside) and the sentence whose card is open,
 * - details inside visible sentences: numerals linked to facts (dotted underline, title = renderFact),
 *   numerals with no fact, lint words (wavy underline by severity), placeholders (orange chips).
 */
import { RangeSetBuilder, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { Fact, LintFlag, SentenceUnit } from '@paper-copilot/core';
import { cardField } from './card/cardState';
import { ctxField, type EditorCtx } from './context';
import { factLabel, matchesOf, numeralsOf, placeholdersOf } from './safe';
import { unitAtPos, unitsField, unitsInRange } from './units';

/* ------------------------------------------------------------------------------------ */
/* Sentence marks                                                                        */
/* ------------------------------------------------------------------------------------ */

export function sentenceMark(u: SentenceUnit): Decoration {
  return Decoration.mark({ class: `pc-s pc-s-${u.state}`, attributes: { 'data-unit': u.id, 'data-state': u.state } });
}

export function buildSentenceMarks(units: readonly SentenceUnit[]): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  let last = -1;
  for (const u of units) {
    if (u.end <= u.start || u.start < last) continue;
    b.add(u.start, u.end, sentenceMark(u));
    last = u.end;
  }
  return b.finish();
}

const activeMark = Decoration.mark({ class: 'pc-s-active' });
const cardedMark = Decoration.mark({ class: 'pc-s-carded' });

export function buildActiveMarks(state: EditorState): DecorationSet {
  const units = state.field(unitsField).units;
  const sel = state.selection.main;
  const ranges: Range<Decoration>[] = [];
  const card = state.field(cardField, false);
  const carded = card ? state.field(unitsField).byId.get(card.id) : undefined;
  if (carded && carded.end > carded.start) ranges.push(cardedMark.range(carded.start, carded.end));
  const active = unitAtPos(units, sel.head);
  if (active && active !== carded && (sel.empty || (sel.from >= active.start && sel.to <= active.end))) ranges.push(activeMark.range(active.start, active.end));
  return Decoration.set(ranges, true);
}

/* ------------------------------------------------------------------------------------ */
/* Details: facts, lint, placeholders                                                    */
/* ------------------------------------------------------------------------------------ */

export interface FactMark {
  from: number;
  to: number;
  linked: boolean;
  title: string;
  factIds: string[];
}

/** Numerals of one sentence text, with their facts (offsets relative to the text). */
export function factMarksFor(text: string, facts: readonly Fact[], factsById: ReadonlyMap<string, Fact>): FactMark[] {
  if (facts.length === 0) return [];
  const out: FactMark[] = [];
  const ph = placeholdersOf(text);
  for (const tok of numeralsOf(text)) {
    if (tok.structural) continue;
    if (ph.some((p) => tok.start >= p.start && tok.end <= p.end)) continue;
    const matches = matchesOf(tok, facts as Fact[]);
    if (matches.length) {
      const titles = matches.map((m) => {
        const f = factsById.get(m.factId);
        const label = f ? factLabel(f) : m.factId;
        return m.field === 'value' ? label : `${label} (${m.field.replace(/^unc:/, 'uncertainty: ')})`;
      });
      out.push({ from: tok.start, to: tok.end, linked: true, title: titles.join('\n'), factIds: matches.map((m) => m.factId) });
    } else {
      out.push({ from: tok.start, to: tok.end, linked: false, title: 'No matching fact: link it in Facts or make it a placeholder', factIds: [] });
    }
  }
  return out;
}

/** Offset of a lint word inside a sentence (whole word, case-insensitive), or -1. */
export function findLintWord(text: string, word: string): number {
  if (!word) return -1;
  const lower = text.toLowerCase();
  const w = word.toLowerCase();
  let from = 0;
  let first = -1;
  for (;;) {
    const i = lower.indexOf(w, from);
    if (i < 0) break;
    if (first < 0) first = i;
    const before = i === 0 ? ' ' : lower[i - 1]!;
    const after = lower[i + w.length] ?? ' ';
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return i;
    from = i + 1;
  }
  return first;
}

export function lintTitle(f: LintFlag): string {
  const rate = f.corpusRate !== null ? ` · corpus ${f.corpusRate.toFixed(1)}/1k words` : '';
  return `${f.check}: ${f.msg}${rate}`;
}

const placeholderMarks: Record<string, Decoration> = {};
function placeholderMark(kind: string): Decoration {
  return (placeholderMarks[kind] ??= Decoration.mark({
    class: `pc-ph pc-ph-${kind}`,
    attributes: { title: kind === 'fact' ? 'Placeholder: a number with no fact yet' : kind === 'claim' ? 'Placeholder: a rejected claim, kept so it is not silently lost' : 'Placeholder' },
  }));
}

type FactCache = Map<string, FactMark[]>;

/** Detail decorations for the units and lines intersecting [from, to]. */
export function buildDetailRanges(state: EditorState, from: number, to: number, cache?: FactCache): Range<Decoration>[] {
  const ctx: EditorCtx = state.field(ctxField);
  const ranges: Range<Decoration>[] = [];
  const doc = state.doc;
  for (const u of unitsInRange(state.field(unitsField).units, from, to)) {
    const text = doc.sliceString(u.start, u.end);
    let marks = cache?.get(text);
    if (!marks) {
      marks = factMarksFor(text, ctx.facts, ctx.factsById);
      if (cache) {
        if (cache.size > 3000) cache.clear();
        cache.set(text, marks);
      }
    }
    for (const m of marks)
      ranges.push(Decoration.mark({ class: m.linked ? 'pc-fact' : 'pc-numeral-unlinked', attributes: { title: m.title } }).range(u.start + m.from, u.start + m.to));
    const flags = ctx.lintBySentence.get(u.id);
    if (flags)
      for (const f of flags) {
        if (!f.word) continue;
        const i = findLintWord(text, f.word);
        if (i < 0) continue;
        ranges.push(Decoration.mark({ class: `pc-lint pc-lint-${f.severity}`, attributes: { title: lintTitle(f) } }).range(u.start + i, u.start + i + f.word.length));
      }
  }
  let pos = from;
  while (pos <= to && pos <= doc.length) {
    const line = doc.lineAt(pos);
    if (line.text.indexOf('[') >= 0) for (const p of placeholdersOf(line.text)) ranges.push(placeholderMark(p.kind).range(line.from + p.start, line.from + p.end));
    pos = line.to + 1;
  }
  return ranges;
}

class DetailPlugin {
  decorations: DecorationSet;
  cache: FactCache = new Map();
  factsRev = -1;

  constructor(view: EditorView) {
    this.decorations = this.build(view);
  }
  update(u: ViewUpdate): void {
    const ctxChanged = u.state.field(ctxField) !== u.startState.field(ctxField);
    const unitsChanged = u.state.field(unitsField) !== u.startState.field(unitsField);
    if (u.docChanged || u.viewportChanged || ctxChanged || unitsChanged) this.decorations = this.build(u.view);
  }
  build(view: EditorView): DecorationSet {
    const ctx = view.state.field(ctxField);
    if (ctx.factsRev !== this.factsRev) {
      this.cache.clear();
      this.factsRev = ctx.factsRev;
    }
    const all: Range<Decoration>[] = [];
    for (const r of view.visibleRanges) all.push(...buildDetailRanges(view.state, r.from, r.to, this.cache));
    return Decoration.set(all, true);
  }
}

export function sentenceDecorations(): Extension {
  return [
    EditorView.decorations.compute([unitsField], (state) => buildSentenceMarks(state.field(unitsField).units)),
    EditorView.decorations.compute([unitsField, 'selection', cardField], buildActiveMarks),
    ViewPlugin.fromClass(DetailPlugin, { decorations: (p) => p.decorations }),
  ];
}
