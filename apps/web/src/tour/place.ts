/**
 * Where the tour card goes: next to the highlighted element and never over it, nor over the sentence card,
 * proposal or ghost text the author is working with (`avoid`). Pure geometry, viewport coordinates.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Side = 'right' | 'left' | 'below' | 'above' | 'corner';

const GAP = 14;
const MARGIN = 12;

export function intersects(a: Rect, b: Rect, pad = 0): boolean {
  return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** The union of rectangles (null for none). */
export function unionRect(rects: readonly Rect[]): Rect | null {
  const rs = rects.filter((r) => r.w > 0 && r.h > 0);
  if (!rs.length) return null;
  const x0 = Math.min(...rs.map((r) => r.x));
  const y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => r.x + r.w));
  const y1 = Math.max(...rs.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Card position: right of the target, left, below, above (aligned with it and kept inside the viewport),
 * then the four viewport corners; the first one that overlaps neither the target nor an avoided rectangle.
 * With no target, the bottom-right corner. If nothing is free, the candidate overlapping the least.
 */
export function placeCard(target: Rect | null, card: { w: number; h: number }, view: { w: number; h: number }, avoid: readonly Rect[] = []): { x: number; y: number; side: Side } {
  const maxX = Math.max(MARGIN, view.w - card.w - MARGIN);
  const maxY = Math.max(MARGIN, view.h - card.h - MARGIN);
  const corners: Array<{ x: number; y: number; side: Side }> = [
    { x: maxX, y: maxY, side: 'corner' },
    { x: MARGIN, y: maxY, side: 'corner' },
    { x: maxX, y: MARGIN + 44, side: 'corner' },
    { x: MARGIN, y: MARGIN + 44, side: 'corner' },
  ];
  const cands: Array<{ x: number; y: number; side: Side }> = [];
  if (target) {
    const alignY = clamp(target.y, MARGIN, maxY);
    const alignX = clamp(target.x, MARGIN, maxX);
    if (target.x + target.w + GAP + card.w <= view.w - MARGIN) cands.push({ x: target.x + target.w + GAP, y: alignY, side: 'right' });
    if (target.x - GAP - card.w >= MARGIN) cands.push({ x: target.x - GAP - card.w, y: alignY, side: 'left' });
    if (target.y + target.h + GAP + card.h <= view.h - MARGIN) cands.push({ x: alignX, y: target.y + target.h + GAP, side: 'below' });
    if (target.y - GAP - card.h >= MARGIN) cands.push({ x: alignX, y: target.y - GAP - card.h, side: 'above' });
  }
  cands.push(...corners);
  const blockers = target ? [target, ...avoid] : [...avoid];
  const overlap = (c: { x: number; y: number }) => {
    const r = { x: c.x, y: c.y, w: card.w, h: card.h };
    let a = 0;
    for (const b of blockers) {
      if (!intersects(r, b, 4)) continue;
      a += Math.max(0, Math.min(r.x + r.w, b.x + b.w) - Math.max(r.x, b.x)) * Math.max(0, Math.min(r.y + r.h, b.y + b.h) - Math.max(r.y, b.y)) + 1;
    }
    return a;
  };
  let best = cands[0]!;
  let bestA = Infinity;
  for (const c of cands) {
    const a = overlap(c);
    if (a === 0) return c;
    if (a < bestA) {
      bestA = a;
      best = c;
    }
  }
  return best;
}
