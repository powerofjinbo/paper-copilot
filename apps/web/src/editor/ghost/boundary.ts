/**
 * Sentence-boundary helpers for ghost triggers. Pure.
 *
 * The rule is the skill's (style_check.py `split_sentences`, as mirrored by core `segment`): a sentence
 * ends at `.`, `?` or `!`, optionally followed by closing quotes/brackets, then whitespace, unless the last
 * whitespace-separated token before it (stripped of leading `( [ " “`, lower-cased, punctuation included)
 * is an abbreviation from core DEFAULT_ABBREVIATIONS. `~` and `\ ` are not whitespace, so `Fig.~\ref{x}`
 * never ends a sentence. While typing we cannot see the next character yet, so the space itself commits
 * the boundary.
 */
import { DEFAULT_ABBREVIATIONS, type SentenceUnit } from '@paper-copilot/core';
import { unitAtPos, unitBefore } from '../units';

const ABBR: ReadonlySet<string> = new Set(DEFAULT_ABBREVIATIONS.map((a) => a.toLowerCase()));

const END_RE = /[.?!]["”’)\]]*[ \t\n]+$/;
const BOUNDARY_RE = /[.?!]["”’)\]]*[ \t\n]+/g;

function tokenBefore(text: string, punctIndex: number): string {
  // the whitespace-separated token that ends with the punctuation at punctIndex (inclusive)
  let i = punctIndex;
  while (i > 0 && !/\s/.test(text[i - 1]!)) i--;
  return text.slice(i, punctIndex + 1).replace(/^[([“"]+/, '').toLowerCase();
}

function isAbbreviation(text: string, punctIndex: number, abbreviations: ReadonlySet<string>): boolean {
  if (text[punctIndex] !== '.') return false;
  return abbreviations.has(tokenBefore(text, punctIndex));
}

/** True if `before` (the text up to the cursor) has just committed a sentence boundary. */
export function endsSentence(before: string, abbreviations: ReadonlySet<string> = ABBR): boolean {
  const m = END_RE.exec(before);
  if (!m) return false;
  const lineStart = before.lastIndexOf('\n', m.index) + 1;
  const line = before.slice(lineStart, m.index + 1).trimStart();
  if (line.startsWith('%')) return false;
  if (line.length <= 1) return false;
  return !isAbbreviation(before, m.index, abbreviations);
}

/**
 * Offset (into `text`) where the sentence containing `pos` starts, scanning back to the previous committed
 * boundary, a blank line, or `limit`.
 */
export function scanSentenceStart(text: string, pos: number, limit = 0, abbreviations: ReadonlySet<string> = ABBR): number {
  let from = Math.max(limit, 0);
  // paragraph start: the last blank line before pos
  const para = text.lastIndexOf('\n\n', pos - 1);
  if (para >= from) from = para + 2;
  const chunk = text.slice(from, pos);
  let start = 0;
  BOUNDARY_RE.lastIndex = 0;
  for (let m = BOUNDARY_RE.exec(chunk); m; m = BOUNDARY_RE.exec(chunk)) {
    const punct = m.index;
    if (isAbbreviation(chunk, punct, abbreviations)) continue;
    start = m.index + m[0].length;
  }
  let s = from + start;
  while (s < pos && /\s/.test(text[s]!)) s++;
  return s;
}

/**
 * The start of the current sentence at `pos`: the containing unit's start when the cursor is inside a unit
 * (after its first character), else a scan back to the previous boundary (not crossing the previous unit).
 */
export function sentenceStartAt(text: string, units: readonly SentenceUnit[], pos: number): number {
  const u = unitAtPos(units, pos);
  if (u && u.start < pos) return u.start;
  const prev = unitBefore(units, pos);
  const limit = prev ? prev.end : Math.max(0, pos - 2000);
  return scanSentenceStart(text, pos, limit);
}

/** Text of the current sentence before the cursor (what the ghost must continue verbatim). */
export function sentencePrefix(text: string, units: readonly SentenceUnit[], pos: number): string {
  const s = sentenceStartAt(text, units, pos);
  const prefix = text.slice(s, pos);
  // a prefix never spans a blank line or a comment line
  return prefix.includes('\n\n') ? prefix.slice(prefix.lastIndexOf('\n\n') + 2) : prefix;
}

/** English words in a LaTeX prefix (commands, math, citations and numbers are not words). */
export function englishWordCount(prefix: string): number {
  const stripped = prefix
    .replace(/(^|[^\\])%.*$/gm, '$1 ')
    .replace(/\$[^$]*\$?/g, ' ')
    .replace(/\\(?:cite[a-zA-Z]*|ref|eqref|cref|Cref|autoref|pageref|label|SI|si|num)\*?(\[[^\]]*\])*(\{[^}]*\})*/g, ' ')
    .replace(/\\[A-Za-z@]+\*?/g, ' ');
  const words = stripped.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g);
  return words ? words.length : 0;
}
