/**
 * Numbers in prose, fact rendering and numeral-to-fact matching.
 *
 * OWNER: core-gate agent.
 *
 * Matching rules (strict, used by linking and the gate):
 * - A numeral stands for a fact field (the value or a named uncertainty) when the field, times the
 *   scale, rounded to the numeral's written precision equals the numeral: |field*scale - numeral| <=
 *   half a unit in the last written digit (for `1.2\times10^{-4}` the last digit is 10^-5).
 *   A numeral without a sign may state the magnitude of a negative fact ("lower by 0.83 points").
 * - Scale 100 only for a dimensionless fraction fact (unit '', |value| <= 1) written as a percent or
 *   in "points"; such a fact written as a percent at scale 1 ("0.97\%") or a percent fact written as a
 *   fraction does not match (the gate reports `percent_scale`). Facts with unit '%' or 'points' are
 *   already scaled and match at scale 1 only; a percent numeral never matches a 'points' fact
 *   (percent versus percentage points).
 * - Physical units must agree when the numeral has one (GeV vs MeV differ; no conversion).
 * - Integer facts (counts, integer cuts) match integer numerals exactly (`8,710` -> 8710 only).
 * - Excluded facts and facts without a numeric value never match.
 */
import type { Fact } from '../schemas';
import { decimalsForSig, factNumber, fixed, isFractionFact, mainUncertainty, needsSci, sciParts, unitSuffix, withThousands } from './format';
import { extractNumeralDetails, normalizeUnit, precisionOfMantissa, toPublicToken, type NumeralDetail } from './numerals';

export interface NumeralToken {
  /** Offsets of the numeral inside the sentence text (UTF-16). */
  start: number;
  end: number;
  /** As written, e.g. "2.32", "8,710", "8{,}710", "1.2\\times10^{-4}", "10^8", "96.94". */
  raw: string;
  /** Parsed numeric value (thousand separators removed; mantissa x 10^exponent applied). */
  value: number;
  /** Number of decimals as written in the mantissa ("2.32" -> 2, "8,710" -> 0). */
  decimals: number;
  /** Significant figures as written. */
  sigfigs: number;
  /** Followed by `\%`, `%`, or the word "percent". */
  percent: boolean;
  /** Followed by the word "points" / "percentage points" / "pp". */
  points: boolean;
  /** Unit right after it (`~GeV`, `\,\mathrm{mm}`, ` mm`, `\si{\GeV}`, `TeV`, `fb$^{-1}$`, `ab$^{-1}$`...), or null. */
  unit: string | null;
  /** Preceded by `\pm`, `±`, `+-` (it is an uncertainty). */
  isUncertainty: boolean;
  /** Inside inline math. */
  inMath: boolean;
  /**
   * Structural numbers that never need a fact: section/figure/table/equation/appendix/reference numbers
   * ("Sec. 3", "Fig. 2", "Eq. (4)", "Table I"), years 1900-2099 next to a citation or "in 2024",
   * list markers "(i)", "(1)", ordinals ("1st"), and bare integers 0-10 with no unit, decimal, percent or
   * "points" ("three seeds" is a word; "3 seeds" is a small bare integer and is structural too).
   */
  structural: boolean;
}

/**
 * Find every numeral in one LaTeX sentence, including inside inline math (`$p_T > 1$~GeV` -> 1 GeV)
 * but never inside \cite{..}/\ref{..}/\label{..} keys, macro names, or `\SI`/`\num` option brackets.
 * `\SI{30}{\GeV}` -> 30 with unit GeV; `\num{8710}` -> 8710.
 * Also skipped: comments, optional arguments of commands, environment names, paths/URLs/lengths,
 * placeholders, digits glued to identifiers (`T1`, `eff_s0`, `3D`), and sub/superscript indices
 * (`p_{T,1}`, `fb^{-1}`). Never throws.
 */
export function extractNumerals(text: string): NumeralToken[] {
  try {
    return extractNumeralDetails(text).map(toPublicToken);
  } catch {
    return [];
  }
}

/** Decimals and significant figures of a numeral string ("0.0550" -> {decimals: 4, sigfigs: 3}). */
export function precisionOf(raw: string): { decimals: number; sigfigs: number } {
  const s = typeof raw === 'string' ? raw : String(raw ?? '');
  if (/^\s*[+\-−]?\s*10\s*\^/.test(s)) return { decimals: 0, sigfigs: 1 };
  const cleaned = s.replace(/\{,\}/g, ',').replace(/\\,|\u2009|\u202f/g, '\u2009');
  const m = /(?:\d{1,3}(?:,\d{3})+(?!\d)|\d{1,3}(?:\u2009\d{3})+(?!\d)|\d+)(?:\.\d+)?|\.\d+/.exec(cleaned);
  if (!m) return { decimals: 0, sigfigs: 0 };
  return precisionOfMantissa(m[0]);
}

/** Power of ten written in a numeral (for tokens that do not carry it). */
function exponentOf(tok: NumeralToken): number {
  const d = tok as Partial<NumeralDetail>;
  if (typeof d.exponent === 'number') return d.exponent;
  const raw = tok.raw ?? '';
  let m = /(?:\\times|×|\\cdot|·|x)\s*10\s*\^\s*\{?\s*([+\-−]?)\s*(\d+)/.exec(raw);
  if (!m) m = /^\s*[+\-−]?\s*10\s*\^\s*\{?\s*([+\-−]?)\s*(\d+)/.exec(raw);
  if (!m) m = /\d[eE]([+\-−]?)(\d+)/.exec(raw);
  if (m) return (m[1] === '-' || m[1] === '−' ? -1 : 1) * Number(m[2]);
  // multipliers ("1.5 million", "10k"): the value is the written mantissa times a power of ten
  const mm = /(?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.\d+)?|\.\d+/.exec(raw.replace(/\{,\}/g, ','));
  const mant = mm ? Number(mm[0].replace(/,/g, '')) : NaN;
  if (Number.isFinite(mant) && mant !== 0 && Number.isFinite(tok.value) && tok.value !== 0) {
    const e = Math.round(Math.log10(Math.abs(tok.value / mant)));
    if (e !== 0 && Math.abs(Math.abs(tok.value) - Math.abs(mant) * Math.pow(10, e)) <= 1e-9 * Math.abs(tok.value)) return e;
  }
  return 0;
}

export interface NumeralMatch {
  factId: string;
  /** 'value' or `unc:<name>` when the numeral equals a named uncertainty. */
  field: string;
  /** 1 or 100 (fraction written as percent / points). */
  scale: 1 | 100;
}

const CUT_KINDS = new Set(['cut', 'definition', 'setting']);

function fieldsOf(f: Fact): Array<[string, number]> {
  const v = factNumber(f);
  if (v === null) return [];
  const out: Array<[string, number]> = [['value', v]];
  for (const [k, u] of Object.entries(f.uncertainties ?? {})) if (typeof u === 'number' && Number.isFinite(u)) out.push([`unc:${k}`, u]);
  return out;
}

/** Scales a numeral may use for a fact under the strict rules. */
function strictScales(tok: NumeralToken, f: Fact): number[] {
  const u = normalizeUnit(f.unit);
  const frac = isFractionFact(f);
  const tu = normalizeUnit(tok.unit);
  if (tu && tu !== '%' && tu !== 'points') return u === tu ? [1] : [];
  if (tok.percent) {
    if (frac) return [100];
    if (u === '%') return [1];
    // a dimensionless value above 1 may already be a percent ("eff_pct": 96.94); 0 and 1 are not
    if (u === '') {
      const v = factNumber(f);
      return v !== null && Math.abs(v) > 1 ? [1] : [];
    }
    return [];
  }
  if (tok.points) {
    if (frac) return [100];
    if (u === 'points' || u === '%' || u === '') return [1];
    return [];
  }
  return [1];
}

/** Scales under the relaxed rules (percent/fraction confusions), used to diagnose `percent_scale`. */
function relaxedScales(tok: NumeralToken, f: Fact): number[] {
  const u = normalizeUnit(f.unit);
  const tu = normalizeUnit(tok.unit);
  if (tu && tu !== '%' && tu !== 'points') return u === tu ? [1] : [];
  if (u && u !== '%' && u !== 'points' && u !== 'fraction') return [1];
  return [1, 100, 0.01];
}

function fieldMatches(x: number, scale: number, tok: NumeralToken, exactInt: boolean): boolean {
  const tv = tok.value;
  if (!Number.isFinite(tv) || !Number.isFinite(x)) return false;
  const target = x * scale;
  const cmp = tv < 0 ? target : Math.abs(target);
  if (exactInt) return Math.abs(cmp - tv) < 1e-9 * Math.max(1, Math.abs(tv));
  const exp = exponentOf(tok);
  const dec = Number.isFinite(tok.decimals) ? tok.decimals : 0;
  const tol = 0.5 * Math.pow(10, exp - dec);
  return Math.abs(cmp - tv) <= tol * (1 + 1e-9) + 1e-12 * Math.max(1, Math.abs(tv));
}

function matchWith(tok: NumeralToken, facts: Fact[], scalesOf: (t: NumeralToken, f: Fact) => number[]): Array<{ factId: string; field: string; scale: number }> {
  const out: Array<{ factId: string; field: string; scale: number }> = [];
  if (!tok || typeof tok.value !== 'number' || !Array.isArray(facts)) return out;
  const seen = new Set<string>();
  const tokExp = exponentOf(tok);
  const tokIsInt = (tok.decimals ?? 0) - tokExp <= 0 && Number.isInteger(tok.value);
  for (const f of facts) {
    if (!f || f.excluded || seen.has(f.id)) continue;
    seen.add(f.id);
    const v = factNumber(f);
    if (v === null) continue;
    const scales = scalesOf(tok, f);
    if (scales.length === 0) continue;
    for (const [field, x] of fieldsOf(f)) {
      if (field !== 'value' && tok.value < 0) continue;
      for (const scale of scales) {
        // integer counts match exactly when written out in full; a power of ten is an explicit rounding
        const exactInt = field === 'value' && scale === 1 && Number.isInteger(v) && tokIsInt && tokExp === 0 && Math.abs(v) >= 1;
        if (fieldMatches(x, scale, tok, exactInt)) {
          out.push({ factId: f.id, field, scale });
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Facts a numeral can stand for: the fact value (or one of its uncertainties) rounded to the numeral's
 * written decimals equals the numeral value exactly, at scale 1 or 100 (scale 100 only when the fact
 * value is within [-1, 1] and the numeral is a percent or "points" or the fact unit is "%" / "points").
 * Units must agree when both are known (GeV vs MeV etc. are different). Excluded facts never match.
 * Integer counts match integer facts exactly ("8,710" -> n_targets = 8710).
 * (Stricter reading used here: scale 100 only for dimensionless fractions written as percent/points;
 * see the module comment.)
 */
export function matchNumeral(tok: NumeralToken, facts: Fact[]): NumeralMatch[] {
  try {
    return matchWith(tok, facts, strictScales).map((m) => ({ factId: m.factId, field: m.field, scale: m.scale as 1 | 100 }));
  } catch {
    return [];
  }
}

/** Matches allowed only under the relaxed (percent/fraction-confused) rules. Internal, for the gate. */
export function relaxedOnlyMatches(tok: NumeralToken, facts: Fact[]): Array<{ factId: string; field: string; scale: number }> {
  try {
    const strict = new Set(matchWith(tok, facts, strictScales).map((m) => `${m.factId}|${m.field}`));
    return matchWith(tok, facts, relaxedScales).filter((m) => !strict.has(`${m.factId}|${m.field}`));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------------------------ */
/* Renderings                                                                            */
/* ------------------------------------------------------------------------------------ */

function sciLatex(x: number, sig: number): string {
  const { mant, exp } = sciParts(x, sig);
  return `${mant}\\times10^{${exp}}`;
}

/**
 * Prose renderings of a fact, derived from value + sigfigs only (never free text):
 * for a fraction in (0, 1] also the percent form (x100). Example: value 0.96942, sigfigs null ->
 * ["0.97", "0.969", "0.9694", "97.0%", "96.9%", "96.94%", ...] at 1-4 decimals. Uncertainties render
 * with the same scale. Used for the Facts panel and for prompts.
 * Here: 2-4 significant figures when `sigfigs` is null, (sigfigs - 1) and sigfigs otherwise; the
 * percent form of a fraction at the same significant figures ("97%", "96.9%", "96.94%"); integers
 * exactly, with and without thousands separators; the main uncertainty as "x ± u" at the same decimals.
 */
export function factAliases(fact: Fact): string[] {
  try {
    const v = fact ? factNumber(fact) : null;
    if (v === null) return [];
    const out: string[] = [];
    const add = (s: string): void => {
      if (s && !out.includes(s)) out.push(s);
    };
    const suffix = unitSuffix(fact.unit);
    const unc = mainUncertainty(fact);
    if (Number.isInteger(v) && Math.abs(v) >= 1 && !(fact.tags ?? []).includes('fraction')) {
      add(withThousands(String(v)) + suffix);
      add(String(v) + suffix);
      if (unc && Number.isInteger(unc.value)) add(`${withThousands(String(v))} ± ${unc.value}${suffix}`);
      return out;
    }
    const sf = fact.sigfigs && fact.sigfigs > 0 ? Math.min(fact.sigfigs, 15) : null;
    const sigs = sf ? Array.from(new Set([Math.max(1, sf - 1), sf])) : [2, 3, 4];
    for (const s of sigs) {
      if (needsSci(v)) {
        add(sciLatex(v, s) + suffix);
        continue;
      }
      const d = decimalsForSig(v, s);
      const str = fixed(v, d);
      add(str + suffix);
      if (unc && Number(fixed(unc.value, d)) !== 0) add(`${str} ± ${fixed(unc.value, d)}${suffix}`);
    }
    if (isFractionFact(fact) && v > 0 && v <= 1) {
      const pv = v * 100;
      for (const s of sigs) {
        const d = decimalsForSig(pv, s);
        const str = fixed(pv, d);
        add(`${str}%`);
        if (unc && Number(fixed(unc.value * 100, d)) !== 0) add(`${str} ± ${fixed(unc.value * 100, d)}%`);
      }
    }
    return out;
  } catch {
    return [];
  }
}

const OP_TEXT: Record<string, string> = { gt: '>', lt: '<', ge: '>=', le: '<=', eq: '=' };

/** Compact one-line rendering for chips and prompts, e.g. "f.g1.delta_points = 2.32 ± 0.28 points". */
export function renderFact(fact: Fact): string {
  try {
    if (!fact) return '';
    const id = fact.id ?? '?';
    const v = factNumber(fact);
    if (v === null) {
      const t = String(fact.value ?? '').replace(/\s+/g, ' ').trim();
      return `${id} = ${t.length > 100 ? t.slice(0, 99) + '…' : t}`;
    }
    const suffix = unitSuffix(fact.unit);
    const unc = mainUncertainty(fact);
    const frac = isFractionFact(fact);
    let num: string;
    let d = 0;
    if (Number.isInteger(v) && Math.abs(v) >= 1 && !(fact.tags ?? []).includes('fraction')) {
      num = withThousands(String(v));
    } else if (needsSci(v)) {
      const { mant, exp } = sciParts(v, fact.sigfigs ?? 3);
      num = `${mant}×10^${exp}`;
      d = -1;
    } else {
      const sig = fact.sigfigs && fact.sigfigs > 0 ? fact.sigfigs : frac ? 4 : 3;
      d = decimalsForSig(v, sig);
      num = fixed(v, d);
    }
    let uncText = '';
    if (unc && d >= 0) {
      const ud = Number.isInteger(v) && d === 0 ? decimalsForSig(unc.value, 2) : d;
      uncText = ` ± ${fixed(unc.value, ud)}`;
    }
    let pct = '';
    if (frac && d >= 0) {
      const pd = Math.max(0, d - 2);
      pct = ` (${fixed(v * 100, pd)}${unc ? ` ± ${fixed(unc.value * 100, pd)}` : ''}%)`;
    }
    const cmpTag = (fact.tags ?? []).find((t) => t.startsWith('cmp:'));
    if (fact.kind === 'cut' && cmpTag) {
      const op = cmpTag.slice(4);
      return `${id}: ${OP_TEXT[op] ?? op} ${num}${uncText}${suffix}`;
    }
    return `${id} = ${num}${uncText}${suffix}${pct}`;
  } catch {
    return String(fact?.id ?? '');
  }
}

/* ------------------------------------------------------------------------------------ */
/* Linking                                                                               */
/* ------------------------------------------------------------------------------------ */

export interface FactLinkResult {
  /** Fact ids linked unambiguously (exactly one candidate fact, or the candidate the caller preferred). */
  linked: string[];
  /** Non-structural numerals with no matching fact. */
  unmatched: NumeralToken[];
  /** Numerals with several candidate facts: [token, candidate fact ids]. */
  ambiguous: Array<{ token: NumeralToken; candidates: string[] }>;
}

/** Per-token link state (internal; shared with the gate). */
export interface TokenLink {
  tok: NumeralDetail;
  matches: NumeralMatch[];
  candidates: string[];
  linked: string | null;
  status: 'structural' | 'linked' | 'ambiguous' | 'unmatched';
}

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

/**
 * Resolve every token to facts. Ties are broken, in order, by: the value an uncertainty belongs to
 * (`2.32 ± 0.28`: 0.28 is an uncertainty of the fact 2.32 linked to, and narrows an ambiguous value to
 * facts that carry that uncertainty); an uncertainty of a fact already linked in the sentence; a
 * comparison (`> 1 GeV` prefers cut/definition/setting facts); the caller's `prefer` list.
 */
export function resolveLinks(toks: NumeralDetail[], facts: Fact[], prefer: string[] = []): TokenLink[] {
  const usable: Fact[] = [];
  const seen = new Set<string>();
  for (const f of Array.isArray(facts) ? facts : []) {
    if (!f || f.excluded || typeof f.id !== 'string' || seen.has(f.id)) continue;
    seen.add(f.id);
    usable.push(f);
  }
  const kind = new Map(usable.map((f) => [f.id, f.kind] as const));
  const cutFacts = usable.filter((f) => CUT_KINDS.has(f.kind));
  const pref = new Set(Array.isArray(prefer) ? prefer : []);
  const links: TokenLink[] = toks.map((tok) => {
    if (tok.structural) {
      // a structural-looking numeral in a comparison may still be a cut (`|\eta| < 4`)
      if (tok.comparison && cutFacts.length) {
        const ms = matchNumeral(tok, cutFacts);
        const ids = uniq(ms.map((m) => m.factId));
        if (ids.length === 1) return { tok, matches: ms, candidates: ids, linked: ids[0]!, status: 'structural' };
      }
      return { tok, matches: [], candidates: [], linked: null, status: 'structural' };
    }
    const ms = matchNumeral(tok, usable);
    let ids = uniq(ms.map((m) => m.factId));
    if (tok.comparison) {
      const cuts = ids.filter((id) => CUT_KINDS.has(kind.get(id) ?? ''));
      if (cuts.length) ids = cuts;
    }
    return { tok, matches: ms, candidates: ids, linked: null, status: ids.length === 0 ? 'unmatched' : 'ambiguous' };
  });
  const uncIds = (l: TokenLink): string[] => uniq(l.matches.filter((m) => m.field.startsWith('unc:')).map((m) => m.factId));
  for (let round = 0; round < 3; round++) {
    let changed = false;
    const linkedSet = new Set(links.map((l) => l.linked).filter((x): x is string => !!x));
    for (const l of links) {
      if (l.status === 'structural' || l.candidates.length === 0) continue;
      const before = l.candidates.join('|');
      const baseIdx = l.tok.uncertaintyOf;
      if (baseIdx >= 0 && links[baseIdx]) {
        const base = links[baseIdx]!;
        const u = uncIds(l);
        if (base.linked && u.includes(base.linked)) l.candidates = [base.linked];
        else if (!base.linked && base.candidates.length > 1) {
          const inter = base.candidates.filter((id) => u.includes(id));
          if (inter.length >= 1 && inter.length < base.candidates.length) {
            base.candidates = inter;
            changed = true;
          }
          if (inter.length >= 1) l.candidates = l.candidates.filter((id) => inter.includes(id)).length ? l.candidates.filter((id) => inter.includes(id)) : inter;
        }
      }
      if (l.candidates.length > 1) {
        const u = uncIds(l).filter((id) => linkedSet.has(id) && l.candidates.includes(id));
        if (u.length === 1) l.candidates = u;
      }
      if (l.candidates.length > 1 && pref.size) {
        const inPref = l.candidates.filter((id) => pref.has(id));
        if (inPref.length >= 1) l.candidates = inPref;
      }
      if (l.candidates.length === 1 && l.linked !== l.candidates[0]) {
        l.linked = l.candidates[0]!;
        l.status = 'linked';
      }
      if (l.candidates.join('|') !== before) changed = true;
    }
    for (const l of links) {
      if (l.status === 'ambiguous' && l.candidates.length === 1) {
        l.linked = l.candidates[0]!;
        l.status = 'linked';
      }
    }
    if (!changed) break;
  }
  return links;
}

/**
 * Link every non-structural numeral of a sentence to facts. `prefer` (e.g. the fact ids the AI said it
 * used, or the paragraph plan's facts) breaks ties: if exactly one candidate is in `prefer`, link it.
 * (If several candidates are preferred, the numeral stays ambiguous among those.) A structural-looking
 * numeral in a comparison that matches exactly one cut fact (`$|\eta| < 4$`) is linked too.
 */
export function linkSentenceFacts(text: string, facts: Fact[], prefer: string[] = []): FactLinkResult {
  try {
    const toks = extractNumeralDetails(text);
    const links = resolveLinks(toks, facts, prefer);
    const linked: string[] = [];
    const unmatched: NumeralToken[] = [];
    const ambiguous: Array<{ token: NumeralToken; candidates: string[] }> = [];
    for (const l of links) {
      if (l.linked) {
        if (!linked.includes(l.linked)) linked.push(l.linked);
        continue;
      }
      if (l.status === 'structural') continue;
      if (l.candidates.length === 0) unmatched.push(toPublicToken(l.tok));
      else ambiguous.push({ token: toPublicToken(l.tok), candidates: [...l.candidates] });
    }
    return { linked, unmatched, ambiguous };
  } catch {
    return { linked: [], unmatched: [], ambiguous: [] };
  }
}

export { extractNumeralDetails, normalizeUnit };
export type { NumeralDetail };
