/**
 * Style features, a scaled style distance, and the sentences that pull a set furthest from a target
 * (docs/design.md, "Style-distance meter"). Heuristics only, no NLP dependency.
 *
 * Tokenization follows style_check.py: whitespace tokens that contain a letter or digit (or a Greek letter or
 * µ), stripped of edge punctuation. Word lists, the finite-verb test and the passive detector are ported from
 * the skill's style_check.py (data/styleCheckLists.ts), so the meter and the sidecar linter agree.
 */
import { excessHits } from './aiese';
import * as L from './data/styleCheckLists';

export interface StyleFeatures {
  n: number;
  medianLen: number;
  p90Len: number;
  /** Median position of the first finite verb (heuristic verb list). */
  verbPos: number;
  passiveShare: number;
  /** we/our/us per 1,000 words. */
  weRate: number;
  hedgeRate: number;
  intensifierRate: number;
  /** Sentences opening with Moreover/Furthermore/Additionally/... per 1,000 words. */
  connectorOpenerRate: number;
  /** Inflated words (utilize, leverage, ...) per 1,000 words. */
  inflatedRate: number;
  /** AI-ese excess vocabulary per 1,000 words. */
  excessVocabRate: number;
  /** Type-token ratio on the first 1,000 words. */
  ttr: number;
  lenStd: number;
  /** Em/en dashes used as punctuation per 1,000 words. */
  dashRate: number;
  /**
   * Number of words the features were measured on (added; optional so older stored feature records stay
   * valid). styleDistance uses it for the sampling noise of rates; without it, n x medianLen is used.
   */
  words?: number;
}

/**
 * The skill's measured five-paper norms (SKILL.md principle 5 and references/sentences-and-words.md):
 * median 23 words, p90 41, verb at median word 5, passive 35% of prose sentences, we 13.6/1k,
 * hedges 3.8/1k, intensifiers 2.1/1k, connector openers ~0.6/1k (4 of 672 sentences), semicolons 2.2/1k,
 * dashes 0.3/1k. Fields the skill does not measure use neutral values documented in the code.
 *
 * Unmeasured fields: inflatedRate 0.2 (SKILL.md: plain verbs vs utilize/leverage 462 vs 5 in 25,027 words);
 * excessVocabRate 0.5 (neutral; the skill does not run the Kobak list); ttr 0.45 (typical of English technical
 * prose at 1,000 words); lenStd 11 (implied by a median of 23, a mean of 25.4 and a p90 of 41 with a
 * right-skewed length distribution). words: 25,027 prose words (sentences-and-words.md, Conventions).
 */
export const SKILL_CORPUS_NORMS: StyleFeatures = {
  n: 985, medianLen: 23, p90Len: 41, verbPos: 5, passiveShare: 0.352, weRate: 13.6, hedgeRate: 3.8,
  intensifierRate: 2.1, connectorOpenerRate: 0.6, inflatedRate: 0.2, excessVocabRate: 0.5, ttr: 0.45, lenStd: 11, dashRate: 0.3,
  words: 25027,
};

/* ------------------------------------------------------------------------------------ */
/* Hedges (this project's list)                                                          */
/* ------------------------------------------------------------------------------------ */

/**
 * Hedge words. The skill reports a rate (3.8 per 1,000 words; "only 6 of 68 modal hedges touch a paper's own
 * result", sentences-and-words.md SENTENCES-8) but style_check.py ships no hedge list, so this list is ours:
 * the modals and adverbs SENTENCES-8 names (*may, could, likely*), their usual companions, and the
 * reading verbs (*suggests*, *appears to*, *seems*).
 */
export const HEDGE_RE =
  /\b(?:may|might|could|likely|unlikely|possibly|perhaps|potentially|presumably|probably|arguably|apparently|seemingly|conceivably|seems?|seemed|suggests?|suggested|suggesting|appears? to|appeared to|tends? to|tended to)\b/gi;

/* ------------------------------------------------------------------------------------ */
/* Per-sentence analysis                                                                 */
/* ------------------------------------------------------------------------------------ */

const isAlpha = (w: string): boolean => /^\p{L}+$/u.test(w);
const TOKEN_KEEP = /[A-Za-z0-9µͰ-Ͽ]/;

function stripPunct(t: string): string {
  let a = 0;
  let b = t.length;
  while (a < b && L.PUNCT.includes(t[a]!)) a++;
  while (b > a && L.PUNCT.includes(t[b - 1]!)) b--;
  return t.slice(a, b);
}

/** style_check.py `inflect`: base, 3rd person and past forms (no -ing: gerunds are not finite). */
function inflect(base: string): string[] {
  const forms = [base];
  if (/(?:s|sh|ch|x|z|o)$/.test(base)) forms.push(base + 'es');
  else if (/[^aeiou]y$/.test(base)) forms.push(base.slice(0, -1) + 'ies');
  else forms.push(base + 's');
  if (base.endsWith('e')) forms.push(base + 'd');
  else if (/[^aeiou]y$/.test(base)) forms.push(base.slice(0, -1) + 'ied');
  else {
    forms.push(base + 'ed');
    if (L.DOUBLE_FINAL.has(base)) forms.push(base + base[base.length - 1] + 'ed');
  }
  return forms;
}

const FORM_BASE: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const b of L.VERB_BASES) for (const f of inflect(b)) if (!m.has(f)) m.set(f, b);
  for (const f of L.IRREG_PAST) if (!m.has(f)) m.set(f, f);
  return m;
})();

const endsWithAny = (w: string, ends: readonly string[]): boolean => ends.some((e) => w.endsWith(e));

function nounish(w: string): boolean {
  return isAlpha(w) && w.length >= 3 && !L.FW.has(w) && !L.AUX.has(w) && !w.endsWith('ly') && !L.PRONOUNS.has(w) && !L.SUBORD.has(w);
}

/** style_check.py `is_finite`: generous test for a finite verb at position j (says yes when unsure). */
function isFiniteVerb(low: string[], j: number): boolean {
  const w = low[j]!;
  const prev = j > 0 ? low[j - 1]! : '';
  const prev2 = j > 1 ? low[j - 2]! : '';
  const nxt = j + 1 < low.length ? low[j + 1]! : '';
  if (L.AUX.has(w)) return !(prev === 'to' && (w === 'have' || w === 'do'));
  let base = FORM_BASE.get(w);
  if (base === undefined) {
    if (!isAlpha(w) || L.FW.has(w) || L.SUBORD.has(w)) return false;
    if (L.MORPH_VERB_RE.test(w) && !L.NOT_PART.has(w)) base = w;
    else if (
      w.endsWith('s') && w.length >= 4 && !endsWithAny(w, L.NOUN_S_ENDINGS) && !L.CLAUSE_START.has(prev) && j > 0 &&
      !endsWithAny(prev, L.ADJ_ENDINGS) && (L.AFTER_VERB.has(nxt) || nxt.endsWith('ly') || !nxt)
    ) base = w;
    else if (w.endsWith('ed') && w.length >= 5 && !L.NOT_PART.has(w) && (L.AFTER_VERB.has(nxt) || nxt.endsWith('ly'))) base = w;
    else return false;
  }
  const noun = L.NOUN_BASES.has(base) || (base === w && w.endsWith('s'));
  if (prev === 'to') return false;
  if (noun && w !== base && w.endsWith('s') && prev.length > 3 && endsWithAny(prev, L.ADJ_ENDINGS)) return false;
  if (L.DETS.has(prev)) return j === 1 && ['this', 'these', 'that', 'those'].includes(prev) && !noun && !w.endsWith('ed');
  if (L.PREPS.has(prev)) return w.endsWith('s') && !noun && !w.endsWith('ed');
  if (L.NUMWORDS.has(prev) || /^\d/.test(prev) || prev === '0') {
    if (L.LABEL_WORDS.has(prev2.replace(/\.+$/, ''))) return true;
    if (noun && !(w.endsWith('s') && L.AFTER_VERB.has(nxt))) return false;
  }
  if (w === base && L.NOUN_BASES.has(base) && nounish(nxt)) {
    const subj = L.PRONOUNS.has(prev) || L.AUX.has(prev) || prev.endsWith('ly') || (prev.endsWith('s') && !L.NOT_PLURAL.has(prev) && prev.length > 3);
    if (!subj) return false;
  }
  return true;
}

/** 1-based position of the first finite verb (style_check.py `main_verb` scan, without clause skipping), or null. */
function firstVerb(low: string[]): number | null {
  for (let k = 0; k < Math.min(low.length, 45); k++) {
    if (L.SUBJ_PRON.has(low[k]!)) {
      let q = k + 1;
      while (q < low.length && (L.SKIP_ADV.has(low[q]!) || (low[q]!.endsWith('ly') && low[q]!.length > 3))) q++;
      const v = low[q];
      if (v !== undefined && isAlpha(v) && (!L.FW.has(v) || L.AUX.has(v)) && !L.SUBORD.has(v)) return q + 1;
    }
    if (isFiniteVerb(low, k)) return k + 1;
  }
  return null;
}

/** style_check.py `passive_count` > 0: a form of *be*, up to two adverbs, then a participle. */
function hasPassive(low: string[]): boolean {
  for (let k = 0; k < low.length; k++) {
    if (!L.BE.has(low[k]!)) continue;
    let j = k + 1;
    let skipped = 0;
    while (j < low.length && skipped < 2 && (L.PASS_ADV.has(low[j]!) || (low[j]!.endsWith('ly') && low[j]!.length > 3))) {
      j++;
      skipped++;
    }
    const w = low[j];
    if (w !== undefined && ((w.endsWith('ed') && w.length >= 4 && !L.NOT_PART.has(w) && L.WORD_RE.test(w)) || L.PARTICIPLE_IRREG.has(w))) return true;
  }
  return false;
}

const INFLATED_RE = L.INFLATED.map(([p, alt]) => [new RegExp(`\\b(?:${p})\\b`, 'gi'), alt] as const);
const HYPE_RE = L.HYPE.map(([p, kind]) => [new RegExp(`\\b(?:${p})\\b`, 'gi'), kind] as const);
const PLAYS_ROLE_RE = /\bplay(?:s|ed|ing)? (?:a|an) (?:key|crucial|vital|pivotal|important|central|essential) role\b/i;
const VERY_SKIP = new Set(['first', 'same', 'end', 'beginning', 'last', 'least', 'top', 'bottom']);
const HIGHLY_SKIP = new Set(['boosted', 'collimated', 'energetic', 'ionizing', 'ionising', 'excited', 'relativistic', 'correlated']);

/** style_check.py `has_number`. */
function hasNumber(plain: string): boolean {
  const t = plain.replace(L.LABEL_NUM_RE, ' ').replace(L.YEAR_RE, ' ');
  return t.search(L.NUM_TOKEN_RE) >= 0 || t.search(L.SPELLED_NUM_RE) >= 0;
}

/** style_check.py check 5 (hype and intensifiers) for one sentence, without the vague-claim exemption. */
function intensifiers(plain: string): string[] {
  const num = hasNumber(plain);
  const stat = plain.search(L.STAT_RE) >= 0 || plain.search(L.STAT_CS_RE) >= 0;
  const out: string[] = [];
  for (const [rx, kind] of HYPE_RE) {
    for (const m of plain.matchAll(rx)) {
      const w = m[0];
      const lw = w.toLowerCase();
      const at = m.index ?? 0;
      const before = (plain.slice(0, at).toLowerCase().split(/\s+/).filter(Boolean).pop() ?? '');
      const after = stripPunct(plain.slice(at + w.length).toLowerCase().split(/\s+/).filter(Boolean)[0] ?? '');
      if (kind === 'number' && num) continue;
      if (lw === 'very' && VERY_SKIP.has(after)) continue;
      if (lw === 'highly' && HIGHLY_SKIP.has(after)) continue;
      if (kind === 'comparative' && ['more', 'less', 'as'].includes(before)) continue;
      if (kind === 'stat' && (num || stat)) continue;
      if (PLAYS_ROLE_RE.test(plain.slice(Math.max(0, at - 12), at + w.length + 6))) continue;
      out.push(w);
    }
  }
  return out;
}

/** Dashes used as punctuation: em dashes, spaced en dashes, spaced or doubled hyphens (not number ranges). */
function dashCount(plain: string): number {
  let n = 0;
  for (const m of plain.matchAll(/—|―|\s–\s|\s-{1,3}\s|(?<!\d)-{2,3}(?!\d)/g)) if (m[0]) n++;
  return n;
}

interface SentStats {
  words: number;
  /** Lower-case tokens (style_check `low`). */
  low: string[];
  verbPos: number | null;
  passive: boolean;
  we: number;
  hedges: string[];
  intens: string[];
  opener: string | null;
  inflated: string[];
  excess: string[];
  dashes: number;
}

function analyze(text: string): SentStats {
  const plain = (text ?? '').replace(/\s+/g, ' ').trim();
  const toks = plain.split(' ').filter((t) => TOKEN_KEEP.test(t)).map(stripPunct).filter((t) => t.length > 0);
  const low = toks.map((t) => t.toLowerCase());
  const st = plain.replace(/^[\s"“‘(\[•\-–—]+/, '');
  const conn = L.CONN_A.exec(st) ?? L.CONN_B.exec(st);
  const inflated: string[] = [];
  for (const [rx] of INFLATED_RE) for (const m of plain.matchAll(rx)) inflated.push(m[0]);
  return {
    words: low.length,
    low,
    verbPos: low.length > 0 ? firstVerb(low) : null,
    passive: hasPassive(low),
    we: low.filter((w) => w === 'we' || w === 'our' || w === 'us' || w === 'ours').length,
    hedges: [...plain.matchAll(HEDGE_RE)].map((m) => m[0]),
    intens: intensifiers(plain),
    opener: conn ? conn[0] : null,
    inflated,
    excess: excessHits(plain).map((h) => h.word),
    dashes: dashCount(plain),
  };
}

/* ------------------------------------------------------------------------------------ */
/* Aggregation                                                                           */
/* ------------------------------------------------------------------------------------ */

/** Linear-interpolation quantile of a sorted array (q = 0.5 is statistics.median, as style_check.py uses). */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Python's round(): halves go to the even neighbour. */
function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** The 90th percentile exactly as style_check.py `length_rows` takes it: srt[min(n-1, round(0.9 (n-1)))]. */
function p90StyleCheck(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, roundHalfEven(0.9 * (sorted.length - 1)))]!;
}

const TTR_WINDOW = 1000;

/**
 * Type-token ratio of the first 1,000 word tokens. Below 1,000 tokens the value is extrapolated to 1,000
 * with Herdan's law (V = N^C, so TTR(1000) = 1000^(C - 1) with C = ln V / ln N), because the raw ratio of a
 * short text is always higher and would make every paragraph look unusual.
 */
function ttrOf(stats: SentStats[]): number {
  const types = new Set<string>();
  let n = 0;
  for (const s of stats) {
    for (const w of s.low) {
      if (!/\p{L}/u.test(w)) continue;
      if (n >= TTR_WINDOW) break;
      types.add(w);
      n++;
    }
    if (n >= TTR_WINDOW) break;
  }
  if (n === 0) return 0;
  if (n >= TTR_WINDOW) return types.size / n;
  if (n === 1) return 1;
  const c = Math.log(types.size) / Math.log(n);
  return Math.pow(TTR_WINDOW, c - 1);
}

function aggregate(stats: SentStats[]): StyleFeatures {
  const ss = stats.filter((s) => s.words > 0);
  const n = ss.length;
  if (n === 0) {
    return { n: 0, medianLen: 0, p90Len: 0, verbPos: 0, passiveShare: 0, weRate: 0, hedgeRate: 0, intensifierRate: 0, connectorOpenerRate: 0, inflatedRate: 0, excessVocabRate: 0, ttr: 0, lenStd: 0, dashRate: 0, words: 0 };
  }
  const lens = ss.map((s) => s.words).sort((a, b) => a - b);
  const words = lens.reduce((a, b) => a + b, 0);
  const mean = words / n;
  const lenStd = n > 1 ? Math.sqrt(lens.reduce((a, l) => a + (l - mean) ** 2, 0) / (n - 1)) : 0;
  // A sentence with no detectable finite verb counts as "verb after the last word".
  const verbs = ss.map((s) => s.verbPos ?? s.words + 1).sort((a, b) => a - b);
  const per1k = (count: number): number => (1000 * count) / words;
  let passive = 0, we = 0, hedges = 0, intens = 0, openers = 0, inflated = 0, excess = 0, dashes = 0;
  for (const s of ss) {
    if (s.passive) passive++;
    we += s.we;
    hedges += s.hedges.length;
    intens += s.intens.length;
    if (s.opener) openers++;
    inflated += s.inflated.length;
    excess += s.excess.length;
    dashes += s.dashes;
  }
  return {
    n,
    medianLen: quantile(lens, 0.5),
    p90Len: p90StyleCheck(lens),
    verbPos: quantile(verbs, 0.5),
    passiveShare: passive / n,
    weRate: per1k(we),
    hedgeRate: per1k(hedges),
    intensifierRate: per1k(intens),
    connectorOpenerRate: per1k(openers),
    inflatedRate: per1k(inflated),
    excessVocabRate: per1k(excess),
    ttr: ttrOf(ss),
    lenStd,
    dashRate: per1k(dashes),
    words,
  };
}

/** Features of a list of plain-text sentences. Empty input -> n = 0 and zeros. */
export function styleFeatures(sentences: string[]): StyleFeatures {
  return aggregate((sentences ?? []).map(analyze));
}

/* ------------------------------------------------------------------------------------ */
/* Distance                                                                              */
/* ------------------------------------------------------------------------------------ */

export type StyleFeatureKey = Exclude<keyof StyleFeatures, 'n' | 'words'>;

/**
 * Typical difference between two authors' values of each feature: a difference of one spread contributes
 * as much as a typical between-author difference. Sources: the per-paper spread of the skill's five papers
 * (sentences-and-words.md, Corpus norms), widened to the range seen between HEP authors where the five papers,
 * from one group, are closer than authors in general.
 */
export const STYLE_SPREADS: Record<StyleFeatureKey, { spread: number; basis: string }> = {
  medianLen: { spread: 4, basis: 'per-paper medians 22-26 words; HEP authors about 18-30' },
  p90Len: { spread: 7, basis: 'p90 tracks the long tail: 5-18% of sentences over 40 words per paper' },
  verbPos: { spread: 2, basis: 'per-paper verb positions 3-4 after a subject, 6-7.5 after a fronted phrase' },
  passiveShare: { spread: 0.12, basis: 'per-paper passive shares 26-46%' },
  weRate: { spread: 5, basis: 'per-paper we/our/us 12-18 per 1,000 words' },
  hedgeRate: { spread: 2.5, basis: 'per-paper hedges 2.1-6.5 per 1,000 words' },
  intensifierRate: { spread: 2, basis: 'corpus 2.1 per 1,000 words; the CHARM and TIME abstracts have none' },
  connectorOpenerRate: { spread: 1.5, basis: 'corpus 0.6 per 1,000 words (4 of 672 sentences)' },
  inflatedRate: { spread: 1, basis: 'corpus 0.2 per 1,000 words (5 utilize/leverage in 25,027 words)' },
  excessVocabRate: { spread: 1.5, basis: 'neutral: about one flagged excess word per 700 words' },
  ttr: { spread: 0.06, basis: 'type-token ratio at 1,000 words varies by about 0.4-0.55 in technical prose' },
  lenStd: { spread: 3, basis: 'length spread about 9-14 words for medians of 22-26' },
  dashRate: { spread: 1, basis: 'corpus 0.3 per 1,000 words; dash-heavy writers reach 2-3' },
};

const FEATURES = Object.keys(STYLE_SPREADS) as StyleFeatureKey[];
const RATE_FEATURES = new Set<StyleFeatureKey>(['weRate', 'hedgeRate', 'intensifierRate', 'connectorOpenerRate', 'inflatedRate', 'excessVocabRate', 'dashRate']);
/** Spread of sentence lengths and of verb positions used for the sampling noise of medians. */
const SIGMA_LEN = 11;
const SIGMA_VERB = 3;

function wordsOf(f: StyleFeatures): number {
  return typeof f.words === 'number' && f.words > 0 ? f.words : Math.max(0, f.n * f.medianLen);
}

/**
 * Sampling variance of feature `k` measured on a set of `n` sentences / `w` words, so that a short paragraph
 * is not called unusual for differences that chance alone produces: medians 1.2533 s/sqrt(n), p90
 * 1.709 s/sqrt(n), standard deviation s/sqrt(2n), passive share sqrt(p(1-p)/n) at p = 0.35, rates as
 * Poisson counts at rate `lambda` per 1,000 words, ttr 0.03 sqrt(1000/w).
 */
function noiseVar(k: StyleFeatureKey, n: number, w: number, lambda: number): number {
  if (n <= 0) return 0;
  switch (k) {
    case 'medianLen': return (1.2533 * SIGMA_LEN) ** 2 / n;
    case 'p90Len': return (1.709 * SIGMA_LEN) ** 2 / n;
    case 'lenStd': return SIGMA_LEN ** 2 / (2 * n);
    case 'verbPos': return (1.2533 * SIGMA_VERB) ** 2 / n;
    case 'passiveShare': return (0.35 * 0.65) / n;
    case 'ttr': return w > 0 ? 0.0009 * (1000 / Math.min(w, 1000)) : 0;
    default: return RATE_FEATURES.has(k) && w > 0 ? (1000 * lambda) / w : 0;
  }
}

/**
 * Scaled distance (0 = identical; ~1 = typical difference between authors) and per-feature contributions.
 *
 * Each feature difference is divided by sqrt(spread^2 + sampling variance of both sides) (STYLE_SPREADS,
 * noiseVar); distance = sqrt(mean of the squared scaled differences over the 13 features), and
 * perFeature[k] = (scaled difference)^2 / 13, so the contributions sum to distance^2. `n` and `words` are
 * sample sizes, not style. If either side has no sentences the distance is 0.
 */
export function styleDistance(a: StyleFeatures, b: StyleFeatures): { distance: number; perFeature: Record<string, number> } {
  const perFeature: Record<string, number> = {};
  for (const k of FEATURES) perFeature[k] = 0;
  if (!(a.n > 0) || !(b.n > 0)) return { distance: 0, perFeature };
  const wa = wordsOf(a);
  const wb = wordsOf(b);
  let sum = 0;
  for (const k of FEATURES) {
    const va = Number.isFinite(a[k]) ? a[k] : 0;
    const vb = Number.isFinite(b[k]) ? b[k] : 0;
    const d = va - vb;
    if (d === 0) continue;
    const lambda = Math.max(Math.min(va, vb), 0.3);
    const s2 = STYLE_SPREADS[k].spread ** 2 + noiseVar(k, a.n, wa, lambda) + noiseVar(k, b.n, wb, lambda);
    const z2 = (d * d) / s2 / FEATURES.length;
    perFeature[k] = z2;
    sum += z2;
  }
  return { distance: Math.sqrt(sum), perFeature };
}

/* ------------------------------------------------------------------------------------ */
/* Furthest sentences                                                                    */
/* ------------------------------------------------------------------------------------ */

const fmt = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const quoteList = (ws: string[]): string => [...new Set(ws.map((w) => w.toLowerCase()))].map((w) => `"${w}"`).join(', ');

function reason(k: StyleFeatureKey, s: SentStats, target: StyleFeatures): string | null {
  switch (k) {
    case 'medianLen':
    case 'p90Len':
    case 'lenStd':
      return s.words > target.medianLen ? `${s.words} words (target median ${fmt(target.medianLen)})` : `only ${s.words} words (target median ${fmt(target.medianLen)})`;
    case 'verbPos':
      return s.verbPos === null ? 'no finite verb found' : `main verb at word ${s.verbPos} (target ${fmt(target.verbPos)})`;
    case 'passiveShare':
      return s.passive ? `passive voice (target ${Math.round(target.passiveShare * 100)}% of sentences)` : `active voice (target ${Math.round(target.passiveShare * 100)}% passive)`;
    case 'weRate':
      return s.we > 0 ? `"we/our" ${s.we} time${s.we === 1 ? '' : 's'}` : 'no "we/our"';
    case 'hedgeRate':
      return s.hedges.length > 0 ? `hedges ${quoteList(s.hedges)}` : 'no hedge';
    case 'intensifierRate':
      return s.intens.length > 0 ? `intensifiers ${quoteList(s.intens)}` : null;
    case 'connectorOpenerRate':
      return s.opener ? `opens with "${s.opener}"` : null;
    case 'inflatedRate':
      return s.inflated.length > 0 ? `inflated wording ${quoteList(s.inflated)}` : null;
    case 'excessVocabRate':
      return s.excess.length > 0 ? `AI-associated words ${quoteList(s.excess)}` : null;
    case 'ttr':
      return 'word variety';
    case 'dashRate':
      return s.dashes > 0 ? 'dash used as punctuation' : null;
  }
}

/** The k sentences whose removal moves the set closest to `target` (largest contribution first), with a plain reason. */
export function furthestSentences(sentences: Array<{ id: string; text: string }>, target: StyleFeatures, k = 3): Array<{ id: string; contribution: number; why: string }> {
  const limit = Number.isFinite(k) ? Math.floor(k) : 0;
  if (limit <= 0 || !sentences || sentences.length === 0) return [];
  const stats = sentences.map((s) => analyze(s.text));
  const full = styleDistance(aggregate(stats), target);
  const out: Array<{ id: string; contribution: number; why: string; i: number }> = [];
  for (let i = 0; i < stats.length; i++) {
    if (stats[i]!.words === 0) continue;
    const rest = stats.filter((_, j) => j !== i);
    const loo = styleDistance(aggregate(rest), target);
    const contribution = full.distance - loo.distance;
    if (!(contribution > 1e-9)) continue;
    const gains = FEATURES.map((f) => ({ f, g: (full.perFeature[f] ?? 0) - (loo.perFeature[f] ?? 0) }))
      .filter((x) => x.g > 1e-12)
      .sort((x, y) => y.g - x.g);
    const why: string[] = [];
    let sawLength = false;
    for (const { f } of gains) {
      const isLength = f === 'medianLen' || f === 'p90Len' || f === 'lenStd';
      if (isLength && sawLength) continue;
      const r = reason(f, stats[i]!, target);
      if (!r) continue;
      if (isLength) sawLength = true;
      why.push(r);
      if (why.length === 2) break;
    }
    out.push({ id: sentences[i]!.id, contribution, why: why.length > 0 ? why.join('; ') : 'moves several features away from the target', i });
  }
  return out
    .sort((x, y) => y.contribution - x.contribution || x.i - y.i)
    .slice(0, limit)
    .map(({ id, contribution, why }) => ({ id, contribution, why }));
}
