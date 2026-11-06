/** PDF pane layout, zoom steps and reading positions (src/pdf/layout.ts). */
import { describe, expect, it } from 'vitest';
import {
  CSS_PER_POINT,
  PAGE_GAP,
  PAGE_PAD,
  clampScroll,
  contentWidth,
  currentPage,
  fitWidthScale,
  layoutPages,
  offsetOf,
  pageIndexAt,
  pageLeft,
  positionAt,
  revealOffset,
  stepZoom,
  visiblePages,
  zoomPercent,
} from '../src/pdf/layout';

const letter = (scale: number) => ({ width: 612 * scale, height: 792 * scale });

describe('layoutPages', () => {
  it('stacks pages with padding and gaps', () => {
    const l = layoutPages([letter(1), letter(1), letter(1)]);
    expect(l.tops).toEqual([PAGE_PAD, PAGE_PAD + 792 + PAGE_GAP, PAGE_PAD + 2 * (792 + PAGE_GAP)]);
    expect(l.height).toBe(PAGE_PAD * 2 + 3 * 792 + 2 * PAGE_GAP);
    expect(l.width).toBe(612 + 2 * PAGE_PAD);
    expect(layoutPages([]).height).toBe(0);
  });

  it('finds the page under an offset, gaps belonging to the page above', () => {
    const l = layoutPages([letter(1), letter(1)]);
    expect(pageIndexAt(l, 0)).toBe(0);
    expect(pageIndexAt(l, 800)).toBe(0); // in the gap
    expect(pageIndexAt(l, l.tops[1]!)).toBe(1);
    expect(pageIndexAt(l, 1e9)).toBe(1);
    expect(pageIndexAt(layoutPages([]), 10)).toBe(-1);
  });

  it('centres narrow pages and pads wide ones', () => {
    const l = layoutPages([letter(1)]);
    expect(pageLeft(l, 1000, 612)).toBe((1000 - 612) / 2);
    expect(pageLeft(l, 300, 612)).toBe(PAGE_PAD);
    expect(contentWidth(l, 300)).toBe(612 + 2 * PAGE_PAD);
    expect(contentWidth(l, 1000)).toBe(1000);
  });
});

describe('reading position', () => {
  it('survives a zoom: the same line of the same page stays at the top', () => {
    const before = layoutPages([letter(1), letter(1), letter(1)]);
    const y = before.tops[1]! + 0.4 * 792;
    const pos = positionAt(before, y)!;
    expect(pos.page).toBe(2);
    expect(pos.frac).toBeCloseTo(0.4, 9);
    const after = layoutPages([letter(2), letter(2), letter(2)]);
    expect(offsetOf(after, pos).y).toBeCloseTo(after.tops[1]! + 0.4 * 792 * 2, 9);
  });

  it('survives a re-compile that drops pages: clamps to the end of the last page', () => {
    const before = layoutPages([letter(1), letter(1), letter(1), letter(1)]);
    const pos = positionAt(before, before.tops[3]! + 100)!;
    const after = layoutPages([letter(1), letter(1)]);
    expect(offsetOf(after, pos).y).toBe(after.tops[1]! + 792);
  });

  it('keeps the horizontal anchor relative to the page when zoomed past the pane width', () => {
    const before = layoutPages([letter(2)]);
    const paneW = 600;
    const left = pageLeft(before, paneW, 612 * 2);
    const pos = positionAt(before, 100, left + 0.25 * 1224, paneW)!;
    expect(pos.xFrac).toBeCloseTo(0.25, 9);
    const after = layoutPages([letter(3)]);
    expect(offsetOf(after, pos, paneW).x).toBeCloseTo(pageLeft(after, paneW, 1836) + 0.25 * 1836, 9);
  });

  it('clamps scroll offsets', () => {
    expect(clampScroll(-5, 1000, 400)).toBe(0);
    expect(clampScroll(900, 1000, 400)).toBe(600);
    expect(clampScroll(100, 300, 400)).toBe(0);
  });

  it('reports the page covering the line a third down the viewport', () => {
    const l = layoutPages([letter(1), letter(1), letter(1)]);
    expect(currentPage(l, 0, 600)).toBe(1);
    // page 2 starts 250 px below the viewport top (below the one-third line): still on page 1
    expect(currentPage(l, l.tops[1]! - 250, 600)).toBe(1);
    expect(currentPage(l, l.tops[1]! - 150, 600)).toBe(2);
    expect(currentPage(l, l.height, 600)).toBe(3);
    expect(currentPage(layoutPages([]), 0, 600)).toBe(0);
  });

  it('lists the pages in view', () => {
    const l = layoutPages([letter(1), letter(1), letter(1)]);
    expect(visiblePages(l, 0, 600)).toEqual([0]);
    expect(visiblePages(l, l.tops[1]! - 100, 600)).toEqual([0, 1]);
    expect(visiblePages(l, 0, 600, 1000)).toEqual([0, 1]);
  });
});

describe('zoom', () => {
  it('fits the widest page into the pane minus padding', () => {
    const s = fitWidthScale(520, 612);
    expect(612 * s).toBeCloseTo(520 - 2 * PAGE_PAD, 9);
    expect(fitWidthScale(520, 0)).toBe(CSS_PER_POINT);
    // never below the minimum zoom, even in a tiny pane
    expect(fitWidthScale(10, 612)).toBeGreaterThan(0);
  });

  it('steps through presets in both directions from any value', () => {
    const at = (z: number) => z * CSS_PER_POINT;
    expect(zoomPercent(stepZoom(at(1), 1))).toBe(110);
    expect(zoomPercent(stepZoom(at(1), -1))).toBe(85);
    expect(zoomPercent(stepZoom(at(1.17), 1))).toBe(125);
    expect(zoomPercent(stepZoom(at(1.17), -1))).toBe(110);
    expect(zoomPercent(stepZoom(at(4), 1))).toBe(500);
    expect(zoomPercent(stepZoom(at(5), 1))).toBe(500);
    expect(zoomPercent(stepZoom(at(0.5), -1))).toBe(40);
    expect(zoomPercent(stepZoom(at(0.25), -1))).toBe(25);
  });
});

describe('revealOffset', () => {
  it('does not scroll when the target is comfortably visible', () => {
    expect(revealOffset(300, 20, 0, 800)).toBeNull();
  });
  it('centres a target that is off screen', () => {
    expect(revealOffset(2000, 20, 0, 800)).toBe(2010 - 400);
    expect(revealOffset(5, 20, 1000, 800)).toBe(15 - 400);
  });
  it('aligns the start of a target taller than the viewport', () => {
    expect(revealOffset(2000, 900, 0, 800)).toBe(2000 - 48);
  });
});
