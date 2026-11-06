/**
 * Thin adapter between anchoring and the text/LaTeX helpers owned by other modules
 * (text/normalize.ts, latex/tokens.ts). Anchoring imports these names only, so the binding to the
 * helpers stays in one place.
 */
import { editDistanceWords, normalizeForHash, similarity } from '../text/normalize';
import { findPlaceholders, latexTokensOf } from '../latex/tokens';
import type { TextAnalysis } from './units';

/** Normalized sentence text used for hashing and overlap/fuzzy matching (normalizeForHash). */
export const normText: (latex: string) => string = normalizeForHash;
/** Normalized word-level edit distance in [0, 1] (editDistanceWords). */
export const editDistance: (a: string, b: string) => number = editDistanceWords;
/** Similarity in [0, 1] used by fuzzy re-anchoring (similarity). */
export const textSimilarity: (a: string, b: string) => number = similarity;

/** Default cite/placeholder extraction: latexTokensOf + findPlaceholders. */
export function defaultAnalyze(text: string): TextAnalysis {
  const cites = latexTokensOf(text).cites;
  const placeholders = findPlaceholders(text).map((p) => p.text);
  return { cites, placeholders };
}
