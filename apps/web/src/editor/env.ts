/**
 * The editor environment, provided to extensions through a facet: the API client, the open file, the
 * current document version, and the controller operations keymaps, widgets and the card call.
 */
import { Facet } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { Proposal, SentenceState } from '@paper-copilot/core';
import type { ApiClient } from '../contracts';

export type CardView = 'main' | 'instruct' | 'grammar' | 'alternatives' | 'history' | 'replan';

export interface EditorOps {
  /** Open the sentence card for a unit (pinned cards stay until Esc or the cursor leaves). */
  openCard(view: EditorView, id: string, opts?: { pinned?: boolean; focus?: boolean; view?: CardView }): void;
  closeCard(view: EditorView, opts?: { focusEditor?: boolean }): void;
  /** Alt+Down / Alt+Up. Returns true if it moved. */
  reviewStep(view: EditorView, dir: 1 | -1): boolean;
  /** Ctrl/Cmd+Enter on a proposed/unsupported unit. */
  acceptUnit(view: EditorView, id: string): Promise<void>;
  rejectUnit(view: EditorView, id: string): Promise<void>;
  rewriteMyself(view: EditorView, id: string): void;
  applyProposal(view: EditorView, p: Proposal, opts?: { state?: SentenceState; instruction?: string | null; lang?: string | null }): boolean;
  /** Intent line rendering (n = 1 or 3). */
  renderIntent(view: EditorView, n: number): boolean;
  /** Toggle the ownership heatmap. */
  toggleHeatmap(): void;
  /** Ask the server to persist now (Ctrl/Cmd+S). */
  flush(): void;
  announce(message: string): void;
}

export interface EditorEnv {
  api: ApiClient;
  file: string;
  /** Version of the current local text (baseVersion of the next change). */
  version(): number;
  ops: EditorOps;
}

export const editorEnv = Facet.define<EditorEnv, EditorEnv | null>({
  combine: (values) => values[0] ?? null,
});
