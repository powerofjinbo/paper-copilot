/**
 * Guarded calls into @paper-copilot/core and @paper-copilot/client-core.
 *
 * Decorations, state fields and keymaps run inside CodeMirror transactions: an exception there would stop
 * the author from typing. Every core call made from those paths goes through `guard`, which logs the
 * first failure of each function and returns a small local fallback (good enough to keep the editor
 * usable; the real behaviour lives in core).
 */
import { ChangeSet } from '@codemirror/state';
import {
  diffChanges,
  extractNumerals,
  findIntentLines,
  findPlaceholders,
  matchNumeral,
  renderFact,
  wordDiff,
  type Fact,
  type NumeralMatch,
  type NumeralToken,
  type PlaceholderKind,
  type PlaceholderSpan,
  type SentenceUnit,
} from '@paper-copilot/core';
import { nextInQueue, reviewQueue } from '@paper-copilot/client-core';

const warned = new Set<string>();
/** Names of core functions that failed at least once (exposed for the harness / e2e checks). */
export const fallbackLog: string[] = [];

export function guard<T>(name: string, fn: () => T, fallback: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (!warned.has(name)) {
      warned.add(name);
      fallbackLog.push(name);
      console.warn(`[editor] ${name} failed, using a local fallback:`, err instanceof Error ? err.message : err);
    }
    return fallback();
  }
}

/* ------------------------------------------------------------------------------------ */
/* Intent lines                                                                          */
/* ------------------------------------------------------------------------------------ */

export interface IntentLine {
  start: number;
  end: number;
  line: number;
  text: string;
}

const CJK_RE = /[　-〿぀-ヿ㄀-ㄯ㐀-䶿一-鿿가-힯＀-￯]/;

export function isIntentLineLocal(lineText: string): boolean {
  const trimmed = lineText.trim();
  if (!trimmed || trimmed.startsWith('%')) return false;
  let cjk = 0;
  let latin = 0;
  let nonSpace = 0;
  for (const ch of trimmed) {
    if (/\s/.test(ch)) continue;
    nonSpace++;
    if (CJK_RE.test(ch)) cjk++;
    else if (/[A-Za-z]/.test(ch)) latin++;
  }
  if (nonSpace === 0) return false;
  return cjk / nonSpace >= 0.3 || (cjk >= 4 && cjk > latin);
}

function intentLinesLocal(text: string): IntentLine[] {
  const out: IntentLine[] = [];
  let pos = 0;
  let line = 1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl < 0 ? text.length : nl;
    const content = text.slice(pos, end);
    if (CJK_RE.test(content) && isIntentLineLocal(content)) out.push({ start: pos, end, line, text: content });
    if (nl < 0) break;
    pos = nl + 1;
    line++;
  }
  return out;
}

export function intentLinesOf(text: string): IntentLine[] {
  if (!CJK_RE.test(text)) return [];
  return guard('findIntentLines', () => findIntentLines(text), () => intentLinesLocal(text));
}

/* ------------------------------------------------------------------------------------ */
/* Placeholders                                                                          */
/* ------------------------------------------------------------------------------------ */

function placeholdersLocal(text: string): PlaceholderSpan[] {
  const out: PlaceholderSpan[] = [];
  const re = /\[([^[\]\n]{1,160})\]/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (/(\\[A-Za-z@]+\*?|[}\]]|\\\\)$/.test(before)) continue;
    const content = (m[1] ?? '').trim();
    let kind: PlaceholderKind | null = null;
    if (/^fact\?/i.test(content)) kind = 'fact';
    else if (/^claim:/i.test(content)) kind = 'claim';
    else if (/^(ref|cite\?)$/i.test(content)) kind = 'ref';
    else if (content.endsWith('?')) kind = 'generic';
    if (kind) out.push({ start: m.index, end: m.index + m[0].length, text: m[0], kind });
  }
  return out;
}

export function placeholdersOf(text: string): PlaceholderSpan[] {
  if (text.indexOf('[') < 0) return [];
  return guard('findPlaceholders', () => findPlaceholders(text), () => placeholdersLocal(text));
}

/* ------------------------------------------------------------------------------------ */
/* Numerals and facts                                                                    */
/* ------------------------------------------------------------------------------------ */

function maskKeys(text: string): string {
  return text.replace(/\\(?:cite[a-z]*|ref|eqref|cref|Cref|autoref|pageref|label|begin|end)\*?(\[[^\]]*\])?\{[^}]*\}/g, (m) => ' '.repeat(m.length));
}

function numeralsLocal(text: string): NumeralToken[] {
  const masked = maskKeys(text);
  const out: NumeralToken[] = [];
  const re = /(\d{1,3}(?:(?:,|\{,\})\d{3})+|\d+(?:\.\d+)?|\.\d+)/g;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    const raw = m[0];
    const start = m.index;
    const end = start + raw.length;
    const prev = masked[start - 1] ?? ' ';
    if (/[A-Za-z_^\\]/.test(prev)) continue;
    const clean = raw.replace(/\{,\}|,/g, '');
    const value = Number(clean);
    if (!Number.isFinite(value)) continue;
    const dot = clean.indexOf('.');
    const decimals = dot < 0 ? 0 : clean.length - dot - 1;
    const digits = clean.replace('.', '').replace(/^0+/, '');
    const after = masked.slice(end, end + 40);
    const before = masked.slice(Math.max(0, start - 24), start);
    const percent = /^\s*(\\%|%|~?percent)/.test(after);
    const points = /^[\s~]*(points|percentage points|pp)\b/.test(after);
    const unitMatch = /^[\s~]*(?:\\,)?\s*(GeV|MeV|TeV|keV|eV|mm|cm|m|ns|ps|fb|pb|ab)\b/.exec(after);
    const isUncertainty = /(\\pm|±|\+-)[\s~$]*$/.test(before);
    const structural =
      /(Sec|Secs|Fig|Figs|Eq|Eqs|Table|Tab|Ref|Refs|App|Section|Figure|Appendix)\.?[\s~]*\(?$/i.test(before) ||
      (decimals === 0 && !percent && !points && !unitMatch && value >= 0 && value <= 10) ||
      (decimals === 0 && value >= 1900 && value <= 2099 && !percent && !unitMatch);
    out.push({
      start,
      end,
      raw,
      value,
      decimals,
      sigfigs: Math.max(1, digits.length),
      percent,
      points,
      unit: unitMatch ? (unitMatch[1] ?? null) : null,
      isUncertainty,
      inMath: false,
      structural,
    });
  }
  return out;
}

export function numeralsOf(text: string): NumeralToken[] {
  if (!/\d/.test(text)) return [];
  return guard('extractNumerals', () => extractNumerals(text), () => numeralsLocal(text));
}

function roundTo(x: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
}

function matchLocal(tok: NumeralToken, facts: Fact[]): NumeralMatch[] {
  const out: NumeralMatch[] = [];
  for (const f of facts) {
    if (f.excluded || typeof f.value !== 'number') continue;
    const fields: Array<[string, number]> = [['value', f.value], ...Object.entries(f.uncertainties).map(([k, v]) => [`unc:${k}`, v] as [string, number])];
    for (const [field, v] of fields) {
      const scales: Array<1 | 100> = [1];
      if (Math.abs(f.value) <= 1 && (tok.percent || tok.points || f.unit === '%' || f.unit === 'points')) scales.push(100);
      for (const scale of scales) {
        if (scale === 1 && tok.percent && f.unit !== '%') continue;
        if (roundTo(v * scale, tok.decimals) === tok.value) {
          out.push({ factId: f.id, field, scale });
          break;
        }
      }
    }
  }
  return out;
}

export function matchesOf(tok: NumeralToken, facts: Fact[]): NumeralMatch[] {
  if (facts.length === 0) return [];
  return guard('matchNumeral', () => matchNumeral(tok, facts), () => matchLocal(tok, facts));
}

function fmtSig(x: number, sig: number | null): string {
  if (sig && Number.isFinite(x) && x !== 0) {
    const digits = Math.max(0, sig - 1 - Math.floor(Math.log10(Math.abs(x))));
    return x.toFixed(Math.min(digits, 8));
  }
  return String(x);
}

function renderFactLocal(f: Fact): string {
  if (typeof f.value !== 'number') return `${f.id} = ${f.value}`;
  const v = fmtSig(f.value, f.sigfigs);
  const total = f.uncertainties.total;
  const dec = v.includes('.') ? v.length - v.indexOf('.') - 1 : 0;
  const unc = total !== undefined ? ` ± ${total.toFixed(dec)}` : '';
  return `${f.id} = ${v}${unc}${f.unit ? ' ' + f.unit : ''}`;
}

export function factLabel(f: Fact): string {
  return guard('renderFact', () => renderFact(f), () => renderFactLocal(f));
}

/* ------------------------------------------------------------------------------------ */
/* Diffs                                                                                 */
/* ------------------------------------------------------------------------------------ */

function wordDiffLocal(a: string, b: string): Array<[number, string]> {
  const ta = a.match(/\s+|\S+\s*/g) ?? [];
  const tb = b.match(/\s+|\S+\s*/g) ?? [];
  const n = ta.length;
  const m = tb.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = ta[i] === tb[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: Array<[number, string]> = [];
  const push = (op: number, t: string) => {
    const last = out[out.length - 1];
    if (last && last[0] === op) last[1] += t;
    else out.push([op, t]);
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ta[i] === tb[j]) {
      push(0, ta[i]!);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) push(-1, ta[i++]!);
    else push(1, tb[j++]!);
  }
  while (i < n) push(-1, ta[i++]!);
  while (j < m) push(1, tb[j++]!);
  return out;
}

export function wordDiffOf(a: string, b: string): Array<[number, string]> {
  return guard('wordDiff', () => wordDiff(a, b), () => wordDiffLocal(a, b));
}

/** Minimal common-prefix/suffix replacement: always correct, rarely minimal. */
export function prefixSuffixChanges(a: string, b: string): ChangeSet {
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  if (p === a.length && p === b.length) return ChangeSet.empty(a.length);
  return ChangeSet.of([{ from: p, to: a.length - s, insert: b.slice(p, b.length - s) }], a.length);
}

/** A ChangeSet turning `a` into `b` (core diffChanges, verified; prefix/suffix fallback). */
export function diffChangesOf(a: string, b: string): ChangeSet {
  return guard(
    'diffChanges',
    () => {
      const cs = diffChanges(a, b);
      if (cs.length !== a.length) throw new Error('diffChanges returned a change set of the wrong length');
      return cs;
    },
    () => prefixSuffixChanges(a, b),
  );
}

/* ------------------------------------------------------------------------------------ */
/* Review queue                                                                          */
/* ------------------------------------------------------------------------------------ */

const REVIEW_STATES = new Set(['proposed', 'unsupported']);

export function reviewQueueOf(units: readonly SentenceUnit[]): SentenceUnit[] {
  return guard(
    'reviewQueue',
    () => reviewQueue(units as SentenceUnit[]),
    () => units.filter((u) => REVIEW_STATES.has(u.state)).sort((a, b) => a.start - b.start),
  );
}

export function nextInQueueOf(units: readonly SentenceUnit[], pos: number, dir: 1 | -1): SentenceUnit | null {
  return guard(
    'nextInQueue',
    () => nextInQueue(units as SentenceUnit[], pos, dir),
    () => {
      const q = units.filter((u) => REVIEW_STATES.has(u.state)).sort((a, b) => a.start - b.start);
      if (q.length === 0) return null;
      if (dir === 1) return q.find((u) => u.start > pos) ?? q[0]!;
      for (let i = q.length - 1; i >= 0; i--) if (q[i]!.start < pos) return q[i]!;
      return q[q.length - 1]!;
    },
  );
}
