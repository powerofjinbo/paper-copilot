/**
 * Ghost-text state machine (docs/design.md, Core loops, Ghost mode). Pure reducer: no timers, no DOM,
 * no network. The host (CodeMirror extension in apps/web, later a VS Code client) feeds events and
 * executes the returned effects (start/cancel timers, send requests, insert text, render).
 *
 * OWNER: client-core agent.
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


/* ------------------------------------------------------------------------------------ */
/* Implementation                                                                        */
/* ------------------------------------------------------------------------------------ */
/*
 * Decisions the rules above leave open (documented here so hosts and tests agree):
 * - Ids: every minted id increments `seq`; timers are `t${seq}`, requests `g${seq}`.
 * - Events that change nothing return the SAME machine object and no effects, so a host can skip work
 *   with `===`. Changed machines are always new objects; the input is never mutated.
 * - 'render' is emitted exactly when what the widget should show (see `ghostView`) changes: a ghost
 *   appears, shrinks, grows back, moves, is hidden (mismatch, composition) or ends.
 * - A typed / composed / deleted / cursor event while composing is ignored: during composition the
 *   host reports the composed text once, at compositionend.
 * - Typing (or composing) while a timer waits or a request is pending cancels it (the prefix changed;
 *   the result could only be stale) and then evaluates the keystroke as if idle, so the debounce
 *   restarts: a timer is (re)started per keystroke, a request is only ever sent when a timer fires or on
 *   Ctrl+Space.
 * - Boundary: a typed event with `endsSentence` lifts the Esc suppression; in 'auto-propose' it starts
 *   the boundary timer (the boundary that ends the suppression may itself propose). Pause: a typed event
 *   with `sentenceWords >= minWordsForPause` (not suppressed, not ending a sentence) starts the pause
 *   timer in 'auto-propose' and 'complete-my-sentence'. Deletions never arm a trigger.
 * - Ctrl+Space ('manual') works while suppressed and lifts the suppression; while showing it
 *   regenerates (the old suggestion ends with 'dismissed', or 'accepted_partial' if part was used). It
 *   does nothing in 'questions-only' or while composing.
 * - Mismatch: a keystroke that does not continue the ghost hides it (mismatches = 1, `pos` stays at the
 *   ghost anchor). The next keystroke decides: a backspace back to the anchor restores the ghost
 *   (mismatches = 0); anything else (typing, composing text, another deletion, a cursor move) dismisses it.
 *   Typing that lands somewhere other than right after the ghost anchor dismisses at once.
 * - Backspacing over consumed characters (typed through or word-accepted) gives them back to the ghost;
 *   a forward delete at the anchor keeps it; any other deletion dismisses it.
 * - Feedback `acceptedText` is the part of the original suggestion that ended up in the document
 *   (consumed by typing, word accepts or the final accept), null if none. A ghost fully typed through or
 *   accepted ends with 'accepted' (acceptedText = the whole original); a user dismissal (Esc, two
 *   mismatches, cursor move, deletion, regenerate) ends with 'dismissed', or 'accepted_partial' if some of
 *   it was used; a mode change or an external document change ends it with 'expired'.
 * - Results: only the pending request's id is shown; a result with empty or whitespace-only text is
 *   treated as empty (back to idle, nothing shown, no feedback because nothing was shown).
 * - A mode change (to a different mode) cancels whatever is in flight: timer cleared, request
 *   cancelled, a showing ghost expired.
 */

type Showing = Extract<GhostState, { kind: 'showing' }>;
type Outcome = Extract<GhostEffect, { type: 'feedback' }>['outcome'];
type Trigger = 'boundary' | 'pause' | 'manual';

const MAX_MISMATCHES = 2;
const IDLE: GhostState = { kind: 'idle', suppressed: false };
const IDLE_SUPPRESSED: GhostState = { kind: 'idle', suppressed: true };

function idle(suppressed: boolean): GhostState {
  return suppressed ? IDLE_SUPPRESSED : IDLE;
}

function withState(m: GhostMachine, state: GhostState): GhostMachine {
  if (state === m.state) return m;
  if (state.kind === 'idle' && m.state.kind === 'idle' && m.state.suppressed === state.suppressed) return m;
  return { ...m, state };
}

function usedText(s: Showing): string | null {
  return s.consumed > 0 ? s.original.slice(0, s.consumed) : null;
}

function feedback(s: Showing, outcome: Outcome, fx: GhostEffect[]): void {
  if (outcome === 'accepted') {
    fx.push({ type: 'feedback', requestId: s.requestId, outcome, acceptedText: s.original });
    return;
  }
  const used = usedText(s);
  if (outcome === 'dismissed' && used !== null) {
    fx.push({ type: 'feedback', requestId: s.requestId, outcome: 'accepted_partial', acceptedText: used });
    return;
  }
  fx.push({ type: 'feedback', requestId: s.requestId, outcome, acceptedText: used });
}

/**
 * Ends whatever is in flight (timer, request, shown ghost) and returns the machine in idle.
 * `outcome` is the feedback for a showing ghost ('dismissed' becomes 'accepted_partial' if part was used).
 */
function stop(m: GhostMachine, fx: GhostEffect[], outcome: 'dismissed' | 'expired', suppressed: boolean): GhostMachine {
  const s = m.state;
  switch (s.kind) {
    case 'idle':
      return withState(m, idle(suppressed || s.suppressed));
    case 'waiting':
      fx.push({ type: 'clearTimer', timerId: s.timerId });
      break;
    case 'pending':
      fx.push({ type: 'cancel', requestId: s.requestId });
      break;
    case 'showing':
      feedback(s, outcome, fx);
      break;
  }
  return withState(m, idle(suppressed));
}

function delay(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function startWait(m: GhostMachine, trigger: 'boundary' | 'pause', pos: number, fx: GhostEffect[]): GhostMachine {
  const seq = m.seq + 1;
  const timerId = `t${seq}`;
  const delayMs = delay(trigger === 'boundary' ? m.config.boundaryDelayMs : m.config.pauseDelayMs);
  fx.push({ type: 'startTimer', timerId, delayMs });
  return { ...m, seq, state: { kind: 'waiting', trigger, timerId, pos, suppressed: false } };
}

function startRequest(m: GhostMachine, trigger: Trigger, pos: number, fx: GhostEffect[]): GhostMachine {
  const seq = m.seq + 1;
  const requestId = `g${seq}`;
  fx.push({ type: 'request', requestId, pos, trigger });
  return { ...m, seq, state: { kind: 'pending', requestId, pos, trigger } };
}

function triggerAllowed(mode: GhostMode, trigger: 'boundary' | 'pause'): boolean {
  if (trigger === 'boundary') return mode === 'auto-propose';
  return mode === 'auto-propose' || mode === 'complete-my-sentence';
}

type Typed = Extract<GhostEvent, { type: 'typed' }>;

/** A keystroke evaluated from idle (the machine's state is idle, or is being replaced by idle). */
function typedFromIdle(m: GhostMachine, suppressed: boolean, ev: Typed, fx: GhostEffect[]): GhostMachine {
  const mode = m.config.mode;
  if (ev.endsSentence) {
    if (triggerAllowed(mode, 'boundary')) return startWait(m, 'boundary', ev.pos, fx);
    return withState(m, idle(false));
  }
  const words = Number.isFinite(ev.sentenceWords) ? ev.sentenceWords : 0;
  if (!suppressed && triggerAllowed(mode, 'pause') && words >= m.config.minWordsForPause) return startWait(m, 'pause', ev.pos, fx);
  return withState(m, idle(suppressed));
}

function consume(m: GhostMachine, s: Showing, n: number, pos: number): GhostMachine {
  return { ...m, state: { ...s, pos, text: s.text.slice(n), consumed: s.consumed + n, mismatches: 0, hidden: false } };
}

function onTyped(m: GhostMachine, ev: Typed, fx: GhostEffect[]): GhostMachine {
  const s = m.state;
  switch (s.kind) {
    case 'idle':
      return typedFromIdle(m, s.suppressed, ev, fx);
    case 'waiting':
      fx.push({ type: 'clearTimer', timerId: s.timerId });
      return typedFromIdle(withState(m, IDLE), false, ev, fx);
    case 'pending':
      fx.push({ type: 'cancel', requestId: s.requestId });
      return typedFromIdle(withState(m, IDLE), false, ev, fx);
    case 'showing': {
      const ins = ev.inserted;
      if (!s.hidden) {
        if (ins.length === 0 && ev.pos === s.pos) return m;
        const aligned = ins.length > 0 && ev.pos === s.pos + ins.length;
        if (aligned && s.text.startsWith(ins)) {
          if (ins.length < s.text.length) return consume(m, s, ins.length, ev.pos);
          feedback(s, 'accepted', fx);
          return typedFromIdle(withState(m, IDLE), false, ev, fx);
        }
        if (aligned && ins.startsWith(s.text)) {
          feedback(s, 'accepted', fx);
          return typedFromIdle(withState(m, IDLE), false, ev, fx);
        }
        if (aligned && s.mismatches + 1 < MAX_MISMATCHES) {
          return { ...m, state: { ...s, mismatches: s.mismatches + 1, hidden: true } };
        }
      }
      feedback(s, 'dismissed', fx);
      return typedFromIdle(withState(m, IDLE), false, ev, fx);
    }
  }
}

function onDeleted(m: GhostMachine, pos: number, fx: GhostEffect[]): GhostMachine {
  const s = m.state;
  if (s.kind !== 'showing') return s.kind === 'idle' ? m : stop(m, fx, 'dismissed', false);
  if (s.hidden) {
    if (pos === s.pos) return { ...m, state: { ...s, hidden: false, mismatches: 0 } };
    return stop(m, fx, 'dismissed', false);
  }
  if (pos === s.pos) return m;
  const back = s.pos - pos;
  if (back > 0 && back <= s.consumed) {
    const consumed = s.consumed - back;
    return { ...m, state: { ...s, pos, consumed, text: s.original.slice(consumed), mismatches: 0 } };
  }
  return stop(m, fx, 'dismissed', false);
}

function onCursor(m: GhostMachine, pos: number, fx: GhostEffect[]): GhostMachine {
  const s = m.state;
  switch (s.kind) {
    case 'idle':
      return m;
    case 'waiting':
    case 'pending':
      return pos === s.pos ? m : stop(m, fx, 'dismissed', false);
    case 'showing':
      return !s.hidden && pos === s.pos ? m : stop(m, fx, 'dismissed', false);
  }
}

function onCompositionEnd(m: GhostMachine, pos: number, composed: string, fx: GhostEffect[]): GhostMachine {
  const m2: GhostMachine = { ...m, composing: false };
  const s = m2.state;
  if (s.kind !== 'showing') return m2;
  if (s.hidden) return composed === '' ? m2 : stop(m2, fx, 'dismissed', false);
  if (composed === '') return pos === s.pos ? m2 : stop(m2, fx, 'dismissed', false);
  const aligned = pos === s.pos + composed.length;
  if (aligned && s.text.startsWith(composed) && composed.length < s.text.length) return consume(m2, s, composed.length, pos);
  if (aligned && composed.startsWith(s.text)) {
    feedback(s, 'accepted', fx);
    return withState(m2, IDLE);
  }
  return stop(m2, fx, 'dismissed', false);
}

function acceptable(m: GhostMachine): Showing | null {
  const s = m.state;
  return s.kind === 'showing' && !s.hidden && !m.composing && s.text.length > 0 ? s : null;
}

function step(m: GhostMachine, ev: GhostEvent, fx: GhostEffect[]): GhostMachine {
  switch (ev.type) {
    case 'typed':
      return m.composing ? m : onTyped(m, ev, fx);
    case 'deleted':
      return m.composing ? m : onDeleted(m, ev.pos, fx);
    case 'cursor':
      return m.composing ? m : onCursor(m, ev.pos, fx);
    case 'timer': {
      const s = m.state;
      if (s.kind !== 'waiting' || s.timerId !== ev.timerId) return m;
      if (m.composing || !triggerAllowed(m.config.mode, s.trigger)) return withState(m, IDLE);
      return startRequest(m, s.trigger, s.pos, fx);
    }
    case 'manual': {
      if (m.composing || m.config.mode === 'questions-only') return m;
      return startRequest(stop(m, fx, 'dismissed', false), 'manual', ev.pos, fx);
    }
    case 'result': {
      const s = m.state;
      if (s.kind !== 'pending' || s.requestId !== ev.requestId) return m;
      if (m.composing || ev.text.trim() === '') return withState(m, IDLE);
      return {
        ...m,
        state: {
          kind: 'showing',
          requestId: s.requestId,
          pos: s.pos,
          text: ev.text,
          consumed: 0,
          original: ev.text,
          mismatches: 0,
          hidden: false,
          factIds: [...ev.factIds],
          citeKeys: [...ev.citeKeys],
        },
      };
    }
    case 'empty':
    case 'error': {
      const s = m.state;
      if (s.kind !== 'pending' || s.requestId !== ev.requestId) return m;
      return withState(m, IDLE);
    }
    case 'compositionstart': {
      if (m.composing) return m;
      const s = m.state;
      const base = s.kind === 'waiting' || s.kind === 'pending' ? stop(m, fx, 'dismissed', false) : m;
      return { ...base, composing: true };
    }
    case 'compositionend':
      return m.composing ? onCompositionEnd(m, ev.pos, ev.composed ?? '', fx) : m;
    case 'accept': {
      const s = acceptable(m);
      if (!s) return m;
      fx.push({ type: 'insert', pos: s.pos, text: s.text, requestId: s.requestId, partial: false });
      feedback(s, 'accepted', fx);
      return withState(m, IDLE);
    }
    case 'acceptWord': {
      const s = acceptable(m);
      if (!s) return m;
      const word = nextWord(s.text);
      if (word.length >= s.text.length) {
        fx.push({ type: 'insert', pos: s.pos, text: s.text, requestId: s.requestId, partial: false });
        feedback(s, 'accepted', fx);
        return withState(m, IDLE);
      }
      fx.push({ type: 'insert', pos: s.pos, text: word, requestId: s.requestId, partial: true });
      return consume(m, s, word.length, s.pos + word.length);
    }
    case 'dismiss':
      return stop(m, fx, 'dismissed', true);
    case 'modeChanged': {
      if (ev.mode === m.config.mode) return m;
      const stopped = stop(m, fx, 'expired', false);
      return { ...stopped, config: { ...stopped.config, mode: ev.mode } };
    }
    case 'external':
      return m.state.kind === 'idle' ? m : stop(m, fx, 'expired', false);
    default:
      return m;
  }
}

/** What the ghost widget should display now, or null (nothing showing, hidden, or IME composing). */
export function ghostView(machine: GhostMachine): { pos: number; text: string; requestId: string; factIds: string[]; citeKeys: string[] } | null {
  const s = machine.state;
  if (machine.composing || s.kind !== 'showing' || s.hidden || s.text.length === 0) return null;
  return { pos: s.pos, text: s.text, requestId: s.requestId, factIds: s.factIds, citeKeys: s.citeKeys };
}

function viewKey(m: GhostMachine): string {
  const v = ghostView(m);
  return v ? `${v.pos}\u0000${v.text}` : '';
}

export function ghostReducer(machine: GhostMachine, event: GhostEvent): { machine: GhostMachine; effects: GhostEffect[] } {
  const effects: GhostEffect[] = [];
  const next = step(machine, event, effects);
  if (next !== machine && viewKey(next) !== viewKey(machine)) effects.push({ type: 'render' });
  return { machine: next, effects };
}

const NEXT_WORD_RE = /^\s*\S*[ \t]?/;

/** The next word of a ghost text for Ctrl/Cmd+Right: leading spaces + word + one trailing space. */
export function nextWord(text: string): string {
  return NEXT_WORD_RE.exec(text)?.[0] ?? '';
}
