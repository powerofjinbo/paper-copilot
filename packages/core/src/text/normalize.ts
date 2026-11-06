/**
 * Text normalization used for hashing, fuzzy matching, edit distance and lint/style features.
 * All functions are pure and isomorphic (browser + Node).
 *
 * OWNER: core-segmenter agent.
 *
 * Both normalizers share one small LaTeX reader (`convert`) that walks the sentence once. It reads
 * LaTeX the way the segmenter and the skill's style_check.py do (comments, math, citations,
 * references, formatting wrappers, accents) and never needs balanced input: an unclosed `$` or brace
 * is kept as text.
 *
 * Idempotence: normalizeForHash(normalizeForHash(x)) === normalizeForHash(x) for every x except a
 * literal `\%` that does not follow a number. To keep the percent of "96.94\%" alive when an already
 * normalized text is normalized again, a `%` that directly follows a digit (optionally after spaces)
 * is read as a percent sign, not as a comment, by both normalizers. (In a .tex file a bare `5%` is a
 * typo for `5\%` anyway.)
 */
import {
  ACCENT_COMBINING,
  CITE_CMDS,
  DROP_ARGS,
  DROP_BREAK_ARGS,
  ENV_MATH_DISPLAY,
  ENV_MATH_INLINE,
  HASH_UNWRAP_CMDS,
  INVISIBLE_CMDS,
  KEEP_FIRST_CMDS,
  KEEP_LAST_CMDS,
  MULTICITE_CMDS,
  NAMED_REF_CMDS,
  REF_CMDS,
  REF_PREFIX_WORD,
  REF_RANGE_CMDS,
  SIUNITX_CMDS,
  TEXT_SYMBOLS,
  TIE_CMDS,
  UNIT_WORDS,
  WRAP_CMDS,
  envCategory,
} from '../latex/scan/tables';
import {
  controlEnd,
  isDigitCode,
  isLetterCode,
  matchBrace,
  matchBraceVerbatim,
  matchBracket,
  readArg,
  readOpt,
  skipOpts,
  splitKeys,
  stripComments,
} from '../latex/scan/lex';

type Mode = 'hash' | 'plain';

const MATH_TOKEN = '⟨M⟩';

/** A `%` read as a percent sign: it directly follows a digit, possibly after spaces or a tie. */
function literalPercent(s: string, i: number): boolean {
  let k = i - 1;
  while (k >= 0) {
    const c = s.charCodeAt(k);
    if (c === 32 || c === 9 || c === 126) {
      k--;
      continue;
    }
    if (c === 92) return false;
    return isDigitCode(c) && !escapedAt(s, k + 1);
  }
  return false;
}

/** True if s[i] is preceded by an odd number of backslashes. */
function escapedAt(s: string, i: number): boolean {
  let n = 0;
  for (let k = i - 1; k >= 0 && s.charCodeAt(k) === 92; k--) n++;
  return n % 2 === 1;
}

function findDollarIn(s: string, k: number, double: boolean): number {
  let depth = 0;
  const n = s.length;
  while (k < n) {
    const c = s.charCodeAt(k);
    if (c === 92) {
      k += 2;
      continue;
    }
    if (c === 123) depth++;
    else if (c === 125) {
      if (depth > 0) depth--;
    } else if (c === 36 && depth === 0) {
      if (!double) return k;
      if (k + 1 < n && s.charCodeAt(k + 1) === 36) return k;
    }
    k++;
  }
  return -1;
}

function findCloseSeq(s: string, k: number, closer: number): number {
  const n = s.length;
  while (k < n) {
    const c = s.charCodeAt(k);
    if (c === 92) {
      if (k + 1 < n && s.charCodeAt(k + 1) === closer) return k;
      k += 2;
      continue;
    }
    k++;
  }
  return -1;
}

/** End offset of \end{name} matching a \begin{name} whose argument ends at `from`, or -1. */
function findEnvEndIn(s: string, name: string, from: number): [number, number] | null {
  let depth = 1;
  const re = /\\(begin|end)\s*\{([^{}]*)\}/g;
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[2]!.trim() !== name) continue;
    if (m[1] === 'begin') depth++;
    else if (--depth === 0) return [m.index, m.index + m[0].length];
  }
  return null;
}

/** Plain rendering of math content: a short number keeps its digits, anything else is `x`. */
function mathPlain(content: string): string {
  let t = stripComments(content).trim();
  t = t.replace(/\\[,;:!]|\\ |~|[{}]/g, '').replace(/\\%$/, '%').replace(/\s+/g, '');
  if (t.length > 0 && t.length <= 24 && /^[-+−]?\d[\d.,]*%?$/.test(t)) return t;
  return 'x';
}

function refPlain(cmd: string, keys: string[]): string {
  if (NAMED_REF_CMDS.has(cmd) && keys.length > 0) {
    const k = keys[0]!;
    const colon = k.indexOf(':');
    const word = colon > 0 ? REF_PREFIX_WORD.get(k.slice(0, colon).toLowerCase()) : undefined;
    if (word) return word + ' 1';
  }
  return '1';
}

function unitPlain(u: string): string {
  let t = u.trim().replace(/\\([A-Za-z]+)/g, (_m, w: string) => UNIT_WORDS.get(w) ?? TEXT_SYMBOLS.get(w) ?? '');
  t = t.replace(/[{}~]/g, '');
  return t.replace(/\s+/g, ' ').trim();
}

function compose(base: string, accent: string): string {
  const mark = ACCENT_COMBINING.get(accent);
  if (!mark || !base) return base;
  if (base === '\\i') base = 'i';
  else if (base === '\\j') base = 'j';
  if (base.startsWith('\\')) return '';
  return (base[0]! + mark).normalize('NFC') + base.slice(1);
}

/** Argument nesting beyond which arguments are copied, not read (pathological input only). */
const MAX_DEPTH = 48;

class Converter {
  private out = '';

  constructor(
    private readonly s: string,
    private readonly mode: Mode,
    private readonly depth = 0,
  ) {}

  run(): string {
    this.walk(0, this.s.length);
    return this.out;
  }

  private emit(t: string): void {
    this.out += t;
  }

  private sub(a: number, b: number): string {
    if (this.depth >= MAX_DEPTH) return this.s.slice(a, b);
    return new Converter(this.s.slice(a, b), this.mode, this.depth + 1).run();
  }

  private walk(from: number, to: number): void {
    const s = this.s;
    const plain = this.mode === 'plain';
    let i = from;
    while (i < to) {
      const c = s.charCodeAt(i);
      if (c === 37) {
        if (literalPercent(s, i)) {
          this.emit('%');
          i++;
          continue;
        }
        const e = s.indexOf('\n', i);
        i = e < 0 || e > to ? to : e;
        continue;
      }
      if (c === 36) {
        i = this.dollar(i, to);
        continue;
      }
      if (c === 92) {
        i = this.command(i, to);
        continue;
      }
      if (c === 126) {
        this.emit(' ');
        i++;
        continue;
      }
      if (c === 123 || c === 125) {
        if (!plain) this.emit(s[i]!);
        i++;
        continue;
      }
      if (plain) {
        if (c === 45 && s.charCodeAt(i + 1) === 45) {
          if (s.charCodeAt(i + 2) === 45) {
            this.emit('—');
            i += 3;
          } else {
            this.emit('–');
            i += 2;
          }
          continue;
        }
        if (c === 96) {
          if (s.charCodeAt(i + 1) === 96) {
            this.emit('"');
            i += 2;
          } else {
            this.emit("'");
            i++;
          }
          continue;
        }
        if (c === 39 && s.charCodeAt(i + 1) === 39) {
          this.emit('"');
          i += 2;
          continue;
        }
        if (c === 38) {
          this.emit(' ');
          i++;
          continue;
        }
      }
      this.emit(s[i]!);
      i++;
    }
  }

  private math(content: string): void {
    this.emit(this.mode === 'hash' ? MATH_TOKEN : mathPlain(content));
  }

  private dollar(i: number, to: number): number {
    const s = this.s;
    const double = s.charCodeAt(i + 1) === 36;
    const e = findDollarIn(s, i + (double ? 2 : 1), double);
    if (e < 0 || e >= to) {
      this.emit(this.mode === 'hash' ? '$' : '');
      return i + 1;
    }
    this.math(s.slice(i + (double ? 2 : 1), e));
    return e + (double ? 2 : 1);
  }

  /** Argument contents [open+1, end-1) of `n` brace arguments starting at j (optional args skipped). */
  private args(j: number, to: number, n: number): { parts: Array<[number, number]>; end: number } {
    const parts: Array<[number, number]> = [];
    let h = j;
    for (let q = 0; q < n; q++) {
      h = skipOpts(this.s, h, to, 2);
      const a = readArg(this.s, h, to);
      if (!a) break;
      parts.push([a.open + 1, a.end - 1]);
      h = a.end;
    }
    return { parts, end: h };
  }

  private command(i: number, to: number): number {
    const s = this.s;
    const plain = this.mode === 'plain';
    if (i + 1 >= to) return i + 1;
    const c1 = s.charCodeAt(i + 1);
    if (!isLetterCode(c1)) return this.symbol(i, c1, to);
    let j = controlEnd(s, i, to);
    const name = s.slice(i + 1, j);
    const known = (set: ReadonlySet<string> | ReadonlyMap<string, unknown>): boolean => set.has(name);
    if (
      j < to && s.charCodeAt(j) === 42 &&
      (known(CITE_CMDS) || known(REF_CMDS) || name === 'footnote' || name === 'caption' || known(TIE_CMDS) || known(DROP_ARGS))
    )
      j++;

    // math environments and \ensuremath
    if (name === 'begin' || name === 'end') {
      const a = readArg(s, j, to);
      if (!a) return j;
      const env = s.slice(a.open + 1, a.end - 1).trim();
      const cat = envCategory(env);
      if (name === 'begin' && (cat === ENV_MATH_DISPLAY || cat === ENV_MATH_INLINE)) {
        const end = findEnvEndIn(s, env, a.end);
        if (end && end[1] <= to) {
          this.math(s.slice(a.end, end[0]));
          return end[1];
        }
      }
      if (!plain) this.emit(s.slice(i, a.end));
      return a.end;
    }
    if (name === 'ensuremath') {
      const a = readArg(s, j, to);
      if (a) {
        this.math(s.slice(a.open + 1, a.end - 1));
        return a.end;
      }
    }
    if (CITE_CMDS.has(name) || MULTICITE_CMDS.has(name)) {
      let h = skipOpts(s, j, to, 2);
      const a = readArg(s, h, to);
      if (!a) {
        if (!plain) this.emit(s.slice(i, j));
        return h;
      }
      const keys = splitKeys(s.slice(a.open + 1, a.end - 1));
      h = a.end;
      if (MULTICITE_CMDS.has(name)) {
        for (;;) {
          const q = skipOpts(s, h, to, 2);
          if (q >= to || s.charCodeAt(q) !== 123) break;
          const b = matchBrace(s, q, to);
          if (b < 0) break;
          keys.push(...splitKeys(s.slice(q + 1, b - 1)));
          h = b;
        }
      }
      if (!plain) this.emit('⟨C:' + keys.join(',') + '⟩');
      return h;
    }
    if (REF_CMDS.has(name) || REF_RANGE_CMDS.has(name)) {
      const h = skipOpts(s, j, to, 1);
      const { parts, end } = this.args(h, to, REF_RANGE_CMDS.has(name) ? 2 : 1);
      if (parts.length === 0) {
        if (!plain) this.emit(s.slice(i, j));
        return end;
      }
      const keys: string[] = [];
      for (const [a, b] of parts) keys.push(...splitKeys(s.slice(a, b)));
      this.emit(plain ? refPlain(name, keys) : '⟨R:' + keys.join(',') + '⟩');
      return end;
    }
    if (name === 'label') {
      const a = readArg(s, j, to);
      return a ? a.end : j;
    }
    // verbatim arguments: `%`, `#`, `$` inside a URL or \verb are not LaTeX syntax
    if (name === 'url' || name === 'path' || name === 'nolinkurl' || name === 'href') {
      if (s.charCodeAt(j) === 123) {
        const e = matchBraceVerbatim(s, j, to);
        if (e > 0) {
          if (name === 'href') {
            const b = readArg(s, e, to);
            if (plain) {
              if (b) this.emit(this.sub(b.open + 1, b.end - 1));
              return b ? b.end : e;
            }
            this.emit(s.slice(i, e));
            if (b) this.emit('{' + this.sub(b.open + 1, b.end - 1) + '}');
            return b ? b.end : e;
          }
          this.emit(plain ? s.slice(j + 1, e - 1) : s.slice(i, e));
          return e;
        }
      }
    }
    if (name === 'verb') {
      let d = j;
      if (s.charCodeAt(d) === 42) d++;
      const delim = s[d];
      if (delim && !/[A-Za-z\s]/.test(delim)) {
        const close = s.indexOf(delim, d + 1);
        if (close > 0 && close < to) {
          this.emit(plain ? s.slice(d + 1, close) : s.slice(i, close + 1));
          return close + 1;
        }
      }
    }
    if (name === 'hyperref') {
      const o = readOpt(s, j, to);
      const a = readArg(s, o ? o.end : j, to);
      if (a) {
        this.emit(this.sub(a.open + 1, a.end - 1));
        return a.end;
      }
    }
    const unwrap = plain ? WRAP_CMDS.has(name) : HASH_UNWRAP_CMDS.has(name);
    if (unwrap) {
      const h = skipOpts(s, j, to, 2);
      const a = readArg(s, h, to);
      if (a) {
        this.emit(this.sub(a.open + 1, a.end - 1));
        return a.end;
      }
      if (plain) return h;
    }
    if (plain) {
      const r = this.plainCommand(i, j, name, to);
      if (r >= 0) return r;
    }
    // unknown macro: hash keeps its name and its arguments; plain keeps the text of its arguments or its name
    let h = j;
    if (h + 1 < to && s.charCodeAt(h) === 123 && s.charCodeAt(h + 1) === 125) {
      // `\ttbar{}` -> `\ttbar`, but `\ttbar{}events` keeps `{}` so the name cannot run into the word
      if (!plain) this.emit(isLetterCode(s.charCodeAt(h + 2)) ? s.slice(i, h + 2) : s.slice(i, j));
      else this.emit(name);
      return h + 2;
    }
    if (!plain) {
      this.emit(s.slice(i, j));
      while (h < to) {
        const ch = s.charCodeAt(h);
        if (ch === 91) {
          const e = matchBracket(s, h, to);
          if (e < 0) break;
          this.emit(s.slice(h, e));
          h = e;
        } else if (ch === 123) {
          const e = matchBrace(s, h, to);
          if (e < 0) break;
          this.emit('{' + this.sub(h + 1, e - 1) + '}');
          h = e;
        } else break;
      }
      return h;
    }
    const texts: string[] = [];
    while (h < to && s.charCodeAt(h) === 123) {
      const e = matchBrace(s, h, to);
      if (e < 0) break;
      texts.push(this.sub(h + 1, e - 1));
      h = e;
    }
    if (texts.length > 0) this.emit(texts.join(' '));
    else this.emit(name);
    return h;
  }

  /** plainText handling of known commands; returns -1 for unknown ones. */
  private plainCommand(i: number, j: number, name: string, to: number): number {
    const s = this.s;
    if (name === 'footnote' || name === 'footnotetext') {
      const h = skipOpts(s, j, to, 1);
      const a = readArg(s, h, to);
      return a ? a.end : h;
    }
    const drop = DROP_ARGS.get(name) ?? DROP_BREAK_ARGS.get(name);
    if (drop !== undefined) return this.args(j, to, drop).end;
    if (INVISIBLE_CMDS.has(name)) {
      if (s.charCodeAt(j) === 123 && s.charCodeAt(j + 1) === 125) return j + 2;
      return j;
    }
    if (name === 'hspace') {
      this.emit(' ');
      const a = readArg(s, j, to);
      return a ? a.end : j;
    }
    if (TIE_CMDS.has(name) || name === 'newline') {
      this.emit(' ');
      return j;
    }
    const keepLast = KEEP_LAST_CMDS.get(name);
    if (keepLast !== undefined) {
      const { parts, end } = this.args(j, to, keepLast);
      const last = parts[parts.length - 1];
      if (last) this.emit(this.sub(last[0], last[1]));
      return end;
    }
    if (KEEP_FIRST_CMDS.has(name)) {
      const { parts, end } = this.args(j, to, 2);
      const first = parts[0];
      if (first) this.emit(this.sub(first[0], first[1]));
      return end;
    }
    const si = SIUNITX_CMDS.get(name);
    if (si !== undefined) {
      const { parts, end } = this.args(j, to, si);
      const t = parts.map(([a, b]) => s.slice(a, b).trim());
      if (name === 'SI' || name === 'qty' || name === 'SIlist' || name === 'qtylist') this.emit(`${t[0] ?? ''} ${unitPlain(t[1] ?? '')}`);
      else if (name === 'si' || name === 'unit') this.emit(unitPlain(t[0] ?? ''));
      else if (name === 'SIrange' || name === 'qtyrange') this.emit(`${t[0] ?? ''}–${t[1] ?? ''} ${unitPlain(t[2] ?? '')}`);
      else if (name === 'numrange') this.emit(`${t[0] ?? ''}–${t[1] ?? ''}`);
      else if (name === 'ang') this.emit(`${t[0] ?? ''}°`);
      else this.emit((t[0] ?? '').replace(/;/g, ','));
      return end;
    }
    if (name === 'item') return skipOpts(s, j, to, 1);
    if (name.length === 1 && ACCENT_COMBINING.has(name)) return this.accent(name, j, to);
    const sym = TEXT_SYMBOLS.get(name);
    if (sym !== undefined) {
      this.emit(sym);
      if (s.charCodeAt(j) === 123 && s.charCodeAt(j + 1) === 125) return j + 2;
      return j;
    }
    void i;
    return -1;
  }

  private accent(acc: string, j: number, to: number): number {
    const s = this.s;
    let k = j;
    if (/[A-Za-z]/.test(acc) && s.charCodeAt(k) === 32) k++;
    let arg = '';
    let end = k;
    if (s.charCodeAt(k) === 123) {
      const e = matchBrace(s, k, to);
      if (e < 0) return j;
      arg = s.slice(k + 1, e - 1).trim();
      end = e;
    } else if (s.charCodeAt(k) === 92) {
      end = controlEnd(s, k, to);
      arg = s.slice(k, end);
    } else if (k < to) {
      arg = s[k]!;
      end = k + 1;
    }
    this.emit(compose(arg, acc));
    return end;
  }

  private symbol(i: number, c1: number, to: number): number {
    const s = this.s;
    const plain = this.mode === 'plain';
    switch (c1) {
      case 92: {
        let h = i + 2;
        if (s.charCodeAt(h) === 42) h++;
        const o = readOpt(s, h, to);
        this.emit(' ');
        return o ? o.end : h;
      }
      case 44:
      case 59:
      case 58:
      case 33:
      case 32:
      case 9:
      case 10:
      case 13:
        this.emit(' ');
        return i + 2;
      case 37:
        this.emit('%');
        return i + 2;
      case 64:
      case 47:
      case 45:
      case 42:
        return i + 2;
      case 40:
      case 91: {
        const e = findCloseSeq(s, i + 2, c1 === 40 ? 41 : 93);
        if (e >= 0 && e < to) {
          this.math(s.slice(i + 2, e));
          return e + 2;
        }
        if (!plain) this.emit(s.slice(i, i + 2));
        return i + 2;
      }
      case 38:
      case 35:
      case 95:
      case 36:
      case 123:
      case 125:
        this.emit(plain ? s[i + 1]! : s.slice(i, i + 2));
        return i + 2;
      default: {
        const ch = String.fromCharCode(c1);
        if (plain && ACCENT_COMBINING.has(ch)) return this.accent(ch, i + 2, to);
        if (!plain) this.emit(s.slice(i, i + 2));
        return i + 2;
      }
    }
  }
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Normalize one LaTeX sentence for hashing and fuzzy matching. Rules, in order:
 * 1. Remove LaTeX comments: an unescaped `%` to end of line (`\%` is a literal percent and stays).
 * 2. Inline math (`$...$`, `\(...\)`) and display math (`\[...\]`, `$$...$$`, equation-like
 *    environments) become the token `⟨M⟩` (content dropped).
 * 3. `\cite[opt]{a,b}` (and \citep, \citet, \citealp, \Cite, \autocite, \parencite, \textcite) become `⟨C:a,b⟩`.
 * 4. `\ref{l}`, `\eqref{l}`, `\cref{l}`, `\Cref{l}`, `\autoref{l}`, `\pageref{l}` become `⟨R:l⟩`; `\label{..}` is removed.
 * 5. `~` and `\,` `\;` `\:` `\!` `\ ` become a single space; `\%` becomes `%`.
 * 6. Text-formatting wrappers keep their content: \emph{x} \textit{x} \textbf{x} \textrm{x} \textsc{x} \mbox{x} -> x.
 * 7. Collapse all whitespace runs to one space; trim.
 * Case is preserved. Unknown macros keep their name (e.g. `\ttbar{}` -> `\ttbar`).
 */
export function normalizeForHash(latex: string): string {
  if (!latex) return '';
  return collapse(new Converter(latex, 'hash').run());
}

/**
 * Readable plain text for lint, style features and BM25: like normalizeForHash, but math becomes
 * `x` (or its content stripped of commands when it is a short number like `$8{,}710$` -> `8,710`),
 * citations are removed, references become `1`, macros without arguments are dropped
 * (`\ttbar{}` -> `ttbar`), accents and LaTeX quotes are converted (``x'' -> "x"), `\%` -> `%`,
 * `--` -> `–`. Whitespace collapsed; trimmed.
 *
 * Also: named references print their word (`\cref{fig:a}` -> `Fig. 1`), footnotes are removed (they are
 * units of their own), siunitx is written out (`\SI{30}{\GeV}` -> `30 GeV`), and a space left before
 * punctuation by a removed citation is dropped (`line~\cite{x}.` -> `line.`).
 */
export function plainText(latex: string): string {
  if (!latex) return '';
  let t = collapse(new Converter(latex, 'plain').run());
  t = t.replace(/\s+([,.;:!?)\]])/g, '$1').replace(/\(\s*\)/g, '').replace(/\[\s*\]/g, '');
  return collapse(t);
}

const WORD_RE = /\d+(?:\.\d+)+|[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

/** Lower-cased word tokens of plain text: letters/digits/apostrophes/hyphens/periods inside numbers. */
export function wordTokens(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD_RE.exec(text)) !== null) out.push(m[0].toLowerCase());
  return out;
}

function levenshtein<T>(a: readonly T[], b: readonly T[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // trim the common prefix and suffix first
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  const n = ea - s;
  const m = eb - s;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  for (let k = 0; k <= m; k++) prev[k] = k;
  for (let x = 1; x <= n; x++) {
    cur[0] = x;
    const ax = a[s + x - 1];
    for (let y = 1; y <= m; y++) {
      const cost = ax === b[s + y - 1] ? 0 : 1;
      const del = prev[y]! + 1;
      const ins = cur[y - 1]! + 1;
      const sub = prev[y - 1]! + cost;
      cur[y] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[m]!;
}

/**
 * Word-level Levenshtein distance between two texts (tokens from `wordTokens(plainText(x))`),
 * normalized by the longer token count. 0 = identical, 1 = completely different. Both empty -> 0.
 */
export function editDistanceWords(a: string, b: string): number {
  const ta = wordTokens(plainText(a));
  const tb = wordTokens(plainText(b));
  const longest = Math.max(ta.length, tb.length);
  if (longest === 0) return 0;
  return levenshtein(ta, tb) / longest;
}

/**
 * Similarity in [0,1] used for fuzzy re-anchoring: 1 - editDistanceWords on normalizeForHash'd text,
 * except that two texts differing only in whitespace/case score 1.
 */
export function similarity(a: string, b: string): number {
  const na = normalizeForHash(a);
  const nb = normalizeForHash(b);
  if (na.replace(/\s+/g, '').toLowerCase() === nb.replace(/\s+/g, '').toLowerCase()) return 1;
  return 1 - editDistanceWords(na, nb);
}

interface DiffToken {
  core: string;
  ws: string;
}

/** Word tokens of a sentence: a run of non-space characters (kept whole across spaces inside {..} or
 * $..$) plus its trailing whitespace. Leading whitespace becomes a token with an empty core. */
function diffTokens(s: string): DiffToken[] {
  const out: DiffToken[] = [];
  const n = s.length;
  let i = 0;
  const isWs = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
  if (i < n && isWs(s.charCodeAt(i))) {
    let e = i;
    while (e < n && isWs(s.charCodeAt(e))) e++;
    out.push({ core: '', ws: s.slice(i, e) });
    i = e;
  }
  while (i < n) {
    let e = i;
    while (e < n && !isWs(s.charCodeAt(e))) {
      const c = s.charCodeAt(e);
      if (c === 92) {
        e += 2;
        continue;
      }
      if (c === 123) {
        const b = matchBrace(s, e, n);
        if (b > 0) {
          e = b;
          continue;
        }
      } else if (c === 36) {
        const double = s.charCodeAt(e + 1) === 36;
        const b = findDollarIn(s, e + (double ? 2 : 1), double);
        if (b > 0) {
          e = b + (double ? 2 : 1);
          continue;
        }
      }
      e++;
    }
    if (e > n) e = n;
    let w = e;
    while (w < n && isWs(s.charCodeAt(w))) w++;
    out.push({ core: s.slice(i, e), ws: s.slice(e, w) });
    i = w;
  }
  return out;
}

/**
 * Word-level diff of two LaTeX sentences, for showing a rewrite: list of [op, text] with
 * op -1 delete, 0 equal, 1 insert. Concatenating ops 0 and -1 gives `a`; ops 0 and 1 gives `b`
 * (exactly, including whitespace). Tokens are runs of non-space chars plus their trailing space,
 * so a LaTeX command such as `\cite{x}` is never split.
 */
export function wordDiff(a: string, b: string): Array<[number, string]> {
  const ta = diffTokens(a);
  const tb = diffTokens(b);
  const ops: Array<[number, string]> = [];
  const push = (op: number, text: string): void => {
    if (!text) return;
    const last = ops[ops.length - 1];
    if (last && last[0] === op) last[1] += text;
    else ops.push([op, text]);
  };
  const equalPair = (x: DiffToken, y: DiffToken): void => {
    push(0, x.core);
    if (x.ws === y.ws) push(0, x.ws);
    else {
      // keep the common whitespace prefix equal, then delete/insert the rest
      let k = 0;
      while (k < x.ws.length && k < y.ws.length && x.ws[k] === y.ws[k]) k++;
      push(0, x.ws.slice(0, k));
      push(-1, x.ws.slice(k));
      push(1, y.ws.slice(k));
    }
  };
  const text = (t: DiffToken): string => t.core + t.ws;
  // common prefix / suffix by core
  let s0 = 0;
  while (s0 < ta.length && s0 < tb.length && ta[s0]!.core === tb[s0]!.core) s0++;
  let ea = ta.length;
  let eb = tb.length;
  while (ea > s0 && eb > s0 && ta[ea - 1]!.core === tb[eb - 1]!.core) {
    ea--;
    eb--;
  }
  for (let k = 0; k < s0; k++) equalPair(ta[k]!, tb[k]!);
  const n = ea - s0;
  const m = eb - s0;
  if (n > 0 || m > 0) {
    if (n === 0 || m === 0 || n * m > 4_000_000) {
      for (let k = s0; k < ea; k++) push(-1, text(ta[k]!));
      for (let k = s0; k < eb; k++) push(1, text(tb[k]!));
    } else {
      // LCS table on cores
      const w = m + 1;
      const L = new Int32Array((n + 1) * w);
      for (let x = n - 1; x >= 0; x--) {
        for (let y = m - 1; y >= 0; y--) {
          L[x * w + y] =
            ta[s0 + x]!.core === tb[s0 + y]!.core
              ? L[(x + 1) * w + y + 1]! + 1
              : Math.max(L[(x + 1) * w + y]!, L[x * w + y + 1]!);
        }
      }
      let x = 0;
      let y = 0;
      const dels: string[] = [];
      const inss: string[] = [];
      const flushChange = (): void => {
        for (const d of dels) push(-1, d);
        for (const t of inss) push(1, t);
        dels.length = 0;
        inss.length = 0;
      };
      while (x < n && y < m) {
        const tx = ta[s0 + x]!;
        const ty = tb[s0 + y]!;
        if (tx.core === ty.core) {
          flushChange();
          equalPair(tx, ty);
          x++;
          y++;
        } else if (L[(x + 1) * w + y]! >= L[x * w + y + 1]!) {
          dels.push(text(tx));
          x++;
        } else {
          inss.push(text(ty));
          y++;
        }
      }
      while (x < n) dels.push(text(ta[s0 + x++]!));
      while (y < m) inss.push(text(tb[s0 + y++]!));
      flushChange();
    }
  }
  for (let k = 0; k < ta.length - ea; k++) equalPair(ta[ea + k]!, tb[eb + k]!);
  return ops;
}
