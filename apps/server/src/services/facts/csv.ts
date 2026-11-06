/**
 * RFC 4180 CSV parsing for result tables (no dependencies).
 *
 * - Handles a UTF-8 BOM, CRLF / LF / CR line endings, quoted fields with embedded delimiters,
 *   newlines and doubled quotes (`""`).
 * - The delimiter is detected from the header line: ',' unless the header has no comma and has
 *   tabs (TSV) or semicolons. `.tsv` files default to tabs.
 * - Blank records (only whitespace, single empty field) are skipped and do not count as rows.
 */

export interface CsvTable {
  delimiter: string;
  /** Header names, trimmed, made unique (`name`, `name_2`, ...); empty names become `col<N>` (1-based). */
  header: string[];
  /** Data records (header excluded, blank lines skipped); padded/truncated to the header length. */
  rows: string[][];
  /** Records whose field count differed from the header. */
  ragged: number;
}

export function detectDelimiter(firstLine: string, ext: string): string {
  if (ext === 'tsv') return '\t';
  if (firstLine.includes(',')) return ',';
  if (firstLine.includes('\t')) return '\t';
  if (firstLine.includes(';')) return ';';
  return ',';
}

/** Parse all records of `text` with `delimiter` (a single character). */
export function parseCsvRecords(text: string, delimiter: string): string[][] {
  const out: string[][] = [];
  const n = text.length;
  const d = delimiter.charCodeAt(0);
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let record: string[] = [];
  let field = '';
  let fieldStart = i;
  let quoted = false;
  let inQuotes = false;
  const endField = (end: number) => {
    record.push(quoted ? field : text.slice(fieldStart, end));
    field = '';
    quoted = false;
  };
  const endRecord = () => {
    if (!(record.length === 1 && record[0]!.trim() === '')) out.push(record);
    record = [];
  };
  while (i < n) {
    const c = text.charCodeAt(i);
    if (inQuotes) {
      if (c === 34 /* " */) {
        if (text.charCodeAt(i + 1) === 34) {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      // Copy a run of non-quote characters at once.
      let j = i + 1;
      while (j < n && text.charCodeAt(j) !== 34) j++;
      field += text.slice(i, j);
      i = j;
      continue;
    }
    if (c === 34 && (quoted || text.slice(fieldStart, i).trim() === '')) {
      // Opening quote (leading whitespace before it is dropped).
      if (!quoted) field = '';
      quoted = true;
      inQuotes = true;
      i++;
      continue;
    }
    if (c === d) {
      endField(i);
      i++;
      fieldStart = i;
      continue;
    }
    if (c === 10 /* \n */ || c === 13 /* \r */) {
      endField(i);
      endRecord();
      if (c === 13 && text.charCodeAt(i + 1) === 10) i++;
      i++;
      fieldStart = i;
      continue;
    }
    if (quoted) {
      // Characters after a closing quote (malformed); keep them.
      field += text[i];
    }
    i++;
  }
  if (inQuotes || quoted || i > fieldStart || record.length > 0) {
    endField(n);
    endRecord();
  }
  return out;
}

export function parseCsv(text: string, ext = 'csv'): CsvTable {
  const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let firstLineEnd = text.indexOf('\n', start);
  if (firstLineEnd === -1) firstLineEnd = text.length;
  const delimiter = detectDelimiter(text.slice(start, firstLineEnd), ext);
  const records = parseCsvRecords(text, delimiter);
  if (records.length === 0) return { delimiter, header: [], rows: [], ragged: 0 };
  const seen = new Map<string, number>();
  const header = records[0]!.map((raw, idx) => {
    let name = raw.trim() || `col${idx + 1}`;
    const k = seen.get(name) ?? 0;
    seen.set(name, k + 1);
    if (k > 0) {
      let m = k + 1;
      while (seen.has(`${name}_${m}`)) m++;
      name = `${name}_${m}`;
      seen.set(name, 1);
    }
    return name;
  });
  let ragged = 0;
  const rows: string[][] = [];
  for (let r = 1; r < records.length; r++) {
    const rec = records[r]!;
    if (rec.length !== header.length) {
      ragged++;
      if (rec.length < header.length) while (rec.length < header.length) rec.push('');
      else rec.length = header.length;
    }
    rows.push(rec);
  }
  return { delimiter, header, rows, ragged };
}

/** Strict decimal number grammar (what result writers emit): 12, -3.5, .5, 1e-3, 2.0E+4. */
const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
/** Cell texts that mean "no value" and do not make a numeric column non-numeric. */
const MISSING = new Set(['', 'nan', 'NaN', 'NAN', 'NA', 'N/A', 'n/a', 'null', 'NULL', 'None', 'inf', '-inf', '+inf', 'Inf', '-Inf', 'Infinity', '-Infinity']);

export function parseNumberCell(cell: string): number | null {
  const s = cell.trim();
  if (!NUM_RE.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

export function isMissingCell(cell: string): boolean {
  return MISSING.has(cell.trim());
}

export function isBooleanCell(cell: string): boolean {
  const s = cell.trim();
  return s === 'True' || s === 'False' || s === 'true' || s === 'false' || s === 'TRUE' || s === 'FALSE';
}
