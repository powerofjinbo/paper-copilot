/**
 * Shared pieces of the Consistency, Terminology and Figure-plan reports: the unit shape they read (a
 * sentence unit plus its LaTeX source), document order across `\input` files, plain-word matching and
 * stable flag ids.
 *
 * OWNER: core-features agent.
 */
import type { ConsistencyFlag, ConsistencyFlagKind, SentenceRef } from '../api';
import type { Part, SentenceState, SentenceUnit, UnitKind } from '../schemas';
import { hashString } from '../text/hash';
import { plainText } from '../text/normalize';

/**
 * What the reports need of a sentence: where it is, what part of the paper it belongs to, and its LaTeX
 * source (`text`, the [start, end) slice of the file). Every SentenceUnit field is accepted; `unitsWithText`
 * builds these from units and file texts.
 */
export interface ConsistencyUnit {
  id: string;
  file: string;
  line: number;
  part: Part;
  kind: UnitKind;
  sectionId: string;
  /** LaTeX source of the sentence. */
  text: string;
  start?: number;
  end?: number;
  paragraphId?: string;
  state?: SentenceState;
  everAi?: boolean;
  facts?: string[];
  cites?: string[];
  placeholders?: string[];
  intentNote?: string | null;
  orphaned?: boolean;
}

/** A .tex file of the project: path relative to the tex root, and its current text. */
export interface ProjectFile {
  file: string;
  text: string;
}

/** Attach each unit's source text (`texts[file].slice(start, end)`); units of unknown files get their textNorm. */
export function unitsWithText(units: readonly SentenceUnit[], texts: Readonly<Record<string, string>> | ReadonlyMap<string, string>): ConsistencyUnit[] {
  const get = (f: string): string | undefined => (texts instanceof Map ? texts.get(f) : (texts as Record<string, string>)[f]);
  return units.map((u) => {
    const t = get(u.file);
    const text = typeof t === 'string' && u.end <= t.length ? t.slice(u.start, u.end) : u.textNorm;
    return { ...u, text };
  });
}

/** The text with comments blanked out (same length, so offsets are unchanged). `\%` is not a comment. */
export function maskComments(text: string): string {
  let out = '';
  let pos = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    if (text[i] !== '%') continue;
    let bs = 0;
    for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) bs++;
    if (bs % 2 === 1) continue;
    let e = text.indexOf('\n', i);
    if (e < 0) e = n;
    out += text.slice(pos, i) + ' '.repeat(e - i);
    pos = e;
    i = e;
  }
  return out + text.slice(pos);
}

export interface ProjectOrderEntry {
  file: string;
  /** Included after `\appendix` in its parent (its sentences belong to the appendix). */
  appendix: boolean;
  /** Reached from the main file through \input / \include / \subfile. */
  included: boolean;
  /**
   * Where the file's text sits in the typeset document: the offsets of the \input commands that lead to
   * it, from the main file down ([] for the main file). Unreached files get [Infinity, rank]. Compare
   * positions with `documentPosition` / `comparePositions`.
   */
  anchor?: number[];
}

function resolveInclude(arg: string, from: string, have: (f: string) => boolean): string | null {
  let a = arg.trim().replace(/^\.\//, '').replace(/\\/g, '/');
  if (!a || a.includes('..')) return null;
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
  const tries = [a, `${a}.tex`];
  for (const t of tries) {
    if (have(t)) return t;
    if (dir && have(dir + t)) return dir + t;
  }
  a = a.replace(/\.tex$/, '');
  return have(`${a}.tex`) ? `${a}.tex` : null;
}

/**
 * Document order of the project's .tex files: the main file, then every file it inputs (\input,
 * \include, \subfile; recursively, in the order the inputs appear outside comments), then the files
 * nothing reaches (sorted), which LaTeX never typesets. A file is in the appendix when its \input
 * comes after `\appendix` (or inside an appendix environment) of a file that is itself typeset.
 */
export function projectFileOrder(mainFile: string, files: readonly ProjectFile[] | Readonly<Record<string, string>>): ProjectOrderEntry[] {
  const texts = new Map<string, string>(Array.isArray(files) ? (files as ProjectFile[]).map((f) => [f.file, f.text] as const) : Object.entries(files as Record<string, string>));
  const have = (f: string): boolean => texts.has(f);
  const out: ProjectOrderEntry[] = [];
  const seen = new Set<string>();
  const visit = (file: string, appendix: boolean, depth: number, anchor: number[]): void => {
    if (seen.has(file) || depth > 20) return;
    seen.add(file);
    out.push({ file, appendix, included: true, anchor });
    const src = maskComments(texts.get(file) ?? '');
    const re = /\\(input|include|subfile)\s*(?:\{([^{}]*)\}|([^\s{}\\%]+))|\\appendix\b|\\begin\s*\{(?:appendix|appendices)\}/g;
    let inApp = appendix;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      if (!m[1]) {
        inApp = true;
        continue;
      }
      const target = resolveInclude(m[2] ?? m[3] ?? '', file, have);
      if (target) visit(target, inApp, depth + 1, [...anchor, m.index]);
    }
  };
  if (texts.has(mainFile)) visit(mainFile, false, 0, []);
  let k = 0;
  for (const f of [...texts.keys()].sort()) if (!seen.has(f)) out.push({ file: f, appendix: false, included: false, anchor: [Number.POSITIVE_INFINITY, k++] });
  return out;
}

/**
 * Position of an offset of `file` in the typeset document, as a key for `comparePositions`: the \input
 * offsets leading to the file, then the offset itself. Files missing from `order` sort after all others,
 * in the order they are first asked for.
 */
export function positionResolver(order: readonly (ProjectOrderEntry | string)[] | undefined): (file: string, offset: number) => number[] {
  const anchors = new Map<string, number[]>();
  (order ?? []).forEach((e, i) => {
    if (typeof e === 'string') {
      if (!anchors.has(e)) anchors.set(e, [Number.POSITIVE_INFINITY, i]);
    } else if (!anchors.has(e.file)) anchors.set(e.file, e.anchor ?? [Number.POSITIVE_INFINITY, i]);
  });
  let extra = anchors.size;
  return (file, offset) => {
    let a = anchors.get(file);
    if (!a) anchors.set(file, (a = [Number.POSITIVE_INFINITY, extra++]));
    return [...a, offset];
  };
}

/** Lexicographic comparison of two document positions (see positionResolver). */
export function comparePositions(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * Units in document order: where their file is \input into the main file (`order` from projectFileOrder;
 * a plain list of files is read as "one after the other"), then by offset (or line).
 * Units of a file typeset in the appendix get part 'app' where the per-file segmentation said 'body'
 * (each file is segmented alone and cannot see the main file's \appendix). Orphaned units are dropped.
 */
export function orderUnits(units: readonly ConsistencyUnit[], order?: readonly (ProjectOrderEntry | string)[]): ConsistencyUnit[] {
  const app = new Set<string>();
  for (const e of order ?? []) if (typeof e !== 'string' && e.appendix) app.add(e.file);
  const pos = positionResolver(order);
  // files absent from `order` keep the order in which they first appear in `units`
  for (const u of units) pos(u.file, 0);
  return units
    .map((u, i) => ({ u, i, k: pos(u.file, u.start ?? u.line) }))
    .filter(({ u }) => !u.orphaned)
    .sort((a, b) => comparePositions(a.k, b.k) || a.i - b.i)
    .map(({ u }) => (app.has(u.file) && u.part === 'body' ? { ...u, part: 'app' as Part } : u));
}

/** Plain-text title of a LaTeX document (`\title[short]{long}`), or null. */
export function extractTitle(text: string): string | null {
  const src = maskComments(text ?? '');
  const m = /\\title\s*(?:\[[^\]]*\]\s*)?\{/.exec(src);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  for (; i < src.length && depth > 0; i++) {
    const c = src[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  const raw = src.slice(start, Math.max(start, i - 1)).replace(/\\\\/g, ' ');
  const t = plainText(raw).trim();
  return t || null;
}

export function shorten(s: string, n = 200): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

export function sentenceRef(u: Pick<ConsistencyUnit, 'id' | 'file' | 'line' | 'part' | 'text'>): SentenceRef {
  return { sentenceId: u.id, file: u.file, line: u.line, part: u.part, text: shorten(u.text) };
}

export function makeFlag(
  kind: ConsistencyFlagKind,
  p: { message: string; severity?: 'warn' | 'info'; heuristic?: boolean; factIds?: string[]; sentenceIds?: string[]; term?: string | null; label?: string | null; subject?: string },
): ConsistencyFlag {
  const sentenceIds = [...new Set(p.sentenceIds ?? [])];
  const factIds = [...new Set(p.factIds ?? [])];
  return {
    id: hashString(`${kind}|${p.subject ?? ''}|${p.term ?? ''}|${p.label ?? ''}|${factIds.join(',')}|${sentenceIds.join(',')}`),
    kind,
    severity: p.severity ?? 'warn',
    heuristic: p.heuristic ?? false,
    message: p.message,
    factIds,
    sentenceIds,
    term: p.term ?? null,
    label: p.label ?? null,
  };
}

/* ------------------------------------------------------------------------------------ */
/* Plain words                                                                           */
/* ------------------------------------------------------------------------------------ */

/** Function words (no content of their own) for phrase and condition matching. */
export const STOP_WORDS: ReadonlySet<string> = new Set(
  `a an the of to in on for with by from at as and or but nor not no is are was were be been being this that these those it its
  their our we they which who whom whose than then so such each every all any some both either neither one two three only also
  very more most less least much many into onto over under within without between among per via about after before while
  where when if whether can could may might must shall should will would do does did has have had i you he she them us my your`
    .split(/\s+/)
    .filter(Boolean),
);

/** A crude English stem ("trackers" -> "tracker", "studies" -> "study", "trained" -> "train"), for matching only. */
const IRREGULAR: Readonly<Record<string, string>> = {
  saw: 'see', seen: 'see', found: 'find', made: 'make', gave: 'give', given: 'give', took: 'take', taken: 'take', shown: 'show',
  chose: 'choose', chosen: 'choose', led: 'lead', began: 'begin', begun: 'begin', kept: 'keep', held: 'hold', lost: 'lose', met: 'meet',
  ran: 'run', rose: 'rise', risen: 'rise', fell: 'fall', fallen: 'fall', grew: 'grow', grown: 'grow', knew: 'know', known: 'know',
  wrote: 'write', written: 'write', built: 'build', brought: 'bring', thought: 'think', taught: 'teach', sought: 'seek', drew: 'draw', drawn: 'draw',
};

export function stemWord(w: string): string {
  let s = w.toLowerCase().replace(/[’']s$/, '');
  const irr = IRREGULAR[s];
  if (irr) return irr;
  if (s.length <= 3) return s;
  if (/ies$/.test(s) && s.length > 4) return s.slice(0, -3) + 'y';
  if (/(?:sses|shes|ches|xes|zes)$/.test(s)) return s.slice(0, -2);
  if (/ss$/.test(s)) return s;
  if (/ing$/.test(s) && s.length > 5) s = s.slice(0, -3);
  else if (/ed$/.test(s) && s.length > 4) s = s.slice(0, -2);
  else if (/s$/.test(s) && !/(?:us|is)$/.test(s)) s = s.slice(0, -1);
  if (/([^aeiou])\1$/.test(s) && !/(?:ll|ss|ff|zz)$/.test(s)) s = s.slice(0, -1);
  if (/e$/.test(s) && s.length > 4) s = s.slice(0, -1);
  return s;
}

/** Lower-case word tokens of plain text, hyphenated compounds split ("graph-neural-network" -> 3 words). */
export function plainTokens(plain: string): string[] {
  return (plain.toLowerCase().match(/[\p{L}\p{N}]+(?:[’'][\p{L}]+)?/gu) ?? []).filter((w) => w !== 'x'); // 'x' is plainText's stand-in for inline math
}

/** Stemmed tokens of a LaTeX sentence (math placeholders dropped). */
export function stemsOfLatex(latex: string): string[] {
  return plainTokens(plainText(latex)).map(stemWord);
}

export function contentStems(tokens: readonly string[]): string[] {
  return tokens.filter((t) => !STOP_WORDS.has(t) && !/^\d+$/.test(t)).map(stemWord);
}

/** Index of `needle` as a contiguous run inside `hay`, or -1. */
export function findRun(hay: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || needle.length > hay.length) return -1;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

export type PhraseMatch = { status: 'present' | 'partial' | 'missing'; matched: string | null };

/**
 * Is a phrase in a sentence? present: its stemmed words appear contiguously (hyphens and inflection do not
 * matter: "graph neural network" matches "graph-neural-network trackers"); partial: every content word
 * appears, or at least half of them (two or more); missing otherwise.
 */
export function matchPhrase(phrase: string, latexOrPlain: string, isPlain = false): PhraseMatch {
  const plain = isPlain ? latexOrPlain : plainText(latexOrPlain);
  const toks = plainTokens(plain);
  const hay = toks.map(stemWord);
  const need = plainTokens(phrase).map(stemWord);
  if (need.length === 0) return { status: 'missing', matched: null };
  const at = findRun(hay, need);
  if (at >= 0) return { status: 'present', matched: toks.slice(at, at + need.length).join(' ') };
  const content = contentStems(plainTokens(phrase));
  if (content.length === 0) return { status: 'missing', matched: null };
  const set = new Set(hay);
  const hits = content.filter((c) => set.has(c));
  if (hits.length === content.length || (content.length >= 2 && hits.length >= 2 && hits.length * 2 >= content.length)) {
    return { status: 'partial', matched: hits.join(' ') };
  }
  return { status: 'missing', matched: null };
}

export const PART_ORDER: readonly Part[] = ['abstract', 'intro', 'body', 'caption', 'concl', 'app', 'footnote'];
