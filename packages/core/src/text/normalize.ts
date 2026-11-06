/**
 * Text normalization used for hashing, fuzzy matching, edit distance and lint/style features.
 * All functions are pure and isomorphic (browser + Node).
 *
 * OWNER: core-segmenter agent. Replace every `notImplemented` body; keep signatures.
 */
import { notImplemented } from '../util';

/**
 * Normalize one LaTeX sentence for hashing and fuzzy matching. Rules, in order:
 * 1. Remove LaTeX comments: an unescaped `%` to end of line (`\%` is a literal percent and stays).
 * 2. Inline math (`$...$`, `\(...\)`) and display math (`\[...\]`, `$$...$$`, equation-like
 *    environments) become the token `⟨M⟩` (content dropped).
 * 3. `\cite[opt]{a,b}` (and \citep, \citet, \citealp, \Cite, \autocite, \parencite, \textcite) become `⟨C:a,b⟩`.
 * 4. `\ref{l}`, `\eqref{l}`, `\cref{l}`, `\Cref{l}`, `\autoref{l}`, `\pageref{l}` become `⟨R:l⟩`; `\label{..}` is removed.
 * 5. `~` and `\,` `\;` `\:` `\!` `\ ` become a single space; `\%` becomes `%`.
 * 6. Text-formatting wrappers keep their content: \emph{x} \textit{x} \textbf{x} \textrm{x} \textsc{x} \mbox{x} -> x.
 * 7. Collapse all whitespace runs to one space; trim.
 * Case is preserved. Unknown macros keep their name (e.g. `\ttbar{}` -> `\ttbar`).
 */
export function normalizeForHash(latex: string): string {
  return notImplemented('normalizeForHash', latex);
}

/**
 * Readable plain text for lint, style features and BM25: like normalizeForHash, but math becomes
 * `x` (or its content stripped of commands when it is a short number like `$8{,}710$` -> `8,710`),
 * citations are removed, references become `1`, macros without arguments are dropped
 * (`\ttbar{}` -> `ttbar`), accents and LaTeX quotes are converted (``x'' -> "x"), `\%` -> `%`,
 * `--` -> `–`. Whitespace collapsed; trimmed.
 */
export function plainText(latex: string): string {
  return notImplemented('plainText', latex);
}

/** Lower-cased word tokens of plain text: letters/digits/apostrophes/hyphens/periods inside numbers. */
export function wordTokens(text: string): string[] {
  return notImplemented('wordTokens', text);
}

/**
 * Word-level Levenshtein distance between two texts (tokens from `wordTokens(plainText(x))`),
 * normalized by the longer token count. 0 = identical, 1 = completely different. Both empty -> 0.
 */
export function editDistanceWords(a: string, b: string): number {
  return notImplemented('editDistanceWords', a, b);
}

/**
 * Similarity in [0,1] used for fuzzy re-anchoring: 1 - editDistanceWords on normalizeForHash'd text,
 * except that two texts differing only in whitespace/case score 1.
 */
export function similarity(a: string, b: string): number {
  return notImplemented('similarity', a, b);
}

/**
 * Word-level diff of two LaTeX sentences, for showing a rewrite: list of [op, text] with
 * op -1 delete, 0 equal, 1 insert. Concatenating ops 0 and -1 gives `a`; ops 0 and 1 gives `b`
 * (exactly, including whitespace). Tokens are runs of non-space chars plus their trailing space,
 * so a LaTeX command such as `\cite{x}` is never split.
 */
export function wordDiff(a: string, b: string): Array<[number, string]> {
  return notImplemented('wordDiff', a, b);
}
