/**
 * Small, deterministic text helpers for prompt assembly. Content is never XML-escaped: LaTeX such as
 * `$p_T < 1$` must reach the model (and come back) character for character. Only attribute values,
 * which we write ourselves, are escaped.
 */

/** Normalize line endings and strip a BOM so the same file always yields the same bytes. */
export function normText(s: string | null | undefined): string {
  if (typeof s !== 'string') return '';
  return s.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/** Trim and normalize; '' for non-strings. */
export function clean(s: string | null | undefined): string {
  return normText(s).trim();
}

/** Collapse all whitespace (including newlines) to single spaces, for one-line table cells. */
export function oneLine(s: string | null | undefined): string {
  return normText(s).replace(/\s+/g, ' ').trim();
}

export function escAttr(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function attrs(a?: Record<string, string | number | boolean | null | undefined>): string {
  if (!a) return '';
  let out = '';
  for (const k of Object.keys(a)) {
    const v = a[k];
    if (v === null || v === undefined || v === '') continue;
    out += ` ${k}="${escAttr(String(v))}"`;
  }
  return out;
}

/** `<name attrs>\nbody\n</name>`; body is trimmed of surrounding blank lines only. */
export function block(name: string, body: string, a?: Record<string, string | number | boolean | null | undefined>): string {
  const b = normText(body).replace(/^\n+|\n+$/g, '');
  return `<${name}${attrs(a)}>\n${b}\n</${name}>`;
}

/** `<name>content</name>` on one line, content verbatim (used for prefixes and short values). */
export function inline(name: string, content: string, a?: Record<string, string | number | boolean | null | undefined>): string {
  return `<${name}${attrs(a)}>${normText(content)}</${name}>`;
}

/** Codepoint string comparison (locale-independent, so ordering is identical on every machine). */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Unique non-empty trimmed strings, first occurrence order kept. */
export function uniq(xs: ReadonlyArray<string | null | undefined> | null | undefined): string[] {
  const out: string[] = [];
  for (const x of xs ?? []) {
    const t = typeof x === 'string' ? x.trim() : '';
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Clamp an integer into [lo, hi]; non-finite input gives `fallback`. */
export function clampInt(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : fallback;
  return Math.min(hi, Math.max(lo, v));
}

export type NotesLang = 'zh' | 'en';

export function langName(l: NotesLang | string | null | undefined): string {
  return l === 'en' ? 'English' : 'Chinese (简体中文)';
}

/** The notes language as given, defaulting to zh (the product default). */
export function notesLang(l: unknown): NotesLang {
  return l === 'en' ? 'en' : 'zh';
}

/** Join sections with one blank line, skipping empty ones. */
export function joinParts(parts: Array<string | null | undefined | false>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').join('\n\n');
}
