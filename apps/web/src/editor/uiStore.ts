/**
 * Editor-only UI flags, kept out of the shared workspace store (state/store.ts) so the editor can add
 * them without a contract change. The shell may import `useEditorUi` to show the toggle elsewhere.
 */
import { create } from 'zustand';

export interface EditorUiState {
  /** Ownership heatmap: tint sentence backgrounds by provenance state (pre-submission scan). */
  heatmap: boolean;
  setHeatmap(on: boolean): void;
  toggleHeatmap(): void;
  /** Whole source in a monospace font (default: prose in a text font). Remembered per browser. */
  mono: boolean;
  toggleMono(): void;
  /**
   * The full app shell shows the heatmap and font toggles in its Settings drawer: the editor bar then
   * leaves them out (the standalone editor harness keeps them).
   */
  togglesInShell: boolean;
}

const MONO_KEY = 'paper-copilot.editor.mono';
function loadMono(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(MONO_KEY) === '1';
  } catch {
    return false;
  }
}

export const useEditorUi = create<EditorUiState>((set, get) => ({
  heatmap: false,
  setHeatmap: (heatmap) => set({ heatmap }),
  toggleHeatmap: () => set((s) => ({ heatmap: !s.heatmap })),
  mono: loadMono(),
  togglesInShell: false,
  toggleMono: () => {
    const mono = !get().mono;
    set({ mono });
    try {
      localStorage.setItem(MONO_KEY, mono ? '1' : '0');
    } catch {
      /* private window: the choice lasts for this page */
    }
  },
}));
