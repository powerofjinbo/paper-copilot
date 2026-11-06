/**
 * Pure helpers of the LLM service: where the cursor is (paragraph, section, plan), the prefix rule of
 * ghost text, section types and the outline plan lookup. No I/O; everything is passed in.
 */
import type { GhostMode, Outline, OutlineParagraph, OutlineSection, SentenceUnit } from '@paper-copilot/core';
import type { DocService, DocState } from '../../contracts';

/* ------------------------------------------------------------------------------------ */
/* Ghost prefix                                                                          */
/* ------------------------------------------------------------------------------------ */

export interface PrefixSplit {
  /** Text to insert at the cursor (after the prefix already in the document). */
  continuation: string;
}

const isWs = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);

/**
 * The ghost must start with the typed prefix verbatim. Whitespace runs may differ (the model may
 * collapse a double space or drop a trailing one); every other character must match exactly. Returns
 * the continuation to insert after the prefix, or null when the model did not continue the prefix.
 * When the prefix ends with whitespace, the continuation's leading whitespace is dropped (the document
 * already has it); otherwise the model's own spacing is kept (" the efficiency." after "We measure").
 */
export function splitPrefix(text: string, prefix: string): PrefixSplit | null {
  if (prefix.length === 0) return { continuation: text.replace(/^\s+/, '') };
  let i = 0;
  let j = 0;
  while (j < prefix.length) {
    const p = prefix[j];
    if (isWs(p)) {
      while (j < prefix.length && isWs(prefix[j])) j++;
      const atPrefixEnd = j >= prefix.length;
      if (isWs(text[i])) {
        while (i < text.length && isWs(text[i])) i++;
      } else if (!atPrefixEnd) {
        return null;
      }
      continue;
    }
    if (text[i] !== p) return null;
    i++;
    j++;
  }
  let continuation = text.slice(i);
  if (isWs(prefix[prefix.length - 1])) continuation = continuation.replace(/^\s+/, '');
  else continuation = continuation.replace(/^\s+/, ' ');
  return { continuation };
}

/** A ghost sentence is one line: newlines (and the indentation after them) become single spaces. */
export function oneLine(s: string): string {
  return s.replace(/[ \t]*\r?\n[ \t]*/g, ' ');
}

/** English words typed so far (CJK and LaTeX commands do not count). */
export function englishWordCount(s: string): number {
  return s
    .replace(/\\[a-zA-Z]+/g, ' ')
    .split(/\s+/)
    .filter((w) => /[A-Za-z]{2,}|^[aAI]$/.test(w)).length;
}

const CJK_RE = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/g;

/** True when most letters are CJK (an intent note, not paper text). */
export function mostlyCjk(s: string): boolean {
  const cjk = (s.match(CJK_RE) ?? []).length;
  const latin = (s.match(/[A-Za-z]/g) ?? []).length;
  return cjk > 0 && cjk >= latin / 2;
}

/* ------------------------------------------------------------------------------------ */
/* Section types and ghost modes                                                         */
/* ------------------------------------------------------------------------------------ */

/** Section type for prompts and exemplar retrieval: the outline template, else the unit's part. */
export function sectionTypeOf(template: string | null | undefined, part: string | null | undefined, sectionTitle = ''): string {
  const t = (template ?? '').toLowerCase();
  if (t) {
    if (t.startsWith('abs')) return 'abstract';
    if (t.startsWith('intro')) return 'intro';
    if (t.startsWith('concl')) return 'concl';
    if (t.startsWith('result')) return 'results';
    if (t.startsWith('caption')) return 'caption';
    return 'body';
  }
  switch (part) {
    case 'abstract':
      return 'abstract';
    case 'intro':
      return 'intro';
    case 'concl':
      return 'concl';
    case 'caption':
      return 'caption';
    case 'footnote':
      return 'other';
    default:
      return /result|performance/i.test(sectionTitle) ? 'results' : 'body';
  }
}

/** docs/design.md: complete-my-sentence for Introduction, Conclusions and Abstract; auto-propose elsewhere. */
export function defaultGhostMode(sectionType: string): GhostMode {
  return sectionType === 'abstract' || sectionType === 'intro' || sectionType === 'concl' ? 'complete-my-sentence' : 'auto-propose';
}

/* ------------------------------------------------------------------------------------ */
/* Outline lookup                                                                        */
/* ------------------------------------------------------------------------------------ */

/** Index of a paragraph id of the form "<sectionId>/p<k>" (or "p<k>"), else null. */
export function paragraphIndex(paragraphId: string | null | undefined): number | null {
  const m = /(?:^|\/)p(\d+)$/.exec(paragraphId ?? '');
  return m ? Number(m[1]) : null;
}

export interface OutlinePlace {
  section: OutlineSection | null;
  paragraph: OutlineParagraph | null;
}

/**
 * The outline section of a unit (matched by sectionId) and its paragraph: by pid equal to the unit's
 * paragraphId (or its "p<k>" suffix), else by position (k-th paragraph of the section).
 */
export function findOutlinePlace(outline: Outline, sectionId: string | null | undefined, paragraphId: string | null | undefined, indexOverride?: number | null): OutlinePlace {
  const section = outline.sections.find((s) => s.id === sectionId) ?? null;
  if (!section) return { section: null, paragraph: null };
  const pid = paragraphId ?? '';
  const suffix = pid.includes('/') ? pid.slice(pid.lastIndexOf('/') + 1) : pid;
  let paragraph = pid ? (section.paragraphs.find((p) => p.pid === pid) ?? section.paragraphs.find((p) => p.pid === suffix) ?? null) : null;
  const idx = indexOverride ?? paragraphIndex(pid);
  if (!paragraph && idx !== null && idx >= 0 && idx < section.paragraphs.length) paragraph = section.paragraphs[idx] ?? null;
  return { section, paragraph };
}

/* ------------------------------------------------------------------------------------ */
/* Cursor context                                                                        */
/* ------------------------------------------------------------------------------------ */

export interface CursorPlace {
  /** The unit the cursor is in (the partial sentence) or the last unit before it. */
  anchor: SentenceUnit | null;
  /** True when the cursor starts a new paragraph after `anchor`. */
  newParagraph: boolean;
  sectionId: string;
  sectionTitle: string;
  part: string;
  paragraphId: string | null;
  /** Paragraph index used for the outline lookup when paragraphId does not match (new paragraph). */
  paragraphIndex: number | null;
  previousParagraphs: string[];
  /** Text of the current paragraph before the sentence being typed. */
  paragraphBefore: string;
}

const join2 = (a: string, b: string): string => (a && b ? `${a.replace(/\s+$/, '')} ${b.replace(/^\s+/, '')}` : a || b);
const PARAGRAPH_BREAK = /\n[ \t]*\n|\\(?:sub)*section\*?\s*[[{]|\\paragraph\s*\{|\\begin\{(?:figure|table|equation|align)/;

/** Where the ghost is asked for. `prefix` is the part of the current sentence already typed. */
export function cursorPlace(doc: DocState, docs: Pick<DocService, 'context' | 'unitText'>, cursor: number, prefix: string): CursorPlace {
  const units = [...doc.units].filter((u) => u.file === doc.file || !u.file).sort((a, b) => a.start - b.start);
  const sentenceStart = Math.max(0, cursor - prefix.length);
  // The partial sentence itself, once segmented, starts where the typed prefix starts.
  const inside = prefix.trim().length === 0 ? undefined : units.find((u) => u.start < cursor && cursor <= u.end && u.start >= sentenceStart - 2);
  if (inside) {
    const c = docs.context(inside.id);
    return {
      anchor: inside,
      newParagraph: false,
      sectionId: c?.sectionId ?? inside.sectionId,
      sectionTitle: c?.sectionTitle ?? '',
      part: c?.part ?? inside.part,
      paragraphId: inside.paragraphId,
      paragraphIndex: paragraphIndex(inside.paragraphId),
      previousParagraphs: (c?.previousParagraphs ?? []).slice(-2),
      paragraphBefore: c?.paragraphBefore ?? '',
    };
  }
  let prev: SentenceUnit | null = null;
  for (const u of units) {
    if (u.end <= sentenceStart) prev = u;
    else break;
  }
  if (!prev) {
    // Nothing segmented before the cursor: use the raw text of the paragraph before it.
    const before = doc.text.slice(Math.max(0, sentenceStart - 3000), sentenceStart);
    const parts = before.split(/\n[ \t]*\n/);
    return {
      anchor: null,
      newParagraph: false,
      sectionId: '',
      sectionTitle: '',
      part: 'body',
      paragraphId: null,
      paragraphIndex: null,
      previousParagraphs: parts.slice(-3, -1).map((p) => p.trim()).filter(Boolean),
      paragraphBefore: (parts[parts.length - 1] ?? '').trim(),
    };
  }
  const c = docs.context(prev.id);
  const prevText = docs.unitText(prev.id) ?? '';
  const gap = doc.text.slice(prev.end, sentenceStart);
  const newParagraph = PARAGRAPH_BREAK.test(gap);
  const ownParagraph = join2(join2(c?.paragraphBefore ?? '', prevText), newParagraph ? (c?.paragraphAfter ?? '') : '');
  const pIdx = paragraphIndex(prev.paragraphId);
  return {
    anchor: prev,
    newParagraph,
    sectionId: c?.sectionId ?? prev.sectionId,
    sectionTitle: c?.sectionTitle ?? '',
    part: c?.part ?? prev.part,
    paragraphId: newParagraph ? null : prev.paragraphId,
    paragraphIndex: newParagraph ? (pIdx === null ? null : pIdx + 1) : pIdx,
    previousParagraphs: newParagraph ? [...(c?.previousParagraphs ?? []), ownParagraph].slice(-2) : (c?.previousParagraphs ?? []).slice(-2),
    paragraphBefore: newParagraph ? '' : ownParagraph,
  };
}

/** The intent note right above the cursor: an intent line within 3 lines above, with no blank line in between. */
export function nearestIntentNote(doc: DocState, cursor: number): string | null {
  if (!doc.intentLines?.length) return null;
  const before = doc.text.slice(0, cursor);
  let best: { end: number; text: string } | null = null;
  for (const il of doc.intentLines) {
    if (il.end > cursor && !(il.start <= cursor && cursor <= il.end)) continue;
    if (!best || il.end > best.end) best = { end: il.end, text: il.text };
  }
  if (!best) return null;
  const between = before.slice(Math.min(best.end, before.length));
  if (/\n[ \t]*\n/.test(between)) return null;
  if ((between.match(/\n/g) ?? []).length > 3) return null;
  const t = best.text.trim();
  return t.length > 0 ? t : null;
}

/** Context around a source line (for intent lines, which are not units). */
export function lineContext(doc: DocState, docs: Pick<DocService, 'context' | 'unitText'>, line: number): { start: number; end: number; paragraphBefore: string; paragraphAfter: string; sectionTitle: string; sectionId: string; part: string; paragraphId: string | null } {
  const il = doc.intentLines.find((x) => x.line === line);
  let start: number;
  let end: number;
  if (il) {
    start = il.start;
    end = il.end;
  } else {
    const lines = doc.text.split('\n');
    const ln = Math.max(1, Math.min(lines.length, line));
    start = lines.slice(0, ln - 1).reduce((n, l) => n + l.length + 1, 0);
    end = start + (lines[ln - 1]?.length ?? 0);
  }
  const units = [...doc.units].sort((a, b) => a.start - b.start);
  let prev: SentenceUnit | null = null;
  let next: SentenceUnit | null = null;
  for (const u of units) {
    if (u.end <= start) prev = u;
    else if (u.start >= end) {
      next = u;
      break;
    }
  }
  let paragraphBefore = '';
  let paragraphAfter = '';
  let sectionTitle = '';
  let sectionId = '';
  let part = 'body';
  let paragraphId: string | null = null;
  if (prev && !PARAGRAPH_BREAK.test(doc.text.slice(prev.end, start))) {
    const c = docs.context(prev.id);
    paragraphBefore = join2(c?.paragraphBefore ?? '', docs.unitText(prev.id) ?? '');
    sectionTitle = c?.sectionTitle ?? '';
    sectionId = c?.sectionId ?? prev.sectionId;
    part = c?.part ?? prev.part;
    paragraphId = prev.paragraphId;
  }
  if (next && !PARAGRAPH_BREAK.test(doc.text.slice(end, next.start))) {
    const c = docs.context(next.id);
    paragraphAfter = join2(docs.unitText(next.id) ?? '', c?.paragraphAfter ?? '');
    if (!sectionId) {
      sectionTitle = c?.sectionTitle ?? '';
      sectionId = c?.sectionId ?? next.sectionId;
      part = c?.part ?? next.part;
      paragraphId = next.paragraphId;
    }
  }
  if (!sectionId) {
    const near = prev ?? next;
    if (near) {
      const c = docs.context(near.id);
      sectionTitle = c?.sectionTitle ?? '';
      sectionId = c?.sectionId ?? near.sectionId;
      part = c?.part ?? near.part;
    }
  }
  return { start, end, paragraphBefore, paragraphAfter, sectionTitle, sectionId, part, paragraphId };
}
