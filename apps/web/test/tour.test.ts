/** The guided tour: state machine, persistence, step detection and card placement (pure parts of src/tour). */
import { describe, expect, it } from 'vitest';
import { INITIAL_TOUR, TOUR_KEY, TOUR_STEPS, currentStep, loadTour, menuEntry, parseTour, saveTour, shouldOffer, tourReduce, type TourEvent, type TourState } from '../src/tour/machine';
import { intersects, placeCard, unionRect } from '../src/tour/place';
import { findSentence, stepDone, stepTarget, takeBaseline, type TourCtx } from '../src/tour/steps';
import { texInstallKeys, isNoTex } from '../src/components/TexInstall';

const run = (events: TourEvent[], from: TourState = INITIAL_TOUR) => events.reduce(tourReduce, from);

describe('tour state machine', () => {
  it('has 6-8 steps in the order of the brief', () => {
    expect(TOUR_STEPS).toEqual(['rail', 'card', 'instruct', 'intent', 'ghost', 'number', 'draft', 'check']);
  });

  it('offers once, only in the demo; Not now is final', () => {
    expect(shouldOffer(INITIAL_TOUR, true)).toBe(true);
    expect(shouldOffer(INITIAL_TOUR, false)).toBe(false);
    const declined = run([{ type: 'offer' }, { type: 'decline' }]);
    expect(declined.status).toBe('declined');
    expect(shouldOffer(declined, true)).toBe(false);
    // decline only answers an offer
    expect(tourReduce(INITIAL_TOUR, { type: 'decline' })).toBe(INITIAL_TOUR);
  });

  it('Next / Back move through the steps; Next on the last step finishes', () => {
    let s = run([{ type: 'offer' }, { type: 'start' }]);
    expect(currentStep(s)).toBe('rail');
    expect(tourReduce(s, { type: 'back' })).toBe(s);
    s = run([{ type: 'next' }, { type: 'next' }, { type: 'back' }], s);
    expect(currentStep(s)).toBe('card');
    for (let i = 0; i < TOUR_STEPS.length - 1; i++) s = tourReduce(s, { type: 'next' });
    expect(s.status).toBe('finished');
    expect(currentStep(s)).toBeNull();
    expect(shouldOffer(s, true)).toBe(false);
  });

  it('complete records the step once, in any order, without moving', () => {
    let s = run([{ type: 'start' }]);
    s = run([{ type: 'complete', step: 'number' }, { type: 'complete', step: 'rail' }, { type: 'complete', step: 'rail' }], s);
    expect(s.done).toEqual(['number', 'rail']);
    expect(s.index).toBe(0);
  });

  it('Skip pauses; the ? menu continues there or starts over', () => {
    let s = run([{ type: 'start' }, { type: 'next' }, { type: 'next' }, { type: 'skip' }]);
    expect(s.status).toBe('paused');
    expect(currentStep(s)).toBeNull();
    expect(menuEntry(s)).toEqual({ kind: 'resume', step: 3 });
    expect(currentStep(tourReduce(s, { type: 'start' }))).toBe('instruct');
    const over = tourReduce(s, { type: 'restart' });
    expect(currentStep(over)).toBe('rail');
    expect(over.done).toEqual([]);
    // a finished tour starts from the beginning again
    const fin: TourState = { status: 'finished', index: 7, done: [...TOUR_STEPS] };
    expect(menuEntry(fin)).toEqual({ kind: 'start', step: 1 });
    expect(tourReduce(fin, { type: 'start' })).toEqual({ status: 'running', index: 0, done: [] });
    // Skip on the offer = Not now
    expect(run([{ type: 'offer' }, { type: 'skip' }]).status).toBe('declined');
  });

  it('persists through storage that may be missing, full or hostile', () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const s: TourState = { status: 'paused', index: 4, done: ['rail', 'card'] };
    saveTour(s, store);
    expect(JSON.parse(mem.get(TOUR_KEY)!)).toEqual(s);
    expect(loadTour(store)).toEqual(s);
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    };
    expect(loadTour(throwing)).toEqual(INITIAL_TOUR);
    expect(() => saveTour(s, throwing)).not.toThrow();
    expect(loadTour(null)).toEqual(INITIAL_TOUR);
    expect(parseTour('{not json')).toEqual(INITIAL_TOUR);
    expect(parseTour(JSON.stringify({ status: 'bogus', index: 99, done: ['rail', 'nope'] }))).toEqual({ status: 'new', index: 7, done: ['rail'] });
    // an offer nobody answered before the reload is offered again
    expect(parseTour(JSON.stringify({ status: 'offered', index: 0, done: [] })).status).toBe('new');
  });
});

function ctx(over: Partial<TourCtx> = {}): TourCtx {
  return {
    units: [
      { id: 'a', state: 'human', text: 'Searches for long-lived particles look for tracks.' },
      { id: 'b', state: 'human', text: 'On isolated displaced particles that neither model saw, it finds 96.94\\%.' },
      { id: 'c', state: 'human', text: 'The test set holds 8,710 targets.' },
    ],
    lint: [{ id: 'l1', check: 'unmatched_number' }],
    leftTab: 'plan',
    leftCollapsed: false,
    cardOpen: false,
    submission: null,
    pdfVersion: null,
    ...over,
  };
}

describe('tour step detection', () => {
  it('rail: another step of the rail opened', () => {
    const base = takeBaseline('rail', ctx());
    expect(stepDone('rail', ctx(), base)).toBe(false);
    expect(stepDone('rail', ctx({ leftTab: 'sources' }), base)).toBe(true);
  });

  it('card: a sentence card is open', () => {
    const base = takeBaseline('card', ctx());
    expect(base.targetId).toBe('a');
    expect(stepDone('card', ctx({ cardOpen: true }), base)).toBe(true);
  });

  it('instruct: the highlighted sentence became AI-edited (accepted), not merely proposed', () => {
    const c0 = ctx();
    const base = takeBaseline('instruct', c0);
    expect(base.targetId).toBe('b');
    const units = c0.units.map((u) => (u.id === 'b' ? { ...u, state: 'proposed' } : u));
    expect(stepDone('instruct', ctx({ units }), base)).toBe(false);
    const accepted = c0.units.map((u) => (u.id === 'b' ? { ...u, state: 'ai-edited', text: 'Compared with 94.62\\%, ...' } : u));
    expect(stepDone('instruct', ctx({ units: accepted }), base)).toBe(true);
  });

  it('intent and ghost: a new sentence rendered from a note / accepted from ghost text', () => {
    const c0 = ctx();
    const add = (state: string) => ctx({ units: [...c0.units, { id: 'n', state, text: 'We train on generic events only.' }] });
    expect(stepDone('intent', add('ai-from-intent'), takeBaseline('intent', c0))).toBe(true);
    expect(stepDone('intent', add('ai-drafted'), takeBaseline('intent', c0))).toBe(false);
    expect(stepDone('ghost', add('ai-drafted'), takeBaseline('ghost', c0))).toBe(true);
    expect(stepDone('ghost', add('human'), takeBaseline('ghost', c0))).toBe(false);
  });

  it('number: a NEW unmatched-number flag (not one that was already there)', () => {
    const base = takeBaseline('number', ctx());
    expect(base.targetId).toBe('c');
    expect(stepDone('number', ctx(), base)).toBe(false);
    expect(stepDone('number', ctx({ lint: [{ id: 'l1', check: 'unmatched_number' }, { id: 'l2', check: 'long' }] }), base)).toBe(false);
    expect(stepDone('number', ctx({ lint: [{ id: 'l1', check: 'unmatched_number' }, { id: 'l9', check: 'unmatched_number' }] }), base)).toBe(true);
  });

  it('draft: the draft arrives, then one of its sentences is accepted; the highlight follows ① then ③', () => {
    const c0 = ctx();
    const base = takeBaseline('draft', c0);
    expect(stepTarget('draft', c0, base)).toEqual({ selector: '.shell-panel' });
    expect(stepTarget('draft', ctx({ leftTab: 'todo' }), base)).toEqual({ selector: '.rail [data-step="plan"]' });
    const drafted = ctx({ units: [...c0.units, { id: 'd1', state: 'proposed', text: 'x' }, { id: 'd2', state: 'proposed', text: 'y' }] });
    expect(stepDone('draft', drafted, base)).toBe(false);
    expect(base.drafted).toBe(true);
    expect(stepTarget('draft', drafted, base)).toEqual({ selector: '.rail [data-step="todo"]' });
    const accepted = ctx({ leftTab: 'todo', units: [...c0.units, { id: 'd1', state: 'ai-drafted', text: 'x' }, { id: 'd2', state: 'proposed', text: 'y' }] });
    expect(stepTarget('draft', accepted, base)).toEqual({ selector: '.shell-panel' });
    expect(stepDone('draft', accepted, base)).toBe(true);
  });

  it('check: a submission check, then a compile that shows a PDF; the highlight moves ④ -> Compile -> PDF', () => {
    const c0 = ctx();
    const base = takeBaseline('check', c0);
    expect(stepTarget('check', c0, base)).toEqual({ selector: '.rail [data-step="check"]' });
    const report = {};
    const checked = ctx({ leftTab: 'check', submission: report });
    expect(stepDone('check', checked, base)).toBe(false);
    expect(stepTarget('check', checked, base)).toEqual({ selector: '.compile-split' });
    const compiled = ctx({ leftTab: 'check', submission: report, pdfVersion: 1 });
    expect(stepDone('check', compiled, base)).toBe(true);
    expect(stepTarget('check', compiled, base)).toEqual({ selector: '.shell-pdf, [data-testid="pdf-strip"]' });
    // a PDF from before the step does not count
    const old = takeBaseline('check', ctx({ pdfVersion: 3 }));
    expect(stepDone('check', ctx({ submission: report, pdfVersion: 3 }), old)).toBe(false);
  });

  it('a sentence step keeps highlighting its sentence after the text changed (by id), and finds it by its start', () => {
    const c0 = ctx();
    const base = takeBaseline('instruct', c0);
    const changed = ctx({ units: c0.units.map((u) => (u.id === 'b' ? { ...u, text: 'Compared with the baseline, ...' } : u)) });
    expect(stepTarget('instruct', changed, base)).toEqual({ sentence: 'b' });
    expect(findSentence(c0, 'The test set holds')).toBe('c');
    expect(findSentence(c0, 'Nothing like this')).toBeNull();
  });
});

describe('tour card placement', () => {
  const view = { w: 1440, h: 900 };
  const card = { w: 340, h: 220 };
  it('goes beside the target and never over it', () => {
    const target = { x: 600, y: 400, w: 400, h: 40 };
    const p = placeCard(target, card, view);
    expect(p.side).toBe('right');
    expect(intersects({ x: p.x, y: p.y, ...card }, target)).toBe(false);
  });

  it('avoids the sentence card the author is using, and stays inside the window', () => {
    const target = { x: 620, y: 450, w: 700, h: 50 };
    const sentenceCard = { x: 630, y: 505, w: 540, h: 140 };
    const p = placeCard(target, card, view, [sentenceCard]);
    const r = { x: p.x, y: p.y, ...card };
    expect(intersects(r, target)).toBe(false);
    expect(intersects(r, sentenceCard)).toBe(false);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w).toBeLessThanOrEqual(view.w);
    expect(r.y + r.h).toBeLessThanOrEqual(view.h);
  });

  it('a target as large as the window: the least overlap; no target: bottom-right corner', () => {
    const p = placeCard({ x: 0, y: 0, w: 1440, h: 900 }, card, view);
    expect(p.side).toBe('corner');
    const q = placeCard(null, card, view);
    expect(q).toEqual({ x: view.w - card.w - 12, y: view.h - card.h - 12, side: 'corner' });
  });

  it('unionRect ignores empty rectangles', () => {
    expect(unionRect([])).toBeNull();
    expect(unionRect([{ x: 10, y: 10, w: 0, h: 5 }, { x: 20, y: 30, w: 10, h: 10 }, { x: 5, y: 35, w: 10, h: 20 }])).toEqual({ x: 5, y: 30, w: 25, h: 25 });
  });
});

describe('LaTeX not installed', () => {
  it('recognises the server message and orders the install lines by OS', () => {
    const err = { state: 'error', errors: [{ message: 'latexmk was not found on PATH. Install TeX: `brew install --cask mactex-no-gui` ...' }], logTail: '' };
    expect(isNoTex(err)).toBe(true);
    expect(isNoTex({ ...err, state: 'ok' })).toBe(false);
    expect(isNoTex({ state: 'error', errors: [{ message: 'Undefined control sequence.' }], logTail: '' })).toBe(false);
    expect(texInstallKeys(true)[0]).toBe('tex.installMac');
    expect(texInstallKeys(false)[0]).toBe('tex.installLinux');
  });
});
