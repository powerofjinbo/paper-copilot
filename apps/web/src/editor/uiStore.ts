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
}

export const useEditorUi = create<EditorUiState>((set) => ({
  heatmap: false,
  setHeatmap: (heatmap) => set({ heatmap }),
  toggleHeatmap: () => set((s) => ({ heatmap: !s.heatmap })),
}));
