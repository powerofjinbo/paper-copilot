/**
 * Coordinate conversion between the three spaces the PDF pane deals with. Pure functions, no PDF.js
 * import, so they are unit-tested in node (apps/web/test/pdf-coords.test.ts).
 *
 *   CSS page space   CSS pixels inside one page element, origin at the page's top-left corner as the
 *                    reader sees it (after /Rotate). The page element is `viewportSize(g, scale)`
 *                    big; its canvas holds `devicePixelRatio` times as many pixels, which never
 *                    matters for clicks because events arrive in CSS pixels.
 *   PDF user space   PDF points, origin bottom-left of the unrotated page (what PDF.js calls PDF
 *                    coordinates; the page's viewBox/CropBox lives here).
 *   SyncTeX space    PDF big points measured from the TOP-LEFT corner of the unrotated page, y down
 *                    (`synctex edit -o page:x:y` takes these; `synctex view` boxes come back in them,
 *                    see apps/server/src/services/build/synctex.ts).
 *
 * `viewportTransform` reproduces PDF.js's PageViewport transform exactly (pdfjs-dist 6.5,
 * display_utils PageViewport constructor), so the conversions agree with what PDF.js paints.
 */

/** Affine matrix [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f (PDF.js / canvas order). */
export type Matrix = [number, number, number, number, number, number];

export interface PageGeometry {
  /** [xMin, yMin, xMax, yMax] in PDF user space (PDFPageProxy.view: the CropBox). */
  viewBox: readonly [number, number, number, number] | readonly number[];
  /** Page /Rotate plus any extra rotation, a multiple of 90 degrees. */
  rotation: number;
  /** PDF /UserUnit (1 for everything TeX produces). */
  userUnit?: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TopLeftBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function normalizeRotation(rotation: number): 0 | 90 | 180 | 270 {
  let r = Math.round(rotation / 90) * 90;
  r %= 360;
  if (r < 0) r += 360;
  return r as 0 | 90 | 180 | 270;
}

/** PDF user space -> CSS page space at `scale` CSS pixels per PDF point (PDF.js PageViewport.transform). */
export function viewportTransform(g: PageGeometry, scale: number): Matrix {
  const vb = g.viewBox;
  const s = scale * (g.userUnit ?? 1);
  const centerX = (vb[2]! + vb[0]!) / 2;
  const centerY = (vb[3]! + vb[1]!) / 2;
  let a: number, b: number, c: number, d: number;
  switch (normalizeRotation(g.rotation)) {
    case 180:
      [a, b, c, d] = [-1, 0, 0, 1];
      break;
    case 90:
      [a, b, c, d] = [0, 1, 1, 0];
      break;
    case 270:
      [a, b, c, d] = [0, -1, -1, 0];
      break;
    default:
      [a, b, c, d] = [1, 0, 0, -1];
  }
  let offX: number, offY: number;
  if (a === 0) {
    offX = Math.abs(centerY - vb[1]!) * s;
    offY = Math.abs(centerX - vb[0]!) * s;
  } else {
    offX = Math.abs(centerX - vb[0]!) * s;
    offY = Math.abs(centerY - vb[1]!) * s;
  }
  return [a * s, b * s, c * s, d * s, offX - a * s * centerX - c * s * centerY, offY - b * s * centerX - d * s * centerY];
}

/** Size of the page in CSS pixels at `scale`, after rotation. */
export function viewportSize(g: PageGeometry, scale: number): { width: number; height: number } {
  const vb = g.viewBox;
  const s = scale * (g.userUnit ?? 1);
  const w = (vb[2]! - vb[0]!) * s;
  const h = (vb[3]! - vb[1]!) * s;
  const r = normalizeRotation(g.rotation);
  return r === 90 || r === 270 ? { width: h, height: w } : { width: w, height: h };
}

export function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function invertMatrix(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  if (det === 0) throw new Error('singular matrix');
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[4] * m[3]) / det, (m[4] * m[1] - m[5] * m[0]) / det];
}

/** CSS page space -> PDF user space (PDF.js PageViewport.convertToPdfPoint). */
export function cssToPdfUser(g: PageGeometry, scale: number, cssX: number, cssY: number): [number, number] {
  return applyMatrix(invertMatrix(viewportTransform(g, scale)), cssX, cssY);
}

/** PDF user space -> CSS page space (PDF.js PageViewport.convertToViewportPoint). */
export function pdfUserToCss(g: PageGeometry, scale: number, x: number, y: number): [number, number] {
  return applyMatrix(viewportTransform(g, scale), x, y);
}

/** PDF user space -> SyncTeX space (top-left origin of the unrotated page, y down). */
export function pdfUserToTopLeft(g: PageGeometry, x: number, y: number): { x: number; y: number } {
  return { x: x - g.viewBox[0]!, y: g.viewBox[3]! - y };
}

export function topLeftToPdfUser(g: PageGeometry, x: number, y: number): [number, number] {
  return [x + g.viewBox[0]!, g.viewBox[3]! - y];
}

/** CSS page space -> SyncTeX space: what a click sends to `synctex edit`. */
export function cssToTopLeft(g: PageGeometry, scale: number, cssX: number, cssY: number): { x: number; y: number } {
  const [ux, uy] = cssToPdfUser(g, scale, cssX, cssY);
  return pdfUserToTopLeft(g, ux, uy);
}

/** SyncTeX box -> CSS rectangle in page space (the bounding box of its four corners, so rotation is handled). */
export function topLeftBoxToCss(g: PageGeometry, scale: number, box: TopLeftBox): Rect {
  const corners = [
    [box.x, box.y],
    [box.x + box.w, box.y],
    [box.x, box.y + box.h],
    [box.x + box.w, box.y + box.h],
  ].map(([x, y]) => {
    const [ux, uy] = topLeftToPdfUser(g, x!, y!);
    return pdfUserToCss(g, scale, ux, uy);
  });
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

/**
 * A pointer event's client coordinates -> CSS page space. `rect` is the page element's
 * getBoundingClientRect() (it already includes scroll and the page's offset in the pane); `cssWidth`/
 * `cssHeight` its layout size. When they differ (a CSS transform or browser pinch-zoom) the point is
 * scaled back, so the result is always in the units `viewportTransform` uses.
 */
export function clientToPageCss(clientX: number, clientY: number, rect: Rect, cssWidth: number, cssHeight: number): { x: number; y: number } {
  const sx = rect.width > 0 ? cssWidth / rect.width : 1;
  const sy = rect.height > 0 ? cssHeight / rect.height : 1;
  return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy };
}

/** Canvas backing-store pixels -> CSS pixels. */
export function canvasToCss(px: number, py: number, outputScale: number): { x: number; y: number } {
  return { x: px / outputScale, y: py / outputScale };
}

/**
 * Backing-store scale for a page canvas: devicePixelRatio, lowered so the canvas stays under
 * `maxPixels` (browsers refuse or silently blank very large canvases at high zoom).
 */
export function outputScale(dpr: number, cssWidth: number, cssHeight: number, maxPixels = 16_777_216): number {
  const want = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const area = cssWidth * cssHeight;
  if (area <= 0) return want;
  const cap = Math.sqrt(maxPixels / area);
  return Math.min(want, cap);
}

/** True when the CSS point lies on the page (inclusive edges). */
export function insidePage(x: number, y: number, size: { width: number; height: number }): boolean {
  return x >= 0 && y >= 0 && x <= size.width && y <= size.height;
}
