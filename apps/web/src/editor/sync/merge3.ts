/**
 * Line-based three-way merge (diff3), used by SyncCore when the server restarted and its version
 * numbers no longer relate to the editor's: `base` is the last text the editor knows came from disk,
 * `ours` is the editor's text, `theirs` is what the new server process read from disk.
 *
 * Rules (one sentence per line, so a line is the natural unit):
 *  - a region changed on one side only takes that side's lines;
 *  - a region changed identically on both sides is taken once (edits saved before the restart);
 *  - a region changed differently on both sides is a conflict: OUR lines are kept (the author's text is
 *    never lost) and the region's line numbers in the result are reported, so the caller can say so.
 * No DOM: unit-tested in apps/web/test/editor-sync.test.ts.
 */

interface Hunk {
  /** Replaced range of base lines [aStart, aEnd). */
  aStart: number;
  aEnd: number;
  /** Replacement range of the other side's lines [bStart, bEnd). */
  bStart: number;
  bEnd: number;
}

/** Split into lines that keep their '\n' (the last line may lack it), so joining restores the text. */
export function splitLines(s: string): string[] {
  if (!s) return [];
  const out: string[] = [];
  let pos = 0;
  while (pos < s.length) {
    const nl = s.indexOf('\n', pos);
    const end = nl < 0 ? s.length : nl + 1;
    out.push(s.slice(pos, end));
    pos = end;
  }
  return out;
}

/** Above this many cells the LCS table is not built: the differing middle becomes one hunk. */
const MAX_CELLS = 4_000_000;

/** Line hunks turning `a` into `b` (longest common subsequence, after trimming the common ends). */
export function lineHunks(a: readonly string[], b: readonly string[]): Hunk[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0 || n * m > MAX_CELLS) return [{ aStart: pre, aEnd: pre + n, bStart: pre, bEnd: pre + m }];
  // lcs[i][j] = LCS length of a[pre+i..pre+n) and b[pre+j..pre+m)
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[pre + i] === b[pre + j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let open: Hunk | null = null;
  const close = () => {
    if (open) hunks.push(open);
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[pre + i] === b[pre + j]) {
      close();
      i++;
      j++;
      continue;
    }
    open ??= { aStart: pre + i, aEnd: pre + i, bStart: pre + j, bEnd: pre + j };
    if (j < m && (i === n || lcs[i * w + j + 1]! >= lcs[(i + 1) * w + j]!)) {
      j++;
      open.bEnd = pre + j;
    } else {
      i++;
      open.aEnd = pre + i;
    }
  }
  close();
  // n lines replaced by n lines: one replacement per line (one sentence per line), so an edit of a
  // neighbouring sentence by the other side does not make the whole block a conflict
  const fine: Hunk[] = [];
  for (const h of hunks) {
    const len = h.aEnd - h.aStart;
    if (len > 1 && len === h.bEnd - h.bStart) {
      for (let k = 0; k < len; k++) if (a[h.aStart + k] !== b[h.bStart + k]) fine.push({ aStart: h.aStart + k, aEnd: h.aStart + k + 1, bStart: h.bStart + k, bEnd: h.bStart + k + 1 });
    } else fine.push(h);
  }
  return fine;
}

export interface Merge3Result {
  text: string;
  /** 1-based line numbers (in `text`) of conflicting regions, where our lines were kept. */
  conflicts: number[];
}

export function merge3(base: string, ours: string, theirs: string): Merge3Result {
  if (ours === theirs) return { text: ours, conflicts: [] };
  if (theirs === base) return { text: ours, conflicts: [] };
  if (ours === base) return { text: theirs, conflicts: [] };
  const B = splitLines(base);
  const O = splitLines(ours);
  const T = splitLines(theirs);
  const sides = [
    { lines: O, hunks: lineHunks(B, O), next: 0, delta: 0 },
    { lines: T, hunks: lineHunks(B, T), next: 0, delta: 0 },
  ];
  const out: string[] = [];
  const conflicts: number[] = [];
  let pos = 0; // in base lines
  for (;;) {
    const firsts = sides.map((s) => s.hunks[s.next]).filter((h): h is Hunk => !!h);
    if (firsts.length === 0) break;
    const start = Math.min(...firsts.map((h) => h.aStart));
    let end = start;
    // Grow the group while a hunk of either side overlaps it. Edits of ADJACENT lines are separate groups
    // (two people editing neighbouring sentences is not a conflict); a hunk starting exactly where an
    // insertion-only group sits joins it (two insertions at one point, or an insertion before an edit).
    const taken: Hunk[][] = [[], []];
    let grew = true;
    while (grew) {
      grew = false;
      sides.forEach((s, k) => {
        const h = s.hunks[s.next];
        if (h && (h.aStart < end || (h.aStart === start && start === end))) {
          taken[k]!.push(h);
          s.next++;
          end = Math.max(end, h.aEnd);
          grew = true;
        }
      });
    }
    for (let i = pos; i < start; i++) out.push(B[i]!);
    // each side's lines for base [start, end)
    const region = sides.map((s, k) => {
      const hs = taken[k]!;
      const bStart = start + s.delta;
      for (const h of hs) s.delta += h.bEnd - h.bStart - (h.aEnd - h.aStart);
      const bEnd = end + s.delta;
      return { changed: hs.length > 0, lines: s.lines.slice(bStart, bEnd) };
    });
    const [o, t] = region as [{ changed: boolean; lines: string[] }, { changed: boolean; lines: string[] }];
    const pureInsert = (k: number): string[] | null => {
      const hs = taken[k]!;
      return hs.length === 1 && hs[0]!.aStart === start && hs[0]!.aEnd === start ? sides[k]!.lines.slice(hs[0]!.bStart, hs[0]!.bEnd) : null;
    };
    if (o.changed && t.changed && o.lines.join('') !== t.lines.join('')) {
      const insO = pureInsert(0);
      const insT = pureInsert(1);
      const startsWith = (lines: string[], head: string[]) => head.every((l, i) => lines[i] === l);
      if (insT && !insO) out.push(...(startsWith(o.lines, insT) ? o.lines : [...insT, ...o.lines]));
      else if (insO && !insT) out.push(...(startsWith(t.lines, insO) ? t.lines : [...insO, ...t.lines]));
      else {
        // differing edits of the same lines (or two different insertions at one point): ours is kept
        conflicts.push(out.length + 1);
        out.push(...o.lines);
      }
    } else if (o.changed) out.push(...o.lines);
    else out.push(...t.lines);
    pos = end;
  }
  for (let i = pos; i < B.length; i++) out.push(B[i]!);
  return { text: out.join(''), conflicts };
}
