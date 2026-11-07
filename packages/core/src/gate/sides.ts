/**
 * Who a number belongs to. A fact of a two-sided claim ("eff_A (claim=G1; A=Canto-L (ttbar);
 * B=acorn (HNL) + LM)") or a table row ("mean (model=...; label=acorn (HNL) + LM)") has a side: the
 * method, sample or population it measures. The gate uses the sides to check that a sentence gives
 * each number to the method it belongs to, that a derived relation (ratio, difference, relative change)
 * is stated about the two quantities it is computed from, and in which direction.
 *
 * OWNER: core-gate agent.
 */
import type { Fact } from '../schemas';

/** `name (k=v; k=v)` -> {k: v}; nested parentheses inside values are kept ("A=Canto-L (ttbar)"). */
export function factMeta(def: string | null | undefined): Map<string, string> {
  const m = new Map<string, string>();
  const d = String(def ?? '');
  const open = d.indexOf('(');
  const close = d.lastIndexOf(')');
  if (open < 0 || close <= open) return m;
  for (const part of d.slice(open + 1, close).split(/;\s*/)) {
    const kv = /^([^=]+)=(.*)$/.exec(part.trim());
    if (kv) m.set(kv[1]!.trim(), kv[2]!.trim());
  }
  return m;
}

const leafOf = (f: Pick<Fact, 'id'>): string => String(f.id ?? '').split('.').pop() ?? '';

/** The A or B designator of a claim fact ("eff_A", "fake_rate_B", "eff_A_seeds"), or null. */
function abLetter(f: Pick<Fact, 'id'>): 'A' | 'B' | null {
  const m = /(?:^|_)([AB])(?:_|$)/.exec(leafOf(f));
  return m ? (m[1] as 'A' | 'B') : null;
}

/** The method/sample a fact measures: the A or B of its claim, else its row label (or model). */
export function sideNameOf(f: Pick<Fact, 'id' | 'definition'>): string | null {
  const meta = factMeta(f.definition);
  const a = meta.get('A');
  const b = meta.get('B');
  if (a && b) {
    const l = abLetter(f);
    return l === 'A' ? a : l === 'B' ? b : null;
  }
  return meta.get('label') ?? meta.get('model') ?? null;
}

/** The other side of a two-sided claim fact (for "eff_A" the B method), or null. */
export function otherSideOf(f: Pick<Fact, 'id' | 'definition'>): string | null {
  const meta = factMeta(f.definition);
  const a = meta.get('A');
  const b = meta.get('B');
  const l = abLetter(f);
  if (!a || !b || !l) return null;
  return l === 'A' ? b : a;
}

/** "A minus B" orientation of a difference fact of a two-sided claim: [A, B], or null. */
export function claimSidesOf(f: Pick<Fact, 'id' | 'definition'>): [string, string] | null {
  const meta = factMeta(f.definition);
  const a = meta.get('A');
  const b = meta.get('B');
  return a && b ? [a, b] : null;
}

const GENERIC = new Set(['the', 'and', 'of', 'with', 'main', 'model', 'method', 'baseline', 'sample', 'test', 'data']);

/** Lower-case name tokens ("acorn (HNL) + LM" -> acorn, hnl, lm). */
export function nameTokens(name: string | null | undefined): string[] {
  return Array.from(
    new Set(
      String(name ?? '')
        .toLowerCase()
        .split(/[\s()+,;/]+/)
        .map((w) => w.replace(/^[-_.]+|[-_.]+$/g, ''))
        .filter((w) => w.length >= 2 && !GENERIC.has(w)),
    ),
  );
}

/** Tokens of `a` that do not name `b` too (what tells the two apart). */
export function distinctTokens(a: string | null | undefined, b: string | null | undefined): string[] {
  const tb = new Set(nameTokens(b));
  return nameTokens(a).filter((w) => !tb.has(w));
}

let cacheText: string | null = null;
let cache = new Map<string, Array<{ start: number; end: number }>>();

/**
 * Whole-word mentions of a name (any of `tokens`, case-insensitive). The words of one name written
 * together ("acorn (HNL) + LM") are one mention, starting at its first word.
 */
export function mentionsOf(text: string, tokens: string[]): Array<{ start: number; end: number }> {
  // the gate asks for the same names once per numeral: one scan per sentence and name list
  if (text !== cacheText) {
    cacheText = text;
    cache = new Map();
  }
  const key = tokens.join('\u0000');
  const hit = cache.get(key);
  if (hit) return hit;
  const out = scanMentions(text, tokens);
  if (cache.size < 256) cache.set(key, out);
  return out;
}

function scanMentions(text: string, tokens: string[]): Array<{ start: number; end: number }> {
  const raw: Array<{ start: number; end: number }> = [];
  for (const tk of tokens) {
    if (!tk) continue;
    const re = new RegExp(`(?<![A-Za-z0-9])${tk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9]|-[A-Za-z0-9])`, 'gi');
    for (const m of text.matchAll(re)) raw.push({ start: m.index, end: m.index + m[0].length });
  }
  raw.sort((x, y) => x.start - y.start);
  const out: Array<{ start: number; end: number }> = [];
  for (const m of raw) {
    const last = out[out.length - 1];
    if (last && /^[\s~()+,/-]{0,4}$/.test(text.slice(last.end, m.start))) last.end = Math.max(last.end, m.end);
    else out.push({ ...m });
  }
  return out;
}

/** A mention that names the reference of a comparison ("than acorn", "over Canto-L", "compared with X"). */
export function isBaselineMention(text: string, start: number): boolean {
  const before = text.slice(Math.max(0, start - 40), start);
  return /\b(?:than|over|against|versus|vs\.?|relative\s+to|compared\s+(?:with|to)|with\s+respect\s+to)\s+(?:that\s+of\s+|those\s+of\s+|the\s+(?:baseline\s+)?)?$/i.test(before);
}
