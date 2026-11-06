/**
 * Intent lines, semantic line breaks and the compile shadow.
 *
 * OWNER: core-segmenter agent.
 */
import type { Segmentation, SegIntentLine } from './segment';
import { isIntentText, scanIntentLines } from './scan/intent';

/**
 * An intent line is a NON-comment line (first non-space char is not `%`) in which CJK characters
 * (Han, Hiragana, Katakana, Hangul, CJK punctuation and full-width forms) make up at least 30% of the
 * non-whitespace characters, or there are at least 4 CJK characters and more CJK than Latin letters.
 * Intent lines hold the author's thoughts in Chinese; they are excluded from segmentation, lint and
 * compilation, and they block a push.
 *
 * Only the non-comment part of the line is counted: CJK after an unescaped `%` is a LaTeX comment
 * (pdflatex ignores it and shadowForCompile leaves it alone), so `text % 中文注释` is not an intent line.
 */
export function isIntentLine(lineText: string): boolean {
  return isIntentText(lineText);
}

/** All intent lines of a source, with offsets of the line content (without the newline). */
export function findIntentLines(source: string): SegIntentLine[] {
  return scanIntentLines(source);
}

/**
 * The text latexmk compiles: identical to `source` except that the content of every intent line is
 * removed (the newline is kept), so line numbers and SyncTeX positions stay valid. CJK inside LaTeX
 * comments is left alone (pdflatex ignores comments).
 *
 * The removed content is replaced by a single `%`: an empty line would be a paragraph break (\par) in
 * TeX, so a note typed between two sentences of a paragraph would split that paragraph in the PDF.
 * With `%` the line contributes nothing at all, exactly as if the note were not there.
 */
export function shadowForCompile(source: string): string {
  const lines = scanIntentLines(source);
  if (lines.length === 0) return source;
  let out = '';
  let last = 0;
  for (const l of lines) {
    out += source.slice(last, l.start) + '%';
    last = l.end;
  }
  return out + source.slice(last);
}

export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

function isWhitespaceOnly(s: string): boolean {
  return /^[ \t\r\n]+$/.test(s);
}

/**
 * Semantic line breaks: put every sentence of every prose paragraph (kind 'prose', not captions or
 * footnotes) on its own line by replacing the whitespace run BETWEEN two consecutive sentences of the
 * same paragraph with a single '\n'. Never touches math, environments, comments or the whitespace
 * inside a sentence. Returns the new text and the edits (in ascending order, non-overlapping, in
 * original-source coordinates) so the change can be applied as one transaction and undone.
 * Idempotent: applying it to its own output yields no edits.
 *
 * A gap that holds anything but spaces, tabs and newlines (a comment, a \label, a dropped fragment) is
 * left alone, and so is a gap before a sentence that would become an intent line on its own line.
 */
export function toSemanticLines(source: string, seg: Segmentation): { text: string; edits: TextEdit[] } {
  const edits: TextEdit[] = [];
  // keep the file's line-ending convention (a CRLF file gets \r\n, so the result stays consistent)
  const firstNl = source.indexOf('\n');
  const nl = firstNl > 0 && source.charCodeAt(firstNl - 1) === 13 ? '\r\n' : '\n';
  for (const p of seg.paragraphs) {
    if (p.kind !== 'prose') continue;
    for (let k = 1; k < p.sentenceIndices.length; k++) {
      const a = seg.sentences[p.sentenceIndices[k - 1]!];
      const b = seg.sentences[p.sentenceIndices[k]!];
      if (!a || !b || a.kind !== 'prose' || b.kind !== 'prose') continue;
      if (b.start <= a.end || b.start > source.length) continue;
      const gap = source.slice(a.end, b.start);
      if (gap === nl || !isWhitespaceOnly(gap)) continue;
      // the sentence must not become an intent line once it stands on a line of its own
      if (isIntentLine(b.text)) continue;
      edits.push({ from: a.end, to: b.start, insert: nl });
    }
  }
  edits.sort((x, y) => x.from - y.from);
  // drop any overlap defensively (the segmenter never produces one)
  const clean: TextEdit[] = [];
  let lastTo = -1;
  for (const e of edits) {
    if (e.from < lastTo) continue;
    clean.push(e);
    lastTo = e.to;
  }
  let text = '';
  let pos = 0;
  for (const e of clean) {
    text += source.slice(pos, e.from) + e.insert;
    pos = e.to;
  }
  text += source.slice(pos);
  return { text, edits: clean };
}
