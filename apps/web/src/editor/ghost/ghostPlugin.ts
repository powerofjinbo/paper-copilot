/**
 * Executes ghost-machine effects (timers, requests, inserts, feedback), renders the ghost widget, feeds
 * IME composition events to the machine, and turns server replies into machine events.
 */
import { EditorSelection, Transaction, type EditorState, type Extension, type TransactionSpec } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { GhostEffect } from '@paper-copilot/client-core';
import type { ServerMessage } from '@paper-copilot/core';
import { changeAnnotation, ghostInsert, makeAnnotation } from '../annotations';
import { ctxField } from '../context';
import { editorEnv } from '../env';
import { currentLang, edText } from '../i18n';
import { appendWithPlaceholders } from '../intent';
import { matchesOf, numeralsOf, placeholdersOf } from '../safe';
import { unitAtPos, unitsField } from '../units';
import { sentencePrefixIn } from './boundary';
import { ghostEvent, ghostField, ghostMetaEffect, ghostNoteEffect, visibleGhost } from './ghostField';

/* ------------------------------------------------------------------------------------ */
/* Widget                                                                                */
/* ------------------------------------------------------------------------------------ */

class GhostWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly factRanges: ReadonlyArray<{ from: number; to: number; title: string }>,
  ) {
    super();
  }
  override eq(other: GhostWidget): boolean {
    return other.text === this.text && other.factRanges.length === this.factRanges.length;
  }
  override toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'pc-ghost';
    span.setAttribute('aria-hidden', 'true');
    span.setAttribute('data-testid', 'ghost');
    const text = this.text;
    let pos = 0;
    for (const r of this.factRanges) {
      if (r.from < pos) continue;
      if (r.from > pos) appendWithPlaceholders(span, text.slice(pos, r.from));
      const f = document.createElement('span');
      f.className = 'pc-ghost-fact';
      f.title = r.title;
      f.textContent = text.slice(r.from, r.to);
      span.appendChild(f);
      pos = r.to;
    }
    if (pos < text.length) appendWithPlaceholders(span, text.slice(pos));
    return span;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

/* The first few ghosts carry a one-line "Tab accept · Esc dismiss" hint (UX review: the keys were named nowhere). */
const HINT_KEY = 'paper-copilot.ghostHintsShown';
const HINT_TIMES = 3;
let hintsShown = (() => {
  try {
    return Number(localStorage.getItem(HINT_KEY)) || 0;
  } catch {
    return 0;
  }
})();
/** Text of the ghost that carries the hint (null: none). */
let hintedText: string | null = null;

/** A new ghost suggestion is about to be shown. */
function noteGhostShown(text: string): void {
  if (hintsShown >= HINT_TIMES) {
    hintedText = null;
    return;
  }
  hintsShown++;
  hintedText = text;
  try {
    localStorage.setItem(HINT_KEY, String(hintsShown));
  } catch {
    /* private window */
  }
}

class GhostHintWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  override eq(other: GhostHintWidget): boolean {
    return other.text === this.text;
  }
  override toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'pc-ghost-hint';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = this.text;
    return span;
  }
}

class GhostNoteWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly kind: string,
  ) {
    super();
  }
  override eq(other: GhostNoteWidget): boolean {
    return other.text === this.text && other.kind === this.kind;
  }
  override toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = `pc-ghost-note pc-ghost-note-${this.kind}`;
    span.setAttribute('role', 'status');
    span.textContent = this.text;
    return span;
  }
}

function ghostFactRanges(state: EditorState, text: string, factIds: readonly string[]): Array<{ from: number; to: number; title: string }> {
  const ctx = state.field(ctxField);
  if (ctx.facts.length === 0) return [];
  const preferred = factIds.length ? ctx.facts.filter((f) => factIds.includes(f.id)) : ctx.facts;
  const out: Array<{ from: number; to: number; title: string }> = [];
  const ph = placeholdersOf(text);
  for (const tok of numeralsOf(text)) {
    if (tok.structural || ph.some((p) => tok.start >= p.start && tok.end <= p.end)) continue;
    const m = matchesOf(tok, preferred);
    if (m.length) out.push({ from: tok.start, to: tok.end, title: m.map((x) => x.factId + (x.field === 'value' ? '' : ` (${x.field})`)).join(', ') });
  }
  return out;
}

export const ghostDecorations = EditorView.decorations.compute([ghostField, ctxField], (state): DecorationSet => {
  const g = visibleGhost(state);
  const ranges = [];
  if (g) ranges.push(Decoration.widget({ widget: new GhostWidget(g.text, ghostFactRanges(state, g.text, g.factIds)), side: 1 }).range(g.pos));
  if (g && hintedText !== null && hintedText === g.text) ranges.push(Decoration.widget({ widget: new GhostHintWidget(edText(currentLang(), 'ghostHint')), side: 2 }).range(g.pos));
  const note = state.field(ghostField).note;
  if (note && note.pos <= state.doc.length && !g) ranges.push(Decoration.widget({ widget: new GhostNoteWidget(note.text, note.kind), side: 1 }).range(note.pos));
  return ranges.length ? Decoration.set(ranges, true) : Decoration.none;
});

/* ------------------------------------------------------------------------------------ */
/* Accepting ghost text                                                                  */
/* ------------------------------------------------------------------------------------ */

/**
 * The transaction for a machine 'insert' effect (Tab / Mod-ArrowRight): the accepted text with
 * {origin: 'ai_ghost', state: 'ai-drafted', sentenceIds: [unit at the cursor] or [], model, promptHash,
 * factIds, citeKeys, requestId}. Marked with `ghostInsert` so it is not fed back as typing.
 */
export function ghostInsertSpec(state: EditorState, eff: Extract<GhostEffect, { type: 'insert' }>): TransactionSpec | null {
  if (eff.pos > state.doc.length || !eff.text) return null;
  const g = state.field(ghostField);
  const meta = g.meta.get(eff.requestId);
  const s = g.machine.state;
  const unit = unitAtPos(state.field(unitsField).units, eff.pos);
  const factIds = meta?.factIds ?? (s.kind === 'showing' ? s.factIds : []);
  const citeKeys = meta?.citeKeys ?? (s.kind === 'showing' ? s.citeKeys : []);
  return {
    changes: { from: eff.pos, insert: eff.text },
    selection: EditorSelection.cursor(eff.pos + eff.text.length),
    annotations: [
      ghostInsert.of(eff.requestId),
      Transaction.userEvent.of('input.complete'),
      changeAnnotation.of(
        makeAnnotation({
          origin: 'ai_ghost',
          state: 'ai-drafted',
          sentenceIds: unit ? [unit.id] : [],
          model: meta?.model ?? null,
          promptHash: meta?.promptHash ?? null,
          factIds,
          citeKeys,
          requestId: eff.requestId,
        }),
      ),
    ],
    scrollIntoView: true,
  };
}

/* ------------------------------------------------------------------------------------ */
/* Effects executor                                                                      */
/* ------------------------------------------------------------------------------------ */

const GHOST_TIMEOUT_MS = 12000;

export interface GhostRequestRecord {
  version: number;
  cursor: number;
  sentAt: number;
}

class GhostRunner {
  timers = new Map<string, ReturnType<typeof setTimeout>>();
  noteTimer: ReturnType<typeof setTimeout> | null = null;
  requests = new Map<string, GhostRequestRecord>();
  lastAnnounced = '';
  destroyed = false;

  constructor(readonly view: EditorView) {}

  update(u: ViewUpdate): void {
    for (const tr of u.transactions) {
      const before = tr.startState.field(ghostField, false);
      const after = tr.state.field(ghostField, false);
      if (!after || after === before || after.effects.length === 0 || (before && before.effects === after.effects)) continue;
      this.run(after.effects);
    }
    const g = u.state.field(ghostField);
    // Safety net: a composition that ended without a compositionend event.
    if (g.machine.composing && !u.view.composing && !u.view.compositionStarted) {
      queueMicrotask(() => {
        if (this.destroyed || !this.view.state.field(ghostField).machine.composing || this.view.composing) return;
        this.view.dispatch({ effects: ghostEvent.of({ type: 'compositionend', pos: this.view.state.selection.main.head, composed: '' }) });
      });
    }
    if (g.note !== u.startState.field(ghostField).note) {
      if (this.noteTimer) clearTimeout(this.noteTimer);
      this.noteTimer = g.note
        ? setTimeout(() => {
            this.noteTimer = null;
            if (!this.destroyed && this.view.state.field(ghostField).note) this.view.dispatch({ effects: ghostNoteEffect.of(null) });
          }, 2600)
        : null;
    }
    const vis = visibleGhost(u.state);
    const env = u.state.facet(editorEnv);
    if (vis && env && vis.text !== this.lastAnnounced && !this.lastAnnounced) env.ops.announce(`Suggestion: ${vis.text.trim()} Press Tab to accept, Escape to dismiss.`);
    this.lastAnnounced = vis ? vis.text : '';
  }

  run(effects: readonly GhostEffect[]): void {
    const network: GhostEffect[] = [];
    for (const eff of effects) {
      switch (eff.type) {
        case 'startTimer': {
          const old = this.timers.get(eff.timerId);
          if (old) clearTimeout(old);
          this.timers.set(
            eff.timerId,
            setTimeout(() => {
              this.timers.delete(eff.timerId);
              if (!this.destroyed) this.view.dispatch({ effects: ghostEvent.of({ type: 'timer', timerId: eff.timerId }) });
            }, eff.delayMs),
          );
          break;
        }
        case 'clearTimer': {
          const t = this.timers.get(eff.timerId);
          if (t) clearTimeout(t);
          this.timers.delete(eff.timerId);
          break;
        }
        case 'render':
          break;
        default:
          network.push(eff);
      }
    }
    // Deferred so the document sync (an update listener, which runs after plugins) has sent the
    // doc.change of this transaction first, and so inserts never dispatch inside an update.
    if (network.length) queueMicrotask(() => this.runDeferred(network));
  }

  runDeferred(effects: GhostEffect[]): void {
    if (this.destroyed) return;
    const view = this.view;
    const env = view.state.facet(editorEnv);
    if (!env) return;
    for (const eff of effects) {
      if (eff.type === 'request') {
        const state = view.state;
        const pos = Math.min(eff.pos, state.doc.length);
        const units = state.field(unitsField).units;
        const prefix = sentencePrefixIn((a, b) => state.doc.sliceString(a, b), units, pos);
        const version = env.version();
        this.requests.set(eff.requestId, { version, cursor: pos, sentAt: Date.now() });
        if (this.requests.size > 16) this.requests.delete(this.requests.keys().next().value!);
        env.api.send({ type: 'ghost.request', requestId: eff.requestId, file: env.file, version, cursor: pos, trigger: eff.trigger, prefix });
        this.watchRequest(eff.requestId);
      } else if (eff.type === 'cancel') {
        env.api.send({ type: 'ghost.cancel', requestId: eff.requestId });
      } else if (eff.type === 'feedback') {
        env.api.send({ type: 'ghost.feedback', requestId: eff.requestId, outcome: eff.outcome, acceptedText: eff.acceptedText });
      } else if (eff.type === 'insert') {
        this.insert(eff);
      }
    }
  }

  /** A request that never gets an answer (lost while reconnecting, server busy) must not stay pending forever. */
  watchRequest(requestId: string): void {
    setTimeout(() => {
      if (this.destroyed) return;
      const s = this.view.state.field(ghostField).machine.state;
      if (s.kind !== 'pending' || s.requestId !== requestId) return;
      this.view.dispatch({
        effects: [ghostEvent.of({ type: 'error', requestId }), ghostNoteEffect.of({ pos: s.pos, text: edText(currentLang(), 'ghostTimeout'), kind: 'error' })],
      });
    }, GHOST_TIMEOUT_MS);
  }

  insert(eff: Extract<GhostEffect, { type: 'insert' }>): void {
    const spec = ghostInsertSpec(this.view.state, eff);
    if (spec) this.view.dispatch(spec);
  }

  destroy(): void {
    this.destroyed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.noteTimer) clearTimeout(this.noteTimer);
  }
}

export const ghostRunner = ViewPlugin.fromClass(GhostRunner, {
  eventHandlers: {
    compositionstart(this: GhostRunner) {
      this.view.dispatch({ effects: ghostEvent.of({ type: 'compositionstart' }) });
    },
    compositionend(this: GhostRunner, e: CompositionEvent) {
      const composed = e.data ?? '';
      // CodeMirror applies the final composed text right around this event; read the cursor after it.
      setTimeout(() => {
        if (this.destroyed || !this.view.state.field(ghostField).machine.composing) return;
        this.view.dispatch({ effects: ghostEvent.of({ type: 'compositionend', pos: this.view.state.selection.main.head, composed }) });
      }, 0);
    },
    blur(this: GhostRunner) {
      const s = this.view.state.field(ghostField).machine.state;
      if (s.kind !== 'idle') this.view.dispatch({ effects: ghostEvent.of({ type: 'dismiss' }) });
    },
  },
});

/* ------------------------------------------------------------------------------------ */
/* Server replies                                                                        */
/* ------------------------------------------------------------------------------------ */

function runnerOf(view: EditorView): GhostRunner | null {
  return view.plugin(ghostRunner);
}

export function handleGhostMessage(view: EditorView, msg: ServerMessage, localVersion: number): void {
  if (msg.type !== 'ghost.result' && msg.type !== 'ghost.empty' && msg.type !== 'ghost.error') return;
  const s = view.state.field(ghostField).machine.state;
  if (s.kind !== 'pending' || s.requestId !== msg.requestId) return; // stale: the machine moved on
  const rec = runnerOf(view)?.requests.get(msg.requestId);
  if (msg.type === 'ghost.result') {
    const fresh = msg.version === localVersion && (rec ? rec.cursor === s.pos : true) && msg.cursor === s.pos;
    if (!fresh || !msg.text) {
      view.dispatch({ effects: ghostEvent.of({ type: 'empty', requestId: msg.requestId }) });
      return;
    }
    noteGhostShown(msg.text);
    view.dispatch({
      effects: [
        ghostMetaEffect.of({ requestId: msg.requestId, model: msg.model, promptHash: msg.promptHash, factIds: msg.factIds, citeKeys: msg.citeKeys, issues: msg.issues }),
        ghostEvent.of({ type: 'result', requestId: msg.requestId, text: msg.text, factIds: msg.factIds, citeKeys: msg.citeKeys }),
        // the gray text wraps below the cursor line: keep a few lines of it in view
        EditorView.scrollIntoView(s.pos, { y: 'nearest', yMargin: 96 }),
      ],
    });
  } else if (msg.type === 'ghost.empty') {
    view.dispatch({
      effects: [ghostEvent.of({ type: 'empty', requestId: msg.requestId }), ghostNoteEffect.of({ pos: s.pos, text: edText(currentLang(), 'noGrounded'), kind: 'empty' })],
    });
  } else {
    view.dispatch({
      effects: [ghostEvent.of({ type: 'error', requestId: msg.requestId }), ghostNoteEffect.of({ pos: s.pos, text: edText(currentLang(), 'ghostUnavailable', { message: msg.message }), kind: 'error' })],
    });
  }
}

export function ghostExtension(): Extension {
  return [ghostField, ghostRunner, ghostDecorations];
}
