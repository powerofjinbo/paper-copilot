/**
 * Sentence boundaries inside one paragraph range of the scanner's mask.
 *
 * The rule is the skill's style_check.py split_sentences, read on LaTeX instead of converted text:
 * a boundary follows `.`, `?` or `!` (or a math region / plain-text macro that ends in a period),
 * optionally followed by closing quotes or brackets (and, LaTeX-specific, closing braces of groups
 * opened in the sentence and a directly attached \cite{..} / \footnote{..}), then whitespace, when the
 * next visible character is upper-case, a digit, an opening quote or bracket, the start of an atomic
 * region (math, \cite, \ref, a macro), or a non-ASCII letter, and when the last whitespace-separated
 * token before the punctuation (leading `([“"` stripped, lower-cased) is not an abbreviation.
 * `~` and `\ ` are not whitespace, so `Fig.~\ref{x}` never breaks.
 */
import {
  K_CLOSE,
  K_CMT,
  K_FMT,
  K_INV,
  K_OPEN,
  K_PROSE,
  K_RS,
  K_TIE,
  K_WS,
  R_CITE,
  R_FOOTNOTE,
  R_TERM,
} from './scanner';

export interface MaskView {
  /** The text the mask was computed on (same length and offsets as the original source). */
  src: string;
  cls: Uint8Array;
  jump: Int32Array;
  rk: Uint8Array;
  tokenText: ReadonlyMap<number, string>;
}

const PLACEHOLDER = '';
const LETTER_OR_DIGIT = /[\p{L}\p{Nd}\p{No}]/u;

function isCloser(c: number): boolean {
  // " ” ’ ) ] and the LaTeX closing quote '
  return c === 34 || c === 0x201d || c === 0x2019 || c === 41 || c === 93 || c === 39;
}

function startsSentence(src: string, q: number): boolean {
  const c = src.charCodeAt(q);
  if (c >= 65 && c <= 90) return true; // A-Z
  if (c >= 48 && c <= 57) return true; // 0-9
  // “ " ( [ ‘ and the LaTeX opening quote `
  if (c === 0x201c || c === 34 || c === 40 || c === 91 || c === 0x2018 || c === 96) return true;
  if (c < 128) return false;
  const cp = src.codePointAt(q) ?? c;
  return LETTER_OR_DIGIT.test(String.fromCodePoint(cp));
}

function isAsciiLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/**
 * Split [ps, pe) into sentences. Pushes start/end pairs (end exclusive, trimmed) to `out`.
 * Sentences without two consecutive ASCII letters of running text are dropped (style_check keeps a
 * sentence only if its plain text has /[A-Za-z]{2,}/).
 */
export function splitParagraph(m: MaskView, ps: number, pe: number, abbr: ReadonlySet<string>, out: number[]): void {
  const { src, cls, jump, rk } = m;
  let i = ps;
  let sStart = -1;
  let depth = 0;
  let lastEnd = -1;
  let tokStart = -1;
  let prevLetter = false;
  let hasWord = false;

  const token = (from: number, to: number): string => {
    let s = '';
    let x = from;
    while (x < to) {
      const k = cls[x];
      if (k === K_PROSE) {
        s += src[x];
        x++;
      } else if (k === K_RS) {
        const t = m.tokenText.get(x);
        if (t === undefined) s += PLACEHOLDER;
        else if (t.charCodeAt(0) === 32) s = t.slice(1);
        else s += t;
        x = jump[x]!;
      } else x++;
    }
    let a = 0;
    while (a < s.length) {
      const c = s.charCodeAt(a);
      if (c === 40 || c === 91 || c === 34 || c === 0x201c || c === 96) a++;
      else break;
    }
    return s.slice(a).toLowerCase();
  };

  /** Try a boundary after terminal punctuation spanning [p, punctEnd). Returns the end of the sentence, or -1. */
  const boundary = (p: number, punctEnd: number): number => {
    let j = punctEnd;
    let end = punctEnd;
    let d = depth;
    while (j < pe) {
      const k = cls[j];
      if (k === K_PROSE && isCloser(src.charCodeAt(j))) {
        j++;
        end = j;
        continue;
      }
      if (k === K_CLOSE) {
        const ce = jump[j]! > j ? jump[j]! : j + 1;
        if (d > 0) {
          d--;
          j = ce;
          end = j;
          continue;
        }
        j = ce;
        continue;
      }
      if (k === K_INV) {
        j++;
        continue;
      }
      if (k === K_RS) {
        const kind = rk[j]! & 0x7f;
        if (kind === R_CITE || kind === R_FOOTNOTE) {
          j = jump[j]!;
          end = j;
          continue;
        }
        break;
      }
      if (k === K_TIE && j + 1 < pe && cls[j + 1] === K_RS && (rk[j + 1]! & 0x7f) === R_CITE) {
        // "seen.~\cite{x} Next": the citation is tied to the sentence it ends
        j = jump[j + 1]!;
        end = j;
        continue;
      }
      if ((k === K_WS || k === K_CMT) && d > 0) {
        // a group opened in the sentence may close on the next line ("..pb.\n\end{eqnarray}\n\end{widetext}")
        let q = j + 1;
        while (q < pe && (cls[q] === K_WS || cls[q] === K_CMT || cls[q] === K_INV)) q++;
        if (q < pe && cls[q] === K_CLOSE) {
          j = q;
          continue;
        }
      }
      break;
    }
    let q = j;
    let sawWs = false;
    while (q < pe) {
      const k = cls[q];
      if (k === K_WS || k === K_CMT) {
        sawWs = true;
        q++;
        continue;
      }
      if (k === K_INV || k === K_FMT) {
        q++;
        continue;
      }
      if (k === K_OPEN || k === K_CLOSE) {
        q = jump[q]! > q ? jump[q]! : q + 1;
        continue;
      }
      break;
    }
    if (!sawWs || q >= pe) return -1;
    const kq = cls[q];
    if (kq !== K_RS && !(kq === K_PROSE && startsSentence(src, q))) return -1;
    // the token runs up to and including the punctuation (or the region that ends in it)
    if (abbr.has(token(Math.max(tokStart, sStart, ps), punctEnd))) return -1;
    return end;
  };

  const flush = (end: number): void => {
    if (hasWord && end > sStart) out.push(sStart, end);
    sStart = -1;
  };

  while (i < pe) {
    const k = cls[i];
    if (sStart < 0) {
      if (k === K_PROSE || k === K_RS || k === K_FMT || k === K_OPEN) {
        sStart = i;
        depth = 0;
        lastEnd = i;
        tokStart = i;
        prevLetter = false;
        hasWord = false;
      } else {
        i = k === K_CLOSE && jump[i]! > i ? jump[i]! : i + 1;
        continue;
      }
    }
    switch (k) {
      case K_WS:
      case K_CMT:
      case K_TIE:
        tokStart = i + 1;
        prevLetter = false;
        i++;
        break;
      case K_PROSE: {
        const c = src.charCodeAt(i);
        lastEnd = i + 1;
        if (isAsciiLetter(c)) {
          if (prevLetter) hasWord = true;
          prevLetter = true;
        } else prevLetter = false;
        if (c === 46 || c === 63 || c === 33) {
          const e = boundary(i, i + 1);
          if (e >= 0) {
            flush(e);
            i = e;
            continue;
          }
        }
        i++;
        break;
      }
      case K_RS: {
        const e = jump[i]!;
        lastEnd = e;
        prevLetter = false;
        if (rk[i]! & R_TERM) {
          const r = boundary(i, e);
          if (r >= 0) {
            flush(r);
            i = r;
            continue;
          }
        }
        i = e;
        break;
      }
      case K_OPEN: {
        const e = jump[i]! > i ? jump[i]! : i + 1;
        depth++;
        lastEnd = e;
        i = e;
        break;
      }
      case K_CLOSE: {
        const e = jump[i]! > i ? jump[i]! : i + 1;
        if (depth > 0) {
          depth--;
          lastEnd = e;
        }
        i = e;
        break;
      }
      case K_FMT:
        lastEnd = i + 1;
        i++;
        break;
      default:
        i++;
    }
  }
  if (sStart >= 0) flush(lastEnd);
}
