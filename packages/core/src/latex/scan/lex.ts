/**
 * Low-level LaTeX lexing helpers working on UTF-16 offsets of one string. Every helper is bounded by
 * an exclusive `to` and never allocates more than the slices it returns, so the scanner stays linear.
 *
 * Conventions shared with style_check.py: a comment is an unescaped `%` to the end of the line; a
 * mandatory argument may be preceded by spaces and at most one newline (a blank line ends the search);
 * an optional argument `[..]` must follow immediately.
 */

export function isLetterCode(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

export function isDigitCode(c: number): boolean {
  return c >= 48 && c <= 57;
}

/** Space-like code units other than newline. */
export function isBlankCode(c: number): boolean {
  return c === 32 || c === 9 || c === 13 || c === 12 || c === 11;
}

/** Index of the next '\n' at or after i (or `to`). */
export function lineEnd(src: string, i: number, to: number): number {
  const e = src.indexOf('\n', i);
  return e < 0 || e > to ? to : e;
}

/** End of a control sequence starting at i (src[i] === '\\'): after the letters of a control word, or after one char. */
export function controlEnd(src: string, i: number, to: number): number {
  const k = i + 1;
  if (k >= to) return k;
  if (!isLetterCode(src.charCodeAt(k))) return k + 1;
  let e = k + 1;
  while (e < to && isLetterCode(src.charCodeAt(e))) e++;
  return e;
}

/** True if src[a, b) equals `word` (no allocation). */
export function wordAt(src: string, a: number, b: number, word: string): boolean {
  if (b - a !== word.length) return false;
  for (let k = 0; k < word.length; k++) if (src.charCodeAt(a + k) !== word.charCodeAt(k)) return false;
  return true;
}

/**
 * Skip spaces before a mandatory argument: blanks, comments and at most one newline (a second newline
 * would be a paragraph break). Returns the index of the first other character.
 */
export function skipArgSpace(src: string, j: number, to: number): number {
  let nl = 0;
  while (j < to) {
    const c = src.charCodeAt(j);
    if (isBlankCode(c)) {
      j++;
      continue;
    }
    if (c === 10) {
      nl++;
      if (nl > 1) return j;
      j++;
      continue;
    }
    if (c === 37) {
      // a comment eats the rest of its line including the newline
      j = lineEnd(src, j, to);
      if (j < to) j++;
      continue;
    }
    return j;
  }
  return j;
}

const VERBATIM_ARG_CMDS = new Set(['url', 'path', 'nolinkurl', 'href']);

/** Sources at least this long get a one-pass brace-pair table, so matching is O(1) and never quadratic. */
const PAIR_TABLE_MIN = 2048;
let pairSrc: string | null = null;
let pairTable: Int32Array = new Int32Array(0);

/**
 * End (past the closing brace) of every '{' of `src`, or -1: one left-to-right pass with the same rules
 * as the local search below (escapes, comments, \verb, verbatim arguments), so a lookup returns what the
 * local search would. Cached for the last source.
 */
function bracePairs(src: string): Int32Array {
  if (src === pairSrc) return pairTable;
  const n = src.length;
  const t = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  let j = 0;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 92) {
      const e = controlEnd(src, j, n);
      if (e - j > 2) {
        const skip = skipVerbatimCommand(src, j, e, n);
        if (skip > 0) {
          if (src.charCodeAt(e) === 123) t[e] = skip;
          j = skip;
          continue;
        }
      }
      j = e;
      continue;
    }
    if (c === 37) {
      j = lineEnd(src, j, n);
      continue;
    }
    if (c === 123) stack.push(j);
    else if (c === 125) {
      const o = stack.pop();
      if (o !== undefined) t[o] = j + 1;
    }
    j++;
  }
  pairSrc = src;
  pairTable = t;
  return t;
}

/** After a control word [j, e): the end of a \verb|..| or of a verbatim {..} argument, or -1. */
function skipVerbatimCommand(src: string, j: number, e: number, to: number): number {
  const k = j + 1;
  if (wordAt(src, k, e, 'verb')) {
    let d = e;
    if (d < to && src.charCodeAt(d) === 42) d++;
    if (d < to) {
      const delim = src[d]!;
      const close = src.indexOf(delim, d + 1);
      const nl = src.indexOf('\n', d + 1);
      if (close > 0 && close < to && (nl < 0 || nl > close)) return close + 1;
    }
    return -1;
  }
  if (e < to && src.charCodeAt(e) === 123 && VERBATIM_ARG_CMDS.has(src.slice(k, e))) {
    const v = matchBraceVerbatim(src, e, to);
    if (v > 0) return v;
  }
  return -1;
}

/**
 * src[i] === '{': index just past the matching '}', or -1 if it does not close before `to`.
 * Backslash escapes, comments, \verb|..| and the verbatim-like argument of \url/\href are respected.
 */
export function matchBrace(src: string, i: number, to: number): number {
  if (src.length >= PAIR_TABLE_MIN) {
    const e = bracePairs(src)[i] ?? -1;
    return e > 0 && e <= to ? e : -1;
  }
  let depth = 0;
  let j = i;
  while (j < to) {
    const c = src.charCodeAt(j);
    if (c === 92) {
      const e = controlEnd(src, j, to);
      if (e - j > 2) {
        // control word: \verb and verbatim arguments need care
        const skip = skipVerbatimCommand(src, j, e, to);
        if (skip > 0) {
          j = skip;
          continue;
        }
      }
      j = e;
      continue;
    }
    if (c === 37) {
      j = lineEnd(src, j, to);
      continue;
    }
    if (c === 123) depth++;
    else if (c === 125) {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return -1;
}

/** Brace matching inside a verbatim-like argument (\url{..}): `%`, `#` and `\` are literal. */
export function matchBraceVerbatim(src: string, i: number, to: number): number {
  let depth = 0;
  for (let j = i; j < to; j++) {
    const c = src.charCodeAt(j);
    if (c === 123) depth++;
    else if (c === 125) {
      depth--;
      if (depth === 0) return j + 1;
    } else if (c === 10 && j + 1 < to && src.charCodeAt(j + 1) === 10) return -1;
  }
  return -1;
}

/** src[i] === '[': index past the matching ']' (braces inside skipped), or -1 (also on a blank line). */
export function matchBracket(src: string, i: number, to: number): number {
  let j = i + 1;
  while (j < to) {
    const c = src.charCodeAt(j);
    if (c === 92) {
      j = controlEnd(src, j, to);
      continue;
    }
    if (c === 123) {
      const e = matchBrace(src, j, to);
      if (e < 0) return -1;
      j = e;
      continue;
    }
    if (c === 93) return j + 1;
    if (c === 37) {
      j = lineEnd(src, j, to);
      continue;
    }
    if (c === 10) {
      let k = j + 1;
      while (k < to && isBlankCode(src.charCodeAt(k))) k++;
      if (k < to && src.charCodeAt(k) === 10) return -1;
    }
    j++;
  }
  return -1;
}

export interface ArgSpan {
  /** Offset of the opening delimiter. */
  open: number;
  /** Offset just past the closing delimiter. */
  end: number;
}

/** A mandatory {..} argument after optional spaces, or null. */
export function readArg(src: string, j: number, to: number): ArgSpan | null {
  const k = skipArgSpace(src, j, to);
  if (k >= to || src.charCodeAt(k) !== 123) return null;
  const e = matchBrace(src, k, to);
  return e < 0 ? null : { open: k, end: e };
}

/** An optional [..] argument directly at j (no spaces), or null. */
export function readOpt(src: string, j: number, to: number): ArgSpan | null {
  if (j >= to || src.charCodeAt(j) !== 91) return null;
  const e = matchBracket(src, j, to);
  return e < 0 ? null : { open: j, end: e };
}

/** Skip up to `max` adjacent optional arguments; returns the new position. */
export function skipOpts(src: string, j: number, to: number, max = 2): number {
  for (let q = 0; q < max; q++) {
    const o = readOpt(src, j, to);
    if (!o) break;
    j = o.end;
  }
  return j;
}

/** Like skipOpts, but spaces (not newlines) may precede each optional argument (\item [a], \begin{x} [o]). */
export function skipOptsSpaced(src: string, j: number, to: number, max = 2): number {
  for (let q = 0; q < max; q++) {
    let k = j;
    while (k < to && isBlankCode(src.charCodeAt(k))) k++;
    const o = readOpt(src, k, to);
    if (!o) break;
    j = o.end;
  }
  return j;
}

/** Remove LaTeX comments (unescaped % to end of line, newline kept) from a short string. */
export function stripComments(s: string): string {
  if (s.indexOf('%') < 0) return s;
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92) {
      i++;
      continue;
    }
    if (c === 37) {
      out += s.slice(last, i);
      const e = s.indexOf('\n', i);
      if (e < 0) {
        last = s.length;
        break;
      }
      i = e - 1;
      last = e;
    }
  }
  return out + s.slice(last);
}

/** Split a key list ("a, b,%\n c") into trimmed non-empty keys. */
export function splitKeys(s: string): string[] {
  const out: string[] = [];
  for (const part of stripComments(s).split(',')) {
    const k = part.trim();
    if (k) out.push(k);
  }
  return out;
}

/**
 * End of a macro definition whose defining command (\newcommand, \def, ...) ends at j
 * (style_check.py macro_def_end). Never returns less than j.
 */
export function macroDefEnd(src: string, name: string, j: number, to: number): number {
  const ctrl = (k: number): number => (k < to && src.charCodeAt(k) === 92 ? controlEnd(src, k, to) : k);
  if (
    name === 'newcommand' || name === 'renewcommand' || name === 'providecommand' ||
    name === 'DeclareRobustCommand' || name === 'newrobustcmd' || name === 'renewrobustcmd' ||
    name === 'DeclareMathOperator'
  ) {
    if (j < to && src.charCodeAt(j) === 42) j++;
    let k = skipArgSpace(src, j, to);
    if (k < to && src.charCodeAt(k) === 123) {
      const e = matchBrace(src, k, to);
      j = e > 0 ? e : k + 1;
    } else j = Math.max(j, ctrl(k));
    for (let q = 0; q < 2; q++) {
      k = skipArgSpace(src, j, to);
      const o = readOpt(src, k, to);
      if (o) j = o.end;
    }
    const a = readArg(src, j, to);
    return a ? a.end : j;
  }
  if (name === 'def' || name === 'gdef' || name === 'edef' || name === 'xdef') {
    const k = skipArgSpace(src, j, to);
    j = Math.max(j, ctrl(k));
    const b = src.indexOf('{', j);
    if (b < 0 || b >= to || b - j > 40) return j;
    const e = matchBrace(src, b, to);
    return e > 0 ? e : j;
  }
  if (name === 'let') {
    let k = skipArgSpace(src, j, to);
    j = Math.max(j, ctrl(k));
    k = skipArgSpace(src, j, to);
    if (k < to && src.charCodeAt(k) === 61) k = skipArgSpace(src, k + 1, to);
    const e = ctrl(k);
    return e > k ? e : Math.min(to, k + 1);
  }
  if (name === 'newenvironment' || name === 'renewenvironment' || name === 'NewDocumentEnvironment' || name === 'RenewDocumentEnvironment') {
    if (j < to && src.charCodeAt(j) === 42) j++;
    const a = readArg(src, j, to);
    if (a) j = a.end;
    for (let q = 0; q < 2; q++) {
      const o = readOpt(src, skipArgSpace(src, j, to), to);
      if (o) j = o.end;
    }
    const nArgs = name.startsWith('newenv') || name.startsWith('renewenv') ? 2 : 3;
    for (let q = 0; q < nArgs; q++) {
      const b = readArg(src, j, to);
      if (!b) break;
      j = b.end;
    }
    return j;
  }
  if (
    name === 'NewDocumentCommand' || name === 'RenewDocumentCommand' || name === 'DeclareDocumentCommand' ||
    name === 'ProvideDocumentCommand' || name === 'NewExpandableDocumentCommand'
  ) {
    const k = skipArgSpace(src, j, to);
    if (k < to && src.charCodeAt(k) === 123) {
      const e = matchBrace(src, k, to);
      j = e > 0 ? e : k + 1;
    } else j = Math.max(j, ctrl(k));
    for (let q = 0; q < 2; q++) {
      const b = readArg(src, j, to);
      if (!b) break;
      j = b.end;
    }
    return j;
  }
  if (name === 'newif') return Math.max(j, ctrl(skipArgSpace(src, j, to)));
  return j;
}
