/**
 * Editor-side copies of workspace data that decorations and the card need (facts, lint, outline), plus
 * editor-local data from the server (re-plan proposals, notes of drafted sentences). Kept in state fields
 * so every decoration is a pure function of the EditorState.
 */
import { StateEffect, StateField } from '@codemirror/state';
import type { Fact, FactsResponse, GateIssueWire, IntentLineInfo, LintFlag, Outline, OutlineParagraph, OutlineSection, SentenceUnit } from '@paper-copilot/core';

export interface EditorCtx {
  readonly facts: readonly Fact[];
  readonly factsById: ReadonlyMap<string, Fact>;
  readonly factsRev: number;
  readonly lint: readonly LintFlag[];
  readonly lintBySentence: ReadonlyMap<string, readonly LintFlag[]>;
  readonly lintRev: number;
  readonly outline: Outline | null;
  readonly unresolved: FactsResponse['unresolved'];
  /** Intent lines last reported by the server, mapped to current coordinates (fallback for local detection). */
  readonly serverIntentLines: readonly IntentLineInfo[];
}

export interface CtxInput {
  facts?: readonly Fact[];
  lint?: readonly LintFlag[];
  outline?: Outline | null;
  unresolved?: FactsResponse['unresolved'];
  serverIntentLines?: readonly IntentLineInfo[];
}

export const setCtxEffect = StateEffect.define<CtxInput>();

const EMPTY_CTX: EditorCtx = {
  facts: [],
  factsById: new Map(),
  factsRev: 0,
  lint: [],
  lintBySentence: new Map(),
  lintRev: 0,
  outline: null,
  unresolved: [],
  serverIntentLines: [],
};

function indexLint(lint: readonly LintFlag[]): Map<string, LintFlag[]> {
  const m = new Map<string, LintFlag[]>();
  for (const f of lint) {
    if (f.dismissed || !f.sentenceId) continue;
    const list = m.get(f.sentenceId);
    if (list) list.push(f);
    else m.set(f.sentenceId, [f]);
  }
  return m;
}

export const ctxField = StateField.define<EditorCtx>({
  create: () => EMPTY_CTX,
  update(v, tr) {
    let next = v;
    if (tr.docChanged && v.serverIntentLines.length) {
      const lines: IntentLineInfo[] = [];
      for (const l of v.serverIntentLines) {
        if (l.end > tr.changes.length) continue;
        const start = tr.changes.mapPos(l.start, 1);
        const end = tr.changes.mapPos(l.end, -1);
        if (end > start) lines.push({ ...l, start, end, line: tr.state.doc.lineAt(start).number });
      }
      next = { ...next, serverIntentLines: lines };
    }
    for (const e of tr.effects) {
      if (!e.is(setCtxEffect)) continue;
      const c = e.value;
      next = { ...next };
      if (c.facts !== undefined && c.facts !== next.facts) {
        const byId = new Map<string, Fact>();
        for (const f of c.facts) byId.set(f.id, f);
        next = { ...next, facts: c.facts, factsById: byId, factsRev: next.factsRev + 1 };
      }
      if (c.lint !== undefined && c.lint !== next.lint) next = { ...next, lint: c.lint, lintBySentence: indexLint(c.lint), lintRev: next.lintRev + 1 };
      if (c.outline !== undefined) next = { ...next, outline: c.outline };
      if (c.unresolved !== undefined) next = { ...next, unresolved: c.unresolved };
      if (c.serverIntentLines !== undefined) next = { ...next, serverIntentLines: c.serverIntentLines };
    }
    return next;
  },
});

/** Outline section and paragraph for a unit (by section id, then paragraph id or plan bookkeeping). */
export function outlineFor(outline: Outline | null, unit: Pick<SentenceUnit, 'id' | 'sectionId' | 'paragraphId'>): { section: OutlineSection | null; paragraph: OutlineParagraph | null } {
  if (!outline) return { section: null, paragraph: null };
  const section = outline.sections.find((s) => s.id === unit.sectionId) ?? null;
  if (!section) return { section: null, paragraph: null };
  let paragraph = section.paragraphs.find((p) => p.pid === unit.paragraphId) ?? null;
  if (!paragraph) paragraph = section.paragraphs.find((p) => Object.values(p.plan.said).includes(unit.id)) ?? null;
  return { section, paragraph };
}

/* ------------------------------------------------------------------------------------ */
/* Re-plan proposals (replan.proposed)                                                   */
/* ------------------------------------------------------------------------------------ */

export interface ReplanItem {
  sentenceId: string;
  action: 'revise' | 'drop' | 'insert_before';
  text: string | null;
  reason: string;
}

export const replanEffect = StateEffect.define<{ items: ReadonlyArray<{ sentenceId: string; action: 'keep' | 'revise' | 'drop' | 'insert_before'; text: string | null; reason: string }> }>();
export const clearReplanEffect = StateEffect.define<string>();

export const replanField = StateField.define<ReadonlyMap<string, ReplanItem>>({
  create: () => new Map(),
  update(v, tr) {
    let next: Map<string, ReplanItem> | null = null;
    for (const e of tr.effects) {
      if (e.is(replanEffect)) {
        next = next ?? new Map(v);
        for (const it of e.value.items) {
          if (it.action === 'keep') next.delete(it.sentenceId);
          else next.set(it.sentenceId, { sentenceId: it.sentenceId, action: it.action, text: it.text, reason: it.reason });
        }
      } else if (e.is(clearReplanEffect)) {
        next = next ?? new Map(v);
        next.delete(e.value);
      }
    }
    return next ?? v;
  },
});

/* ------------------------------------------------------------------------------------ */
/* Notes that came with drafted sentences (the drafter's Chinese gloss, referee question, gate issues)    */
/* ------------------------------------------------------------------------------------ */

export interface DraftNote {
  noteZh: string | null;
  refereeQuestion: string | null;
  issues: readonly GateIssueWire[];
  move: string | null;
}

export const draftNotesEffect = StateEffect.define<ReadonlyArray<[string, DraftNote]>>();

/** Keyed by the sentence text as inserted (exact); notes stop showing once the author edits the sentence. */
export const draftNotesField = StateField.define<ReadonlyMap<string, DraftNote>>({
  create: () => new Map(),
  update(v, tr) {
    let next: Map<string, DraftNote> | null = null;
    for (const e of tr.effects) {
      if (!e.is(draftNotesEffect)) continue;
      next = next ?? new Map(v);
      for (const [k, n] of e.value) next.set(k.trim(), n);
    }
    return next ?? v;
  },
});
