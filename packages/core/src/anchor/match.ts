/**
 * Segment <-> previous-unit matching for assignUnits (see the rules in units.ts).
 *
 * Phase 1 (both modes): character-overlap matching between units and segments of the same kind
 * (footnote segments are nested inside their host sentence's span, so kinds never mix), resolved
 * greedily by overlap size: the largest overlap of a unit keeps its id, so a split keeps the id on the
 * larger part and a merge keeps the id of the unit that overlaps the merged sentence most.
 * Phase 2 (external only): exact-hash re-anchoring with ctxHash, then line distance, as tie-breakers.
 * Phase 3 (external only): fuzzy re-anchoring within a line window, similarity >= threshold and an
 * agreeing neighbour; repeated while it makes progress, so chains of moved/edited units resolve.
 */
import type { SentenceUnit } from '../schemas';
import type { SegSentence } from '../latex/segment';

export interface MatchContext {
  segs: SegSentence[];
  /** Live previous units (not orphaned), sorted by (start, end). */
  prev: SentenceUnit[];
  /** Previously orphaned units: eligible for exact-hash re-anchoring in external mode only. */
  orphans: SentenceUnit[];
  external: boolean;
  fuzzyThreshold: number;
  fuzzyLineWindow: number;
  segNorm: (si: number) => string;
  segHash: (si: number) => string;
  segCtxHash: (si: number) => string;
  /** Line of a previous unit's mapped start in the new text. */
  prevLine: (u: SentenceUnit) => number;
  similarity: (a: string, b: string) => number;
}

export interface OverlapPair {
  si: number;
  pi: number;
  ov: number;
}

export interface MatchResult {
  /** Segment index -> index into prev (live) or -1. */
  segOwner: Int32Array;
  /** prev index -> segment index or -1. */
  prevMatch: Int32Array;
  /** orphan index -> segment index or -1. */
  orphanMatch: Int32Array;
  /** Segment index -> orphan index re-anchored there, or -1. */
  segOrphan: Int32Array;
  /** All overlap pairs (for split / merge detection). */
  pairs: OverlapPair[];
  /** How each matched unit was re-anchored (for diagnostics/tests). */
  how: Map<number, 'overlap' | 'hash' | 'fuzzy'>;
}

function overlapPairs(segs: SegSentence[], prev: SentenceUnit[]): OverlapPair[] {
  const pairs: OverlapPair[] = [];
  let p = 0;
  let active: number[] = [];
  for (let si = 0; si < segs.length; si++) {
    const s = segs[si]!;
    while (p < prev.length && prev[p]!.start < s.end) {
      if (prev[p]!.end > prev[p]!.start) active.push(p);
      p++;
    }
    // Segments are sorted by start, so a unit ending at or before this start can never overlap again.
    if (active.length > 8) active = active.filter((pi) => prev[pi]!.end > s.start);
    for (const pi of active) {
      const u = prev[pi]!;
      if (u.kind !== s.kind) continue;
      const ov = Math.min(u.end, s.end) - Math.max(u.start, s.start);
      if (ov > 0) pairs.push({ si, pi, ov });
    }
  }
  return pairs;
}

export function matchUnits(ctx: MatchContext): MatchResult {
  const { segs, prev, orphans } = ctx;
  const segOwner = new Int32Array(segs.length).fill(-1);
  const prevMatch = new Int32Array(prev.length).fill(-1);
  const orphanMatch = new Int32Array(orphans.length).fill(-1);
  const segOrphan = new Int32Array(segs.length).fill(-1);
  const how = new Map<number, 'overlap' | 'hash' | 'fuzzy'>();
  const segFree = (si: number): boolean => segOwner[si] === -1 && segOrphan[si] === -1;

  /* Phase 1: overlap. */
  const pairs = overlapPairs(segs, prev);
  const sorted = [...pairs].sort((a, b) => b.ov - a.ov || a.si - b.si || a.pi - b.pi);
  // External mode: an overlap only claims identity if the texts are still recognizably the same
  // sentence; a sentence rewritten beyond recognition is re-anchored by hash/fuzzy or orphaned, never
  // silently relabelled. Half the fuzzy threshold keeps splits and merges (about 0.5) matched.
  const floor = ctx.fuzzyThreshold / 2;
  for (const { si, pi } of sorted) {
    if (segOwner[si] !== -1 || prevMatch[pi] !== -1) continue;
    if (ctx.external) {
      const u = prev[pi]!;
      const norm = ctx.segNorm(si);
      if (norm !== u.textNorm && ctx.similarity(u.textNorm, norm) < floor) continue;
    }
    segOwner[si] = pi;
    prevMatch[pi] = si;
    how.set(pi, 'overlap');
  }
  if (!ctx.external) return { segOwner, prevMatch, orphanMatch, segOrphan, pairs, how };

  /* Phase 2: exact hash (live units first, then previously orphaned ones). */
  const byHash = new Map<string, number[]>();
  for (let si = 0; si < segs.length; si++) {
    if (!segFree(si)) continue;
    const h = ctx.segHash(si);
    const list = byHash.get(h);
    if (list) list.push(si);
    else byHash.set(h, [si]);
  }
  const hashRound = (units: SentenceUnit[], taken: Int32Array, onMatch: (ui: number, si: number) => void): void => {
    const cands: Array<{ ui: number; si: number; ctx: number; dist: number }> = [];
    for (let ui = 0; ui < units.length; ui++) {
      if (taken[ui] !== -1) continue;
      const u = units[ui]!;
      const list = byHash.get(u.hash);
      if (!list) continue;
      const line = ctx.prevLine(u);
      for (const si of list) {
        if (segs[si]!.kind !== u.kind) continue;
        cands.push({ ui, si, ctx: ctx.segCtxHash(si) === u.ctxHash ? 0 : 1, dist: Math.abs(segs[si]!.line - line) });
      }
    }
    cands.sort((a, b) => a.ctx - b.ctx || a.dist - b.dist || a.si - b.si || a.ui - b.ui);
    for (const c of cands) {
      if (taken[c.ui] !== -1 || !segFree(c.si)) continue;
      onMatch(c.ui, c.si);
    }
  };
  hashRound(prev, prevMatch, (pi, si) => {
    segOwner[si] = pi;
    prevMatch[pi] = si;
    how.set(pi, 'hash');
  });
  hashRound(orphans, orphanMatch, (oi, si) => {
    segOrphan[si] = oi;
    orphanMatch[oi] = si;
  });

  /* Phase 2b: repeated sentences. The diff may keep a repeated sentence's text in place while its
     context moved (e.g. two paragraphs that share a sentence swap). Among matched units whose text is
     identical to their segment, re-pair each group of equal hashes so that ctxHash agrees where it can. */
  {
    const groups = new Map<string, number[]>();
    for (let pi = 0; pi < prev.length; pi++) {
      const si = prevMatch[pi]!;
      if (si === -1 || ctx.segHash(si) !== prev[pi]!.hash) continue;
      const g = groups.get(prev[pi]!.hash);
      if (g) g.push(pi);
      else groups.set(prev[pi]!.hash, [pi]);
    }
    for (const units of groups.values()) {
      if (units.length < 2) continue;
      const slots = units.map((pi) => prevMatch[pi]!);
      const agree = (pi: number, si: number): number => (ctx.segCtxHash(si) === prev[pi]!.ctxHash ? 1 : 0);
      const current = units.reduce((n, pi) => n + agree(pi, prevMatch[pi]!), 0);
      const cands: Array<{ pi: number; si: number; a: number; dist: number }> = [];
      for (const pi of units)
        for (const si of slots) cands.push({ pi, si, a: agree(pi, si), dist: Math.abs(segs[si]!.line - ctx.prevLine(prev[pi]!)) });
      cands.sort((x, y) => y.a - x.a || x.dist - y.dist || x.si - y.si || x.pi - y.pi);
      const nextOf = new Map<number, number>();
      const usedSlots = new Set<number>();
      for (const c of cands) {
        if (nextOf.has(c.pi) || usedSlots.has(c.si)) continue;
        nextOf.set(c.pi, c.si);
        usedSlots.add(c.si);
      }
      const better = [...nextOf].reduce((n, [pi, si]) => n + agree(pi, si), 0);
      if (better <= current) continue;
      for (const [pi, si] of nextOf) {
        prevMatch[pi] = si;
        segOwner[si] = pi;
        how.set(pi, 'hash');
      }
    }
  }

  /* Phase 3: fuzzy, within the line window, with an agreeing neighbour. */
  const window = ctx.fuzzyLineWindow;
  const lowerBound = (line: number): number => {
    let lo = 0;
    let hi = segs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid]!.line < line) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const agrees = (pi: number, si: number): boolean =>
    (pi > 0 && si > 0 && prevMatch[pi - 1] === si - 1) || (pi + 1 < prev.length && prevMatch[pi + 1] === si + 1);
  for (let pass = 0; pass < prev.length + 1; pass++) {
    const cands: Array<{ pi: number; si: number; sim: number; dist: number }> = [];
    for (let pi = 0; pi < prev.length; pi++) {
      if (prevMatch[pi] !== -1) continue;
      const u = prev[pi]!;
      const line = ctx.prevLine(u);
      for (let si = lowerBound(line - window); si < segs.length && segs[si]!.line <= line + window; si++) {
        if (!segFree(si) || !agrees(pi, si)) continue;
        const sim = ctx.similarity(u.textNorm, ctx.segNorm(si));
        if (sim >= ctx.fuzzyThreshold) cands.push({ pi, si, sim, dist: Math.abs(segs[si]!.line - line) });
      }
    }
    if (cands.length === 0) break;
    cands.sort((a, b) => b.sim - a.sim || a.dist - b.dist || a.si - b.si || a.pi - b.pi);
    let progress = false;
    for (const c of cands) {
      if (prevMatch[c.pi] !== -1 || !segFree(c.si)) continue;
      segOwner[c.si] = c.pi;
      prevMatch[c.pi] = c.si;
      how.set(c.pi, 'fuzzy');
      progress = true;
    }
    if (!progress) break;
  }
  return { segOwner, prevMatch, orphanMatch, segOrphan, pairs, how };
}
