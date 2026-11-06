/**
 * Offset-mapped "plain" view of one LaTeX sentence for numeral extraction.
 *
 * The sentence is rewritten into a string `s` in which every character remembers the source span it
 * came from (`a[i]..b[i]`), whether it is inside math, inside a sub/superscript group, inside a
 * placeholder, or inside a \SI/\num command. LaTeX that can never hold a prose number is dropped or
 * replaced by marker characters:
 * - \cite{..} -> CITE marker, \ref{..} family -> REF marker, \label{..} -> nothing;
 * - comments, optional arguments of commands, environment names, URLs, paths and lengths -> nothing;
 * - other control words -> MACRO marker (so `\alpha2` never glues), except symbols that matter for
 *   numbers (`\pm` -> ±, `\times` -> ×, `\geq` -> ≥, `\%` -> %, `\,` -> thin space, `\GeV` -> GeV ...);
 * - braces -> GROUP_OPEN / GROUP_CLOSE separators (so `\frac{1}{2}` never reads as 12), except
 *   `{,}` -> `,` (thousands separator) and the braces of formatting/unit wrappers (`\mathrm{GeV}` -> GeV);
 * - `$`, `\(`, `\[` and math environments toggle the math flag and emit nothing.
 *
 * OWNER: core-gate agent.
 */
import { findPlaceholders, isCiteCommand, skipGroup } from '../latex/tokens';

export const CITE = '\u0001';
export const MACRO = '\u0002';
export const REF = '\u0004';
export const GO = '\u0005';
export const GC = '\u0006';
export const THIN = '\u2009';

export interface Plain {
  s: string;
  /** Source start of each plain char. */
  a: number[];
  /** Source end (exclusive) of each plain char. */
  b: number[];
  math: boolean[];
  /** 0 none, 1 superscript, 2 subscript. */
  script: number[];
  /** The script group starts right after a digit. */
  scriptAfterDigit: boolean[];
  /** Span of the enclosing \SI / \num / \qty command, if any. */
  cmd: Array<[number, number] | null>;
  /** Inside a placeholder `[fact?: ..]`. */
  placeholder: boolean[];
  /** Source offsets of `%` characters that follow a digit and were read as a percent sign, not a comment. */
  rawPercents: number[];
}

const RE_ESC: Record<string, string> = { '%': '%', '&': '&', '_': '_', '#': '#', '$': MACRO, '{': GO, '}': GC };

const SYMBOLS: Record<string, string> = {
  pm: '±', mp: '∓', times: '×', cdot: '·', geq: '≥', ge: '≥', geqslant: '≥', leq: '≤', le: '≤', leqslant: '≤', gt: '>', lt: '<',
  gtrsim: '≳', gtrapprox: '≳', lesssim: '≲', lessapprox: '≲', approx: '≈', simeq: '≈', sim: '∼', sigma: 'σ', mu: 'µ', micro: 'µ',
  degree: '°', textdegree: '°', minus: '−', textminus: '−', textendash: '–', textemdash: '—', percent: '%', textpm: '±', textmu: 'µ',
  textperthousand: '‰', ll: '≪', gg: '≫', neq: '≠', ne: '≠', equiv: '≡', propto: '∝',
};

/** Unit macros (HEP packages, siunitx shorthands) -> prose unit. */
const UNIT_MACROS: Record<string, string> = {
  eV: 'eV', keV: 'keV', MeV: 'MeV', GeV: 'GeV', TeV: 'TeV', PeV: 'PeV', GeVc: 'GeV/c', MeVc: 'MeV/c', GeVcc: 'GeV/c^2',
  mm: 'mm', cm: 'cm', um: 'µm', micron: 'µm', nm: 'nm', fm: 'fm', km: 'km', ns: 'ns', ps: 'ps', fs: 'fs', us: 'µs',
  fb: 'fb', pb: 'pb', nb: 'nb', ab: 'ab', ifb: 'fb^-1', invfb: 'fb^-1', fbinv: 'fb^-1', ipb: 'pb^-1', invpb: 'pb^-1', pbinv: 'pb^-1',
  iab: 'ab^-1', invab: 'ab^-1', abinv: 'ab^-1', inb: 'nb^-1', mrad: 'mrad', murad: 'µrad', rad: 'rad', tesla: 'T',
};

/** Wrappers whose braces are dropped (their content stays in the same word). */
const WRAPPERS = new Set([
  'emph', 'textit', 'textbf', 'textrm', 'textsc', 'textsf', 'texttt', 'textup', 'textnormal', 'textsl', 'textmd', 'mbox', 'hbox', 'text',
  'mathrm', 'mathit', 'mathbf', 'mathsf', 'mathtt', 'mathcal', 'mathbb', 'mathscr', 'mathfrak', 'boldsymbol', 'bm', 'operatorname',
  'ensuremath', 'textsuperscript', 'textsubscript', 'underline', 'uline', 'textnormal', 'mathnormal',
]);

/** Declarations that take no argument and emit nothing. */
const DECLARATIONS = new Set([
  'rm', 'it', 'bf', 'em', 'sf', 'tt', 'sc', 'sl', 'small', 'footnotesize', 'scriptsize', 'tiny', 'large', 'Large', 'LARGE', 'huge',
  'Huge', 'normalsize', 'centering', 'raggedright', 'raggedleft', 'displaystyle', 'textstyle', 'scriptstyle', 'left', 'right',
  'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'protect', 'xspace', 'relax', 'noindent', 'par', 'nobreak',
  'allowbreak', 'hfill', 'vfill', 'smallskip', 'medskip', 'bigskip', 'linebreak', 'newline', 'maketitle', 'appendix',
]);

const SPACE_MACROS = new Set([' ', ';', ':', '!', '>', 'quad', 'qquad', 'enspace', 'enskip', 'space', 'nobreakspace']);
const THIN_MACROS = new Set([',', 'thinspace', 'negthinspace']);

/** First brace argument is opaque (paths, URLs, lengths, colors ...). Value: number of opaque brace args. */
const OPAQUE_ARGS: Record<string, number> = {
  url: 1, href: 1, includegraphics: 1, input: 1, include: 1, hspace: 1, vspace: 1, color: 1, textcolor: 1, colorbox: 1,
  bibliography: 1, bibliographystyle: 1, usepackage: 1, setlength: 2, addtolength: 2, rule: 2, parbox: 1, makebox: 0,
  framebox: 0, raisebox: 1, scalebox: 1, resizebox: 2, doi: 1, arxiv: 1, eprint: 1, nocite: 1, bibitem: 1, label: 1,
  pagestyle: 1, thispagestyle: 1, newcommand: 2, renewcommand: 2, providecommand: 2, def: 0, hyperref: 0, hypertarget: 1,
  hyperlink: 1, vskip: 0, hskip: 0, kern: 0, settowidth: 2, phantom: 1, hphantom: 1, vphantom: 1,
};

const REF_NAMES = new Set([
  'ref', 'eqref', 'cref', 'Cref', 'autoref', 'Autoref', 'pageref', 'nameref', 'vref', 'Vref', 'labelcref', 'cpageref', 'Cpageref',
  'crefrange', 'Crefrange', 'subref',
]);

const MATH_ENVS = new Set([
  'equation', 'align', 'gather', 'multline', 'eqnarray', 'displaymath', 'math', 'flalign', 'alignat', 'dmath', 'subequations',
]);

/** Environments whose first brace argument after the name is a spec (column spec, width). */
const ENV_SPEC_ARGS: Record<string, number> = { tabular: 1, 'tabular*': 2, tabularx: 2, array: 1, minipage: 1, wrapfigure: 2, multicols: 1, subfigure: 1 };

/** siunitx unit macros -> text. */
const SI_PREFIX: Record<string, string> = {
  yocto: 'y', zepto: 'z', atto: 'a', femto: 'f', pico: 'p', nano: 'n', micro: 'µ', milli: 'm', centi: 'c', deci: 'd', kilo: 'k',
  mega: 'M', giga: 'G', tera: 'T', peta: 'P', exa: 'E',
};
const SI_UNIT: Record<string, string> = {
  metre: 'm', meter: 'm', second: 's', electronvolt: 'eV', eV: 'eV', barn: 'b', tesla: 'T', radian: 'rad', degree: '°',
  hertz: 'Hz', gram: 'g', kelvin: 'K', ampere: 'A', volt: 'V', watt: 'W', joule: 'J', percent: '%', sievert: 'Sv', gray: 'Gy',
  hour: 'h', minute: 'min', litre: 'l', liter: 'l', newton: 'N', pascal: 'Pa', candela: 'cd', mole: 'mol', coulomb: 'C',
};

/** Convert a siunitx unit argument (`\GeV`, `\giga\electronvolt`, `\per\femto\barn`, `GeV`) to prose text. */
export function siUnitText(arg: string): string {
  const s = arg.trim();
  if (!s) return '';
  if (!s.includes('\\')) return s.replace(/\s+/g, ' ').replace(/[~]/g, ' ').trim();
  const parts: string[] = [];
  let per = false;
  let prefix = '';
  const re = /\\([A-Za-z]+)|([^\\\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[2] !== undefined) {
      parts.push(m[2].replace(/[{}~]/g, ''));
      continue;
    }
    const name = m[1]!;
    if (name === 'per') {
      per = true;
      continue;
    }
    if (name === 'square' || name === 'squared' || name === 'cubic' || name === 'cubed') continue;
    if (SI_PREFIX[name] !== undefined) {
      prefix += SI_PREFIX[name];
      continue;
    }
    let u = SI_UNIT[name] ?? UNIT_MACROS[name] ?? (name === 'percent' ? '%' : null);
    if (u === null) u = name;
    const unit = prefix + u;
    prefix = '';
    parts.push(per ? `${unit}^-1` : unit);
    per = false;
  }
  return parts.join(' ').trim();
}

interface Frame {
  /** Emit GROUP_CLOSE when the frame closes. */
  emitClose: boolean;
  script: number;
  scriptAfterDigit: boolean;
  cmd: [number, number] | null;
  /** Restore math flag on close (for \text inside math we keep math=true anyway). */
}

function isLetterCh(c: string | undefined): boolean {
  return c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '@');
}
function isDigitCh(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}

function skipWs(text: string, i: number): number {
  while (i < text.length && /[ \t\r\n]/.test(text[i]!)) i++;
  return i;
}

function skipOpt(text: string, i: number, allowSpace: boolean): number {
  for (;;) {
    const k = allowSpace ? skipWs(text, i) : i;
    if (text[k] === '[') {
      i = skipGroup(text, k, '[', ']');
      continue;
    }
    return i;
  }
}

/** Skip `count` brace arguments (each optionally preceded by whitespace); returns the end index. */
function skipArgs(text: string, i: number, count: number): number {
  for (let c = 0; c < count; c++) {
    const k = skipWs(text, i);
    if (text[k] !== '{') return i;
    i = skipGroup(text, k);
  }
  return i;
}

/** Build the plain view. Never throws. */
export function buildPlain(input: string): Plain {
  const text = typeof input === 'string' ? input : String(input ?? '');
  const P: Plain = { s: '', a: [], b: [], math: [], script: [], scriptAfterDigit: [], cmd: [], placeholder: [], rawPercents: [] };
  const chars: string[] = [];
  const phSpans = findPlaceholders(text);
  const inPh = (pos: number): boolean => {
    for (const p of phSpans) if (pos >= p.start && pos < p.end) return true;
    return false;
  };
  const stack: Frame[] = [];
  let math = false;
  let mathClose: string | null = null;
  /** Script applied to the next emitted token only (`^2`, `_\mu`). */
  let scriptOnce = 0;
  let scriptOnceAfterDigit = false;

  const top = (): Frame | undefined => stack[stack.length - 1];
  const curScript = (): { k: number; d: boolean } => {
    if (scriptOnce) return { k: scriptOnce, d: scriptOnceAfterDigit };
    for (let j = stack.length - 1; j >= 0; j--) if (stack[j]!.script) return { k: stack[j]!.script, d: stack[j]!.scriptAfterDigit };
    return { k: 0, d: false };
  };
  const curCmd = (): [number, number] | null => {
    for (let j = stack.length - 1; j >= 0; j--) if (stack[j]!.cmd) return stack[j]!.cmd;
    return null;
  };
  const lastChar = (): string | undefined => chars[chars.length - 1];
  const emit = (str: string, a: number, b: number): void => {
    const sc = curScript();
    const cmd = curCmd();
    const ph = inPh(a);
    for (let q = 0; q < str.length; q++) {
      chars.push(str[q]!);
      P.a.push(a);
      P.b.push(b);
      P.math.push(math);
      P.script.push(sc.k);
      P.scriptAfterDigit.push(sc.d);
      P.cmd.push(cmd);
      P.placeholder.push(ph);
    }
  };
  const endOnce = (): void => {
    scriptOnce = 0;
    scriptOnceAfterDigit = false;
  };

  const n = text.length;
  let i = 0;
  let guard = 0;
  while (i < n) {
    if (++guard > n * 4 + 100) break; // defensive: never loop forever
    const c = text[i]!;
    // ---------------------------------------------------------------- comments / raw percent
    if (c === '%') {
      // `97%` (unescaped) after a digit: read as a percent sign (and remember it: it is broken LaTeX).
      let k = chars.length - 1;
      while (k >= 0 && (chars[k] === ' ' || chars[k] === THIN)) k--;
      if (k >= 0 && isDigitCh(chars[k])) {
        P.rawPercents.push(i);
        emit('%', i, i + 1);
        i++;
        continue;
      }
      let e = text.indexOf('\n', i);
      if (e < 0) e = n;
      i = e;
      continue;
    }
    if (c === '$') {
      const dbl = text[i + 1] === '$';
      const len = dbl ? 2 : 1;
      if (!math) {
        math = true;
        mathClose = dbl ? '$$' : '$';
      } else if ((mathClose === '$$' && dbl) || mathClose === '$') {
        math = false;
        mathClose = null;
      }
      i += len;
      continue;
    }
    if (c === '{') {
      if (text[i + 1] === ',' && text[i + 2] === '}') {
        emit(',', i, i + 3);
        i += 3;
        endOnce();
        continue;
      }
      const once = scriptOnce;
      const onceD = scriptOnceAfterDigit;
      endOnce();
      if (once) {
        // `^{..}` group: the whole group is the script
        stack.push({ emitClose: true, script: once, scriptAfterDigit: onceD, cmd: null });
      } else {
        stack.push({ emitClose: true, script: 0, scriptAfterDigit: false, cmd: null });
        emit(GO, i, i + 1);
      }
      i++;
      continue;
    }
    if (c === '}') {
      const f = stack.pop();
      if (f && f.emitClose) {
        // close emitted without the script flag of the closed frame
        const sc = f.script;
        if (sc) {
          // keep the closer flagged as script so it binds to the exponent
          chars.push(GC);
          P.a.push(i);
          P.b.push(i + 1);
          P.math.push(math);
          P.script.push(sc);
          P.scriptAfterDigit.push(f.scriptAfterDigit);
          P.cmd.push(curCmd());
          P.placeholder.push(inPh(i));
        } else {
          emit(GC, i, i + 1);
        }
      }
      i++;
      continue;
    }
    if (c === '^' || c === '_') {
      const afterDigit = isDigitCh(lastChar());
      emit(c, i, i + 1);
      scriptOnce = c === '^' ? 1 : 2;
      scriptOnceAfterDigit = afterDigit;
      i++;
      // skip spaces between ^ and its argument
      i = skipWs(text, i);
      // single-character argument (not a group, not a macro): emit it flagged and stop
      const nc = text[i];
      if (nc !== undefined && nc !== '{' && nc !== '\\') {
        emit(nc, i, i + 1);
        endOnce();
        i++;
      }
      continue;
    }
    if (c === '~') {
      emit(' ', i, i + 1);
      endOnce();
      i++;
      continue;
    }
    if (c === '\n' || c === '\t' || c === '\r' || c === ' ') {
      emit(' ', i, i + 1);
      i++;
      continue;
    }
    if (c === '\u202f') {
      emit(THIN, i, i + 1);
      i++;
      continue;
    }
    if (c !== '\\') {
      emit(c, i, i + 1);
      endOnce();
      i++;
      continue;
    }
    // ---------------------------------------------------------------- control sequences
    let j = i + 1;
    if (j >= n) {
      i = n;
      break;
    }
    let name: string;
    if (isLetterCh(text[j])) {
      while (j < n && isLetterCh(text[j])) j++;
      name = text.slice(i + 1, j);
      if (text[j] === '*') j++;
    } else {
      name = text[j]!;
      j++;
    }
    const start = i;
    // control symbols
    if (name.length === 1 && !isLetterCh(name)) {
      if (name === '\\') {
        if (text[j] === '*') j++;
        j = skipOpt(text, j, false);
        emit(' ', start, j);
        i = j;
        endOnce();
        continue;
      }
      if (name === '(' || name === '[') {
        math = true;
        mathClose = '\\' + (name === '(' ? ')' : ']');
        i = j;
        continue;
      }
      if (name === ')' || name === ']') {
        if (mathClose === '\\' + name) {
          math = false;
          mathClose = null;
        }
        i = j;
        continue;
      }
      if (THIN_MACROS.has(name)) emit(THIN, start, j);
      else if (SPACE_MACROS.has(name)) emit(' ', start, j);
      else if (RE_ESC[name] !== undefined) emit(RE_ESC[name]!, start, j);
      else if (name === '-' || name === '/' || name === '@') {
        /* invisible */
      } else emit(MACRO, start, j);
      endOnce();
      i = j;
      continue;
    }
    // control words
    if (name === 'begin' || name === 'end') {
      const k = skipWs(text, j);
      if (text[k] === '{') {
        const ge = skipGroup(text, k);
        const env = text.slice(k + 1, ge - 1).trim();
        const base = env.replace(/\*$/, '');
        let e = ge;
        if (MATH_ENVS.has(base)) {
          if (name === 'begin') {
            math = true;
            mathClose = 'env:' + base;
          } else if (mathClose === 'env:' + base) {
            math = false;
            mathClose = null;
          }
        }
        if (name === 'begin') {
          e = skipOpt(text, e, false);
          const specs = ENV_SPEC_ARGS[env] ?? ENV_SPEC_ARGS[base] ?? 0;
          if (specs) e = skipArgs(text, skipOpt(text, e, true), specs);
        }
        emit(' ', start, e);
        endOnce();
        i = e;
        continue;
      }
      i = j;
      continue;
    }
    if (isCiteCommand(name) || REF_NAMES.has(name) || name === 'label') {
      let k = skipOpt(text, j, true);
      const multi = (isCiteCommand(name) && /s$/.test(name)) || name === 'crefrange' || name === 'Crefrange';
      k = skipArgs(text, k, 1);
      if (multi) {
        for (let guard2 = 0; guard2 < 32; guard2++) {
          const k2 = skipWs(text, skipOpt(text, k, true));
          if (text[k2] !== '{') break;
          k = skipGroup(text, k2);
        }
      }
      if (name !== 'label') emit(isCiteCommand(name) ? CITE : REF, start, k);
      endOnce();
      i = k;
      continue;
    }
    if (name === 'verb') {
      const d = text[j];
      const close = d === undefined ? -1 : text.indexOf(d, j + 1);
      const e = close < 0 ? n : close + 1;
      emit(MACRO, start, e);
      endOnce();
      i = e;
      continue;
    }
    if (name === 'SI' || name === 'qty' || name === 'num' || name === 'SIrange' || name === 'qtyrange' || name === 'numrange' || name === 'ang' || name === 'SIlist' || name === 'numlist' || name === 'qtylist') {
      // \SI[opts]{num}{unit}; \num[opts]{num}; \SIrange[opts]{a}{b}{unit}; \numrange{a}{b}; \ang{x}
      let k = skipOpt(text, j, true);
      const nums = name === 'SIrange' || name === 'qtyrange' || name === 'numrange' ? 2 : 1;
      const hasUnit = name === 'SI' || name === 'qty' || name === 'SIrange' || name === 'qtyrange' || name === 'SIlist' || name === 'qtylist';
      // find the full command span first
      let e = k;
      const argSpans: Array<[number, number]> = [];
      for (let c2 = 0; c2 < nums + (hasUnit ? 1 : 0); c2++) {
        const k2 = skipWs(text, e);
        if (text[k2] !== '{') break;
        const ge = skipGroup(text, k2);
        argSpans.push([k2, ge]);
        e = ge;
      }
      const span: [number, number] = [start, e];
      emit(GO, start, k);
      for (let c2 = 0; c2 < argSpans.length; c2++) {
        const [s0, s1] = argSpans[c2]!;
        const inner = text.slice(s0 + 1, Math.max(s0 + 1, s1 - 1));
        if (c2 < nums) {
          if (c2 > 0) emit(' – ', s0, s0 + 1);
          // process the number argument through the main loop by recursion on a sub-view
          const sub = buildPlain(inner);
          for (let q = 0; q < sub.s.length; q++) {
            const sa = Math.min(s0 + 1 + sub.a[q]!, s1 - 1);
            const sb = Math.min(s0 + 1 + sub.b[q]!, s1 - 1);
            chars.push(sub.s[q]!);
            P.a.push(sa);
            P.b.push(Math.max(sb, sa));
            P.math.push(math || sub.math[q]!);
            P.script.push(sub.script[q]!);
            P.scriptAfterDigit.push(sub.scriptAfterDigit[q]!);
            P.cmd.push(span);
            P.placeholder.push(false);
          }
        } else {
          const u = siUnitText(inner);
          if (u) emit(' ' + u, s0, s1);
        }
      }
      if (name === 'ang') emit('°', Math.max(start, e - 1), e);
      emit(GC, Math.max(start, e - 1), e);
      endOnce();
      i = e;
      continue;
    }
    if (name === 'si' || name === 'unit') {
      // siunitx unit alone: \si{\micro\metre} -> "µm"
      const k0 = skipOpt(text, j, true);
      const k = skipWs(text, k0);
      if (text[k] === '{') {
        const ge = skipGroup(text, k);
        const u = siUnitText(text.slice(k + 1, Math.max(k + 1, ge - 1)));
        emit(u ? u : MACRO, start, ge);
        endOnce();
        i = ge;
        continue;
      }
    }
    if (OPAQUE_ARGS[name] !== undefined) {
      let k = skipOpt(text, j, true);
      k = skipArgs(text, k, OPAQUE_ARGS[name]!);
      if (name === 'makebox' || name === 'framebox') k = skipOpt(text, k, true);
      emit(name === 'hspace' || name === 'vspace' ? ' ' : MACRO, start, k);
      endOnce();
      i = k;
      continue;
    }
    if (SYMBOLS[name] !== undefined) {
      emit(SYMBOLS[name]!, start, j);
      endOnce();
      i = j;
      continue;
    }
    if (name === 'circ' && scriptOnce === 1) {
      emit('°', start, j);
      endOnce();
      i = j;
      continue;
    }
    if (UNIT_MACROS[name] !== undefined) {
      emit(UNIT_MACROS[name]!, start, j);
      endOnce();
      // `\GeV{}` swallow empty group
      if (text[j] === '{' && text[j + 1] === '}') j += 2;
      i = j;
      continue;
    }
    if (THIN_MACROS.has(name)) {
      emit(THIN, start, j);
      i = j;
      continue;
    }
    if (SPACE_MACROS.has(name)) {
      emit(' ', start, j);
      i = j;
      continue;
    }
    if (DECLARATIONS.has(name)) {
      i = j;
      continue;
    }
    if (WRAPPERS.has(name)) {
      const k = skipWs(text, j);
      if (text[k] === '{') {
        const once = scriptOnce;
        const onceD = scriptOnceAfterDigit;
        endOnce();
        stack.push({ emitClose: once !== 0, script: once, scriptAfterDigit: onceD, cmd: null });
        i = k + 1;
        continue;
      }
      i = j;
      continue;
    }
    if (name === 'item') {
      const k = skipOpt(text, j, false);
      emit(' ', start, k);
      i = k;
      continue;
    }
    // any other control word: a marker, then skip a glued optional argument (`\caption[short]{..}`)
    emit(MACRO, start, j);
    endOnce();
    i = text[j] === '[' ? skipOpt(text, j, false) : j;
  }
  P.s = chars.join('');
  return P;
}
