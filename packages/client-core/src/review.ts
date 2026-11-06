/**
 * Review-queue helpers for draft-then-review mode. Pure.
 * OWNER: client-core agent.
 */
import type { SentenceUnit } from '@paper-copilot/core';
import { notImplemented } from '@paper-copilot/core';

/** Units still awaiting review, in document order: state 'proposed' or 'unsupported'. */
export function reviewQueue(units: SentenceUnit[]): SentenceUnit[] {
  return notImplemented('reviewQueue', units);
}

/** Next (dir 1) or previous (dir -1) unit in the review queue relative to a document position; wraps around; null if the queue is empty. */
export function nextInQueue(units: SentenceUnit[], pos: number, dir: 1 | -1): SentenceUnit | null {
  return notImplemented('nextInQueue', units, pos, dir);
}

/** "12 of 37 reviewed": counts AI-proposed units of the current draft session that the author has acted on. */
export function reviewProgress(units: SentenceUnit[]): { reviewed: number; total: number } {
  return notImplemented('reviewProgress', units);
}

/** The unit containing a position (start <= pos <= end), or null. Binary search over sorted units. */
export function unitAt(units: SentenceUnit[], pos: number): SentenceUnit | null {
  return notImplemented('unitAt', units, pos);
}
