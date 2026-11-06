/**
 * Page layout, zoom steps and reading positions for the PDF pane. Pure functions, unit-tested in node.
 *
 * Pages are stacked vertically: `pad` above the first page, `gap` between pages, `pad` below the last,
 * each page horizontally centred (or starting at `pad` when wider than the pane). A reading position is
 * "page N, this fraction of its height", so it survives a re-compile that changes the page count, a
 * zoom and a pane resize.
 */

export interface PageSize {
  width: number;
  height: number;
}

export interface Layout {
  tops: number[];
  heights: number[];
  widths: number[];
  /** Total content height including padding. */
  height: number;
  /** Widest page plus horizontal padding. */
  width: number;
}

export interface ReadingPosition {
  /** 1-based page number. */
  page: number;
  /** Offset of the anchor line inside that page, as a fraction of its height (may be slightly < 0 or > 1 in a gap). */
  frac: number;
  /** Horizontal anchor as a fraction of that page's width (only matters when zoomed past the pane width). */
  xFrac: number;
}

export const PAGE_GAP = 12;
export const PAGE_PAD = 12;

/** "100%" zoom: 96 CSS px per inch over 72 points per inch (PDF.js PixelsPerInch.PDF_TO_CSS_UNITS). */
export const CSS_PER_POINT = 96 / 72;

/** Zoom presets as fractions of 100%. */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.85, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4] as const;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 5;

export function layoutPages(sizes: readonly PageSize[], gap = PAGE_GAP, pad = PAGE_PAD): Layout {
  const tops: number[] = [];
  const heights: number[] = [];
  const widths: number[] = [];
  let y = pad;
  let maxW = 0;
  sizes.forEach((s, i) => {
    if (i > 0) y += gap;
    tops.push(y);
    heights.push(s.height);
    widths.push(s.width);
    y += s.height;
    maxW = Math.max(maxW, s.width);
  });
  return { tops, heights, widths, height: sizes.length ? y + pad : 0, width: maxW + 2 * pad };
}

/** Index (0-based) of the page whose slot (page plus the gap below it) contains content offset `y`. */
export function pageIndexAt(layout: Layout, y: number): number {
  const n = layout.tops.length;
  if (n === 0) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (layout.tops[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Left edge of a page: centred in the content box, or at `pad` when the page is wider than the pane. */
export function pageLeft(layout: Layout, paneWidth: number, pageWidth: number, pad = PAGE_PAD): number {
  const content = Math.max(paneWidth, layout.width);
  return Math.max(pad, (content - pageWidth) / 2);
}

/** Width of the scrollable content box. */
export function contentWidth(layout: Layout, paneWidth: number): number {
  return Math.max(paneWidth, layout.width);
}

/**
 * Reading position of content offset (`x`, `y`). `paneWidth` is the scroll container's client width,
 * used to find the page's left edge for the horizontal fraction.
 */
export function positionAt(layout: Layout, y: number, x = 0, paneWidth = 0): ReadingPosition | null {
  const i = pageIndexAt(layout, y);
  if (i < 0) return null;
  const h = layout.heights[i]! || 1;
  const w = layout.widths[i]! || 1;
  const left = pageLeft(layout, paneWidth, w);
  return { page: i + 1, frac: (y - layout.tops[i]!) / h, xFrac: (x - left) / w };
}

/** Content offset of a reading position in a (possibly different) layout; pages past the end clamp to the end of the last page. */
export function offsetOf(layout: Layout, pos: ReadingPosition, paneWidth = 0): { y: number; x: number } {
  const n = layout.tops.length;
  if (n === 0) return { y: 0, x: 0 };
  const i = Math.min(Math.max(pos.page, 1), n) - 1;
  const frac = pos.page > n ? 1 : pos.frac;
  const w = layout.widths[i]!;
  return { y: layout.tops[i]! + frac * layout.heights[i]!, x: pageLeft(layout, paneWidth, w) + pos.xFrac * w };
}

/** Clamp a scroll offset to the scrollable range. */
export function clampScroll(v: number, content: number, viewport: number): number {
  return Math.max(0, Math.min(v, Math.max(0, content - viewport)));
}

/**
 * The page the reader is "on": the page covering the line one third down the viewport (a page that
 * only peeks in at the top does not count), clamped to the last page.
 */
export function currentPage(layout: Layout, scrollTop: number, viewportHeight: number): number {
  const i = pageIndexAt(layout, scrollTop + viewportHeight / 3);
  return i < 0 ? 0 : i + 1;
}

/** Pages (0-based indices) that intersect [top, top + height), extended by `margin` on both sides. */
export function visiblePages(layout: Layout, top: number, height: number, margin = 0): number[] {
  const out: number[] = [];
  const a = top - margin;
  const b = top + height + margin;
  for (let i = 0; i < layout.tops.length; i++) {
    const t = layout.tops[i]!;
    if (t + layout.heights[i]! >= a && t <= b) out.push(i);
  }
  return out;
}

/** CSS px per point that makes the widest page fill the pane (minus padding and a scrollbar allowance). */
export function fitWidthScale(paneWidth: number, widestPagePoints: number, pad = PAGE_PAD, scrollbar = 0): number {
  if (widestPagePoints <= 0) return CSS_PER_POINT;
  const avail = Math.max(80, paneWidth - 2 * pad - scrollbar);
  return clampScale(avail / widestPagePoints);
}

export function clampScale(scale: number): number {
  return Math.min(MAX_ZOOM * CSS_PER_POINT, Math.max(MIN_ZOOM * CSS_PER_POINT, scale));
}

/** Next zoom preset strictly above (dir 1) or below (dir -1) `scale` (CSS px per point). */
export function stepZoom(scale: number, dir: 1 | -1): number {
  const z = scale / CSS_PER_POINT;
  const eps = 1e-3;
  if (dir > 0) {
    const next = ZOOM_STEPS.find((s) => s > z + eps);
    return clampScale((next ?? Math.min(MAX_ZOOM, z * 1.25)) * CSS_PER_POINT);
  }
  const prev = [...ZOOM_STEPS].reverse().find((s) => s < z - eps);
  return clampScale((prev ?? Math.max(MIN_ZOOM, z / 1.25)) * CSS_PER_POINT);
}

/** Zoom as a whole percentage of 100% (for the toolbar). */
export function zoomPercent(scale: number): number {
  return Math.round((scale / CSS_PER_POINT) * 100);
}

/**
 * Scroll offset that brings [start, start + size) into a viewport of `viewport` px at `current`, or
 * null when it is already comfortably visible. Large targets align their start with a margin.
 */
export function revealOffset(start: number, size: number, current: number, viewport: number, margin = 48): number | null {
  const end = start + size;
  if (start >= current + margin * 0.5 && end <= current + viewport - margin * 0.5) return null;
  if (size + 2 * margin >= viewport) return start - margin;
  return start + size / 2 - viewport / 2;
}
