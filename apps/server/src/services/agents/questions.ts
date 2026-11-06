/**
 * Referee questions in .paper/questions.json: `{ [sectionId]: RefereeQuestion[] }` (at most four per
 * section, newest pass replaces the section's list). A flat RefereeQuestion[] is also accepted on read.
 */
import { RefereeQuestion } from '@paper-copilot/core';
import { z } from 'zod';
import type { PaperFiles } from '../../contracts';

export const QuestionsFile = z.union([z.record(z.string(), z.array(RefereeQuestion)), z.array(RefereeQuestion)]);

export const MAX_QUESTIONS = 4;

export function readQuestions(files: PaperFiles, path: string): Record<string, RefereeQuestion[]> {
  const raw = files.readJson(path, QuestionsFile, {});
  if (!Array.isArray(raw)) return raw;
  const out: Record<string, RefereeQuestion[]> = {};
  for (const q of raw) (out[q.sectionId] ??= []).push(q);
  return out;
}

/** Serialize async critical sections (read-modify-write of one file). */
export function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
