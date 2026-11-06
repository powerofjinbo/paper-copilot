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
 */
import type { Fact } from '../schemas';
import { notImplemented } from '../util';

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
  | 'empty';

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

export function gateSentence(text: string, ctx: GateContext): GateResult {
  return notImplemented('gateSentence', text, ctx);
}
