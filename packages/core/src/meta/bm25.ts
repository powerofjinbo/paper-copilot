/**
 * BM25 retrieval over the author's corpus (docs/design.md, voice source 3: the six nearest author
 * sentences for the current move and section type).
 *
 * Okapi BM25 with k1 = 1.2 and b = 0.75 by default, the non-negative idf
 * log(1 + (N - df + 0.5) / (df + 0.5)), lower-cased word tokens (letters and digits, Unicode-aware) and a
 * short English stopword list. A query term counts once however often it is repeated. Ties are broken by
 * insertion order, so results are deterministic.
 */

export interface Bm25Doc {
  id: string;
  text: string;
  tags?: string[];
}

/** A short English stopword list (function words only; physics words such as "energy" or "mass" stay). */
export const BM25_STOPWORDS: ReadonlySet<string> = new Set(
  `a about above after again against all also am an and any are as at be because been before being below
  between both but by can could did do does doing down during each either et etc few for from further had has
  have having he her here hers him his how however i if in into is it its itself just may me might more most
  must my no nor not now of off on once only or other our ours out over own per same she should so some such
  than that the their theirs them then there these they this those through thus to too under until up upon
  us very via was we were what when where whether which while who whom whose why will with within without
  would yet you your`.split(/\s+/),
);

const TOKEN_RE = /[\p{L}\p{N}]+/gu;

/** Lower-cased word tokens of `text` without stopwords (the tokens the index uses). */
export function bm25Tokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(TOKEN_RE)) {
    const t = m[0];
    if (!BM25_STOPWORDS.has(t)) out.push(t);
  }
  return out;
}

export class Bm25Index {
  private readonly k1: number;
  private readonly b: number;
  private readonly ids: string[] = [];
  private readonly tags: Array<ReadonlySet<string>> = [];
  private readonly lengths: number[] = [];
  /** term -> postings: [docIndex, termFrequency][] in increasing docIndex. */
  private readonly postings = new Map<string, Array<[number, number]>>();
  private readonly avgdl: number;

  constructor(docs: Bm25Doc[], opts: { k1?: number; b?: number } = {}) {
    this.k1 = typeof opts.k1 === 'number' && Number.isFinite(opts.k1) && opts.k1 >= 0 ? opts.k1 : 1.2;
    this.b = typeof opts.b === 'number' && Number.isFinite(opts.b) ? Math.min(1, Math.max(0, opts.b)) : 0.75;
    let total = 0;
    docs.forEach((d, i) => {
      this.ids.push(d.id);
      this.tags.push(new Set(d.tags ?? []));
      const toks = bm25Tokens(d.text ?? '');
      this.lengths.push(toks.length);
      total += toks.length;
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const [t, n] of tf) {
        let list = this.postings.get(t);
        if (!list) this.postings.set(t, (list = []));
        list.push([i, n]);
      }
    });
    this.avgdl = docs.length > 0 ? total / docs.length : 0;
  }

  /** Top-k documents by BM25 score (score > 0 only), optionally restricted to docs having all `tags`. */
  search(query: string, k: number, tags?: string[]): Array<{ id: string; score: number }> {
    const limit = Number.isFinite(k) ? Math.floor(k) : 0;
    if (limit <= 0 || this.ids.length === 0) return [];
    const terms = [...new Set(bm25Tokens(query))];
    if (terms.length === 0) return [];
    const want = (tags ?? []).filter((t) => t.length > 0);
    const allowed = (i: number): boolean => want.every((t) => this.tags[i]!.has(t));
    const n = this.ids.length;
    const scores = new Map<number, number>();
    for (const term of terms) {
      const list = this.postings.get(term);
      if (!list) continue;
      const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5));
      for (const [i, tf] of list) {
        if (want.length > 0 && !allowed(i)) continue;
        const norm = this.avgdl > 0 ? this.lengths[i]! / this.avgdl : 1;
        const s = (idf * tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * norm));
        scores.set(i, (scores.get(i) ?? 0) + s);
      }
    }
    return [...scores.entries()]
      .filter(([, s]) => s > 0)
      .sort((x, y) => y[1] - x[1] || x[0] - y[0])
      .slice(0, limit)
      .map(([i, score]) => ({ id: this.ids[i]!, score }));
  }

  get size(): number {
    return this.ids.length;
  }
}
