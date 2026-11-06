/**
 * Line-level three-way merge for sentence-per-line LaTeX.
 *
 * git's merge reports a conflict when two sides change ADJACENT lines; with one sentence per line that
 * is the common case (the author polishes sentence 4 while an advisor edits sentence 5). This merge
 * conflicts only when both sides change the same base lines (or insert different text at the same
 * point); identical changes on both sides are taken once. Pure function; used by the sync service to
 * resolve a stash re-apply or a rebase step before giving up and restoring the tree.
 */
import DiffMatchPatch from 'diff-match-patch';

interface Hunk {
  /** Replace base lines [start, end) with `lines`. */
  start: number;
  end: number;
  lines: string[];
  side: 'a' | 'b';
}

function splitLines(t: string): string[] {
  // keep line terminators so the merged text is byte-exact
  const out: string[] = [];
  let i = 0;
  while (i < t.length) {
    const j = t.indexOf('\n', i);
    if (j < 0) {
      out.push(t.slice(i));
      break;
    }
    out.push(t.slice(i, j + 1));
    i = j + 1;
  }
  return out;
}

function hunks(base: string[], other: string[], side: 'a' | 'b'): Hunk[] {
  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = 0;
  // map each distinct line to one char, diff, and walk the result
  const map = new Map<string, string>();
  const enc = (ls: string[]) =>
    ls
      .map((l) => {
        let c = map.get(l);
        if (c === undefined) {
          c = String.fromCharCode(map.size + 1);
          map.set(l, c);
        }
        return c;
      })
      .join('');
  if (base.length + other.length > 60000) throw new Error('file too large for a line merge');
  const a = enc(base);
  const b = enc(other);
  const diffs = dmp.diff_main(a, b, false);
  const out: Hunk[] = [];
  let bi = 0;
  let oi = 0;
  let cur: Hunk | null = null;
  for (const [op, s] of diffs) {
    if (op === 0) {
      if (cur) out.push(cur);
      cur = null;
      bi += s.length;
      oi += s.length;
    } else if (op === -1) {
      cur ??= { start: bi, end: bi, lines: [], side };
      cur.end += s.length;
      bi += s.length;
    } else {
      cur ??= { start: bi, end: bi, lines: [], side };
      cur.lines.push(...other.slice(oi, oi + s.length));
      oi += s.length;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const same = (x: Hunk, y: Hunk) => x.start === y.start && x.end === y.end && x.lines.length === y.lines.length && x.lines.every((l, i) => l === y.lines[i]);

export interface MergeResult {
  ok: boolean;
  text: string;
  /** 1-based base line ranges both sides changed. */
  conflicts: Array<{ from: number; to: number }>;
}

/** Merge `ours` and `theirs`, both derived from `base`. */
export function merge3(base: string, ours: string, theirs: string): MergeResult {
  if (ours === theirs) return { ok: true, text: ours, conflicts: [] };
  if (ours === base) return { ok: true, text: theirs, conflicts: [] };
  if (theirs === base) return { ok: true, text: ours, conflicts: [] };
  const bl = splitLines(base);
  let ha: Hunk[];
  let hb: Hunk[];
  try {
    ha = hunks(bl, splitLines(ours), 'a');
    hb = hunks(bl, splitLines(theirs), 'b');
  } catch {
    return { ok: false, text: ours, conflicts: [{ from: 1, to: bl.length }] };
  }
  const all = [...ha, ...hb].sort((x, y) => x.start - y.start || x.end - y.end || (x.side === 'a' ? -1 : 1));
  const conflicts: Array<{ from: number; to: number }> = [];
  const chosen: Hunk[] = [];
  for (const h of all) {
    const prev = chosen[chosen.length - 1];
    if (prev && prev.side !== h.side) {
      const overlap = h.start < prev.end && prev.start < h.end;
      const samePointInsert = h.start === h.end && prev.start === prev.end && h.start === prev.start;
      const insertInside = (h.start === h.end && prev.start < h.start && h.start < prev.end) || (prev.start === prev.end && h.start < prev.start && prev.start < h.end);
      if (overlap || samePointInsert || insertInside) {
        if (same(prev, h)) continue; // both made the same change
        conflicts.push({ from: Math.min(prev.start, h.start) + 1, to: Math.max(prev.end, h.end) });
        continue;
      }
    }
    chosen.push(h);
  }
  if (conflicts.length) return { ok: false, text: ours, conflicts };
  let out = '';
  let pos = 0;
  for (const h of chosen) {
    out += bl.slice(pos, h.start).join('') + h.lines.join('');
    pos = Math.max(pos, h.end);
  }
  out += bl.slice(pos).join('');
  return { ok: true, text: out, conflicts: [] };
}
