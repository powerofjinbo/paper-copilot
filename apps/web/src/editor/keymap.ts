/**
 * Prec.highest key bindings: ghost (Tab, Mod-ArrowRight, Escape, Ctrl-Space), intent lines (Mod-Enter,
 * Alt-Enter, Tab/Enter/1-3/Esc while a rendering is shown), review (Alt-ArrowDown/Up, Mod-Enter on a
 * proposed sentence), the sentence card (Ctrl-., Mod-I, Mod-G) and housekeeping (Mod-S, Mod-Alt-O).
 * Every command returns false when it does not apply, so the default bindings (indent, find next...)
 * keep working, with two deliberate exceptions:
 *  - Mod-Enter is always consumed: CodeMirror's default (insertBlankLine) would add a LaTeX paragraph
 *    break, which nothing on screen shows; on a sentence that is not proposed a short note says why
 *    nothing happened;
 *  - Alt-ArrowDown/Up navigate the review queue; with nothing to review they fall through to the standard
 *    "move line", except right after a review step (an impatient extra press must not move a sentence).
 */
import { Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap, type Command } from '@codemirror/view';
import { searchPanelOpen } from '@codemirror/search';
import { cardField, closeCardEffect } from './card/cardState';
import { editorEnv } from './env';
import { ghostEvent, ghostField, ghostModeAt, ghostNoteEffect, visibleGhost } from './ghost/ghostField';
import { intentAcceptSpec, intentLineAt, intentRenderEffect, intentRenderField } from './intent';
import { currentLang, edText } from './i18n';
import { finishRewriteSpec, rewriteField } from './rewrite';
import { unitAtPos, unitBefore, unitsField } from './units';

function env(view: EditorView) {
  return view.state.facet(editorEnv);
}

function unitAtCursor(view: EditorView) {
  const sel = view.state.selection.main;
  const units = view.state.field(unitsField).units;
  return unitAtPos(units, sel.head) ?? (sel.empty ? null : unitAtPos(units, sel.from));
}

/* ---------------------------------------------------------------- intent rendering */

function intentReady(view: EditorView) {
  const r = view.state.field(intentRenderField);
  if (!r || r.status !== 'ready' || r.proposals.length === 0) return null;
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(r.from);
  return head >= line.from && head <= line.to ? r : null;
}

export function acceptIntent(view: EditorView, index?: number): boolean {
  const r = view.state.field(intentRenderField);
  if (!r || r.status !== 'ready') return false;
  const p = r.proposals[index ?? r.selected];
  if (!p) return false;
  view.dispatch(intentAcceptSpec(r, p));
  env(view)?.ops.announce('Note rendered into an English sentence.');
  return true;
}

const intentKey =
  (fn: (view: EditorView) => boolean): Command =>
  (view) =>
    intentReady(view) ? fn(view) : false;

const intentPick =
  (n: number): Command =>
  (view) => {
    const r = intentReady(view);
    if (!r || r.proposals.length < 2 || n >= r.proposals.length) return false;
    return acceptIntent(view, n);
  };

const intentMove =
  (dir: 1 | -1): Command =>
  (view) => {
    const r = intentReady(view);
    if (!r || r.proposals.length < 2) return false;
    const selected = (r.selected + dir + r.proposals.length) % r.proposals.length;
    view.dispatch({ effects: intentRenderEffect.of({ ...r, selected }) });
    return true;
  };

/* ---------------------------------------------------------------- ghost */

const acceptGhost: Command = (view) => {
  if (!visibleGhost(view.state)) return false;
  view.dispatch({ effects: ghostEvent.of({ type: 'accept' }) });
  return true;
};

const acceptGhostWord: Command = (view) => {
  if (!visibleGhost(view.state)) return false;
  view.dispatch({ effects: ghostEvent.of({ type: 'acceptWord' }) });
  return true;
};

const requestGhost: Command = (view) => {
  if (view.composing) return false;
  const head = view.state.selection.main.head;
  if (intentLineAt(view.state, head)) return false;
  view.dispatch({ effects: ghostEvent.of({ type: 'manual', pos: head }) });
  const after = view.state.field(ghostField).machine;
  if (after.state.kind === 'idle' && ghostModeAt(view.state, head) === 'questions-only')
    view.dispatch({ effects: ghostNoteEffect.of({ pos: head, text: edText(currentLang(), 'questionsOnly'), kind: 'info' }) });
  return true;
};

/* ---------------------------------------------------------------- escape */

const escape: Command = (view) => {
  const state = view.state;
  if (state.field(intentRenderField)) {
    view.dispatch({ effects: intentRenderEffect.of(null) });
    return true;
  }
  const g = state.field(ghostField).machine.state;
  if (visibleGhost(state)) {
    view.dispatch({ effects: ghostEvent.of({ type: 'dismiss' }) });
    return true;
  }
  if (state.field(cardField)) {
    view.dispatch({ effects: closeCardEffect.of(null) });
    return true;
  }
  if (g.kind === 'showing' || g.kind === 'pending' || g.kind === 'waiting') {
    // also suppresses automatic suggestions until the next sentence boundary
    view.dispatch({ effects: ghostEvent.of({ type: 'dismiss' }) });
    return true;
  }
  if (state.field(rewriteField)) {
    const spec = finishRewriteSpec(state);
    if (spec) view.dispatch(spec);
    return true;
  }
  if (state.field(ghostField).note) {
    view.dispatch({ effects: ghostNoteEffect.of(null) });
    return true;
  }
  return false;
};

/* ---------------------------------------------------------------- review and card */

const modEnter: Command = (view) => {
  if (intentReady(view)) return acceptIntent(view);
  const head = view.state.selection.main.head;
  if (intentLineAt(view.state, head)) {
    env(view)?.ops.renderIntent(view, 1);
    return true;
  }
  const u = unitAtCursor(view);
  if (u && (u.state === 'proposed' || u.state === 'unsupported')) {
    void env(view)?.ops.acceptUnit(view, u.id);
    return true;
  }
  // never fall through to insertBlankLine (a paragraph break in the compiled paper)
  if (u) view.dispatch({ effects: ghostNoteEffect.of({ pos: Math.min(u.end, view.state.doc.length), text: edText(currentLang(), 'alreadyAccepted'), kind: 'info' }) });
  return true;
};

const altEnter: Command = (view) => {
  const head = view.state.selection.main.head;
  const r = view.state.field(intentRenderField);
  if (r || intentLineAt(view.state, head)) return env(view)?.ops.renderIntent(view, 3) ?? false;
  return false;
};

const openCard =
  (cardView: 'main' | 'instruct' | 'grammar'): Command =>
  (view) => {
    if (cardView === 'grammar' && searchPanelOpen(view.state)) return false;
    const units = view.state.field(unitsField).units;
    const head = view.state.selection.main.head;
    const u = unitAtCursor(view) ?? (cardView === 'main' ? unitBefore(units, head) : null);
    if (!u) return false;
    env(view)?.ops.openCard(view, u.id, { pinned: true, focus: true, view: cardView });
    return true;
  };

const review =
  (dir: 1 | -1): Command =>
  (view) =>
    env(view)?.ops.reviewStep(view, dir) ?? false;

export function paperKeymap(): Extension {
  return Prec.highest(
    keymap.of([
      { key: 'Tab', run: (v) => intentKey(acceptIntent)(v) || acceptGhost(v) },
      { key: 'Enter', run: intentKey(acceptIntent) },
      { key: '1', run: intentPick(0) },
      { key: '2', run: intentPick(1) },
      { key: '3', run: intentPick(2) },
      { key: 'ArrowDown', run: intentMove(1) },
      { key: 'ArrowUp', run: intentMove(-1) },
      { key: 'Mod-ArrowRight', run: acceptGhostWord },
      { key: 'Escape', run: escape },
      { key: 'Ctrl-Space', run: requestGhost, preventDefault: true },
      { key: 'Ctrl-Shift-Space', run: requestGhost, preventDefault: true },
      { key: 'Alt-/', run: requestGhost },
      { key: 'Mod-Enter', run: modEnter },
      { key: 'Alt-Enter', run: altEnter },
      { key: 'Alt-ArrowDown', run: review(1) },
      { key: 'Alt-ArrowUp', run: review(-1) },
      { key: 'Ctrl-.', run: openCard('main') },
      { key: 'Mod-.', run: openCard('main') },
      { key: 'Mod-i', run: openCard('instruct') },
      { key: 'Mod-g', run: openCard('grammar') },
      {
        key: 'Mod-s',
        run: (v) => {
          env(v)?.ops.flush();
          return true;
        },
        preventDefault: true,
      },
      {
        key: 'Mod-Alt-o',
        run: (v) => {
          env(v)?.ops.toggleHeatmap();
          return true;
        },
      },
    ]),
  );
}
