/**
 * What each tour step highlights and how it knows the author did the step's one thing. Detection is pure
 * over a snapshot of the stores and the DOM (TourCtx), compared with the snapshot taken when the step began
 * (Baseline), so every step works whatever the author did before it (another step, a reset, Back).
 */
import type { TourStepId } from './machine';

export interface TourCtx {
  /** Units of the open file with their current text. */
  units: ReadonlyArray<{ id: string; state: string; text: string }>;
  lint: ReadonlyArray<{ id: string; check: string }>;
  leftTab: string;
  leftCollapsed: boolean;
  /** A sentence card is open in the editor. */
  cardOpen: boolean;
  /** The last submission report (identity changes on every run), null before one. */
  submission: object | null;
  pdfVersion: number | null;
}

export interface Baseline {
  /** The sentence this step highlights (found by its start when the step began). */
  targetId: string | null;
  states: Record<string, string>;
  counts: Record<string, number>;
  lintIds: string[];
  leftTab: string;
  pdfVersion: number | null;
  submission: object | null;
  /** draft: the drafted sentences arrived (then: accept one in ③). */
  drafted: boolean;
}

/** The sentence a step highlights, by the start of its text in the fixture paper. */
export const STEP_SENTENCE: Partial<Record<TourStepId, string>> = {
  card: 'Searches for long-lived particles',
  instruct: 'On isolated displaced particles that neither',
  intent: 'In this paper, we train on generic events only',
  ghost: 'This lead holds for every particle species',
  number: 'The test set holds',
};

const AI_STATES = new Set(['ai-edited', 'ai-drafted', 'ai-from-intent']);

function counts(ctx: TourCtx): Record<string, number> {
  const c: Record<string, number> = {};
  for (const u of ctx.units) c[u.state] = (c[u.state] ?? 0) + 1;
  return c;
}

const n = (c: Record<string, number>, ...states: string[]) => states.reduce((a, s) => a + (c[s] ?? 0), 0);

export function findSentence(ctx: Pick<TourCtx, 'units'>, prefix: string | undefined): string | null {
  if (!prefix) return null;
  return ctx.units.find((u) => u.text.startsWith(prefix))?.id ?? null;
}

export function takeBaseline(step: TourStepId, ctx: TourCtx): Baseline {
  return {
    targetId: findSentence(ctx, STEP_SENTENCE[step]),
    states: Object.fromEntries(ctx.units.map((u) => [u.id, u.state])),
    counts: counts(ctx),
    lintIds: ctx.lint.map((f) => f.id),
    leftTab: ctx.leftTab,
    pdfVersion: ctx.pdfVersion,
    submission: ctx.submission,
    drafted: false,
  };
}

/** Did the author do this step's thing (since `base`)? May note progress in `base` (the draft step). */
export function stepDone(step: TourStepId, ctx: TourCtx, base: Baseline): boolean {
  const c = counts(ctx);
  switch (step) {
    case 'rail':
      return ctx.leftTab !== base.leftTab || ctx.leftTab === 'sources';
    case 'card':
      return ctx.cardOpen;
    case 'instruct': {
      if (n(c, 'ai-edited') > n(base.counts, 'ai-edited')) return true;
      const u = base.targetId ? ctx.units.find((x) => x.id === base.targetId) : undefined;
      return !!u && base.states[u.id] === 'human' && AI_STATES.has(u.state);
    }
    case 'intent':
      return n(c, 'ai-from-intent') > n(base.counts, 'ai-from-intent');
    case 'ghost':
      return n(c, 'ai-drafted') > n(base.counts, 'ai-drafted');
    case 'number':
      return ctx.lint.some((f) => f.check === 'unmatched_number' && !base.lintIds.includes(f.id));
    case 'draft':
      if (n(c, 'proposed', 'unsupported') > n(base.counts, 'proposed', 'unsupported')) base.drafted = true;
      return base.drafted && n(c, 'ai-drafted') > n(base.counts, 'ai-drafted');
    case 'check':
      // a submission check ran (now or before) and a compile showed a PDF since the step began
      return ctx.submission !== null && ctx.pdfVersion !== null && ctx.pdfVersion !== base.pdfVersion;
  }
}

/**
 * What to highlight: a sentence (by id) or an element (CSS selector), following the step's progress
 * (draft: ① Plan, then ③ To do; check: ④, then Compile, then the PDF).
 */
export function stepTarget(step: TourStepId, ctx: TourCtx, base: Baseline): { sentence: string } | { selector: string } | null {
  const panelOpen = (tab: string) => ctx.leftTab === tab && !ctx.leftCollapsed;
  switch (step) {
    case 'rail':
      return { selector: '.rail' };
    case 'draft':
      if (!base.drafted) return panelOpen('plan') ? { selector: '.shell-panel' } : { selector: '.rail [data-step="plan"]' };
      return panelOpen('todo') ? { selector: '.shell-panel' } : { selector: '.rail [data-step="todo"]' };
    case 'check':
      if (ctx.submission === null) {
        return panelOpen('check') ? { selector: '.shell-panel' } : { selector: '.rail [data-step="check"]' };
      }
      if (ctx.pdfVersion === null || ctx.pdfVersion === base.pdfVersion) return { selector: '.compile-split' };
      return { selector: '.shell-pdf, [data-testid="pdf-strip"]' };
    default: {
      const id = base.targetId && ctx.units.some((u) => u.id === base.targetId) ? base.targetId : findSentence(ctx, STEP_SENTENCE[step]);
      return id ? { sentence: id } : null;
    }
  }
}
