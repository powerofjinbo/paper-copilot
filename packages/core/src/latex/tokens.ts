/**
 * LaTeX tokens inside one sentence: citations, references, labels, math spans, macros and
 * placeholders. Used by the faithfulness gate (LaTeX invariance, cite/ref checks) and by units.
 *
 * OWNER: core-gate agent.
 */
import { notImplemented } from '../util';

export interface LatexTokens {
  /** \cite-family keys, split on commas, trimmed, in order (with repeats). */
  cites: string[];
  /** \ref, \eqref, \cref, \Cref, \autoref, \pageref targets (comma lists split). */
  refs: string[];
  /** \label keys. */
  labels: string[];
  /** Inline and display math spans, whitespace-normalized, including delimiters normalized to `$...$`. */
  math: string[];
  /** Other macro names (with backslash), excluding the formatting whitelist
   *  (\emph \textit \textbf \textrm \textsc \textsf \texttt \mbox \text) and spacing (\, \; \: \! \  ~). */
  macros: string[];
}

export function latexTokensOf(text: string): LatexTokens {
  return notImplemented('latexTokensOf', text);
}

export interface InvarianceResult {
  ok: boolean;
  /** Tokens present in `before` but missing (or fewer) in `after`, e.g. "cite:Wang2022LRT", "math:$p_T > 1$". */
  missing: string[];
  /** Tokens present in `after` but not (or more often) in `before`. */
  added: string[];
}

/**
 * The skill's rule "Keep \cite, \ref, \label, math, macros and symbols exactly": compare the multisets
 * of cites, refs, labels, math spans and macros of a sentence before and after an AI rewrite.
 * ok = no token missing and none added.
 */
export function compareLatexInvariance(before: string, after: string): InvarianceResult {
  return notImplemented('compareLatexInvariance', before, after);
}

export type PlaceholderKind = 'fact' | 'claim' | 'ref' | 'generic';

export interface PlaceholderSpan {
  start: number;
  end: number;
  text: string;
  kind: PlaceholderKind;
}

/**
 * Placeholders in paper text, as the skill prescribes: `[fact?: description]`, `[claim: text?]`,
 * `[ref]`, `[cite?]`, and generic `[baseline?]`, `[factor?]`, `[range: cτ?]` (a bracket group whose
 * content ends with `?`). A bracket group is NOT a placeholder when it is a LaTeX optional argument:
 * immediately preceded (ignoring nothing) by a command name (`\cite[`, `\\[`, `\item[`), by `}` or `]`
 * of a command, or by `\begin{..}`. Content may not contain newlines and is at most 160 chars.
 */
export function findPlaceholders(text: string): PlaceholderSpan[] {
  return notImplemented('findPlaceholders', text);
}
