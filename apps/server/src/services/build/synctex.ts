/**
 * SyncTeX command-line output parsing and coordinate conversion.
 *
 * Coordinates. `synctex view` prints, per matching box, `Page`, `x`, `y`, `h`, `v`, `W`, `H` in PDF big
 * points (1/72 inch) measured from the TOP-LEFT corner of the page with y growing downwards. `h` is the
 * left edge of the box, `v` its baseline, `W` its width and `H` its height above the baseline (depth is
 * not reported). The box of one record is therefore
 *   left = h, top = v - H, width = W, height = H          (top-left origin, points)
 * which is what PDF.js-style viewers need after flipping with the page height if they use a
 * bottom-left origin (yBottomLeft = pageHeight - top - height). Checked against `pdftotext -bbox` on
 * the fixture: a line's synctex box and its words' boxes agree to 0.01 pt.
 * A source line usually yields several records (one per typeset line); we return the union of the
 * records on the first page that overlap the first record's column, so a sentence wrapped over three
 * lines gives one rectangle and a two-column page never gives a box spanning the gutter.
 *
 * `synctex edit -o page:x:y:file.pdf` takes the same top-left-origin point coordinates and prints
 * `Input:<path>` and `Line:<n>` (Column is usually -1).
 */

export interface SynctexRecord {
  page: number;
  x: number;
  y: number;
  h: number;
  v: number;
  W: number;
  H: number;
}

export interface PdfBox {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

function num(s: string | undefined): number {
  const n = s === undefined ? NaN : Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/** Records of a `synctex view` result (between "SyncTeX result begin" and "end"). */
export function parseSynctexView(out: string): SynctexRecord[] {
  const recs: SynctexRecord[] = [];
  let cur: Partial<Record<'page' | 'x' | 'y' | 'h' | 'v' | 'W' | 'H', number>> | null = null;
  const flush = () => {
    if (!cur) return;
    const r = cur;
    if ([r.page, r.h, r.v, r.W, r.H].every((n) => n !== undefined && Number.isFinite(n)) && (r.page ?? 0) >= 1) {
      recs.push({ page: r.page!, x: r.x ?? r.h!, y: r.y ?? r.v!, h: r.h!, v: r.v!, W: r.W!, H: r.H! });
    }
    cur = null;
  };
  let inResult = false;
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === 'SyncTeX result begin') {
      inResult = true;
      continue;
    }
    if (line === 'SyncTeX result end') {
      flush();
      inResult = false;
      continue;
    }
    if (!inResult) continue;
    const m = /^([A-Za-z]+):(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    const val = m[2]!;
    if (key === 'Output') {
      flush();
      cur = {};
      continue;
    }
    if (!cur) cur = {};
    if (key === 'Page') cur.page = num(val);
    else if (key === 'x' || key === 'y' || key === 'h' || key === 'v' || key === 'W' || key === 'H') cur[key] = num(val);
  }
  flush();
  return recs;
}

/** Union box (top-left origin, points) of the records on the first record's page and column. */
export function boxFromRecords(recs: SynctexRecord[]): PdfBox | null {
  const first = recs[0];
  if (!first) return null;
  const left0 = first.h;
  const right0 = first.h + Math.max(0, first.W);
  const same = recs.filter((r) => {
    if (r.page !== first.page) return false;
    const l = r.h;
    const rr = r.h + Math.max(0, r.W);
    // Horizontal overlap with the first record (same column); zero-width records count at their h.
    return rr >= left0 - 0.5 && l <= right0 + 0.5;
  });
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of same) {
    const top = r.v - Math.max(0, r.H);
    x0 = Math.min(x0, r.h);
    y0 = Math.min(y0, top);
    x1 = Math.max(x1, r.h + Math.max(0, r.W));
    y1 = Math.max(y1, r.v);
  }
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return null;
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  const round = (n: number) => Math.round(n * 100) / 100;
  return { page: first.page, x: round(x0), y: round(y0), w: round(Math.max(0, x1 - x0)), h: round(Math.max(0, y1 - y0)) };
}

/**
 * Input/Line records of a `synctex edit` result, in output order. synctex lists the enclosing boxes
 * first and the innermost last (a click on a sentence of an \include'd chapter yields the page box from
 * main.tex at \begin{document}, then the chapter line), so callers should prefer the LAST record.
 */
export function parseSynctexEditAll(out: string): Array<{ input: string; line: number; column: number | null }> {
  const recs: Array<{ input: string; line: number; column: number | null }> = [];
  let inResult = false;
  let input: string | null = null;
  let line: number | null = null;
  let column: number | null = null;
  const flush = () => {
    if (input !== null && line !== null && Number.isFinite(line) && line >= 1) recs.push({ input, line, column });
    input = null;
    line = null;
    column = null;
  };
  for (const raw of out.split(/\r?\n/)) {
    const t = raw.replace(/\r$/, '');
    if (t.trim() === 'SyncTeX result begin') {
      inResult = true;
      continue;
    }
    if (t.trim() === 'SyncTeX result end') break;
    if (!inResult) continue;
    if (t.startsWith('Output:')) {
      flush();
    } else if (t.startsWith('Input:')) {
      if (input !== null) flush();
      input = t.slice('Input:'.length);
    } else if (t.startsWith('Line:')) {
      line = num(t.slice(5));
    } else if (t.startsWith('Column:')) {
      const c = num(t.slice(7));
      column = Number.isFinite(c) && c >= 0 ? c : null;
    }
  }
  flush();
  return recs;
}

/** The innermost (last) record of a `synctex edit` result. */
export function parseSynctexEdit(out: string): { input: string; line: number; column: number | null } | null {
  const all = parseSynctexEditAll(out);
  return all.length ? all[all.length - 1]! : null;
}
