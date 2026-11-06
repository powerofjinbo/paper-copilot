/** Words for states and origins (colour is never the only signal). */
import type { SentenceState, VersionOrigin } from '@paper-copilot/core';

export const STATE_LABEL: Record<SentenceState, string> = {
  human: 'Written by you',
  'ai-from-intent': 'AI, from your note',
  'ai-drafted': 'AI drafted, accepted',
  'ai-edited': 'AI drafted, edited by you',
  proposed: 'Proposed, not yet reviewed',
  external: 'Changed outside the app',
  placeholder: 'Placeholder',
  unsupported: 'Unsupported: failed the fact gate',
};

/** Very short labels for the heatmap legend. */
export const STATE_SHORT: Record<SentenceState, string> = {
  human: 'yours',
  'ai-from-intent': 'from note',
  'ai-drafted': 'AI accepted',
  'ai-edited': 'AI, edited',
  proposed: 'proposed',
  external: 'external',
  placeholder: 'placeholder',
  unsupported: 'unsupported',
};

export const ORIGIN_LABEL: Record<VersionOrigin, string> = {
  import: 'Imported',
  human_typed: 'Typed by you',
  human_edit: 'Edited by you',
  ai_ghost: 'Ghost text accepted',
  ai_intent: 'Rendered from your note',
  ai_draft: 'AI draft',
  ai_rewrite: 'AI rewrite',
  grammar_fix: 'Grammar fix',
  replan: 'Re-plan revision',
  external_edit: 'Changed outside the app',
};

export const STATE_ORDER: readonly SentenceState[] = [
  'human',
  'ai-from-intent',
  'ai-drafted',
  'ai-edited',
  'proposed',
  'unsupported',
  'external',
  'placeholder',
];

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.round((now - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 90) return '1 min ago';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

export function isCjk(text: string): boolean {
  return /[　-〿぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/.test(text);
}
