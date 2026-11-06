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
 *
 * Implementation notes (scan/scanner.ts builds the mask as a class per UTF-16 unit, scan/split.ts applies
 * the boundary rule on it):
 * - Intent lines are read as comments: they never end a paragraph and never join a sentence's words.
 * - A `}` closing a group opened inside the sentence, `''`/`'` closing quotes, and `~\cite{..}` directly
 *   after the punctuation also stay with the sentence they end.
 * - A sentence needs two consecutive ASCII letters of running text (style_check drops the others, e.g. a
 *   lone `$N$.`); such fragments produce no unit.
 * - Floats contribute only their captions; `\caption[short]{long}` segments the long argument; subfloat
 *   and \subcaptionbox captions are captions too. Text inside skipped material still reports its
 *   \label, \ref and \cite keys.
 * - `\be ... \ee` style macros defined with \newcommand/\def for math environments are display math;
 *   plain-text macros ending in a period (`\newcommand{\etc}{etc.}`) end sentences like style_check's
 *   macro expansion; abbreviation macros (`\eg`, `\etal`) never do.
 * - Part rules follow style_check part_for_heading: subsections inherit the part of their section; in a
 *   full document, text after the abstract and before the first heading is 'intro' (style_check
 *   build_blocks: a letter without an Introduction heading); acknowledgment/reference headings are
 *   'body' (style_check drops them; units keep their provenance).
 * - `\begin{acknowledgments}` / revtex `\acknowledgments` open a section 'acknowledgments'; a JHEP-style
 *   `\abstract{..}` (also in the preamble) is the abstract. `sections` also lists these pseudo-sections
 *   and 'front' / 'body' when text precedes the first heading, so every sentence's sectionId is in it.
 * - Inline environments (inparaenum, revtex widetext around a display, otherlanguage) stay inside the
 *   sentence and balance like braces; an unclosed construct (while the author types) never swallows
 *   the rest of the file: it is read as text until it is closed. Brace and environment pairs are found
 *   in one pass, so even broken input segments in linear time.
 * - An optional `\item[label]` is structure, not part of the unit (style_check keeps it in its text).
 */
import type { Part, UnitKind } from '../schemas';
import { DEFAULT_ABBREVIATIONS } from './abbreviations';
import { scanIntentLines } from './scan/intent';
import { Scanner, type ParaRange, type SecInfo } from './scan/scanner';
import { splitParagraph } from './scan/split';

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

/** Sorted line-start offsets of a text (line k+1 starts at starts[k]). */
function lineStarts(text: string): Int32Array {
  let count = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) count++;
  const starts = new Int32Array(count);
  let k = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts[k++] = i + 1;
  return starts;
}

function lineAt(starts: Int32Array, offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

let abbrCacheKey: readonly string[] | null = null;
let abbrCache: ReadonlySet<string> = new Set();

function abbreviationSet(list: readonly string[]): ReadonlySet<string> {
  if (list !== abbrCacheKey) {
    abbrCache = new Set(list.map((a) => a.trim().toLowerCase()).filter((a) => a.length > 0));
    abbrCacheKey = list;
  }
  return abbrCache;
}

/** Section slug: lower-case, runs of non-alphanumerics to '-'. */
function slug(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'section';
}

function baseSectionId(sec: SecInfo, fragment: boolean): string {
  switch (sec.kind) {
    case 'abstract':
      return 'abstract';
    case 'ack':
      return 'acknowledgments';
    case 'front':
      return fragment ? 'body' : 'front';
    default:
      if (sec.label) return sec.label;
      if (sec.part === 'abstract' && /^abstract[.:]?$/i.test(sec.plain.trim())) return 'abstract';
      return 'sec:' + slug(sec.plain);
  }
}

export function segment(source: string, opts: SegmentOptions = {}): Segmentation {
  const abbr = abbreviationSet(opts.abbreviations ?? DEFAULT_ABBREVIATIONS);
  const intentLines = scanIntentLines(source);
  // Intent lines are read as comment lines (same length, so offsets are unchanged).
  let work = source;
  if (intentLines.length > 0) {
    let w = '';
    let last = 0;
    for (const l of intentLines) {
      w += source.slice(last, l.start) + '%' + ' '.repeat(Math.max(0, l.end - l.start - 1));
      last = l.end;
    }
    work = w + source.slice(last);
  }
  const sc = new Scanner(work);
  sc.run();
  const view = { src: work, cls: sc.cls, jump: sc.jump, rk: sc.rk, tokenText: sc.tokenText };

  // Split every paragraph range; keep the ones that produced sentences.
  interface RawPara {
    range: ParaRange;
    spans: number[];
  }
  const raws: RawPara[] = [];
  const spans: number[] = [];
  for (const range of sc.paras) {
    spans.length = 0;
    splitParagraph(view, range.start, range.end, abbr, spans);
    if (spans.length > 0) raws.push({ range, spans: spans.slice() });
  }
  raws.sort((a, b) => a.spans[0]! - b.spans[0]! || a.range.start - b.range.start);

  // Pseudo-section for text before the first heading ('front', or 'body' in fragment mode).
  const front: SecInfo = { kind: 'front', level: 1, title: '', plain: '', start: Number.MAX_SAFE_INTEGER, part: 'body', label: null, id: '' };
  let frontUsed = false;
  const secOf = (r: ParaRange): SecInfo => r.sec ?? front;
  for (const r of raws) {
    if (r.range.sec) continue;
    if (!frontUsed || r.spans[0]! < front.start) {
      front.start = r.spans[0]!;
      front.part = r.range.kind === 'prose' ? r.range.part : front.part;
    }
    frontUsed = true;
  }
  const allSecs: SecInfo[] = frontUsed ? [...sc.secs, front] : sc.secs.slice();
  allSecs.sort((a, b) => a.start - b.start);
  const used = new Set<string>();
  for (const sec of allSecs) {
    const base = baseSectionId(sec, sc.fragment);
    let id = base;
    for (let k = 2; used.has(id); k++) id = `${base}-${k}`;
    used.add(id);
    sec.id = id;
  }

  // Sentences in document order; paragraphs indexed by their first sentence.
  const starts = lineStarts(source);
  interface Tmp {
    s: SegSentence;
    para: number;
  }
  const tmp: Tmp[] = [];
  const paragraphs: SegParagraph[] = [];
  raws.forEach((r, pIndex) => {
    const sec = secOf(r.range);
    for (let k = 0; k < r.spans.length; k += 2) {
      const start = r.spans[k]!;
      const end = r.spans[k + 1]!;
      tmp.push({
        para: pIndex,
        s: {
          start,
          end,
          line: lineAt(starts, start),
          text: source.slice(start, end),
          part: r.range.part,
          kind: r.range.kind,
          sectionId: sec.id,
          sectionTitle: sec.title,
          paragraphIndex: pIndex,
          indexInParagraph: k / 2,
        },
      });
    }
    paragraphs.push({
      index: pIndex,
      start: r.spans[0]!,
      end: r.spans[r.spans.length - 1]!,
      sectionId: sec.id,
      part: r.range.part,
      kind: r.range.kind,
      sentenceIndices: [],
    });
  });
  tmp.sort((a, b) => a.s.start - b.s.start || a.para - b.para);
  const sentences: SegSentence[] = new Array(tmp.length);
  for (let k = 0; k < tmp.length; k++) {
    const t = tmp[k]!;
    sentences[k] = t.s;
    paragraphs[t.para]!.sentenceIndices.push(k);
  }

  const sections: SegSection[] = allSecs.map((sec) => ({
    id: sec.id,
    title: sec.title,
    level: sec.level,
    start: sec.start,
    line: lineAt(starts, sec.start),
    part: sec.part,
    label: sec.label,
  }));

  return {
    sentences,
    sections,
    paragraphs,
    intentLines: intentLines.map((l) => ({ start: l.start, end: l.end, line: l.line, text: l.text })),
    labels: sc.labels.slice(),
    refs: sc.refs.slice(),
    cites: sc.cites.slice(),
    fragment: sc.fragment,
  };
}

let lineCacheText: string | null = null;
let lineCacheStarts: Int32Array = new Int32Array(1);

/** 1-based line number of an offset (binary search over a precomputed line-start table is fine). */
export function lineOf(source: string, offset: number): number {
  if (source !== lineCacheText) {
    lineCacheStarts = lineStarts(source);
    lineCacheText = source;
  }
  // a newline at `offset` itself still belongs to the line it ends
  return lineAt(lineCacheStarts, Math.max(0, Math.min(offset, source.length)));
}
