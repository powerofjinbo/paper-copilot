/**
 * Deterministic number formatting for fact renderings (aliases, chips, prompts).
 *
 * OWNER: core-gate agent.
 */
import type { Fact } from '../schemas';
import { normalizeUnit } from './numerals';

/** Numeric value of a fact (numbers, or strings that are plain numbers), else null. */
export function factNumber(f: Pick<Fact, 'value'>): number | null {
  const v = f.value;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim().replace(/,(?=\d{3}(?:\D|$))/g, '');
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) {
      const n = Number(t);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

/** A dimensionless fraction (efficiency, rate) that prose may write as a percent. */
export function isFractionFact(f: Pick<Fact, 'value' | 'unit' | 'tags'>): boolean {
  const v = factNumber(f);
  if (v === null) return false;
  const u = normalizeUnit(f.unit);
  if (u !== '' && u !== 'fraction') return false;
  if (Math.abs(v) > 1) return false;
  if (Number.isInteger(v)) return (f.tags ?? []).includes('fraction');
  return true;
}

/** Decimals needed to show `sig` significant figures of x. */
export function decimalsForSig(x: number, sig: number): number {
  if (!Number.isFinite(x) || x === 0) return Math.max(0, sig - 1);
  const mag = Math.floor(Math.log10(Math.abs(x)));
  return Math.min(15, Math.max(0, sig - 1 - mag));
}

/** toFixed without "-0". */
export function fixed(x: number, d: number): string {
  const s = x.toFixed(Math.max(0, Math.min(20, d)));
  return /^-0(?:\.0+)?$/.test(s) ? s.slice(1) : s;
}

/** "8710" -> "8,710" (integers only; other strings unchanged). */
export function withThousands(s: string): string {
  const m = /^(-?)(\d+)(\.\d+)?$/.exec(s);
  if (!m || m[2]!.length <= 3) return s;
  return m[1] + m[2]!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (m[3] ?? '');
}

/** Scientific rendering for very small or large values: {mantissa, exponent}. */
export function sciParts(x: number, sig: number): { mant: string; exp: number } {
  if (x === 0) return { mant: fixed(0, Math.max(0, sig - 1)), exp: 0 };
  let exp = Math.floor(Math.log10(Math.abs(x)));
  let mant = x / Math.pow(10, exp);
  let ms = fixed(mant, Math.max(0, sig - 1));
  if (Math.abs(Number(ms)) >= 10) {
    exp += 1;
    mant = x / Math.pow(10, exp);
    ms = fixed(mant, Math.max(0, sig - 1));
  }
  return { mant: ms, exp };
}

export function needsSci(x: number): boolean {
  const a = Math.abs(x);
  return a !== 0 && (a < 1e-3 || (a >= 1e7 && !Number.isInteger(x)));
}

/** Unit suffix as written after a number in prose. */
export function unitSuffix(unit: string): string {
  const u = (unit ?? '').trim();
  if (!u) return '';
  if (u === '%') return '%';
  return ' ' + u;
}

/** The main uncertainty of a fact: `total` if present, else the first entry. */
export function mainUncertainty(f: Pick<Fact, 'uncertainties'>): { name: string; value: number } | null {
  const u = f.uncertainties ?? {};
  if (typeof u.total === 'number' && Number.isFinite(u.total)) return { name: 'total', value: u.total };
  for (const [k, v] of Object.entries(u)) if (typeof v === 'number' && Number.isFinite(v)) return { name: k, value: v };
  return null;
}
