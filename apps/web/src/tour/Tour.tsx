/**
 * The guided tour (新手引导): a spotlight on the real element and a small card beside it (never over it,
 * nor over the sentence card or proposal the author is working with), with Back / Next / Skip. Each step
 * asks the author to do one thing in the demo paper and moves on once it is done (steps.ts), or on Next.
 * Offered once on the first launch of the browser demo; the ? menu starts, continues or restarts it.
 *
 * Keyboard: the card's buttons are ordinary buttons; inside the card ← / → go back / next and Escape
 * pauses the tour. Focus moves to the card only when the tour starts or the author uses its buttons, never
 * while they type in the editor.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { create } from 'zustand';
import type { ApiClient } from '../contracts';
import { isMockClient } from '../api/extras';
import { notify, openStep } from '../components/actions';
import { htmlLang, useT, type MsgKey } from '../i18n';
import { useShell } from '../state/extra';
import { useWorkspace } from '../state/store';
import { currentStep, loadTour, saveTour, shouldOffer, tourReduce, TOUR_STEPS, type TourEvent, type TourState, type TourStepId } from './machine';
import { placeCard, unionRect, type Rect } from './place';
import { stepDone, stepTarget, takeBaseline, type Baseline, type TourCtx } from './steps';
import './tour.css';

interface TourStore {
  state: TourState;
  dispatch(e: TourEvent): void;
}

export const useTour = create<TourStore>((set, get) => ({
  state: loadTour(),
  dispatch: (e) => {
    const next = tourReduce(get().state, e);
    if (next === get().state) return;
    saveTour(next);
    set({ state: next });
  },
}));

/** Key names in our own strings as <kbd>: ⌘+I, Ctrl+Enter, ⌥/, Alt+/, Ctrl+Space, Tab, Enter, Esc. */
const KEY_RE = /((?:⌘|⌥|Ctrl|Alt)(?:\+?(?:Enter|Space|Shift|\/|↓|↑|→|\.|[A-Za-z](?![a-z])))+|\bTab\b|\bEnter\b|\bEsc\b)/;

function withKeys(text: string) {
  return text.split(KEY_RE).map((p, i) => (i % 2 ? <kbd key={i} className="kbd">{p}</kbd> : p));
}

const AVOID = '[data-testid="sentence-card"], [data-testid="proposal"], .pc-intent-render, [data-testid="ghost"], .popover, .help-dialog, .drawer-root';

function snapshot(): TourCtx {
  const ws = useWorkspace.getState();
  const sh = useShell.getState();
  let text = '';
  try {
    text = ws.editor?.getText() ?? '';
  } catch {
    text = '';
  }
  return {
    units: ws.units.map((u) => ({ id: u.id, state: u.state, text: text.slice(u.start, u.end) })),
    lint: ws.lint.map((f) => ({ id: f.id, check: f.check })),
    leftTab: ws.leftTab,
    leftCollapsed: sh.leftCollapsed || sh.fitHidden.left,
    cardOpen: !!document.querySelector('[data-testid="sentence-card"]'),
    submission: sh.submission,
    pdfVersion: ws.compile.pdfVersion,
  };
}

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** The highlighted rectangle (viewport coordinates), clipped to the editor's scroller for a sentence. */
function targetRect(target: ReturnType<typeof stepTarget>): Rect | null {
  if (!target) return null;
  if ('selector' in target) {
    const el = [...document.querySelectorAll(target.selector)].find((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    return el ? rectOf(el) : null;
  }
  const spans = [...document.querySelectorAll(`.cm-content [data-unit="${CSS.escape(target.sentence)}"]`)];
  const rects = spans.flatMap((s) => [...s.getClientRects()].map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height })));
  const u = unionRect(rects);
  if (!u) return null;
  const scroller = document.querySelector('.shell-editor .cm-scroller');
  if (scroller) {
    const s = rectOf(scroller);
    const y0 = Math.max(u.y, s.y);
    const y1 = Math.min(u.y + u.h, s.y + s.h);
    if (y1 - y0 < 8) return null; // scrolled out of view
    return { x: u.x, y: y0, w: u.w, h: y1 - y0 };
  }
  return u;
}

/** Bring the step's place on screen (scroll to its sentence, open its step of the rail). */
function prepare(step: TourStepId, target: ReturnType<typeof stepTarget>): void {
  if (step === 'draft') {
    const tab = useWorkspace.getState().leftTab;
    if (tab !== 'plan' && tab !== 'todo') openStep('plan');
    else useShell.getState().setLeftCollapsed(false);
    return;
  }
  if (step === 'check') return;
  if (target && 'sentence' in target) {
    try {
      useWorkspace.getState().editor?.revealSentence(target.sentence);
    } catch {
      /* the editor is not ready: "Show me where" tries again */
    }
  }
}

const STEP_KEYS: Record<TourStepId, { title: MsgKey; body: MsgKey; act: MsgKey }> = {
  rail: { title: 'tour.rail.title', body: 'tour.rail.body', act: 'tour.rail.do' },
  card: { title: 'tour.card.title', body: 'tour.card.body', act: 'tour.card.do' },
  instruct: { title: 'tour.instruct.title', body: 'tour.instruct.body', act: 'tour.instruct.do' },
  intent: { title: 'tour.intent.title', body: 'tour.intent.body', act: 'tour.intent.do' },
  ghost: { title: 'tour.ghost.title', body: 'tour.ghost.body', act: 'tour.ghost.do' },
  number: { title: 'tour.number.title', body: 'tour.number.body', act: 'tour.number.do' },
  draft: { title: 'tour.draft.title', body: 'tour.draft.body', act: 'tour.draft.do' },
  check: { title: 'tour.check.title', body: 'tour.check.body', act: 'tour.check.do' },
};

/** Start (or continue) the tour from the ? menu or the first-launch offer, with focus on its card. */
export function startTour(restart = false): void {
  useShell.getState().setHelpOpen(false);
  useShell.getState().setSettingsOpen(false);
  // the tour's first step explains the four steps: the first-run hint would say the same twice
  if (!useShell.getState().firstRunDone) useShell.getState().dismissFirstRun();
  useTour.getState().dispatch({ type: restart ? 'restart' : 'start' });
  focusCardSoon();
}

/** Focus requests for the tour card (served once by whichever card is on screen). */
let focusRequest = 0;
let focusServed = 0;
function focusCardSoon(): void {
  focusRequest++;
}

const RESET_KEY = 'paper-copilot.demo.reset';

/** The example paper is about to be reset (a reload): the next load says it was. */
export function markDemoReset(): void {
  try {
    sessionStorage.setItem(RESET_KEY, '1');
  } catch {
    /* blocked storage: no confirmation toast */
  }
}

function takeDemoReset(): boolean {
  try {
    const v = sessionStorage.getItem(RESET_KEY) === '1';
    if (v) sessionStorage.removeItem(RESET_KEY);
    return v;
  } catch {
    return false;
  }
}

function TourOffer() {
  const t = useT();
  const lang = useShell((s) => s.lang);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className="tour-offer" role="dialog" aria-modal="false" aria-labelledby="tour-offer-title" aria-describedby="tour-offer-body" data-testid="tour-offer" lang={htmlLang(lang)} ref={ref}>
      <h2 id="tour-offer-title" className="tour-title">
        {t('tour.offerTitle')}
      </h2>
      <p id="tour-offer-body" className="tour-body">
        {t('tour.offerBody')}
      </p>
      <div className="tour-actions">
        <button type="button" className="btn btn-sm btn-default" onClick={() => useTour.getState().dispatch({ type: 'decline' })} data-testid="tour-offer-later">
          {t('tour.offerLater')}
        </button>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => startTour()} data-testid="tour-offer-start">
          {t('tour.offerStart')}
        </button>
      </div>
    </div>
  );
}

function TourCard({ step, index }: { step: TourStepId; index: number }) {
  const t = useT();
  const lang = useShell((s) => s.lang);
  const dispatch = useTour((s) => s.dispatch);
  const cardRef = useRef<HTMLDivElement>(null);
  const base = useRef<{ step: TourStepId; b: Baseline } | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [done, setDone] = useState(false);
  const [missing, setMissing] = useState(false);
  const keys = STEP_KEYS[step];
  const lastIndex = TOUR_STEPS.length - 1;

  // a new step: take its baseline, bring its place on screen
  useEffect(() => {
    const ctx = snapshot();
    const b = takeBaseline(step, ctx);
    base.current = { step, b };
    setDone(false);
    setMissing(false);
    const timer = setTimeout(() => prepare(step, stepTarget(step, snapshot(), b)), 60);
    return () => clearTimeout(timer);
  }, [step]);

  // follow the target and watch for the step's action (the stores and the DOM change in many ways: poll)
  useEffect(() => {
    let alive = true;
    let misses = 0;
    const tick = () => {
      if (!alive || !base.current || base.current.step !== step) return;
      const ctx = snapshot();
      const b = base.current.b;
      const r = targetRect(stepTarget(step, ctx, b));
      setRect((old) => (old && r && Math.abs(old.x - r.x) < 0.5 && Math.abs(old.y - r.y) < 0.5 && Math.abs(old.w - r.w) < 0.5 && Math.abs(old.h - r.h) < 0.5 ? old : r));
      misses = r ? 0 : misses + 1;
      setMissing(misses > 3);
      if (stepDone(step, ctx, b)) {
        setDone(true);
        useTour.getState().dispatch({ type: 'complete', step });
      }
    };
    tick();
    const id = setInterval(tick, 200);
    const onResize = () => tick();
    window.addEventListener('resize', onResize);
    return () => {
      alive = false;
      clearInterval(id);
      window.removeEventListener('resize', onResize);
    };
  }, [step]);

  // done: say so, then move on (the author can also press Next right away)
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => {
      if (useTour.getState().state.index === index && useTour.getState().state.status === 'running') {
        if (index === lastIndex) notify('info', t('tour.finished'));
        dispatch({ type: 'next' });
      }
    }, 1400);
    return () => clearTimeout(timer);
  }, [done, index, lastIndex, dispatch, t]);

  // place the card beside the target, clear of what the author works with
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const size = { w: el.offsetWidth, h: el.offsetHeight };
    const avoid = [...document.querySelectorAll(AVOID)].filter((e) => !el.contains(e)).map(rectOf).filter((r) => r.w > 0 && r.h > 0);
    const p = placeCard(rect ? pad(rect, 6) : null, size, { w: window.innerWidth, h: window.innerHeight }, avoid);
    setPos((old) => (old && Math.abs(old.x - p.x) < 1 && Math.abs(old.y - p.y) < 1 ? old : { x: p.x, y: p.y }));
  });

  // focus the card when the tour starts (from the menu or the offer), not on every step
  useEffect(() => {
    if (focusServed === focusRequest) return;
    focusServed = focusRequest;
    cardRef.current?.focus({ preventScroll: true });
  });

  const next = useCallback(() => {
    if (index === lastIndex) notify('info', t('tour.finished'));
    else focusCardSoon();
    dispatch({ type: 'next' });
  }, [dispatch, index, lastIndex, t]);
  const back = useCallback(() => {
    focusCardSoon();
    dispatch({ type: 'back' });
  }, [dispatch]);
  const skip = useCallback(() => dispatch({ type: 'skip' }), [dispatch]);
  const showMe = () => {
    const b = base.current?.b;
    if (b) prepare(step, stepTarget(step, snapshot(), b));
    if (step === 'check' && useWorkspace.getState().leftTab !== 'check') openStep('check');
  };

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      skip();
    } else if (e.key === 'ArrowRight' && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      next();
    } else if (e.key === 'ArrowLeft' && !e.altKey && !e.metaKey && !e.ctrlKey && index > 0) {
      e.preventDefault();
      back();
    }
  };

  const spot = rect ? pad(rect, 6) : null;
  return (
    <>
      {spot ? <div className="tour-spot" aria-hidden="true" data-testid="tour-spot" style={{ left: spot.x, top: spot.y, width: spot.w, height: spot.h }} /> : null}
      <div
        ref={cardRef}
        className={`tour-card${done ? ' is-done' : ''}`}
        role="dialog"
        aria-modal="false"
        aria-labelledby="tour-card-title"
        aria-describedby="tour-card-body"
        aria-keyshortcuts="ArrowLeft ArrowRight Escape"
        tabIndex={-1}
        lang={htmlLang(lang)}
        data-testid="tour-card"
        data-step={step}
        onKeyDown={onKey}
        style={pos ? { left: pos.x, top: pos.y } : { right: 16, bottom: 44 }}
      >
        <div className="tour-head">
          <span className="tour-progress" aria-label={t('tour.progress', { n: index + 1, total: TOUR_STEPS.length })}>
            {TOUR_STEPS.map((s, i) => (
              <span key={s} className={`tour-dot${i === index ? ' is-current' : i < index ? ' is-past' : ''}`} aria-hidden="true" />
            ))}
            <span className="tour-progress-text">{t('tour.progress', { n: index + 1, total: TOUR_STEPS.length })}</span>
          </span>
          <button type="button" className="link-btn small tour-skip" onClick={skip} data-testid="tour-skip">
            {t('tour.skip')}
          </button>
        </div>
        <h2 id="tour-card-title" className="tour-title">
          {t(keys.title)}
        </h2>
        <p id="tour-card-body" className="tour-body">
          {t(keys.body)}
        </p>
        <div className="tour-do">
          <span className="tour-do-label">{t('tour.doLabel')}</span>
          <span className="tour-do-text">{withKeys(t(keys.act))}</span>
        </div>
        <p className="tour-status" aria-live="polite">
          {done ? (
            <span className="tour-done" data-testid="tour-done">
              ✓ {t('tour.done')}
            </span>
          ) : missing ? (
            <span className="muted small">{t('tour.notShown')}</span>
          ) : null}
        </p>
        <div className="tour-actions">
          <button type="button" className="btn btn-sm btn-ghost" onClick={showMe} data-testid="tour-show">
            {t('tour.showMe')}
          </button>
          <span className="tour-spacer" />
          <button type="button" className="btn btn-sm btn-default" onClick={back} disabled={index === 0} data-testid="tour-back">
            {t('tour.back')}
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={next} data-testid="tour-next">
            {index === lastIndex ? t('tour.finish') : t('tour.next')}
          </button>
        </div>
      </div>
    </>
  );
}

function pad(r: Rect, p: number): Rect {
  return { x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p };
}

export function Tour({ api }: { api: ApiClient }) {
  const state = useTour((s) => s.state);
  const ready = useWorkspace((s) => s.units.length > 0 && !!s.editor);
  const demo = isMockClient(api);
  const offer = shouldOffer(state, demo) || state.status === 'offered';
  const step = currentStep(state);
  const t = useT();
  useEffect(() => {
    if (ready && shouldOffer(state, demo)) useTour.getState().dispatch({ type: 'offer' });
  }, [ready, state, demo]);
  useEffect(() => {
    if (ready && demo && takeDemoReset()) notify('info', t('demo.resetDone'));
  }, [ready, demo, t]);
  if (!ready) return null;
  if (step) return <TourCard key={step} step={step} index={state.index} />;
  if (offer && demo) return <TourOffer />;
  return null;
}
