/**
 * Push-guard scans over .tex text (pure): intent lines, CJK outside comments, unresolved merge markers;
 * plus a small unified-diff renderer for modes without git (ols, none).
 */
import DiffMatchPatch from 'diff-match-patch';
import { findIntentLines } from '@paper-copilot/core';

/** Han, Hiragana, Katakana, Hangul, CJK punctuation, full-width forms. */
const CJK_RE = /[　-〿぀-ヿ㄀-ㄯㆠ-ㇿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]|[\u{20000}-\u{2fa1f}]/u;

/** The part of a LaTeX line before an unescaped `%` (a `\%` is a literal percent sign). */
export function stripComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '%') continue;
    let bs = 0;
    for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) bs++;
    if (bs % 2 === 0) return line.slice(0, i);
  }
  return line;
}

export interface LineHit {
  line: number;
  text: string;
}

export function intentLineHits(text: string): LineHit[] {
  return findIntentLines(text).map((l) => ({ line: l.line, text: l.text }));
}

/** Lines with a CJK character outside comments. */
export function cjkHits(text: string): LineHit[] {
  const out: LineHit[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((l, i) => {
    if (CJK_RE.test(stripComment(l))) out.push({ line: i + 1, text: l.trim().slice(0, 200) });
  });
  return out;
}

/** Unresolved merge markers: `<<<<<<< `/`>>>>>>> ` lines, and `=======` only in a file that has an opening marker. */
export function mergeMarkerHits(text: string): LineHit[] {
  const out: LineHit[] = [];
  const lines = text.split(/\r?\n/);
  const hasOpen = lines.some((l) => /^<{7}(?: |$)/.test(l));
  lines.forEach((l, i) => {
    if (/^<{7}(?: |$)/.test(l) || /^>{7}(?: |$)/.test(l) || (hasOpen && /^={7}$/.test(l)) || /^\|{7}(?: |$)/.test(l)) out.push({ line: i + 1, text: l.slice(0, 200) });
  });
  return out;
}

/** Unified diff (3 lines of context) between two texts, with git-style headers. */
export function unifiedDiff(file: string, before: string | null, after: string | null, context = 3): string {
  if (before === after) return '';
  const a = before ?? '';
  const b = after ?? '';
  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = 0;
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(a, b);
  const diffs = dmp.diff_main(chars1, chars2, false);
  dmp.diff_charsToLines_(diffs, lineArray);
  type L = { op: -1 | 0 | 1; text: string };
  const lines: L[] = [];
  for (const [op, chunk] of diffs) {
    const parts = chunk.split('\n');
    if (parts[parts.length - 1] === '') parts.pop();
    for (const p of parts) lines.push({ op: op as -1 | 0 | 1, text: p });
  }
  const head = [`diff --git a/${file} b/${file}`, before === null ? 'new file' : null, `--- ${before === null ? '/dev/null' : `a/${file}`}`, `+++ ${after === null ? '/dev/null' : `b/${file}`}`].filter((x): x is string => x !== null);
  const out: string[] = [];
  let i = 0;
  // line numbers
  const aNo: number[] = [];
  const bNo: number[] = [];
  {
    let x = 1;
    let y = 1;
    for (const l of lines) {
      aNo.push(x);
      bNo.push(y);
      if (l.op !== 1) x++;
      if (l.op !== -1) y++;
    }
  }
  while (i < lines.length) {
    if (lines[i]!.op === 0) {
      i++;
      continue;
    }
    let start = Math.max(0, i - context);
    let end = i;
    // extend the hunk while changes are within 2*context lines of each other
    for (;;) {
      while (end < lines.length && lines[end]!.op !== 0) end++;
      let k = end;
      while (k < lines.length && lines[k]!.op === 0 && k - end < 2 * context) k++;
      if (k < lines.length && lines[k]!.op !== 0) {
        end = k;
        continue;
      }
      end = Math.min(lines.length, end + context);
      break;
    }
    const slice = lines.slice(start, end);
    const aCount = slice.filter((l) => l.op !== 1).length;
    const bCount = slice.filter((l) => l.op !== -1).length;
    const aStart = aCount === 0 ? aNo[start]! - 1 : aNo[start]!;
    const bStart = bCount === 0 ? bNo[start]! - 1 : bNo[start]!;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const l of slice) out.push((l.op === 0 ? ' ' : l.op === -1 ? '-' : '+') + l.text);
    i = end;
    start = end;
  }
  if (out.length === 0) return '';
  return [...head, ...out].join('\n') + '\n';
}
