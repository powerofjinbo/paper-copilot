/** Data the sentence card shows, derived from the editor state (pure). */
import type { EditorState } from '@codemirror/state';
import type { Fact, LintFlag, OutlineParagraph, OutlineSection, SentenceUnit } from '@paper-copilot/core';
import { ctxField, draftNotesField, outlineFor, replanField, type DraftNote, type ReplanItem } from '../context';
import { unitsField } from '../units';
import { cardField, type CardState } from './cardState';

export interface CardSnapshot {
  card: CardState;
  unit: SentenceUnit;
  text: string;
  facts: readonly Fact[];
  missingFactIds: readonly string[];
  lint: readonly LintFlag[];
  section: OutlineSection | null;
  paragraph: OutlineParagraph | null;
  replan: ReplanItem | null;
  draftNote: DraftNote | null;
  unresolved: ReadonlyArray<{ raw: string; candidates: string[] }>;
}

export function cardSnapshot(state: EditorState): CardSnapshot | null {
  const card = state.field(cardField, false);
  if (!card) return null;
  const unit = state.field(unitsField).byId.get(card.id);
  if (!unit) return null;
  const ctx = state.field(ctxField);
  const facts: Fact[] = [];
  const missing: string[] = [];
  for (const id of unit.facts) {
    const f = ctx.factsById.get(id);
    if (f) facts.push(f);
    else missing.push(id);
  }
  const { section, paragraph } = outlineFor(ctx.outline, unit);
  const text = state.doc.sliceString(unit.start, unit.end);
  return {
    card,
    unit,
    text,
    facts,
    missingFactIds: missing,
    lint: ctx.lintBySentence.get(unit.id) ?? [],
    section,
    paragraph,
    replan: state.field(replanField).get(unit.id) ?? null,
    draftNote: state.field(draftNotesField).get(text.trim()) ?? null,
    unresolved: ctx.unresolved.filter((u) => u.sentenceId === unit.id),
  };
}

export function sameSnapshot(a: CardSnapshot, b: CardSnapshot): boolean {
  return (
    a.card === b.card &&
    a.unit === b.unit &&
    a.text === b.text &&
    a.lint === b.lint &&
    a.section === b.section &&
    a.paragraph === b.paragraph &&
    a.replan === b.replan &&
    a.draftNote === b.draftNote &&
    a.facts.length === b.facts.length &&
    a.facts.every((f, i) => f === b.facts[i]) &&
    a.unresolved.length === b.unresolved.length
  );
}
