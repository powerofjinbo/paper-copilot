/**
 * .bib parsing with @retorquere/bibtex-parser (pure-JS build, no WASM init needed).
 *
 * Titles keep the author's capitalisation (no sentence-casing, no case-protection markup); LaTeX is
 * converted to Unicode by the parser (`M{\"u}ller` -> Müller, `$\tau$` -> τ). Identifiers are
 * normalised for lookups: arXiv ids without `arXiv:` and version suffix, DOIs without resolver
 * prefixes.
 */
import { parse, type Creator } from '@retorquere/bibtex-parser/js';

export interface BibEntry {
  key: string;
  type: string;
  title: string;
  /** Rendered author list ("Chun-Yi Wang, Xiangyang Ju, Shih-Chieh Hsu et al."). */
  authors: string;
  authorNames: string[];
  /** The list ends with "and others" (or was truncated). */
  etAl: boolean;
  year: number | null;
  arxiv: string | null;
  doi: string | null;
  abstract: string | null;
  /** .bib file (relative to texRoot) the entry came from. */
  file: string;
}

const ARXIV_NEW = /^(\d{4}\.\d{4,5})(?:v\d+)?$/;
const ARXIV_OLD = /^([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i;

/** Normalised arXiv id ("arXiv:2203.08800v2" -> "2203.08800"), or null if it is not one. */
export function normalizeArxiv(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().replace(/^arxiv:/i, '').replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, '').replace(/\.pdf$/i, '');
  s = s.trim();
  const m = ARXIV_NEW.exec(s) ?? ARXIV_OLD.exec(s);
  return m ? m[1]! : null;
}

/** Normalised DOI ("https://doi.org/10.1/ABC" -> "10.1/ABC"), or null. Comparison is case-insensitive. */
export function normalizeDoi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .trim();
  return /^10\.\d{3,9}\/\S+$/.test(s) ? s : null;
}

const MARKUP_TAG = /<\/?(?:span|i|b|em|strong|sup|sub|sc|nc|a|br)\b[^>]*>/gi;

/** Plain text from a parsed field (markup tags removed, whitespace collapsed, Unicode NFC). */
export function cleanField(s: string | undefined | null): string {
  if (!s) return '';
  return s.replace(MARKUP_TAG, '').replace(/\s+/g, ' ').trim().normalize('NFC');
}

function creatorName(c: Creator): string {
  if (c.name) return cleanField(c.name);
  return cleanField([c.firstName, c.prefix, c.lastName, c.suffix].filter(Boolean).join(' '));
}

export function renderAuthors(names: string[], etAl: boolean, max = 3): string {
  if (names.length === 0) return etAl ? 'et al.' : '';
  const shown = names.slice(0, max);
  const more = etAl || names.length > max;
  return shown.join(', ') + (more ? ' et al.' : '');
}

function yearOf(fields: Record<string, unknown>): number | null {
  for (const k of ['year', 'date', 'eprintdate']) {
    const v = fields[k];
    if (typeof v === 'string') {
      const m = /(1[89]\d{2}|20\d{2}|21\d{2})/.exec(v);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

function arxivOf(fields: Record<string, unknown>): string | null {
  const str = (k: string) => (typeof fields[k] === 'string' ? (fields[k] as string) : null);
  const prefix = (str('archiveprefix') ?? str('eprinttype') ?? '').toLowerCase();
  const eprint = str('eprint');
  if (eprint && (prefix === '' || prefix === 'arxiv')) {
    const a = normalizeArxiv(eprint);
    if (a) return a;
  }
  for (const k of ['arxiv', 'arxivid', 'arxiv_id']) {
    const a = normalizeArxiv(str(k));
    if (a) return a;
  }
  for (const k of ['url', 'journal', 'note', 'howpublished']) {
    const v = str(k);
    const m = v ? /arxiv(?:\.org\/(?:abs|pdf)\/|:\s*)([\w./-]+?)(?:\.pdf)?(?=[\s,;}]|$)/i.exec(v) : null;
    if (m) {
      const a = normalizeArxiv(m[1]);
      if (a) return a;
    }
  }
  return null;
}

function doiOf(fields: Record<string, unknown>): string | null {
  const d = typeof fields.doi === 'string' ? normalizeDoi(fields.doi) : null;
  if (d) return d;
  const url = typeof fields.url === 'string' ? fields.url : '';
  return /doi\.org\//i.test(url) ? normalizeDoi(url) : null;
}

export interface BibParseResult {
  entries: BibEntry[];
  errors: string[];
}

export function parseBibText(text: string, file: string): BibParseResult {
  const errors: string[] = [];
  let lib;
  try {
    lib = parse(text, { english: ['__none__'], caseProtection: false });
  } catch (e) {
    return { entries: [], errors: [`${file}: ${e instanceof Error ? e.message : String(e)}`] };
  }
  for (const er of lib.errors) errors.push(`${file}: ${er.error}`);
  const entries: BibEntry[] = [];
  for (const e of lib.entries) {
    if (!e.key) continue;
    const fields = e.fields as unknown as Record<string, unknown>;
    const creators = (Array.isArray(fields.author) ? fields.author : Array.isArray(fields.editor) ? fields.editor : []) as Creator[];
    let etAl = false;
    const names: string[] = [];
    for (const c of creators) {
      const n = creatorName(c);
      if (/^others$/i.test(n) || /^et\.? al\.?$/i.test(n)) etAl = true;
      else if (n) names.push(n);
    }
    if (names.length === 0 && typeof fields.collaboration === 'string') names.push(`${cleanField(fields.collaboration)} Collaboration`);
    entries.push({
      key: e.key,
      type: e.type,
      title: cleanField(typeof fields.title === 'string' ? fields.title : ''),
      authors: renderAuthors(names, etAl),
      authorNames: names,
      etAl,
      year: yearOf(fields),
      arxiv: arxivOf(fields),
      doi: doiOf(fields),
      abstract: typeof fields.abstract === 'string' ? cleanField(fields.abstract) || null : null,
      file,
    });
  }
  return { entries, errors };
}
