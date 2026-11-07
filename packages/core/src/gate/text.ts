/**
 * Text-sanity checks of the faithfulness gate: CJK in paper text, model reasoning or chat leaking into
 * the sentence, markdown, word counts, and placeholder descriptions.
 *
 * OWNER: core-gate agent.
 */
import { scanLatex } from '../latex/tokens';

/** CJK ideographs, kana, hangul, CJK punctuation and full-width forms. */
export const CJK_RE = /[⺀-⿟　-〿぀-ヿ㄀-ㄯ㄰-㆏ㆠ-ㇿ㐀-䶿一-鿿가-힯豈-﫿︰-﹏＀-￯]|[\ud840-\ud87f][\udc00-\udfff]/;

export function findCjk(text: string): { start: number; end: number; raw: string } | null {
  const re = new RegExp(CJK_RE.source, 'g');
  const m = re.exec(text);
  if (!m) return null;
  // extend over the run of CJK characters for a readable excerpt
  let end = m.index + m[0].length;
  const run = new RegExp(`(?:${CJK_RE.source})+`, 'y');
  run.lastIndex = m.index;
  const r = run.exec(text);
  if (r) end = m.index + r[0].length;
  return { start: m.index, end, raw: text.slice(m.index, end) };
}

interface LeakHit {
  start: number;
  end: number;
  raw: string;
  why: string;
}

const LEAK_START =
  /^\s*(?:let me\b|let's\b|i will\b|i'll\b|i would\b|i think\b|i can\b|i have\b|i've\b|i am\b|i'm\b|here is\b|here's\b|here are\b|sure\b|okay\b|ok\b[,.!]|certainly\b|of course\b|absolutely\b|great\b[,.!]|the next sentence\b|next sentence\b|(?:sentence|output|answer|rewrite|rewritten|revised|revision|draft|note|explanation|translation|suggestion|response)\s*\d*\s*:)/i;

const LEAK_ANY =
  /\b(?:let me|i will|i'll|here is|here's|here are|the next sentence|the following sentence|as an ai\b|as a language model|i hope this|feel free to|in this rewrite|i have rewritten|i rewrote|i've rewritten|i changed|rewritten sentence|revised sentence)\b/i;

/** Model reasoning, chat or markdown in a sentence. Returns the first hit. */
export function findReasoningLeak(text: string): LeakHit | null {
  const s = text;
  let m = LEAK_START.exec(s);
  if (m) {
    const lead = m[0].length - m[0].trimStart().length;
    return { start: m.index + lead, end: m.index + m[0].length, raw: m[0].trim(), why: 'starts like a chat reply or a label' };
  }
  m = LEAK_ANY.exec(s);
  if (m) return { start: m.index, end: m.index + m[0].length, raw: m[0], why: 'reads like model reasoning or chat' };
  // markdown: bullets, numbered lists, headings, quotes at line start; bold; code spans
  m = /^[ \t]*(?:[-*+•]\s+|\d{1,2}[.)]\s+(?=[A-Za-z])|#{1,6}\s+|>\s+)/m.exec(s);
  if (m) return { start: m.index, end: m.index + m[0].length, raw: m[0].trim(), why: 'markdown list or heading' };
  m = /\*\*[^*\n]+\*\*|__[^_\n]+__/.exec(s);
  if (m) return { start: m.index, end: m.index + m[0].length, raw: m[0], why: 'markdown emphasis' };
  m = /(^|[^`])`([^`'\n]+)`(?!`)/.exec(s);
  if (m) {
    const st = m.index + m[1]!.length;
    return { start: st, end: m.index + m[0].length, raw: m[0].slice(m[1]!.length), why: 'markdown code span' };
  }
  // wrapping quotes (LaTeX ``..'' quotes are fine)
  m = /^\s*["“”‘]/.exec(s);
  if (m) return { start: m.index, end: m.index + m[0].length, raw: m[0].trim(), why: 'wrapped in quotes' };
  m = /["“”](?:\s*[.!?])?\s*$/.exec(s);
  if (m) return { start: m.index, end: m.index + m[0].length, raw: m[0].trim(), why: 'wrapped in quotes' };
  return null;
}

/**
 * Words of a LaTeX sentence as a reader sees them: comments dropped, \cite/\ref/\label dropped,
 * each math span counts as one word, command names dropped (their arguments stay).
 */
export function countWords(text: string): number {
  const scan = scanLatex(text);
  const blanks: Array<[number, number, string]> = [];
  for (const c of scan.comments) blanks.push([c.start, c.end, ' ']);
  for (const k of scan.keyCommands) blanks.push([k.start, k.end, ' ']);
  for (const m of scan.math) blanks.push([m.start, m.end, ' M ']);
  blanks.sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [s, e, r] of blanks) {
    if (s < pos) continue;
    out += text.slice(pos, s) + r;
    pos = e;
  }
  out += text.slice(pos);
  out = out.replace(/\\[A-Za-z@]+\*?/g, ' ').replace(/\\./g, ' ').replace(/[{}~]/g, ' ');
  let n = 0;
  for (const w of out.split(/\s+/)) if (/[A-Za-z0-9]/.test(w) || CJK_RE.test(w)) n++;
  return n;
}

/** Words of `text` usable in a placeholder description: no LaTeX, no digits, no special characters. */
export function cleanWords(text: string): string[] {
  const scan = scanLatex(text);
  const blanks: Array<[number, number]> = [];
  for (const c of scan.comments) blanks.push([c.start, c.end]);
  for (const k of scan.keyCommands) blanks.push([k.start, k.end]);
  for (const m of scan.math) blanks.push([m.start, m.end]);
  blanks.sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [s, e] of blanks) {
    if (s < pos) continue;
    out += text.slice(pos, s) + ' ';
    pos = e;
  }
  out += text.slice(pos);
  out = out
    .replace(/\[[^\]\n]*\]/g, ' ')
    .replace(/\\[A-Za-z@]+\*?/g, ' ')
    .replace(/\\./g, ' ')
    .replace(/[0-9]+(?:[.,][0-9]+)*/g, ' ')
    .replace(/[^A-Za-z\s'-]/g, ' ');
  return out
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ''))
    .filter((w) => w.length > 0);
}

/**
 * The words of cleanWords with their offsets in `text`, computed in one pass (the gate asks for the
 * words around every numeral of a sentence; calling cleanWords on each prefix was quadratic).
 */
export function cleanWordSpans(text: string): Array<{ word: string; start: number; end: number }> {
  const scan = scanLatex(text);
  const chars = text.split('');
  const blank = (s: number, e: number): void => {
    for (let i = Math.max(0, s); i < Math.min(e, chars.length); i++) chars[i] = ' ';
  };
  for (const c of scan.comments) blank(c.start, c.end);
  for (const k of scan.keyCommands) blank(k.start, k.end);
  for (const m of scan.math) blank(m.start, m.end);
  const sp = (m: string): string => ' '.repeat(m.length);
  const out = chars
    .join('')
    .replace(/\[[^\]\n]*\]/g, sp)
    .replace(/\\[A-Za-z@]+\*?/g, sp)
    .replace(/\\./g, sp)
    .replace(/[0-9]+(?:[.,][0-9]+)*/g, sp)
    .replace(/[^A-Za-z\s'-]/g, ' ');
  const words: Array<{ word: string; start: number; end: number }> = [];
  for (const m of out.matchAll(/\S+/g)) {
    const lead = /^['-]*/.exec(m[0])![0].length;
    const w = m[0].replace(/^['-]+|['-]+$/g, '');
    if (w) words.push({ word: w, start: m.index + lead, end: m.index + lead + w.length });
  }
  return words;
}

/** Sanitize a free string for use inside a placeholder (ASCII-safe for pdflatex, no brackets). */
export function placeholderSafe(s: string, max = 60): string {
  const t = s
    .replace(/[\\{}$%#&_^~[\]\n\r]/g, ' ')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? t.slice(0, max).trim() : t;
}
