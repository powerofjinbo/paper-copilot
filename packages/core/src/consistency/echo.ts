/**
 * Echo check (Consistency panel): every fact-backed number across abstract, introduction, body,
 * captions and conclusions, with per-occurrence sentence ids, and the flags of docs/design.md
 * ("Consistency: each headline number across abstract, body, conclusions and captions with drift,
 * factor-versus-percent and dropped-condition flags, plus stale-fact sentences") and of the skill's
 * Step 0 (the key phrase echoed in title, abstract, contribution and conclusions; the headline number
 * with its baseline in abstract and conclusions).
 *
 * OWNER: core-features agent.
 *
 * Numerals are read exactly as the gate reads them (extractNumeralDetails + resolveLinks, preferring the
 * unit's linked facts), so the panel and the gate never disagree on what a number stands for. Facts that
 * hold the identical value and unit (the same efficiency in a claim JSON and a CSV row) are one quantity;
 * per-seed values yield to the aggregate. A numeral that matches no fact but a derived relation (ratio,
 * difference, relative change; meta/derived.ts) is a quantity of that relation.
 *
 * Flags (kinds in api.ts ConsistencyFlagKind):
 * - drift_precision: one quantity written at different precision ("96.94%" in the abstract, "96.9%" in
 *   the body); warn across parts, info inside one part.
 * - drift_form: one quantity as a percent in one place and a fraction or another form elsewhere.
 * - drift_value (heuristic): a numeral that matches no fact but is within 5% of a quantity the text
 *   states elsewhere in the same form (a stale or mistyped copy: "96.49%" against 96.94%).
 * - factor_percent: one fact pair stated as a factor in one place and as a percent in another.
 * - condition_dropped (heuristic): a number of the abstract or conclusions whose body sentence carries a
 *   condition phrase ("on the isolated gun particles", "at $\mu = 200$") none of whose content words the
 *   abstract/conclusions sentence (or the one before it) has.
 * - stale_fact: a stale fact (its artifact changed) stated in the text, with the sentences.
 * - ambiguous_number (info): a numeral that fits facts with different values. Before flagging, the
 *   report picks one candidate when every candidate holds this very number, when exactly one shares the
 *   result row of a number linked in the same sentence, or (heuristic) when exactly one candidate's name
 *   words appear in the sentence; NumberOccurrence.resolvedBy says which (the gate is unchanged).
 * - key_phrase_missing / key_phrase_partial / no_contribution_sentence.
 * - headline_missing / headline_baseline / headline_condition.
 */
import type { ConsistencyFlag, EchoQuantity, EchoReport, HeadlinePlace, KeyPhraseLocation, NumberForm, NumberOccurrence, SentenceRef } from '../api';
import type { Fact, Outline, Part } from '../schemas';
import { extractNumeralDetails, normalizeUnit, resolveLinks, type NumeralDetail, type TokenLink } from '../facts/numbers';
import { factNumber, isFractionFact } from '../facts/format';
import { derivedRelationMatches, type DerivedRelation } from '../gate/gate';
import { plainText } from '../text/normalize';
import * as STYLE_LISTS from '../meta/data/styleCheckLists';
import { definitionStem } from '../meta/derived';
import { PART_ORDER, contentStems, makeFlag, matchPhrase, plainTokens, sentenceRef, shorten, stemWord, type ConsistencyUnit } from './common';

export interface EchoOptions {
  /** Plain or LaTeX title (see extractTitle); without it the title location is 'absent'. */
  title?: string | null;
  /** Derived relations the gate accepts (derivedRelations(facts)); numerals matching one are quantities too. */
  derived?: readonly DerivedRelation[];
  /** Relative distance under which an unmatched numeral is reported as a drifted copy (default 0.05). */
  driftTolerance?: number;
}

/* ------------------------------------------------------------------------------------ */
/* Occurrences                                                                           */
/* ------------------------------------------------------------------------------------ */

interface Occ extends NumberOccurrence {
  key: string;
  unitIndex: number;
  /** For derived quantities: the sorted fact pair (factor-versus-percent grouping). */
  pair: string | null;
  factIds: string[];
}

function formOf(tok: NumeralDetail, fact: Fact | null): NumberForm {
  if (tok.word) return 'words';
  if (tok.ratioDen !== null) return 'ratio';
  if (tok.factor) return 'factor';
  if (tok.percent) return 'percent';
  if (tok.points) return 'points';
  if (tok.unit) return 'unit';
  if (fact && isFractionFact(fact)) return 'fraction';
  return 'plain';
}

function renderingOf(tok: NumeralDetail): string {
  if (tok.word) return tok.phrase || tok.raw;
  if (tok.ratioDen !== null) return tok.raw;
  return `${tok.negative && !tok.raw.startsWith('-') ? '-' : ''}${tok.raw.replace(/\{,\}/g, ',').replace(/\\,/g, ' ')}${tok.percent ? '%' : ''}${tok.points ? ' points' : ''}${tok.unit && !tok.points && tok.unit !== '%' ? ' ' + tok.unit : ''}${tok.factor ? ' times' : ''}`;
}

/** A per-seed value (array element of *_seeds, CSV column eff_s0): yields to the aggregate. */
function perSeed(f: Fact): boolean {
  const last = String(f.id).split('.').pop() ?? '';
  return /\/\d+$/.test(String(f.locator ?? '')) || /(?:^|[._])seeds?(?:[._]|$)/i.test(String(f.id)) || /(?:^|_)(?:s|seed)\d+$/i.test(last);
}

/** Equivalence classes of facts: same numeric value and unit. */
class Classes {
  private readonly byId = new Map<string, Fact>();
  private readonly order = new Map<string, number>();
  private readonly members = new Map<string, string[]>();
  constructor(facts: readonly Fact[]) {
    facts.forEach((f, i) => {
      if (!f || typeof f.id !== 'string' || this.byId.has(f.id)) return;
      this.byId.set(f.id, f);
      this.order.set(f.id, i);
      const k = this.valueKey(f);
      if (k === null) return;
      const m = this.members.get(k);
      if (m) m.push(f.id);
      else this.members.set(k, [f.id]);
    });
  }
  fact(id: string): Fact | undefined {
    return this.byId.get(id);
  }
  rank(id: string): number {
    return this.order.get(id) ?? Number.MAX_SAFE_INTEGER;
  }
  valueKey(f: Fact): string | null {
    const v = factNumber(f);
    if (v === null || f.excluded) return null;
    return `${normalizeUnit(f.unit)}|${v.toPrecision(12)}`;
  }
  /** Facts holding the same value as `id` (itself first, then store order). */
  equivalents(id: string): string[] {
    const f = this.byId.get(id);
    if (!f) return [id];
    const k = this.valueKey(f);
    const m = k === null ? [id] : (this.members.get(k) ?? [id]);
    return [id, ...m.filter((x) => x !== id)];
  }
  /** Primary fact of a quantity: the first of its class in store order, preferring aggregates over per-seed values. */
  primary(id: string): string {
    const eq = this.equivalents(id);
    const sorted = [...eq].sort((a, b) => this.rank(a) - this.rank(b));
    return sorted.find((x) => { const f = this.byId.get(x); return f ? !perSeed(f) : false; }) ?? sorted[0] ?? id;
  }
  /** Reduce candidate ids to distinct quantities (by value), aggregates first. */
  quantities(ids: readonly string[]): string[] {
    let fs = ids.map((x) => this.byId.get(x)).filter((f): f is Fact => !!f);
    const agg = fs.filter((f) => !perSeed(f));
    if (agg.length) fs = agg;
    fs.sort((a, b) => this.rank(a.id) - this.rank(b.id));
    const out: string[] = [];
    const seen = new Set<string>();
    for (const f of fs) {
      const p = this.primary(f.id);
      const k = this.valueKey(f) ?? f.id;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
    return out;
  }
}

/** The number a candidate match stands for (the fact's value or the named uncertainty), as unit|value. */
function matchedNumberKey(cls: Classes, l: TokenLink, id: string): string | null {
  const f = cls.fact(id);
  if (!f) return null;
  const m = l.matches.find((x) => x.factId === id);
  const field = m?.field ?? 'value';
  let v: number | null;
  if (field.startsWith('unc:')) {
    const u = (f.uncertainties ?? {})[field.slice(4)];
    v = typeof u === 'number' && Number.isFinite(u) ? u : null;
  } else v = factNumber(f);
  if (v === null) return null;
  return `${normalizeUnit(f.unit)}|${Math.abs(v * (m?.scale ?? 1)).toPrecision(12)}`;
}

/** Result row / claim object of a fact: its artifact and its id without the last segment. */
function rowKey(f: Fact | undefined): string | null {
  if (!f) return null;
  const id = String(f.id);
  const cut = id.lastIndexOf('.');
  return cut > 0 ? `${String(f.artifact ?? '')}|${id.slice(0, cut)}` : null;
}

/**
 * Name words of a fact: its id segments (after the 'f.' prefix: artifact stem, row key, column), its
 * definition stem and the row values of its definition ("eff_A (variant=no_edge_features)"), stemmed;
 * one- and two-letter labels dropped.
 */
function nameStems(f: Fact): Set<string> {
  const id = String(f.id).replace(/^f\./, '');
  const meta = [...String(f.definition ?? '').matchAll(/=\s*([^;,)]+)/g)].map((m) => m[1]!).join(' ');
  const words = `${id} ${definitionStem(f)} ${meta}`.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2);
  return new Set(contentStems(words));
}

type Resolution = { id: string; by: 'same_value' | 'row' | 'context' };

/**
 * Pick one candidate of an unlinked numeral that fits facts with different values, for the report only
 * (see NumberOccurrence.resolvedBy). Null when the numeral stays ambiguous.
 */
function resolveForReport(cls: Classes, l: TokenLink, ids: readonly string[], siblingRows: ReadonlySet<string>, sentenceStems: ReadonlySet<string>): Resolution | null {
  // 1. every candidate holds this very number: prefer the uncertainty field of a main fact (groups with "2.49 ± 0.24")
  const keys = new Set(ids.map((id) => matchedNumberKey(cls, l, id)));
  if (keys.size === 1 && !keys.has(null)) {
    const unc = ids.find((id) => (l.matches.find((m) => m.factId === id)?.field ?? 'value') !== 'value');
    return { id: unc ?? ids[0]!, by: 'same_value' };
  }
  // 2. one candidate (as a distinct quantity) shares the row of a number linked in the same sentence
  if (siblingRows.size) {
    const inRow = ids.filter((id) => {
      const k = rowKey(cls.fact(id));
      return k !== null && siblingRows.has(k);
    });
    if (inRow.length && cls.quantities(inRow).length === 1) return { id: inRow[0]!, by: 'row' };
  }
  // 3. one candidate's distinctive name words appear in the sentence
  const qs = cls.quantities(ids);
  const names = qs.map((id) => {
    const f = cls.fact(id);
    return f ? nameStems(f) : new Set<string>();
  });
  const common = names.length ? [...names[0]!].filter((w) => names.every((n) => n.has(w))) : [];
  const scores = names.map((n) => [...n].filter((w) => !common.includes(w) && sentenceStems.has(w)).length);
  const best = Math.max(0, ...scores);
  if (best > 0 && scores.filter((x) => x === best).length === 1) return { id: qs[scores.indexOf(best)]!, by: 'context' };
  return null;
}

function occurrencesOf(units: readonly ConsistencyUnit[], cls: Classes, facts: Fact[], derived: readonly DerivedRelation[]): { occ: Occ[]; unmatched: Occ[] } {
  const occ: Occ[] = [];
  const unmatched: Occ[] = [];
  units.forEach((u, unitIndex) => {
    let toks: NumeralDetail[];
    let links: TokenLink[];
    try {
      toks = extractNumeralDetails(u.text);
      links = resolveLinks(toks, facts, u.facts ?? []);
    } catch {
      return;
    }
    const ref = sentenceRef(u);
    // rows of the numbers this sentence states unambiguously (for 'row' resolution)
    const siblingRows = new Set<string>();
    for (const l of links) {
      if (l.tok.ratioPart || (l.status === 'structural' && !l.linked)) continue;
      const ids = l.linked ? [l.linked] : l.candidates;
      if (!ids.length || (!l.linked && cls.quantities(ids).length > 1)) continue;
      for (const id of ids) {
        const k = rowKey(cls.fact(id));
        if (k) siblingRows.add(k);
      }
    }
    let sentenceStems: Set<string> | null = null;
    for (const l of links) {
      const tok = l.tok;
      if (tok.ratioPart) continue;
      const base = {
        ...ref,
        raw: tok.raw,
        rendering: renderingOf(tok),
        value: tok.value,
        decimals: tok.decimals,
        sigfigs: tok.sigfigs,
        unitIndex,
      };
      if (l.status === 'structural' && !l.linked) continue;
      if (l.linked || l.candidates.length > 0) {
        const ids = l.linked ? [l.linked] : l.candidates;
        const qs = cls.quantities(ids);
        let resolved: Resolution | null = null;
        if (!l.linked && qs.length > 1) {
          sentenceStems ??= new Set(contentStems(plainTokens(plainText(u.text))));
          resolved = resolveForReport(cls, l, ids, siblingRows, sentenceStems);
        }
        const chosen = l.linked ?? resolved?.id ?? null;
        const primary = chosen ? (resolved?.by === 'same_value' ? chosen : cls.primary(chosen)) : (qs[0] ?? ids[0]!);
        const match = l.matches.find((m) => m.factId === (chosen ?? ids[0])) ?? l.matches[0];
        const field = match?.field ?? 'value';
        const fact = cls.fact(primary) ?? null;
        occ.push({
          ...base,
          form: formOf(tok, fact),
          field,
          derived: null,
          ambiguous: !chosen && qs.length > 1,
          candidates: l.linked ? [] : [...ids],
          ...(resolved ? { resolvedBy: resolved.by } : {}),
          key: `${primary}#${field}`,
          pair: null,
          factIds: field === 'value' ? cls.equivalents(primary) : [primary],
        });
        continue;
      }
      const rel = derived.find((d) => derivedRelationMatches(tok, d));
      if (rel) {
        const ids = rel.factIds.map((x) => cls.primary(x));
        const pair = [...ids].sort().join('|');
        occ.push({ ...base, form: formOf(tok, null), field: 'value', derived: rel.description, ambiguous: false, candidates: [], key: `derived:${ids.join('|')}:${rel.kind ?? 'value'}`, pair, factIds: ids });
        continue;
      }
      unmatched.push({ ...base, form: formOf(tok, null), field: 'value', derived: null, ambiguous: false, candidates: [], key: '', pair: null, factIds: [] });
    }
  });
  return { occ, unmatched };
}

/* ------------------------------------------------------------------------------------ */
/* Conditions                                                                            */
/* ------------------------------------------------------------------------------------ */

/** Words that name the compared objects, not a condition ("for the baseline", "with the tracker"). */
const NON_CONDITION = new Set(
  `baseline baselines model models tracker trackers method methods approach approaches network networks paper work section sections
  figure figures fig figs table tables eq eqs equation result results value values case cases other same new old previous former latter
  study analysis comparison reference respect example instance addition contrast particular general average total mean
  one two three four five six seven eight nine ten first second third last end`
    .split(/\s+/)
    .filter(Boolean)
    .map(stemWord),
);

const COND_START = /^(?:on|at|for|in|within|without|with|under|above|below|beyond|after|before|when|if|assuming|given|excluding|including|requiring|using|up)$/;
const COND_STOP = /^(?:than|and|or|but|which|that|while|whereas|compared|against|versus|vs|is|are|was|were|be|been|has|have|had|finds|find|found|gives|give|gave|shows|show|showed|reaches|reach|reached|holds|hold|makes|make|it|we|they|this|these|its|our)$/;

/** A finite verb form ("stays", "grew", "is"): the condition phrase ends before it (participles such as "isolated" stay). */
function verbLike(w: string): boolean {
  if (STYLE_LISTS.AUX.has(w) || STYLE_LISTS.IRREG_PAST.has(w)) return true;
  if (w.length > 3 && w.endsWith('s') && STYLE_LISTS.VERB_BASES.has(w.slice(0, -1)) && !STYLE_LISTS.NOUN_BASES.has(w.slice(0, -1))) return true;
  if (w.length > 4 && w.endsWith('es') && STYLE_LISTS.VERB_BASES.has(w.slice(0, -2))) return true;
  return false;
}

/** Prepositional idioms that never state a condition. */
const IDIOM_RE = /^(?:in\s+(?:favou?r|turn|particular|addition|fact|total|contrast|practice|principle|terms|order|general|summary|short|detail|agreement|line|part|place|case|view|spite)|at\s+(?:least|most|all|first|last|best|worst|once)|for\s+(?:example|instance|comparison|reference|simplicity|clarity|brevity|completeness|convenience|this|that|these|each|both|all)|with\s+(?:respect|regard)|on\s+(?:average|top|the\s+other\s+hand|the\s+contrary)|after\s+all|in\s+the\s+(?:same|other|end|meantime|following))\b/i;

/** Condition phrases of a sentence (preposition + up to six words), with their content stems. */
export function conditionPhrases(latex: string): Array<{ phrase: string; stems: string[] }> {
  const plain = plainText(latex);
  const out: Array<{ phrase: string; stems: string[] }> = [];
  const parts = plain.split(/[,;:()]|\.\s/);
  for (const part of parts) {
    const words = part.split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!.toLowerCase().replace(/[^a-z]/g, '');
      if (!COND_START.test(w)) continue;
      if (w === 'up' && (words[i + 1] ?? '').toLowerCase() !== 'to') continue;
      const phrase: string[] = [words[i]!];
      for (let k = i + 1; k < words.length && phrase.length < 7; k++) {
        const x = words[k]!.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (COND_STOP.test(x) || verbLike(x) || (COND_START.test(x) && phrase.length > 1 && x !== 'to')) break;
        phrase.push(words[k]!);
      }
      if (IDIOM_RE.test(phrase.join(' ') + ' ' + words.slice(i + phrase.length, i + phrase.length + 2).join(' '))) continue;
      const toks = plainTokens(phrase.slice(1).join(' '));
      const stems = contentStems(toks).filter((s) => !NON_CONDITION.has(s) && s.length > 1);
      if (stems.length === 0) continue;
      out.push({ phrase: phrase.join(' ').replace(/[.]+$/, ''), stems: [...new Set(stems)] });
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------ */
/* Main                                                                                  */
/* ------------------------------------------------------------------------------------ */

function canon(o: Occ): string {
  const v = o.form === 'percent' || o.form === 'points' || o.form === 'factor' || o.form === 'unit' ? o.form : o.form === 'ratio' ? 'ratio' : 'number';
  return `${v}:${o.raw.replace(/\{,\}|,|\\,|\s/g, '')}`;
}

const isPercentLike = (f: NumberForm): boolean => f === 'percent';
const isFractionLike = (f: NumberForm): boolean => f === 'fraction' || f === 'plain';

/** Value of a quantity in the units the text uses for `form` (fractions as percent for a percent numeral). */
function factValueIn(f: Fact, form: NumberForm): number | null {
  const v = factNumber(f);
  if (v === null) return null;
  if ((form === 'percent' || form === 'points') && isFractionFact(f)) return v * 100;
  return v;
}

const CONTRIBUTION_RE = /\b(?:in\s+this\s+(?:paper|work|article|letter|study|note|analysis)|in\s+the\s+present\s+(?:paper|work)|here)\s*,?\s+we\b/i;
const WE_VERB_RE = /^(?:we|this\s+(?:paper|work|letter|article|study))\s+(?:present|propose|introduce|report|describe|show|demonstrate|train|study|studie|develop|measure|search|test|investigate|compare|build|construct|ask|address|answer)(?:s|es)?\b/i;

/**
 * Echo check over the units of the whole project, in document order (see orderUnits). Pure and
 * deterministic; never throws on odd input (a unit it cannot read is skipped).
 */
export function echoCheck(units: readonly ConsistencyUnit[], facts: readonly Fact[], outline: Outline | null | undefined, opts: EchoOptions = {}): EchoReport {
  const us = (Array.isArray(units) ? units : []).filter((u) => u && typeof u.text === 'string' && !u.orphaned);
  const fs = (Array.isArray(facts) ? facts : []).filter((f) => f && typeof f.id === 'string' && !f.excluded);
  const cls = new Classes(fs);
  const derived = (opts.derived ?? []).filter((d) => d && typeof d === 'object');
  const tolerance = opts.driftTolerance ?? 0.05;
  const { occ, unmatched } = occurrencesOf(us, cls, fs, derived);
  const flags: ConsistencyFlag[] = [];

  // ---------------------------------------------------------------- quantities
  const byKey = new Map<string, Occ[]>();
  for (const o of occ) {
    const list = byKey.get(o.key);
    if (list) list.push(o);
    else byKey.set(o.key, [o]);
  }
  const quantities: EchoQuantity[] = [];
  for (const [key, list] of byKey) {
    const first = list[0]!;
    const primary = key.startsWith('derived:') ? first.factIds.join('|') : key.slice(0, key.lastIndexOf('#'));
    const f = cls.fact(primary.split('|')[0]!);
    const parts = PART_ORDER.filter((p) => list.some((o) => o.part === p));
    const renderings: string[] = [];
    for (const o of list) if (!renderings.includes(o.rendering)) renderings.push(o.rendering);
    quantities.push({
      key,
      primaryFactId: key.startsWith('derived:') ? first.factIds[0]! : primary,
      factIds: first.factIds,
      field: first.field,
      definition: key.startsWith('derived:') ? (first.derived ?? '') : (f?.definition ?? ''),
      stale: first.factIds.some((id) => cls.fact(id)?.stale === true),
      occurrences: list.map(strip),
      parts,
      renderings,
    });
    // drift: one quantity, several renderings
    // drift compares digits only: words ("twice", "zero") and ambiguous numerals are reported, not compared
    const canons = new Map<string, Occ[]>();
    for (const o of list.filter((x) => x.form !== 'words' && !x.ambiguous)) {
      const c = canon(o);
      const l = canons.get(c);
      if (l) l.push(o);
      else canons.set(c, [o]);
    }
    if (canons.size > 1) {
      const cmp = [...canons.values()].flat();
      const forms = new Set(cmp.map((o) => o.form));
      const crossParts = new Set(cmp.map((o) => o.part)).size > 1;
      const desc = [...canons.values()].map((os) => `"${os[0]!.rendering}" (${[...new Set(os.map((o) => o.part))].join(', ')})`).join(' vs ');
      const ids = cmp.map((o) => o.sentenceId!).filter(Boolean);
      const what = key.startsWith('derived:') ? (first.derived ?? key) : primary;
      // a numeral the report assigned by its wording only makes the flag a heuristic
      const byContext = cmp.some((o) => o.resolvedBy === 'context');
      if ([...forms].some(isPercentLike) && [...forms].some(isFractionLike)) {
        flags.push(makeFlag('drift_form', { subject: key, heuristic: byContext, factIds: first.factIds.slice(0, 1), sentenceIds: ids, message: `${what} is written as a percent in one place and as a fraction in another: ${desc}. Use one form.` }));
      } else if (!(forms.has('factor') && forms.has('percent'))) {
        flags.push(
          makeFlag('drift_precision', {
            subject: key,
            severity: crossParts ? 'warn' : 'info',
            heuristic: byContext,
            factIds: first.factIds.slice(0, 1),
            sentenceIds: ids,
            message: `${what} is stated with different precision${crossParts ? ' across parts' : ''}: ${desc}. Quote it the same way everywhere (the abstract and conclusions echo the body).`,
          }),
        );
      }
    }
    // ambiguous numerals
    const amb = list.filter((o) => o.ambiguous && o.form !== 'words');
    if (amb.length) {
      flags.push(
        makeFlag('ambiguous_number', {
          subject: key,
          severity: 'info',
          factIds: [...new Set(amb.flatMap((o) => cls.quantities(o.candidates)))],
          sentenceIds: amb.map((o) => o.sentenceId!).filter(Boolean),
          message: `"${amb[0]!.rendering}" fits several facts with different values (${cls.quantities(amb[0]!.candidates).slice(0, 4).join(', ')}); link the one you mean.`,
        }),
      );
    }
  }

  // ---------------------------------------------------------------- factor versus percent, per fact pair
  {
    const byPair = new Map<string, Occ[]>();
    for (const o of occ) {
      const pair = o.pair ?? (o.field === 'value' ? cls.primary(o.factIds[0] ?? '') : null);
      if (!pair) continue;
      const l = byPair.get(pair);
      if (l) l.push(o);
      else byPair.set(pair, [o]);
    }
    for (const [pair, list] of byPair) {
      const factor = list.filter((o) => o.form === 'factor' || (o.form === 'words' && /times|fold|twice|thrice|half|factor|double|triple/i.test(o.rendering)));
      const pct = list.filter((o) => o.form === 'percent');
      if (factor.length && pct.length) {
        flags.push(
          makeFlag('factor_percent', {
            subject: pair,
            factIds: pair.split('|'),
            sentenceIds: [...factor, ...pct].map((o) => o.sentenceId!).filter(Boolean),
            message: `The same comparison (${pair.split('|').join(', ')}) is stated as a factor ("${factor[0]!.rendering}", ${factor[0]!.part}) and as a percent ("${pct[0]!.rendering}", ${pct[0]!.part}); keep one form throughout.`,
          }),
        );
      }
    }
  }

  // ---------------------------------------------------------------- drifted copies that equal a per-seed value
  // "96.84%" in the conclusions against "96.94%" (the mean of three seeds) in the abstract: a one-digit
  // typo that happens to be one seed's value. A sentence that does not speak of seeds does not state a
  // per-seed value, so such a copy is a drifted copy of the aggregate.
  {
    for (const [key, list] of byKey) {
      if (key.startsWith('derived:')) continue;
      const f = cls.fact(key.slice(0, key.lastIndexOf('#')));
      if (!f || !perSeed(f)) continue;
      for (const o of list) {
        if (o.field !== 'value' || o.value === 0) continue;
        const u = us[o.unitIndex];
        if (!u || /\bseeds?\b|\bper[-\s]seed\b|\brandom\s+initiali[sz]ation/i.test(plainText(u.text))) continue;
        let best: { key: string; o: Occ; d: number } | null = null;
        for (const [k2, l2] of byKey) {
          if (k2 === key || k2.startsWith('derived:')) continue;
          const f2 = cls.fact(k2.slice(0, k2.lastIndexOf('#')));
          if (!f2 || perSeed(f2) || l2[0]!.field !== 'value') continue;
          const sameForm = l2.find((x) => x.form === o.form);
          if (!sameForm) continue;
          const fv = factValueIn(f2, o.form);
          if (fv === null || fv === 0) continue;
          const d = Math.abs(Math.abs(o.value) - Math.abs(fv)) / Math.abs(fv);
          if (d > 0 && d <= tolerance && (!best || d < best.d)) best = { key: k2, o: sameForm, d };
        }
        if (!best) continue;
        const fid = best.key.slice(0, best.key.lastIndexOf('#'));
        flags.push(
          makeFlag('drift_value', {
            subject: `${fid}|${o.sentenceId}|${o.raw}`,
            heuristic: true,
            factIds: [fid, f.id],
            sentenceIds: [o.sentenceId!, best.o.sentenceId!].filter(Boolean),
            message: `"${o.rendering}" (${o.part}) is the per-seed value ${f.id}, but the sentence does not speak of seeds; ${fid} is written "${best.o.rendering}" (${best.o.part}). An old or mistyped copy?`,
          }),
        );
      }
    }
  }

  // ---------------------------------------------------------------- drifted copies (unmatched near a stated quantity)
  const unmatchedOut: NumberOccurrence[] = [];
  for (const u of unmatched) {
    unmatchedOut.push(strip(u));
    if (!['percent', 'points', 'unit', 'fraction', 'plain'].includes(u.form) || u.value === 0) continue;
    let best: { key: string; o: Occ; d: number } | null = null;
    for (const [key, list] of byKey) {
      if (key.startsWith('derived:')) continue;
      const o = list[0]!;
      if (o.field !== 'value') continue;
      const sameForm = list.find((x) => x.form === u.form);
      if (!sameForm) continue;
      const f = cls.fact(key.slice(0, key.lastIndexOf('#')));
      const fv = f ? factValueIn(f, u.form) : null;
      if (fv === null || fv === 0) continue;
      const d = Math.abs(Math.abs(u.value) - Math.abs(fv)) / Math.abs(fv);
      if (d > 0 && d <= tolerance && (!best || d < best.d)) best = { key, o: sameForm, d };
    }
    if (best) {
      const fid = best.key.slice(0, best.key.lastIndexOf('#'));
      flags.push(
        makeFlag('drift_value', {
          subject: `${fid}|${u.sentenceId}|${u.raw}`,
          heuristic: true,
          factIds: [fid],
          sentenceIds: [u.sentenceId!, best.o.sentenceId!].filter(Boolean),
          message: `"${u.rendering}" (${u.part}) matches no fact but is close to ${fid}, written "${best.o.rendering}" (${best.o.part}); an old or mistyped copy?`,
        }),
      );
    }
  }

  // ---------------------------------------------------------------- stale facts
  const stale: EchoReport['stale'] = [];
  {
    const staleFacts = fs.filter((f) => f.stale);
    for (const f of staleFacts) {
      const sids = new Set<string>();
      const refs: SentenceRef[] = [];
      us.forEach((u, i) => {
        const viaLink = (u.facts ?? []).includes(f.id);
        const viaNum = occ.some((o) => o.unitIndex === i && o.factIds.includes(f.id));
        if ((viaLink || viaNum) && !sids.has(u.id)) {
          sids.add(u.id);
          refs.push(sentenceRef(u));
        }
      });
      if (refs.length === 0) continue;
      stale.push({ factId: f.id, definition: f.definition, sentences: refs });
      flags.push(makeFlag('stale_fact', { subject: f.id, factIds: [f.id], sentenceIds: [...sids], message: `${f.id} changed in ${f.artifact} since it was linked; reread ${refs.length} sentence${refs.length === 1 ? '' : 's'} that state it.` }));
    }
  }

  // ---------------------------------------------------------------- conditions dropped
  {
    // per unit, computed once: a numeral-dense unit has many occurrences (re-parsing it per occurrence was quadratic)
    const phrasesOf = new Map<number, Array<{ phrase: string; stems: string[] }>>();
    const haveOf = new Map<number, Set<string>>();
    for (const [key, list] of byKey) {
      const heads = list.filter((o) => o.part === 'abstract' || o.part === 'concl');
      const bodies = list.filter((o) => o.part === 'body' || o.part === 'intro' || o.part === 'app' || o.part === 'caption');
      if (!heads.length || !bodies.length) continue;
      const bodyPhrases = new Map<string, { phrase: string; stems: string[]; sentenceId: string }>();
      for (const b of bodies) {
        let phrases = phrasesOf.get(b.unitIndex);
        if (!phrases) phrasesOf.set(b.unitIndex, (phrases = conditionPhrases(us[b.unitIndex]!.text)));
        for (const c of phrases) if (!bodyPhrases.has(c.phrase.toLowerCase())) bodyPhrases.set(c.phrase.toLowerCase(), { ...c, sentenceId: b.sentenceId! });
      }
      const doneHead = new Set<number>();
      for (const h of heads) {
        if (doneHead.has(h.unitIndex)) continue;
        doneHead.add(h.unitIndex);
        const here = us[h.unitIndex]!;
        const prev = us[h.unitIndex - 1];
        const ctx = here.text + (prev && prev.part === here.part ? ' ' + prev.text : '');
        let have = haveOf.get(h.unitIndex);
        if (!have) haveOf.set(h.unitIndex, (have = new Set(plainTokens(plainText(ctx)).map(stemWord))));
        const dropped = [...bodyPhrases.values()].filter((c) => c.stems.every((s) => !have.has(s)));
        if (!dropped.length) continue;
        const what = key.startsWith('derived:') ? (h.derived ?? key) : key.slice(0, key.lastIndexOf('#'));
        flags.push(
          makeFlag('condition_dropped', {
            subject: `${key}|${h.sentenceId}`,
            heuristic: true,
            factIds: h.factIds.slice(0, 2),
            sentenceIds: [h.sentenceId!, ...dropped.map((d) => d.sentenceId)].filter(Boolean),
            message: `"${h.rendering}" (${what}) in the ${h.part === 'abstract' ? 'abstract' : 'conclusions'} lacks the condition the body states with it: ${dropped
              .slice(0, 3)
              .map((d) => `"${d.phrase}"`)
              .join(', ')}. Heuristic: check that the number travels with its condition.`,
          }),
        );
      }
    }
  }

  // ---------------------------------------------------------------- key phrase
  const keyPhrase = String(outline?.story?.keyPhrase ?? '').trim();
  const abstractUnits = us.filter((u) => u.part === 'abstract');
  const conclUnits = us.filter((u) => u.part === 'concl');
  const introUnits = us.filter((u) => u.part === 'intro');
  let contributionUnit: ConsistencyUnit | null = introUnits.find((u) => CONTRIBUTION_RE.test(plainText(u.text))) ?? null;
  if (!contributionUnit) contributionUnit = introUnits.find((u) => WE_VERB_RE.test(plainText(u.text).trim())) ?? null;
  if (!contributionUnit) contributionUnit = us.find((u) => (u.part === 'body' || u.part === 'intro') && CONTRIBUTION_RE.test(plainText(u.text))) ?? null;
  const locations: KeyPhraseLocation[] = [];
  if (keyPhrase) {
    const locate = (where: KeyPhraseLocation['where'], group: ConsistencyUnit[] | null, title?: string | null): KeyPhraseLocation => {
      if (where === 'title') {
        if (!title) return { where, status: 'absent', sentenceIds: [], matched: null };
        const m = matchPhrase(keyPhrase, title, true);
        return { where, status: m.status, sentenceIds: [], matched: m.matched };
      }
      if (!group || group.length === 0) return { where, status: 'absent', sentenceIds: [], matched: null };
      let best: { status: 'present' | 'partial'; ids: string[]; matched: string | null } | null = null;
      for (const u of group) {
        const m = matchPhrase(keyPhrase, u.text);
        if (m.status === 'present') {
          if (!best || best.status !== 'present') best = { status: 'present', ids: [u.id], matched: m.matched };
          else best.ids.push(u.id);
        } else if (m.status === 'partial' && !best) best = { status: 'partial', ids: [u.id], matched: m.matched };
      }
      return best ? { where, status: best.status, sentenceIds: best.ids, matched: best.matched } : { where, status: 'missing', sentenceIds: [], matched: null };
    };
    const title = opts.title ? (/\\/.test(opts.title) ? plainText(opts.title) : opts.title) : null;
    locations.push(locate('title', null, title));
    locations.push(locate('abstract', abstractUnits));
    locations.push(locate('contribution', contributionUnit ? [contributionUnit] : null));
    locations.push(locate('conclusions', conclUnits));
    for (const l of locations) {
      if (l.status === 'missing' || (l.status === 'absent' && l.where !== 'contribution')) {
        if (l.status === 'absent' && l.where === 'title' && opts.title === undefined) continue;
        flags.push(makeFlag('key_phrase_missing', { subject: l.where, term: keyPhrase, sentenceIds: l.sentenceIds, message: `The key phrase "${keyPhrase}" is not in the ${l.where === 'contribution' ? 'contribution sentence' : l.where}${l.status === 'absent' ? ` (there is no ${l.where})` : ''}; the story is echoed in title, abstract, contribution and conclusions.` }));
      } else if (l.status === 'partial') {
        flags.push(makeFlag('key_phrase_partial', { subject: l.where, severity: 'info', term: keyPhrase, sentenceIds: l.sentenceIds, message: `The ${l.where === 'contribution' ? 'contribution sentence' : l.where} has the words of "${keyPhrase}" but not the phrase (${l.matched ?? ''}); echo it verbatim.` }));
      }
    }
  }
  if (!contributionUnit && introUnits.length > 0) {
    flags.push(makeFlag('no_contribution_sentence', { subject: 'intro', severity: 'info', message: 'The introduction has no contribution sentence ("In this paper, we ..."); readers look for one at the end of the first page.' }));
  }

  // ---------------------------------------------------------------- headline
  const hl = outline?.headline;
  const headlineId = hl?.factId ?? null;
  const baselineId = hl?.baselineFactId ?? null;
  const condition = String(hl?.condition ?? '').trim();
  const places: HeadlinePlace[] = [];
  if (headlineId) {
    const hq = new Set(cls.equivalents(headlineId));
    const bq = baselineId ? new Set(cls.equivalents(baselineId)) : null;
    const hFact = cls.fact(headlineId) ?? null;
    const factsIn = (i: number): string[] => [...new Set(occ.filter((o) => o.unitIndex === i).flatMap((o) => o.factIds))];
    const hasHeadline = (i: number): boolean => {
      const ids = factsIn(i);
      if (ids.some((x) => hq.has(x))) return true;
      // a difference or ratio stated through its two terms ("95.52% compared with 93.03%")
      const hv = hFact ? factNumber(hFact) : null;
      if (hv === null || hv === 0) return false;
      const nums = ids.map((x) => cls.fact(x)).filter((f): f is Fact => !!f && factNumber(f) !== null);
      for (let a = 0; a < nums.length; a++) {
        for (let b = 0; b < nums.length; b++) {
          if (a === b) continue;
          const va = factNumber(nums[a]!)!;
          const vb = factNumber(nums[b]!)!;
          const scale = isFractionFact(nums[a]!) && isFractionFact(nums[b]!) && normalizeUnit(hFact!.unit) !== '' ? 100 : 1;
          const cands = [(va - vb) * scale, vb !== 0 ? va / vb : NaN];
          if (cands.some((c) => Number.isFinite(c) && Math.abs(c - hv) <= 1e-6 * Math.max(1, Math.abs(hv)))) return true;
        }
      }
      return false;
    };
    for (const where of ['abstract', 'conclusions'] as const) {
      const part: Part = where === 'abstract' ? 'abstract' : 'concl';
      const idxs = us.map((u, i) => ({ u, i })).filter(({ u }) => u.part === part);
      const hits = idxs.filter(({ i }) => hasHeadline(i));
      let baselinePresent: boolean | null = null;
      const otherBaselines = new Set<string>();
      let conditionPresent: boolean | null = null;
      if (hits.length) {
        if (bq) {
          baselinePresent = hits.some(({ i }) => [i, i + 1].some((j) => us[j]?.part === part && factsIn(j).some((x) => bq.has(x))));
          if (!baselinePresent) {
            // other facts of the baseline's family (a fraction for a fraction, the same unit otherwise)
            const bFact = cls.fact(baselineId!);
            const family = (f: Fact | undefined): string => (f ? (isFractionFact(f) ? 'fraction' : normalizeUnit(f.unit)) : '?');
            for (const { i } of hits) for (const x of factsIn(i)) if (!hq.has(x) && !bq.has(x) && family(cls.fact(x)) === family(bFact)) otherBaselines.add(cls.primary(x));
          }
        }
        if (condition) {
          const need = contentStems(plainTokens(condition));
          conditionPresent = need.length === 0 || hits.some(({ i }) => {
            const ctx = [us[i - 1], us[i], us[i + 1]].filter((x): x is ConsistencyUnit => !!x && x.part === part).map((x) => x.text).join(' ');
            const have = new Set(plainTokens(plainText(ctx)).map(stemWord));
            return need.filter((s) => have.has(s)).length * 2 >= need.length;
          });
        }
      }
      const place: HeadlinePlace = { where, present: hits.length > 0, sentenceIds: hits.map(({ u }) => u.id), baselinePresent, otherBaselines: [...otherBaselines], conditionPresent };
      places.push(place);
      if (idxs.length === 0) continue;
      const label = headlineId;
      if (!place.present) {
        flags.push(makeFlag('headline_missing', { subject: where, factIds: [headlineId], message: `The headline number (${label}) is not stated in the ${where}; the ${where} should give it with its baseline.` }));
      } else {
        if (baselinePresent === false) {
          flags.push(
            makeFlag('headline_baseline', {
              subject: where,
              factIds: [headlineId, baselineId!, ...otherBaselines],
              sentenceIds: place.sentenceIds,
              message: `In the ${where} the headline (${label}) appears without its baseline ${baselineId}${otherBaselines.size ? `; it is compared with ${[...otherBaselines].join(', ')} instead` : ''}.`,
            }),
          );
        }
        if (conditionPresent === false) {
          flags.push(makeFlag('headline_condition', { subject: where, heuristic: true, factIds: [headlineId], sentenceIds: place.sentenceIds, message: `In the ${where} the headline (${label}) appears without its condition "${shorten(condition, 80)}". Heuristic (content words).` }));
        }
      }
    }
  }

  return {
    quantities,
    unmatched: unmatchedOut,
    stale,
    keyPhrase: { phrase: keyPhrase, locations },
    contribution: contributionUnit ? sentenceRef(contributionUnit) : null,
    headline: { factId: headlineId, baselineFactId: baselineId, condition, places },
    flags,
  };
}

function strip(o: Occ): NumberOccurrence {
  const { key: _k, unitIndex: _u, pair: _p, factIds: _f, ...rest } = o;
  return rest;
}
