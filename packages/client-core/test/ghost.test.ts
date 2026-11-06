import { describe, expect, it } from 'vitest';
import type { GhostMode } from '@paper-copilot/core';
import {
  DEFAULT_GHOST_CONFIG,
  ghostReducer,
  ghostView,
  initialGhost,
  nextWord,
  type GhostEffect,
  type GhostEvent,
  type GhostMachine,
  type GhostState,
} from '../src/ghost';

/* ------------------------------------------------------------------------------------ */
/* Helpers                                                                               */
/* ------------------------------------------------------------------------------------ */

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

/** Applies events in order; every input machine is frozen so any mutation throws. */
function run(m: GhostMachine, ...events: GhostEvent[]): { machine: GhostMachine; effects: GhostEffect[]; steps: GhostEffect[][] } {
  const effects: GhostEffect[] = [];
  const steps: GhostEffect[][] = [];
  let cur = m;
  for (const ev of events) {
    deepFreeze(cur);
    const r = ghostReducer(cur, ev);
    effects.push(...r.effects);
    steps.push(r.effects);
    cur = r.machine;
  }
  return { machine: cur, effects, steps };
}

const typed = (pos: number, inserted: string, sentenceWords = 0, endsSentence = false): GhostEvent => ({
  type: 'typed',
  pos,
  inserted,
  sentenceWords,
  endsSentence,
});

const types = (effects: GhostEffect[]) => effects.map((e) => e.type);
const ofType = <T extends GhostEffect['type']>(effects: GhostEffect[], t: T) =>
  effects.filter((e): e is Extract<GhostEffect, { type: T }> => e.type === t);
const feedbacks = (effects: GhostEffect[]) => ofType(effects, 'feedback');
const requests = (effects: GhostEffect[]) => ofType(effects, 'request');
const machine = (mode: GhostMode = 'complete-my-sentence') => initialGhost({ mode });

/** A machine showing `text` at `pos` (via manual request + result). */
function showing(text: string, pos = 10, mode: GhostMode = 'complete-my-sentence', ids: { factIds?: string[]; citeKeys?: string[] } = {}) {
  const r = run(machine(mode), { type: 'manual', pos });
  const req = requests(r.effects)[0]!;
  const s = run(r.machine, { type: 'result', requestId: req.requestId, text, factIds: ids.factIds ?? [], citeKeys: ids.citeKeys ?? [] });
  expect(s.machine.state.kind).toBe('showing');
  return { machine: s.machine, requestId: req.requestId };
}

function asShowing(st: GhostState) {
  if (st.kind !== 'showing') throw new Error(`expected showing, got ${st.kind}`);
  return st;
}

/* ------------------------------------------------------------------------------------ */
/* Initial state and ids                                                                 */
/* ------------------------------------------------------------------------------------ */

describe('initialGhost', () => {
  it('starts idle, unsuppressed, not composing, seq 0, with defaults merged', () => {
    const m = initialGhost({ pauseDelayMs: 300 });
    expect(m.state).toEqual({ kind: 'idle', suppressed: false });
    expect(m.composing).toBe(false);
    expect(m.seq).toBe(0);
    expect(m.config).toEqual({ ...DEFAULT_GHOST_CONFIG, pauseDelayMs: 300 });
  });

  it('mints ids deterministically from seq', () => {
    const a = run(machine('auto-propose'), typed(20, 'x', 3), { type: 'timer', timerId: 't1' });
    expect(a.effects).toEqual([
      { type: 'startTimer', timerId: 't1', delayMs: 500 },
      { type: 'request', requestId: 'g2', pos: 20, trigger: 'pause' },
    ]);
    expect(a.machine.seq).toBe(2);
    const b = run(machine('auto-propose'), typed(20, 'x', 3), { type: 'timer', timerId: 't1' });
    expect(b).toEqual(a);
  });
});

/* ------------------------------------------------------------------------------------ */
/* Triggers per mode                                                                     */
/* ------------------------------------------------------------------------------------ */

describe('triggers', () => {
  const modes: GhostMode[] = ['complete-my-sentence', 'auto-propose', 'questions-only'];

  it('a single keystroke never sends a request in any mode', () => {
    for (const mode of modes) {
      for (const ev of [typed(5, 'a', 10), typed(5, ' ', 0, true), typed(5, 'a', 0)]) {
        const r = run(machine(mode), ev);
        expect(requests(r.effects)).toHaveLength(0);
      }
    }
  });

  it('pause: complete-my-sentence and auto-propose start a pause timer with >= 3 words; firing requests', () => {
    for (const mode of ['complete-my-sentence', 'auto-propose'] as GhostMode[]) {
      const r1 = run(machine(mode), typed(30, 'e', 3));
      expect(r1.effects).toEqual([{ type: 'startTimer', timerId: 't1', delayMs: 500 }]);
      expect(r1.machine.state).toEqual({ kind: 'waiting', trigger: 'pause', timerId: 't1', pos: 30, suppressed: false });
      const r2 = run(r1.machine, { type: 'timer', timerId: 't1' });
      expect(r2.effects).toEqual([{ type: 'request', requestId: 'g2', pos: 30, trigger: 'pause' }]);
      expect(r2.machine.state).toEqual({ kind: 'pending', requestId: 'g2', pos: 30, trigger: 'pause' });
    }
  });

  it('pause needs >= minWordsForPause words', () => {
    for (const mode of ['complete-my-sentence', 'auto-propose'] as GhostMode[]) {
      for (const w of [0, 1, 2]) {
        const r = run(machine(mode), typed(30, 'e', w));
        expect(r.effects).toEqual([]);
        expect(r.machine.state.kind).toBe('idle');
      }
    }
    const custom = run(initialGhost({ mode: 'complete-my-sentence', minWordsForPause: 5 }), typed(9, 'a', 4));
    expect(custom.effects).toEqual([]);
    const custom2 = run(initialGhost({ mode: 'complete-my-sentence', minWordsForPause: 5 }), typed(9, 'a', 5));
    expect(types(custom2.effects)).toEqual(['startTimer']);
  });

  it('boundary: only auto-propose starts a boundary timer (boundaryDelayMs)', () => {
    const ap = run(machine('auto-propose'), typed(40, ' ', 0, true));
    expect(ap.effects).toEqual([{ type: 'startTimer', timerId: 't1', delayMs: 800 }]);
    expect(ap.machine.state).toMatchObject({ kind: 'waiting', trigger: 'boundary', pos: 40 });
    const fired = run(ap.machine, { type: 'timer', timerId: 't1' });
    expect(fired.effects).toEqual([{ type: 'request', requestId: 'g2', pos: 40, trigger: 'boundary' }]);

    for (const mode of ['complete-my-sentence', 'questions-only'] as GhostMode[]) {
      const r = run(machine(mode), typed(40, ' ', 7, true));
      expect(r.effects).toEqual([]);
      expect(r.machine.state).toEqual({ kind: 'idle', suppressed: false });
    }
  });

  it('questions-only never requests prose: no timers, manual ignored', () => {
    const m = machine('questions-only');
    const r = run(m, typed(1, 'a', 9), typed(2, ' ', 9, true), { type: 'manual', pos: 2 }, { type: 'timer', timerId: 't1' });
    expect(r.effects).toEqual([]);
    expect(r.machine.state.kind).toBe('idle');
    const manual = ghostReducer(m, { type: 'manual', pos: 3 });
    expect(manual.machine).toBe(m);
    expect(manual.effects).toEqual([]);
  });

  it('manual works in complete-my-sentence and auto-propose, with any word count', () => {
    for (const mode of ['complete-my-sentence', 'auto-propose'] as GhostMode[]) {
      const r = run(machine(mode), { type: 'manual', pos: 0 });
      expect(r.effects).toEqual([{ type: 'request', requestId: 'g1', pos: 0, trigger: 'manual' }]);
      expect(r.machine.state).toEqual({ kind: 'pending', requestId: 'g1', pos: 0, trigger: 'manual' });
    }
  });

  it('typing debounces: each keystroke clears and restarts the timer, never requests', () => {
    const r = run(machine('complete-my-sentence'), typed(10, 'a', 3), typed(11, 'b', 3), typed(12, 'c', 3));
    expect(r.effects).toEqual([
      { type: 'startTimer', timerId: 't1', delayMs: 500 },
      { type: 'clearTimer', timerId: 't1' },
      { type: 'startTimer', timerId: 't2', delayMs: 500 },
      { type: 'clearTimer', timerId: 't2' },
      { type: 'startTimer', timerId: 't3', delayMs: 500 },
    ]);
    expect(r.machine.state).toMatchObject({ kind: 'waiting', timerId: 't3', pos: 12 });
    // the old timer firing late is ignored
    const late = ghostReducer(r.machine, { type: 'timer', timerId: 't1' });
    expect(late.machine).toBe(r.machine);
    expect(late.effects).toEqual([]);
  });

  it('a boundary while waiting for a pause replaces the pause with a boundary timer (auto-propose)', () => {
    const r = run(machine('auto-propose'), typed(10, 'x', 4), typed(12, ' ', 0, true));
    expect(r.effects).toEqual([
      { type: 'startTimer', timerId: 't1', delayMs: 500 },
      { type: 'clearTimer', timerId: 't1' },
      { type: 'startTimer', timerId: 't2', delayMs: 800 },
    ]);
    expect(r.machine.state).toMatchObject({ kind: 'waiting', trigger: 'boundary' });
  });

  it('typing falling below the word threshold while waiting clears the timer', () => {
    const r = run(machine(), typed(10, 'x', 3), { type: 'deleted', pos: 9 });
    expect(r.effects).toEqual([
      { type: 'startTimer', timerId: 't1', delayMs: 500 },
      { type: 'clearTimer', timerId: 't1' },
    ]);
    expect(r.machine.state).toEqual({ kind: 'idle', suppressed: false });
    const r2 = run(machine(), typed(10, 'x', 3), typed(11, 'y', 1));
    expect(r2.machine.state.kind).toBe('idle');
    expect(types(r2.effects)).toEqual(['startTimer', 'clearTimer']);
  });

  it('cursor move while waiting cancels the timer; cursor staying put keeps it', () => {
    const w = run(machine(), typed(10, 'x', 3)).machine;
    const same = ghostReducer(w, { type: 'cursor', pos: 10 });
    expect(same.machine).toBe(w);
    const away = run(w, { type: 'cursor', pos: 3 });
    expect(away.effects).toEqual([{ type: 'clearTimer', timerId: 't1' }]);
    expect(away.machine.state.kind).toBe('idle');
  });

  it('typing while a request is pending cancels it and re-arms the debounce', () => {
    const p = run(machine(), typed(10, 'x', 3), { type: 'timer', timerId: 't1' }).machine;
    const r = run(p, typed(11, 'y', 3));
    expect(r.effects).toEqual([
      { type: 'cancel', requestId: 'g2' },
      { type: 'startTimer', timerId: 't3', delayMs: 500 },
    ]);
    // its late result is dropped
    const late = run(r.machine, { type: 'result', requestId: 'g2', text: 'late', factIds: [], citeKeys: [] });
    expect(late.machine).toBe(r.machine);
    expect(late.effects).toEqual([]);
  });

  it('cursor move or deletion while pending cancels the request', () => {
    const p = run(machine(), { type: 'manual', pos: 5 }).machine;
    expect(run(p, { type: 'cursor', pos: 6 }).effects).toEqual([{ type: 'cancel', requestId: 'g1' }]);
    expect(run(p, { type: 'deleted', pos: 4 }).effects).toEqual([{ type: 'cancel', requestId: 'g1' }]);
    expect(ghostReducer(p, { type: 'cursor', pos: 5 }).machine).toBe(p);
  });

  it('deletions never arm a trigger', () => {
    for (const mode of ['complete-my-sentence', 'auto-propose'] as GhostMode[]) {
      const r = run(machine(mode), { type: 'deleted', pos: 4 });
      expect(r.effects).toEqual([]);
    }
  });

  it('manual while waiting clears the timer and requests at the given position', () => {
    const r = run(machine(), typed(10, 'x', 3), { type: 'manual', pos: 10 });
    expect(r.effects).toEqual([
      { type: 'startTimer', timerId: 't1', delayMs: 500 },
      { type: 'clearTimer', timerId: 't1' },
      { type: 'request', requestId: 'g2', pos: 10, trigger: 'manual' },
    ]);
  });

  it('manual while pending cancels and re-requests', () => {
    const r = run(machine(), { type: 'manual', pos: 5 }, { type: 'manual', pos: 5 });
    expect(r.effects).toEqual([
      { type: 'request', requestId: 'g1', pos: 5, trigger: 'manual' },
      { type: 'cancel', requestId: 'g1' },
      { type: 'request', requestId: 'g2', pos: 5, trigger: 'manual' },
    ]);
  });

  it('manual while showing regenerates: old one dismissed, new request', () => {
    const { machine: m, requestId } = showing(' is shown.', 10);
    const r = run(m, { type: 'manual', pos: 10 });
    expect(r.effects).toEqual([
      { type: 'feedback', requestId, outcome: 'dismissed', acceptedText: null },
      { type: 'request', requestId: 'g2', pos: 10, trigger: 'manual' },
      { type: 'render' },
    ]);
    expect(ghostView(r.machine)).toBeNull();
  });

  it('non-finite or negative delays are clamped to 0', () => {
    const r = run(initialGhost({ mode: 'auto-propose', boundaryDelayMs: -5, pauseDelayMs: Number.NaN }), typed(1, ' ', 0, true), typed(2, 'x', 3));
    expect(ofType(r.effects, 'startTimer').map((e) => e.delayMs)).toEqual([0, 0]);
  });
});

/* ------------------------------------------------------------------------------------ */
/* Esc suppression                                                                       */
/* ------------------------------------------------------------------------------------ */

describe('Esc suppression', () => {
  it('dismiss while showing: feedback dismissed, idle suppressed, render', () => {
    const { machine: m, requestId } = showing(' the rest.', 10);
    const r = run(m, { type: 'dismiss' });
    expect(r.effects).toEqual([{ type: 'feedback', requestId, outcome: 'dismissed', acceptedText: null }, { type: 'render' }]);
    expect(r.machine.state).toEqual({ kind: 'idle', suppressed: true });
  });

  it('suppresses pause triggers until the next boundary, then the boundary may propose (auto-propose)', () => {
    const { machine: m } = showing(' the rest.', 10, 'auto-propose');
    const sup = run(m, { type: 'dismiss' }).machine;
    const r = run(sup, typed(11, 'a', 5), typed(12, 'b', 6));
    expect(r.effects).toEqual([]);
    expect(r.machine.state).toEqual({ kind: 'idle', suppressed: true });
    const b = run(r.machine, typed(14, ' ', 0, true));
    expect(b.effects).toEqual([{ type: 'startTimer', timerId: 't2', delayMs: 800 }]);
    // and afterwards pauses work again
    const p = run(b.machine, typed(15, 'w', 3));
    expect(types(p.effects)).toEqual(['clearTimer', 'startTimer']);
    expect(p.machine.state).toMatchObject({ kind: 'waiting', trigger: 'pause' });
  });

  it('in complete-my-sentence the boundary lifts suppression without requesting', () => {
    const sup = run(machine(), { type: 'dismiss' }).machine;
    expect(sup.state).toEqual({ kind: 'idle', suppressed: true });
    expect(run(sup, typed(3, 'x', 4)).effects).toEqual([]);
    const b = run(sup, typed(3, ' ', 0, true));
    expect(b.effects).toEqual([]);
    expect(b.machine.state).toEqual({ kind: 'idle', suppressed: false });
    expect(types(run(b.machine, typed(4, 'x', 4)).effects)).toEqual(['startTimer']);
  });

  it('dismiss while waiting or pending clears/cancels and suppresses', () => {
    const w = run(machine(), typed(10, 'x', 3)).machine;
    const rw = run(w, { type: 'dismiss' });
    expect(rw.effects).toEqual([{ type: 'clearTimer', timerId: 't1' }]);
    expect(rw.machine.state).toEqual({ kind: 'idle', suppressed: true });
    const p = run(machine(), { type: 'manual', pos: 1 }).machine;
    const rp = run(p, { type: 'dismiss' });
    expect(rp.effects).toEqual([{ type: 'cancel', requestId: 'g1' }]);
    expect(rp.machine.state).toEqual({ kind: 'idle', suppressed: true });
  });

  it('manual still works while suppressed (and lifts the suppression)', () => {
    const sup = run(machine(), { type: 'dismiss' }).machine;
    const r = run(sup, { type: 'manual', pos: 4 });
    expect(requests(r.effects)).toHaveLength(1);
    const e = run(r.machine, { type: 'empty', requestId: 'g1' });
    expect(e.machine.state).toEqual({ kind: 'idle', suppressed: false });
  });

  it('dismiss in idle is idempotent', () => {
    const a = run(machine(), { type: 'dismiss' }).machine;
    const b = ghostReducer(a, { type: 'dismiss' });
    expect(b.machine).toBe(a);
    expect(b.effects).toEqual([]);
  });
});

/* ------------------------------------------------------------------------------------ */
/* Results                                                                               */
/* ------------------------------------------------------------------------------------ */

describe('results', () => {
  it('a matching result shows the ghost with facts and cites, and renders', () => {
    const p = run(machine(), { type: 'manual', pos: 12 }).machine;
    const r = run(p, { type: 'result', requestId: 'g1', text: ' by 2.3 points.', factIds: ['f.a'], citeKeys: ['k1'] });
    expect(r.effects).toEqual([{ type: 'render' }]);
    expect(r.machine.state).toEqual({
      kind: 'showing',
      requestId: 'g1',
      pos: 12,
      text: ' by 2.3 points.',
      consumed: 0,
      original: ' by 2.3 points.',
      mismatches: 0,
      hidden: false,
      factIds: ['f.a'],
      citeKeys: ['k1'],
    });
    expect(ghostView(r.machine)).toEqual({ pos: 12, text: ' by 2.3 points.', requestId: 'g1', factIds: ['f.a'], citeKeys: ['k1'] });
  });

  it('stale results (wrong id, or not pending) are dropped unchanged', () => {
    const p = run(machine(), { type: 'manual', pos: 12 }).machine;
    for (const ev of [
      { type: 'result', requestId: 'g0', text: 'x', factIds: [], citeKeys: [] },
      { type: 'empty', requestId: 'g9' },
      { type: 'error', requestId: 'zzz' },
    ] as GhostEvent[]) {
      const r = ghostReducer(p, ev);
      expect(r.machine).toBe(p);
      expect(r.effects).toEqual([]);
    }
    const idle = machine();
    expect(ghostReducer(idle, { type: 'result', requestId: 'g1', text: 'x', factIds: [], citeKeys: [] }).machine).toBe(idle);
    const { machine: s } = showing(' a b.');
    expect(ghostReducer(s, { type: 'result', requestId: 'g1', text: 'other', factIds: [], citeKeys: [] }).machine).toBe(s);
  });

  it('empty and error results return to idle without showing or feedback', () => {
    for (const ev of [{ type: 'empty', requestId: 'g1' }, { type: 'error', requestId: 'g1' }] as GhostEvent[]) {
      const p = run(machine(), { type: 'manual', pos: 1 }).machine;
      const r = run(p, ev);
      expect(r.effects).toEqual([]);
      expect(r.machine.state).toEqual({ kind: 'idle', suppressed: false });
    }
  });

  it('a result with empty or whitespace-only text counts as empty', () => {
    for (const text of ['', '   ', '\n']) {
      const p = run(machine(), { type: 'manual', pos: 1 }).machine;
      const r = run(p, { type: 'result', requestId: 'g1', text, factIds: [], citeKeys: [] });
      expect(r.effects).toEqual([]);
      expect(r.machine.state.kind).toBe('idle');
    }
  });

  it('copies factIds / citeKeys so later mutation of the event does not leak in', () => {
    const p = run(machine(), { type: 'manual', pos: 1 }).machine;
    const factIds = ['f.a'];
    const r = ghostReducer(p, { type: 'result', requestId: 'g1', text: 'x y', factIds, citeKeys: [] });
    factIds.push('f.b');
    expect(asShowing(r.machine.state).factIds).toEqual(['f.a']);
  });
});

/* ------------------------------------------------------------------------------------ */
/* Showing: typing through, mismatches, cursor, deletions                                */
/* ------------------------------------------------------------------------------------ */

describe('typing over a ghost', () => {
  it('matching keystrokes consume the ghost (it shrinks) and render', () => {
    const { machine: m } = showing(' shows a gain.', 10);
    const r = run(m, typed(11, ' ', 2), typed(12, 's', 3), typed(13, 'h', 3));
    const st = asShowing(r.machine.state);
    expect(st).toMatchObject({ pos: 13, text: 'ows a gain.', consumed: 3, original: ' shows a gain.', mismatches: 0, hidden: false });
    expect(r.steps.every((s) => s.length === 1 && s[0]!.type === 'render')).toBe(true);
    expect(requests(r.effects)).toHaveLength(0);
  });

  it('typing the whole ghost completes it with feedback accepted', () => {
    const { machine: m, requestId } = showing(' ok.', 10);
    const r = run(m, typed(11, ' '), typed(12, 'o'), typed(13, 'k'), typed(14, '.'));
    expect(feedbacks(r.effects)).toEqual([{ type: 'feedback', requestId, outcome: 'accepted', acceptedText: ' ok.' }]);
    expect(r.machine.state).toEqual({ kind: 'idle', suppressed: false });
    expect(ofType(r.effects, 'insert')).toHaveLength(0);
  });

  it('a multi-character insertion that covers the ghost and more completes it and evaluates the rest', () => {
    const { machine: m, requestId } = showing(' ok.', 10, 'auto-propose');
    const r = run(m, typed(15, ' ok. ', 0, true));
    expect(r.effects).toEqual([
      { type: 'feedback', requestId, outcome: 'accepted', acceptedText: ' ok.' },
      { type: 'startTimer', timerId: 't2', delayMs: 800 },
      { type: 'render' },
    ]);
  });

  it('a single mismatch hides the ghost; a second mismatching keystroke dismisses it', () => {
    const { machine: m, requestId } = showing(' shows', 10);
    const one = run(m, typed(11, 'X', 3));
    expect(one.effects).toEqual([{ type: 'render' }]);
    expect(asShowing(one.machine.state)).toMatchObject({ hidden: true, mismatches: 1, pos: 10, text: ' shows' });
    expect(ghostView(one.machine)).toBeNull();
    const two = run(one.machine, typed(12, 'Y', 3));
    expect(feedbacks(two.effects)).toEqual([{ type: 'feedback', requestId, outcome: 'dismissed', acceptedText: null }]);
    // the keystroke then counts as normal typing (no suppression): pause re-armed
    expect(types(two.effects)).toEqual(['feedback', 'startTimer']);
    expect(two.machine.state).toMatchObject({ kind: 'waiting', trigger: 'pause' });
  });

  it('even a keystroke that would have matched dismisses once hidden (the document no longer aligns)', () => {
    const { machine: m } = showing('abc', 10);
    const r = run(m, typed(11, 'x'), typed(12, 'a'));
    expect(feedbacks(r.effects)).toHaveLength(1);
    expect(r.machine.state.kind).toBe('idle');
  });

  it('backspacing the mismatched character restores the ghost', () => {
    const { machine: m } = showing(' shows', 10);
    const hidden = run(m, typed(11, 'X')).machine;
    const r = run(hidden, { type: 'deleted', pos: 10 });
    expect(r.effects).toEqual([{ type: 'render' }]);
    expect(asShowing(r.machine.state)).toMatchObject({ hidden: false, mismatches: 0, pos: 10, text: ' shows' });
    // and a new single mismatch only hides again
    expect(asShowing(run(r.machine, typed(11, 'Z')).machine.state).hidden).toBe(true);
  });

  it('another deletion or a cursor move while hidden dismisses', () => {
    const { machine: m, requestId } = showing(' shows', 10);
    const hidden = run(m, typed(11, 'X')).machine;
    for (const ev of [{ type: 'deleted', pos: 9 }, { type: 'cursor', pos: 11 }, { type: 'cursor', pos: 10 }] as GhostEvent[]) {
      const r = run(hidden, ev);
      expect(feedbacks(r.effects)).toEqual([{ type: 'feedback', requestId, outcome: 'dismissed', acceptedText: null }]);
      expect(r.machine.state.kind).toBe('idle');
    }
  });

  it('partial typing then a mismatch-dismissal reports accepted_partial with the used text', () => {
    const { machine: m, requestId } = showing(' shows a gain.', 10);
    const r = run(m, typed(11, ' '), typed(12, 's'), typed(13, 'X'), typed(14, 'Y'));
    expect(feedbacks(r.effects)).toEqual([{ type: 'feedback', requestId, outcome: 'accepted_partial', acceptedText: ' s' }]);
  });

  it('typing that lands away from the ghost anchor dismisses at once', () => {
    const { machine: m, requestId } = showing(' shows', 10);
    const r = run(m, typed(30, ' '));
    expect(feedbacks(r.effects)).toEqual([{ type: 'feedback', requestId, outcome: 'dismissed', acceptedText: null }]);
    expect(r.machine.state.kind).toBe('idle');
  });

  it('an empty insertion at the anchor changes nothing', () => {
    const { machine: m } = showing(' shows', 10);
    const r = ghostReducer(m, typed(10, ''));
    expect(r.machine).toBe(m);
    expect(r.effects).toEqual([]);
  });

  it('moving the cursor away dismisses (not suppressed); staying put keeps it', () => {
    const { machine: m, requestId } = showing(' shows', 10);
    expect(ghostReducer(m, { type: 'cursor', pos: 10 }).machine).toBe(m);
    const r = run(m, { type: 'cursor', pos: 2 });
    expect(r.effects).toEqual([{ type: 'feedback', requestId, outcome: 'dismissed', acceptedText: null }, { type: 'render' }]);
    expect(r.machine.state).toEqual({ kind: 'idle', suppressed: false });
  });

  it('backspacing over consumed characters gives them back to the ghost', () => {
    const { machine: m } = showing(' shows', 10);
    const typedTwo = run(m, typed(11, ' '), typed(12, 's')).machine;
    const r = run(typedTwo, { type: 'deleted', pos: 11 });
    expect(asShowing(r.machine.state)).toMatchObject({ pos: 11, text: 'shows', consumed: 1 });
    expect(r.effects).toEqual([{ type: 'render' }]);
    const r2 = run(r.machine, { type: 'deleted', pos: 10 });
    expect(asShowing(r2.machine.state)).toMatchObject({ pos: 10, text: ' shows', consumed: 0 });
  });

  it('deleting before the consumed text dismisses; forward delete at the anchor keeps the ghost', () => {
    const { machine: m, requestId } = showing(' shows', 10);
    expect(ghostReducer(m, { type: 'deleted', pos: 10 }).machine).toBe(m);
    const r = run(m, { type: 'deleted', pos: 9 });
    expect(feedbacks(r.effects)).toEqual([{ type: 'feedback', requestId, outcome: 'dismissed', acceptedText: null }]);
    expect(r.machine.state.kind).toBe('idle');
  });
});

/* ------------------------------------------------------------------------------------ */
/* Accepting                                                                             */
/* ------------------------------------------------------------------------------------ */

describe('accept', () => {
  it('Tab inserts all remaining text and reports accepted', () => {
    const { machine: m, requestId } = showing(' shows a gain.', 10, 'complete-my-sentence', { factIds: ['f.a'] });
    const r = run(m, { type: 'accept' });
    expect(r.effects).toEqual([
      { type: 'insert', pos: 10, text: ' shows a gain.', requestId, partial: false },
      { type: 'feedback', requestId, outcome: 'accepted', acceptedText: ' shows a gain.' },
      { type: 'render' },
    ]);
    expect(r.machine.state).toEqual({ kind: 'idle', suppressed: false });
  });

  it('Tab after typing through part inserts only the remainder', () => {
    const { machine: m, requestId } = showing(' shows', 10);
    const r = run(m, typed(11, ' '), typed(12, 's'), { type: 'accept' });
    expect(ofType(r.effects, 'insert')).toEqual([{ type: 'insert', pos: 12, text: 'hows', requestId, partial: false }]);
    expect(feedbacks(r.effects)).toEqual([{ type: 'feedback', requestId, outcome: 'accepted', acceptedText: ' shows' }]);
  });

  it('word accept inserts the next word with its trailing space and keeps the rest showing', () => {
    const { machine: m, requestId } = showing(' shows a gain.', 10);
    const r = run(m, { type: 'acceptWord' });
    expect(r.effects).toEqual([{ type: 'insert', pos: 10, text: ' shows ', requestId, partial: true }, { type: 'render' }]);
    expect(asShowing(r.machine.state)).toMatchObject({ pos: 17, text: 'a gain.', consumed: 7, hidden: false });
    expect(ghostView(r.machine)).toMatchObject({ pos: 17, text: 'a gain.' });
    // the host does not feed the insert back as typing; the next keystroke at the new anchor still matches
    const t = run(r.machine, typed(18, 'a'));
    expect(asShowing(t.machine.state)).toMatchObject({ pos: 18, text: ' gain.' });
  });

  it('accepting the last word completes with insert partial:false and accepted', () => {
    const { machine: m, requestId } = showing(' shows a gain.', 10);
    const r = run(m, { type: 'acceptWord' }, { type: 'acceptWord' }, { type: 'acceptWord' });
    expect(ofType(r.effects, 'insert')).toEqual([
      { type: 'insert', pos: 10, text: ' shows ', requestId, partial: true },
      { type: 'insert', pos: 17, text: 'a ', requestId, partial: true },
      { type: 'insert', pos: 19, text: 'gain.', requestId, partial: false },
    ]);
    expect(feedbacks(r.effects)).toEqual([{ type: 'feedback', requestId, outcome: 'accepted', acceptedText: ' shows a gain.' }]);
    expect(r.machine.state).toEqual({ kind: 'idle', suppressed: false });
  });

  it('word accepts then Esc report accepted_partial with the accepted words', () => {
    const { machine: m, requestId } = showing(' shows a gain.', 10);
    const r = run(m, { type: 'acceptWord' }, { type: 'dismiss' });
    expect(feedbacks(r.effects)).toEqual([{ type: 'feedback', requestId, outcome: 'accepted_partial', acceptedText: ' shows ' }]);
    expect(r.machine.state).toEqual({ kind: 'idle', suppressed: true });
  });

  it('word accepts then a cursor move report accepted_partial', () => {
    const { machine: m, requestId } = showing(' shows a gain.', 10);
    const r = run(m, { type: 'acceptWord' }, { type: 'cursor', pos: 0 });
    expect(feedbacks(r.effects)).toEqual([{ type: 'feedback', requestId, outcome: 'accepted_partial', acceptedText: ' shows ' }]);
  });

  it('accept / acceptWord do nothing when nothing is visible (idle, pending, hidden, composing)', () => {
    const { machine: m } = showing(' shows', 10);
    const hidden = run(m, typed(11, 'X')).machine;
    const composing = run(m, { type: 'compositionstart' }).machine;
    for (const mm of [machine(), run(machine(), { type: 'manual', pos: 1 }).machine, hidden, composing]) {
      for (const ev of [{ type: 'accept' }, { type: 'acceptWord' }] as GhostEvent[]) {
        const r = ghostReducer(mm, ev);
        expect(r.machine).toBe(mm);
        expect(r.effects).toEqual([]);
      }
    }
  });
});

describe('nextWord', () => {
  it.each([
    [' shows a gain.', ' shows '],
    ['shows a gain.', 'shows '],
    ['gain.', 'gain.'],
    ['   lots  of space', '   lots '],
    ['a\nb', 'a'],
    ['\\cite{Wang2022} and', '\\cite{Wang2022} '],
    ['', ''],
    ['   ', '   '],
    ['数据 显示', '数据 '],
  ])('%j -> %j', (input, expected) => {
    expect(nextWord(input)).toBe(expected);
  });

  it('repeated word accepts with double spaces still finish', () => {
    const { machine: m, requestId } = showing('a  b', 0);
    const r = run(m, { type: 'acceptWord' }, { type: 'acceptWord' });
    expect(ofType(r.effects, 'insert').map((e) => e.text)).toEqual(['a ', ' b']);
    expect(feedbacks(r.effects)).toEqual([{ type: 'feedback', requestId, outcome: 'accepted', acceptedText: 'a  b' }]);
  });
});

/* ------------------------------------------------------------------------------------ */
/* IME composition                                                                       */
/* ------------------------------------------------------------------------------------ */

describe('IME composition', () => {
  it('compositionstart clears a waiting timer and cancels a pending request', () => {
    const w = run(machine(), typed(10, 'x', 3)).machine;
    const rw = run(w, { type: 'compositionstart' });
    expect(rw.effects).toEqual([{ type: 'clearTimer', timerId: 't1' }]);
    expect(rw.machine.composing).toBe(true);
    expect(rw.machine.state.kind).toBe('idle');
    const p = run(machine(), { type: 'manual', pos: 1 }).machine;
    const rp = run(p, { type: 'compositionstart' });
    expect(rp.effects).toEqual([{ type: 'cancel', requestId: 'g1' }]);
    expect(rp.machine.composing).toBe(true);
  });

  it('while composing: no request, no timer, no render, whatever arrives', () => {
    const c = run(machine('auto-propose'), { type: 'compositionstart' }).machine;
    const r = run(
      c,
      typed(3, 'x', 9),
      typed(4, ' ', 0, true),
      { type: 'manual', pos: 4 },
      { type: 'timer', timerId: 't1' },
      { type: 'deleted', pos: 2 },
      { type: 'cursor', pos: 9 },
      { type: 'result', requestId: 'g1', text: 'x', factIds: [], citeKeys: [] },
      { type: 'accept' },
      { type: 'acceptWord' },
      { type: 'compositionstart' },
    );
    expect(r.effects).toEqual([]);
    expect(r.machine).toBe(c);
    expect(ghostView(r.machine)).toBeNull();
  });

  it('a showing ghost is hidden during composition and restored if the composed text matches', () => {
    const { machine: m } = showing('数据显示', 10);
    const c = run(m, { type: 'compositionstart' });
    expect(c.effects).toEqual([{ type: 'render' }]);
    expect(ghostView(c.machine)).toBeNull();
    expect(c.machine.state.kind).toBe('showing');
    const e = run(c.machine, { type: 'compositionend', pos: 12, composed: '数据' });
    expect(e.machine.composing).toBe(false);
    expect(e.effects).toEqual([{ type: 'render' }]);
    expect(ghostView(e.machine)).toMatchObject({ pos: 12, text: '显示' });
  });

  it('a cancelled composition (nothing composed, cursor unchanged) restores the ghost as it was', () => {
    const { machine: m } = showing(' shows', 10);
    const r = run(m, { type: 'compositionstart' }, { type: 'compositionend', pos: 10, composed: '' });
    expect(ghostView(r.machine)).toMatchObject({ pos: 10, text: ' shows' });
    expect(feedbacks(r.effects)).toEqual([]);
  });

  it('a non-matching composition dismisses the ghost', () => {
    const { machine: m, requestId } = showing(' shows', 10);
    const r = run(m, { type: 'compositionstart' }, { type: 'compositionend', pos: 12, composed: '你好' });
    expect(feedbacks(r.effects)).toEqual([{ type: 'feedback', requestId, outcome: 'dismissed', acceptedText: null }]);
    expect(r.machine.state).toEqual({ kind: 'idle', suppressed: false });
    expect(r.machine.composing).toBe(false);
  });

  it('a matching composition at the wrong position dismisses', () => {
    const { machine: m } = showing('数据显示', 10);
    const r = run(m, { type: 'compositionstart' }, { type: 'compositionend', pos: 40, composed: '数据' });
    expect(r.machine.state.kind).toBe('idle');
  });

  it('composing the whole ghost completes it with accepted', () => {
    const { machine: m, requestId } = showing('数据', 10);
    const r = run(m, { type: 'compositionstart' }, { type: 'compositionend', pos: 12, composed: '数据' });
    expect(feedbacks(r.effects)).toEqual([{ type: 'feedback', requestId, outcome: 'accepted', acceptedText: '数据' }]);
    expect(r.machine.state.kind).toBe('idle');
  });

  it('compositionend with nothing composing is a no-op; idle composition just toggles the flag', () => {
    const m = machine();
    expect(ghostReducer(m, { type: 'compositionend', pos: 0, composed: 'x' }).machine).toBe(m);
    const r = run(m, { type: 'compositionstart' }, { type: 'compositionend', pos: 2, composed: '你好' });
    expect(r.effects).toEqual([]);
    expect(r.machine.composing).toBe(false);
    expect(r.machine.state).toEqual({ kind: 'idle', suppressed: false });
  });

  it('composition keeps the Esc suppression', () => {
    const sup = run(machine(), { type: 'dismiss' }).machine;
    const r = run(sup, { type: 'compositionstart' }, { type: 'compositionend', pos: 2, composed: '你' });
    expect(r.machine.state).toEqual({ kind: 'idle', suppressed: true });
  });

  it('a hidden (mismatched) ghost: empty composition keeps it hidden, real composition dismisses', () => {
    const { machine: m } = showing(' shows', 10);
    const hidden = run(m, typed(11, 'X')).machine;
    const keep = run(hidden, { type: 'compositionstart' }, { type: 'compositionend', pos: 11, composed: '' });
    expect(asShowing(keep.machine.state).hidden).toBe(true);
    const gone = run(hidden, { type: 'compositionstart' }, { type: 'compositionend', pos: 12, composed: '好' });
    expect(gone.machine.state.kind).toBe('idle');
  });

  it('a stale result arriving during composition is dropped (its request was cancelled)', () => {
    const p = run(machine(), { type: 'manual', pos: 1 }).machine;
    const c = run(p, { type: 'compositionstart' }).machine;
    const r = run(c, { type: 'result', requestId: 'g1', text: 'late', factIds: [], citeKeys: [] }, { type: 'compositionend', pos: 1, composed: '' });
    expect(r.effects).toEqual([]);
    expect(ghostView(r.machine)).toBeNull();
  });
});

/* ------------------------------------------------------------------------------------ */
/* Mode changes and external changes                                                     */
/* ------------------------------------------------------------------------------------ */

describe('mode change', () => {
  it('to the same mode is a no-op', () => {
    const m = machine('auto-propose');
    expect(ghostReducer(m, { type: 'modeChanged', mode: 'auto-propose' }).machine).toBe(m);
  });

  it('updates the config and keeps the suppression when idle', () => {
    const sup = run(machine(), { type: 'dismiss' }).machine;
    const r = run(sup, { type: 'modeChanged', mode: 'auto-propose' });
    expect(r.effects).toEqual([]);
    expect(r.machine.config.mode).toBe('auto-propose');
    expect(r.machine.state).toEqual({ kind: 'idle', suppressed: true });
  });

  it('mid-request cancels the request', () => {
    const p = run(machine(), { type: 'manual', pos: 1 }).machine;
    const r = run(p, { type: 'modeChanged', mode: 'questions-only' });
    expect(r.effects).toEqual([{ type: 'cancel', requestId: 'g1' }]);
    expect(r.machine.state.kind).toBe('idle');
    expect(r.machine.config.mode).toBe('questions-only');
    // the late result is dropped
    expect(run(r.machine, { type: 'result', requestId: 'g1', text: 'x', factIds: [], citeKeys: [] }).effects).toEqual([]);
  });

  it('while waiting clears the timer', () => {
    const w = run(machine('auto-propose'), typed(1, ' ', 0, true)).machine;
    expect(run(w, { type: 'modeChanged', mode: 'complete-my-sentence' }).effects).toEqual([{ type: 'clearTimer', timerId: 't1' }]);
  });

  it('while showing expires the ghost', () => {
    const { machine: m, requestId } = showing(' shows', 10);
    const r = run(m, { type: 'modeChanged', mode: 'questions-only' });
    expect(r.effects).toEqual([{ type: 'feedback', requestId, outcome: 'expired', acceptedText: null }, { type: 'render' }]);
    const { machine: m2, requestId: id2 } = showing(' shows a gain.', 10);
    const part = run(m2, { type: 'acceptWord' }, { type: 'modeChanged', mode: 'auto-propose' });
    expect(feedbacks(part.effects)).toEqual([{ type: 'feedback', requestId: id2, outcome: 'expired', acceptedText: ' shows ' }]);
  });

  it('the new mode governs the next triggers', () => {
    const m = run(machine('complete-my-sentence'), { type: 'modeChanged', mode: 'auto-propose' }).machine;
    expect(types(run(m, typed(5, ' ', 0, true)).effects)).toEqual(['startTimer']);
    const q = run(m, { type: 'modeChanged', mode: 'questions-only' }).machine;
    expect(run(q, typed(5, 'x', 9)).effects).toEqual([]);
  });
});

describe('external document change', () => {
  it('expires a showing ghost, cancels pending, clears waiting, ignores idle', () => {
    const { machine: m, requestId } = showing(' shows', 10);
    const r = run(m, { type: 'external' });
    expect(r.effects).toEqual([{ type: 'feedback', requestId, outcome: 'expired', acceptedText: null }, { type: 'render' }]);
    expect(r.machine.state).toEqual({ kind: 'idle', suppressed: false });

    const p = run(machine(), { type: 'manual', pos: 1 }).machine;
    expect(run(p, { type: 'external' }).effects).toEqual([{ type: 'cancel', requestId: 'g1' }]);

    const w = run(machine(), typed(1, 'x', 3)).machine;
    expect(run(w, { type: 'external' }).effects).toEqual([{ type: 'clearTimer', timerId: 't1' }]);

    const sup = run(machine(), { type: 'dismiss' }).machine;
    const ri = ghostReducer(sup, { type: 'external' });
    expect(ri.machine).toBe(sup);
    expect(ri.effects).toEqual([]);
  });

  it('expires a ghost hidden by composition', () => {
    const { machine: m, requestId } = showing(' shows', 10);
    const r = run(m, { type: 'compositionstart' }, { type: 'external' });
    expect(feedbacks(r.effects)).toEqual([{ type: 'feedback', requestId, outcome: 'expired', acceptedText: null }]);
    expect(r.machine.composing).toBe(true);
  });
});

/* ------------------------------------------------------------------------------------ */
/* Totality, immutability, determinism                                                   */
/* ------------------------------------------------------------------------------------ */

describe('totality', () => {
  const allEvents: GhostEvent[] = [
    typed(11, ' ', 3),
    typed(11, 'Q', 4),
    typed(12, ' ', 0, true),
    typed(10, ''),
    { type: 'deleted', pos: 9 },
    { type: 'deleted', pos: 10 },
    { type: 'cursor', pos: 10 },
    { type: 'cursor', pos: 0 },
    { type: 'timer', timerId: 't1' },
    { type: 'timer', timerId: 'nope' },
    { type: 'manual', pos: 10 },
    { type: 'result', requestId: 'g1', text: ' more.', factIds: [], citeKeys: [] },
    { type: 'result', requestId: 'g3', text: ' more.', factIds: [], citeKeys: [] },
    { type: 'empty', requestId: 'g1' },
    { type: 'error', requestId: 'g1' },
    { type: 'compositionstart' },
    { type: 'compositionend', pos: 10, composed: '' },
    { type: 'compositionend', pos: 11, composed: '数' },
    { type: 'accept' },
    { type: 'acceptWord' },
    { type: 'dismiss' },
    { type: 'modeChanged', mode: 'auto-propose' },
    { type: 'modeChanged', mode: 'questions-only' },
    { type: 'modeChanged', mode: 'complete-my-sentence' },
    { type: 'external' },
  ];

  function seedStates(): GhostMachine[] {
    const out: GhostMachine[] = [];
    for (const mode of ['complete-my-sentence', 'auto-propose', 'questions-only'] as GhostMode[]) {
      const m = machine(mode);
      out.push(m);
      out.push(run(m, { type: 'dismiss' }).machine);
      out.push(run(m, { type: 'compositionstart' }).machine);
      out.push(run(m, typed(10, 'x', 3)).machine);
      out.push(run(m, typed(10, ' ', 0, true)).machine);
    }
    const s = showing(' a b.', 10);
    out.push(run(machine(), { type: 'manual', pos: 10 }).machine);
    out.push(s.machine);
    out.push(run(s.machine, typed(11, 'X')).machine);
    out.push(run(s.machine, { type: 'compositionstart' }).machine);
    out.push(run(s.machine, { type: 'acceptWord' }).machine);
    return out;
  }

  it('every event in every state is handled without throwing, never mutates, and is deterministic', () => {
    for (const seed of seedStates()) {
      for (const ev of allEvents) {
        const snapshot = JSON.stringify(seed);
        deepFreeze(seed);
        const a = ghostReducer(seed, ev);
        const b = ghostReducer(seed, ev);
        expect(JSON.stringify(seed)).toBe(snapshot);
        expect(a).toEqual(b);
        expect(Array.isArray(a.effects)).toBe(true);
        // a request never starts while composing or in questions-only
        if (a.machine.composing || seed.config.mode === 'questions-only') {
          if (ev.type !== 'modeChanged') expect(requests(a.effects)).toHaveLength(0);
        }
        // a request is only ever sent by a timer firing or Ctrl+Space
        if (requests(a.effects).length) expect(['timer', 'manual']).toContain(ev.type);
        // an unchanged machine comes back by reference with no effects
        if (a.machine === seed) expect(a.effects).toEqual([]);
      }
    }
  });

  it('random event sequences keep invariants', () => {
    let x = 12345;
    const rand = (n: number) => {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      return x % n;
    };
    for (let trial = 0; trial < 300; trial++) {
      let m = machine((['complete-my-sentence', 'auto-propose', 'questions-only'] as GhostMode[])[trial % 3]);
      const timers = new Set<string>();
      const pendingReqs = new Set<string>();
      for (let i = 0; i < 40; i++) {
        let ev = allEvents[rand(allEvents.length)]!;
        // make timer/result events refer to live ids sometimes
        if (ev.type === 'timer' && m.state.kind === 'waiting' && rand(2)) ev = { type: 'timer', timerId: m.state.timerId };
        if (ev.type === 'result' && m.state.kind === 'pending' && rand(2)) ev = { ...ev, requestId: m.state.requestId };
        deepFreeze(m);
        const r = ghostReducer(m, ev);
        for (const e of r.effects) {
          if (e.type === 'startTimer') timers.add(e.timerId);
          if (e.type === 'clearTimer') {
            expect(timers.has(e.timerId)).toBe(true);
            timers.delete(e.timerId);
          }
          if (e.type === 'request') pendingReqs.add(e.requestId);
          if (e.type === 'cancel') expect(pendingReqs.has(e.requestId)).toBe(true);
        }
        m = r.machine;
        const s = m.state;
        if (s.kind === 'showing') {
          expect(s.original.slice(s.consumed)).toBe(s.text);
          expect(s.text.length).toBeGreaterThan(0);
          expect(s.mismatches).toBeLessThan(2);
        }
        if (s.kind === 'waiting' || s.kind === 'pending') expect(m.composing).toBe(false);
        if (m.config.mode === 'questions-only') expect(['idle']).toContain(s.kind);
      }
    }
  });
});
