/**
 * CJK detection for intent lines (the author's notes, usually in Chinese, typed between sentences).
 *
 * A line counts only by its non-comment part: CJK after an unescaped `%` is a LaTeX comment, which
 * pdflatex ignores and which the shadow copy leaves alone, so it cannot make the line an intent line.
 */

export interface IntentLineSpan {
  start: number;
  end: number;
  line: number;
  text: string;
}

/** Han, kana, Hangul, CJK punctuation/symbols and full-width forms (UTF-16 code units, BMP). */
export function isCjkCode(c: number): boolean {
  return (
    (c >= 0x2e80 && c <= 0x2fdf) || // CJK radicals supplement, Kangxi radicals
    (c >= 0x3000 && c <= 0x303f) || // CJK symbols and punctuation
    (c >= 0x3040 && c <= 0x30ff) || // Hiragana, Katakana
    (c >= 0x3100 && c <= 0x312f) || // Bopomofo
    (c >= 0x3130 && c <= 0x318f) || // Hangul compatibility Jamo
    (c >= 0x3190 && c <= 0x31ff) || // Kanbun, Bopomofo ext., CJK strokes, Katakana ext.
    (c >= 0x3200 && c <= 0x33ff) || // enclosed CJK, CJK compatibility
    (c >= 0x3400 && c <= 0x4dbf) || // CJK ext. A
    (c >= 0x4e00 && c <= 0x9fff) || // CJK unified ideographs
    (c >= 0xa960 && c <= 0xa97f) || // Hangul Jamo ext. A
    (c >= 0xac00 && c <= 0xd7ff) || // Hangul syllables, Jamo ext. B
    (c >= 0x1100 && c <= 0x11ff) || // Hangul Jamo
    (c >= 0xf900 && c <= 0xfaff) || // CJK compatibility ideographs
    (c >= 0xfe30 && c <= 0xfe4f) || // CJK compatibility forms
    (c >= 0xff00 && c <= 0xffef) // half-width and full-width forms
  );
}

/** Supplementary-plane ideographs (CJK ext. B..H, U+20000..U+3FFFF) arrive as high surrogates D840..D8BF. */
function isCjkHighSurrogate(c: number): boolean {
  return c >= 0xd840 && c <= 0xd8bf;
}

/** A quick pre-filter: any code unit that could start a CJK character. */
export function mayContainCjk(text: string): boolean {
  return CJK_ANY.test(text);
}
const CJK_ANY = /[ᄀ-ᇿ⺀-鿿ꥠ-꥿가-퟿豈-﫿︰-﹏＀-￯\ud840-\ud8bf]/;

function isLatinLetter(c: number): boolean {
  return (
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    (c >= 0xc0 && c <= 0x24f && c !== 0xd7 && c !== 0xf7) ||
    (c >= 0x1e00 && c <= 0x1eff)
  );
}

function isSpaceCode(c: number): boolean {
  return c === 32 || c === 9 || c === 13 || c === 10 || c === 12 || c === 11 || c === 0xa0 || c === 0x3000 ||
    (c >= 0x2000 && c <= 0x200b) || c === 0x202f || c === 0x205f || c === 0xfeff;
}

/** End (exclusive) of the non-comment part of a line: the first `%` not escaped by an odd run of backslashes. */
export function commentStart(line: string, from = 0, to = line.length): number {
  for (let i = from; i < to; i++) {
    const c = line.charCodeAt(i);
    if (c === 92 /* \ */) {
      i++; // skip the escaped character (also the second backslash of \\)
      continue;
    }
    if (c === 37 /* % */) return i;
  }
  return to;
}

/**
 * Intent-line test on [from, to) of `text` (one line, no newline inside).
 * True when the first non-space character is not `%` and, over the non-comment part of the line,
 * CJK characters are at least 30% of the non-whitespace characters, or there are at least 4 CJK
 * characters and more CJK characters than Latin letters.
 */
export function isIntentRange(text: string, from: number, to: number): boolean {
  let i = from;
  while (i < to && isSpaceCode(text.charCodeAt(i))) i++;
  if (i >= to || text.charCodeAt(i) === 37) return false;
  const stop = commentStart(text, i, to);
  let cjk = 0;
  let nonSpace = 0;
  let latin = 0;
  for (let k = i; k < stop; k++) {
    const c = text.charCodeAt(k);
    if (c >= 0xdc00 && c <= 0xdfff) continue; // low surrogate: counted with its high surrogate
    if (isSpaceCode(c)) continue;
    nonSpace++;
    if (isCjkCode(c) || isCjkHighSurrogate(c)) cjk++;
    else if (isLatinLetter(c)) latin++;
  }
  if (cjk === 0) return false;
  return cjk >= 0.3 * nonSpace || (cjk >= 4 && cjk > latin);
}

export function isIntentText(lineText: string): boolean {
  if (!mayContainCjk(lineText)) return false;
  // A caller may hand over a line with its newline; judge the first line only.
  let to = lineText.indexOf('\n');
  if (to < 0) to = lineText.length;
  if (to > 0 && lineText.charCodeAt(to - 1) === 13) to--;
  return isIntentRange(lineText, 0, to);
}

/** All intent lines of a source with offsets of the line content (newline and a trailing \r excluded). */
export function scanIntentLines(source: string): IntentLineSpan[] {
  const out: IntentLineSpan[] = [];
  if (!mayContainCjk(source)) return out;
  const re = new RegExp(CJK_ANY.source, 'g');
  let lastLineStart = -1;
  let line = 1;
  let counted = 0; // offset up to which newlines have been counted into `line`
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const pos = m.index;
    const ls = source.lastIndexOf('\n', pos - 1) + 1;
    let le = source.indexOf('\n', pos);
    if (le < 0) le = source.length;
    re.lastIndex = le; // one test per line
    if (ls === lastLineStart) continue;
    lastLineStart = ls;
    let end = le;
    if (end > ls && source.charCodeAt(end - 1) === 13) end--;
    if (!isIntentRange(source, ls, end)) continue;
    for (let k = counted; k < ls; k++) if (source.charCodeAt(k) === 10) line++;
    counted = ls;
    out.push({ start: ls, end, line, text: source.slice(ls, end) });
  }
  return out;
}
