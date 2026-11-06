/**
 * Offset-preserving LaTeX scanner.
 *
 * It classifies every UTF-16 code unit of the source (the "mask") and cuts the text into paragraph
 * ranges of three kinds of streams: the body (prose), captions and footnotes. Nothing is re-printed;
 * the sentence splitter (split.ts) works on the class array and slices the original source.
 *
 * Classes:
 *   SKIP   not running text (preamble, floats outside captions, tables, verbatim, headings)
 *   PROSE  a character of running text
 *   WS     breakable whitespace (spaces, newlines, \\, \newline)
 *   CMT    a comment or an intent line (whitespace for splitting, but a comment line is not blank)
 *   TIE    `~`, `\ `, `\,`, `\quad`...: separates words but never ends a sentence
 *   FMT    zero-width formatting kept in a sentence (\emph, the `\` of `\%`, accents)
 *   OPEN / CLOSE  braces of a group or of a prose argument (zero-width, balance-tracked)
 *   INV    invisible material (\label{..}, \noindent, \vspace{..}, title material): zero-width,
 *          trimmed at sentence edges
 *   RS/RF  an atomic region (math, \cite, \ref, \footnote in its host, \url, unknown macros):
 *          RS at its first unit with jump[] to its end, RF for the rest
 */
import type { Part, UnitKind } from '../../schemas';
import { plainText } from '../../text/normalize';
import {
  ACCENT_LETTERS,
  ACCENT_SYMBOLS,
  CITE_CMDS,
  DIMEN_CMDS,
  DROP_ARGS,
  DROP_BREAK_ARGS,
  ENV_ABSTRACT,
  ENV_ACK,
  ENV_APPENDIX,
  ENV_ARGS,
  ENV_DOCUMENT,
  ENV_FLOAT,
  ENV_INLINE_LIST,
  ENV_LIST,
  ENV_MATH_DISPLAY,
  ENV_MATH_INLINE,
  ENV_SKIP,
  ENV_TRANSPARENT,
  ENV_VERBATIM,
  INVISIBLE_CMDS,
  KEEP_FIRST_CMDS,
  KEEP_LAST_CMDS,
  LINEBREAK_CMDS,
  MACRO_DEF_CMDS,
  MULTICITE_CMDS,
  REF_CMDS,
  REF_RANGE_CMDS,
  SECTION_LEVELS,
  SIUNITX_CMDS,
  TIE_CMDS,
  WRAP_CMDS,
  classifyHeading,
  envCategory,
} from './tables';
import {
  type ArgSpan,
  controlEnd,
  isBlankCode,
  isLetterCode,
  lineEnd,
  macroDefEnd,
  matchBrace,
  matchBraceVerbatim,
  matchBracket,
  readArg,
  readOpt,
  skipArgSpace,
  skipOpts,
  skipOptsSpaced,
  splitKeys,
  stripComments,
  wordAt,
} from './lex';

export const K_SKIP = 0;
export const K_PROSE = 1;
export const K_WS = 2;
export const K_CMT = 3;
export const K_TIE = 4;
export const K_FMT = 5;
export const K_OPEN = 6;
export const K_CLOSE = 7;
export const K_INV = 8;
export const K_RS = 9;
export const K_RF = 10;

/** Region kinds (low 7 bits of rk[]); bit 7 marks a region that ends in terminal punctuation. */
export const R_MATH = 1;
export const R_DISPLAY = 2;
export const R_CITE = 3;
export const R_REF = 4;
export const R_FOOTNOTE = 5;
export const R_CMD = 6;
export const R_VERB = 7;
export const R_TERM = 0x80;

export interface SecInfo {
  kind: 'heading' | 'abstract' | 'ack' | 'front';
  level: number;
  /** Raw title with comments and \label removed, whitespace collapsed. */
  title: string;
  /** plainText of the title (for the part rules and the slug). */
  plain: string;
  start: number;
  part: Part;
  label: string | null;
  /** Final id, assigned by the caller after de-duplication. */
  id: string;
}

export interface ParaRange {
  start: number;
  end: number;
  kind: UnitKind;
  part: Part;
  /** null: before the first heading (resolved to 'front' / 'body' by the caller). */
  sec: SecInfo | null;
}

interface Stream {
  kind: UnitKind;
  body: boolean;
  paraStart: number;
  part: Part;
  sec: SecInfo | null;
}

interface Ctx {
  sec: SecInfo | null;
  part: Part;
  top: Part;
}

/** Nesting depth (environments, footnotes, captions, prose arguments) beyond which nothing recurses. */
const MAX_DEPTH = 48;

const DOC_BEGIN_RE = /\\begin\s*\{document\}/g;
const DOC_END_RE = /\\end\s*\{document\}/g;
const MACRO_RE = /\\(?:re)?newcommand\*?|\\providecommand\*?|\\DeclareRobustCommand\*?|\\[gex]?def(?![A-Za-z])/g;
const JHEP_ABSTRACT_RE = /\\abstract(?![A-Za-z])/g;

/** True if offset `pos` is inside a comment on its line. */
export function inComment(src: string, pos: number): boolean {
  const ls = src.lastIndexOf('\n', pos - 1) + 1;
  for (let i = ls; i < pos; i++) {
    const c = src.charCodeAt(i);
    if (c === 92) {
      i++;
      continue;
    }
    if (c === 37) return true;
  }
  return false;
}

/** Terminal period at the end of display-math content (style_check display_math, plus nested \end{..}). */
export function displayMathEndsSentence(content: string): boolean {
  let c = stripComments(content);
  c = c.replace(/\\(?:label|tag\*?)\s*\{[^{}]*\}|\\(?:nonumber|notag)(?![A-Za-z])/g, '');
  c = c.replace(/\\(?:left|right|bigl|bigr|Bigl|Bigr|big|Big|bigg|Bigg|middle)\s*\./g, '');
  for (let guard = 0; guard < 8; guard++) {
    c = c.replace(/(?:\\\\\*?(?:\[[^\]]*\])?|\\[,;:!]|\\q?quad(?![A-Za-z])|\s|&)+$/, '');
    const m = /\\end\s*\{[A-Za-z]+\*?\}$/.exec(c);
    if (!m) break;
    c = c.slice(0, m.index);
  }
  c = c.replace(/\\(?:text|mathrm|textrm|mbox)\s*\{\s*([.,;])\s*\}\s*$/, '$1');
  return c.endsWith('.') && !c.endsWith('\\.');
}

/** Terminal period at the end of inline-math content (style_check inline_math moves it outside). */
export function inlineMathEndsSentence(content: string): boolean {
  const c = stripComments(content).trim();
  return c.endsWith('.') && !c.endsWith('\\.');
}

export class Scanner {
  readonly n: number;
  readonly cls: Uint8Array;
  readonly jump: Int32Array;
  readonly rk: Uint8Array;
  /** Token text for regions that stand for words (user text macros such as \etc -> "etc."). */
  readonly tokenText = new Map<number, string>();
  readonly paras: ParaRange[] = [];
  readonly secs: SecInfo[] = [];
  readonly labels: string[] = [];
  readonly refs: string[] = [];
  readonly cites: string[] = [];
  fragment = false;

  private curSec: SecInfo | null = null;
  private curPart: Part = 'body';
  private topPart: Part = 'body';
  private inApp = false;
  private headingSeen = false;
  private pendingSec: SecInfo | null = null;
  private envStack: string[] = [];
  private listInline: boolean[] = [];
  private stopAt = -1;
  private depth = 0;
  private readonly beginAlias = new Map<string, string>();
  private readonly endAlias = new Map<string, string>();
  private readonly macroText = new Map<string, string>();
  /** Macros whose body is a whole display (\newcommand{\x}{\[ .. \]}) -> ends with a period. */
  private readonly mathMacro = new Map<string, boolean>();

  constructor(private readonly src: string) {
    this.n = src.length;
    this.cls = new Uint8Array(this.n);
    this.jump = new Int32Array(this.n);
    this.rk = new Uint8Array(this.n);
  }

  run(): void {
    const src = this.src;
    let bodyStart = 0;
    let bodyEnd = this.n;
    let beginAt = -1;
    DOC_BEGIN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DOC_BEGIN_RE.exec(src)) !== null) {
      if (!inComment(src, m.index)) {
        beginAt = m.index;
        bodyStart = m.index + m[0].length;
        break;
      }
    }
    this.fragment = beginAt < 0;
    if (!this.fragment) {
      DOC_END_RE.lastIndex = bodyStart;
      while ((m = DOC_END_RE.exec(src)) !== null) {
        if (!inComment(src, m.index)) {
          bodyEnd = m.index;
          break;
        }
      }
    }
    this.collectMacros();
    const body: Stream = { kind: 'prose', body: true, paraStart: -1, part: 'body', sec: null };
    if (!this.fragment) this.scanPreamble(0, beginAt, body);
    body.paraStart = bodyStart;
    this.scanProse(bodyStart, bodyEnd, body);
    this.breakPara(body, bodyEnd, -1);
  }

  /* ---------------------------------------------------------------------------------- */
  /* Macros: \be/\ee shortcuts for math environments and plain-text macros (\etc)        */
  /* ---------------------------------------------------------------------------------- */

  private collectMacros(): void {
    const src = this.src;
    if (src.indexOf('def') < 0 && src.indexOf('command') < 0) return;
    MACRO_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MACRO_RE.exec(src)) !== null) {
      if (inComment(src, m.index)) continue;
      const isDef = m[0].endsWith('def');
      let j = m.index + m[0].length;
      let name: string | null = null;
      let k = skipArgSpace(src, j, this.n);
      if (k < this.n && src.charCodeAt(k) === 123) {
        const e = matchBrace(src, k, this.n);
        if (e < 0) continue;
        const inner = src.slice(k + 1, e - 1).trim();
        if (/^\\[A-Za-z]+$/.test(inner)) name = inner.slice(1);
        j = e;
      } else if (k < this.n && src.charCodeAt(k) === 92) {
        const e = controlEnd(src, k, this.n);
        if (e - k > 2) name = src.slice(k + 1, e);
        j = e;
      }
      if (!name) continue;
      if (isDef) {
        // \def\name{body} only (no parameter text)
        if (j >= this.n || src.charCodeAt(j) !== 123) continue;
      } else {
        k = skipArgSpace(src, j, this.n);
        if (readOpt(src, k, this.n)) continue; // takes arguments
        j = k;
      }
      const a = readArg(src, j, this.n);
      if (!a) continue;
      this.noteMacro(name, src.slice(a.open + 1, a.end - 1));
      MACRO_RE.lastIndex = a.end;
    }
  }

  private noteMacro(name: string, body: string): void {
    const b = stripComments(body).trim();
    const bm = /^\\begin\s*\{([A-Za-z]+\*?)\}/.exec(b);
    if (bm) {
      const env = bm[1]!;
      const cat = envCategory(env);
      if (cat === ENV_MATH_DISPLAY || cat === ENV_MATH_INLINE) {
        const close = /\\end\s*\{([A-Za-z]+\*?)\}$/.exec(b);
        // a macro holding a whole display is one math region, not the opening of one
        if (close && close[1] === env) this.mathMacro.set(name, cat === ENV_MATH_DISPLAY ? displayMathEndsSentence(b.slice(bm[0].length, close.index)) : false);
        else this.beginAlias.set(name, env);
      }
      return;
    }
    if (/^(?:\\\[[^]*\\\]|\$\$[^]*\$\$)$/.test(b)) {
      this.mathMacro.set(name, displayMathEndsSentence(b.slice(2, -2)));
      return;
    }
    const em = /\\end\s*\{([A-Za-z]+\*?)\}$/.exec(b);
    if (em && /^\\end\s*\{/.test(b)) {
      const cat = envCategory(em[1]!);
      if (cat === ENV_MATH_DISPLAY || cat === ENV_MATH_INLINE) this.endAlias.set(name, em[1]!);
      return;
    }
    const t = b.replace(/\\xspace(?![A-Za-z])|\\@|\\\/|\\ |\{\}/g, '').replace(/\s+/g, ' ').trim();
    if (t && t.length <= 40 && /^[^\\${}%~#&^_]+$/.test(t)) this.macroText.set(name, t);
  }

  /* ---------------------------------------------------------------------------------- */
  /* Preamble: only the JHEP-style \abstract{..} is running text                          */
  /* ---------------------------------------------------------------------------------- */

  private scanPreamble(from: number, to: number, body: Stream): void {
    const src = this.src;
    JHEP_ABSTRACT_RE.lastIndex = from;
    let m: RegExpExecArray | null;
    while ((m = JHEP_ABSTRACT_RE.exec(src)) !== null && m.index < to) {
      if (inComment(src, m.index)) continue;
      const a = readArg(src, m.index + m[0].length, to);
      if (!a) continue;
      this.abstractArg(m.index, a, body);
      JHEP_ABSTRACT_RE.lastIndex = a.end;
    }
  }

  /* ---------------------------------------------------------------------------------- */
  /* Paragraphs, sections, context                                                        */
  /* ---------------------------------------------------------------------------------- */

  private breakPara(st: Stream, end: number, next: number): void {
    if (st.paraStart >= 0 && end > st.paraStart) {
      this.paras.push({
        start: st.paraStart,
        end,
        kind: st.kind,
        part: st.body ? this.curPart : st.part,
        sec: st.body ? this.curSec : st.sec,
      });
    }
    st.paraStart = next;
  }

  private saveCtx(): Ctx {
    return { sec: this.curSec, part: this.curPart, top: this.topPart };
  }

  /** Back from an abstract or acknowledgments block. In a full document, text after the abstract and before
   * any heading is the introduction (style_check build_blocks: a letter without an Introduction heading);
   * a fragment stays 'body'. */
  private restoreCtx(c: Ctx, afterAbstract: boolean): void {
    this.curSec = c.sec;
    if (afterAbstract && !this.headingSeen && !this.inApp && !this.fragment) {
      this.curPart = 'intro';
      this.topPart = 'intro';
    } else {
      this.curPart = c.part;
      this.topPart = c.top;
    }
  }

  private pseudoSection(kind: 'abstract' | 'ack', start: number): SecInfo {
    const sec: SecInfo =
      kind === 'abstract'
        ? { kind, level: 1, title: 'Abstract', plain: 'Abstract', start, part: 'abstract', label: null, id: '' }
        : { kind, level: 1, title: 'Acknowledgments', plain: 'Acknowledgments', start, part: 'body', label: null, id: '' };
    this.secs.push(sec);
    return sec;
  }

  /* ---------------------------------------------------------------------------------- */
  /* Classification helpers                                                               */
  /* ---------------------------------------------------------------------------------- */

  private fill(k: number, a: number, b: number): void {
    if (b > a) this.cls.fill(k, a, b);
  }

  private region(a: number, b: number, kind: number, term = false): void {
    if (b <= a) return;
    this.cls[a] = K_RS;
    if (b > a + 1) this.cls.fill(K_RF, a + 1, b);
    this.jump[a] = b;
    this.rk[a] = kind | (term ? R_TERM : 0);
  }

  /** A multi-unit OPEN/CLOSE token (\begin{..} / \end{..} of an inline environment): kind at a, jump to b. */
  private marker(kind: number, a: number, b: number): void {
    if (b <= a) return;
    this.cls[a] = kind;
    if (b > a + 1) this.cls.fill(K_RF, a + 1, b);
    this.jump[a] = b;
  }

  private content(st: Stream): void {
    if (st.body && this.pendingSec !== null) this.pendingSec = null;
  }

  /** Scan [a, b) with the same stream but without stopping at enclosing \end{..}. */
  private scanSub(a: number, b: number, st: Stream): void {
    if (this.depth >= MAX_DEPTH) {
      this.fill(K_INV, a, b);
      return;
    }
    const env = this.envStack;
    const lists = this.listInline;
    this.envStack = [];
    this.listInline = [];
    this.depth++;
    this.scanProse(a, b, st);
    this.depth--;
    this.envStack = env;
    this.listInline = lists;
  }

  /** A caption or footnote argument [a, b) becomes its own stream. */
  private nested(kind: 'caption' | 'footnote', a: number, b: number): void {
    if (this.depth >= MAX_DEPTH) return;
    const st: Stream = { kind, body: false, paraStart: a, part: kind, sec: this.curSec };
    this.scanSub(a, b, st);
    this.breakPara(st, b, -1);
  }

  private recordKeys(list: string[], a: number, b: number): void {
    for (const k of splitKeys(this.src.slice(a, b))) list.push(k);
  }

  /* ---------------------------------------------------------------------------------- */
  /* Prose mode                                                                           */
  /* ---------------------------------------------------------------------------------- */

  /** Scan [from, to) as running text. Returns `to`, or the offset of an `\end{X}` closing an enclosing environment. */
  scanProse(from: number, to: number, st: Stream): number {
    const src = this.src;
    const cls = this.cls;
    let i = from;
    while (i < to) {
      const c = src.charCodeAt(i);
      if (c === 10) {
        cls[i] = K_WS;
        let k = i + 1;
        while (k < to && isBlankCode(src.charCodeAt(k))) k++;
        if (k < to && src.charCodeAt(k) === 10) {
          // a blank line ends the paragraph
          this.breakPara(st, i, k);
          for (let q = i + 1; q < k; q++) cls[q] = K_WS;
          i = k;
          continue;
        }
        i++;
        continue;
      }
      if (c === 32 || c === 9 || c === 13 || c === 12 || c === 11) {
        cls[i] = K_WS;
        i++;
        continue;
      }
      if (c === 37) {
        const e = lineEnd(src, i, to);
        this.fill(K_CMT, i, e);
        i = e;
        continue;
      }
      if (c === 92) {
        i = this.command(i, to, st);
        if (this.stopAt >= 0) {
          const s = this.stopAt;
          this.stopAt = -1;
          return s;
        }
        continue;
      }
      if (c === 36) {
        i = this.dollar(i, to, st);
        continue;
      }
      if (c === 123) {
        cls[i] = K_OPEN;
        i++;
        continue;
      }
      if (c === 125) {
        cls[i] = K_CLOSE;
        i++;
        continue;
      }
      if (c === 126 || c === 38 || c === 0xa0 || c === 0x202f) {
        cls[i] = K_TIE;
        i++;
        continue;
      }
      if ((c >= 0x2000 && c <= 0x200a) || c === 0x205f || c === 0x3000 || c === 0x2028 || c === 0x2029) {
        cls[i] = K_WS;
        i++;
        continue;
      }
      if (c === 0xfeff || c === 0x200b) {
        cls[i] = K_INV;
        i++;
        continue;
      }
      cls[i] = K_PROSE;
      if (st.body && this.pendingSec !== null) this.pendingSec = null;
      i++;
    }
    return to;
  }

  /* ---------------------------------------------------------------------------------- */
  /* Math                                                                                 */
  /* ---------------------------------------------------------------------------------- */

  /** Closing `$` (single) or `$$` (double) of math starting at k, at brace depth 0, not across a blank line. */
  private findDollar(k: number, to: number, double: boolean): number {
    const src = this.src;
    let depth = 0;
    while (k < to) {
      const c = src.charCodeAt(k);
      if (c === 92) {
        k += 2;
        continue;
      }
      if (c === 37) {
        k = lineEnd(src, k, to);
        continue;
      }
      if (c === 123) depth++;
      else if (c === 125) {
        if (depth > 0) depth--;
      } else if (c === 36 && depth === 0) {
        if (!double) return k;
        if (k + 1 < to && src.charCodeAt(k + 1) === 36) return k;
      } else if (c === 10) {
        let q = k + 1;
        while (q < to && isBlankCode(src.charCodeAt(q))) q++;
        if (q < to && src.charCodeAt(q) === 10) return -1;
      }
      k++;
    }
    return -1;
  }

  /** Closing `\)` or `\]` (closer = ')' or ']') at brace depth 0, not across a blank line. */
  private findMathClose(k: number, to: number, closer: number): number {
    const src = this.src;
    let depth = 0;
    while (k < to) {
      const c = src.charCodeAt(k);
      if (c === 92) {
        if (k + 1 < to && src.charCodeAt(k + 1) === closer && depth === 0) return k;
        k += 2;
        continue;
      }
      if (c === 37) {
        k = lineEnd(src, k, to);
        continue;
      }
      if (c === 123) depth++;
      else if (c === 125) {
        if (depth > 0) depth--;
      } else if (c === 10) {
        let q = k + 1;
        while (q < to && isBlankCode(src.charCodeAt(q))) q++;
        if (q < to && src.charCodeAt(q) === 10) return -1;
      }
      k++;
    }
    return -1;
  }

  private dollar(i: number, to: number, st: Stream): number {
    const src = this.src;
    if (i + 1 < to && src.charCodeAt(i + 1) === 36) {
      const e = this.findDollar(i + 2, to, true);
      if (e < 0) {
        this.fill(K_PROSE, i, i + 2);
        return i + 2;
      }
      this.region(i, e + 2, R_DISPLAY, displayMathEndsSentence(src.slice(i + 2, e)));
      this.scanMath(i + 2, e);
      this.content(st);
      return e + 2;
    }
    const e = this.findDollar(i + 1, to, false);
    if (e < 0) {
      this.cls[i] = K_PROSE;
      return i + 1;
    }
    this.region(i, e + 1, R_MATH, inlineMathEndsSentence(src.slice(i + 1, e)));
    this.scanMath(i + 1, e);
    this.content(st);
    return e + 1;
  }

  /** Record \label, \ref-like and \cite-like keys inside math or other skipped material [a, b). */
  private scanMath(a: number, b: number): void {
    const src = this.src;
    let k = a;
    while (k < b) {
      const c = src.charCodeAt(k);
      if (c === 37) {
        k = lineEnd(src, k, b);
        continue;
      }
      if (c !== 92) {
        k++;
        continue;
      }
      const e = controlEnd(src, k, b);
      if (e - k > 2) {
        const name = src.slice(k + 1, e);
        if (name === 'label' || CITE_CMDS.has(name) || REF_CMDS.has(name) || REF_RANGE_CMDS.has(name)) {
          let h = e;
          if (h < b && src.charCodeAt(h) === 42) h++;
          h = skipOpts(src, h, b);
          const arg = readArg(src, h, b);
          if (arg) {
            const list = name === 'label' ? this.labels : CITE_CMDS.has(name) ? this.cites : this.refs;
            this.recordKeys(list, arg.open + 1, arg.end - 1);
            k = arg.end;
            continue;
          }
        }
      }
      k = e;
    }
  }

  /* ---------------------------------------------------------------------------------- */
  /* Environments                                                                         */
  /* ---------------------------------------------------------------------------------- */

  /** begin token offset -> [start, end) of its matching `\end{name}` (or end-alias macro). Built once. */
  private envPairs: Map<number, [number, number]> | null = null;

  /**
   * Matching end of the environment whose \begin (or begin-alias macro) starts at `beginAt`:
   * [start, end) of `\end{name}` (or of an end alias such as \ee), honouring nesting by name and
   * comments; null if it does not close at or after `from` and before `to`. All pairs come from one pass
   * over the source (per-name stacks), so an unclosed environment never costs more than once.
   */
  findEnvEnd(beginAt: number, from: number, to: number): [number, number] | null {
    if (!this.envPairs) this.envPairs = this.pairEnvironments();
    const m = this.envPairs.get(beginAt);
    if (!m || m[0] < from || m[1] > to) return null;
    return m;
  }

  private pairEnvironments(): Map<number, [number, number]> {
    const src = this.src;
    const n = this.n;
    const aliases = this.beginAlias.size > 0 || this.endAlias.size > 0;
    const stacks = new Map<string, number[]>();
    const out = new Map<number, [number, number]>();
    const open = (env: string, at: number): void => {
      const st = stacks.get(env);
      if (st) st.push(at);
      else stacks.set(env, [at]);
    };
    const close = (env: string, a: number, b: number): void => {
      const at = stacks.get(env)?.pop();
      if (at !== undefined) out.set(at, [a, b]);
    };
    let k = 0;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (c === 37) {
        k = lineEnd(src, k, n);
        continue;
      }
      if (c !== 92) {
        k++;
        continue;
      }
      const e = controlEnd(src, k, n);
      if (e - k <= 2) {
        k = e;
        continue;
      }
      const isBegin = wordAt(src, k + 1, e, 'begin');
      if (isBegin || wordAt(src, k + 1, e, 'end')) {
        const a = readArg(src, e, n);
        if (a) {
          const env = src.slice(a.open + 1, a.end - 1).trim();
          if (isBegin) open(env, k);
          else close(env, k, a.end);
          k = a.end;
          continue;
        }
        k = e;
        continue;
      }
      if (aliases) {
        const w = src.slice(k + 1, e);
        const b = this.beginAlias.get(w);
        if (b !== undefined) open(b, k);
        else {
          const en = this.endAlias.get(w);
          if (en !== undefined) close(en, k, e);
        }
      }
      k = e;
    }
    return out;
  }

  private beginEnv(i: number, j: number, to: number, st: Stream): number {
    const src = this.src;
    const a = readArg(src, j, to);
    if (!a) {
      this.fill(K_INV, i, j);
      return j;
    }
    const name = src.slice(a.open + 1, a.end - 1).trim();
    const cat = envCategory(name);
    const head = a.end;
    switch (cat) {
      case ENV_DOCUMENT:
        this.fill(K_INV, i, head);
        return head;
      case ENV_MATH_DISPLAY:
      case ENV_MATH_INLINE:
        return this.mathEnv(i, head, name, cat === ENV_MATH_DISPLAY, to, st);
      case ENV_VERBATIM: {
        const close = '\\end{' + name + '}';
        const e = src.indexOf(close, head);
        if (e < 0 || e + close.length > to) {
          this.breakPara(st, i, head);
          this.fill(K_INV, i, head);
          return head;
        }
        this.breakPara(st, i, e + close.length);
        return e + close.length;
      }
      case ENV_FLOAT:
      case ENV_SKIP: {
        const end = this.findEnvEnd(i, head, to);
        if (!end) {
          this.breakPara(st, i, head);
          this.fill(K_INV, i, head);
          return head;
        }
        // not prose: a \label after the float still names the heading before it
        this.breakPara(st, i, end[1]);
        this.scanSkip(head, end[0], cat === ENV_FLOAT);
        return end[1];
      }
      default:
        return this.proseEnv(i, head, name, cat, to, st);
    }
  }

  private mathEnv(i: number, head: number, name: string, display: boolean, to: number, st: Stream): number {
    const end = this.findEnvEnd(i, head, to);
    if (!end) {
      // unclosed (the author is typing): the \begin token is still where a display starts
      this.region(i, head, R_CMD);
      this.content(st);
      return head;
    }
    const inner = this.src.slice(head, end[0]);
    const term = display ? displayMathEndsSentence(inner) : inlineMathEndsSentence(inner);
    this.region(i, end[1], display ? R_DISPLAY : R_MATH, term);
    this.scanMath(head, end[0]);
    this.content(st);
    return end[1];
  }

  private proseEnv(i: number, head: number, name: string, cat: number, to: number, st: Stream): number {
    const src = this.src;
    let h = skipOptsSpaced(src, head, to, 2);
    const nargs = ENV_ARGS.get(name) ?? 0;
    for (let q = 0; q < nargs; q++) {
      const a = readArg(src, h, to);
      if (!a) break;
      h = skipOpts(src, a.end, to, 2);
    }
    const inline = cat === ENV_INLINE_LIST || cat === ENV_TRANSPARENT;
    if (this.depth >= MAX_DEPTH) {
      // pathological nesting: no recursion, the \end{..} will read as a stray end
      this.fill(K_INV, i, h);
      if (!inline) this.breakPara(st, i, h);
      return h;
    }
    // an inline environment balances like a brace group inside its sentence
    if (inline) this.marker(K_OPEN, i, h);
    else {
      this.fill(K_INV, i, h);
      this.breakPara(st, i, h);
    }
    let saved: Ctx | null = null;
    if (st.body) {
      if (cat === ENV_ABSTRACT) {
        saved = this.saveCtx();
        this.curSec = this.pseudoSection('abstract', i);
        this.curPart = 'abstract';
      } else if (cat === ENV_ACK) {
        saved = this.saveCtx();
        this.curSec = this.pseudoSection('ack', i);
        this.curPart = 'body';
      } else if (cat === ENV_APPENDIX) {
        this.inApp = true;
        this.curPart = 'app';
        this.topPart = 'app';
      }
      if (!inline) this.pendingSec = null;
    }
    const isList = cat === ENV_LIST || cat === ENV_INLINE_LIST;
    this.envStack.push(name);
    if (isList) this.listInline.push(cat === ENV_INLINE_LIST);
    this.depth++;
    const p = this.scanProse(h, to, st);
    this.depth--;
    this.envStack.pop();
    if (isList) this.listInline.pop();
    let r = p;
    if (p < to) {
      const a = readArg(src, p + 4, to);
      const endName = a ? src.slice(a.open + 1, a.end - 1).trim() : '';
      if (a && endName === name) {
        if (inline) this.marker(K_CLOSE, p, a.end);
        else {
          this.breakPara(st, p, a.end);
          this.fill(K_INV, p, a.end);
        }
        r = a.end;
      } else if (!inline) this.breakPara(st, p, p);
    } else if (!inline) this.breakPara(st, p, p);
    if (saved) this.restoreCtx(saved, cat === ENV_ABSTRACT);
    return r;
  }

  /* ---------------------------------------------------------------------------------- */
  /* Skip mode: floats, tables, pictures. Only captions are running text.                 */
  /* ---------------------------------------------------------------------------------- */

  private scanSkip(from: number, to: number, captions: boolean): void {
    const src = this.src;
    let k = from;
    while (k < to) {
      const c = src.charCodeAt(k);
      if (c === 37) {
        k = lineEnd(src, k, to);
        continue;
      }
      if (c === 36) {
        const double = k + 1 < to && src.charCodeAt(k + 1) === 36;
        const e = this.findDollar(k + (double ? 2 : 1), to, double);
        if (e < 0) {
          k += double ? 2 : 1;
          continue;
        }
        this.scanMath(k, e);
        k = e + (double ? 2 : 1);
        continue;
      }
      if (c !== 92) {
        k++;
        continue;
      }
      const e = controlEnd(src, k, to);
      if (e - k <= 2) {
        const s = src.charCodeAt(k + 1);
        if (s === 40 || s === 91) {
          const close = this.findMathClose(e, to, s === 40 ? 41 : 93);
          if (close >= 0) {
            this.scanMath(e, close);
            k = close + 2;
            continue;
          }
        }
        k = e;
        continue;
      }
      const name = src.slice(k + 1, e);
      if (
        captions &&
        (name === 'caption' || name === 'subcaption' || name === 'captionof' || name === 'subcaptionbox' ||
          name === 'subfloat' || name === 'subfigure' || name === 'subtable')
      ) {
        k = this.caption(k, e, name, to, null);
        continue;
      }
      if (name === 'label' || CITE_CMDS.has(name) || MULTICITE_CMDS.has(name) || REF_CMDS.has(name) || REF_RANGE_CMDS.has(name)) {
        let h = e;
        if (h < to && src.charCodeAt(h) === 42) h++;
        h = skipOpts(src, h, to);
        const a = readArg(src, h, to);
        if (a) {
          const list = name === 'label' ? this.labels : CITE_CMDS.has(name) || MULTICITE_CMDS.has(name) ? this.cites : this.refs;
          this.recordKeys(list, a.open + 1, a.end - 1);
          k = a.end;
          continue;
        }
        k = h;
        continue;
      }
      if (name === 'begin') {
        const a = readArg(src, e, to);
        if (a) {
          const env = src.slice(a.open + 1, a.end - 1).trim();
          const cat = envCategory(env);
          if (cat === ENV_VERBATIM) {
            const close = src.indexOf('\\end{' + env + '}', a.end);
            k = close >= 0 && close < to ? close : a.end;
            continue;
          }
          k = a.end;
          continue;
        }
      }
      if (name === 'verb') {
        let d = e;
        if (d < to && src.charCodeAt(d) === 42) d++;
        const delim = src[d];
        if (delim) {
          const close = src.indexOf(delim, d + 1);
          if (close > 0 && close < lineEnd(src, d + 1, to)) {
            k = close + 1;
            continue;
          }
        }
      }
      if ((name === 'url' || name === 'href' || name === 'path') && e < to && src.charCodeAt(e) === 123) {
        const v = matchBraceVerbatim(src, e, to);
        if (v > 0) {
          k = v;
          continue;
        }
      }
      k = e;
    }
  }

  /**
   * Caption-like command at k (name ends at e). Its caption text becomes a caption stream; the rest of
   * the command (subfloat contents) is skipped. `st` is the host prose stream (\captionof outside a
   * float), or null inside a float. Returns the end of the command.
   */
  private caption(k: number, e: number, name: string, to: number, st: Stream | null): number {
    const src = this.src;
    let h = e;
    if (h < to && src.charCodeAt(h) === 42) h++;
    let cap: ArgSpan | null = null;
    let contentArg: ArgSpan | null = null;
    if (name === 'subfloat' || name === 'subfigure' || name === 'subtable') {
      // \subfloat[list entry][caption]{body} or \subfloat[caption]{body}
      const o1 = readOpt(src, h, to);
      if (o1) {
        const o2 = readOpt(src, o1.end, to);
        cap = o2 ?? o1;
        h = cap.end;
        contentArg = readArg(src, h, to);
      }
    } else if (name === 'subcaptionbox') {
      h = skipOpts(src, h, to, 1);
      cap = readArg(src, h, to);
      if (cap) {
        h = skipOpts(src, cap.end, to, 2);
        contentArg = readArg(src, h, to);
      }
    } else {
      if (name === 'captionof') {
        const t = readArg(src, h, to);
        if (t) h = t.end;
      }
      h = skipOpts(src, h, to, 1);
      cap = readArg(src, h, to);
    }
    if (!cap) {
      if (st) this.fill(K_INV, k, h);
      return h;
    }
    if (st) {
      this.breakPara(st, k, -1);
      this.content(st);
    }
    this.nested('caption', cap.open + 1, cap.end - 1);
    let end = cap.end;
    if (contentArg) {
      this.scanSkip(contentArg.open + 1, contentArg.end - 1, true);
      end = contentArg.end;
    }
    if (st) st.paraStart = end;
    return end;
  }

  /* ---------------------------------------------------------------------------------- */
  /* Commands                                                                             */
  /* ---------------------------------------------------------------------------------- */

  private command(i: number, to: number, st: Stream): number {
    const src = this.src;
    const cls = this.cls;
    if (i + 1 >= to) {
      cls[i] = K_INV;
      return i + 1;
    }
    const c1 = src.charCodeAt(i + 1);
    if (!isLetterCode(c1)) return this.controlSymbol(i, c1, to, st);
    let j = i + 2;
    while (j < to && isLetterCode(src.charCodeAt(j))) j++;
    const name = src.slice(i + 1, j);

    if (name === 'begin') return this.beginEnv(i, j, to, st);
    if (name === 'end') {
      const a = readArg(src, j, to);
      const env = a ? src.slice(a.open + 1, a.end - 1).trim() : '';
      if (a && this.envStack.includes(env)) {
        this.stopAt = i;
        return i;
      }
      const e = a ? a.end : j;
      if (envCategory(env) !== ENV_TRANSPARENT && envCategory(env) !== ENV_INLINE_LIST) this.breakPara(st, i, e);
      this.fill(K_INV, i, e);
      return e;
    }
    const display = this.mathMacro.get(name);
    if (display !== undefined) {
      let h = j;
      if (h + 1 < to && src.charCodeAt(h) === 123 && src.charCodeAt(h + 1) === 125) h += 2;
      this.region(i, h, R_DISPLAY, display);
      this.content(st);
      return h;
    }
    const alias = this.beginAlias.get(name);
    if (alias !== undefined) {
      let h = j;
      if (h + 1 < to && src.charCodeAt(h) === 123 && src.charCodeAt(h + 1) === 125) h += 2;
      return this.mathEnv(i, h, alias, envCategory(alias) === ENV_MATH_DISPLAY, to, st);
    }
    if (this.endAlias.has(name)) {
      this.fill(K_INV, i, j);
      return j;
    }
    const level = SECTION_LEVELS.get(name);
    if (level !== undefined) return this.heading(i, j, level, to, st);
    if (name === 'appendix' || name === 'appendices') {
      if (st.body) {
        this.breakPara(st, i, j);
        this.inApp = true;
        this.curPart = 'app';
        this.topPart = 'app';
      }
      this.fill(K_INV, i, j);
      return j;
    }
    if (name === 'item') {
      const h = skipOptsSpaced(src, j, to, 1);
      const inline = this.listInline.length > 0 && this.listInline[this.listInline.length - 1] === true;
      if (!inline) {
        this.breakPara(st, i, h);
        if (st.body) this.pendingSec = null;
      }
      this.fill(K_INV, i, h);
      return h;
    }
    if (name === 'par') {
      this.breakPara(st, i, j);
      this.fill(K_INV, i, j);
      return j;
    }
    if (CITE_CMDS.has(name) || MULTICITE_CMDS.has(name)) return this.cite(i, j, to, st, MULTICITE_CMDS.has(name));
    if (REF_CMDS.has(name) || REF_RANGE_CMDS.has(name)) return this.ref(i, j, to, st, REF_RANGE_CMDS.has(name));
    if (name === 'label') {
      const a = readArg(src, j, to);
      if (!a) {
        this.fill(K_INV, i, j);
        return j;
      }
      const key = stripComments(src.slice(a.open + 1, a.end - 1)).trim();
      this.labels.push(key);
      this.fill(K_INV, i, a.end);
      if (st.body && this.pendingSec !== null) {
        this.pendingSec.label = key;
        this.pendingSec = null;
      }
      return a.end;
    }
    if (name === 'footnote' || name === 'footnotetext') return this.footnote(i, j, to, st);
    if (name === 'caption' || name === 'subcaption' || name === 'captionof' || name === 'subcaptionbox' || name === 'subfloat') {
      return this.caption(i, j, name, to, st);
    }
    if (WRAP_CMDS.has(name)) {
      let h = j;
      if (h < to && src.charCodeAt(h) === 42) h++;
      this.fill(K_FMT, i, h);
      for (let o = readOpt(src, h, to); o; o = readOpt(src, h, to)) {
        this.fill(K_INV, h, o.end);
        h = o.end;
      }
      return h;
    }
    const keepLast = KEEP_LAST_CMDS.get(name);
    if (keepLast !== undefined) {
      this.fill(K_FMT, i, j);
      let h = j;
      for (let q = 0; q < keepLast - 1; q++) {
        const h0 = h;
        h = skipOpts(src, h, to);
        const a = readArg(src, h, to);
        if (!a) {
          this.fill(K_INV, h0, h);
          return h;
        }
        this.fill(K_INV, h0, a.end);
        h = a.end;
      }
      const h1 = skipOpts(src, h, to);
      this.fill(K_INV, h, h1);
      return h1;
    }
    if (KEEP_FIRST_CMDS.has(name)) {
      let h = skipOpts(src, j, to);
      this.fill(K_FMT, i, j);
      this.fill(K_INV, j, h);
      const a1 = readArg(src, h, to);
      if (!a1) return h;
      this.fill(K_INV, h, a1.open);
      this.cls[a1.open] = K_OPEN;
      this.scanSub(a1.open + 1, a1.end - 1, st);
      this.cls[a1.end - 1] = K_CLOSE;
      h = a1.end;
      const a2 = readArg(src, h, to);
      if (a2) {
        this.fill(K_INV, h, a2.end);
        h = a2.end;
      }
      return h;
    }
    if (name === 'href') {
      const k = skipArgSpace(src, j, to);
      if (k < to && src.charCodeAt(k) === 123) {
        const e = matchBraceVerbatim(src, k, to);
        if (e > 0) {
          this.fill(K_FMT, i, k);
          this.fill(K_INV, k, e);
          return e;
        }
      }
      this.region(i, j, R_CMD);
      this.content(st);
      return j;
    }
    if (name === 'hyperref') {
      const o = readOpt(src, j, to);
      if (o) {
        this.recordKeys(this.refs, o.open + 1, o.end - 1);
        this.fill(K_FMT, i, o.end);
        return o.end;
      }
      this.fill(K_FMT, i, j);
      return j;
    }
    if (name === 'url' || name === 'path' || name === 'nolinkurl') return this.verbLike(i, j, to, st, false);
    if (name === 'verb' || name === 'lstinline' || name === 'mintinline') return this.verbLike(i, j, to, st, true, name);
    const si = SIUNITX_CMDS.get(name);
    if (si !== undefined) {
      let h = skipOpts(src, j, to);
      for (let q = 0; q < si; q++) {
        const a = readArg(src, h, to);
        if (!a) break;
        h = skipOpts(src, a.end, to);
      }
      this.region(i, h, R_CMD);
      this.content(st);
      return h;
    }
    if (name === 'ensuremath') {
      const a = readArg(src, j, to);
      if (!a) {
        this.region(i, j, R_CMD);
        return j;
      }
      this.region(i, a.end, R_MATH, inlineMathEndsSentence(src.slice(a.open + 1, a.end - 1)));
      this.scanMath(a.open + 1, a.end - 1);
      this.content(st);
      return a.end;
    }
    const dropBreak = DROP_BREAK_ARGS.get(name);
    if (dropBreak !== undefined) {
      const h = this.skipDropArgs(j, to, dropBreak);
      this.breakPara(st, i, h);
      this.fill(K_INV, i, h);
      return h;
    }
    const drop = DROP_ARGS.get(name);
    if (drop !== undefined) {
      const h = this.skipDropArgs(j, to, drop);
      this.fill(K_INV, i, h);
      return h;
    }
    if (INVISIBLE_CMDS.has(name)) {
      let h = j;
      if (h + 1 < to && src.charCodeAt(h) === 123 && src.charCodeAt(h + 1) === 125) h += 2;
      this.fill(K_INV, i, h);
      return h;
    }
    if (TIE_CMDS.has(name) || DIMEN_CMDS.has(name)) {
      let h = j;
      if (name === 'hspace') {
        if (h < to && src.charCodeAt(h) === 42) h++;
        const a = readArg(src, h, to);
        if (a) h = a.end;
      } else if (DIMEN_CMDS.has(name)) {
        const mm = /^\s*[-+]?\d*\.?\d+\s*(?:pt|mm|cm|em|ex|in|bp|pc|sp|mu|true\s*pt|\\[A-Za-z]+)(?:\s*(?:plus|minus)\s*[-+]?\d*\.?\d+\s*(?:pt|mm|cm|em|ex|fil+))*/.exec(
          src.slice(j, Math.min(to, j + 60)),
        );
        if (mm) h = j + mm[0].length;
      }
      this.fill(name === 'vskip' ? K_INV : K_TIE, i, h);
      return h;
    }
    if (LINEBREAK_CMDS.has(name)) {
      this.fill(K_WS, i, j);
      return j;
    }
    if (MACRO_DEF_CMDS.has(name)) {
      const h = Math.max(j, macroDefEnd(src, name, j, to));
      this.fill(K_INV, i, h);
      return h;
    }
    if (name === 'iffalse') {
      const fi = this.findFi(j, to);
      if (fi < 0) {
        this.fill(K_INV, i, j);
        return j;
      }
      this.fill(K_CMT, i, fi);
      return fi;
    }
    if (name === 'abstract' && st.body) {
      const a = readArg(src, j, to);
      if (a) return this.abstractArg(i, a, st);
    }
    if ((name === 'acknowledgments' || name === 'acknowledgements') && st.body) {
      this.breakPara(st, i, j);
      this.curSec = this.pseudoSection('ack', i);
      this.curPart = 'body';
      this.pendingSec = null;
      this.fill(K_INV, i, j);
      return j;
    }
    if (name.length === 1 && ACCENT_LETTERS.has(name)) {
      const d = j < to ? src.charCodeAt(j) : 0;
      if (d === 123) {
        this.fill(K_FMT, i, j);
        return j;
      }
      if (d === 32 && j + 1 < to && isLetterCode(src.charCodeAt(j + 1))) {
        this.fill(K_FMT, i, j + 1);
        return j + 1;
      }
    }
    // Unknown macro or text symbol: an atomic region (its brace arguments stay prose).
    let h = j;
    if (h + 1 < to && src.charCodeAt(h) === 123 && src.charCodeAt(h + 1) === 125) h += 2;
    else if (h < to && src.charCodeAt(h) === 91) {
      const e = matchBracket(src, h, to);
      if (e > 0 && e - h <= 120) h = e;
    }
    const mt = this.macroText.get(name);
    let term = false;
    if (mt !== undefined) {
      term = /[.?!]$/.test(mt);
      if (term) {
        const sp = mt.lastIndexOf(' ');
        this.tokenText.set(i, sp >= 0 ? ' ' + mt.slice(sp + 1) : mt);
      }
    }
    this.region(i, h, R_CMD, term);
    this.content(st);
    return h;
  }

  private controlSymbol(i: number, c1: number, to: number, st: Stream): number {
    const src = this.src;
    const cls = this.cls;
    switch (c1) {
      case 92: {
        // \\ line break, \\* and \\[len]
        let h = i + 2;
        if (h < to && src.charCodeAt(h) === 42) h++;
        this.fill(K_WS, i, h);
        const o = readOpt(src, h, to);
        if (o) {
          this.fill(K_INV, h, o.end);
          h = o.end;
        }
        return h;
      }
      case 10:
        cls[i] = K_TIE; // control space at the end of a line; the newline is scanned normally
        return i + 1;
      case 44: // \,
      case 59: // \;
      case 58: // \:
      case 33: // \!
      case 32: // control space
      case 9:
      case 13:
        this.fill(K_TIE, i, i + 2);
        return i + 2;
      case 40: {
        // \( ... \)
        const e = this.findMathClose(i + 2, to, 41);
        if (e < 0) {
          this.fill(K_INV, i, i + 2);
          return i + 2;
        }
        this.region(i, e + 2, R_MATH, inlineMathEndsSentence(src.slice(i + 2, e)));
        this.scanMath(i + 2, e);
        this.content(st);
        return e + 2;
      }
      case 91: {
        // \[ ... \]
        const e = this.findMathClose(i + 2, to, 93);
        if (e < 0) {
          this.fill(K_INV, i, i + 2);
          return i + 2;
        }
        this.region(i, e + 2, R_DISPLAY, displayMathEndsSentence(src.slice(i + 2, e)));
        this.scanMath(i + 2, e);
        this.content(st);
        return e + 2;
      }
      case 41:
      case 93:
      case 64: // \@
      case 47: // \/
      case 45: // \-
      case 42: // \*
        this.fill(K_INV, i, i + 2);
        return i + 2;
      case 37: // \%
      case 38: // \&
      case 35: // \#
      case 95: // \_
      case 36: // \$
      case 123: // \{
      case 125: // \}
      case 124: // \|
        cls[i] = K_FMT;
        cls[i + 1] = K_PROSE;
        this.content(st);
        return i + 2;
      default:
        if (ACCENT_SYMBOLS.indexOf(String.fromCharCode(c1)) >= 0) {
          this.fill(K_FMT, i, i + 2);
          return i + 2;
        }
        this.region(i, i + 2, R_CMD);
        this.content(st);
        return i + 2;
    }
  }

  private heading(i: number, j: number, level: number, to: number, st: Stream): number {
    const src = this.src;
    let h = j;
    if (h < to && src.charCodeAt(h) === 42) h++;
    h = skipOpts(src, h, to, 1);
    const a = readArg(src, h, to);
    if (!a) {
      this.fill(K_INV, i, h);
      return h;
    }
    this.breakPara(st, i, a.end);
    if (!st.body) {
      this.fill(K_INV, i, a.end);
      return a.end;
    }
    const raw = src.slice(a.open + 1, a.end - 1);
    const nLabels = this.labels.length;
    this.scanMath(a.open + 1, a.end - 1); // labels, refs, cites inside the title
    const titleLabel = this.labels.length > nLabels ? this.labels[nLabels]! : null;
    const plain = plainText(raw);
    const kind = classifyHeading(plain);
    let part: Part;
    if (kind === 'appendix') {
      this.inApp = true;
      part = 'app';
    } else if (kind === 'drop') part = 'body';
    else if (kind === 'abstract') part = 'abstract';
    else if (this.inApp) part = 'app';
    else if (kind === 'intro') part = 'intro';
    else if (kind === 'concl') part = 'concl';
    else if (level >= 2 && (this.topPart === 'intro' || this.topPart === 'body' || this.topPart === 'concl')) part = this.topPart;
    else part = 'body';
    const title = stripComments(raw)
      .replace(/\\label\s*\{[^{}]*\}/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const sec: SecInfo = { kind: 'heading', level, title, plain, start: i, part, label: titleLabel, id: '' };
    this.secs.push(sec);
    this.curSec = sec;
    this.curPart = part;
    if (level <= 1) this.topPart = part;
    this.headingSeen = true;
    this.pendingSec = titleLabel ? null : sec;
    return a.end;
  }

  private abstractArg(i: number, a: ArgSpan, st: Stream): number {
    this.breakPara(st, i, a.open + 1);
    const saved = this.saveCtx();
    this.curSec = this.pseudoSection('abstract', i);
    this.curPart = 'abstract';
    this.pendingSec = null;
    this.fill(K_INV, i, a.open + 1);
    this.scanSub(a.open + 1, a.end - 1, st);
    this.breakPara(st, a.end - 1, a.end);
    this.fill(K_INV, a.end - 1, a.end);
    this.restoreCtx(saved, true);
    return a.end;
  }

  private cite(i: number, j: number, to: number, st: Stream, multi: boolean): number {
    const src = this.src;
    let h = j;
    if (h < to && src.charCodeAt(h) === 42) h++;
    h = skipOpts(src, h, to, 2);
    const a = readArg(src, h, to);
    if (!a) {
      this.region(i, h, R_CITE);
      this.content(st);
      return h;
    }
    this.recordKeys(this.cites, a.open + 1, a.end - 1);
    let e = a.end;
    if (multi) {
      for (;;) {
        const q = skipOpts(src, e, to, 2);
        if (q >= to || src.charCodeAt(q) !== 123) break;
        const b = matchBrace(src, q, to);
        if (b < 0) break;
        this.recordKeys(this.cites, q + 1, b - 1);
        e = b;
      }
    }
    this.region(i, e, R_CITE);
    this.content(st);
    return e;
  }

  private ref(i: number, j: number, to: number, st: Stream, range: boolean): number {
    const src = this.src;
    let h = j;
    if (h < to && src.charCodeAt(h) === 42) h++;
    h = skipOpts(src, h, to, 1);
    const a = readArg(src, h, to);
    if (!a) {
      this.region(i, h, R_REF);
      this.content(st);
      return h;
    }
    this.recordKeys(this.refs, a.open + 1, a.end - 1);
    let e = a.end;
    if (range) {
      const b = readArg(src, e, to);
      if (b) {
        this.recordKeys(this.refs, b.open + 1, b.end - 1);
        e = b.end;
      }
    }
    this.region(i, e, R_REF);
    this.content(st);
    return e;
  }

  private footnote(i: number, j: number, to: number, st: Stream): number {
    const src = this.src;
    const h = skipOpts(src, j, to, 1);
    const a = readArg(src, h, to);
    if (!a) {
      this.fill(K_INV, i, h);
      return h;
    }
    this.nested('footnote', a.open + 1, a.end - 1);
    // the host keeps the whole \footnote{..} inside its span as one atomic region
    this.cls[i] = K_RS;
    this.fill(K_RF, i + 1, a.open + 1);
    this.cls[a.end - 1] = K_RF;
    this.jump[i] = a.end;
    this.rk[i] = R_FOOTNOTE;
    this.content(st);
    return a.end;
  }

  /** \url{..}, \verb|..|, \lstinline|..| / {..}, \mintinline{lang}|..|. */
  private verbLike(i: number, j: number, to: number, st: Stream, verb: boolean, name = ''): number {
    const src = this.src;
    let h = j;
    if (verb) {
      if (name === 'verb' && h < to && src.charCodeAt(h) === 42) h++;
      if (name !== 'verb') h = skipOpts(src, h, to, 1);
      if (name === 'mintinline') {
        const lang = readArg(src, h, to);
        if (lang) h = lang.end;
      }
    }
    if (h < to && src.charCodeAt(h) === 123 && name !== 'verb') {
      const e = matchBraceVerbatim(src, h, to);
      if (e > 0) {
        this.region(i, e, R_VERB);
        this.content(st);
        return e;
      }
    } else if (h < to) {
      const d = src.charCodeAt(h);
      if (!isLetterCode(d) && !isBlankCode(d) && d !== 10 && d !== 123) {
        const close = src.indexOf(src[h]!, h + 1);
        if (close > 0 && close < lineEnd(src, h + 1, to)) {
          this.region(i, close + 1, R_VERB);
          this.content(st);
          return close + 1;
        }
      }
    }
    this.region(i, h, R_CMD);
    this.content(st);
    return h;
  }

  /** style_check DROP_ARGS: up to two optional arguments, then `n` arguments each followed by optional ones. */
  private skipDropArgs(j: number, to: number, n: number): number {
    const src = this.src;
    let h = j;
    if (h < to && src.charCodeAt(h) === 42) h++;
    h = skipOpts(src, h, to, 2);
    for (let q = 0; q < n; q++) {
      const a = readArg(src, h, to);
      if (!a) break;
      h = skipOpts(src, a.end, to, 2);
    }
    return h;
  }

  /** The \fi that ends an \iffalse block (first one outside comments, not followed by a letter). */
  private findFi(j: number, to: number): number {
    const src = this.src;
    let k = j;
    while (k < to) {
      const c = src.charCodeAt(k);
      if (c === 37) {
        k = lineEnd(src, k, to);
        continue;
      }
      if (c === 92) {
        const e = controlEnd(src, k, to);
        if (wordAt(src, k + 1, e, 'fi')) return e;
        k = e;
        continue;
      }
      k++;
    }
    return -1;
  }
}
