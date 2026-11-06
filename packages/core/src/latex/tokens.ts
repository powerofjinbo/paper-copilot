/**
 * LaTeX tokens inside one sentence: citations, references, labels, math spans, macros and
 * placeholders. Used by the faithfulness gate (LaTeX invariance, cite/ref checks) and by units.
 *
 * OWNER: core-gate agent.
 *
 * Implementation notes:
 * - One hand-written linear scanner (`scanLatex`) walks the sentence once. Comments (`%` to end of
 *   line, not `\%`) are skipped. Arguments of \url, \href (first), \includegraphics, \input, \include,
 *   \begin/\end names, \hspace/\vspace, \verb are opaque. Optional arguments of commands are skipped.
 * - Math spans: `$..$`, `$$..$$`, `\(..\)`, `\[..\]` and the math environments (equation, align,
 *   gather, multline, eqnarray, displaymath, math, flalign, alignat, with or without `*`). Their content
 *   is whitespace-normalized (runs collapsed; a space survives only between a control word and a
 *   letter, where it is significant) and `\label{..}` is removed from it (labels are tracked apart).
 *   Cites, refs and labels inside math are still collected. Macros inside math are part of the math
 *   token and are not listed again.
 * - Macros outside math: every control word or control symbol, except the cite/ref/label families,
 *   the formatting whitelist and spacing. `\begin{env}` / `\end{env}` of non-math environments are
 *   listed as `\begin{env}` / `\end{env}`.
 */

export interface LatexTokens {
  /** \cite-family keys, split on commas, trimmed, in order (with repeats). */
  cites: string[];
  /** \ref, \eqref, \cref, \Cref, \autoref, \pageref targets (comma lists split). */
  refs: string[];
  /** \label keys. */
  labels: string[];
  /** Inline and display math spans, whitespace-normalized, including delimiters normalized to `$...$`. */
  math: string[];
  /** Other macro names (with backslash), excluding the formatting whitelist
   *  (\emph \textit \textbf \textrm \textsc \textsf \texttt \mbox \text) and spacing (\, \; \: \! \  ~). */
  macros: string[];
}

/** One command with keys (cite, ref or label), with its source span (command name to closing brace). */
export interface KeyCommandSpan {
  kind: 'cite' | 'ref' | 'label';
  /** Command name with backslash, e.g. `\citep`. */
  cmd: string;
  start: number;
  end: number;
  keys: string[];
  /** Span of the (last) key argument including braces. */
  argStart: number;
  argEnd: number;
  inMath: boolean;
}

export interface MathSpan {
  start: number;
  end: number;
  /** Normalized `$...$` form. */
  norm: string;
  display: boolean;
}

export interface LatexScan {
  keyCommands: KeyCommandSpan[];
  math: MathSpan[];
  macros: Array<{ name: string; start: number; end: number }>;
  /** Comment spans `%...` (to end of line, newline excluded). */
  comments: Array<{ start: number; end: number }>;
}

/** Formatting macros that never count as notation. */
export const FORMAT_MACROS: ReadonlySet<string> = new Set(['\\emph', '\\textit', '\\textbf', '\\textrm', '\\textsc', '\\textsf', '\\texttt', '\\mbox', '\\text']);

/** Spacing commands (not notation). */
const SPACING_MACROS: ReadonlySet<string> = new Set([
  '\\,', '\\;', '\\:', '\\!', '\\ ', '\\\\', '\\/', '\\@', '\\-', '\\quad', '\\qquad', '\\enspace', '\\thinspace', '\\negthinspace',
  '\\xspace', '\\newline', '\\linebreak', '\\nolinebreak', '\\nobreak', '\\allowbreak', '\\hspace', '\\vspace', '\\hfill', '\\vfill',
  '\\smallskip', '\\medskip', '\\bigskip', '\\noindent', '\\par', '\\relax',
]);

const MATH_ENVS: ReadonlySet<string> = new Set([
  'equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*', 'eqnarray', 'eqnarray*',
  'displaymath', 'math', 'flalign', 'flalign*', 'alignat', 'alignat*', 'dmath', 'dmath*',
]);

const REF_CMDS: ReadonlySet<string> = new Set([
  'ref', 'eqref', 'cref', 'Cref', 'autoref', 'Autoref', 'pageref', 'nameref', 'vref', 'Vref', 'labelcref', 'cpageref', 'Cpageref',
  'crefrange', 'Crefrange', 'subref', 'ref*', 'cref*', 'Cref*', 'autoref*',
]);

/** Commands whose first brace argument is opaque (a path, a URL, a length, an environment name...). */
const OPAQUE_FIRST_ARG: ReadonlySet<string> = new Set([
  'url', 'href', 'includegraphics', 'input', 'include', 'hspace', 'vspace', 'hspace*', 'vspace*', 'begin', 'end', 'color',
  'textcolor', 'bibliography', 'bibliographystyle', 'usepackage', 'documentclass', 'setlength', 'addtolength', 'linespread',
  'rule', 'parbox', 'makebox', 'framebox', 'raisebox', 'scalebox', 'resizebox', 'doi', 'arxiv', 'eprint',
]);

export function isCiteCommand(name: string): boolean {
  // \cite, \citep, \citet, \cites, \Cite, \parencite, \textcite, \autocite, \footcite, \supercite,
  // \onlinecite (revtex), \citealp, \citeauthor, \citeyear, \citenum, \nocite ...
  return /^(?:[a-zA-Z]*cite[a-zA-Z]*|Cite[a-zA-Z]*)\*?$/.test(name);
}

function isLetter(c: string | undefined): boolean {
  return c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '@');
}

/** Read a control sequence at `i` (text[i] === '\\'). Returns name without backslash and end index. */
function readControl(text: string, i: number): { name: string; end: number } {
  let j = i + 1;
  if (j >= text.length) return { name: '', end: j };
  if (isLetter(text[j])) {
    while (j < text.length && isLetter(text[j])) j++;
    if (text[j] === '*') j++;
    return { name: text.slice(i + 1, j), end: j };
  }
  // control symbol
  return { name: text[j]!, end: j + 1 };
}

/** Index after a balanced group starting at `i` (text[i] === open). Unbalanced: end of text. */
export function skipGroup(text: string, i: number, open = '{', close = '}'): number {
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return text.length;
}

function skipSpaces(text: string, i: number): number {
  while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++;
  return i;
}

/** Skip optional arguments `[..]` (and whitespace before them only if `allowSpace`). */
function skipOptionals(text: string, i: number, allowSpace = true): number {
  for (;;) {
    const k = allowSpace ? skipSpaces(text, i) : i;
    if (text[k] === '[') {
      const e = skipGroup(text, k, '[', ']');
      i = e;
      continue;
    }
    return i;
  }
}

function splitKeys(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Whitespace-normalize math content: collapse runs; keep a space only after a control word before a letter. */
export function normalizeMath(content: string): string {
  const s = content.replace(/\\label\s*\{[^{}]*\}/g, ' ').replace(/(^|[^\\])%[^\n]*/g, '$1').replace(/\s+/g, ' ').trim();
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === ' ') {
      const next = s[i + 1];
      const m = /\\[A-Za-z@]+$/.exec(out);
      if (m && isLetter(next)) out += ' ';
      continue;
    }
    out += c;
    // keep escaped characters as they are (e.g. "\ " is spacing, kept literally)
    if (c === '\\' && i + 1 < s.length && !isLetter(s[i + 1])) {
      out += s[i + 1];
      i++;
    }
  }
  return '$' + out + '$';
}

/**
 * Scan a sentence once and return its cite/ref/label commands, math spans, macros and comments.
 * Never throws.
 */
export function scanLatex(input: string): LatexScan {
  const text = typeof input === 'string' ? input : String(input ?? '');
  const out: LatexScan = { keyCommands: [], math: [], macros: [], comments: [] };
  const n = text.length;
  let i = 0;
  // Math state
  let mathStart = -1;
  let mathContentStart = -1;
  let mathClose: string | null = null; // '$', '$$', '\\)', '\\]', or 'env:<name>'
  let mathDisplay = false;

  const closeMath = (contentEnd: number, spanEnd: number): void => {
    out.math.push({ start: mathStart, end: spanEnd, norm: normalizeMath(text.slice(mathContentStart, contentEnd)), display: mathDisplay });
    mathStart = -1;
    mathClose = null;
  };

  while (i < n) {
    const c = text[i]!;
    if (c === '%') {
      let e = text.indexOf('\n', i);
      if (e < 0) e = n;
      out.comments.push({ start: i, end: e });
      i = e;
      continue;
    }
    if (c === '$') {
      const dbl = text[i + 1] === '$';
      if (mathClose === null) {
        mathStart = i;
        mathDisplay = dbl;
        mathClose = dbl ? '$$' : '$';
        i += dbl ? 2 : 1;
        mathContentStart = i;
        continue;
      }
      if (mathClose === '$$' && dbl) {
        closeMath(i, i + 2);
        i += 2;
        continue;
      }
      if (mathClose === '$') {
        closeMath(i, i + 1);
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (c !== '\\') {
      i++;
      continue;
    }
    const { name, end } = readControl(text, i);
    const inMath = mathClose !== null;
    if (name === '') {
      i = end;
      continue;
    }
    // math delimiters
    if (name === '(' || name === '[') {
      if (!inMath) {
        mathStart = i;
        mathDisplay = name === '[';
        mathClose = name === '(' ? '\\)' : '\\]';
        mathContentStart = end;
      }
      i = end;
      continue;
    }
    if (name === ')' || name === ']') {
      if (mathClose === '\\' + name) closeMath(i, end);
      i = end;
      continue;
    }
    if (name === 'begin' || name === 'end') {
      const k = skipSpaces(text, end);
      if (text[k] === '{') {
        const ge = skipGroup(text, k);
        const env = text.slice(k + 1, ge - 1).trim();
        if (MATH_ENVS.has(env)) {
          if (name === 'begin' && !inMath) {
            mathStart = i;
            mathDisplay = true;
            mathClose = 'env:' + env;
            mathContentStart = ge;
          } else if (name === 'end' && mathClose === 'env:' + env) {
            closeMath(i, ge);
          }
        } else if (!inMath) {
          out.macros.push({ name: `\\${name}{${env}}`, start: i, end: ge });
        }
        i = name === 'begin' ? skipOptionals(text, ge, false) : ge;
        continue;
      }
      i = end;
      continue;
    }
    if (name === 'verb' || name === 'verb*') {
      const delim = text[end];
      if (delim !== undefined) {
        const close = text.indexOf(delim, end + 1);
        const e = close < 0 ? n : close + 1;
        if (!inMath) out.macros.push({ name: '\\verb', start: i, end: e });
        i = e;
        continue;
      }
      i = end;
      continue;
    }
    const bare = name.replace(/\*$/, '');
    const isCite = isCiteCommand(name);
    const isRef = REF_CMDS.has(name) || REF_CMDS.has(bare);
    if (isCite || isRef || bare === 'label') {
      // optional args, then one or more key groups (\cites{a}{b}, \crefrange{a}{b})
      let k = skipOptionals(text, end);
      k = skipSpaces(text, k);
      const keys: string[] = [];
      let argStart = -1;
      let argEnd = -1;
      const multi = (isCite && /s\*?$/.test(name) && name !== 'nocites') || bare === 'crefrange' || bare === 'Crefrange';
      while (text[k] === '{') {
        const ge = skipGroup(text, k);
        argStart = k;
        argEnd = ge;
        keys.push(...splitKeys(text.slice(k + 1, Math.max(k + 1, ge - 1))));
        k = ge;
        if (!multi) break;
        const k2 = skipSpaces(text, skipOptionals(text, k));
        if (text[k2] !== '{') break;
        k = k2;
      }
      if (argStart < 0) {
        // \cite without argument: keep it as a key command with no keys
        argStart = end;
        argEnd = end;
        k = end;
      }
      out.keyCommands.push({ kind: isCite ? 'cite' : isRef ? 'ref' : 'label', cmd: '\\' + name, start: i, end: k, keys, argStart, argEnd, inMath });
      i = k;
      continue;
    }
    const full = '\\' + name;
    if (OPAQUE_FIRST_ARG.has(name)) {
      let k = skipOptionals(text, end);
      k = skipSpaces(text, k);
      if (text[k] === '{') k = skipGroup(text, k);
      if (!inMath && !SPACING_MACROS.has(full) && !SPACING_MACROS.has('\\' + bare)) out.macros.push({ name: full, start: i, end });
      i = k;
      continue;
    }
    if (!inMath && !FORMAT_MACROS.has(full) && !SPACING_MACROS.has(full) && !SPACING_MACROS.has('\\' + bare)) {
      out.macros.push({ name: full, start: i, end });
    }
    // `\\[2pt]`, `\\*[2pt]`, `\item[a]`: skip an optional argument glued to the command
    if (name === '\\' || bare === 'item') {
      let k = end;
      if (name === '\\' && text[k] === '*') k++;
      i = skipOptionals(text, k, false);
    } else {
      i = end;
    }
  }
  if (mathClose !== null && mathStart >= 0) {
    // Unclosed math: take the rest of the sentence.
    out.math.push({ start: mathStart, end: n, norm: normalizeMath(text.slice(mathContentStart, n)), display: mathDisplay });
  }
  return out;
}

export function latexTokensOf(text: string): LatexTokens {
  const scan = scanLatex(text);
  const cites: string[] = [];
  const refs: string[] = [];
  const labels: string[] = [];
  for (const kc of scan.keyCommands) {
    const target = kc.kind === 'cite' ? cites : kc.kind === 'ref' ? refs : labels;
    target.push(...kc.keys);
  }
  return { cites, refs, labels, math: scan.math.map((m) => m.norm), macros: scan.macros.map((m) => m.name) };
}

export interface InvarianceResult {
  ok: boolean;
  /** Tokens present in `before` but missing (or fewer) in `after`, e.g. "cite:Wang2022LRT", "math:$p_T > 1$". */
  missing: string[];
  /** Tokens present in `after` but not (or more often) in `before`. */
  added: string[];
}

function tokenList(t: LatexTokens): string[] {
  return [
    ...t.cites.map((k) => 'cite:' + k),
    ...t.refs.map((k) => 'ref:' + k),
    ...t.labels.map((k) => 'label:' + k),
    ...t.math.map((k) => 'math:' + k),
    ...t.macros.map((k) => 'macro:' + k),
  ];
}

/**
 * The skill's rule "Keep \cite, \ref, \label, math, macros and symbols exactly": compare the multisets
 * of cites, refs, labels, math spans and macros of a sentence before and after an AI rewrite.
 * ok = no token missing and none added.
 * `missing` / `added` list one entry per missing / extra occurrence, in order of appearance.
 */
export function compareLatexInvariance(before: string, after: string): InvarianceResult {
  const a = tokenList(latexTokensOf(before));
  const b = tokenList(latexTokensOf(after));
  const countB = new Map<string, number>();
  for (const t of b) countB.set(t, (countB.get(t) ?? 0) + 1);
  const missing: string[] = [];
  for (const t of a) {
    const c = countB.get(t) ?? 0;
    if (c > 0) countB.set(t, c - 1);
    else missing.push(t);
  }
  const countA = new Map<string, number>();
  for (const t of a) countA.set(t, (countA.get(t) ?? 0) + 1);
  const added: string[] = [];
  for (const t of b) {
    const c = countA.get(t) ?? 0;
    if (c > 0) countA.set(t, c - 1);
    else added.push(t);
  }
  return { ok: missing.length === 0 && added.length === 0, missing, added };
}

export type PlaceholderKind = 'fact' | 'claim' | 'ref' | 'generic';

export interface PlaceholderSpan {
  start: number;
  end: number;
  text: string;
  kind: PlaceholderKind;
}

const MAX_PLACEHOLDER_CONTENT = 160;

/** Find the `]` matching the `[` at `i` (nested brackets allowed), or -1 (newline, too long, unclosed). */
function matchBracket(text: string, i: number): number {
  let depth = 0;
  const limit = Math.min(text.length, i + MAX_PLACEHOLDER_CONTENT + 2);
  for (let j = i; j < limit; j++) {
    const c = text[j];
    if (c === '\n' || c === '\r') return -1;
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** Index of the `{` matching the `}` at `close`, or -1. */
function matchOpenBrace(text: string, close: number): number {
  let depth = 0;
  for (let j = close; j >= 0; j--) {
    const c = text[j];
    if (j > 0 && text[j - 1] === '\\' && (c === '{' || c === '}')) continue;
    if (c === '}') depth++;
    else if (c === '{') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** Index of the `[` matching the `]` at `close`, or -1. */
function matchOpenBracket(text: string, close: number): number {
  let depth = 0;
  for (let j = close; j >= 0; j--) {
    const c = text[j];
    if (j > 0 && text[j - 1] === '\\') continue;
    if (c === ']') depth++;
    else if (c === '[') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** True when the text right before `pos` (exclusive) ends a command name, `\\`, or a command argument. */
function endsCommandOrArg(text: string, pos: number, placeholderEnds: ReadonlySet<number>, depth = 0): boolean {
  if (pos <= 0 || depth > 8) return false;
  const before = text.slice(Math.max(0, pos - 64), pos);
  if (/\\(?:[A-Za-z@]+|\\)\*?$/.test(before)) {
    // `\\` is a command, but `\\\\` (two backslashes) followed by `[` too; `\\[` itself (display math) is not reached here
    return true;
  }
  const prev = text[pos - 1];
  if (prev === '}') {
    const open = matchOpenBrace(text, pos - 1);
    if (open < 0) return false;
    return endsCommandOrArg(text, open, placeholderEnds, depth + 1);
  }
  if (prev === ']') {
    if (placeholderEnds.has(pos)) return false;
    const open = matchOpenBracket(text, pos - 1);
    if (open < 0) return false;
    return endsCommandOrArg(text, open, placeholderEnds, depth + 1);
  }
  return false;
}

function placeholderKind(content: string): PlaceholderKind | null {
  const c = content.trim();
  if (!c) return null;
  if (/^fact\s*\?/i.test(c)) return 'fact';
  if (/^claim\s*:/i.test(c)) return 'claim';
  if (/^(?:ref|refs|cite|cites|citation|citations)\s*\??$/i.test(c) || /^(?:ref|refs|cite|citation)\s*\??\s*:/i.test(c)) return 'ref';
  if (c.endsWith('?')) return 'generic';
  return null;
}

/**
 * Placeholders in paper text, as the skill prescribes: `[fact?: description]`, `[claim: text?]`,
 * `[ref]`, `[cite?]`, and generic `[baseline?]`, `[factor?]`, `[range: cτ?]` (a bracket group whose
 * content ends with `?`). A bracket group is NOT a placeholder when it is a LaTeX optional argument:
 * immediately preceded (ignoring nothing) by a command name (`\cite[`, `\\[`, `\item[`), by `}` or `]`
 * of a command, or by `\begin{..}`. Content may not contain newlines and is at most 160 chars.
 */
export function findPlaceholders(text: string): PlaceholderSpan[] {
  const s = typeof text === 'string' ? text : String(text ?? '');
  const out: PlaceholderSpan[] = [];
  if (s.indexOf('[') < 0) return out;
  const placeholderEnds = new Set<number>();
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf('[', i);
    if (open < 0) break;
    // `\[` is display math, not a bracket group.
    let bs = 0;
    for (let k = open - 1; k >= 0 && s[k] === '\\'; k--) bs++;
    if (bs % 2 === 1) {
      i = open + 1;
      continue;
    }
    const close = matchBracket(s, open);
    if (close < 0) {
      i = open + 1;
      continue;
    }
    if (endsCommandOrArg(s, open, placeholderEnds)) {
      i = close + 1;
      continue;
    }
    const content = s.slice(open + 1, close);
    const kind = content.length <= MAX_PLACEHOLDER_CONTENT ? placeholderKind(content) : null;
    if (kind) {
      out.push({ start: open, end: close + 1, text: s.slice(open, close + 1), kind });
      placeholderEnds.add(close + 1);
      i = close + 1;
    } else {
      // a plain bracket group may still contain a placeholder: `[see [ref]]`
      i = open + 1;
    }
  }
  return out;
}
