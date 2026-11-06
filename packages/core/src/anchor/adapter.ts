/**
 * Thin adapter between anchoring and the text/LaTeX helpers owned by other modules
 * (text/normalize.ts, latex/tokens.ts).
 *
 * Production behaviour: every function calls the real implementation. The ONLY exception is the
 * `not implemented: <name>` error thrown by contract stubs while a module is still being written: in
 * that case (and only that case) a small local fallback is used, and the decision is cached per
 * function so a stub does not cost an exception per sentence. Any other error is re-thrown. Once the
 * real function exists the fallback is never reached.
 *
 * The fallbacks are deliberately simple but follow the same contracts (see normalize.ts / tokens.ts),
 * so anchoring behaves sensibly either way.
 */
import { editDistanceWords, normalizeForHash, similarity } from '../text/normalize';
import { findPlaceholders, latexTokensOf } from '../latex/tokens';
import type { TextAnalysis } from './units';

function isNotImplemented(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith('not implemented');
}

/** Wrap `real` so a "not implemented" stub falls back to `fallback` (cached after the first miss). */
function withFallback<A extends unknown[], R>(real: (...a: A) => R, fallback: (...a: A) => R): (...a: A) => R {
  let useFallback = false;
  return (...a: A): R => {
    if (!useFallback) {
      try {
        return real(...a);
      } catch (e) {
        if (!isNotImplemented(e)) throw e;
        useFallback = true;
      }
    }
    return fallback(...a);
  };
}

/* ------------------------------------------------------------------------------------ */
/* Fallbacks                                                                             */
/* ------------------------------------------------------------------------------------ */

const DISPLAY_ENVS = 'equation|equation\\*|align|align\\*|gather|gather\\*|multline|multline\\*|eqnarray|eqnarray\\*|displaymath';

/** Fallback for normalizeForHash (same rules, regex-based). */
export function fallbackNormalize(latex: string): string {
  let s = latex.replace(/(^|[^\\])%[^\n]*/g, '$1');
  s = s.replace(new RegExp(`\\\\begin\\{(${DISPLAY_ENVS})\\}[\\s\\S]*?\\\\end\\{\\1\\}`, 'g'), '⟨M⟩');
  s = s.replace(/\$\$[\s\S]*?\$\$/g, '⟨M⟩').replace(/\\\[[\s\S]*?\\\]/g, '⟨M⟩');
  s = s.replace(/\\\([\s\S]*?\\\)/g, '⟨M⟩').replace(/(^|[^\\])\$(?:\\\$|[^$])*\$/g, '$1⟨M⟩');
  s = s.replace(/\\(?:cite[a-z]*|Cite|autocite|parencite|textcite)\*?(?:\[[^\]]*\])*\{([^}]*)\}/g, (_m, k: string) =>
    `⟨C:${k.split(',').map((x) => x.trim()).join(',')}⟩`,
  );
  s = s.replace(/\\(?:ref|eqref|cref|Cref|autoref|pageref)\{([^}]*)\}/g, '⟨R:$1⟩');
  s = s.replace(/\\label\{[^}]*\}/g, '');
  s = s.replace(/~|\\[,;:! ]/g, ' ').replace(/\\%/g, '%');
  s = s.replace(/\\(?:emph|textit|textbf|textrm|textsc|mbox)\{([^{}]*)\}/g, '$1');
  return s.replace(/\s+/g, ' ').trim();
}

function fallbackTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}⟨]+|[^\p{L}\p{N}⟩]+$/gu, ''))
    .filter((w) => w.length > 0);
}

/** Word-level Levenshtein distance normalized by the longer token count. */
export function wordLevenshtein(a: string[], b: string[]): number {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return 0;
  if (n === 0 || m === 0) return 1;
  let prev = new Array<number>(m + 1);
  let cur = new Array<number>(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    const ai = a[i - 1];
    for (let j = 1; j <= m; j++) {
      const sub = (prev[j - 1] ?? 0) + (ai === b[j - 1] ? 0 : 1);
      const del = (prev[j] ?? 0) + 1;
      const ins = (cur[j - 1] ?? 0) + 1;
      cur[j] = Math.min(sub, del, ins);
    }
    [prev, cur] = [cur, prev];
  }
  return (prev[m] ?? 0) / Math.max(n, m);
}

export function fallbackEditDistance(a: string, b: string): number {
  return wordLevenshtein(fallbackTokens(fallbackNormalize(a)), fallbackTokens(fallbackNormalize(b)));
}

export function fallbackSimilarity(a: string, b: string): number {
  const na = fallbackNormalize(a);
  const nb = fallbackNormalize(b);
  if (na.toLowerCase() === nb.toLowerCase()) return 1;
  return 1 - wordLevenshtein(fallbackTokens(na), fallbackTokens(nb));
}

const PLACEHOLDER_RE = /\[([^\[\]\n]{0,160})\]/g;

/** Fallback for latexTokensOf(..).cites + findPlaceholders(..). */
export function fallbackAnalyze(text: string): TextAnalysis {
  const cites: string[] = [];
  const citeRe = /\\(?:cite[a-z]*|Cite|autocite|parencite|textcite)\*?(?:\[[^\]]*\])*\{([^}]*)\}/g;
  for (let m = citeRe.exec(text); m; m = citeRe.exec(text)) {
    for (const k of (m[1] ?? '').split(',')) if (k.trim()) cites.push(k.trim());
  }
  const placeholders: string[] = [];
  PLACEHOLDER_RE.lastIndex = 0;
  for (let m = PLACEHOLDER_RE.exec(text); m; m = PLACEHOLDER_RE.exec(text)) {
    const before = text.slice(0, m.index);
    // A LaTeX optional argument: \cmd[..], \\[..], }[..], ][..]
    if (/(\\[A-Za-z@]+\*?|\\\\|[}\]])$/.test(before)) continue;
    const body = (m[1] ?? '').trim();
    if (body === 'ref' || /^fact\?/.test(body) || /^claim:/.test(body) || body.endsWith('?')) placeholders.push(m[0]);
  }
  return { cites, placeholders };
}

/* ------------------------------------------------------------------------------------ */
/* Adapted functions used by anchoring                                                   */
/* ------------------------------------------------------------------------------------ */

export const normText: (latex: string) => string = withFallback(normalizeForHash, fallbackNormalize);
export const editDistance: (a: string, b: string) => number = withFallback(editDistanceWords, fallbackEditDistance);
export const textSimilarity: (a: string, b: string) => number = withFallback(similarity, fallbackSimilarity);

function realAnalyze(text: string): TextAnalysis {
  const cites = latexTokensOf(text).cites;
  const placeholders = findPlaceholders(text).map((p) => p.text);
  return { cites, placeholders };
}

/** Default cite/placeholder extraction: latexTokensOf + findPlaceholders. */
export const defaultAnalyze: (text: string) => TextAnalysis = withFallback(realAnalyze, fallbackAnalyze);
