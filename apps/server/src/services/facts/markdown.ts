/**
 * Definitions-style markdown (e.g. `docs/definitions.md`) -> cut, setting and definition facts.
 *
 * Rules (deterministic, documented in tests):
 * - Fenced code blocks are skipped. `#` headings set the section shown in definition sources.
 * - A list item (or paragraph) of the form `**Term** (note): text` or `Term: text` (a term of at most
 *   eight words before the first colon) becomes a `definition` fact: value = the text (continuation
 *   lines joined, markdown stripped), definition = the term. Kind `sample` when the term is "Sample(s)".
 * - Every comparison on a line becomes its own fact with locator `md:line=N` (the line it is on):
 *   `<quantity> <op> <number> [unit]` and `<op> <number> <counted noun>` (">= 5 space points") with op
 *   one of `> < >= <= ≥ ≤ \geq \leq`, "at least", "at most", "more than", "fewer than", "less than",
 *   "greater than", "above", "below" -> kind `cut`, tags ['cut', 'cmp:<op>'];
 *   `<quantity> = <number> [unit]` -> kind `setting`, tags ['setting', 'cmp:=']. A number followed by an
 *   arithmetic operator or another variable (`R = 1000 pT / ...`) is an expression, not a setting, and
 *   ranges (`0.052-0.061 mm`) are not cuts. Units are physics units (GeV, mm, rad, T, % ...); a counted
 *   noun (hits, space points, tracks ...) is kept in the definition and the id, and the unit is ''.
 * - Values are the numbers as written (thousands separators removed). Nothing is inferred.
 */

export interface MdFact {
  kind: 'cut' | 'setting' | 'definition' | 'sample';
  /** Id part after `f.<stem>.`, e.g. `pT_gt_1GeV`, `Target_reconstructable_particle`. */
  idPart: string;
  value: number | string;
  unit: string;
  /** 1-based line. */
  line: number;
  definition: string;
  definitionSource: string;
  tags: string[];
}

const PHYS_UNITS: Array<[RegExp, string]> = [
  [/^GeV(?![A-Za-z0-9])/, 'GeV'],
  [/^MeV(?![A-Za-z0-9])/, 'MeV'],
  [/^TeV(?![A-Za-z0-9])/, 'TeV'],
  [/^keV(?![A-Za-z0-9])/, 'keV'],
  [/^eV(?![A-Za-z0-9])/, 'eV'],
  [/^mm(?![A-Za-z0-9])/, 'mm'],
  [/^cm(?![A-Za-z0-9])/, 'cm'],
  [/^(?:μm|µm|um)(?![A-Za-z0-9])/, 'μm'],
  [/^nm(?![A-Za-z0-9])/, 'nm'],
  [/^ns(?![A-Za-z0-9])/, 'ns'],
  [/^ps(?![A-Za-z0-9])/, 'ps'],
  [/^fs(?![A-Za-z0-9])/, 'fs'],
  [/^ms(?![A-Za-z0-9])/, 'ms'],
  [/^mrad(?![A-Za-z0-9])/, 'mrad'],
  [/^rad(?![A-Za-z0-9])/, 'rad'],
  [/^deg(?:rees?)?(?![A-Za-z0-9])/, 'deg'],
  [/^°/, 'deg'],
  [/^%/, '%'],
  [/^percent(?![A-Za-z0-9])/, '%'],
  [/^T(?![A-Za-z0-9])/, 'T'],
  [/^m(?![A-Za-z0-9])/, 'm'],
  [/^s(?![A-Za-z0-9])/, 's'],
];

const NOUN_RE =
  /^(?:(space|pixel|forward|strip|true|reconstructed|matched|good|truth|outer|inner)\s+)?(points|hits|layers|tracks|events|particles|edges|seeds|vertices|muons|daughters|modules|cells|jets|leptons|stations|chambers|candidates|entries|bins|clusters|tracklets|segments|triplets|doublets|sigma)(?![A-Za-z0-9])/;

const STOP = new Set(
  (
    'and or with of the a an for to in at is are be by on from as than has have had if when that which where only also all each every any ' +
    'one two its their not no nor but so such both either plus minus then there this these those was were been being do does did gives give ' +
    'shown use uses used keep keeps kept get gets require requires required need needs needed without within per vs versus same set sets ' +
    'number fraction most least more less fewer greater'
  ).split(' '),
);

const OP_WORDS: Record<string, string> = {
  '>': 'gt',
  '<': 'lt',
  '>=': 'ge',
  '<=': 'le',
  '=': 'eq',
};

function canonicalOp(op: string): string {
  const o = op.toLowerCase().replace(/\s+/g, ' ');
  switch (o) {
    case '>=':
    case '=>':
    case '≥':
    case '⩾':
    case '\\geq':
    case '\\ge':
    case 'at least':
      return '>=';
    case '<=':
    case '=<':
    case '≤':
    case '⩽':
    case '\\leq':
    case '\\le':
    case 'at most':
      return '<=';
    case '>':
    case '\\gt':
    case 'more than':
    case 'greater than':
    case 'above':
      return '>';
    case '<':
    case '\\lt':
    case 'fewer than':
    case 'less than':
    case 'below':
      return '<';
    default:
      return '=';
  }
}

const GREEK: Record<string, string> = {
  α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', ζ: 'zeta', η: 'eta', θ: 'theta', ι: 'iota', κ: 'kappa',
  λ: 'lambda', μ: 'mu', µ: 'mu', ν: 'nu', ξ: 'xi', π: 'pi', ρ: 'rho', σ: 'sigma', τ: 'tau', υ: 'upsilon', φ: 'phi',
  χ: 'chi', ψ: 'psi', ω: 'omega', Γ: 'Gamma', Δ: 'Delta', Θ: 'Theta', Λ: 'Lambda', Ξ: 'Xi', Π: 'Pi', Σ: 'Sigma',
  Φ: 'Phi', Ψ: 'Psi', Ω: 'Omega',
};

/** Greek letters -> their names (η -> eta), for ids. */
export function transliterate(s: string): string {
  return s.replace(/[\u0370-\u03ff\u00b5]/g, (c) => GREEK[c] ?? c);
}

/** Markdown/LaTeX-light line -> plain text with the same meaning (keeps `|abs|` bars). */
export function plainMdLine(line: string): string {
  let s = line;
  s = s.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '');
  s = s.replace(/\\([|*_#`[\]()<>])/g, '$1'); // markdown escapes (\| inside tables)
  s = s.replace(/&(lt|gt|ge|le|amp|nbsp);/g, (_m, e: string) => ({ lt: '<', gt: '>', ge: '≥', le: '≤', amp: '&', nbsp: ' ' })[e] ?? _m);
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\*\*|__/g, '');
  s = s.replace(/(^|[\s(])\*(\S(?:[^*]*\S)?)\*(?=[\s.,;:)]|$)/g, '$1$2');
  s = s.replace(/`/g, '');
  s = s.replace(/\$/g, '');
  s = s.replace(/\\[,;: ]|~/g, ' ');
  return s;
}

function numSlug(raw: string): string {
  return raw
    .replace(/,/g, '')
    .replace(/^\+/, '')
    .replace(/^-/, 'm')
    .replace(/\./g, 'p')
    .replace(/[eE]-/, 'em')
    .replace(/[eE]\+?/, 'e');
}

function unitSlug(unit: string): string {
  if (unit === '%') return 'pct';
  if (unit === 'μm') return 'um';
  return unit.replace(/[^A-Za-z0-9]/g, '');
}

export function slugWords(text: string, max = 48): string {
  const words = transliterate(text)
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, ' ')
    .split(/[^A-Za-z0-9_-]+/)
    .map((w) => w.replace(/^[-_]+|[-_]+$/g, ''))
    .filter(Boolean);
  let out = '';
  for (const w of words) {
    const next = out ? `${out}_${w}` : w;
    if (next.length > max && out) break;
    out = next;
  }
  return out.slice(0, max) || 'x';
}

interface Comparison {
  /** Offset of the operator in the scanned text. */
  offset: number;
  qty: string | null;
  op: string;
  opText: string;
  numberText: string;
  value: number;
  unit: string;
  unitText: string;
  noun: string | null;
}

const CMP_RE =
  /(?:(>=|=>|<=|=<|≥|≤|⩾|⩽|>|<|=)|(\\(?:geq?|leq?|gt|lt))(?![A-Za-z])|\b(at least|at most|more than|fewer than|less than|greater than|above|below)\b)\s*([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

const QTY_RE = /(\|[^|\s][^|]{0,22}\||[A-Za-zͰ-Ͽ][\w^{}\\'.-]*(?:\[[^\]]{0,16}\])?)\s*$/u;

/** All comparisons on one plain-text line, in order. Exported for tests. */
export function findComparisons(plain: string): Comparison[] {
  const out: Comparison[] = [];
  CMP_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CMP_RE.exec(plain))) {
    const opText = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    const numberText = m[4]!;
    const start = m.index;
    const before = plain.slice(0, start);
    // '=' that is part of '==', '!=', '>=' handled by the alternation order; reject '!=' / '=='.
    if (opText === '=' && /[!=<>]$/.test(before)) continue;
    if ((opText === '>' || opText === '<') && /[<>-]$/.test(before)) continue; // arrows '->', '<<'
    const afterIdx = start + m[0].length;
    let rest = plain.slice(afterIdx);
    // A digit or letter glued to the number that is not a unit: part of another token.
    if (/^[0-9]/.test(rest)) continue;
    if (/^\s*[-–]\s*\d/.test(rest)) continue; // a range such as 0.052-0.061
    if (/^[.,]\d/.test(rest)) continue;
    let unit = '';
    let unitText = '';
    const restTrim = rest.replace(/^[\s~]+/, '');
    const glued = rest.length > 0 && /^[A-Za-zμµ%°]/.test(rest);
    for (const [re, canon] of PHYS_UNITS) {
      const um = re.exec(restTrim);
      if (um) {
        unit = canon;
        unitText = um[0];
        break;
      }
    }
    let noun: string | null = null;
    if (unit) {
      rest = restTrim.slice(unitText.length);
    } else {
      if (glued) continue; // e.g. "2x", "10K"
      const nm = NOUN_RE.exec(restTrim);
      if (nm) {
        noun = nm[0];
        rest = restTrim.slice(nm[0].length);
      } else {
        rest = restTrim;
      }
    }
    // An arithmetic continuation makes it an expression ("= 1000 pT / (0.3 x 2.0)").
    if (/^\s*(?:[x×*/+·^]|\\times|\\cdot)(?:\s|$|\d|\()/.test(rest)) continue;
    const op = canonicalOp(opText);
    const qm = QTY_RE.exec(before.slice(-80));
    let qty: string | null = qm ? qm[1]!.replace(/[.'-]+$/, '') : null;
    if (qty === '') qty = null;
    if (qty && !qty.startsWith('|') && STOP.has(qty.toLowerCase())) qty = null;
    if (qty && /^\d/.test(qty)) qty = null;
    if (op === '=') {
      if (!qty) continue;
      // "= 5 hits" is fine; "= 1000 pT" (followed by another variable) is an expression.
      if (!unit && !noun) {
        const nextWord = /^\s*([A-Za-z][\w]*)/.exec(rest);
        if (nextWord && !STOP.has(nextWord[1]!.toLowerCase())) continue;
      }
    } else if (!qty && !noun && !unit) {
      continue; // ">= 300 shown as overflow": nothing says what is compared
    }
    const value = Number(numberText.replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    out.push({ offset: start, qty, op, opText, numberText, value, unit, unitText, noun });
  }
  return out;
}

interface Item {
  line: number;
  lines: string[];
}

const DEF_BOLD = /^\*\*(.+?)\*\*\s*(\([^)]*\))?\s*:\s+([\s\S]+)$/;
const DEF_PLAIN = /^([^:\n]{2,80}?):\s+([\s\S]+)$/;

function stripInline(s: string): string {
  return plainMdLine(s).replace(/\s+/g, ' ').trim();
}

function parseDefinitionItem(raw: string): { term: string; text: string } | null {
  const text = raw.replace(/\s+/g, ' ').trim();
  const b = DEF_BOLD.exec(text);
  if (b) {
    const term = stripInline(b[1]! + (b[2] ? ' ' + b[2] : ''));
    const body = stripInline(b[3]!);
    if (term && body) return { term, text: body };
  }
  const p = DEF_PLAIN.exec(text);
  if (p) {
    const termRaw = p[1]!.trim();
    const words = termRaw.split(/\s+/).filter(Boolean);
    if (words.length === 0 || words.length > 8) return null;
    if (/[.!?]\s/.test(termRaw)) return null; // a sentence, not a term
    if (/^(?:https?|ftp|file)$/i.test(termRaw)) return null;
    if (!/^[A-Za-z`|*_(Ͱ-Ͽ]/u.test(termRaw)) return null;
    const term = stripInline(termRaw);
    const body = stripInline(p[2]!);
    if (term && body) return { term, text: body };
  }
  return null;
}

/** Parse a definitions-style markdown document. `artifact` is used in definition sources only. */
export function parseDefinitionsMarkdown(text: string, artifact: string): MdFact[] {
  const lines = text.split(/\r\n|\r|\n/);
  const out: MdFact[] = [];
  let section = '';
  let inFence = false;
  let item: Item | null = null;

  const flush = () => {
    if (!item) return;
    const joined = item.lines.map((l, i) => (i === 0 ? l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '') : l.trim())).join(' ');
    const def = parseDefinitionItem(joined);
    // Comparisons over the joined item text, so a comparison wrapped across lines is found; each
    // fact gets the line on which its operator stands.
    const starts: number[] = [];
    let plainJoined = '';
    item.lines.forEach((l, i) => {
      const p = i === 0 ? plainMdLine(l) : plainMdLine(l.trim()).trim();
      if (i > 0) plainJoined += ' ';
      starts.push(plainJoined.length);
      plainJoined += p;
    });
    const lineAt = (offset: number): number => {
      let k = 0;
      while (k + 1 < starts.length && starts[k + 1]! <= offset) k++;
      return item!.line + k;
    };
    const term = def ? def.term : null;
    for (const c of findComparisons(plainJoined)) {
      const ln = lineAt(c.offset);
      const srcLine = (lines[ln - 1] ?? '').trim();
      const subject = c.qty ?? c.noun ?? '';
      const subjectSlug = subject ? slugWords(subject.replace(/\|/g, ' '), 32) : '';
      const opWord = OP_WORDS[c.op] ?? 'eq';
      const idPart = [subjectSlug, opWord, numSlug(c.numberText) + unitSlug(c.unit)].filter(Boolean).join('_');
      const written = [c.qty, c.opText, c.numberText, c.unitText || null, c.noun].filter(Boolean).join(' ');
      const ctxBits = [term ? `"${term}"` : null, section ? `section "${section}"` : null].filter(Boolean);
      const excerpt = srcLine.length > 160 ? srcLine.slice(0, 157) + '...' : srcLine;
      out.push({
        kind: c.op === '=' ? 'setting' : 'cut',
        idPart,
        value: c.value,
        unit: c.unit,
        line: ln,
        definition: ctxBits.length ? `${written} (${ctxBits.join('; ')})` : written,
        definitionSource: `${artifact} line ${ln}: ${excerpt}`,
        tags: c.op === '=' ? ['setting', 'cmp:='] : ['cut', `cmp:${c.op}`, ...(c.noun && !c.unit ? ['count'] : [])],
      });
    }
    if (def) {
      const isSample = /^samples?\b/i.test(def.term);
      out.push({
        kind: isSample ? 'sample' : 'definition',
        idPart: slugWords(def.term),
        value: def.text.length > 1500 ? def.text.slice(0, 1500) : def.text,
        unit: '',
        line: item.line,
        definition: def.term,
        definitionSource: `${artifact} line ${item.line}${section ? `, section "${section}"` : ''}`,
        tags: [isSample ? 'sample' : 'definition'],
      });
    }
    item = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const ln = i + 1;
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      section = h[2]!.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    const isItemStart = /^\s*(?:[-*+]|\d+[.)])\s+/.test(line);
    if (isItemStart || !item) {
      flush();
      item = { line: ln, lines: [line] };
    } else {
      item.lines.push(line);
    }
  }
  flush();
  return out;
}
