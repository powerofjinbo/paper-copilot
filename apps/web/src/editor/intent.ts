/**
 * Intent lines: lines that are mostly CJK hold the author's own thoughts (often Chinese). They are tinted
 * teal; Ctrl/Cmd+Enter renders one into an English sentence (a block widget under the line), Alt+Enter asks
 * for three alternatives; accepting replaces the line's text in ONE transaction that carries
 * {origin: 'ai_intent', state: 'ai-from-intent', intentNote}.
 */
import { EditorSelection, StateEffect, StateField, type EditorState, type Extension, type TransactionSpec } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import type { Proposal } from '@paper-copilot/core';
import { changeAnnotation, makeAnnotation } from './annotations';
import { ctxField } from './context';
import { MOD_KEY } from './labels';
import { intentLinesOf, placeholdersOf, type IntentLine } from './safe';

/* ------------------------------------------------------------------------------------ */
/* Detection                                                                             */
/* ------------------------------------------------------------------------------------ */

const HAS_CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]/;

export const intentLinesField = StateField.define<readonly IntentLine[]>({
  create: (state) => intentLinesOf(state.doc.toString()),
  update(v, tr) {
    return tr.docChanged ? intentLinesOf(tr.state.doc.toString()) : v;
  },
});

/** Locally detected intent lines plus server-reported ones that still contain CJK (deduplicated by line). */
export function allIntentLines(state: EditorState): IntentLine[] {
  const local = state.field(intentLinesField);
  const server = state.field(ctxField).serverIntentLines;
  if (server.length === 0) return local as IntentLine[];
  const byLine = new Map<number, IntentLine>();
  for (const l of local) byLine.set(l.line, l);
  for (const s of server) {
    if (byLine.has(s.line) || s.line > state.doc.lines) continue;
    const line = state.doc.line(s.line);
    if (!HAS_CJK.test(line.text)) continue;
    byLine.set(s.line, { start: line.from, end: line.to, line: s.line, text: line.text });
  }
  return [...byLine.values()].sort((a, b) => a.start - b.start);
}

export function intentLineAt(state: EditorState, pos: number): IntentLine | null {
  const lineNo = state.doc.lineAt(pos).number;
  return allIntentLines(state).find((l) => l.line === lineNo) ?? null;
}

/** The trimmed content range of an intent line (keeps indentation and trailing spaces). */
export function intentContentRange(state: EditorState, l: IntentLine): { from: number; to: number; note: string } {
  const line = state.doc.lineAt(l.start);
  const text = line.text;
  const lead = text.length - text.trimStart().length;
  const trail = text.length - text.trimEnd().length;
  const from = line.from + lead;
  const to = Math.max(from, line.to - trail);
  return { from, to, note: state.doc.sliceString(from, to) };
}

/* ------------------------------------------------------------------------------------ */
/* Render state                                                                          */
/* ------------------------------------------------------------------------------------ */

export interface IntentRender {
  from: number;
  to: number;
  line: number;
  note: string;
  status: 'loading' | 'ready' | 'error';
  proposals: readonly Proposal[];
  selected: number;
  n: number;
  error: string | null;
  /** Increments per request so late answers for an older request are dropped. */
  req: number;
}

export const intentRenderEffect = StateEffect.define<IntentRender | null>();

export const intentRenderField = StateField.define<IntentRender | null>({
  create: () => null,
  update(v, tr) {
    let next = v;
    if (next && tr.docChanged) {
      // Any edit of the note itself makes the rendering stale.
      let touched = false;
      tr.changes.iterChangedRanges((fromA, toA) => {
        if (fromA <= next!.to && toA >= next!.from) touched = true;
      });
      if (touched) next = null;
      else next = { ...next, from: tr.changes.mapPos(next.from, 1), to: tr.changes.mapPos(next.to, -1) };
    }
    for (const e of tr.effects) if (e.is(intentRenderEffect)) next = e.value;
    return next;
  },
});

/** The single transaction that replaces an intent line with its English rendering. */
export function intentAcceptSpec(r: IntentRender, p: Proposal): TransactionSpec {
  return {
    changes: { from: r.from, to: r.to, insert: p.text },
    selection: EditorSelection.cursor(r.from + p.text.length),
    annotations: [
      changeAnnotation.of(
        makeAnnotation({
          origin: 'ai_intent',
          state: 'ai-from-intent',
          intentNote: r.note,
          sentenceIds: [],
          model: p.model,
          promptHash: p.promptHash,
          factIds: p.factIds,
          citeKeys: p.citeKeys,
          lang: 'zh',
        }),
      ),
    ],
    effects: intentRenderEffect.of(null),
    userEvent: 'input.ai.intent',
    scrollIntoView: true,
  };
}

/* ------------------------------------------------------------------------------------ */
/* Decorations                                                                           */
/* ------------------------------------------------------------------------------------ */

const intentLineDeco = Decoration.line({
  class: 'pc-intent-line',
  attributes: { title: `Intent note: excluded from compile and lint. ${MOD_KEY}+Enter renders it into an English sentence.` },
});

class IntentHintWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  override toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'pc-intent-hint';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = `${MOD_KEY}+Enter → English · Alt+Enter → 3 options`;
    return span;
  }
}

/** Renders text with placeholder chips (shared by the ghost widget and the intent widget). */
export function appendWithPlaceholders(parent: HTMLElement, text: string): void {
  const spans = placeholdersOf(text);
  let pos = 0;
  for (const s of spans) {
    if (s.start > pos) parent.appendChild(document.createTextNode(text.slice(pos, s.start)));
    const chip = document.createElement('span');
    chip.className = `pc-ph pc-ph-${s.kind}`;
    chip.textContent = s.text;
    chip.title = 'Placeholder: the AI found no grounded value';
    parent.appendChild(chip);
    pos = s.end;
  }
  if (pos < text.length) parent.appendChild(document.createTextNode(text.slice(pos)));
}

export interface IntentWidgetActions {
  accept(view: EditorView, index: number): void;
  alternatives(view: EditorView): void;
  discard(view: EditorView): void;
}

class IntentRenderWidget extends WidgetType {
  constructor(
    readonly r: IntentRender,
    readonly actions: IntentWidgetActions,
  ) {
    super();
  }
  override eq(other: IntentRenderWidget): boolean {
    return (
      other.r.status === this.r.status &&
      other.r.selected === this.r.selected &&
      other.r.req === this.r.req &&
      other.r.proposals.length === this.r.proposals.length &&
      other.r.proposals.every((p, i) => p.proposalId === this.r.proposals[i]!.proposalId)
    );
  }
  override get estimatedHeight(): number {
    return 40 + 26 * Math.max(1, this.r.proposals.length);
  }
  override toDOM(view: EditorView): HTMLElement {
    const r = this.r;
    const box = document.createElement('div');
    box.className = 'pc-intent-render';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'English rendering of your note');
    const head = document.createElement('div');
    head.className = 'pc-ir-head';
    head.textContent = r.n > 1 ? 'English, in your voice: choose one' : 'English, in your voice';
    box.appendChild(head);
    if (r.status === 'loading') {
      const l = document.createElement('div');
      l.className = 'pc-ir-loading';
      l.innerHTML = '<span class="pc-pulse" aria-hidden="true"></span>';
      l.appendChild(document.createTextNode(r.n > 1 ? ' Rendering three options…' : ' Rendering your note…'));
      l.setAttribute('role', 'status');
      box.appendChild(l);
    } else if (r.status === 'error') {
      const l = document.createElement('div');
      l.className = 'pc-ir-error';
      l.setAttribute('role', 'alert');
      l.textContent = r.error ?? 'Rendering failed.';
      box.appendChild(l);
    } else {
      const list = document.createElement('div');
      list.className = 'pc-ir-options';
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-label', 'Proposed sentences');
      r.proposals.forEach((p, i) => {
        const opt = document.createElement('div');
        opt.className = 'pc-ir-option' + (i === r.selected ? ' pc-selected' : '');
        opt.setAttribute('role', 'option');
        opt.setAttribute('aria-selected', String(i === r.selected));
        if (r.proposals.length > 1) {
          const num = document.createElement('span');
          num.className = 'pc-ir-num';
          num.textContent = String(i + 1);
          opt.appendChild(num);
        }
        const t = document.createElement('span');
        t.className = 'pc-ir-text';
        appendWithPlaceholders(t, p.text);
        opt.appendChild(t);
        const issues = p.issues.filter((x) => x.severity === 'block' || x.severity === 'warn');
        if (issues.length) {
          const iss = document.createElement('div');
          iss.className = 'pc-ir-issues';
          iss.textContent = issues.map((x) => `${x.severity === 'block' ? '⚠' : '·'} ${x.message}`).join('  ');
          opt.appendChild(iss);
        }
        opt.addEventListener('mousedown', (e) => {
          e.preventDefault();
          this.actions.accept(view, i);
        });
        list.appendChild(opt);
      });
      box.appendChild(list);
      const note = r.proposals[r.selected]?.notes;
      if (note) {
        const n = document.createElement('div');
        n.className = 'pc-ir-note';
        n.lang = 'zh';
        n.textContent = note;
        box.appendChild(n);
      }
    }
    const keys = document.createElement('div');
    keys.className = 'pc-ir-keys';
    const mk = (label: string, key: string, fn: () => void, disabled = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pc-btn pc-btn-small';
      b.disabled = disabled;
      b.innerHTML = `${label} <kbd>${key}</kbd>`;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => {
        e.preventDefault();
        fn();
      });
      keys.appendChild(b);
    };
    mk('Accept', r.proposals.length > 1 ? `Tab · 1–${r.proposals.length}` : 'Tab', () => this.actions.accept(view, r.selected), r.status !== 'ready');
    mk('3 options', 'Alt+Enter', () => this.actions.alternatives(view), r.status === 'loading');
    mk('Discard', 'Esc', () => this.actions.discard(view));
    box.appendChild(keys);
    return box;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

export function intentDecorations(actions: IntentWidgetActions): Extension {
  const lines = EditorView.decorations.compute([intentLinesField, ctxField, 'selection', intentRenderField], (state) => {
    const ranges = [];
    const head = state.selection.main.head;
    const activeLine = state.doc.lineAt(head).number;
    const render = state.field(intentRenderField);
    for (const l of allIntentLines(state)) {
      const line = state.doc.line(Math.min(l.line, state.doc.lines));
      ranges.push(intentLineDeco.range(line.from));
      if (l.line === activeLine && !render && state.selection.main.empty) ranges.push(Decoration.widget({ widget: new IntentHintWidget(), side: 1 }).range(line.to));
    }
    return Decoration.set(ranges, true);
  });
  const widget = EditorView.decorations.compute([intentRenderField], (state): DecorationSet => {
    const r = state.field(intentRenderField);
    if (!r || r.to > state.doc.length) return Decoration.none;
    const at = state.doc.lineAt(r.to).to;
    return Decoration.set([Decoration.widget({ widget: new IntentRenderWidget(r, actions), block: true, side: 1 }).range(at)]);
  });
  return [intentLinesField, intentRenderField, lines, widget];
}
