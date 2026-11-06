/**
 * Numbers in prose, fact rendering and numeral-to-fact matching.
 *
 * OWNER: core-gate agent.
 */
import type { Fact } from '../schemas';
import { notImplemented } from '../util';

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
 */
export function extractNumerals(text: string): NumeralToken[] {
  return notImplemented('extractNumerals', text);
}

/** Decimals and significant figures of a numeral string ("0.0550" -> {decimals: 4, sigfigs: 3}). */
export function precisionOf(raw: string): { decimals: number; sigfigs: number } {
  return notImplemented('precisionOf', raw);
}

/**
 * Prose renderings of a fact, derived from value + sigfigs only (never free text):
 * for a fraction in (0, 1] also the percent form (x100). Example: value 0.96942, sigfigs null ->
 * ["0.97", "0.969", "0.9694", "97.0%", "96.9%", "96.94%", ...] at 1-4 decimals. Uncertainties render
 * with the same scale. Used for the Facts panel and for prompts.
 */
export function factAliases(fact: Fact): string[] {
  return notImplemented('factAliases', fact);
}

/** Compact one-line rendering for chips and prompts, e.g. "f.g1.delta_points = 2.32 ± 0.28 points". */
export function renderFact(fact: Fact): string {
  return notImplemented('renderFact', fact);
}

export interface NumeralMatch {
  factId: string;
  /** 'value' or `unc:<name>` when the numeral equals a named uncertainty. */
  field: string;
  /** 1 or 100 (fraction written as percent / points). */
  scale: 1 | 100;
}

/**
 * Facts a numeral can stand for: the fact value (or one of its uncertainties) rounded to the numeral's
 * written decimals equals the numeral value exactly, at scale 1 or 100 (scale 100 only when the fact
 * value is within [-1, 1] and the numeral is a percent or "points" or the fact unit is "%" / "points").
 * Units must agree when both are known (GeV vs MeV etc. are different). Excluded facts never match.
 * Integer counts match integer facts exactly ("8,710" -> n_targets = 8710).
 */
export function matchNumeral(tok: NumeralToken, facts: Fact[]): NumeralMatch[] {
  return notImplemented('matchNumeral', tok, facts);
}

export interface FactLinkResult {
  /** Fact ids linked unambiguously (exactly one candidate fact, or the candidate the caller preferred). */
  linked: string[];
  /** Non-structural numerals with no matching fact. */
  unmatched: NumeralToken[];
  /** Numerals with several candidate facts: [token, candidate fact ids]. */
  ambiguous: Array<{ token: NumeralToken; candidates: string[] }>;
}

/**
 * Link every non-structural numeral of a sentence to facts. `prefer` (e.g. the fact ids the AI said it
 * used, or the paragraph plan's facts) breaks ties: if exactly one candidate is in `prefer`, link it.
 */
export function linkSentenceFacts(text: string, facts: Fact[], prefer: string[] = []): FactLinkResult {
  return notImplemented('linkSentenceFacts', text, facts, prefer);
}
