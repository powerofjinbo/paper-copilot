/**
 * Ghost text: the client-core state machine lives in a StateField. Events are derived from transactions
 * (typing, deleting, cursor moves, remote changes) or arrive as `ghostEvent` effects (timers, results,
 * composition, keys). The reducer is pure; the effects it returns are stored on the field value and
 * executed by the ghost ViewPlugin (ghostPlugin.ts), which owns timers and the network.
 */
import { StateEffect, StateField, type EditorState, type Transaction } from '@codemirror/state';
import type { GhostMode } from '@paper-copilot/core';
import { ghostReducer, initialGhost, type GhostEffect, type GhostEvent, type GhostMachine } from '@paper-copilot/client-core';
import { changeAnnotation, ghostInsert, remoteChange } from '../annotations';
import { ctxField } from '../context';
import { unitAtPos, unitBefore, unitsField } from '../units';
import { endsSentence, englishWordCount, sentencePrefixIn } from './boundary';

export interface GhostResultMeta {
  requestId: string;
  model: string;
  promptHash: string;
  factIds: string[];
  citeKeys: string[];
  issues: Array<{ code: string; severity: 'block' | 'warn'; message: string }>;
}

export interface GhostNote {
  pos: number;
  text: string;
  kind: 'empty' | 'error' | 'info';
}

export interface GhostValue {
  readonly machine: GhostMachine;
  /** Effects produced by the last transaction (EMPTY when none). */
  readonly effects: readonly GhostEffect[];
  readonly meta: ReadonlyMap<string, GhostResultMeta>;
  readonly note: GhostNote | null;
}

export const ghostEvent = StateEffect.define<GhostEvent>();
export const ghostMetaEffect = StateEffect.define<GhostResultMeta>();
export const ghostNoteEffect = StateEffect.define<GhostNote | null>();

const EMPTY_EFFECTS: readonly GhostEffect[] = [];

let warnedReducer = false;

function reduce(machine: GhostMachine, ev: GhostEvent, out: GhostEffect[]): GhostMachine {
  try {
    const r = ghostReducer(machine, ev);
    out.push(...r.effects);
    return r.machine;
  } catch (err) {
    if (!warnedReducer) {
      warnedReducer = true;
      console.warn('[editor] ghostReducer failed; ghost text is disabled until it works:', err instanceof Error ? err.message : err);
    }
    return machine;
  }
}

/** Ghost mode at a position: outline section setting, else by part (abstract/intro/concl: complete-my-sentence). */
export function ghostModeAt(state: EditorState, pos: number): GhostMode {
  const units = state.field(unitsField).units;
  const u = unitAtPos(units, pos) ?? unitBefore(units, pos) ?? units[0] ?? null;
  if (!u) return 'complete-my-sentence';
  const outline = state.field(ctxField).outline;
  const section = outline?.sections.find((s) => s.id === u.sectionId);
  if (section) return section.ghostMode;
  return u.part === 'abstract' || u.part === 'intro' || u.part === 'concl' ? 'complete-my-sentence' : 'auto-propose';
}

/** Ghost events implied by a transaction itself (not by its explicit ghostEvent effects). */
export function eventsFromTransaction(tr: Transaction, machine: GhostMachine): GhostEvent[] {
  if (tr.annotation(ghostInsert) !== undefined) return [];
  if (tr.docChanged) {
    if (tr.annotation(remoteChange) || tr.annotation(changeAnnotation)) return [{ type: 'external' }];
    // During IME composition the composed text is reported once, at compositionend.
    if (machine.composing || tr.isUserEvent('input.type.compose')) return [];
    const head = tr.state.selection.main.head;
    if (tr.isUserEvent('input.type')) {
      let inserted = '';
      let count = 0;
      tr.changes.iterChanges((_fa, _ta, _fb, _tb, text) => {
        count++;
        inserted += text.toString();
      });
      if (count === 1 && inserted.length > 0 && tr.state.selection.ranges.length === 1) {
        const doc = tr.state.doc;
        const before = doc.sliceString(Math.max(0, head - 600), head);
        const units = tr.state.field(unitsField).units;
        const prefix = sentencePrefixIn((a, b) => doc.sliceString(a, b), units, head);
        return [{ type: 'typed', pos: head, inserted, sentenceWords: englishWordCount(prefix), endsSentence: endsSentence(before) }];
      }
      return [{ type: 'external' }];
    }
    if (tr.isUserEvent('delete')) return [{ type: 'deleted', pos: head }];
    return [{ type: 'external' }];
  }
  if (tr.selection && tr.startState.selection.main.head !== tr.state.selection.main.head) {
    return [{ type: 'cursor', pos: tr.state.selection.main.head }];
  }
  return [];
}

export const ghostField = StateField.define<GhostValue>({
  create: () => ({ machine: initialGhost(), effects: EMPTY_EFFECTS, meta: new Map(), note: null }),
  update(value, tr) {
    let machine = value.machine;
    let meta = value.meta;
    let note = value.note;
    const out: GhostEffect[] = [];

    const head = tr.state.selection.main.head;
    if (tr.docChanged || tr.selection || tr.effects.length) {
      const mode = ghostModeAt(tr.state, head);
      if (mode !== machine.config.mode) machine = reduce(machine, { type: 'modeChanged', mode }, out);
    }
    for (const ev of eventsFromTransaction(tr, machine)) machine = reduce(machine, ev, out);
    for (const e of tr.effects) {
      if (e.is(ghostMetaEffect)) {
        const m = new Map(meta);
        m.set(e.value.requestId, e.value);
        while (m.size > 8) m.delete(m.keys().next().value!);
        meta = m;
      } else if (e.is(ghostNoteEffect)) {
        note = e.value;
      } else if (e.is(ghostEvent)) {
        machine = reduce(machine, e.value, out);
      }
    }
    if (note && (tr.docChanged || (tr.selection && tr.state.selection.main.head !== note.pos))) note = null;
    if (machine === value.machine && out.length === 0 && meta === value.meta && note === value.note && value.effects.length === 0) return value;
    return { machine, effects: out.length ? out : EMPTY_EFFECTS, meta, note };
  },
});

/** What the ghost widget should show right now, or null. */
export function visibleGhost(state: EditorState): { pos: number; text: string; factIds: string[] } | null {
  const { machine } = state.field(ghostField);
  const s = machine.state;
  if (machine.composing || s.kind !== 'showing' || s.hidden || !s.text) return null;
  if (s.pos < 0 || s.pos > state.doc.length) return null;
  return { pos: s.pos, text: s.text, factIds: s.factIds };
}

export function ghostPending(state: EditorState): { pos: number } | null {
  const s = state.field(ghostField).machine.state;
  return s.kind === 'pending' ? { pos: s.pos } : null;
}
