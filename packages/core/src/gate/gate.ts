/**
 * The faithfulness gate: one pure function that every AI sentence passes before it is shown
 * (ghost), stored (draft hook) or offered (rewrite/alternatives/grammar/intent rendering).
 *
 * OWNER: core-gate agent.
 *
 * Checks (docs/design.md, "Faithfulness and provenance"):
 * 1. numbers: every non-structural numeral matches a fact (matchNumeral), or an uncertainty of a fact
 *    linked in the same sentence, or a declared derived relation, or a number typed in the author's
 *    intent note (then it is 'unlinked', severity warn). Otherwise 'unmatched_number' (block) and the
 *    numeral is replaced in `repaired` by `[fact?: <8 words of context>]`.
 *    Percent written for a fraction fact without x100 (or vice versa) -> 'percent_scale' (block).
 *    The same fact stated as a factor and as a percent in one sentence -> 'factor_percent' (warn).
 * 2. cuts/definitions: a numeral with a unit (GeV, mm, ...) next to a comparison (`>`, `<`, `\geq`,
 *    "above", "below", "at least") must match a fact of kind 'cut'/'definition'/'setting', else
 *    'unmatched_cut' (block).
 * 3. citations: every \cite key must be in ctx.allowedCiteKeys (in rewrite | grammar mode also the keys
 *    the original sentence already cites), else 'unknown_cite' (block) and the
 *    \cite{..} is replaced by `[ref]` in `repaired`. Every \ref target must be in ctx.knownLabels, else
 *    'unknown_ref' (block).
 * 4. LaTeX invariance (mode rewrite | grammar): compareLatexInvariance(ctx.original, text) must be ok,
 *    else 'latex_changed' (block).
 * 5. fictional numbers: a numeral equal to one of ctx.fictionalNumbers that is not also a fact value ->
 *    'fictional_number' (block; the skill's reference examples are invented).
 * 6. placeholders: two identical placeholders in one sentence -> 'duplicate_placeholder' (warn).
 * 7. claim strength (warn): exclude/rule out need a limit fact with CL >= 95% in the sentence's facts;
 *    demonstrate/establish/prove need validationState >= reproduced on a linked fact; a result verb
 *    (improve, outperform, better, higher, lower, gain, boost) with no linked fact and no placeholder ->
 *    'claim_strength'.
 * 8. text sanity: CJK characters in paper text -> 'cjk_in_text' (block); more than ctx.maxWords words
 *    -> 'too_long' (block in ghost mode, warn otherwise); output that reads like model reasoning or
 *    chat ("Let me", "I will", "Here is", "Sure", "The next sentence", leading/trailing quotes or
 *    markdown) -> 'reasoning_leak' (block); empty -> 'empty' (block).
 * `ok` is true iff there is no 'block' issue. The function never throws on odd input.
 *
 * Additions beyond the list above (all codes are reported on the wire as plain strings):
 * - 'unlinked_number' (warn): a numeral accepted only because the author typed it in the intent note.
 * - 'number_changed' (warn, modes rewrite | grammar): a number of the original sentence is missing from
 *   the rewrite (the skill: keep every number; dropping one is not an invention but must be reread).
 * - 'bad_latex' (block): an unescaped `%` after a number, which comments out the rest of the line.
 * - 'gate_error' (block): an internal failure; the gate fails closed.
 * - 'loose_number' (warn): a result restated in words ("ninety-seven percent") or as a rough ratio
 *   ("9 out of 10") that does match a fact; linked, and the author is asked for the measured numeral.
 * - 'direction' (block or warn): an unsigned numeral linked to a signed difference fact whose nearest
 *   direction word ("rises", "lower", "fewer") contradicts the sign (block when the fact is negative or
 *   the "A minus B" definition shows which side the sentence speaks from; warn otherwise), or the
 *   magnitude of a negative fact with no direction word (warn).
 * - 'meaning_changed': grammar mode (block) when the "fix" adds or removes a negation, flips a
 *   direction word, or substitutes more than a few content words (gate/meaning.ts; offer it as a
 *   rewrite instead); rewrite mode (warn) when a negation or direction word changed.
 * Each numeral gets at most one number issue, in this order: fictional_number, percent_scale,
 * unmatched_cut, then the intent note (whose percent/points form must agree with the text, else
 * percent_scale), unmatched_number. Word numerals ("thirty percent", "twice", "halves", "a hundredfold",
 * "an order of magnitude") are numerals like any other; a factor only matches a dimensionless
 * non-fraction fact or a derived relation. An uncertainty (± u, compact, asymmetric) only matches an
 * uncertainty recorded for the fact its value is linked to (or a standalone uncertainty fact), never an
 * unrelated fact that happens to have the same value. Structural numerals (Sec. 3, Fig. 2, years next
 * to a citation, list markers, bare integers 0-10 such as "three seeds") are not checked, except: a
 * small integer after a comparison ("at least 3 space points", "$|\eta| < 2$") must match a cut,
 * definition or setting fact (else 'unmatched_cut'); a ratio "N out of M" must match a fraction fact;
 * a small digit count of something that is not structure ("8 GPUs") must match a fact in ghost and
 * draft modes (else 'unmatched_number' block) and is warned in the other modes unless the original
 * sentence already has it.
 */
import type { Fact } from '../schemas';
import { compareLatexInvariance, findPlaceholders, latexTokensOf, scanLatex } from '../latex/tokens';
import { extractNumeralDetails, normalizeUnit as normUnit, relaxedOnlyMatches, resolveLinks, type NumeralDetail, type TokenLink } from '../facts/numbers';
import { claimStrengthIssues, confidenceLevelOf } from './claims';
import { directionWords, grammarOnlyReasons, meaningChange, type Direction } from './meaning';
import { cleanWords, countWords, findCjk, findReasoningLeak, placeholderSafe } from './text';

export type GateMode = 'ghost' | 'draft' | 'rewrite' | 'grammar' | 'intent';

export type GateIssueCode =
  | 'unmatched_number'
  | 'unmatched_cut'
  | 'percent_scale'
  | 'factor_percent'
  | 'unknown_cite'
  | 'unknown_ref'
  | 'latex_changed'
  | 'fictional_number'
  | 'duplicate_placeholder'
  | 'claim_strength'
  | 'cjk_in_text'
  | 'too_long'
  | 'reasoning_leak'
  | 'empty'
  | 'unlinked_number'
  | 'number_changed'
  | 'bad_latex'
  | 'loose_number'
  | 'direction'
  | 'meaning_changed'
  | 'gate_error';

export interface GateIssue {
  code: GateIssueCode;
  severity: 'block' | 'warn';
  message: string;
  start?: number;
  end?: number;
  raw?: string;
}

/**
 * A number the AI may write because it is derived from facts, e.g. a ratio of two facts
 * (meta/derived.ts `derivedRelations` builds them; the wire shape is `DerivedRelationSchema` in api.ts).
 * Without `form` the relation matches any numeral with its value at the numeral's precision (or its
 * `raw` rendering), as before. With `form` the numeral must also be written that way:
 * - 'factor': "2.5 times", "a factor of 2.5", "2.5-fold", "twice" (a bare "2.5" is not a ratio);
 * - 'points': "2.3 points" / "percentage points";
 * - 'percent': "60\%" / "60 percent";
 * - 'fraction': a ratio "N out of M" (|N/M - value| <= 0.5/M), a percent (value x 100) or a bare decimal.
 * `maxSigfigs`: a numeral written with more significant figures does not match (ratios are quoted to 1-2).
 */
export interface DerivedRelation {
  value: number;
  /** Rendering the gate accepts, e.g. "2.4". */
  raw: string;
  factIds: string[];
  description: string;
  kind?: 'ratio' | 'difference' | 'relative' | 'share';
  form?: 'factor' | 'points' | 'percent' | 'fraction';
  maxSigfigs?: number;
  renderings?: string[];
}

export interface GateContext {
  mode: GateMode;
  facts: Fact[];
  allowedCiteKeys: string[];
  knownLabels: string[];
  fictionalNumbers: string[];
  /** The author's intent note; numerals typed there pass as 'unlinked' (warn). */
  intentText?: string | null;
  /** The sentence being rewritten (modes rewrite | grammar). */
  original?: string | null;
  /** Ghost: 35. Default: no limit. */
  maxWords?: number | null;
  derived?: DerivedRelation[];
  /** Fact ids the model claimed it used (tie-breaker for ambiguous numerals). */
  claimedFactIds?: string[];
}

export interface GateResult {
  ok: boolean;
  issues: GateIssue[];
  /** `text` with violations replaced by visible placeholders (never silently "fixed" otherwise). */
  repaired: string;
  /** Facts linked by numerals (plus claimed facts that appear). */
  factIds: string[];
  citeKeys: string[];
  /** Numerals accepted only because they appear in the intent note. */
  unlinked: string[];
  placeholders: string[];
}

/** Default word limit of a ghost sentence (docs/design.md, ghost request constraints). */
export const GHOST_MAX_WORDS = 35;

const CUT_KINDS = new Set(['cut', 'definition', 'setting']);

/** Facts a "comparison + unit" numeral may stand for: cuts, definitions, settings, and limits ("excluded below 1.2 TeV"). */
function cutLike(f: Fact | undefined): boolean {
  if (!f) return false;
  if (CUT_KINDS.has(f.kind)) return true;
  if ((f.tags ?? []).some((t) => /^(?:limit|bound|reach|cl[:=_-]?\d+)/i.test(t))) return true;
  return /\b(?:limits?|bounds?|reach|exclusion|excluded|confidence level|CL)\b/i.test(f.definition ?? '');
}

function arr<T>(x: unknown): T[] {
  return Array.isArray(x) ? (x as T[]) : [];
}

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

/** Normalized numeral text for exact comparisons ("8{,}710" -> "8710", "1.2\times10^{-4}" -> "1.2e-4"). */
function normRaw(raw: string): string {
  return raw
    .replace(/\{,\}|,|\\,|\u2009|\s|\$|\\%|%|~/g, '')
    .replace(/^\+/, '')
    .replace(/−/g, '-')
    .replace(/(?:\\times|×|\\cdot|·|x)10\^\{?([+-]?\d+)\}?/, 'e$1')
    .replace(/^10\^\{?([+-]?\d+)\}?$/, '1e$1');
}

function sameValue(a: number, b: number): boolean {
  return Math.abs(Math.abs(a) - Math.abs(b)) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Parse a fictional-number string ("1.2", "87.8%", "300", "1,200") into a value, or null. */
function parseLooseNumber(s: string): number | null {
  const t = String(s ?? '')
    .replace(/\{,\}|,|\\,|\s|\$|\\%|%|~/g, '')
    .replace(/−/g, '-');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/** Does a derived relation account for this numeral (same rendering, or its value at the numeral's precision)? */
function derivedMatch(tok: NumeralDetail, rel: DerivedRelation): boolean {
  if (!rel) return false;
  if (rel.form !== undefined) return derivedFormMatch(tok, rel);
  if (tok.ratioDen !== null) return false; // "9 out of 10" is the ratio 0.9, never the number 9
  if (typeof rel.value !== 'number' || !Number.isFinite(rel.value)) {
    return typeof rel.raw === 'string' && normRaw(rel.raw) === normRaw(tok.raw);
  }
  if (typeof rel.raw === 'string' && rel.raw && normRaw(rel.raw) === normRaw(tok.raw)) return true;
  const tol = 0.5 * Math.pow(10, tok.exponent - tok.decimals);
  return Math.abs(Math.abs(rel.value) - Math.abs(tok.value)) <= tol * (1 + 1e-9) + 1e-12;
}

/**
 * Does `rel` account for numeral `tok` (as the gate reads it)? Exported for the Consistency view, which
 * must attribute a numeral to the same relation the gate accepted it for.
 */
export function derivedRelationMatches(tok: NumeralDetail, rel: DerivedRelation): boolean {
  try {
    return derivedMatch(tok, rel);
  } catch {
    return false;
  }
}

/** Form-aware match of a typed derived relation (see DerivedRelation). */
function derivedFormMatch(tok: NumeralDetail, rel: DerivedRelation): boolean {
  if (typeof rel.value !== 'number' || !Number.isFinite(rel.value) || tok.isUncertainty) return false;
  const v = Math.abs(rel.value);
  const tol = 0.5 * Math.pow(10, tok.exponent - tok.decimals);
  const near = (x: number, t: number): boolean => Math.abs(x - Math.abs(tok.value)) <= t * (1 + 1e-9) + 1e-12;
  const plain = !tok.percent && !tok.points && !tok.unit && tok.ratioDen === null;
  if (typeof rel.maxSigfigs === 'number' && !tok.word && tok.ratioDen === null && tok.sigfigs > rel.maxSigfigs) return false;
  switch (rel.form) {
    case 'factor':
      return tok.factor && !tok.percent && !tok.points && near(v, tol);
    case 'points':
      return tok.points && !tok.factor && near(v, tol);
    case 'percent':
      return tok.percent && !tok.factor && near(v, tol);
    case 'fraction': {
      if (tok.factor) return false;
      if (tok.ratioDen !== null) return tok.ratioDen > 0 && Math.abs(tok.value / tok.ratioDen - v) <= 0.5 / tok.ratioDen + 1e-12;
      if (tok.percent) return near(v * 100, tol);
      return plain && v <= 1 && near(v, tol);
    }
    default:
      return false;
  }
}

interface Replacement {
  start: number;
  end: number;
  text: string;
}

function applyReplacements(text: string, reps: Replacement[]): string {
  const sorted = [...reps].sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Replacement[] = [];
  let lastEnd = -1;
  for (const r of sorted) {
    if (r.start < lastEnd) continue; // overlapping: keep the first (outer) one
    kept.push(r);
    lastEnd = r.end;
  }
  let out = '';
  let pos = 0;
  for (const r of kept) {
    out += text.slice(pos, r.start) + r.text;
    pos = r.end;
  }
  return out + text.slice(pos);
}

function blockResult(text: string, issue: GateIssue): GateResult {
  return { ok: false, issues: [issue], repaired: text, factIds: [], citeKeys: [], unlinked: [], placeholders: [] };
}

export function gateSentence(text: string, ctx: GateContext): GateResult {
  const t = typeof text === 'string' ? text : text === null || text === undefined ? '' : String(text);
  try {
    return gateImpl(t, ctx ?? ({ mode: 'draft' } as GateContext));
  } catch (err) {
    return blockResult(t, {
      code: 'gate_error',
      severity: 'block',
      message: `The faithfulness gate failed on this sentence (${err instanceof Error ? err.message : String(err)}); it is not shown as grounded.`,
    });
  }
}

function gateImpl(t: string, ctx: GateContext): GateResult {
  const mode: GateMode = (['ghost', 'draft', 'rewrite', 'grammar', 'intent'] as const).includes(ctx.mode) ? ctx.mode : 'draft';
  const facts = arr<Fact>(ctx.facts).filter((f) => f && typeof f.id === 'string');
  const allowed = new Set(arr<string>(ctx.allowedCiteKeys).map((k) => String(k).trim()));
  const labels = new Set(arr<string>(ctx.knownLabels).map((k) => String(k).trim()));
  const claimed = arr<string>(ctx.claimedFactIds).filter((x) => typeof x === 'string');
  const derived = arr<DerivedRelation>(ctx.derived).filter((d) => d && typeof d === 'object');
  const issues: GateIssue[] = [];
  const reps: Replacement[] = [];

  // ---------------------------------------------------------------- 8. empty
  const scan = scanLatex(t);
  let visible = '';
  {
    let pos = 0;
    for (const c of scan.comments) {
      visible += t.slice(pos, c.start);
      pos = c.end;
    }
    visible += t.slice(pos);
  }
  if (!visible.trim()) {
    return blockResult(t, { code: 'empty', severity: 'block', message: 'The model returned no sentence.' });
  }

  // ---------------------------------------------------------------- 8. text sanity
  const cjk = findCjk(t);
  if (cjk) {
    issues.push({ code: 'cjk_in_text', severity: 'block', message: `Chinese/CJK characters ("${cjk.raw}") must not reach the paper text; the paper is in English.`, start: cjk.start, end: cjk.end, raw: cjk.raw });
  }
  // math and comments are masked (same length) so `$a\n- b$` is never a markdown bullet
  let masked = t;
  for (const sp of [...scan.math, ...scan.comments]) masked = masked.slice(0, sp.start) + ' '.repeat(Math.max(0, sp.end - sp.start)) + masked.slice(sp.end);
  const leak = findReasoningLeak(masked);
  if (leak) {
    issues.push({ code: 'reasoning_leak', severity: 'block', message: `The output ${leak.why} ("${leak.raw}"), not one paper sentence.`, start: leak.start, end: leak.end, raw: leak.raw });
  }
  const limit = ctx.maxWords === undefined ? (mode === 'ghost' ? GHOST_MAX_WORDS : null) : ctx.maxWords;
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
    const words = countWords(t);
    if (words > limit) {
      issues.push({ code: 'too_long', severity: mode === 'ghost' ? 'block' : 'warn', message: `${words} words; the limit here is ${limit}. Split the sentence or cut a clause.` });
    }
  }

  // ---------------------------------------------------------------- 3. citations and references
  // A rewrite or grammar fix may keep the author's own citations (the author put them there; the
  // invariance check below already requires the same multiset of keys). New keys still need resolving.
  if ((mode === 'rewrite' || mode === 'grammar') && typeof ctx.original === 'string') {
    try {
      for (const kc of scanLatex(ctx.original).keyCommands) if (kc.kind === 'cite') for (const k of kc.keys) allowed.add(k);
    } catch {
      /* an unreadable original adds nothing */
    }
  }
  for (const kc of scan.keyCommands) {
    const raw = t.slice(kc.start, kc.end);
    if (kc.kind === 'cite') {
      const unknown = kc.keys.filter((k) => !allowed.has(k));
      if (kc.keys.length === 0 || unknown.length > 0) {
        const known = kc.keys.filter((k) => allowed.has(k));
        issues.push({
          code: 'unknown_cite',
          severity: 'block',
          message: kc.keys.length === 0 ? `Empty citation ${raw}.` : `Citation key${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `"${k}"`).join(', ')} not in the resolved bibliography; replaced by [ref].`,
          start: kc.start,
          end: kc.end,
          raw,
        });
        const replacement = known.length
          ? `${t.slice(kc.start, kc.argStart)}{${known.join(',')}}${t.slice(kc.argEnd, kc.end)}~[ref]`
          : '[ref]';
        reps.push({ start: kc.start, end: kc.end, text: replacement });
      }
    } else if (kc.kind === 'ref') {
      const unknown = kc.keys.filter((k) => !labels.has(k));
      if (kc.keys.length === 0 || unknown.length > 0) {
        issues.push({
          code: 'unknown_ref',
          severity: 'block',
          message: kc.keys.length === 0 ? `Empty reference ${raw}.` : `Reference target${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `"${k}"`).join(', ')} not found in the project.`,
          start: kc.start,
          end: kc.end,
          raw,
        });
        const what = placeholderSafe(unknown.join(' ') || 'target', 40);
        reps.push({ start: kc.start, end: kc.end, text: `[ref target ${what}?]` });
      }
    }
  }

  // literal numeric citations ("as shown in [12]", "studies~[3, 4]"): an invented reference
  for (const lit of literalCitations(t, scan)) {
    issues.push({ code: 'unknown_cite', severity: 'block', message: `"${lit.raw}" is a literal reference number; cite with \\cite{key} from the bibliography.`, start: lit.start, end: lit.end, raw: lit.raw });
    reps.push({ start: lit.start, end: lit.end, text: '[ref]' });
  }

  // ---------------------------------------------------------------- 4. LaTeX invariance
  const original = typeof ctx.original === 'string' ? ctx.original : null;
  if ((mode === 'rewrite' || mode === 'grammar') && original !== null) {
    const inv = compareLatexInvariance(original, t);
    if (!inv.ok) {
      const parts: string[] = [];
      if (inv.missing.length) parts.push(`missing ${inv.missing.join(', ')}`);
      if (inv.added.length) parts.push(`added ${inv.added.join(', ')}`);
      issues.push({ code: 'latex_changed', severity: 'block', message: `The AI changed notation: ${parts.join('; ')}. \\cite, \\ref, \\label, math and macros must stay exactly as written.`, raw: [...inv.missing, ...inv.added].join(' ') });
    }
  }

  // ---------------------------------------------------------------- 1, 2, 5. numbers
  const toks = extractNumeralDetails(t);
  const badPct = scan.comments.find((c) => /\d[ \t]*$/.test(t.slice(Math.max(0, c.start - 8), c.start)));
  if (badPct) {
    issues.push({ code: 'bad_latex', severity: 'block', message: 'A bare % after a number starts a LaTeX comment and hides the rest of the line; write \\%.', start: badPct.start, end: badPct.start + 1, raw: '%' });
  }
  const links = resolveLinks(toks, facts, claimed, { strictCounts: mode === 'ghost' || mode === 'draft' });
  linkRatios(links, facts);
  const originalRaws = (mode === 'rewrite' || mode === 'grammar') && typeof ctx.original === 'string' ? extractNumeralDetails(ctx.original).map((x) => normRaw(x.raw)) : [];
  const byId = new Map(facts.map((f) => [f.id, f] as const));
  const intentNums = typeof ctx.intentText === 'string' && ctx.intentText ? extractNumeralDetails(ctx.intentText) : [];
  const fictional = arr<string>(ctx.fictionalNumbers)
    .map((s) => ({ s: String(s), v: parseLooseNumber(String(s)), n: normRaw(String(s)) }))
    .filter((f) => f.v !== null || f.n);
  const linked: string[] = [];
  const unlinked: string[] = [];
  /** quantity key -> forms used ('factor' | 'percent'). */
  const forms = new Map<string, Set<string>>();
  const addForm = (key: string, tok: NumeralDetail): void => {
    const f = tok.factor ? 'factor' : tok.percent ? 'percent' : null;
    if (!f) return;
    if (!forms.has(key)) forms.set(key, new Set());
    forms.get(key)!.add(f);
  };
  const usedDescriptions = new Set<string>();
  const placeholderFor = (tok: NumeralDetail): string => {
    const before = cleanWords(t.slice(0, tok.replStart)).slice(-5);
    const after = cleanWords(t.slice(tok.replEnd)).slice(0, 3);
    let desc = placeholderSafe([...before, '...', ...after].join(' ').replace(/^\.\.\.\s*|\s*\.\.\.$/g, ''), 120);
    if (!desc || desc === '...') desc = 'value';
    let d = desc;
    for (let k = 2; usedDescriptions.has(d); k++) d = `${desc} (${k})`;
    usedDescriptions.add(d);
    return `[fact?: ${d}]`;
  };
  const flagNumber = (l: TokenLink, code: GateIssueCode, message: string): void => {
    issues.push({ code, severity: 'block', message, start: l.tok.start, end: l.tok.end, raw: l.tok.raw });
    reps.push({ start: l.tok.replStart, end: l.tok.replEnd, text: placeholderFor(l.tok) });
  };
  const shown = (tok: NumeralDetail): string => (tok.word ? tok.phrase : `${tok.raw}${tok.percent ? '%' : ''}${tok.unit ? ' ' + tok.unit : ''}${tok.points ? ' points' : ''}`);
  /** A comparison that makes the numeral a cut: with a physical unit, or a bare small integer ("at least 3 space points"). */
  const cutComparison = (tok: NumeralDetail): boolean => {
    if (!tok.comparison) return false;
    if (tok.unit && tok.unit !== '%' && tok.unit !== 'points') return true;
    return !tok.weakComparison && !tok.percent && !tok.points && !tok.unit && !tok.factor && tok.ratioDen === null && tok.decimals === 0 && Math.abs(tok.value) <= 10;
  };
  const cutText = (tok: NumeralDetail): string => `"${tok.word ? tok.phrase : tok.raw}${tok.unit ? ' ' + tok.unit : ''}" after "${tok.comparison}"`;
  const formOf = (tok: NumeralDetail): string => (tok.percent ? '%' : tok.points ? 'points' : tok.factor ? 'factor' : (tok.unit ?? ''));

  for (const l of links) {
    const tok = l.tok;
    if (l.status === 'structural') {
      if (l.linked) linked.push(l.linked);
      // a small count ("8 GPUs") outside ghost/draft: not blocked, but the author is told
      if (tok.smallCount && !l.linked && !originalRaws.includes(normRaw(tok.raw))) {
        issues.push({ code: 'unmatched_number', severity: 'warn', message: `"${tok.raw}" counts something that is not in the fact store; check it against the analysis.`, start: tok.start, end: tok.end, raw: tok.raw });
      }
      continue;
    }
    if (l.candidates.length > 0) {
      // 2. cuts: a unit (or a bare small integer) next to a comparison must be a cut/definition/setting fact
      if (cutComparison(tok) && !l.candidates.some((id) => cutLike(byId.get(id)))) {
        flagNumber(l, 'unmatched_cut', `${cutText(tok)} reads as a cut, but it matches no cut or definition fact (only ${l.candidates.join(', ')}).`);
        continue;
      }
      if (l.linked) {
        linked.push(l.linked);
        addForm(l.linked, tok);
      } else {
        for (const id of l.candidates) addForm(id, tok);
      }
      // a result written in words or as a coarse ratio is linked, but should be the measured numeral
      if ((tok.word && !(tok.comparison && !tok.percent && !tok.factor)) || tok.ratioDen !== null) {
        const ids = l.linked ? [l.linked] : l.candidates;
        issues.push({
          code: 'loose_number',
          severity: 'warn',
          message: `"${tok.word ? tok.phrase : tok.raw}" restates ${ids.join(' or ')} ${tok.word ? 'in words' : 'as a rough ratio'}; write the measured value as a numeral with its precision.`,
          start: tok.start,
          end: tok.end,
          raw: tok.raw,
        });
      }
      continue;
    }
    // an uncertainty whose value equals some fact, but no uncertainty recorded for the value's fact
    if (tok.isUncertainty && tok.uncertaintyOf >= 0) {
      const base = links[tok.uncertaintyOf];
      const baseIds = base ? (base.linked ? [base.linked] : base.candidates) : [];
      if (!derived.some((d) => derivedMatch(tok, d))) {
        flagNumber(l, 'unmatched_number', `"${shown(tok)}" is given as an uncertainty, but no such uncertainty is recorded${baseIds.length ? ` for ${baseIds.join(', ')}` : ''}; replaced by a [fact?: ...] placeholder.`);
        continue;
      }
    }
    // unmatched: derived relation?
    const rel = derived.find((d) => derivedMatch(tok, d));
    if (rel) {
      const ids = arr<string>(rel.factIds).filter((x) => typeof x === 'string');
      linked.push(...ids);
      addForm([...ids].sort().join('|'), tok);
      // a percent that is also a fact in points (or a fraction) at the wrong scale: the relative change
      // explains it, but the author may have meant the difference ("2.3%" for 2.32 points)
      if (rel.kind === 'relative' && tok.percent) {
        const confused = relaxedOnlyMatches(tok, facts);
        if (confused.length) {
          issues.push({ code: 'percent_scale', severity: 'warn', message: `"${shown(tok)}" is read as the relative change ${rel.description}; it is also ${confused[0]!.factId} written as a percent. If you mean the difference, write points.`, start: tok.start, end: tok.end, raw: tok.raw });
        }
      }
      continue;
    }
    // a confidence level ("at 95\\% CL") documented by a limit fact
    if (tok.percent && /^[\s~]*(?:\\[,;: ]\s*)*(?:CL\b|C\.L\.|confidence)/i.test(t.slice(tok.replEnd))) {
      const limitFacts = facts.filter((f) => !f.excluded && confidenceLevelOf(f) !== null && sameValue(confidenceLevelOf(f)!, tok.value));
      if (limitFacts.length) {
        if (limitFacts.length === 1) linked.push(limitFacts[0]!.id);
        continue;
      }
    }
    // typed by the author in the intent note? (checked after the scale and cut checks below)
    const intentSame = tok.word || tok.ratioDen !== null ? intentNums.filter((n) => sameValue(n.value, tok.value) && formOf(n) === formOf(tok)) : intentNums.filter((n) => sameValue(n.value, tok.value) || normRaw(n.raw) === normRaw(tok.raw));
    const fictionalHit = fictional.some((f) => (tok.word ? f.n === normRaw(tok.phrase) || f.s.toLowerCase() === tok.phrase : (f.v !== null && sameValue(f.v, tok.value)) || (f.n !== '' && f.n === normRaw(tok.raw))));
    if (fictionalHit && intentSame.length === 0) {
      flagNumber(l, 'fictional_number', `"${shown(tok)}" is a number from the skill's invented examples, not from this analysis.`);
      continue;
    }
    const relaxed = relaxedOnlyMatches(tok, facts);
    if (relaxed.length) {
      const r = relaxed[0]!;
      const f = byId.get(r.factId);
      const how = r.scale === 100 ? 'a fraction that must be written as a percent (x100) here' : r.scale === 0.01 ? 'a percent, but the text writes it as a fraction' : tok.percent ? 'a fraction, but the text adds a percent sign' : tok.points ? 'a value that is not in percentage points' : 'a value on another scale';
      flagNumber(l, 'percent_scale', `"${tok.raw}${tok.percent ? '%' : tok.points ? ' points' : ''}" looks like ${r.factId}${f ? ` (${String(f.value)}${f.unit ? ' ' + f.unit : ''})` : ''} written as ${how}; percent versus fraction or points mix-up.`);
      continue;
    }
    if (cutComparison(tok)) {
      flagNumber(l, 'unmatched_cut', `${cutText(tok)} reads as a cut, but no cut or definition fact has this value.`);
      continue;
    }
    if (intentSame.length) {
      // the note's form must agree: "2.3 points" in the note is not "2.3\%" in the text
      const agree = intentSame.some((n) => formOf(n) === '' || formOf(n) === formOf(tok));
      if (!agree) {
        const n = intentSame[0]!;
        flagNumber(l, 'percent_scale', `Your note gives ${n.raw} as ${formOf(n) === 'points' ? 'percentage points' : formOf(n) === '%' ? 'a percent' : formOf(n)}, but the text writes "${shown(tok)}"${formOf(tok) ? ` (${formOf(tok) === '%' ? 'a percent' : formOf(tok)})` : ''}; percent versus points mix-up.`);
        continue;
      }
      unlinked.push(tok.raw);
      issues.push({ code: 'unlinked_number', severity: 'warn', message: `"${shown(tok)}" comes from your note and is not linked to a fact; check it against the result files.`, start: tok.start, end: tok.end, raw: tok.raw });
      continue;
    }
    if (fictionalHit) {
      flagNumber(l, 'fictional_number', `"${shown(tok)}" is a number from the skill's invented examples, not from this analysis.`);
      continue;
    }
    flagNumber(
      l,
      'unmatched_number',
      `"${shown(tok)}" matches no fact${tok.isUncertainty ? ' (as an uncertainty)' : tok.ratioDen !== null ? ' (as a fraction)' : tok.factor ? ' (as a factor; give it as a derived relation of two facts)' : tok.smallCount ? ' (a count that is not in the fact store)' : ''}; replaced by a [fact?: ...] placeholder.`,
    );
  }

  // ---------------------------------------------------------------- direction of signed results
  // A numeral without a sign may state the magnitude of a negative fact ("lower by 0.83 points"); the
  // direction word next to it must then agree with the sign.
  {
    const dirs = directionWords(t);
    for (const l of links) {
      const tok = l.tok;
      if (!l.linked || tok.negative || tok.isUncertainty || tok.ratioDen !== null) continue;
      const f = byId.get(l.linked);
      const m = l.matches.find((x) => x.factId === l.linked);
      if (!f || !m || m.field !== 'value' || typeof f.value !== 'number' || !Number.isFinite(f.value) || f.value === 0) continue;
      const diffLike = f.value < 0 || normUnit(f.unit) === 'points' || /\b(?:minus|difference|diff|delta|gain|change)\b/i.test(`${f.definition ?? ''} ${String(f.id).replace(/[._]/g, ' ')}`);
      if (!diffLike || CUT_KINDS.has(f.kind)) continue;
      let sign: Direction = f.value > 0 ? 'up' : 'down';
      // "A minus B": a sentence whose subject is B states the difference from B's side
      // ("acorn's rate is 0.83 points higher than Canto-L's"); B after "than"/"over"/"against" is the baseline
      const ab = /^(.+?)\s+(?:minus|−|–|-)\s+(.+?)\s*$/.exec(String(f.definition ?? ''));
      let subjectKnown = false;
      if (ab) {
        const entity = (side: string, left: boolean): string => {
          let e = side.split(',')[left ? side.split(',').length - 1 : 0]!.trim();
          if (left) e = e.replace(/^.*\bof\s+/i, '');
          return e.replace(/[()]/g, ' ').trim().split(/\s+/)[0] ?? '';
        };
        const find = (name: string): { pos: number; baseline: boolean } | null => {
          if (name.length < 2) return null;
          const re = new RegExp(`(?<![A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i');
          const mm = re.exec(t);
          if (!mm) return null;
          const before = t.slice(Math.max(0, mm.index - 40), mm.index);
          return { pos: mm.index, baseline: /\b(?:than|over|against|versus|vs\.?|relative\s+to|compared\s+(?:with|to)|with\s+respect\s+to)\s+(?:that\s+of\s+|the\s+)?$/i.test(before) };
        };
        const xa = find(entity(ab[1]!, true));
        const yb = find(entity(ab[2]!, false));
        let subject: 'A' | 'B' | null = null;
        if (xa && !xa.baseline && (!yb || yb.baseline || xa.pos < yb.pos)) subject = 'A';
        else if (yb && !yb.baseline && (!xa || xa.baseline || yb.pos < xa.pos)) subject = 'B';
        else if (yb?.baseline) subject = 'A';
        else if (xa?.baseline) subject = 'B';
        subjectKnown = subject !== null;
        if (subject === 'B') sign = sign === 'up' ? 'down' : 'up';
      }
      // nearest direction word (by distance to the numeral)
      let best: { dir: Direction; word: string; d: number } | null = null;
      for (const d of dirs) {
        const dist = d.end <= tok.start ? tok.start - d.end : d.start >= tok.end ? d.start - tok.end : 0;
        if (dist > 80) continue;
        if (!best || dist < best.d) best = { dir: d.dir, word: d.word, d: dist };
      }
      if (!best) {
        if (f.value < 0) issues.push({ code: 'direction', severity: 'warn', message: `"${shown(tok)}" is the size of ${f.id} = ${String(f.value)} (a decrease); say which way it goes.`, start: tok.start, end: tok.end, raw: tok.raw });
        continue;
      }
      if (best.dir !== sign) {
        const severity = f.value < 0 || subjectKnown ? 'block' : 'warn';
        issues.push({
          code: 'direction',
          severity,
          message: `"${best.word} ... ${shown(tok)}" states ${best.dir === 'up' ? 'an increase' : 'a decrease'}, but ${f.id} = ${String(f.value)}${f.definition ? ` (${f.definition})` : ''} goes the other way.`,
          start: tok.start,
          end: tok.end,
          raw: tok.raw,
        });
      }
    }
  }

  // ---------------------------------------------------------------- grammar / rewrite: meaning drift
  if ((mode === 'rewrite' || mode === 'grammar') && original !== null) {
    if (mode === 'grammar') {
      const why = grammarOnlyReasons(original, t);
      if (why.length) {
        issues.push({ code: 'meaning_changed', severity: 'block', message: `This is not a grammar fix: it ${why.join('; ')}. Offer it as a rewrite for review instead.`, raw: why.join('; ') });
      }
    } else {
      const c = meaningChange(original, t);
      if (c.negation || c.direction) {
        issues.push({ code: 'meaning_changed', severity: 'warn', message: `The rewrite ${[c.negation ? 'adds or removes a negation' : '', c.direction ? 'changes a direction word (higher/lower, rises/falls)' : ''].filter(Boolean).join(' and ')}; reread it against the original.` });
      }
    }
  }
  for (const [key, set] of forms) {
    if (set.has('factor') && set.has('percent')) {
      issues.push({ code: 'factor_percent', severity: 'warn', message: `The same result (${key.split('|').join(', ')}) is stated both as a factor and as a percent; keep one form.` });
    }
  }

  // rewrite / grammar: numbers of the original must survive
  if ((mode === 'rewrite' || mode === 'grammar') && original !== null) {
    const before = extractNumeralDetails(original).filter((x) => !x.structural);
    const after = extractNumeralDetails(t).filter((x) => !x.structural);
    const pool = after.map((x) => normRaw(x.raw));
    const missing: string[] = [];
    for (const b of before) {
      const i = pool.indexOf(normRaw(b.raw));
      if (i >= 0) pool.splice(i, 1);
      else missing.push(b.raw);
    }
    if (missing.length) {
      issues.push({ code: 'number_changed', severity: 'warn', message: `The rewrite dropped or changed ${missing.map((m) => `"${m}"`).join(', ')}; keep every number of the original.`, raw: missing.join(' ') });
    }
  }

  // ---------------------------------------------------------------- 6. placeholders
  const inputPlaceholders = findPlaceholders(t);
  const counts = new Map<string, number>();
  for (const p of inputPlaceholders) {
    const k = p.text.replace(/\s+/g, ' ').trim().toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const [k, c] of counts) {
    if (c > 1) {
      const first = inputPlaceholders.find((p) => p.text.replace(/\s+/g, ' ').trim().toLowerCase() === k)!;
      issues.push({ code: 'duplicate_placeholder', severity: 'warn', message: `The placeholder ${first.text} appears ${c} times; give each missing item its own description.`, start: first.start, end: first.end, raw: first.text });
    }
  }

  // ---------------------------------------------------------------- claimed facts that appear
  const linkedUniq = uniq(linked.filter((id) => byId.has(id) || derived.some((d) => arr<string>(d.factIds).includes(id))));
  const lowerText = visible.toLowerCase();
  for (const id of claimed) {
    if (linkedUniq.includes(id)) continue;
    const f = byId.get(id);
    if (!f || f.excluded) continue;
    const isCandidate = links.some((l) => l.candidates.includes(id));
    const strAppears = typeof f.value === 'string' && f.value.trim().length >= 3 && lowerText.includes(f.value.trim().toLowerCase());
    if (isCandidate || strAppears) linkedUniq.push(id);
  }

  // ---------------------------------------------------------------- 7. claim strength
  const linkedFacts = linkedUniq.map((id) => byId.get(id)).filter((f): f is Fact => !!f);
  const strength = claimStrengthIssues({
    text: visible,
    linkedFacts,
    hasPlaceholder: inputPlaceholders.length > 0 || reps.length > 0,
    hasCitation: scan.keyCommands.some((k) => k.kind === 'cite' && k.keys.some((key) => allowed.has(key))),
  });
  for (const s of strength) issues.push({ code: 'claim_strength', severity: 'warn', message: s.message, raw: s.raw });

  // ---------------------------------------------------------------- result
  const repaired = applyReplacements(t, reps);
  const citeKeys = uniq(latexTokensOf(repaired).cites.filter((k) => allowed.has(k)));
  const placeholders = findPlaceholders(repaired).map((p) => p.text);
  return {
    ok: !issues.some((i) => i.severity === 'block'),
    issues,
    repaired,
    factIds: linkedUniq,
    citeKeys,
    unlinked: uniq(unlinked),
    placeholders,
  };
}

/**
 * A ratio "N out of M" that fits several fraction facts is linked when they are one quantity: per-seed
 * values (array elements such as `#/eff_A_seeds/0`, CSV columns such as `eff_s0`) yield to the aggregate, and facts holding the identical value (the
 * same efficiency in a claim JSON and a CSV row) count once (the first in fact-store order is linked).
 * Ratios that still fit facts with different values stay ambiguous (accepted, `loose_number`).
 */
function linkRatios(links: TokenLink[], facts: Fact[]): void {
  const order = new Map<string, number>();
  const byId = new Map<string, Fact>();
  facts.forEach((f, i) => {
    if (!order.has(f.id)) {
      order.set(f.id, i);
      byId.set(f.id, f);
    }
  });
  const element = (f: Fact): boolean =>
    /\/\d+$/.test(String(f.locator ?? '')) || /(?:^|[._])seeds?(?:[._]|$)/i.test(String(f.id)) || /(?:^|_)(?:s|seed)\d+$/i.test(String(f.id).split('.').pop() ?? '');
  for (const l of links) {
    if (l.tok.ratioDen === null || l.linked || l.candidates.length < 2) continue;
    let cands = l.candidates.map((id) => byId.get(id)).filter((f): f is Fact => !!f);
    const aggregate = cands.filter((f) => !element(f));
    if (aggregate.length > 0) cands = aggregate;
    cands.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const first = cands[0];
    if (!first || typeof first.value !== 'number') continue;
    const one = cands.every((f) => typeof f.value === 'number' && sameValue(f.value, first.value as number) && normUnit(f.unit) === normUnit(first.unit));
    if (!one) continue;
    l.linked = first.id;
    l.status = 'linked';
  }
}

/** Literal numeric citations outside math: `[12]`, `[3--5]`, `[1, 2, 3]` after a space or `~`; `[3, 4]` only after `~` or "Ref.". */
function literalCitations(t: string, scan: ReturnType<typeof scanLatex>): Array<{ start: number; end: number; raw: string }> {
  const out: Array<{ start: number; end: number; raw: string }> = [];
  const re = /\[(\d{1,3}(?:\s*(?:,|--|–|-)\s*\d{1,3})*)\](?![{\[])/g;
  const inSpan = (pos: number): boolean => scan.math.some((m) => pos >= m.start && pos < m.end) || scan.comments.some((c) => pos >= c.start && pos < c.end);
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const start = m.index;
    if (inSpan(start)) continue;
    const before = t.slice(Math.max(0, start - 16), start);
    const tie = /~$/.test(before);
    const refWord = /\b(?:Refs?|References?)\.?[\s~]*$/.test(before);
    const spaced = start === 0 || /\s$/.test(before);
    if (!(tie || refWord || spaced)) continue;
    const parts = m[1]!.split(/\s*(?:,|--|–|-)\s*/);
    const isRange = /--|–|-/.test(m[1]!);
    const ok = tie || refWord || parts.length === 1 || parts.length >= 3 || isRange;
    if (!ok) continue;
    out.push({ start, end: start + m[0].length, raw: m[0] });
  }
  return out;
}
