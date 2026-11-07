/**
 * Navigation helpers for the ④ Check reports: every report row carries a SentenceRef (sentenceId, file,
 * line) or bare sentence ids (flags). `refIndex` collects sentenceId -> {file, line} from anything in a
 * report, so a flag's ids can be revealed in the right file (switching files first).
 */
import { revealLine, revealSentence } from '../../components/actions';

export interface RefTarget {
  sentenceId: string | null;
  file: string | null;
  line: number | null;
}

/** sentenceId -> {file, line} from every object in `report` that has `sentenceId` and `file` (pure). */
export function refIndex(report: unknown): Map<string, { file: string; line: number | null }> {
  const out = new Map<string, { file: string; line: number | null }>();
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== 'object' || depth > 8 || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    if (typeof o.sentenceId === 'string' && typeof o.file === 'string' && !out.has(o.sentenceId)) {
      out.set(o.sentenceId, { file: o.file, line: typeof o.line === 'number' ? o.line : null });
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(report, 0);
  return out;
}

/** Reveal a report target: the sentence when known (in its file), else the line. */
export function goRef(r: RefTarget, openCard = false): void {
  if (r.sentenceId) revealSentence(r.sentenceId, openCard, r.file);
  else if (r.line !== null) revealLine(r.line, r.file);
}

/** Reveal a sentence id found in a report, looking its file up in the index. */
export function goId(index: Map<string, { file: string; line: number | null }>, id: string): void {
  const hit = index.get(id);
  goRef({ sentenceId: id, file: hit?.file ?? null, line: hit?.line ?? null });
}
