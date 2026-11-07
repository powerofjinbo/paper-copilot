/**
 * Bridge between the editor state and the workspace store: facts, lint and outline flow in; units (in
 * current coordinates, document order) and the active sentence id flow out.
 */
import type { Extension } from '@codemirror/state';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import type { SentenceUnit } from '@paper-copilot/core';
import { useWorkspace } from '../state/store';
import { setCtxEffect, type CtxInput } from './context';
import { editorEnv } from './env';
import { setUnitsEffect, patchUnitsEffect, unitAtPos, unitsField } from './units';

const LOCAL_PUBLISH_MS = 150;

class StoreBridge {
  unsub: () => void;
  timer: ReturnType<typeof setTimeout> | null = null;
  lastActive: string | null | undefined = undefined;
  destroyed = false;

  /** A parked editor (its file is not the one shown) must not overwrite the shown file's units. */
  private shown(): boolean {
    const f = useWorkspace.getState().file;
    return f === null || f === this.view.state.facet(editorEnv)?.file;
  }

  constructor(readonly view: EditorView) {
    const s = useWorkspace.getState();
    queueMicrotask(() => {
      if (!this.destroyed) view.dispatch({ effects: setCtxEffect.of({ facts: s.facts, lint: s.lint, outline: s.outline, unresolved: s.unresolved }) });
    });
    this.unsub = useWorkspace.subscribe((st, prev) => {
      const c: CtxInput = {};
      if (st.facts !== prev.facts) c.facts = st.facts;
      if (st.lint !== prev.lint) c.lint = st.lint;
      if (st.outline !== prev.outline) c.outline = st.outline;
      if (st.unresolved !== prev.unresolved) c.unresolved = st.unresolved;
      if (Object.keys(c).length === 0) return;
      // never dispatch from inside another update (the store may change during a CodeMirror update)
      queueMicrotask(() => {
        if (!this.destroyed) this.view.dispatch({ effects: setCtxEffect.of(c) });
      });
    });
  }

  update(u: ViewUpdate): void {
    const before = u.startState.field(unitsField);
    const after = u.state.field(unitsField);
    if (before !== after) {
      const fromServer = u.transactions.some((tr) => tr.effects.some((e) => e.is(setUnitsEffect) || e.is(patchUnitsEffect)));
      if (fromServer) this.publishNow();
      else if (!this.timer) this.timer = setTimeout(() => this.publishNow(), LOCAL_PUBLISH_MS);
    }
    if (before !== after || u.selectionSet) {
      const active = unitAtPos(after.units, u.state.selection.main.head)?.id ?? null;
      if (active !== this.lastActive) {
        this.lastActive = active;
        queueMicrotask(() => {
          if (!this.destroyed && this.shown()) useWorkspace.getState().setActiveSentence(active);
        });
      }
    }
  }

  publishNow(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.destroyed) return;
    const units = this.view.state.field(unitsField).units as SentenceUnit[];
    queueMicrotask(() => {
      if (!this.destroyed && this.shown()) useWorkspace.getState().setUnits(units);
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.unsub();
    if (this.timer) clearTimeout(this.timer);
  }
}

export function storeBridge(): Extension {
  return ViewPlugin.fromClass(StoreBridge);
}

/** Publish the view's units and active sentence now (a parked editor shown again). */
export function publishUnits(view: EditorView): void {
  const units = view.state.field(unitsField).units as SentenceUnit[];
  const active = unitAtPos(units, view.state.selection.main.head)?.id ?? null;
  queueMicrotask(() => {
    useWorkspace.getState().setUnits(units);
    useWorkspace.getState().setActiveSentence(active);
  });
}
