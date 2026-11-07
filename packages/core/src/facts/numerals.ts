/**
 * Numeral extraction over the offset-mapped plain view (see plain.ts). Produces detailed tokens
 * (`NumeralDetail`) that the public `extractNumerals` trims to `NumeralToken`, and that the gate uses
 * for repairs, cut checks and factor/percent checks.
 *
 * OWNER: core-gate agent.
 */
import type { NumeralToken } from './numbers';
import { buildPlain, CITE, GC, GO, MACRO, THIN, type Plain } from './plain';

export interface NumeralDetail extends NumeralToken {
  /** Power of ten applied to the mantissa (`1.2\times10^{-4}` -> -4, `10^8` -> 8, else 0). */
  exponent: number;
  /** Written as a factor (`2.4 times`, `2.4\times`, `2.4-fold`, `a factor of 2.4`). */
  factor: boolean;
  /** Comparison right before it (`>`, `<`, `>=`, `<=`, `above`, `below`, `at least` ...), normalized, or null. */
  comparison: string | null;
  /** Ordinal (`1st`, `2nd`). */
  ordinal: boolean;
  /** Written with a minus sign. */
  negative: boolean;
  /** Index (in the returned array) of the value this uncertainty belongs to, or -1. */
  uncertaintyOf: number;
  /** Source span to replace when the gate turns this numeral into a placeholder. */
  replStart: number;
  replEnd: number;
  /** Plain-view indices (internal). */
  pStart: number;
  pEnd: number;
  /** Plain index after attached scripts/compact uncertainty (where unit lookup starts). */
  pAfter: number;
  /** Written in words ("ninety-seven", "twice", "a hundredfold", "an order of magnitude"). */
  word: boolean;
  /** Normalized wording of a word numeral ("ninety-seven percent", "hundredfold", "five times"); '' for digits. */
  phrase: string;
  /** "N out of M", "N in M", "N of M" (digits): the denominator M; the token stands for the ratio N/M. */
  ratioDen: number | null;
  /** The denominator of a ratio (consumed by the numerator token; structural). */
  ratioPart: boolean;
  /**
   * A small digit integer (0-10) that counts something outside the list of structural countables
   * ("8 GPUs", "3 fake tracks"); structural, but the gate checks it in ghost and draft modes.
   */
  smallCount: boolean;
  /** The comparison word is a weak one ("over", "under", "within", "beyond"): "averaged over 3 seeds". */
  weakComparison: boolean;
}

const STRUCT_WORDS = new Set(
  (
    'sec secs section sections fig figs figure figures eq eqs eqn eqns equation equations table tables tab tabs app apps appendix ' +
    'appendices ref refs reference references chapter chapters chap part parts line lines item items step steps stage stages ' +
    'phase phases run runs algorithm algorithms alg listing listings theorem lemma corollary definition page pages pp ' +
    'option options case cases scenario scenarios version type class level layer layers volume volumes vol panel panels row rows ' +
    'column columns col cols footnote footnotes paragraph point'
  ).split(' '),
);
/** Structural words that are also ordinary lowercase words: structural only when capitalized ("Run 2", "Case 1"). */
const CAPITAL_ONLY = new Set(
  'part parts line lines item items step steps stage stages phase phases run runs option options case cases scenario scenarios version type class level layer layers volume volumes vol panel panels row rows column columns col cols point'.split(' '),
);
const YEAR_WORDS = new Set(
  (
    'in since until till from during before after early late mid circa year years summer winter spring autumn fall ' +
    'january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec'
  ).split(' '),
);

/** Nouns that make a preceding integer a count ("2024 events"), never a year. */
const COUNTED_NOUN =
  /^(?:events?|targets?|particles?|tracks?|hits?|samples?|jets?|muons?|electrons?|photons?|leptons?|vertices|vertex|seeds?|bins?|points?|entries|candidates?|layers?|cells?|channels?|modules?|iterations?|epochs?|steps?|trials?|toys?|simulations?|collisions?|signals?|backgrounds?|times|daughters?|pairs?|edges?|nodes?|graphs?|parameters?|runs?|files?|images?|examples?|objects?|clusters?|segments?|showers?|decays?|neutrinos?|protons?|pions?|kaons?|bunches?|crossings?|tracklets?)$/i;

/** Nouns a small digit integer may count without a fact ("3 seeds", "2 panels"): structure, not results. */
const COUNTABLE = new Set(
  (
    'seed seeds layer layers step steps stage stages panel panels bin bins column columns row rows figure figures fig figs ' +
    'table tables section sections sec secs chapter chapters case cases class classes category categories region regions part parts ' +
    'component components term terms type types kind kinds group groups set sets method methods model models approach approaches ' +
    'option options variant variants scenario scenarios configuration configurations dimension dimensions dim axis axes criterion ' +
    'criteria condition conditions question questions example examples equation equations eq eqs appendix appendices item items ' +
    'line lines paragraph paragraphs sentence sentences word words author authors paper papers reference references ref refs ' +
    'point points way ways reason reasons feature features input inputs output outputs head heads block blocks hidden ' +
    'sub subsection subsections run runs version versions sample samples'
  ).split(' '),
);
/** Words after a small integer that are not nouns ("3 and 4", "2 or more", "5 of them"). */
const NON_NOUN = new Set(
  (
    'and or of to in on at by for with from than as is are was were be been the a an that which per each times nor but ' +
    'if so then also only more less fewer most least other others such these those this its their our we it they ' +
    'where when while after before above below between into onto via vs versus etc because since although though unless until ' +
    'has have had do does did can could will would may might shall should must remain remains gives give shows show'
  ).split(' '),
);

/* Word numerals. Cardinals 0-99 (compounds with a hyphen or a space), optionally times hundred/thousand/million. */
const W_UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const W_TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const W_SCALE: Record<string, number> = { hundred: 100, thousand: 1000, million: 1e6, billion: 1e9 };
const W_UNIT_RE = 'one|two|three|four|five|six|seven|eight|nine';
const W_CARD_RE =
  `(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:${W_UNIT_RE})(?![A-Za-z]))?` +
  `|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|zero|ten|${W_UNIT_RE})(?![A-Za-z])`;
const W_SCALE_RE = '(?:hundred|thousand|million|billion)(?![A-Za-z])';
const W_SMALL: Record<string, number> = { an: 1, a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, several: 2, many: 2 };

/** Value of a cardinal phrase ("ninety-seven", "two hundred", "a thousand"). */
function cardinalValue(phrase: string): number | null {
  const words = phrase.toLowerCase().split(/[\s-]+/).filter(Boolean);
  let total = 0;
  let cur = 0;
  let any = false;
  for (const w of words) {
    if (w === 'a' || w === 'an') {
      cur = 1;
      continue;
    }
    if (w in W_UNITS) cur += W_UNITS[w]!;
    else if (w in W_TENS) cur += W_TENS[w]!;
    else if (w in W_SCALE) {
      const sc = W_SCALE[w]!;
      total += (cur || 1) * sc;
      cur = 0;
    } else return null;
    any = true;
  }
  return any ? total + cur : null;
}

/**
 * Word-numeral patterns, tried in order at each word start of the plain view: [regex (sticky), kind].
 * - 'magnitude': "an order of magnitude" (x10), "two orders of magnitude" (x100), "orders of magnitude".
 * - 'fold': "a hundredfold", "tenfold", "three-fold", "five fold".
 * - 'halve': "halves", "halved", "halving", "in half", "by half" (a factor of two).
 * - 'half': "half of" (0.5).
 * - 'twice': "twice"/"thrice" before as/the/that/... (a factor).
 * - 'double': "doubles"/"doubled"/"tripled"/"quadruples", "double the" (a factor).
 * - 'card': cardinals ("ninety-seven", "thirty", "two hundred", "a thousand").
 */
/** Cheap pre-test: could the text hold a word numeral at all? */
const WORDISH =
  /(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|teen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|twice|thrice|doubl|tripl|quadrupl|halv|half|fold|magnitude)/i;

const WORD_PATTERNS: Array<[RegExp, string]> = [
  [new RegExp(`(?:(an?|one|two|three|four|five|six|several|many)\\s+)?orders?\\s+of\\s+magnitude(?![A-Za-z])`, 'iy'), 'magnitude'],
  [new RegExp(`(?:an?\\s+)?((?:${W_CARD_RE}\\s*)?${W_SCALE_RE}|${W_CARD_RE})[- ]?fold(?![A-Za-z])`, 'iy'), 'fold'],
  [/(?:hundred|thousand|ten|two|three|four|five|six)fold(?![A-Za-z])/iy, 'fold1'],
  [/(?:halv(?:es|ed|ing)|(?:in|by)\s+half)(?![A-Za-z])/iy, 'halve'],
  [/half\s+of(?![A-Za-z])/iy, 'half'],
  [/(twice|thrice)(?=\s+(?:as|the|that|its|their|this|these|those|what|our|his|her|a|an|than|more|less|fewer|larger|smaller|higher|lower)(?![A-Za-z]))/iy, 'twice'],
  [/(doubl|tripl|quadrupl)(?:es|ed|ing)(?![A-Za-z])/iy, 'double'],
  [/(double|triple)(?=\s+(?:the|its|their|our|that)(?![A-Za-z]))/iy, 'double'],
  [new RegExp(`(?:(?:an?|${W_CARD_RE})\\s+)?${W_SCALE_RE}(?:\\s+(?:and\\s+)?${W_CARD_RE})?|${W_CARD_RE}`, 'iy'), 'card'],
];

/** Physical units recognized after a numeral: [regex (sticky, applied to the plain view), normalized unit]. */
const UNIT_PATTERNS: Array<[RegExp, string]> = [
  [/(?:GeV|MeV|TeV|keV|PeV|eV)\s*\/\s*c\s*\^?\s*\{?2\}?(?![A-Za-z])/y, '@eVc2'],
  [/(?:GeV|MeV|TeV|keV|PeV|eV)\s*\/\s*c(?![A-Za-z])/y, '@eVc'],
  [/(PeV|TeV|GeV|MeV|keV|eV)(?![A-Za-z])/y, '@1'],
  [/(fb|pb|nb|ab|mb|µb|μb)\s*\^\s*\{?\s*[-−]\s*1\s*\}?(?![0-9])/y, '@inv'],
  [/(fb|pb|nb|ab)\s*[-−]\s*1(?![0-9])/y, '@inv'],
  [/\/\s*(fb|pb|nb|ab)(?![A-Za-z])/y, '@slashinv'],
  [/(fb|pb|nb|mb)(?![A-Za-z])/y, '@1'],
  [/(?:µ|μ|\u0002?\s*mu\s*|u)m(?![A-Za-z])/y, 'µm'],
  [/(fm|nm|mm|cm|km)(?![A-Za-z])/y, '@1'],
  [/(?:µ|μ)s(?![A-Za-z])/y, 'µs'],
  [/(fs|ps|ns|ms)(?![A-Za-z])/y, '@1'],
  [/(mrad|µrad|μrad|rad)(?![A-Za-z])/y, '@1'],
  [/(kHz|MHz|GHz|THz|Hz)(?![A-Za-z])/y, '@1'],
  [/(?:°|deg(?:rees?)?(?![A-Za-z]))/y, 'deg'],
  [/(TB|GB|MB|kB|KB|TiB|GiB|MiB)(?![A-Za-z])/y, '@1'],
  [/(?:σ|sigma(?![A-Za-z])|standard deviations?(?![A-Za-z]))/y, 'σ'],
  [/T(?![A-Za-z0-9])/y, 'T'],
  [/m(?![A-Za-z0-9])/y, 'm'],
  [/s(?![A-Za-z0-9])/y, 's'],
];

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}
function isAsciiLetter(c: string | undefined): boolean {
  return c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));
}
function isIdentChar(c: string | undefined): boolean {
  return c !== undefined && (isAsciiLetter(c) || isDigit(c) || c === '_');
}
function isSpaceLike(c: string | undefined): boolean {
  return c === ' ' || c === THIN || c === GO || c === GC;
}

/** Normalize a unit as written in facts or prose ("GeV/c" -> "GeV", "um" -> "µm", "fb-1" -> "fb^-1"). */
export function normalizeUnit(u: string | null | undefined): string {
  if (u === null || u === undefined) return '';
  let s = String(u).trim();
  if (!s) return '';
  s = s.replace(/\$|\\,|~|\{|\}/g, '').replace(/\\mathrm|\\text|\\rm/g, '').replace(/\s+/g, '');
  const low = s.toLowerCase();
  if (low === '%' || low === 'percent' || low === '\\%' || low === 'pct') return '%';
  if (low === 'points' || low === 'point' || low === 'pp' || low === 'percentagepoints' || low === 'percentagepoint' || low === 'p.p.') return 'points';
  s = s.replace(/^\\?(?:mu|micro)/, 'µ').replace(/^μ/, 'µ').replace(/^u(?=m$|s$|rad$)/, 'µ');
  s = s.replace(/\/c\^?2$/, '').replace(/\/c$/, '');
  let m = /^(fb|pb|nb|ab|mb|µb)(?:\^?[-−]1|\^\(-1\))$/.exec(s);
  if (m) return `${m[1]}^-1`;
  m = /^\/(fb|pb|nb|ab)$/.exec(s);
  if (m) return `${m[1]}^-1`;
  if (/^(?:deg|degree|degrees|°)$/i.test(s)) return 'deg';
  if (/^(?:sigma|σ|\\sigma)$/i.test(s)) return 'σ';
  if (/^(?:tesla)$/i.test(s)) return 'T';
  return s;
}

function readUnitAt(s: string, k: number): { unit: string; end: number } | null {
  for (const [re, canon] of UNIT_PATTERNS) {
    re.lastIndex = k;
    const m = re.exec(s);
    if (!m) continue;
    let unit = canon;
    if (canon === '@1') unit = m[1]!;
    else if (canon === '@inv' || canon === '@slashinv') unit = `${m[1]}^-1`;
    else if (canon === '@eVc' || canon === '@eVc2') unit = /^(PeV|TeV|GeV|MeV|keV|eV)/.exec(m[0])![1]!;
    return { unit: normalizeUnit(unit), end: k + m[0].length };
  }
  return null;
}

/** Read the script group starting at plain index `k` (P.s[k] === '^' or '_'). */
function readScript(P: Plain, k: number): { content: string; end: number; kind: number } | null {
  const ch = P.s[k];
  if (ch !== '^' && ch !== '_') return null;
  const kind = ch === '^' ? 1 : 2;
  let e = k + 1;
  let content = '';
  while (e < P.s.length && P.script[e] === kind) {
    const c = P.s[e]!;
    if (c === GC) {
      e++;
      break;
    }
    content += c;
    e++;
  }
  if (e === k + 1) return null;
  return { content, end: e, kind };
}

const MANTISSA_RE = /(?:\d{1,3}(?:,\d{3})+(?![\d])|\d{1,3}(?:\u2009\d{3})+(?![\d])|\d+)(?:\.\d+)?|\.\d+/y;

function precisionOfMantissa(m: string): { decimals: number; sigfigs: number } {
  const clean = m.replace(/[,\u2009\s]|\{,\}|\\,/g, '');
  const dot = clean.indexOf('.');
  const decimals = dot < 0 ? 0 : clean.length - dot - 1;
  let digits = clean.replace('.', '').replace(/^0+/, '');
  if (dot < 0) digits = digits.replace(/0+$/, '');
  return { decimals, sigfigs: Math.max(1, digits.length) };
}

function prevSignificant(P: Plain, k: number, skip: (c: string) => boolean): number {
  let j = k - 1;
  while (j >= 0 && skip(P.s[j]!)) j--;
  return j;
}

function wordBefore(P: Plain, k: number): { word: string; start: number } {
  // skip spaces, '(' '[' and GROUP chars
  let j = k - 1;
  while (j >= 0 && (isSpaceLike(P.s[j]) || P.s[j] === '(' || P.s[j] === '[')) j--;
  if (j >= 0 && P.s[j] === '.') j--;
  const end = j + 1;
  while (j >= 0 && /[A-Za-z]/.test(P.s[j]!)) j--;
  return { word: P.s.slice(j + 1, end), start: j + 1 };
}

const CMP_WORDS: Array<[RegExp, string]> = [
  [/(?:^|[^A-Za-z])(?:at\s+least|no\s+less\s+than|not\s+less\s+than|no\s+fewer\s+than)\s*$/i, '>='],
  [/(?:^|[^A-Za-z])(?:at\s+most|no\s+more\s+than|not\s+more\s+than)\s*$/i, '<='],
  [/(?:^|[^A-Za-z])(?:more\s+than|greater\s+than|larger\s+than|higher\s+than|above|exceeding|exceeds|beyond|over)\s*$/i, '>'],
  [/(?:^|[^A-Za-z])(?:less\s+than|fewer\s+than|smaller\s+than|lower\s+than|below|under|within)\s*$/i, '<'],
];

function comparisonBefore(P: Plain, k: number): string | null {
  let j = k - 1;
  while (j >= 0 && (isSpaceLike(P.s[j]) || P.s[j] === '$')) j--;
  if (j < 0) return null;
  const c = P.s[j]!;
  const c0 = P.s[j - 1];
  if (c === '≥' || (c === '=' && c0 === '>')) return '>=';
  if (c === '≤' || (c === '=' && c0 === '<')) return '<=';
  if (c === '>' && c0 !== '-' && c0 !== '>') return '>';
  if (c === '<' && c0 !== '<') return '<';
  if (c === '≳') return '>~';
  if (c === '≲') return '<~';
  const tail = P.s.slice(Math.max(0, j - 30), j + 1).replace(/[\u0005\u0006\u2009]/g, ' ');
  for (const [re, op] of CMP_WORDS) if (re.test(tail)) return op;
  return null;
}

/** The comparison right before `k` is one of the weak words ("over", "under", "within", "beyond"). */
function weakComparisonBefore(P: Plain, k: number): boolean {
  const tail = P.s.slice(Math.max(0, k - 30), k).replace(/[\u0005\u0006\u2009$]/g, ' ');
  return /(?:^|[^A-Za-z])(?:over|under|within|beyond)\s*$/i.test(tail);
}

type Mk = (pStart: number, pEnd: number, value: number, prec: { decimals: number; sigfigs: number }, exponent: number) => NumeralDetail;

function sigfigsOfInt(v: number): number {
  const d = String(Math.round(Math.abs(v))).replace(/0+$/, '');
  return Math.max(1, d.length);
}

const isWordChar = (c: string | undefined): boolean => c !== undefined && (isAsciiLetter(c) || isDigit(c) || c === '_');

/**
 * Word numerals in the plain view (outside math, scripts and placeholders): cardinals, "percent" after
 * them (classified later), factors ("twice", "halves", "a hundredfold", "three-fold", "an order of
 * magnitude") and "half of". Compound adjectives ("two-step", "one-sentence") and ordinals are skipped.
 */
function wordNumerals(P: Plain, mk: Mk): NumeralDetail[] {
  const s = P.s;
  const out: NumeralDetail[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (!isAsciiLetter(c) || isWordChar(s[i - 1]) || s[i - 1] === '-' || P.math[i] || P.script[i] || P.placeholder[i]) {
      i++;
      continue;
    }
    let hit: { end: number; value: number; factor: boolean; phrase: string } | null = null;
    for (const [re, kind] of WORD_PATTERNS) {
      re.lastIndex = i;
      const m = re.exec(s);
      if (!m) continue;
      const whole = m[0];
      const phrase = whole.toLowerCase().replace(/\s+/g, ' ').replace(/^an? /, '');
      let value: number | null = null;
      let factor = true;
      let end = i + whole.length;
      switch (kind) {
        case 'magnitude': {
          const n = m[1] ? (W_SMALL[m[1].toLowerCase()] ?? 1) : /orders/i.test(whole) ? 2 : 1;
          value = Math.pow(10, n);
          break;
        }
        case 'fold':
          value = cardinalValue(m[1]!);
          break;
        case 'fold1':
          value = cardinalValue(whole.replace(/fold$/i, ''));
          break;
        case 'halve':
          value = 2;
          break;
        case 'half':
          // "more than half of its hits" is a criterion (a definition), not a result
          value = comparisonBefore(P, i) ? null : 0.5;
          factor = false;
          end = i + 4; // "half"; "of" stays outside the replaced span
          break;
        case 'twice':
          value = m[1]!.toLowerCase() === 'twice' ? 2 : 3;
          break;
        case 'double': {
          const r = m[1]!.toLowerCase();
          value = r.startsWith('doubl') ? 2 : r.startsWith('tripl') ? 3 : 4;
          break;
        }
        default: {
          factor = false;
          // a bare scale word ("1.5 million", "2 thousand") is a multiplier of a digit numeral, read there
          value = /^(?:hundred|thousand|million|billion)/i.test(whole) ? null : cardinalValue(whole);
          // compound adjectives and nouns: "two-step", "one-sentence", "three-body" (not "five-sigma")
          const after = s.slice(end, end + 12);
          if (/^-[A-Za-z]/.test(after) && !/^-(?:fold|sigma|percent|times|point|points)(?![A-Za-z])/i.test(after)) value = null;
          // "one" as a pronoun ("one of", "no one", "one can") is never a quantity
          if (value === 1 && /^one$/i.test(whole)) {
            const prevWord = /([A-Za-z]+)[\s\u2009]*$/.exec(s.slice(Math.max(0, i - 12), i))?.[1]?.toLowerCase() ?? '';
            const nextWord = /^[\s\u2009]*([A-Za-z]+)/.exec(after)?.[1]?.toLowerCase() ?? '';
            if (['no', 'the', 'this', 'that', 'each', 'every', 'any', 'which', 'some'].includes(prevWord)) value = null;
            if (['another', 'can', 'may', 'might', 'could', 'would', 'should', 'must', 'finds', 'gets', 'sees', 'obtains', 'expects', 'has', 'needs'].includes(nextWord)) value = null;
          }
        }
      }
      if (value === null || !Number.isFinite(value)) {
        // skip the whole word so its parts are not read again
        hit = null;
        let e = end;
        while (e < s.length && (isAsciiLetter(s[e]) || s[e] === '-')) e++;
        i = e;
        break;
      }
      hit = { end, value, factor, phrase: kind === 'half' ? 'half' : phrase };
      break;
    }
    if (hit) {
      const frac = hit.value > 0 && hit.value < 1;
      const tok = mk(i, hit.end, hit.value, { decimals: frac ? 1 : 0, sigfigs: frac ? 1 : sigfigsOfInt(hit.value) }, 0);
      tok.word = true;
      tok.phrase = hit.phrase;
      tok.factor = hit.factor;
      out.push(tok);
      i = hit.end;
      continue;
    }
    // advance to the end of this word
    if (isAsciiLetter(s[i])) {
      while (i < s.length && isWordChar(s[i])) i++;
    } else i++;
  }
  return out;
}

/** Classification of a word numeral: "percent"/"points"/"times"/a unit after it, "a factor of", a comparison. */
function classifyWord(P: Plain, tok: NumeralDetail): void {
  const s = P.s;
  let k = tok.pEnd;
  while (k < s.length && isSpaceLike(s[k])) k++;
  const rest = s.slice(k, k + 40);
  let m: RegExpExecArray | null;
  if (!tok.factor) {
    if ((m = /^(?:%|-?(?:per\s?cent|percent)(?![A-Za-z]))/i.exec(rest))) {
      tok.percent = true;
      tok.phrase += ' percent';
      tok.replEnd = Math.max(tok.replEnd, P.b[k + m[0].length - 1] ?? tok.replEnd);
    } else if ((m = /^(?:percentage[\s-]+points?|points?)(?![A-Za-z])/i.exec(rest)) && tok.value > 10) {
      // "ninety points": "five points" is too often a count of points
      tok.points = true;
      tok.phrase += ' points';
    } else if ((m = /^(?:times|[-\s]?fold)(?![A-Za-z])/i.exec(rest))) {
      tok.factor = true;
      tok.phrase += ' times';
    } else {
      let ku = k;
      if (s[ku] === '-' && /[A-Za-zµμ°σ]/.test(s[ku + 1] ?? '')) ku++;
      const u = readUnitAt(s, ku);
      if (u && !/^[msT]$/.test(u.unit)) tok.unit = u.unit;
    }
  }
  if (!tok.factor && /factor\s+of\s*$/i.test(s.slice(Math.max(0, tok.pStart - 16), tok.pStart).replace(/[\u0005\u0006\u2009]/g, ' '))) {
    tok.factor = true;
    tok.phrase = `factor of ${tok.phrase}`;
  }
  tok.comparison = comparisonBefore(P, tok.pStart);
  if (tok.comparison) tok.weakComparison = weakComparisonBefore(P, tok.pStart);
}

/**
 * Extract detailed numeral tokens. Never throws (returns [] on pathological input).
 */
export function extractNumeralDetails(input: string): NumeralDetail[] {
  const text = typeof input === 'string' ? input : String(input ?? '');
  if (!/[0-9]/.test(text) && !WORDISH.test(text)) return [];
  let P: Plain;
  try {
    P = buildPlain(text);
  } catch {
    return [];
  }
  const s = P.s;
  const L = s.length;
  const toks: NumeralDetail[] = [];
  const srcStart = (p: number): number => P.a[p] ?? text.length;
  const srcEnd = (p: number): number => P.b[p - 1] ?? text.length;

  const mk = (pStart: number, pEnd: number, value: number, prec: { decimals: number; sigfigs: number }, exponent: number): NumeralDetail => {
    const start = srcStart(pStart);
    const end = Math.max(start, srcEnd(pEnd));
    return {
      start,
      end,
      raw: text.slice(start, end),
      value,
      decimals: prec.decimals,
      sigfigs: prec.sigfigs,
      percent: false,
      points: false,
      unit: null,
      isUncertainty: false,
      inMath: !!P.math[pStart],
      structural: false,
      exponent,
      factor: false,
      comparison: null,
      ordinal: false,
      negative: false,
      uncertaintyOf: -1,
      replStart: start,
      replEnd: end,
      pStart,
      pEnd,
      pAfter: pEnd,
      word: false,
      phrase: '',
      ratioDen: null,
      ratioPart: false,
      smallCount: false,
      weakComparison: false,
    };
  };

  let p = 0;
  while (p < L) {
    const ch = s[p]!;
    const startsNum = isDigit(ch) || (ch === '.' && isDigit(s[p + 1]) && !isDigit(s[p - 1]));
    if (!startsNum || P.script[p] || P.placeholder[p]) {
      p++;
      continue;
    }
    // identifiers: digits glued to letters / underscores before (`T1`, `eff_s0`, `H2`)
    if (isIdentChar(s[p - 1]) || (s[p - 1] === '.' && isIdentChar(s[p - 2]))) {
      while (p < L && (isIdentChar(s[p]) || (s[p] === '.' && isIdentChar(s[p + 1])))) p++;
      continue;
    }
    // ISO dates: 2026-10-03
    const date = /\d{4}-\d{2}-\d{2}(?![\d])/y;
    date.lastIndex = p;
    if (date.exec(s)) {
      const t = mk(p, p + 10, Number(s.slice(p, p + 4)), { decimals: 0, sigfigs: 4 }, 0);
      t.structural = true;
      toks.push(t);
      p += 10;
      continue;
    }
    MANTISSA_RE.lastIndex = p;
    const mm = MANTISSA_RE.exec(s);
    if (!mm) {
      p++;
      continue;
    }
    const mant = mm[0];
    let q = p + mant.length;
    // version strings and dotted identifiers: 1.2.3, 10.1103/...
    if (s[q] === '.' && isDigit(s[q + 1])) {
      while (q < L && (isDigit(s[q]) || s[q] === '.' || isAsciiLetter(s[q]))) q++;
      p = q;
      continue;
    }
    const mantValue = Number(mant.replace(/[,\u2009]/g, ''));
    if (!Number.isFinite(mantValue)) {
      p = q;
      continue;
    }
    let prec = precisionOfMantissa(mant);
    let exponent = 0;
    let value = mantValue;
    let pEnd = q;
    // e-notation glued: 1.2e-4
    const eRe = /[eE]([+\-−]?)(\d+)(?![A-Za-z0-9])/y;
    eRe.lastIndex = q;
    const em = eRe.exec(s);
    if (em) {
      exponent = (em[1] === '-' || em[1] === '−' ? -1 : 1) * Number(em[2]);
      pEnd = q + em[0].length;
    } else {
      // scientific: <mantissa> × 10^{e}
      let r = q;
      while (r < L && isSpaceLike(s[r])) r++;
      if (s[r] === '×' || s[r] === '·' || (s[r] === 'x' && !isAsciiLetter(s[r + 1]))) {
        let r2 = r + 1;
        while (r2 < L && isSpaceLike(s[r2])) r2++;
        if (s[r2] === '1' && s[r2 + 1] === '0' && !isDigit(s[r2 + 2])) {
          let r3 = r2 + 2;
          while (r3 < L && s[r3] === ' ') r3++;
          const sc = readScript(P, r3);
          const em2 = sc && sc.kind === 1 ? /^\s*([+\-−]?)\s*(\d+)\s*$/.exec(sc.content) : null;
          if (sc && em2) {
            exponent = (em2[1] === '-' || em2[1] === '−' ? -1 : 1) * Number(em2[2]);
            pEnd = sc.end;
          }
        }
      } else if (mant === '10') {
        // pure power of ten: 10^8, 10^{-3}
        let r3 = q;
        while (r3 < L && s[r3] === ' ') r3++;
        const sc = readScript(P, r3);
        const em2 = sc && sc.kind === 1 ? /^\s*([+\-−]?)\s*(\d+)\s*$/.exec(sc.content) : null;
        if (sc && em2 && sc.content.trim()[0] !== '+') {
          exponent = (em2[1] === '-' || em2[1] === '−' ? -1 : 1) * Number(em2[2]);
          value = 1;
          prec = { decimals: 0, sigfigs: 1 };
          pEnd = sc.end;
        }
      }
    }
    value = exponent ? Number((value * Math.pow(10, exponent)).toPrecision(15)) : value;
    const tok = mk(p, pEnd, value, prec, exponent);
    const baseIndex = toks.length;
    toks.push(tok);
    // attached uncertainties: compact 2.32(28) and asymmetric ^{+0.3}_{-0.2}
    let after = pEnd;
    const compact = /\((\d{1,3})\)/y;
    compact.lastIndex = after;
    const cm = exponent === 0 && prec.decimals > 0 ? compact.exec(s) : null;
    if (cm) {
      const digits = cm[1]!;
      const u = mk(after + 1, after + 1 + digits.length, Number(digits) / Math.pow(10, prec.decimals), { decimals: prec.decimals, sigfigs: precisionOfMantissa(digits).sigfigs }, 0);
      u.isUncertainty = true;
      u.uncertaintyOf = baseIndex;
      toks.push(u);
      after += cm[0].length;
    } else {
      for (let guard = 0; guard < 2; guard++) {
        const sc = readScript(P, after);
        if (!sc) break;
        const um = /^\s*([+\-−])\s*(\d+(?:\.\d+)?|\.\d+)\s*$/.exec(sc.content);
        if (!um) break;
        // locate the digits inside the script in the plain view
        let d0 = after + 1;
        while (d0 < sc.end && !isDigit(s[d0]) && s[d0] !== '.') d0++;
        const d1 = d0 + um[2]!.length;
        const u = mk(d0, d1, Number(um[2]), precisionOfMantissa(um[2]!), 0);
        u.isUncertainty = true;
        u.uncertaintyOf = baseIndex;
        toks.push(u);
        after = sc.end;
      }
    }
    tok.pAfter = after;
    p = Math.max(after, pEnd);
  }

  // ------------------------------------------------------------------ word numerals
  {
    const words = wordNumerals(P, mk);
    if (words.length) {
      const all = [...toks.map((tk, i) => ({ tk, i })), ...words.map((tk) => ({ tk, i: -1 }))];
      all.sort((x, y) => x.tk.pStart - y.tk.pStart || x.tk.pEnd - y.tk.pEnd);
      const at = new Map<number, number>();
      all.forEach((x, k) => {
        if (x.i >= 0) at.set(x.i, k);
      });
      const merged = all.map((x) => x.tk);
      for (const tk of merged) if (tk.uncertaintyOf >= 0) tk.uncertaintyOf = at.get(tk.uncertaintyOf) ?? -1;
      toks.length = 0;
      toks.push(...merged);
    }
  }

  // ------------------------------------------------------------------ classification
  for (let t = 0; t < toks.length; t++) {
    const tok = toks[t]!;
    if (tok.structural) continue; // dates
    if (tok.word) {
      classifyWord(P, tok);
      continue;
    }
    // glued letters after the numeral: unit, ordinal, factor 'x', or an identifier (3D, 10K, 13a)
    const nextC = s[tok.pEnd];
    const glued = tok.pAfter === tok.pEnd && isAsciiLetter(nextC);
    // negative sign
    const sp = tok.pStart - 1;
    if (tok.uncertaintyOf < 0 && (s[sp] === '-' || s[sp] === '−') && s[sp - 1] !== '-') {
      let unary: boolean;
      if (P.math[sp]) {
        const j = prevSignificant(P, sp, (c) => c === ' ' || c === THIN);
        const pc = j >= 0 ? s[j]! : '';
        unary = j < 0 || !P.math[j] || '=(,;:<>≤≥≈∼±[|'.includes(pc) || pc === GO || pc === MACRO;
      } else {
        const pc = s[sp - 1];
        unary = pc === undefined || pc === ' ' || pc === '(' || pc === GO || pc === '[' || pc === '$' || (P.math[sp - 1] ?? false) !== P.math[sp];
      }
      if (unary) {
        tok.negative = true;
        tok.value = -tok.value;
        tok.start = P.a[sp] ?? tok.start;
        tok.raw = text.slice(tok.start, tok.end);
        tok.replStart = tok.start;
      }
    }
    // uncertainty (±)
    if (tok.uncertaintyOf < 0) {
      const j = prevSignificant(P, tok.negative ? sp : tok.pStart, (c) => isSpaceLike(c) || c === '$');
      const pc = s[j];
      if (pc === '±' || pc === '∓' || (pc === '-' && s[j - 1] === '+') || (pc === '/' && s[j - 1] === '-' && s[j - 2] === '+')) {
        tok.isUncertainty = true;
        // find the value it belongs to: previous token (or previous uncertainty's value)
        if (t > 0) {
          const prev = toks[t - 1]!;
          tok.uncertaintyOf = prev.uncertaintyOf >= 0 ? prev.uncertaintyOf : t - 1;
        }
      }
    }
    // forward: percent / points / units / factor / ordinal
    let k = tok.pAfter;
    while (k < L && isSpaceLike(s[k])) k++;
    if (s[k] === ')' && (tok.isUncertainty || s[tok.pStart - 1] === '(' || (tok.negative && s[tok.pStart - 2] === '('))) {
      k++;
      while (k < L && isSpaceLike(s[k])) k++;
    }
    let rest = s.slice(k, k + 40);
    let consumedEnd = -1;
    let m: RegExpExecArray | null;
    let multiplied = false;
    const mult = glued ? /^([kKM])(?![A-Za-z0-9])/.exec(rest) : /^(thousand|million|billion|trillion)(?![A-Za-z])/i.exec(rest);
    if (mult) {
      const w = mult[1]!.toLowerCase();
      const e = w === 'k' || w === 'thousand' ? 3 : w === 'm' || w === 'million' ? 6 : w === 'billion' ? 9 : 12;
      tok.exponent += e;
      tok.value = Number((tok.value * Math.pow(10, e)).toPrecision(15));
      multiplied = true;
      k += mult[0].length;
      while (k < L && isSpaceLike(s[k])) k++;
      rest = s.slice(k, k + 40);
    }
    if ((m = /^(?:个)?百分点/.exec(rest))) {
      tok.points = true;
    } else if ((m = /^[％]/.exec(rest))) {
      tok.percent = true;
    } else if ((m = /^倍/.exec(rest))) {
      tok.factor = true;
    } else if ((m = /^(?:%|‰)/.exec(rest))) {
      tok.percent = m[0] === '%';
      consumedEnd = k + m[0].length;
      const r2 = s.slice(consumedEnd, consumedEnd + 64).replace(/^[\s\u2009\u0005\u0006-]+/, '');
      if (/^points?(?![A-Za-z])/i.test(r2)) {
        tok.percent = false;
        tok.points = true;
      }
    } else if ((m = /^-?(?:per\s?cent|percent)(?![A-Za-z])/i.exec(rest))) {
      tok.percent = true;
    } else if ((m = /^(?:percentage[\s-]+points?|points?|pp|p\.p\.)(?![A-Za-z])/i.exec(rest))) {
      tok.points = true;
    } else if ((m = /^(?:times(?![A-Za-z])|[-\s]?fold(?![A-Za-z])|×(?!\s*10\s*\^)|x(?![A-Za-z0-9]))/.exec(rest))) {
      tok.factor = true;
    } else if (/^(?:st|nd|rd|th)(?![A-Za-z])/.test(rest) && tok.decimals === 0 && tok.exponent === 0 && (glued || s[k] === '^')) {
      tok.ordinal = true;
    } else if (s[k] === '^' && tok.decimals === 0) {
      const sc = readScript(P, k);
      if (sc && /^\s*(?:\u0002)?\s*(?:st|nd|rd|th)\s*$/.test(sc.content.replace(/[\u0005\u0006]/g, ''))) tok.ordinal = true;
    } else {
      let ku = k;
      if (s[ku] === '-' && /[A-Za-zµμ°σ]/.test(s[ku + 1] ?? '')) ku++;
      const u = readUnitAt(s, ku);
      // single-letter units (m, s, T) never glue: "1990s" is a decade, not seconds
      if (u && !(glued && /^[msT]$/.test(u.unit))) tok.unit = u.unit;
    }
    if (glued && !multiplied && !tok.unit && !tok.ordinal && !tok.factor && !tok.percent && !tok.points) {
      tok.structural = true; // identifier-like (3D, 10K, 13a): never a prose number
      (tok as NumeralDetail & { identifier?: boolean }).identifier = true;
    }
    // replacement span: include an attached percent sign
    if (tok.percent && consumedEnd > 0) tok.replEnd = Math.max(tok.replEnd, P.b[consumedEnd - 1] ?? tok.replEnd);
    if (P.cmd[tok.pStart]) {
      const span = P.cmd[tok.pStart]!;
      tok.replStart = span[0];
      tok.replEnd = span[1];
    }
    // factor written before: "a factor of 2.4", "factor 2"
    if (!tok.factor && /factor(?:\s+of)?\s*$/i.test(s.slice(Math.max(0, tok.pStart - 16), tok.pStart).replace(/[\u0005\u0006\u2009]/g, ' '))) tok.factor = true;
    tok.comparison = tok.isUncertainty ? null : comparisonBefore(P, tok.negative ? sp : tok.pStart);
    if (tok.comparison) tok.weakComparison = weakComparisonBefore(P, tok.negative ? sp : tok.pStart);
  }
  // drop identifier pseudo-tokens
  const kept: NumeralDetail[] = [];
  const remap = new Map<number, number>();
  toks.forEach((tk, idx) => {
    if ((tk as NumeralDetail & { identifier?: boolean }).identifier) return;
    remap.set(idx, kept.length);
    kept.push(tk);
  });
  for (const tk of kept) {
    if (tk.uncertaintyOf >= 0) tk.uncertaintyOf = remap.get(tk.uncertaintyOf) ?? -1;
    delete (tk as NumeralDetail & { identifier?: boolean }).identifier;
  }

  // ------------------------------------------------------------------ inheritance
  for (let t = kept.length - 1; t >= 0; t--) {
    const u = kept[t]!;
    if (u.uncertaintyOf < 0) continue;
    const base = kept[u.uncertaintyOf];
    if (!base) continue;
    // `a ± b unit`: the unit written after the uncertainty applies to the value (and earlier uncertainties)
    if (!base.percent && !base.points && !base.unit && (u.percent || u.points || u.unit)) {
      base.percent = u.percent;
      base.points = u.points;
      base.unit = u.unit;
      for (let k = u.uncertaintyOf + 1; k < t; k++) {
        const o = kept[k]!;
        if (o.uncertaintyOf === u.uncertaintyOf && !o.percent && !o.points && !o.unit) {
          o.percent = u.percent;
          o.points = u.points;
          o.unit = u.unit;
        }
      }
    }
    // compact / asymmetric uncertainties carry the value's unit
    if (!u.percent && !u.points && !u.unit) {
      u.percent = base.percent;
      u.points = base.points;
      u.unit = base.unit;
    }
  }
  // ranges: "20--30\%", "1 to 5 GeV"
  for (let t = 0; t + 1 < kept.length; t++) {
    const a = kept[t]!;
    const b = kept[t + 1]!;
    if (a.percent || a.points || a.unit || a.isUncertainty || b.isUncertainty) continue;
    if (!(b.percent || b.points || b.unit)) continue;
    const between = s.slice(a.pAfter, b.negative ? b.pStart - 1 : b.pStart).replace(/[\s\u2009\u0005\u0006$]/g, '');
    if (/^(?:-|--|–|—|to|and|or)$/i.test(between)) {
      a.percent = b.percent;
      a.points = b.points;
      a.unit = b.unit;
    }
  }

  // ------------------------------------------------------------------ ratios: "9 out of 10", "one in ten", "2 of 3"
  for (let t = 0; t + 1 < kept.length; t++) {
    const a = kept[t]!;
    const b = kept[t + 1]!;
    const intLike = (x: NumeralDetail): boolean =>
      !x.structural && x.decimals === 0 && x.exponent === 0 && !x.percent && !x.points && !x.unit && !x.isUncertainty && !x.factor && !x.negative && x.uncertaintyOf < 0 && Number.isInteger(x.value);
    if (!intLike(a) || !intLike(b) || !(b.value > a.value) || b.value < 2) continue;
    const between = s.slice(a.pAfter, b.pStart).replace(/[\s\u2009\u0005\u0006~$]+/g, ' ').trim().toLowerCase();
    const ok = between === 'out of' || between === 'in' || between === 'per' || (between === 'of' && !a.word && !b.word);
    if (!ok) continue;
    a.ratioDen = b.value;
    a.end = b.end;
    a.raw = text.slice(a.start, a.end);
    a.replEnd = Math.max(a.replEnd, b.replEnd);
    a.pAfter = b.pAfter;
    if (a.word) a.phrase = `${a.phrase} ${between} ${b.phrase || b.raw}`;
    b.structural = true;
    b.ratioPart = true;
    t++;
  }

  // ------------------------------------------------------------------ structural
  for (let t = 0; t < kept.length; t++) {
    const tok = kept[t]!;
    if (tok.structural) continue;
    // a ratio stands for a result ("9 out of 10 fake tracks"): always checked
    if (tok.ratioDen !== null) continue;
    const isInt = tok.decimals === 0 && tok.exponent === 0 && !/[,\u2009]/.test(s.slice(tok.pStart, tok.pEnd));
    const plainInt = isInt && !tok.percent && !tok.points && !tok.unit && !tok.isUncertainty && !tok.factor;
    const followedByPm = (() => {
      const nt = kept[t + 1];
      return !!nt && nt.uncertaintyOf === t;
    })();
    if (tok.ordinal) {
      tok.structural = true;
      continue;
    }
    // "Sec. 3", "Fig.~2", "Eq.~(4)", "Table 2", "Ref.~[12]"
    const wb = wordBefore(P, tok.negative ? tok.pStart - 1 : tok.pStart);
    if (STRUCT_WORDS.has(wb.word.toLowerCase()) && !tok.percent && !tok.points && !tok.unit && !tok.isUncertainty && !followedByPm && !tok.factor) {
      // words that are also ordinary lowercase words ("we run 100 toys", "in this case 30") count only capitalized
      const capitalOnly = CAPITAL_ONLY.has(wb.word.toLowerCase());
      if (!capitalOnly || /^[A-Z]/.test(wb.word)) {
        tok.structural = true;
        continue;
      }
    }
    // chains: "Secs. 2 and 3", "Figs. 2--4", "Eqs. (3)-(5)"
    if (t > 0 && plainInt) {
      const prev = kept[t - 1]!;
      const nextWord = /^[\s\u2009\u0005\u0006]*([A-Za-z]+)/.exec(s.slice(tok.pEnd, tok.pEnd + 30))?.[1] ?? '';
      if (prev.structural && !prev.ordinal && !COUNTED_NOUN.test(nextWord) && (tok.value <= 99 || !/^[a-z]/.test(nextWord))) {
        const between = s.slice(prev.pAfter, tok.pStart).replace(/[\s\u2009\u0005\u0006()]/g, '');
        if (/^(?:,|-|--|–|—|and|or|to|&|,and)?$/i.test(between)) {
          tok.structural = true;
          continue;
        }
      }
    }
    // arXiv identifiers
    if (/arxiv:\s*$/i.test(s.slice(Math.max(0, tok.pStart - 8), tok.pStart))) {
      tok.structural = true;
      continue;
    }
    // years next to a citation or after "in", "since" ...
    if (plainInt && !tok.negative && tok.value >= 1900 && tok.value <= 2099) {
      let j = tok.pEnd;
      while (j < L && (isSpaceLike(s[j]) || s[j] === ',' || s[j] === ';' || s[j] === ')' || s[j] === ']')) j++;
      const nextCite = s[j] === CITE;
      const pj = prevSignificant(P, tok.pStart, (c) => isSpaceLike(c) || c === '(' || c === ',' || c === ';');
      const prevCite = s[pj] === CITE;
      const before = s.slice(Math.max(0, tok.pStart - 16), tok.pStart).replace(/[\u0005\u0006\u2009]/g, ' ');
      const authorYear = /al\.?\s*[,(]?\s*$/.test(before);
      // "in 2024 events" is a count, not a year
      const nextWord = /^[\s\u2009\u0005\u0006]*([A-Za-z]+)/.exec(s.slice(tok.pEnd, tok.pEnd + 30))?.[1] ?? '';
      const countedNoun = COUNTED_NOUN.test(nextWord);
      if (nextCite || prevCite || authorYear || (YEAR_WORDS.has(wb.word.toLowerCase()) && !countedNoun)) {
        tok.structural = true;
        continue;
      }
    }
    // list markers: (1), (2), 1) at the start
    if (isInt && tok.value <= 20 && !tok.negative) {
      const pc = s[tok.pStart - 1];
      const nc = s[tok.pEnd];
      if (pc === '(' && nc === ')' && !tok.percent && !tok.unit) {
        tok.structural = true;
        continue;
      }
      // only blanks before the numeral (stops at the first non-blank; the old replace copied the whole prefix per numeral)
      if (/^[\s\u0005\u0006]*$/.test(s.slice(0, tok.pStart)) && (nc === ')' || nc === '.') && s[tok.pEnd + 1] === ' ') {
        tok.structural = true;
        continue;
      }
    }
    // bare small integers 0-10
    if (plainInt && !tok.negative && !followedByPm && tok.value >= 0 && tok.value <= 10) {
      // after a comparison ("at least 3 space points", "$|\eta| < 2$") it is a cut and must match one;
      // "averaged over 3 seeds" (a weak comparison word) and "at least one" in words stay structural
      if (tok.comparison && !tok.weakComparison && !(tok.word && tok.value < 2)) continue;
      tok.structural = true;
      // "8 GPUs", "3 fake tracks": a count of something that is not structure (checked in ghost/draft)
      // ("Phase-2 upgrade", "Run-3 data" are names, not counts)
      if (!tok.word && !(s[tok.pStart - 1] === '-' && isAsciiLetter(s[tok.pStart - 2]))) {
        const nm = /^[\s\u2009\u0005\u0006~]*([A-Za-z][A-Za-z-]*)(?:[\s\u2009\u0005\u0006~]+([A-Za-z][A-Za-z-]*))?/.exec(s.slice(tok.pAfter, tok.pAfter + 60));
        const w1 = nm?.[1]?.toLowerCase() ?? '';
        const w2 = nm?.[2]?.toLowerCase() ?? '';
        if (w1 && !NON_NOUN.has(w1) && !COUNTABLE.has(w1) && !COUNTABLE.has(w2)) tok.smallCount = true;
      }
      continue;
    }
  }
  return kept;
}

/** Public token shape (drops internal fields). */
export function toPublicToken(d: NumeralDetail): NumeralToken {
  return {
    start: d.start,
    end: d.end,
    raw: d.raw,
    value: d.value,
    decimals: d.decimals,
    sigfigs: d.sigfigs,
    percent: d.percent,
    points: d.points,
    unit: d.unit,
    isUncertainty: d.isUncertainty,
    inMath: d.inMath,
    structural: d.structural,
  };
}

export { precisionOfMantissa };
