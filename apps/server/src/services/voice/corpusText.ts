/**
 * Corpus text helpers: sentence splitting for exemplars and norms, section-type canonicalization,
 * and importers (plain text, Markdown, LaTeX, PDF via pdftotext).
 *
 * LaTeX goes through core `segment` (the same boundaries as the paper's own sentence units and the
 * skill's style_check) and `plainText`; plain text (txt, md, pdftotext output) through a small
 * splitter with the same rule: break after . ? ! (plus closing quotes/brackets) and whitespace when the
 * next character starts a sentence and the token before the period is not an abbreviation.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ABBREVIATIONS, plainText, segment, type CorpusEntry, type Part } from '@paper-copilot/core';
import { probeExecutable, runProcess } from '../build/proc';

export type SectionType = 'abstract' | 'intro' | 'body' | 'results' | 'concl' | 'caption' | 'other';
export const SECTION_TYPES: readonly SectionType[] = ['abstract', 'intro', 'body', 'results', 'concl', 'caption', 'other'];

/** Canonical section type ("Introduction" -> intro, "Summary and outlook" -> concl, "method" -> body). */
export function canonicalSectionType(s: string | null | undefined): SectionType {
  const t = (s ?? '').trim().toLowerCase();
  if (!t) return 'other';
  if ((SECTION_TYPES as readonly string[]).includes(t)) return t as SectionType;
  if (/^abs/.test(t)) return 'abstract';
  if (/intro|motivation|^background/.test(t)) return 'intro';
  if (/conclu|summary|outlook|discussion/.test(t)) return 'concl';
  if (/result|performance|evaluation/.test(t)) return 'results';
  if (/caption|figure|table/.test(t)) return 'caption';
  if (/method|setup|model|data|sample|simulation|analysis|selection|body|appendix|^app/.test(t)) return 'body';
  return 'other';
}

/** Section type of a segmented sentence from its part and section title. */
export function sectionTypeOfPart(part: Part, sectionTitle: string): SectionType {
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

/* ------------------------------------------------------------------------------------ */
/* Core adapters (core may still be a stub while it is being written)                   */
/* ------------------------------------------------------------------------------------ */

function isNotImplemented(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith('not implemented');
}

/** core plainText, or a crude stand-in while core is a stub. */
export function toPlain(latex: string): string {
  try {
    return plainText(latex);
  } catch (e) {
    if (!isNotImplemented(e)) throw e;
    return latex
      .replace(/(^|[^\\])%[^\n]*/g, '$1')
      .replace(/\$[^$]*\$/g, 'x')
      .replace(/\\(?:cite[a-z]*|label)\*?(?:\[[^\]]*\])*\{[^}]*\}/g, '')
      .replace(/\\(?:ref|eqref|cref|Cref|autoref)\{[^}]*\}/g, '1')
      .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g, '$1')
      .replace(/\\[a-zA-Z]+\*?/g, '')
      .replace(/[{}~]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

/* ------------------------------------------------------------------------------------ */
/* Splitting                                                                             */
/* ------------------------------------------------------------------------------------ */

const ABBR = new Set(DEFAULT_ABBREVIATIONS.map((a) => a.toLowerCase()));

/** Join a pdftotext / hard-wrapped paragraph: de-hyphenate line ends, collapse whitespace. */
export function unwrapParagraph(p: string): string {
  return p
    .replace(/(\p{Ll})-\n(\p{Ll})/gu, '$1$2')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t ]+/g, ' ')
    .trim();
}

/** Split one paragraph of plain text into sentences. */
export function splitPlainSentences(paragraph: string): string[] {
  const s = unwrapParagraph(paragraph);
  const out: string[] = [];
  let start = 0;
  const re = /[.?!]["”’)\]]*\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const endPunct = m.index + m[0].trimEnd().length;
    const next = s[m.index + m[0].length];
    if (next === undefined) break;
    if (!/[\p{Lu}\p{N}“"(\[‘]|[^\x00-\x7f]/u.test(next) || /\p{Ll}/u.test(next)) continue;
    const before = s.slice(start, m.index + 1);
    const rawTok = (before.split(/\s+/).pop() ?? '').replace(/^[(\[“"]+/, '');
    if (ABBR.has(rawTok.toLowerCase())) continue;
    // Single capital initials ("A. Fixture") are not sentence ends.
    if (/^\p{Lu}\.$/u.test(rawTok)) continue;
    out.push(s.slice(start, endPunct).trim());
    start = m.index + m[0].length;
  }
  const rest = s.slice(start).trim();
  if (rest) out.push(rest);
  return out.filter((x) => x.length > 0);
}

/** Paragraphs of plain text (blank-line separated). */
export function plainParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export interface CorpusSentence {
  /** `${entryId}#${index}` */
  id: string;
  entryId: string;
  text: string;
  sectionType: SectionType;
}

/** Does this text look like LaTeX source (not prose that mentions a backslash)? */
export function looksLikeLatex(text: string, source = ''): boolean {
  if (/\.(tex|ltx)$/i.test(source)) return true;
  if (/\.(txt|md|pdf)$/i.test(source)) return false;
  return /\\(begin|section|subsection|cite[pt]?|ref|emph|textbf|label)\b|\$[^$\n]+\$/.test(text);
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** A sentence usable as a voice sample: 4..80 words, mostly letters, no leftover markup. */
export function usableSentence(s: string): boolean {
  const n = wordCount(s);
  if (n < 4 || n > 80) return false;
  const letters = (s.match(/\p{L}/gu) ?? []).length;
  return letters >= 0.5 * s.replace(/\s+/g, '').length;
}

let segmentMissing = false;

/** Sentences of one corpus entry (plain text), with section types. */
export function entrySentences(e: CorpusEntry): CorpusSentence[] {
  const base = canonicalSectionType(e.sectionType);
  const out: CorpusSentence[] = [];
  const push = (text: string, st: SectionType) => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (!usableSentence(t)) return;
    out.push({ id: `${e.id}#${out.length}`, entryId: e.id, text: t, sectionType: st });
  };
  if (looksLikeLatex(e.text, e.source) && !segmentMissing) {
    try {
      const seg = segment(e.text);
      for (const s of seg.sentences) {
        if (s.kind === 'footnote') continue;
        const st = base === 'other' ? sectionTypeOfPart(s.part, s.sectionTitle) : s.kind === 'caption' ? 'caption' : base;
        push(toPlain(s.text), st);
      }
      return out;
    } catch (err) {
      if (!isNotImplemented(err)) throw err;
      segmentMissing = true;
    }
  }
  const plain = looksLikeLatex(e.text, e.source) ? toPlain(e.text) : e.text;
  for (const p of plainParagraphs(plain)) for (const s of splitPlainSentences(p)) push(s, base);
  return out;
}

/* ------------------------------------------------------------------------------------ */
/* Importers                                                                             */
/* ------------------------------------------------------------------------------------ */

export type ImportFormat = 'txt' | 'md' | 'tex' | 'pdf';

export interface ImportOptions {
  source: string;
  sectionType?: string | null;
  unassisted: boolean;
}

type NewEntry = Omit<CorpusEntry, 'id'>;

/** Plain text: one entry (paragraph structure kept). */
export function importPlainText(text: string, o: ImportOptions): NewEntry[] {
  const clean = plainParagraphs(text).map(unwrapParagraph).join('\n\n');
  return clean ? [{ text: clean, source: o.source, sectionType: canonicalSectionType(o.sectionType), unassisted: o.unassisted }] : [];
}

/** Markdown: one entry per heading section, typed by the heading; markup stripped. */
export function importMarkdown(text: string, o: ImportOptions): NewEntry[] {
  const out: NewEntry[] = [];
  let title = '';
  let buf: string[] = [];
  let inFence = false;
  const flush = () => {
    const body = buf
      .join('\n')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
      .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
      .replace(/^>\s?/gm, '');
    const paras = plainParagraphs(body).map(unwrapParagraph).filter((p) => !/^\|/.test(p));
    if (paras.length) {
      const st = o.sectionType ? canonicalSectionType(o.sectionType) : canonicalSectionType(title);
      out.push({ text: paras.join('\n\n'), source: title ? `${o.source} § ${title}` : o.source, sectionType: st, unassisted: o.unassisted });
    }
    buf = [];
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      flush();
      title = h[1]!.trim();
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

/**
 * LaTeX: one entry per section (sentences grouped by section id), typed by part/section title, text
 * kept as LaTeX source so it can be re-segmented. An explicit sectionType overrides the detection.
 */
export function importLatex(text: string, o: ImportOptions): NewEntry[] {
  let seg;
  try {
    seg = segment(text);
  } catch (e) {
    if (!isNotImplemented(e)) throw e;
    return [{ text, source: o.source, sectionType: canonicalSectionType(o.sectionType), unassisted: o.unassisted }];
  }
  const groups = new Map<string, { title: string; st: SectionType; parts: string[] }>();
  for (const s of seg.sentences) {
    if (s.kind === 'footnote') continue;
    const st = o.sectionType ? canonicalSectionType(o.sectionType) : sectionTypeOfPart(s.part, s.sectionTitle);
    const key = `${s.sectionId}|${st}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { title: s.sectionTitle, st, parts: [] }));
    g.parts.push(s.text);
  }
  const out: NewEntry[] = [];
  for (const g of groups.values()) {
    out.push({ text: g.parts.join('\n'), source: g.title ? `${o.source} § ${g.title}` : o.source, sectionType: g.st, unassisted: o.unassisted });
  }
  return out;
}

let pdftotextOk: boolean | null = null;

export function pdftotextAvailable(): boolean {
  if (pdftotextOk === null) pdftotextOk = probeExecutable(process.env.PAPER_PDFTOTEXT ?? 'pdftotext', ['-v']);
  return pdftotextOk;
}

/** Remove pdftotext debris: page numbers, running heads, equation fragments, reference lists. */
export function cleanPdfText(raw: string): string {
  const text = raw.replace(/\f/g, '\n\n').replace(/\r\n?/g, '\n');
  const cut = text.search(/\n\s*(References|REFERENCES|Bibliography)\s*\n/);
  const body = cut > 0 ? text.slice(0, cut) : text;
  const paras = plainParagraphs(body)
    .map((p) =>
      p
        .split('\n')
        .filter((l) => {
          const t = l.trim();
          if (!t) return false;
          if (/^\d{1,4}$/.test(t)) return false; // page numbers
          const letters = (t.match(/\p{L}/gu) ?? []).length;
          return letters >= 0.4 * t.replace(/\s+/g, '').length; // equation debris
        })
        .join('\n'),
    )
    .map(unwrapParagraph)
    .filter((p) => wordCount(p) >= 8);
  return paras.join('\n\n');
}

/** PDF bytes -> plain text via pdftotext (poppler). Throws a clear error when it is not installed. */
export async function pdfToText(data: Uint8Array, timeoutMs = 60_000): Promise<string> {
  if (!pdftotextAvailable()) {
    throw new Error('pdftotext (poppler-utils) is not installed; install it or import the text/LaTeX source instead');
  }
  if (data.length < 5 || Buffer.from(data.subarray(0, 5)).toString('latin1') !== '%PDF-') throw new Error('the upload is not a PDF file');
  const dir = await mkdtemp(join(tmpdir(), 'paper-pdf-'));
  try {
    const file = join(dir, 'in.pdf');
    await writeFile(file, data);
    const r = await runProcess(process.env.PAPER_PDFTOTEXT ?? 'pdftotext', ['-enc', 'UTF-8', '-q', file, '-'], { timeoutMs, maxOutput: 20_000_000 });
    if (r.missing) throw new Error('pdftotext is not installed');
    if (r.timedOut) throw new Error('pdftotext timed out');
    if (r.code !== 0) throw new Error(`pdftotext failed: ${r.stderr.trim().slice(0, 300) || `exit ${r.code}`}`);
    return cleanPdfText(r.stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
