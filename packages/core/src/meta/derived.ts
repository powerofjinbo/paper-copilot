/**
 * Derived relations: numbers the prose may state that are computed from two facts, never stored in an
 * artifact ("2.5 times fewer fake tracks", "2.3 points higher", "60% lower", "9 out of 10 targets").
 * The gate accepts them through `GateContext.derived` and links both facts (docs/design.md,
 * "Faithfulness and provenance", item 1: "a declared derived relation ... via a small calculator").
 *
 * OWNER: core-features agent.
 *
 * Rules (pure, deterministic, bounded):
 * - Only numeric facts of the same kind (default: kind 'number') and the same unit family are paired:
 *   fractions and percents (a fraction 0.0137 and a percent 1.37 are one family), percentage points,
 *   counts (integers tagged 'count' or named n_*), dimensionless values, and each physical unit on its own
 *   (no unit conversion). Excluded facts, uncertainty facts (sigma_*, *_err) and zero values are skipped.
 * - A pair must share a definition stem ("eff" for eff_A / eff_B / scan[2].eff_A, "fake_rate" for
 *   fake_rate_A / fake_rate_B), or, for counts and physical values only, an artifact. Per-seed values are
 *   skipped. Two rows of one table pair only when their metadata (sample, population, model, label, ...)
 *   differ in at most two values (one model against another on the same population; not one model on one
 *   population against another model on another). Across artifacts, one of the two must be a headline
 *   value (top level of a results/*_claim.json). Every relation is a chance for a wrong number to pass the
 *   gate, so the pairing stays this narrow. Pairs are generated tier by tier until `maxRelations` (default
 *   5000): same stem in the same row/object first, then same stem in the same artifact, then the same
 *   stem across artifacts, then counts and physical values of the same artifact; inside a tier, in
 *   fact-store order.
 * - ratio: max/min of two positive values when it is at least `minRatio` (1.1), quoted to 1-2
 *   significant figures as a factor ("2.5 times", "a factor of 3"); maxSigfigs 2.
 * - difference: a - b in percentage points for fractions, percents and points; maxSigfigs 3.
 * - relative: (a - b) / b x 100, in both directions ("60% lower", "151% higher"); maxSigfigs 3.
 * - share: a / b for two counts with a < b, written as a fraction, a percent or "N out of M".
 */
import type { Fact } from '../schemas';
import type { DerivedRelation } from '../gate/gate';
import { decimalsForSig, factNumber, fixed, isFractionFact } from '../facts/format';
import { normalizeUnit } from '../facts/numerals';

export type DerivedKind = 'ratio' | 'difference' | 'relative' | 'share';

export interface DerivedOptions {
  /** Hard cap on the number of relations (default 5000). */
  maxRelations?: number;
  /** Fact kinds to pair (default ['number']). */
  kinds?: string[];
  /** Relation kinds to build (default all four). */
  include?: DerivedKind[];
  /** Smallest ratio worth quoting as a factor (default 1.1; below, a percent reads better). */
  minRatio?: number;
  /** Largest bucket of facts paired with each other in tiers 1-3 (default 200; bounds the work). */
  maxBucket?: number;
  /** Also pair per-seed values (`#/eff_A_seeds/0`, CSV `eff_s0`); default false: nobody quotes their ratios. */
  includeSeeds?: boolean;
}

export const DEFAULT_MAX_DERIVED = 5000;

type Family = string;

interface Item {
  f: Fact;
  idx: number;
  /** Non-numeric metadata of the definition ("sample=...; model=..."), for row-to-row comparisons. */
  meta: Map<string, string>;
  /** A top-level value of a claim artifact (results/*_claim.json): the paper's headline numbers. */
  claimTop: boolean;
  /** Value in family units: fractions as fractions (a percent fact / 100), others as stored. */
  x: number;
  family: Family;
  stem: string;
  group: string;
}

/** A fact that is itself an uncertainty (sigma_x, x_err, tag 'uncertainty'): not paired. */
function uncertaintyLike(f: Fact): boolean {
  if ((f.tags ?? []).some((t) => /^(?:uncertainty|error|sigma|unc)$/i.test(t))) return true;
  const last = String(f.id).split('.').pop() ?? '';
  return /^(?:sigma|err|error|unc|uncert|uncertainty|std|sd|stderr)(?:_|$)|_(?:sigma|err|error|unc|uncert|uncertainty|std|sd|stderr)$/i.test(last);
}

/** A per-seed value: an array element of a *_seeds list, or a CSV column such as eff_s0 / eff_seed1. */
function perSeed(f: Fact): boolean {
  const last = String(f.id).split('.').pop() ?? '';
  return /(?:^|[._])seeds?(?:[._]|$)/i.test(String(f.id)) || /(?:^|_)(?:s|seed)\d+$/i.test(last) || /_seeds\/\d+$/.test(String(f.locator ?? ''));
}

function isCount(f: Fact, v: number): boolean {
  if (!Number.isInteger(v)) return false;
  if ((f.tags ?? []).includes('count')) return true;
  const last = (String(f.id).split('.').pop() ?? '').toLowerCase();
  return /^n_|^n$|_n$|^num_|count/.test(last);
}

function familyOf(f: Fact, v: number): { family: Family; x: number } | null {
  const u = normalizeUnit(f.unit);
  if (isFractionFact(f)) return { family: 'fraction', x: v };
  if (u === '%') return { family: 'fraction', x: v / 100 };
  if (u === 'points') return { family: 'points', x: v };
  if (u === '' && isCount(f, v)) return { family: 'count', x: v };
  if (u === '') return { family: 'dimensionless', x: v };
  return { family: `unit:${u}`, x: v };
}

/**
 * Definition stem: the quantity's name without its sample/model designator ("eff_A" -> "eff",
 * "scan[0].fake_rate_B" -> "fake_rate", "eff_s0" -> "eff", "time_lrt_ms" -> "time_lrt").
 */
export function definitionStem(f: Pick<Fact, 'id' | 'definition'>): string {
  const def = String(f.definition ?? '').trim();
  let head = def.split(/\s*[(;,:]/)[0]!.trim();
  if (!head || /\s/.test(head)) head = String(f.id).split('.').pop() ?? '';
  head = head.split('.').pop() ?? head;
  let s = head.toLowerCase().replace(/\[\d+\]/g, '').replace(/[\s-]+/g, '_');
  for (let k = 0; k < 3; k++) {
    const before = s;
    s = s.replace(/_(?:ms|mm|cm|um|gev|tev|mev|kev|mrad|rad|pct|percent|points|frac|fraction)$/, '');
    s = s.replace(/_(?:[a-d]|s\d+|seed\d*|seeds|\d+)$/, '');
    if (s === before) break;
  }
  return s || String(f.id);
}

/** "eff_s0 (sample=generic_iso; model=canto; n=8710)" -> {sample: generic_iso, model: canto} (numeric values dropped). */
function metaOf(f: Fact): Map<string, string> {
  const m = new Map<string, string>();
  const def = String(f.definition ?? '');
  const open = def.indexOf('(');
  const close = def.lastIndexOf(')');
  const inner = open >= 0 && close > open ? def.slice(open + 1, close) : '';
  for (const part of inner.split(/;\s*/)) {
    const kv = /^([^=]+)=(.*)$/.exec(part.trim());
    if (!kv) continue;
    const v = kv[2]!.trim();
    if (/^[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i.test(v)) continue;
    m.set(kv[1]!.trim(), v);
  }
  return m;
}

/** Rows that differ in at most `max` metadata values (one factor: the model, or the population, or the bin). */
function comparable(a: Item, b: Item, max = 2): boolean {
  let diff = 0;
  for (const k of new Set([...a.meta.keys(), ...b.meta.keys()])) if (a.meta.get(k) !== b.meta.get(k)) diff++;
  return diff <= max;
}

/** Row or object of a locator: "#/scan/0/eff_A" -> "#/scan/0", "csv:row=3;col=eff" -> "csv:row=3". */
function groupOf(f: Fact): string {
  const loc = String(f.locator ?? '');
  if (loc.startsWith('#')) {
    const i = loc.lastIndexOf('/');
    return i <= 0 ? '#' : loc.slice(0, i);
  }
  const m = /^(csv:row=\d+)/.exec(loc);
  if (m) return m[1]!;
  return loc;
}

/** x at `sig` significant figures. */
function sig(x: number, s: number): string {
  return fixed(x, decimalsForSig(x, s));
}

function renderings(x: number, sigs: number[]): string[] {
  const out: string[] = [];
  for (const s of sigs) {
    const r = sig(x, s);
    if (!out.includes(r)) out.push(r);
  }
  return out;
}

interface Pair {
  a: Item;
  b: Item;
}

function relationsFor(p: Pair, include: Set<DerivedKind>, minRatio: number): DerivedRelation[] {
  const { a, b } = p;
  const out: DerivedRelation[] = [];
  const A = a.f.id;
  const B = b.f.id;
  const fam = a.family;
  if (include.has('difference') && (fam === 'fraction' || fam === 'points')) {
    const d = fam === 'fraction' ? (a.x - b.x) * 100 : a.x - b.x;
    if (Math.abs(d) > 1e-12) {
      const r = renderings(Math.abs(d), [2, 3]);
      out.push({ value: d, raw: r[0]!, factIds: [A, B], description: `${A} − ${B} = ${sig(d, 3)} points`, kind: 'difference', form: 'points', maxSigfigs: 3, renderings: r.map((x) => `${x} points`) });
    }
  }
  if (include.has('relative') && a.x !== 0 && b.x !== 0 && Math.sign(a.x) === Math.sign(b.x)) {
    for (const [p1, p2] of [
      [a, b],
      [b, a],
    ] as const) {
      const rel = ((p1.x - p2.x) / p2.x) * 100;
      if (Math.abs(rel) < 0.05 || !Number.isFinite(rel)) continue;
      const r = renderings(Math.abs(rel), [2, 3]);
      out.push({
        value: rel,
        raw: r[0]!,
        factIds: [p1.f.id, p2.f.id],
        description: `(${p1.f.id} − ${p2.f.id}) / ${p2.f.id} = ${sig(rel, 3)}%`,
        kind: 'relative',
        form: 'percent',
        maxSigfigs: 3,
        renderings: r.map((x) => `${x}%`),
      });
    }
  }
  if (include.has('ratio') && a.x > 0 && b.x > 0) {
    const [hi, lo] = a.x >= b.x ? [a, b] : [b, a];
    const q = hi.x / lo.x;
    if (q >= minRatio && Number.isFinite(q) && q < 1e6) {
      const r = renderings(q, [2, 1]);
      out.push({ value: q, raw: r[0]!, factIds: [hi.f.id, lo.f.id], description: `${hi.f.id} / ${lo.f.id} = ${sig(q, 3)} (ratio)`, kind: 'ratio', form: 'factor', maxSigfigs: 2, renderings: r.map((x) => `${x} times`) });
    }
  }
  if (include.has('share') && fam === 'count' && a.x > 0 && b.x > 0 && a.x !== b.x) {
    const [num, den] = a.x < b.x ? [a, b] : [b, a];
    const q = num.x / den.x;
    const r = renderings(q, [2, 3]);
    out.push({ value: q, raw: r[0]!, factIds: [num.f.id, den.f.id], description: `${num.f.id} / ${den.f.id} = ${sig(q, 3)} (share)`, kind: 'share', form: 'fraction', renderings: [...r, ...renderings(q * 100, [2, 3]).map((x) => `${x}%`)] });
  }
  return out;
}

/**
 * Derived relations between pairs of facts (see the module comment for the rules). Deterministic for
 * the same facts in the same order; never throws (returns [] on bad input).
 */
export function derivedRelations(facts: Fact[], opts: DerivedOptions = {}): DerivedRelation[] {
  try {
    return derivedImpl(Array.isArray(facts) ? facts : [], opts);
  } catch {
    return [];
  }
}

function derivedImpl(facts: Fact[], opts: DerivedOptions): DerivedRelation[] {
  const max = Math.max(0, Math.floor(opts.maxRelations ?? DEFAULT_MAX_DERIVED));
  const kinds = new Set(opts.kinds ?? ['number']);
  const include = new Set<DerivedKind>(opts.include ?? ['ratio', 'difference', 'relative', 'share']);
  const minRatio = opts.minRatio ?? 1.1;
  const maxBucket = Math.max(2, opts.maxBucket ?? 200);
  const items: Item[] = [];
  const seen = new Set<string>();
  facts.forEach((f, idx) => {
    if (!f || typeof f.id !== 'string' || seen.has(f.id) || f.excluded || !kinds.has(f.kind)) return;
    seen.add(f.id);
    const v = factNumber(f);
    if (v === null || v === 0 || uncertaintyLike(f) || (!opts.includeSeeds && perSeed(f))) return;
    const fam = familyOf(f, v);
    if (!fam) return;
    items.push({ f, idx, x: fam.x, family: fam.family, stem: definitionStem(f), group: `${f.artifact}|${groupOf(f)}`, meta: metaOf(f), claimTop: /_claim\.json$/i.test(String(f.artifact)) && /^#\/[^/]+$/.test(String(f.locator ?? '')) });
  });

  const out: DerivedRelation[] = [];
  const done = new Set<string>();
  const push = (p: Pair): boolean => {
    const key = p.a.idx < p.b.idx ? `${p.a.idx}|${p.b.idx}` : `${p.b.idx}|${p.a.idx}`;
    if (done.has(key)) return true;
    done.add(key);
    const [a, b] = p.a.idx < p.b.idx ? [p.a, p.b] : [p.b, p.a];
    for (const r of relationsFor({ a, b }, include, minRatio)) {
      if (out.length >= max) return false;
      out.push(r);
    }
    return out.length < max;
  };
  const bucketsBy = (key: (it: Item) => string): Item[][] => {
    const m = new Map<string, Item[]>();
    for (const it of items) {
      const k = `${it.family}\u0000${key(it)}`;
      let b = m.get(k);
      if (!b) m.set(k, (b = []));
      b.push(it);
    }
    // buckets in the order of their first fact
    return [...m.values()].filter((b) => b.length > 1);
  };
  // Different quantities of one artifact are paired only when a ratio between them can mean something:
  // counts (8,000 training events, 8 times the test events) and physical values (two timings in ms),
  // never two different fractions (an efficiency and a fake rate).
  const crossStemOk = (fam: Family): boolean => fam === 'count' || fam.startsWith('unit:');
  const tiers: Array<{ buckets: Item[][]; ok: (a: Item, b: Item) => boolean; cap: boolean }> = [
    { buckets: bucketsBy((it) => `${it.group}\u0000${it.stem}`), ok: () => true, cap: false },
    { buckets: bucketsBy((it) => `${it.f.artifact}\u0000${it.stem}`), ok: (a, b) => comparable(a, b), cap: true },
    { buckets: bucketsBy((it) => it.stem), ok: (a, b) => a.f.artifact !== b.f.artifact && (a.claimTop || b.claimTop), cap: true },
    { buckets: bucketsBy((it) => it.f.artifact), ok: (a, b) => a.stem !== b.stem && crossStemOk(a.family), cap: true },
  ];
  for (const tier of tiers) {
    for (const bucket of tier.buckets) {
      const b = tier.cap ? bucket.slice(0, maxBucket) : bucket;
      for (let i = 0; i < b.length; i++) {
        for (let j = i + 1; j < b.length; j++) {
          if (!tier.ok(b[i]!, b[j]!)) continue;
          if (!push({ a: b[i]!, b: b[j]! })) return out;
        }
      }
    }
  }
  return out;
}
