/**
 * The left rail's information architecture: four steps in writing order (① Plan, ② Sources, ③ To do,
 * ④ Check & submit), the mapping of the older panel names onto them, and the pure logic behind the
 * merged To-do list and the badges. No React here, so it is unit-tested directly (test/steps.test.ts).
 */
import type { PlaceholderKind, RefereeQuestion, SentenceUnit, SubmissionReport } from '@paper-copilot/core';
import type { LeftStep, LeftTab, ProjectFileInfo } from '../contracts';

export const STEPS: readonly LeftStep[] = ['plan', 'sources', 'todo', 'check'];

/** Sections a step can be asked to open and scroll to (focusSection). */
export type StepSection =
  | 'outline'
  | 'framings'
  | 'facts'
  | 'lit'
  | 'review'
  | 'placeholders'
  | 'questions'
  | 'submission'
  | 'consistency'
  | 'terminology'
  | 'figures'
  | 'disclosure'
  | 'sync';

/** The step an older panel name (or a step) belongs to; 'voice' lives in Settings (null). */
export function stepOf(tab: LeftTab | string | null | undefined): LeftStep | null {
  switch (tab) {
    case 'plan':
    case 'outline':
      return 'plan';
    case 'sources':
    case 'facts':
    case 'lit':
      return 'sources';
    case 'todo':
    case 'review':
    case 'placeholders':
    case 'questions':
      return 'todo';
    case 'check':
    case 'sync':
    case 'submission':
    case 'consistency':
    case 'terminology':
    case 'figures':
    case 'disclosure':
      return 'check';
    default:
      return null;
  }
}

/** The section an older panel name points at inside its step (null for a bare step). */
export function sectionOf(tab: LeftTab | string): StepSection | null {
  switch (tab) {
    case 'outline':
    case 'facts':
    case 'lit':
    case 'review':
    case 'placeholders':
    case 'questions':
    case 'sync':
    case 'submission':
    case 'consistency':
    case 'terminology':
    case 'figures':
    case 'disclosure':
      return tab;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------------------------ */
/* ③ To do: one list of review items, placeholders and referee questions                  */
/* ------------------------------------------------------------------------------------ */

export type TodoGroupKind = 'review' | 'placeholders' | 'questions';

export interface TodoReviewItem {
  kind: 'review';
  key: string;
  unit: SentenceUnit;
}
export interface TodoPlaceholderItem {
  kind: 'placeholder';
  key: string;
  unit: SentenceUnit;
  placeholder: string;
  phKind: PlaceholderKind;
}
export interface TodoQuestionItem {
  kind: 'question';
  key: string;
  question: RefereeQuestion;
}
export type TodoItem = TodoReviewItem | TodoPlaceholderItem | TodoQuestionItem;

export interface TodoGroup {
  kind: TodoGroupKind;
  items: TodoItem[];
}

export function isReviewState(state: SentenceUnit['state']): boolean {
  return state === 'proposed' || state === 'unsupported';
}

/**
 * The To-do groups in a fixed order (review, placeholders, questions). Review and placeholder items are
 * in document order; questions follow the section order given (unknown sections last). Empty groups are
 * kept (the panel shows their headers only when non-empty).
 */
export function buildTodo(
  units: readonly SentenceUnit[],
  questions: readonly RefereeQuestion[],
  classify: (placeholder: string) => PlaceholderKind,
  sectionOrder: readonly string[] = [],
): TodoGroup[] {
  const ordered = [...units].sort((a, b) => a.start - b.start);
  const review: TodoItem[] = [];
  const ph: TodoItem[] = [];
  for (const u of ordered) {
    if (isReviewState(u.state)) review.push({ kind: 'review', key: `r:${u.id}`, unit: u });
    u.placeholders.forEach((p, i) => ph.push({ kind: 'placeholder', key: `p:${u.id}:${i}`, unit: u, placeholder: p, phKind: classify(p) }));
  }
  const rank = new Map(sectionOrder.map((s, i) => [s, i]));
  const qs = questions
    .map((q, i) => ({ q, i }))
    .sort((a, b) => (rank.get(a.q.sectionId) ?? 1e6) - (rank.get(b.q.sectionId) ?? 1e6) || a.i - b.i)
    .map(({ q }): TodoItem => ({ kind: 'question', key: `q:${q.id}`, question: q }));
  return [
    { kind: 'review', items: review },
    { kind: 'placeholders', items: ph },
    { kind: 'questions', items: qs },
  ];
}

/** Open items the ③ badge counts: sentences to review plus placeholders (questions are notes, never "done"). */
export function openTodoCount(units: readonly SentenceUnit[]): number {
  let n = 0;
  for (const u of units) {
    if (isReviewState(u.state)) n++;
    n += u.placeholders.length;
  }
  return n;
}

/**
 * Open items in the OTHER files of the project (from GET /api/files), so the To-do list can say where else
 * work waits. The open file is excluded: its live units are the truth.
 */
export function otherFileTodo(files: readonly ProjectFileInfo[], openFile: string | null): Array<{ file: string; review: number; placeholders: number }> {
  return files
    .filter((f) => f.file !== openFile && f.proposed + f.unsupported + f.placeholders > 0)
    .map((f) => ({ file: f.file, review: f.proposed + f.unsupported, placeholders: f.placeholders }));
}

/* ------------------------------------------------------------------------------------ */
/* Submission status (top-bar pill, ④ badge)                                              */
/* ------------------------------------------------------------------------------------ */

export type SubmissionTone = 'unknown' | 'ready' | 'issues' | 'blocked';

/** green "ready" when nothing blocks; amber "n issues" otherwise (blockers + warnings). */
export function submissionStatus(r: SubmissionReport | null): { tone: SubmissionTone; issues: number; blockers: number } {
  if (!r) return { tone: 'unknown', issues: 0, blockers: 0 };
  const failing = r.items.filter((i) => !i.ok && i.severity !== 'info');
  const blockers = failing.filter((i) => i.severity === 'block').length;
  if (blockers > 0) return { tone: 'blocked', issues: failing.length, blockers };
  return { tone: failing.length ? 'issues' : 'ready', issues: failing.length, blockers: 0 };
}

/** Submission items for display: failing blockers first, then failing warnings, then the rest (stable). */
export function orderSubmissionItems(r: SubmissionReport): SubmissionReport['items'] {
  const rank = (i: SubmissionReport['items'][number]) => (i.ok ? 3 : i.severity === 'block' ? 0 : i.severity === 'warn' ? 1 : 2);
  return r.items.map((it, idx) => ({ it, idx })).sort((a, b) => rank(a.it) - rank(b.it) || a.idx - b.idx).map((x) => x.it);
}

/* ------------------------------------------------------------------------------------ */
/* First-run hint (dismissable, remembered)                                              */
/* ------------------------------------------------------------------------------------ */

const FIRST_RUN_KEY = 'paper-copilot.firstRun.v1';

export function firstRunSeen(storage: Pick<Storage, 'getItem'> | null | undefined = safeStorage()): boolean {
  try {
    return storage?.getItem(FIRST_RUN_KEY) === '1';
  } catch {
    return false;
  }
}

export function markFirstRunSeen(storage: Pick<Storage, 'setItem'> | null | undefined = safeStorage()): void {
  try {
    storage?.setItem(FIRST_RUN_KEY, '1');
  } catch {
    /* blocked storage: the hint shows again next time, which is harmless */
  }
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
