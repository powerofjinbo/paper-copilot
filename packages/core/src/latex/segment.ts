/**
 * Offset-preserving LaTeX segmentation into sentence units.
 *
 * OWNER: core-segmenter agent. Replace the `notImplemented` body; keep the exported types and
 * signatures (server, web and other core modules import them).
 *
 * Design rules (docs/design.md, "Architecture", segmenter):
 * - Never re-print LaTeX. Every sentence is a [start, end) slice of the ORIGINAL source.
 * - Work on an offset-preserving mask: a string of the same length as the source in which
 *   non-prose regions are replaced by filler characters, so sentence boundaries can be found with
 *   plain string scanning and mapped 1:1 back to the source. A hand-written scanner is preferred;
 *   @unified-latex/* may be used only if offsets stay exact.
 * - Sentence boundary rule = the skill's style_check.py `split_sentences`: break after `.`, `?` or `!`
 *   (optionally followed by closing quotes/brackets `"”’)]`) and whitespace, when the next non-space
 *   char is upper-case, a digit, an opening quote/paren `“"([‘`, the start of a masked math/command
 *   region, or a non-ASCII letter; and the last whitespace-separated token before the period
 *   (stripped of leading `([“"`) lower-cased is NOT in DEFAULT_ABBREVIATIONS. `~` and `\ ` after a
 *   period are not whitespace (so `Fig.~\ref{x}` never breaks). A `\cite{..}` or `\footnote{..}`
 *   directly after the terminal punctuation (`seen.\cite{x} Next`) belongs to the sentence before it.
 * - Skip entirely: the preamble (before \begin{document}; if there is no \begin{document} the whole
 *   source is body text, "fragment mode"), comments, \title/\author/\affiliation/\date/\email/\thanks
 *   arguments, \maketitle, \bibliography{..}, \bibliographystyle{..}, thebibliography, tabular*,
 *   tikzpicture, verbatim, lstlisting, minted, everything after \end{document}, intent lines
 *   (see intent.ts; they are reported separately).
 * - Display math (equation, equation*, align(*), gather(*), multline(*), eqnarray(*), displaymath,
 *   \[..\], $$..$$) is masked as one atomic token INSIDE the surrounding sentence; it does not end the
 *   paragraph. If the math content ends with `.` (before \end{..} or \]) the sentence ends after it.
 * - Inline math ($..$, \(..\)), \cite/\ref/\eqref/\label and other commands are masked so that dots
 *   inside them never split; `\label{..}` text is not part of a sentence's words but stays inside its span.
 * - Paragraphs end at blank lines, \par, sectioning commands, and \begin/\end of non-math
 *   environments (figure, table, itemize, enumerate, abstract, ...). Each \item starts a new paragraph.
 * - Captions: the argument of \caption[..]{..} is segmented as kind 'caption', part 'caption'.
 *   Footnotes: the argument of \footnote{..} is segmented as kind 'footnote', part 'footnote'; the
 *   host sentence keeps the \footnote{..} text inside its span but it is masked.
 * - Parts: inside \begin{abstract} -> 'abstract'; after \section{..} whose title matches
 *   /intro/i -> 'intro', /conclu|summary|outlook|discussion and conclu/i -> 'concl'; after \appendix
 *   (or inside an \begin{appendix}) -> 'app'; otherwise 'body'. Fragment mode -> 'body'.
 * - Section ids: the \label key itself if a \label follows the heading before any prose (e.g.
 *   'sec:intro'), else 'sec:' + slug(title) (lower-case, runs of non-alphanumerics to '-'),
 *   de-duplicated with -2, -3 suffixes. Text before the first heading (after the abstract) gets
 *   'front'. The abstract gets 'abstract'. Fragment mode with no heading: 'body'.
 * - Sentence `start`/`end` are trimmed of surrounding whitespace; `end` is exclusive and includes the
 *   terminal punctuation and closing quotes/brackets and any attached \cite/\footnote.
 * - Headings (\section{..} etc.) are not sentences; they are reported in `sections`.
 * - Must be fast: a 10,000-word paper in under 30 ms on a laptop; pure string scanning, no regex backtracking blow-ups.
 */
import type { Part, UnitKind } from '../schemas';
import { notImplemented } from '../util';

export interface SegSentence {
  start: number;
  end: number;
  /** 1-based line of `start`. */
  line: number;
  /** Source slice [start, end). */
  text: string;
  part: Part;
  kind: UnitKind;
  sectionId: string;
  sectionTitle: string;
  /** Global paragraph index (0-based, document order). */
  paragraphIndex: number;
  /** Index of the sentence inside its paragraph (0-based). */
  indexInParagraph: number;
}

export interface SegSection {
  id: string;
  title: string;
  /** 0 part, 1 section, 2 subsection, 3 subsubsection, 4 paragraph */
  level: number;
  /** Offset of the heading command. */
  start: number;
  line: number;
  part: Part;
  label: string | null;
}

export interface SegParagraph {
  index: number;
  start: number;
  end: number;
  sectionId: string;
  part: Part;
  kind: UnitKind;
  /** Indices into `sentences`. */
  sentenceIndices: number[];
}

export interface SegIntentLine {
  start: number;
  end: number;
  line: number;
  text: string;
}

export interface Segmentation {
  sentences: SegSentence[];
  sections: SegSection[];
  paragraphs: SegParagraph[];
  intentLines: SegIntentLine[];
  /** \label keys in document order. */
  labels: string[];
  /** \ref-like targets in document order. */
  refs: string[];
  /** \cite keys in document order (with repeats). */
  cites: string[];
  /** True when the source had no \begin{document} (a fragment). */
  fragment: boolean;
}

export interface SegmentOptions {
  /** Defaults to DEFAULT_ABBREVIATIONS. */
  abbreviations?: readonly string[];
}

export function segment(source: string, opts: SegmentOptions = {}): Segmentation {
  return notImplemented('segment', source, opts);
}

/** 1-based line number of an offset (binary search over a precomputed line-start table is fine). */
export function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}
