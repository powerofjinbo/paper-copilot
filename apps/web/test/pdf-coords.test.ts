/**
 * PDF pane coordinate conversion (src/pdf/coords.ts). The viewport math is checked against PDF.js
 * itself (the legacy build runs in node) on hand-made one-page PDFs with every /Rotate and a
 * MediaBox that does not start at the origin.
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  canvasToCss,
  clientToPageCss,
  cssToPdfUser,
  cssToTopLeft,
  insidePage,
  invertMatrix,
  applyMatrix,
  normalizeRotation,
  outputScale,
  pdfUserToCss,
  topLeftBoxToCss,
  viewportSize,
  viewportTransform,
  type PageGeometry,
} from '../src/pdf/coords';

function onePagePdf(rotate: number, box: number[]): Uint8Array {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', `<< /Type /Page /Parent 2 0 R /MediaBox [${box.join(' ')}] /Rotate ${rotate} >>`];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const docs: Array<{ loadingTask: { destroy(): Promise<void> } }> = [];
afterAll(async () => {
  await Promise.all(docs.map((d) => d.loadingTask.destroy()));
});

async function pdfjsPage(rotate: number, box: number[]) {
  const doc = await pdfjs.getDocument({ data: onePagePdf(rotate, box), verbosity: 0 }).promise;
  docs.push(doc);
  return doc.getPage(1);
}

const LETTER: PageGeometry = { viewBox: [0, 0, 612, 792], rotation: 0 };

describe('viewportTransform matches PDF.js', () => {
  for (const rotate of [0, 90, 180, 270]) {
    for (const box of [
      [0, 0, 612, 792],
      [10, 20, 622, 812],
      [-36, 5, 559, 847],
    ]) {
      it(`rotate ${rotate}, MediaBox [${box.join(' ')}]`, async () => {
        const page = await pdfjsPage(rotate, box);
        const g: PageGeometry = { viewBox: page.view, rotation: page.rotate, userUnit: page.userUnit };
        for (const scale of [1, 1.3333, 2.25]) {
          const vp = page.getViewport({ scale });
          const m = viewportTransform(g, scale);
          m.forEach((v, i) => expect(v).toBeCloseTo(vp.transform[i]!, 9));
          const size = viewportSize(g, scale);
          expect(size.width).toBeCloseTo(vp.width, 9);
          expect(size.height).toBeCloseTo(vp.height, 9);
          for (const [cx, cy] of [
            [0, 0],
            [17, 42],
            [size.width, size.height],
            [size.width / 3, size.height * 0.8],
          ]) {
            const [ux, uy] = cssToPdfUser(g, scale, cx!, cy!);
            const [ex, ey] = vp.convertToPdfPoint(cx!, cy!) as [number, number];
            expect(ux).toBeCloseTo(ex, 9);
            expect(uy).toBeCloseTo(ey, 9);
            const [bx, by] = pdfUserToCss(g, scale, ux, uy);
            expect(bx).toBeCloseTo(cx!, 9);
            expect(by).toBeCloseTo(cy!, 9);
          }
        }
      });
    }
  }
});

describe('click -> SyncTeX point (top-left origin, points)', () => {
  it('maps the top-left corner of an unrotated page to (0, 0) and the bottom-right to the page size', () => {
    const s = 1.5;
    expect(cssToTopLeft(LETTER, s, 0, 0)).toEqual({ x: 0, y: 0 });
    const br = cssToTopLeft(LETTER, s, 612 * s, 792 * s);
    expect(br.x).toBeCloseTo(612, 9);
    expect(br.y).toBeCloseTo(792, 9);
  });

  it('divides by the zoom: a click 30 x 40 CSS px in at 125% is 18 x 24 pt', () => {
    const s = 1.25 * (96 / 72);
    const p = cssToTopLeft(LETTER, s, 30, 40);
    expect(p.x).toBeCloseTo(18, 9);
    expect(p.y).toBeCloseTo(24, 9);
  });

  it('is relative to the visible page box when the MediaBox has an offset', () => {
    const g: PageGeometry = { viewBox: [10, 20, 622, 812], rotation: 0 };
    const p = cssToTopLeft(g, 1, 100, 50);
    expect(p.x).toBeCloseTo(100, 9);
    expect(p.y).toBeCloseTo(50, 9);
  });

  it('undoes /Rotate 90: the top-left of the screen is the bottom-left of the unrotated page', () => {
    const g: PageGeometry = { viewBox: [0, 0, 612, 792], rotation: 90 };
    // Rotated 90 clockwise, the on-screen page is 792 wide and 612 tall.
    expect(viewportSize(g, 1)).toEqual({ width: 792, height: 612 });
    const tl = cssToTopLeft(g, 1, 0, 0);
    expect(tl.x).toBeCloseTo(0, 9);
    expect(tl.y).toBeCloseTo(792, 9);
    const p = cssToTopLeft(g, 2, 2 * 100, 2 * 50);
    // screen (100, 50) pt -> unrotated x = 50, y-from-top = 792 - 100
    expect(p.x).toBeCloseTo(50, 9);
    expect(p.y).toBeCloseTo(692, 9);
  });

  it('handles 180 and 270 degrees', () => {
    const g180: PageGeometry = { viewBox: [0, 0, 612, 792], rotation: 180 };
    const p = cssToTopLeft(g180, 1, 0, 0);
    expect(p.x).toBeCloseTo(612, 9);
    expect(p.y).toBeCloseTo(792, 9);
    const g270: PageGeometry = { viewBox: [0, 0, 612, 792], rotation: -90 };
    expect(normalizeRotation(-90)).toBe(270);
    const q = cssToTopLeft(g270, 1, 0, 0);
    expect(q.x).toBeCloseTo(612, 9);
    expect(q.y).toBeCloseTo(0, 9);
  });

  it('ignores devicePixelRatio for clicks but converts canvas pixels when asked', () => {
    expect(canvasToCss(300, 120, 2)).toEqual({ x: 150, y: 60 });
  });

  it('turns client coordinates into page CSS pixels, undoing a CSS transform on the page element', () => {
    const rect = { left: 100, top: 250, width: 816, height: 1056 };
    expect(clientToPageCss(130, 290, rect, 816, 1056)).toEqual({ x: 30, y: 40 });
    // element laid out at 816 px but displayed at half size (transform: scale(.5))
    const half = { left: 100, top: 250, width: 408, height: 528 };
    expect(clientToPageCss(115, 270, half, 816, 1056)).toEqual({ x: 30, y: 40 });
  });

  it('knows when a point is on the page', () => {
    expect(insidePage(0, 0, { width: 10, height: 10 })).toBe(true);
    expect(insidePage(10, 10, { width: 10, height: 10 })).toBe(true);
    expect(insidePage(-0.5, 3, { width: 10, height: 10 })).toBe(false);
    expect(insidePage(3, 10.5, { width: 10, height: 10 })).toBe(false);
  });
});

describe('SyncTeX box -> CSS rectangle', () => {
  it('scales a box on an unrotated page', () => {
    const r = topLeftBoxToCss(LETTER, 2, { x: 54, y: 238.11, w: 245.08, h: 8.86 });
    expect(r.left).toBeCloseTo(108, 9);
    expect(r.top).toBeCloseTo(476.22, 9);
    expect(r.width).toBeCloseTo(490.16, 9);
    expect(r.height).toBeCloseTo(17.72, 9);
  });

  it('round-trips with the click conversion on rotated pages', () => {
    for (const rotation of [0, 90, 180, 270]) {
      const g: PageGeometry = { viewBox: [10, 20, 622, 812], rotation };
      const box = { x: 72, y: 100, w: 200, h: 12 };
      const r = topLeftBoxToCss(g, 1.7, box);
      const a = cssToTopLeft(g, 1.7, r.left, r.top);
      const b = cssToTopLeft(g, 1.7, r.left + r.width, r.top + r.height);
      expect(Math.min(a.x, b.x)).toBeCloseTo(box.x, 9);
      expect(Math.max(a.x, b.x)).toBeCloseTo(box.x + box.w, 9);
      expect(Math.min(a.y, b.y)).toBeCloseTo(box.y, 9);
      expect(Math.max(a.y, b.y)).toBeCloseTo(box.y + box.h, 9);
    }
  });
});

describe('matrix helpers and output scale', () => {
  it('inverts an affine matrix', () => {
    const m = viewportTransform({ viewBox: [3, 4, 500, 700], rotation: 90 }, 1.37);
    const inv = invertMatrix(m);
    const [x, y] = applyMatrix(inv, ...applyMatrix(m, 12.5, -7));
    expect(x).toBeCloseTo(12.5, 9);
    expect(y).toBeCloseTo(-7, 9);
  });

  it('uses devicePixelRatio, capped so huge zooms stay under the canvas pixel limit', () => {
    expect(outputScale(2, 800, 1000)).toBe(2);
    expect(outputScale(0, 800, 1000)).toBe(1);
    expect(outputScale(Number.NaN, 800, 1000)).toBe(1);
    const s = outputScale(3, 4000, 5000, 16_777_216);
    expect(s).toBeLessThan(3);
    expect(4000 * s * 5000 * s).toBeLessThanOrEqual(16_777_216 + 1);
  });
});
