/**
 * Compile errors of the open file as line decorations (`pc-compile-error`, with the message as a title), so
 * the failing line is marked in the text, not only listed in the compile bar. The lines come from the
 * workspace store (compile.status); they are mapped through later edits until the next compile.
 */
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { useWorkspace } from '../state/store';
import { editorEnv } from './env';

const setCompileErrors = StateEffect.define<Array<{ line: number; message: string }>>();

const field = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setCompileErrors)) continue;
      const doc = tr.state.doc;
      const seen = new Set<number>();
      const ranges = [];
      for (const { line, message } of [...e.value].sort((a, b) => a.line - b.line)) {
        if (line < 1 || line > doc.lines || seen.has(line)) continue;
        seen.add(line);
        ranges.push(Decoration.line({ class: 'pc-compile-error', attributes: { title: message } }).range(doc.line(line).from));
      }
      deco = Decoration.set(ranges);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Same file? The log may name it "./main.tex" or with backslashes. */
function sameFile(a: string, b: string): boolean {
  const n = (s: string) => s.replace(/\\/g, '/').replace(/^\.\//, '');
  return n(a) === n(b) || n(a).endsWith(`/${n(b)}`);
}

const bridge = ViewPlugin.define((view) => {
  let destroyed = false;
  const push = () => {
    const file = view.state.facet(editorEnv)?.file;
    const c = useWorkspace.getState().compile;
    const lines = file && c.state !== 'running' ? c.errors.filter((e) => e.line !== null && sameFile(e.file, file)).map((e) => ({ line: e.line!, message: e.message })) : [];
    queueMicrotask(() => {
      if (!destroyed) view.dispatch({ effects: setCompileErrors.of(lines) });
    });
  };
  push();
  const unsub = useWorkspace.subscribe((s, prev) => {
    if (s.compile !== prev.compile) push();
  });
  return {
    update(u: ViewUpdate) {
      // the first snapshot filled the empty document: the error lines exist now
      if (u.docChanged && u.startState.doc.length === 0) push();
    },
    destroy() {
      destroyed = true;
      unsub();
    },
  };
});

export function compileErrorLines(): Extension {
  return [field, bridge];
}
