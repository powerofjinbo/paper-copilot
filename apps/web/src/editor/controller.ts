/**
 * EditorController: builds the CodeMirror view with every paper-copilot extension, wires the document
 * sync and server messages, and implements the EditorHandle (contracts.ts) and the internal EditorOps.
 */
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, tooltips } from '@codemirror/view';
import type { ChangeAnnotation, Proposal, SentenceState } from '@paper-copilot/core';
import type { ApiClient, EditorHandle, ServerMessageOf } from '../contracts';
import { useWorkspace } from '../state/store';
import { draftInsertionPoint, draftSentenceSpecs, proposalSpec, rejectSpec, replaceUnitSpec } from './actions';
import { cardField, closeCardEffect, openCardEffect } from './card/cardState';
import { cardTooltip, chooseCardSide } from './card/cardTooltip';
import { hoverCards } from './card/hover';
import { ctxField, draftNotesEffect, draftNotesField, replanEffect, replanField, type DraftNote } from './context';
import { sentenceDecorations } from './decorations';
import { editorEnv, type EditorEnv, type EditorOps } from './env';
import { ghostNoteEffect } from './ghost/ghostField';
import { currentLang, edText } from './i18n';
import { ghostExtension, handleGhostMessage } from './ghost/ghostPlugin';
import { paperGutters } from './gutters';
import { acceptIntent } from './keymap';
import { intentContentRange, intentDecorations, intentLineAt, intentRenderEffect, intentRenderField, type IntentWidgetActions } from './intent';
import { paperKeymap } from './keymap';
import { STATE_LABEL } from './labels';
import { rewritableLength, rewriteEffect, rewriteExtension } from './rewrite';
import { factLabel, nextInQueueOf, reviewQueueOf } from './safe';
import { storeBridge } from './storeBridge';
import { DocSync } from './sync/docSync';
import { paperTheme, texHighlight } from './theme';
import { useEditorUi } from './uiStore';
import { unitAtPos, unitsField, updateUnitMetaEffect } from './units';

export interface ControllerOptions {
  parent: HTMLElement;
  api: ApiClient;
  file: string;
  announce(message: string): void;
  onStatus(status: 'loading' | 'ready'): void;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class EditorController {
  readonly view: EditorView;
  readonly sync: DocSync;
  /** The selection the last review step made (Alt+Down/Up), to tell an extra press from a "move line". */
  private lastReviewSel: { from: number; to: number } | null = null;
  readonly handle: EditorHandle;
  readonly ops: EditorOps;
  private readonly editable = new Compartment();
  private offs: Array<() => void> = [];
  private intentReq = 0;
  private destroyed = false;

  constructor(private readonly opts: ControllerOptions) {
    const { api, file } = opts;
    this.ops = this.makeOps();
    // The editor's messages that refer to the local text (ghost.request: version + cursor) go out after the
    // document changes made before them (DocSync sends one change at a time).
    const orderedApi = new Proxy(api, {
      get: (target, prop) => {
        if (prop === 'send') return (m: Parameters<ApiClient['send']>[0]) => (this.sync ? this.sync.sendOrdered(m) : target.send(m));
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const env: EditorEnv = { api: orderedApi, file, version: () => this.sync.core.localVersion, ops: this.ops };
    this.sync = new DocSync(api, file, {
      view: () => (this.destroyed ? null : this.view),
      loaded: () => {
        this.view.dispatch({ effects: this.editable.reconfigure(EditorView.editable.of(true)) });
        opts.onStatus('ready');
      },
      notice: (level, message) => useWorkspace.getState().pushNotice(level, message),
    });
    const intentActions: IntentWidgetActions = {
      accept: (view, i) => {
        acceptIntent(view, i);
        view.focus();
      },
      alternatives: (view) => {
        this.ops.renderIntent(view, 3);
        view.focus();
      },
      discard: (view) => {
        view.dispatch({ effects: intentRenderEffect.of(null) });
        view.focus();
      },
    };
    this.view = new EditorView({
      parent: opts.parent,
      state: EditorState.create({
        doc: '',
        extensions: [
          editorEnv.of(env),
          EditorState.lineSeparator.of('\n'),
          this.editable.of(EditorView.editable.of(false)),
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          bracketMatching(),
          EditorView.lineWrapping,
          StreamLanguage.define(stex),
          syntaxHighlighting(texHighlight),
          search({ top: true }),
          paperKeymap(),
          keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
          unitsField,
          ctxField,
          replanField,
          draftNotesField,
          intentDecorations(intentActions),
          sentenceDecorations(),
          ghostExtension(),
          rewriteExtension(),
          cardTooltip(),
          hoverCards(),
          paperGutters(),
          storeBridge(),
          tooltips({ position: 'fixed' }),
          paperTheme,
          EditorView.contentAttributes.of({
            'aria-label': `LaTeX source of ${file}. Alt+Down: next sentence to review. Ctrl+period: sentence card.`,
            spellcheck: 'false',
            autocorrect: 'off',
            autocapitalize: 'off',
            lang: 'en',
          }),
          EditorView.updateListener.of((u) => this.sync.onUpdate(u)),
        ],
      }),
    });
    this.handle = this.makeHandle();
    this.offs.push(
      api.on('ghost.result', (m) => this.ghostMessage(m)),
      api.on('ghost.empty', (m) => this.ghostMessage(m)),
      api.on('ghost.error', (m) => this.ghostMessage(m)),
      api.on('replan.proposed', (m) => {
        if (m.file === file && !this.destroyed) this.view.dispatch({ effects: replanEffect.of({ items: m.items }) });
      }),
    );
    this.sync.start();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.sync.stop();
    for (const off of this.offs) off();
    this.offs = [];
    this.view.destroy();
  }

  private ghostMessage(m: ServerMessageOf<'ghost.result'> | ServerMessageOf<'ghost.empty'> | ServerMessageOf<'ghost.error'>): void {
    if (this.destroyed) return;
    handleGhostMessage(this.view, m, this.sync.core.localVersion);
  }

  /* ------------------------------------------------------------------------------ ops */

  private makeOps(): EditorOps {
    const ops: EditorOps = {
      openCard: (view, id, o = {}) => {
        const u = view.state.field(unitsField).byId.get(id);
        if (!u) return;
        const above = chooseCardSide(view, u.start, u.end);
        view.dispatch({ effects: openCardEffect.of({ id, pinned: o.pinned ?? true, focus: o.focus ?? false, above, view: o.view ?? 'main' }) });
      },
      closeCard: (view, o) => {
        if (view.state.field(cardField)) view.dispatch({ effects: closeCardEffect.of(null) });
        if (o?.focusEditor) view.focus();
      },
      reviewStep: (view, dir) => {
        const state = view.state;
        const units = state.field(unitsField).units;
        const sel = state.selection.main;
        const target = nextInQueueOf(units, dir === 1 ? sel.to : sel.from, dir);
        if (!target) {
          // Right after a review step (the selection is still the sentence it selected) the key is
          // consumed with a note: an impatient extra press must not move a sentence. Otherwise it falls
          // through to the standard Alt+Up/Down "move line" (reordering sentences).
          const last = this.lastReviewSel;
          if (!last || last.from !== sel.from || last.to !== sel.to) return false;
          view.dispatch({ effects: ghostNoteEffect.of({ pos: sel.head, text: edText(currentLang(), 'noReview'), kind: 'info' }) });
          ops.announce(edText(currentLang(), 'noReview'));
          return true;
        }
        this.lastReviewSel = { from: target.start, to: target.end };
        const focusCard = !!document.activeElement?.closest('.pc-card');
        view.dispatch({
          selection: EditorSelection.range(target.start, target.end),
          effects: [EditorView.scrollIntoView(target.start, { y: 'center' }), closeCardEffect.of(null)],
        });
        if (!focusCard) view.focus();
        const queue = reviewQueueOf(units);
        const index = queue.findIndex((u) => u.id === target.id);
        ops.announce(`Review ${index + 1} of ${queue.length}: ${STATE_LABEL[target.state]}.`);
        // open the card once the scroll has been applied, so the side with more room is chosen
        requestAnimationFrame(() => {
          if (!this.destroyed) ops.openCard(view, target.id, { pinned: true, focus: focusCard });
        });
        return true;
      },
      acceptUnit: async (view, id) => {
        try {
          const unit = await this.opts.api.accept(id);
          if (!this.destroyed) view.dispatch({ effects: updateUnitMetaEffect.of(unit) });
          ops.announce('Sentence accepted.');
        } catch (err) {
          useWorkspace.getState().pushNotice('error', `Accept failed: ${errText(err)}`);
        }
      },
      rejectUnit: async (view, id) => {
        try {
          const { replacement } = await this.opts.api.reject(id);
          if (this.destroyed) return;
          const spec = rejectSpec(view.state, id, replacement);
          if (spec) view.dispatch(spec);
          ops.announce('Sentence rejected; its claim is kept as a placeholder.');
        } catch (err) {
          useWorkspace.getState().pushNotice('error', `Reject failed: ${errText(err)}`);
        }
      },
      rewriteMyself: (view, id) => {
        const state = view.state;
        const u = state.field(unitsField).byId.get(id);
        if (!u) return;
        const ctx = state.field(ctxField);
        const facts = u.facts.map((fid) => {
          const f = ctx.factsById.get(fid);
          return f ? factLabel(f) : fid;
        });
        // Select the words but keep the sentence end (".", "?\cite{x}"...). The rewrite extension then turns
        // the first keystroke into "type before the old words" (see rewrite.ts) so the unit keeps its id.
        const end = u.start + rewritableLength(state.doc.sliceString(u.start, u.end));
        view.dispatch({
          selection: EditorSelection.range(u.start, end),
          effects: [
            closeCardEffect.of(null),
            rewriteEffect.of({ id, phase: 'selected', armed: true, newFrom: u.start, oldFrom: u.start, oldTo: end, note: u.intentNote, facts }),
            EditorView.scrollIntoView(u.start, { y: 'nearest' }),
          ],
        });
        view.focus();
        ops.announce('Sentence selected. Type your own version; the old words stay struck through until you type the final period.');
      },
      applyProposal: (view, p, o) => {
        const spec = proposalSpec(view.state, p, o ?? {});
        if (!spec) return false;
        view.dispatch(spec);
        return true;
      },
      renderIntent: (view, n) => {
        const state = view.state;
        const open = state.field(intentRenderField);
        const line = open ? intentLineAt(state, open.from) : intentLineAt(state, state.selection.main.head);
        if (!line) return false;
        const range = intentContentRange(state, line);
        if (!range.note.trim()) return false;
        const req = ++this.intentReq;
        const lineNo = state.doc.lineAt(range.from).number;
        const base = { from: range.from, to: range.to, line: lineNo, note: range.note, n, selected: 0, req };
        // the options open as a block below the note line: keep them in view
        view.dispatch({ effects: [intentRenderEffect.of({ ...base, status: 'loading', proposals: [], error: null }), EditorView.scrollIntoView(range.to, { y: 'nearest', yMargin: 140 })] });
        this.opts.api
          .renderIntent(this.opts.file, lineNo, range.note, n)
          .then((proposals) => {
            const cur = this.destroyed ? null : view.state.field(intentRenderField);
            if (!cur || cur.req !== req) return;
            view.dispatch({
              effects: [
                intentRenderEffect.of({ ...cur, status: proposals.length ? 'ready' : 'error', proposals, error: proposals.length ? null : 'No grounded rendering came back.' }),
                EditorView.scrollIntoView(Math.min(cur.to, view.state.doc.length), { y: 'nearest', yMargin: 160 + 60 * Math.max(1, proposals.length) }),
              ],
            });
            if (proposals[0]) ops.announce(`Proposed: ${proposals[0].text}. Tab to accept.`);
          })
          .catch((err: unknown) => {
            const cur = this.destroyed ? null : view.state.field(intentRenderField);
            if (!cur || cur.req !== req) return;
            view.dispatch({ effects: intentRenderEffect.of({ ...cur, status: 'error', error: `Rendering failed: ${errText(err)}` }) });
          });
        return true;
      },
      toggleHeatmap: () => useEditorUi.getState().toggleHeatmap(),
      flush: () => {
        if (this.sync.core.initialized) this.sync.sendOrdered({ type: 'doc.flush', file: this.opts.file, version: this.sync.core.localVersion });
      },
      announce: (message) => this.opts.announce(message),
    };
    return ops;
  }

  /* ------------------------------------------------------------------------------ handle */

  private makeHandle(): EditorHandle {
    const view = this.view;
    const ops = this.ops;
    const handle: EditorHandle = {
      focus: () => view.focus(),
      revealSentence: (id, o) => {
        const u = view.state.field(unitsField).byId.get(id);
        if (!u) return;
        view.dispatch({ selection: EditorSelection.range(u.start, u.end), effects: EditorView.scrollIntoView(u.start, { y: 'center' }) });
        view.focus();
        if (o?.openCard)
          requestAnimationFrame(() => {
            if (!this.destroyed) ops.openCard(view, id, { pinned: true, focus: true });
          });
      },
      revealLine: (line) => {
        const n = Math.max(1, Math.min(view.state.doc.lines, Math.round(line)));
        const l = view.state.doc.line(n);
        view.dispatch({ selection: EditorSelection.cursor(l.from), effects: EditorView.scrollIntoView(l.from, { y: 'center' }) });
        view.focus();
      },
      applyProposal: (p: Proposal, o?: { state?: SentenceState }) => ops.applyProposal(view, p, o),
      insertDraft: (msg) => this.insertDraft(msg),
      replaceUnitText: (id: string, text: string, annotation: ChangeAnnotation) => {
        const spec = replaceUnitSpec(view.state, id, text, annotation);
        if (!spec) return false;
        view.dispatch(spec);
        return true;
      },
      getText: () => view.state.doc.toString(),
      activeSentenceId: () => unitAtPos(view.state.field(unitsField).units, view.state.selection.main.head)?.id ?? null,
      currentLine: () => view.state.doc.lineAt(view.state.selection.main.head).number,
    };
    // A handle kept by a panel after the editor was destroyed (file switch) must not touch the dead view.
    const guarded = {} as EditorHandle;
    for (const key of Object.keys(handle) as Array<keyof EditorHandle>) {
      const fn = handle[key] as (...args: unknown[]) => unknown;
      (guarded as unknown as Record<string, unknown>)[key] = (...args: unknown[]) => {
        if (!this.destroyed) return fn(...args);
        if (key === 'getText') return view.state.doc.toString();
        if (key === 'currentLine') return 1;
        return key === 'applyProposal' || key === 'replaceUnitText' ? false : null;
      };
    }
    return guarded;
  }

  private insertDraft(msg: ServerMessageOf<'draft.proposed'>): void {
    if (msg.file !== this.opts.file || this.destroyed) return;
    const view = this.view;
    const at = draftInsertionPoint(view.state, msg, (pos, version) => {
      const cs = this.sync.core.changesSince(version, view.state.doc.length);
      return cs && pos <= cs.length ? cs.mapPos(pos, 1) : null;
    });
    const notes: Array<[string, DraftNote]> = [];
    let count = 0;
    for (const p of msg.paragraphs)
      for (const s of p.sentences) {
        count++;
        notes.push([s.text, { noteZh: s.noteZh, refereeQuestion: s.refereeQuestion, issues: s.issues, move: s.move }]);
      }
    if (count === 0) return;
    view.dispatch({ effects: draftNotesEffect.of(notes) });
    for (const spec of draftSentenceSpecs(at, msg)) view.dispatch(spec);
    view.dispatch({ effects: EditorView.scrollIntoView(Math.min(at + 2, view.state.doc.length), { y: 'center' }) });
    this.ops.announce(`${count} drafted sentence${count === 1 ? '' : 's'} inserted as proposed. Alt+Down to review.`);
  }
}
