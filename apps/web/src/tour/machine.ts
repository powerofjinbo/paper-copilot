/**
 * The guided tour's state machine (pure; Tour.tsx drives it). Eight steps on the demo paper, each asking the
 * author to do one thing; a step advances when that thing is done (`complete`) or on Next. The state is
 * remembered per browser (localStorage, every access in try/catch), so a reload resumes where the author
 * was, a finished or declined tour is not offered again, and the ? menu restarts it.
 */

export const TOUR_STEPS = ['rail', 'card', 'instruct', 'intent', 'ghost', 'number', 'draft', 'check'] as const;
export type TourStepId = (typeof TOUR_STEPS)[number];

/**
 * new: never seen · offered: the first-launch offer is on screen · declined: "Not now" · running · paused:
 * skipped part-way (the ? menu continues it) · finished.
 */
export type TourStatus = 'new' | 'offered' | 'declined' | 'running' | 'paused' | 'finished';

export interface TourState {
  status: TourStatus;
  /** Index of the current step in TOUR_STEPS (kept while paused, so the tour can continue there). */
  index: number;
  /** Steps whose action the author did (in any order). */
  done: TourStepId[];
}

export type TourEvent =
  | { type: 'offer' }
  | { type: 'decline' }
  | { type: 'start' }
  | { type: 'restart' }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'skip' }
  | { type: 'complete'; step: TourStepId };

export const INITIAL_TOUR: TourState = { status: 'new', index: 0, done: [] };

const last = TOUR_STEPS.length - 1;

export function currentStep(s: TourState): TourStepId | null {
  return s.status === 'running' ? TOUR_STEPS[s.index] ?? null : null;
}

export function tourReduce(s: TourState, e: TourEvent): TourState {
  switch (e.type) {
    case 'offer':
      return s.status === 'new' ? { ...s, status: 'offered' } : s;
    case 'decline':
      return s.status === 'offered' ? { ...s, status: 'declined' } : s;
    case 'start':
      // continue a paused tour where it stopped; anything else starts from the first step
      if (s.status === 'running') return s;
      if (s.status === 'paused') return { ...s, status: 'running' };
      return { status: 'running', index: 0, done: s.status === 'finished' ? [] : s.done };
    case 'restart':
      return { status: 'running', index: 0, done: [] };
    case 'next':
      if (s.status !== 'running') return s;
      return s.index >= last ? { ...s, status: 'finished', index: last } : { ...s, index: s.index + 1 };
    case 'back':
      return s.status === 'running' && s.index > 0 ? { ...s, index: s.index - 1 } : s;
    case 'skip':
      return s.status === 'running' ? { ...s, status: 'paused' } : s.status === 'offered' ? { ...s, status: 'declined' } : s;
    case 'complete': {
      if (s.done.includes(e.step)) return s;
      return { ...s, done: [...s.done, e.step] };
    }
  }
}

/** Offer the tour on its own only in the browser demo, and only to someone who never saw it. */
export function shouldOffer(s: TourState, demo: boolean): boolean {
  return demo && s.status === 'new';
}

/** The ? menu entry: continue a paused tour, or take it (again). */
export function menuEntry(s: TourState): { kind: 'resume' | 'start'; step: number } {
  return s.status === 'paused' && s.index > 0 ? { kind: 'resume', step: s.index + 1 } : { kind: 'start', step: 1 };
}

export const TOUR_KEY = 'paper-copilot.tour.v1';

const STATUSES: readonly TourStatus[] = ['new', 'offered', 'declined', 'running', 'paused', 'finished'];

export function parseTour(raw: string | null | undefined): TourState {
  if (!raw) return { ...INITIAL_TOUR };
  try {
    const p = JSON.parse(raw) as Partial<TourState>;
    let status: TourStatus = STATUSES.includes(p.status as TourStatus) ? (p.status as TourStatus) : 'new';
    // an offer left on screen at the last reload counts as not yet answered
    if (status === 'offered') status = 'new';
    const index = Number.isInteger(p.index) ? Math.min(last, Math.max(0, p.index as number)) : 0;
    const done = Array.isArray(p.done) ? TOUR_STEPS.filter((id) => (p.done as unknown[]).includes(id)) : [];
    return { status, index, done };
  } catch {
    return { ...INITIAL_TOUR };
  }
}

export function loadTour(storage: Pick<Storage, 'getItem'> | null | undefined = safeStorage()): TourState {
  try {
    return parseTour(storage?.getItem(TOUR_KEY));
  } catch {
    return { ...INITIAL_TOUR };
  }
}

export function saveTour(s: TourState, storage: Pick<Storage, 'setItem'> | null | undefined = safeStorage()): void {
  try {
    storage?.setItem(TOUR_KEY, JSON.stringify(s));
  } catch {
    /* private window or blocked storage: the tour state lasts for this page */
  }
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
