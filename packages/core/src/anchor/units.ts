/**
 * Stable sentence identity across local edits, re-segmentation, pulls and edits made outside the app.
 *
 * OWNER: core-anchoring agent. Replace the `notImplemented` bodies; keep the exported signatures.
 *
 * Pipeline used by the server after every debounce (local typing) and after every pull/disk change:
 *   1. units' spans are mapped into the new text: `mapUnits(units, changes)` (local, exact ChangeSet)
 *      or `diffChanges(old, new)` + `mapUnits` (external, via diff-match-patch).
 *   2. the new text is segmented (`segment()`).
 *   3. `assignUnits()` matches new segments to previous units, keeps ids, creates new units, evolves
 *      provenance states, and emits version rows, edit pairs and a report.
 */
import { ChangeSet, type ChangeDesc, type ChangeSpec } from '@codemirror/state';
import DiffMatchPatch from 'diff-match-patch';
import type { ChangeAnnotation, ReanchorReport } from '../api';
import type { EditPair, SentenceUnit, SentenceVersion } from '../schemas';
import type { Segmentation } from '../latex/segment';
import { assignUnitsImpl } from './assign';
import { LineTable } from './lines';

/**
 * Map unit spans through a change set. `start` maps with assoc +1 (text inserted exactly at a sentence
 * start is NOT part of it), `end` with assoc -1 (text inserted exactly at its end is not part of it).
 * Units whose span collapses (start >= end) are kept with start === end; assignUnits removes them.
 * If `newText` is given, `line` is recomputed.
 */
export function mapUnits(units: SentenceUnit[], changes: ChangeDesc, newText?: string): SentenceUnit[] {
  const oldLen = changes.length;
  const lines = newText !== undefined ? new LineTable(newText) : null;
  const clamp = (p: number): number => (p < 0 ? 0 : p > oldLen ? oldLen : p);
  return units.map((u) => {
    // Defensive clamp: a span outside the old document would make mapPos throw.
    const s0 = clamp(u.start);
    const e0 = Math.max(s0, clamp(u.end));
    const start = changes.mapPos(s0, 1);
    let end = changes.mapPos(e0, -1);
    if (end < start) end = start;
    const line = lines ? lines.lineOf(start) : u.line;
    if (start === u.start && end === u.end && line === u.line) return u;
    return { ...u, start, end, line };
  });
}

/** Ranges touched by a change set, in new-document coordinates, merged and sorted. */
export function changedRanges(changes: ChangeDesc): Array<{ from: number; to: number }> {
  const raw: Array<{ from: number; to: number }> = [];
  changes.iterChangedRanges((_fromA, _toA, fromB, toB) => raw.push({ from: fromB, to: toB }));
  raw.sort((a, b) => a.from - b.from || a.to - b.to);
  const out: Array<{ from: number; to: number }> = [];
  for (const r of raw) {
    const last = out[out.length - 1];
    // Overlapping or touching ranges merge (a deletion point next to an insertion is one region).
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else out.push({ from: r.from, to: r.to });
  }
  return out;
}

/** A ChangeSet that turns `oldText` into `newText`, computed with diff-match-patch (semantic cleanup). */
export function diffChanges(oldText: string, newText: string): ChangeSet {
  if (oldText === newText) return ChangeSet.empty(oldText.length);
  const dmp = new DiffMatchPatch();
  // No deadline: the diff must be deterministic. Line mode keeps large documents fast.
  dmp.Diff_Timeout = 0;
  const diffs = dmp.diff_main(oldText, newText, true);
  dmp.diff_cleanupSemantic(diffs);
  const specs: ChangeSpec[] = [];
  let pos = 0;
  let pending: { from: number; to: number; insert: string } | null = null;
  const flush = (): void => {
    if (pending && (pending.to > pending.from || pending.insert.length > 0)) specs.push(pending);
    pending = null;
  };
  for (const [op, chunk] of diffs) {
    if (op === 0) {
      flush();
      pos += chunk.length;
    } else if (op === -1) {
      pending ??= { from: pos, to: pos, insert: '' };
      pending.to += chunk.length;
      pos += chunk.length;
    } else {
      pending ??= { from: pos, to: pos, insert: '' };
      pending.insert += chunk;
    }
  }
  flush();
  // Split inserted text on '\n' only, so '\r\n' keeps its two code units and offsets stay exact.
  return ChangeSet.of(specs, oldText.length, '\n');
}

export interface TextAnalysis {
  cites: string[];
  placeholders: string[];
}

export interface AssignInput {
  file: string;
  /** The new text the segmentation was computed on. */
  text: string;
  seg: Segmentation;
  /** Previous units of this file, spans ALREADY mapped into `text` coordinates. */
  prev: SentenceUnit[];
  /** Last version row of each previous unit, and its last AI version (for edit distance), by unit id. */
  lastVersion: (id: string) => SentenceVersion | undefined;
  lastAiVersion: (id: string) => SentenceVersion | undefined;
  /**
   * Regions changed since the previous segmentation, in `text` coordinates. Units whose mapped span
   * does not intersect any dirty region and whose segment text is identical keep every field. Omit to
   * treat the whole document as dirty (import, open, pull).
   */
  dirty?: Array<{ from: number; to: number }>;
  /** 'local' = the author typed or applied an AI proposal in the app; 'external' = pulled/disk change. */
  changeSource: 'local' | 'external';
  /** Present when the change came from an AI transaction (ghost accept, rewrite, draft insert...). */
  annotation?: ChangeAnnotation | null;
  /** Range of the annotated change in `text` coordinates. Units intersecting it take the annotation. */
  annotatedRange?: { from: number; to: number } | null;
  /** ISO timestamp for createdAt / version rows. */
  now: string;
  /** For 'external' matching: similarity threshold (default 0.6) and line window (default 8). */
  fuzzyThreshold?: number;
  fuzzyLineWindow?: number;
  /** Cite/placeholder extraction; defaults to latexTokensOf + findPlaceholders from latex/tokens. */
  analyze?: (text: string) => TextAnalysis;
}

export interface AssignResult {
  /** All live units of the file in document order (orphans excluded). */
  units: SentenceUnit[];
  /** New version rows to append, in order. */
  versions: SentenceVersion[];
  /**
   * Units created or changed (for sentences.patch), compared field by field with the MAPPED `prev`:
   * a unit whose only difference is the span shift already applied by mapUnits is not included
   * (clients map the same change), but one whose ctxHash, paragraphId, line or state changed is.
   */
  upserts: SentenceUnit[];
  /** Ids that disappeared (deleted or merged into another unit). */
  removed: string[];
  /** External mode only: units that could not be re-anchored (orphaned = true). Metadata kept, never deleted. */
  orphaned: SentenceUnit[];
  /** Pairs (last AI text, new human text) for AI units the author edited by hand (voice learning). */
  editPairs: EditPair[];
  report: ReanchorReport;
}

/**
 * Match segments to previous units and evolve provenance. Rules:
 *
 * MATCHING (local): a segment keeps the id of the previous unit whose mapped span overlaps it most
 * (by characters). If one previous unit overlaps several segments (a split), the largest overlap keeps
 * the id and the others get new ids with `splitFrom` set. If several previous units overlap one segment
 * (a merge), the largest overlap keeps its id and the others are `removed`. Segments with no overlap
 * get new units.
 * MATCHING (external, in addition): after overlap matching, an unmatched previous unit whose `hash`
 * equals an unmatched segment's hash re-anchors there (ties broken by `ctxHash`); otherwise the best
 * unmatched segment within `fuzzyLineWindow` lines with similarity(textNorm) >= `fuzzyThreshold` AND an
 * agreeing neighbour (the previous or next unit was matched next to it) re-anchors; otherwise the unit
 * is orphaned.
 *
 * STATE EVOLUTION when a matched unit's normalized text changed (new version row, origin in brackets):
 * - changeSource 'external' -> state 'external' (external_edit). everAi is kept.
 * - annotated AI change -> annotation.state (ai_ghost/ai_draft/ai_rewrite/ai_intent/replan as given);
 *   everAi = true; model/promptHash/intentNote from the annotation; facts = annotation.factIds;
 *   origin 'grammar_fix' keeps the previous state and sets grammarFixed = true.
 * - local typing (no annotation): human -> human (human_edit); ai-drafted | ai-from-intent | proposed |
 *   unsupported | ai-edited -> ai-edited (human_edit) with editDistance = editDistanceWords(last AI
 *   version text, new text) and an EditPair; external -> human, or ai-edited if everAi; placeholder ->
 *   human once the text is no longer only a placeholder.
 * - any unit whose whole text is a single placeholder -> state 'placeholder'.
 * New units: annotated -> annotation.state (proposed for drafts); otherwise 'human' (human_typed),
 * except changeSource 'external' -> 'external' (external_edit). Import (no prev units, changeSource
 * 'external', no annotation) is signalled by the caller via `prev = []` plus an annotation with origin
 * 'import' -> state 'human', imported = true, version origin 'import'.
 * Every unit gets hash = hashString(normalizeForHash(text)), textNorm, ctxHash from its in-paragraph
 * neighbours, line, part, kind, sectionId, paragraphId = `${sectionId}/p${paragraphIndex}`, cites and
 * placeholders from `analyze`. Unchanged units keep facts/claims/move.
 */
export function assignUnits(input: AssignInput): AssignResult {
  return assignUnitsImpl(input);
}

/** Convenience for external changes: diffChanges + mapUnits + assignUnits(changeSource 'external'). */
export function reanchor(
  oldText: string,
  newText: string,
  seg: Segmentation,
  input: Omit<AssignInput, 'text' | 'seg' | 'changeSource' | 'dirty'>,
): AssignResult {
  const changes = diffChanges(oldText, newText);
  const prev = mapUnits(input.prev, changes, newText);
  return assignUnitsImpl({ ...input, prev, text: newText, seg, changeSource: 'external' });
}
