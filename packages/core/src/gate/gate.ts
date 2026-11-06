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
 * 3. citations: every \cite key must be in ctx.allowedCiteKeys, else 'unknown_cite' (block) and the
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
 * Each numeral gets at most one number issue, in this order: fictional_number, percent_scale,
 * unmatched_cut, unmatched_number. Structural numerals (Sec. 3, Fig. 2, years next to a citation,
 * list markers, bare integers 0-10) are never checked.
 */
import type { Fact } from '../schemas';
import { compareLatexInvariance, findPlaceholders, latexTokensOf, scanLatex } from '../latex/tokens';
import { extractNumeralDetails, relaxedOnlyMatches, resolveLinks, type NumeralDetail, type TokenLink } from '../facts/numbers';
import { claimStrengthIssues, confidenceLevelOf } from './claims';
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
  | 'gate_error';

export interface GateIssue {
  code: GateIssueCode;
  severity: 'block' | 'warn';
  message: string;
  start?: number;
  end?: number;
  raw?: string;
}

/** A number the AI may write because it is derived from facts, e.g. a ratio of two facts. */
export interface DerivedRelation {
  value: number;
  /** Rendering the gate accepts, e.g. "2.4". */
  raw: string;
  factIds: string[];
  description: string;
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
  if (!rel || typeof rel.value !== 'number' || !Number.isFinite(rel.value)) {
    return !!rel && typeof rel.raw === 'string' && normRaw(rel.raw) === normRaw(tok.raw);
  }
  if (typeof rel.raw === 'string' && rel.raw && normRaw(rel.raw) === normRaw(tok.raw)) return true;
  const tol = 0.5 * Math.pow(10, tok.exponent - tok.decimals);
  return Math.abs(Math.abs(rel.value) - Math.abs(tok.value)) <= tol * (1 + 1e-9) + 1e-12;
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
  const links = resolveLinks(toks, facts, claimed);
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

  for (const l of links) {
    const tok = l.tok;
    if (l.status === 'structural') {
      if (l.linked) linked.push(l.linked);
      continue;
    }
    if (l.candidates.length > 0) {
      // 2. cuts: a unit next to a comparison must be a cut/definition/setting fact
      const physUnit = tok.unit && tok.unit !== '%' && tok.unit !== 'points';
      if (tok.comparison && physUnit && !l.candidates.some((id) => cutLike(byId.get(id)))) {
        flagNumber(l, 'unmatched_cut', `"${tok.raw} ${tok.unit}" after "${tok.comparison}" reads as a cut, but it matches no cut or definition fact (only ${l.candidates.join(', ')}).`);
        continue;
      }
      if (l.linked) {
        linked.push(l.linked);
        addForm(l.linked, tok);
      } else {
        for (const id of l.candidates) addForm(id, tok);
      }
      continue;
    }
    // unmatched: derived relation?
    const rel = derived.find((d) => derivedMatch(tok, d));
    if (rel) {
      const ids = arr<string>(rel.factIds).filter((x) => typeof x === 'string');
      linked.push(...ids);
      addForm([...ids].sort().join('|'), tok);
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
    // typed by the author in the intent note?
    const fromIntent = intentNums.some((n) => sameValue(n.value, tok.value) || normRaw(n.raw) === normRaw(tok.raw));
    if (fromIntent) {
      unlinked.push(tok.raw);
      issues.push({ code: 'unlinked_number', severity: 'warn', message: `"${tok.raw}" comes from your note and is not linked to a fact; check it against the result files.`, start: tok.start, end: tok.end, raw: tok.raw });
      continue;
    }
    if (fictional.some((f) => (f.v !== null && sameValue(f.v, tok.value)) || (f.n !== '' && f.n === normRaw(tok.raw)))) {
      flagNumber(l, 'fictional_number', `"${tok.raw}" is a number from the skill's invented examples, not from this analysis.`);
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
    const physUnit = tok.unit && tok.unit !== '%' && tok.unit !== 'points';
    if (tok.comparison && physUnit) {
      flagNumber(l, 'unmatched_cut', `"${tok.raw} ${tok.unit}" after "${tok.comparison}" reads as a cut, but no cut or definition fact has this value.`);
      continue;
    }
    flagNumber(l, 'unmatched_number', `"${tok.raw}${tok.percent ? '%' : ''}${tok.unit ? ' ' + tok.unit : ''}${tok.points ? ' points' : ''}" matches no fact${tok.isUncertainty ? ' (as an uncertainty)' : ''}; replaced by a [fact?: ...] placeholder.`);
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
