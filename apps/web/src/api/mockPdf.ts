/**
 * The browser demo's example PDF (`?mock=1` has no LaTeX). fixtures/canto-demo/demo/main.pdf was compiled
 * from fixtures/canto-demo/tex/main.tex with latexmk, and synctex.json holds the SyncTeX box of every source
 * line (fixtures/canto-demo/demo/build.ts regenerates both). The PDF never changes with the author's edits,
 * so forward and inverse search here are approximate: a line of the CURRENT text is matched to the line of
 * the fixture with the same text (the nearest one), and back.
 */
import pdfUrl from '../../../../fixtures/canto-demo/demo/main.pdf?url';
import synctexRaw from '../../../../fixtures/canto-demo/demo/synctex.json?raw';
import fixtureTex from '../../../../fixtures/canto-demo/tex/main.tex?raw';

export interface DemoBox {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const DEMO_PDF_URL: string = pdfUrl;

function loadBoxes(raw: string): Map<number, DemoBox> {
  const out = new Map<number, DemoBox>();
  try {
    const j = JSON.parse(raw) as { lines?: Record<string, DemoBox> };
    for (const [k, b] of Object.entries(j.lines ?? {})) {
      const n = Number(k);
      if (Number.isInteger(n) && b && [b.page, b.x, b.y, b.w, b.h].every((v) => typeof v === 'number' && Number.isFinite(v))) out.set(n, b);
    }
  } catch {
    /* a broken table: no SyncTeX in the demo (the callers say so) */
  }
  return out;
}

const BOXES = loadBoxes(synctexRaw);
const ORIGINAL = fixtureTex.split('\n');
/** First line after \begin{document}: preamble lines share the title's box and are never an inverse target. */
const BODY_START = Math.max(1, ORIGINAL.findIndex((l) => l.trim() === '\\begin{document}') + 2);

const norm = (s: string | undefined) => (s ?? '').trim();

/** The 1-based line of `lines` whose text equals `text`, nearest to `near`; null if none. */
function nearestSame(lines: readonly string[], text: string, near: number): number | null {
  if (!text) return null;
  let best: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (norm(lines[i]) !== text) continue;
    if (best === null || Math.abs(i + 1 - near) < Math.abs(best - near)) best = i + 1;
  }
  return best;
}

/**
 * Forward search: the PDF box for `line` of the current text, through the fixture line with the same text
 * (or, for a line the author added or changed, the nearest unchanged line above it). Null when nothing
 * matches.
 */
export function demoForward(currentText: string, line: number, boxes: ReadonlyMap<number, DemoBox> = BOXES, original: readonly string[] = ORIGINAL): DemoBox | null {
  const cur = currentText.split('\n');
  for (let l = Math.min(line, cur.length); l >= 1; l--) {
    const orig = nearestSame(original, norm(cur[l - 1]), l);
    if (orig !== null && boxes.has(orig)) return boxes.get(orig)!;
  }
  return null;
}

/**
 * Inverse search: the line of the current text for a click at (x, y) points on `page`. The smallest box
 * that contains the point (prose lines first), else the box nearest vertically within 24 pt; its fixture
 * line is mapped to the current text by its content (the nearest identical line), else kept as is.
 */
export function demoInverse(currentText: string, page: number, x: number, y: number, boxes: ReadonlyMap<number, DemoBox> = BOXES, original: readonly string[] = ORIGINAL, bodyStart = BODY_START): number | null {
  const slack = 1.5;
  let hit: { line: number; area: number; prose: boolean } | null = null;
  let near: { line: number; d: number } | null = null;
  for (const [line, b] of boxes) {
    if (b.page !== page || line < bodyStart) continue;
    const inside = x >= b.x - slack && x <= b.x + b.w + slack && y >= b.y - slack && y <= b.y + b.h + slack;
    if (inside) {
      const area = b.w * b.h;
      const text = norm(original[line - 1]);
      const prose = !!text && !text.startsWith('\\') && !text.startsWith('%');
      const better = !hit || (prose && !hit.prose) || (prose === hit.prose && (area < hit.area - 0.5 || (Math.abs(area - hit.area) <= 0.5 && line > hit.line)));
      if (better) hit = { line, area, prose };
    } else if (x >= b.x - slack && x <= b.x + b.w + slack) {
      const d = y < b.y ? b.y - y : y - (b.y + b.h);
      if (d <= 24 && (!near || d < near.d)) near = { line, d };
    }
  }
  const orig = hit?.line ?? near?.line ?? null;
  if (orig === null) return null;
  const cur = currentText.split('\n');
  return nearestSame(cur, norm(original[orig - 1]), orig) ?? Math.min(orig, cur.length);
}

/** True when the committed SyncTeX table loaded (forward / inverse search work in the demo). */
export function demoSynctexAvailable(): boolean {
  return BOXES.size > 0;
}
