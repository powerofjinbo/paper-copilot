/**
 * Ghost-text state machine (docs/design.md, Core loops, Ghost mode). Pure reducer: no timers, no DOM,
 * no network. The host (CodeMirror extension in apps/web, later a VS Code client) feeds events and
 * executes the returned effects (start/cancel timers, send requests, insert text, render).
 *
 * OWNER: client-core agent. Replace the `notImplemented` bodies; keep exported names and types.
 *
 * Rules:
 * - Never request per keystroke. Triggers: 'manual' (Ctrl+Space) in every mode except that
 *   'questions-only' never shows prose; 'boundary' (a sentence just ended: . ? ! outside abbreviations,
 *   then a space) fires after `boundaryDelayMs` only in 'auto-propose'; 'pause' fires after
 *   `pauseDelayMs` of no typing when the current sentence already has >= `minWordsForPause` English
 *   words, in 'auto-propose' and 'complete-my-sentence'.
 * - While an IME composition is active (Chinese input), never request, never render; a showing ghost is
 *   hidden and restored only if the composed text matches its next characters.
 * - Esc dismisses and suppresses automatic triggers until the next sentence boundary.
 * - Typing characters that match the ghost's next characters consumes them (the ghost shrinks); two
 *   mismatching keystrokes dismiss it; a single mismatch hides it until the next keystroke decides.
 * - Moving the cursor away from the ghost position dismisses it.
 * - A result is shown only if its requestId is the pending one and the document version/cursor still
 *   correspond (the host checks offsets; the machine checks ids). Stale results are dropped.
 * - Tab accepts all remaining ghost text; Ctrl/Cmd+Right accepts the next word (including its trailing
 *   space) and keeps the rest showing.
 * - Every terminal outcome emits a 'feedback' effect (accepted, accepted_partial, dismissed, expired).
 */
import type { GhostMode } from '@paper-copilot/core';
import { notImplemented } from '@paper-copilot/core';

export interface GhostConfig {
  mode: GhostMode;
  boundaryDelayMs: number;
  pauseDelayMs: number;
  minWordsForPause: number;
}

export const DEFAULT_GHOST_CONFIG: GhostConfig = {
  mode: 'complete-my-sentence',
  boundaryDelayMs: 800,
  pauseDelayMs: 500,
  minWordsForPause: 3,
};

export type GhostState =
  | { kind: 'idle'; suppressed: boolean }
  | { kind: 'waiting'; trigger: 'boundary' | 'pause'; timerId: string; pos: number; suppressed: false }
  | { kind: 'pending'; requestId: string; pos: number; trigger: 'boundary' | 'pause' | 'manual' }
  | {
      kind: 'showing';
      requestId: string;
      /** Document position where the remaining ghost text would be inserted. */
      pos: number;
      /** Remaining (not yet typed/accepted) ghost text. */
      text: string;
      /** Characters of the original suggestion already consumed by typing or partial accepts. */
      consumed: number;
      original: string;
      mismatches: number;
      hidden: boolean;
      factIds: string[];
      citeKeys: string[];
    };

export type GhostEvent =
  | { type: 'typed'; pos: number; inserted: string; sentenceWords: number; endsSentence: boolean }
  | { type: 'deleted'; pos: number }
  | { type: 'cursor'; pos: number }
  | { type: 'timer'; timerId: string }
  | { type: 'manual'; pos: number }
  | { type: 'result'; requestId: string; text: string; factIds: string[]; citeKeys: string[] }
  | { type: 'empty'; requestId: string }
  | { type: 'error'; requestId: string }
  | { type: 'compositionstart' }
  | { type: 'compositionend'; pos: number; composed: string }
  | { type: 'accept' }
  | { type: 'acceptWord' }
  | { type: 'dismiss' }
  | { type: 'modeChanged'; mode: GhostMode }
  | { type: 'external' };

export type GhostEffect =
  | { type: 'startTimer'; timerId: string; delayMs: number }
  | { type: 'clearTimer'; timerId: string }
  | { type: 'request'; requestId: string; pos: number; trigger: 'boundary' | 'pause' | 'manual' }
  | { type: 'cancel'; requestId: string }
  | { type: 'insert'; pos: number; text: string; requestId: string; partial: boolean }
  | { type: 'render' }
  | { type: 'feedback'; requestId: string; outcome: 'accepted' | 'accepted_partial' | 'dismissed' | 'expired'; acceptedText: string | null };

export interface GhostMachine {
  state: GhostState;
  config: GhostConfig;
  composing: boolean;
  /** Counter used to mint request and timer ids deterministically (tests). */
  seq: number;
}

export function initialGhost(config: Partial<GhostConfig> = {}): GhostMachine {
  return { state: { kind: 'idle', suppressed: false }, config: { ...DEFAULT_GHOST_CONFIG, ...config }, composing: false, seq: 0 };
}

export function ghostReducer(machine: GhostMachine, event: GhostEvent): { machine: GhostMachine; effects: GhostEffect[] } {
  return notImplemented('ghostReducer', machine, event);
}

/** The next word of a ghost text for Ctrl/Cmd+Right: leading spaces + word + one trailing space. */
export function nextWord(text: string): string {
  return notImplemented('nextWord', text);
}
