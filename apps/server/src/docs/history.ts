/**
 * history.jsonl writer: an append-only, ordered event log next to the versions table.
 *
 * Every version row becomes one `version` event with the before/after hashes and the edit distance;
 * review decisions that change no text (accept, reject, discard orphan) are logged as their own events.
 * Appends are serialized through one promise chain so lines never interleave or reorder.
 */
import { hashString, normalizeForHash, type SentenceVersion } from '@paper-copilot/core';
import type { Logger, PaperFiles } from '../contracts';

export type HistoryEvent =
  | ({ event: 'version'; file: string; hash: string; parentHash: string | null } & SentenceVersion)
  | { event: 'accept' | 'reject' | 'state' | 'orphan_discarded' | 'semantic_lines' | 'semantic_lines_undo' | 'reanchor'; ts: string; sentenceId: string | null; file: string | null; [k: string]: unknown };

export interface HistoryLog {
  versions(file: string, rows: SentenceVersion[], parentText: (row: SentenceVersion) => string | null): void;
  event(e: Extract<HistoryEvent, { event: Exclude<HistoryEvent['event'], 'version'> }>): void;
  /** Resolves when every queued line is on disk. */
  drain(): Promise<void>;
}

export function textHash(text: string): string {
  return hashString(normalizeForHash(text));
}

export function createHistoryLog(path: string, files: PaperFiles, log: Logger): HistoryLog {
  let chain: Promise<void> = Promise.resolve();
  let warned = false;
  const append = (value: unknown): void => {
    chain = chain
      .then(() => files.appendJsonl(path, value))
      .catch((e) => {
        if (!warned) {
          warned = true;
          log.error('cannot append to history.jsonl', String(e));
        }
      });
  };
  return {
    versions(file, rows, parentText) {
      for (const v of rows) {
        const parent = v.parentVersion === null ? null : parentText(v);
        append({ event: 'version', file, hash: textHash(v.text), parentHash: parent === null ? null : textHash(parent), ...v });
      }
    },
    event(e) {
      append(e);
    },
    drain() {
      return chain;
    },
  };
}
