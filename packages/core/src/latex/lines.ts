/**
 * Intent lines, semantic line breaks and the compile shadow.
 *
 * OWNER: core-segmenter agent.
 */
import type { Segmentation, SegIntentLine } from './segment';
import { notImplemented } from '../util';

/**
 * An intent line is a NON-comment line (first non-space char is not `%`) in which CJK characters
 * (Han, Hiragana, Katakana, Hangul, CJK punctuation and full-width forms) make up at least 30% of the
 * non-whitespace characters, or there are at least 4 CJK characters and more CJK than Latin letters.
 * Intent lines hold the author's thoughts in Chinese; they are excluded from segmentation, lint and
 * compilation, and they block a push.
 */
export function isIntentLine(lineText: string): boolean {
  return notImplemented('isIntentLine', lineText);
}

/** All intent lines of a source, with offsets of the line content (without the newline). */
export function findIntentLines(source: string): SegIntentLine[] {
  return notImplemented('findIntentLines', source);
}

/**
 * The text latexmk compiles: identical to `source` except that the content of every intent line is
 * removed (the newline is kept), so line numbers and SyncTeX positions stay valid. CJK inside LaTeX
 * comments is left alone (pdflatex ignores comments).
 */
export function shadowForCompile(source: string): string {
  return notImplemented('shadowForCompile', source);
}

export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

/**
 * Semantic line breaks: put every sentence of every prose paragraph (kind 'prose', not captions or
 * footnotes) on its own line by replacing the whitespace run BETWEEN two consecutive sentences of the
 * same paragraph with a single '\n'. Never touches math, environments, comments or the whitespace
 * inside a sentence. Returns the new text and the edits (in ascending order, non-overlapping, in
 * original-source coordinates) so the change can be applied as one transaction and undone.
 * Idempotent: applying it to its own output yields no edits.
 */
export function toSemanticLines(source: string, seg: Segmentation): { text: string; edits: TextEdit[] } {
  return notImplemented('toSemanticLines', source, seg);
}
