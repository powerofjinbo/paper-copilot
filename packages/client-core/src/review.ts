/**
 * Review-queue helpers for draft-then-review mode. Pure.
 * OWNER: client-core agent.
 *
 * Positions are UTF-16 offsets into one file's current text (SentenceUnit.start/end); callers pass the
 * units of the file being edited.
 */
import type { SentenceState, SentenceUnit } from '@paper-copilot/core';

const QUEUE_STATES: ReadonlySet<SentenceState> = new Set<SentenceState>(['proposed', 'unsupported']);

function inQueue(u: SentenceUnit): boolean {
  return QUEUE_STATES.has(u.state);
}

/** Document order: start, then end, then id (deterministic for equal spans). */
function byPosition(a: SentenceUnit, b: SentenceUnit): number {
  return a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Units still awaiting review, in document order: state 'proposed' or 'unsupported'. */
export function reviewQueue(units: SentenceUnit[]): SentenceUnit[] {
  return units.filter(inQueue).sort(byPosition);
}

/**
 * Next (dir 1) or previous (dir -1) unit in the review queue relative to a document position; wraps around; null if the queue is empty.
 *
 * If `pos` lies inside a queued unit (start <= pos <= end; at a shared edge the earlier unit), that unit
 * is the current one and the step goes to its neighbour, so repeated Alt+Down / Alt+Up never stays put
 * while there are at least two queued units. Orphaned units (no valid position after an external change)
 * are skipped: jumping to their stale offsets would land on unrelated text.
 */
export function nextInQueue(units: SentenceUnit[], pos: number, dir: 1 | -1): SentenceUnit | null {
  const q = units.filter((u) => inQueue(u) && !u.orphaned).sort(byPosition);
  if (q.length === 0) return null;
  const current = q.findIndex((u) => u.start <= pos && pos <= u.end);
  if (dir === 1) {
    if (current >= 0) return q[(current + 1) % q.length]!;
    const i = q.findIndex((u) => u.start > pos);
    return q[i >= 0 ? i : 0]!;
  }
  if (current >= 0) return q[(current - 1 + q.length) % q.length]!;
  for (let i = q.length - 1; i >= 0; i--) if (q[i]!.start < pos) return q[i]!;
  return q[q.length - 1]!;
}

/**
 * "12 of 37 reviewed": counts AI-proposed units of the current draft session that the author has acted on.
 *
 * Which units were proposed during this session is not recoverable from the units alone, so the count is
 * defined as: reviewed = units ever touched by the AI (`everAi`) that are no longer 'proposed' or
 * 'unsupported' (accepted, edited, rewritten, rejected into a `[claim: ...?]` placeholder, ...);
 * total = reviewed + the length of the review queue. Hence reviewed <= total, total = 0 for a purely
 * human document, and reviewed === total exactly when the queue is empty.
 */
export function reviewProgress(units: SentenceUnit[]): { reviewed: number; total: number } {
  let reviewed = 0;
  let queued = 0;
  for (const u of units) {
    if (inQueue(u)) queued++;
    else if (u.everAi) reviewed++;
  }
  return { reviewed, total: reviewed + queued };
}

/**
 * The unit containing a position (start <= pos <= end), or null. Binary search over sorted units.
 *
 * Precondition: `units` sorted by start and non-overlapping (as the segmenter produces them), so ends
 * are sorted too. At a shared edge (one unit ends where the next starts) the earlier unit wins; a
 * collapsed unit (start === end) is returned only if no non-empty unit contains `pos`.
 */
export function unitAt(units: SentenceUnit[], pos: number): SentenceUnit | null {
  // first index whose end >= pos
  let lo = 0;
  let hi = units.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (units[mid]!.end < pos) lo = mid + 1;
    else hi = mid;
  }
  let collapsed: SentenceUnit | null = null;
  for (let k = lo; k < units.length; k++) {
    const u = units[k]!;
    if (u.start > pos) break;
    if (pos <= u.end) {
      if (u.end > u.start) return u;
      collapsed ??= u;
    }
  }
  return collapsed;
}
