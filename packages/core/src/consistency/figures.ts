/**
 * Figure plan (Figure-plan panel): every float of the project with its label, caption sentences,
 * first citation and citation order, a caption-anatomy checklist, and the claim -> figure map of the
 * outline (docs/design.md, UI layout: "Figure plan: job, claim, caption-anatomy checklist, citation
 * order, exists or needs run"; the skill's figures-and-evidence reference).
 *
 * OWNER: core-features agent.
 *
 * - Floats: figure, figure*, wrapfigure, sidewaysfigure, SCfigure (one counter) and table, table*,
 *   wraptable, sidewaystable (another), outside comments, in document order across \input files.
 * - Citations: every \ref-like command (\ref, \cref, \autoref, ...) to one of the float's labels outside
 *   the float itself. A float nobody cites is `float_uncited`; a float first cited after a float that
 *   LaTeX numbers later is `float_order` (readers expect Fig. 1 before Fig. 2).
 * - Caption anatomy (word heuristics, labelled as such): quantity versus variable ("efficiency versus
 *   displacement", "as a function of"), conditions (sample, selection, "for", "at", "with ..."), the
 *   encoding key (solid/dashed, markers, bands, colours), a panel map when the figure has several panels
 *   ((a)/(b), left/right, several \includegraphics or subfigures), and a reading rule or takeaway ("a ratio
 *   above one means ...", "higher is better"). Tables are checked for conditions and takeaway only.
 */
import type { CaptionCheck, ConsistencyFlag, FigurePlanReport, FloatPlanRow, SentenceRef } from '../api';
import type { Claim, FigureEntry, Outline } from '../schemas';
import type { SegSentence, Segmentation } from '../latex/segment';
import { scanLatex } from '../latex/tokens';
import { plainText } from '../text/normalize';
import { conditionPhrases } from './echo';
import { comparePositions, makeFlag, maskComments, positionResolver, sentenceRef, shorten, type ConsistencyUnit, type ProjectOrderEntry } from './common';

export interface FigurePlanFile {
  file: string;
  text: string;
  /** Used for caption sentences when no units of this file are given. */
  seg?: Segmentation;
}

export interface FigurePlanOptions {
  /** Document order (projectFileOrder); default: the order of `files`. */
  order?: readonly (ProjectOrderEntry | string)[];
  /** Figure entries of the sidecar (figureId -> label) for resolving outline.claimFigures. */
  figures?: readonly FigureEntry[];
  /** Claims, for the claim text in the claim -> figure map. */
  claims?: readonly Claim[];
}

const FIG_ENVS = new Set(['figure', 'figure*', 'wrapfigure', 'sidewaysfigure', 'sidewaysfigure*', 'SCfigure', 'SCfigure*']);
const TAB_ENVS = new Set(['table', 'table*', 'wraptable', 'sidewaystable', 'sidewaystable*', 'SCtable']);

interface RawFloat {
  kind: 'figure' | 'table';
  file: string;
  /** Position in the typeset document (positionResolver). */
  pos: number[];
  start: number;
  end: number;
  line: number;
  labels: string[];
  graphics: string[];
  subpanels: number;
  captionRaw: string;
  /** File offsets of its sub-panels (their captions are not the float's caption). */
  panelSpans: Array<[number, number]>;
}

function lineAtOffset(text: string, off: number): number {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < off; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

/** Offset just past the balanced `{...}` group that opens at `open` (src[open] === '{'), or src.length. */
function groupEnd(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return src.length;
}

/**
 * Spans of the sub-panels of a float (subfigure/subtable environments, \subfloat, \subfigure,
 * \subtable and \subcaptionbox commands with their arguments): their \caption and \label belong to a
 * panel, not to the float.
 */
function subPanelSpans(src: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const envRe = /\\begin\s*\{(sub(?:figure|table)\*?)\}/g;
  let m: RegExpExecArray | null;
  while ((m = envRe.exec(src))) {
    const endRe = new RegExp(`\\\\end\\s*\\{${m[1]!.replace('*', '\\*')}\\}`, 'g');
    endRe.lastIndex = m.index + m[0].length;
    const e = endRe.exec(src);
    out.push([m.index, e ? e.index + e[0].length : src.length]);
  }
  const cmdRe = /\\(subfloat|subfigure|subtable|subcaptionbox)(?![A-Za-z])/g;
  while ((m = cmdRe.exec(src))) {
    let i = m.index + m[0].length;
    let groups = m[1] === 'subcaptionbox' ? 2 : 1;
    while (i < src.length && groups > 0) {
      while (i < src.length && /\s/.test(src[i]!)) i++;
      if (src[i] === '[') {
        let depth = 0;
        for (; i < src.length; i++) {
          if (src[i] === '[') depth++;
          else if (src[i] === ']' && --depth === 0) break;
        }
        i++;
        continue;
      }
      if (src[i] !== '{') break;
      i = groupEnd(src, i);
      groups--;
    }
    out.push([m.index, i]);
  }
  return out;
}

const inSpans = (spans: ReadonlyArray<[number, number]>, off: number): boolean => spans.some(([a, b]) => off >= a && off < b);

/** Argument of the float's own `\caption[..]{..}` (the first outside its sub-panels, else the first), or ''. */
function captionArg(src: string, spans: ReadonlyArray<[number, number]> = []): string {
  const re = /\\caption\s*(?:\[[^\]]*\]\s*)?\{/g;
  let m: RegExpExecArray | null;
  let first: RegExpExecArray | null = null;
  let own: RegExpExecArray | null = null;
  while ((m = re.exec(src))) {
    first ??= m;
    if (!inSpans(spans, m.index)) {
      own = m;
      break;
    }
  }
  const c = own ?? first;
  if (!c) return '';
  const open = c.index + c[0].length - 1;
  const end = groupEnd(src, open);
  return src.slice(open + 1, Math.max(open + 1, end - 1));
}

function scanFloats(file: string, text: string, posOf: (file: string, offset: number) => number[]): RawFloat[] {
  const src = maskComments(text);
  const out: RawFloat[] = [];
  const re = /\\begin\s*\{([A-Za-z]+\*?)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const env = m[1]!;
    const kind = FIG_ENVS.has(env) ? 'figure' : TAB_ENVS.has(env) ? 'table' : null;
    if (!kind) continue;
    const endRe = new RegExp(`\\\\end\\s*\\{${env.replace('*', '\\*')}\\}`, 'g');
    endRe.lastIndex = m.index + m[0].length;
    const e = endRe.exec(src);
    const end = e ? e.index + e[0].length : src.length;
    const at = m.index;
    const inner = src.slice(at, end);
    const spans = subPanelSpans(inner);
    // the float's own label first (outside its sub-panels), then the panels' labels: a \ref to a panel cites the float
    const own: string[] = [];
    const panel: string[] = [];
    try {
      for (const kc of scanLatex(inner).keyCommands) if (kc.kind === 'label') (inSpans(spans, kc.start) ? panel : own).push(...kc.keys);
    } catch {
      /* no labels */
    }
    const labels = [...own, ...panel];
    const graphics = [...inner.matchAll(/\\includegraphics\s*(?:\[[^\]]*\]\s*)?\{([^{}]*)\}/g)].map((g) => g[1]!.trim());
    const subpanels = (inner.match(/\\begin\s*\{sub(?:figure|table)\}|\\subfloat\b|\\subcaptionbox\b|\\subfigure\b/g) ?? []).length;
    out.push({ kind, file, pos: posOf(file, m.index), start: m.index, end, line: lineAtOffset(text, m.index), labels, graphics, subpanels, captionRaw: captionArg(inner, spans), panelSpans: spans.map(([a, b]) => [at + a, at + b] as [number, number]) });
    re.lastIndex = end;
  }
  return out;
}

const QUANTITY_RE = /\b(?:versus|vs\.?|as a function of|against|in bins of|binned in|dependence on|distributions? of|per|by|for each|in each)\b/i;
const COND_RE = /\b(?:samples?|events?|selection|selected|test set|population|after|requiring|pile-?up|cuts?|targets?|particles?|data set|dataset|simulation|simulated)\b/i;
const ENCODING_RE = /\b(?:solid|dashed|dotted|dash-dotted|lines?|markers?|points|circles?|squares?|triangles?|bands?|shaded|filled|open|colou?r(?:ed|s)?|red|blue|green|black|orange|gr[ae]y|purple|histograms?|error bars?|legend|curves?|boxes|crosses|stars|diamonds|hatched)\b/i;
const PANEL_TOKEN_RE = /\((?:[a-f])\)|\b(?:left|right|top|bottom|upper|middle)\b|\blower(?=\s+(?:panel|plot|row|half))|\bpanels?\b/gi;
const TAKEAWAY_RE = /\b(?:above|below|higher|larger|smaller|shorter|longer|better|worse|means?|indicates?|shows? that|exceed(?:s)?|outperforms?|favou?rs?|improves?|drops?|falls?|rises?|grows?|degrades?|agrees?|consistent with|overlaps?|differs?|dominat\w*|reads?|is best|the gap|the lead|ratio|most|neither|the same)\b|\blower(?!\s+(?:panel|plot|row|half|left|right))/i;
const PANEL_WORD_RE = /\((?:[a-f]|left|right|top|bottom)\)|\b(?:left|right|top|bottom|upper|lower|middle)\s+(?:panels?|plots?|row)\b|\bpanels?\b|\b(?:left|right|top|bottom)\s*:/i;
const PANEL_SHOWS_RE = /\b(?:left|right|top|bottom|upper|lower|middle|inset)\s+(?:panels?|plots?)\s+(?:shows?|gives?|displays?|is|are|compares?)\b/i;

function checklist(kind: 'figure' | 'table', captionPlain: string, captionLatex: string, multi: boolean): CaptionCheck[] {
  const ev = (re: RegExp): string | null => {
    const m = re.exec(captionPlain);
    return m ? m[0] : null;
  };
  const out: CaptionCheck[] = [];
  if (kind === 'figure') {
    const q = ev(QUANTITY_RE);
    out.push({ key: 'quantity', status: q ? 'ok' : 'missing', evidence: q });
  } else out.push({ key: 'quantity', status: 'na', evidence: null });
  const cond = conditionPhrases(captionLatex)[0]?.phrase ?? ev(COND_RE);
  out.push({ key: 'conditions', status: cond ? 'ok' : 'missing', evidence: cond });
  if (kind === 'figure') {
    const enc = ev(ENCODING_RE);
    out.push({ key: 'encoding', status: enc ? 'ok' : 'missing', evidence: enc });
    if (multi) {
      const toks = new Set((captionPlain.match(PANEL_TOKEN_RE) ?? []).map((x) => x.toLowerCase()).filter((x) => x !== 'panel' && x !== 'panels'));
      const shows = PANEL_SHOWS_RE.exec(captionPlain);
      out.push({ key: 'panels', status: toks.size >= 2 || shows ? 'ok' : 'missing', evidence: toks.size ? [...toks].join(', ') : shows ? shows[0] : null });
    } else out.push({ key: 'panels', status: 'na', evidence: null });
  } else {
    out.push({ key: 'encoding', status: 'na', evidence: null });
    out.push({ key: 'panels', status: 'na', evidence: null });
  }
  const tk = ev(TAKEAWAY_RE);
  out.push({ key: 'takeaway', status: tk ? 'ok' : 'missing', evidence: tk });
  return out;
}

const CHECK_WORDS: Record<string, string> = { quantity: 'quantity versus variable', conditions: 'conditions', encoding: 'encoding key (line styles, markers, colours)', panels: 'panel map', takeaway: 'reading rule or takeaway' };

/** Figure plan over the project's files and units. Pure; never throws on odd input. */
export function figurePlan(files: readonly FigurePlanFile[], units: readonly ConsistencyUnit[], outline: Outline | null | undefined, opts: FigurePlanOptions = {}): FigurePlanReport {
  const fl = (Array.isArray(files) ? files : []).filter((f) => f && typeof f.file === 'string' && typeof f.text === 'string');
  const posOf = positionResolver(opts.order ?? fl.map((f) => f.file));
  for (const f of fl) posOf(f.file, 0);
  const ordered = [...fl].sort((a, b) => comparePositions(posOf(a.file, 0), posOf(b.file, 0)));
  const us = (Array.isArray(units) ? units : []).filter((u) => u && typeof u.text === 'string' && !u.orphaned);
  const unitsOf = new Map<string, ConsistencyUnit[]>();
  for (const u of us) {
    const l = unitsOf.get(u.file);
    if (l) l.push(u);
    else unitsOf.set(u.file, [u]);
  }
  // files without units: caption and prose sentences from their segmentation (no sentence ids)
  for (const f of ordered) {
    if (unitsOf.has(f.file) || !f.seg) continue;
    unitsOf.set(
      f.file,
      f.seg.sentences.map((s: SegSentence): ConsistencyUnit => ({ id: '', file: f.file, line: s.line, part: s.part, kind: s.kind, sectionId: s.sectionId, text: s.text, start: s.start, end: s.end })),
    );
  }

  const raws: RawFloat[] = ordered.flatMap((f) => scanFloats(f.file, f.text, posOf)).sort((a, b) => comparePositions(a.pos, b.pos));
  const counters = { figure: 0, table: 0 };
  const byLabel = new Map<string, number>();
  raws.forEach((r, i) => {
    for (const l of r.labels) if (!byLabel.has(l)) byLabel.set(l, i);
  });

  // citations
  interface Cite {
    pos: number[];
    offset: number;
    file: string;
    line: number;
    unit: ConsistencyUnit | null;
  }
  const cites = new Map<number, Cite[]>();
  for (const f of ordered) {
    let kcs: ReturnType<typeof scanLatex>['keyCommands'] = [];
    try {
      kcs = scanLatex(maskComments(f.text)).keyCommands;
    } catch {
      kcs = [];
    }
    const fileUnits = unitsOf.get(f.file) ?? [];
    for (const kc of kcs) {
      if (kc.kind !== 'ref') continue;
      for (const key of kc.keys) {
        const fi = byLabel.get(key);
        if (fi === undefined) continue;
        const r = raws[fi]!;
        if (r.file === f.file && kc.start >= r.start && kc.start < r.end) continue; // the float's own caption
        // the sentence holding it: the smallest unit span around the offset
        let unit: ConsistencyUnit | null = null;
        for (const u of fileUnits) {
          if (u.start === undefined || u.end === undefined) continue;
          if (kc.start >= u.start && kc.start < u.end && (!unit || u.end - u.start < (unit.end! - unit.start!))) unit = u;
        }
        const list = cites.get(fi) ?? [];
        list.push({ pos: posOf(f.file, kc.start), offset: kc.start, file: f.file, line: lineAtOffset(f.text, kc.start), unit });
        cites.set(fi, list);
      }
    }
  }
  const before = (a: Cite, b: Cite): boolean => comparePositions(a.pos, b.pos) < 0;
  const byPos = (a: Cite, b: Cite): number => comparePositions(a.pos, b.pos);

  const flags: ConsistencyFlag[] = [];
  const rows: FloatPlanRow[] = raws.map((r, i) => {
    const number = ++counters[r.kind];
    const fileUnits = unitsOf.get(r.file) ?? [];
    const allCaps = fileUnits.filter((u) => u.kind === 'caption' && u.start !== undefined && u.start >= r.start && u.start < r.end);
    const ownCaps = allCaps.filter((u) => !inSpans(r.panelSpans, u.start!));
    const caps = ownCaps.length ? ownCaps : allCaps;
    const captionLatex = caps.length ? caps.map((u) => u.text).join(' ') : r.captionRaw;
    let captionPlain = '';
    try {
      captionPlain = plainText(captionLatex);
    } catch {
      captionPlain = captionLatex;
    }
    const cs = (cites.get(i) ?? []).sort(byPos);
    const first = cs[0];
    const firstRef: SentenceRef | null = first ? (first.unit && first.unit.id ? sentenceRef(first.unit) : { sentenceId: null, file: first.file, line: first.line, part: first.unit?.part ?? null, text: shorten(first.unit?.text ?? '') }) : null;
    const multi = r.graphics.length > 1 || r.subpanels > 0 || PANEL_WORD_RE.test(captionPlain);
    return {
      kind: r.kind,
      number,
      label: r.labels[0] ?? null,
      labels: r.labels,
      file: r.file,
      line: r.line,
      graphics: r.graphics,
      captionSentenceIds: caps.map((u) => u.id).filter(Boolean),
      caption: shorten(captionPlain, 400),
      firstRef,
      refCount: cs.length,
      citeRank: null,
      outOfOrder: false,
      checklist: captionLatex.trim() ? checklist(r.kind, captionPlain, captionLatex, multi) : [],
      claimIds: [],
    };
  });
  // citation ranks and order, per kind
  for (const kind of ['figure', 'table'] as const) {
    const idx = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.kind === kind);
    const cited = idx.filter(({ i }) => (cites.get(i) ?? []).length > 0);
    const firstOf = (i: number): Cite => (cites.get(i) ?? []).sort(byPos)[0]!;
    const byCite = [...cited].sort((a, b) => (before(firstOf(a.i), firstOf(b.i)) ? -1 : before(firstOf(b.i), firstOf(a.i)) ? 1 : a.i - b.i));
    byCite.forEach(({ r }, k) => (r.citeRank = k + 1));
    for (const { r, i } of cited) {
      const earlier = cited.filter(({ r: o, i: j }) => o.number < r.number && before(firstOf(i), firstOf(j)));
      if (earlier.length) {
        r.outOfOrder = true;
        const name = kind === 'figure' ? 'Fig.' : 'Table';
        flags.push(
          makeFlag('float_order', {
            label: r.label,
            sentenceIds: [r.firstRef?.sentenceId ?? ''].filter(Boolean),
            message: `${name} ${r.number}${r.label ? ` (${r.label})` : ''} is cited before ${earlier.map(({ r: o }) => `${name} ${o.number}`).join(', ')}; cite floats in the order they are numbered, or move the float.`,
          }),
        );
      }
    }
  }
  for (const r of rows) {
    const name = r.kind === 'figure' ? 'Fig.' : 'Table';
    if (!r.label) flags.push(makeFlag('float_no_label', { subject: `${r.file}:${r.line}`, message: `${name} ${r.number} (${r.file}:${r.line}) has no \\label, so the text cannot cite it.` }));
    if (!r.checklist.length) flags.push(makeFlag('float_no_caption', { subject: `${r.file}:${r.line}`, label: r.label, message: `${name} ${r.number}${r.label ? ` (${r.label})` : ''} has no caption.` }));
    if (r.label && r.refCount === 0) flags.push(makeFlag('float_uncited', { label: r.label, sentenceIds: r.captionSentenceIds, message: `${name} ${r.number} (${r.label}) is never cited in the text; every float needs a sentence that sends the reader to it.` }));
    const missing = r.checklist.filter((c) => c.status === 'missing');
    if (missing.length) {
      flags.push(
        makeFlag('caption_anatomy', {
          label: r.label,
          subject: `${r.file}:${r.line}`,
          severity: 'info',
          heuristic: true,
          sentenceIds: r.captionSentenceIds,
          message: `${name} ${r.number}${r.label ? ` (${r.label})` : ''}: the caption may lack ${missing.map((c) => CHECK_WORDS[c.key]).join(', ')} (word heuristic).`,
        }),
      );
    }
  }

  // claim -> figure
  const figById = new Map<string, FigureEntry>((opts.figures ?? []).map((f) => [f.figureId, f] as const));
  const claimById = new Map<string, Claim>((opts.claims ?? []).map((c) => [c.claimId, c] as const));
  const claimsOut: FigurePlanReport['claims'] = [];
  for (const cf of outline?.claimFigures ?? []) {
    if (!cf || typeof cf.figureId !== 'string') continue;
    const entry = figById.get(cf.figureId);
    const tryLabels = [cf.figureId, entry?.label ?? '', `fig:${cf.figureId}`, `tab:${cf.figureId}`].filter(Boolean);
    const fi = tryLabels.map((l) => byLabel.get(l)).find((x) => x !== undefined);
    const row = fi !== undefined ? rows[fi]! : null;
    if (row && !row.claimIds.includes(cf.claimId)) row.claimIds.push(cf.claimId);
    const claimText = claimById.get(cf.claimId)?.text ?? null;
    claimsOut.push({ claimId: cf.claimId, figureId: cf.figureId, label: row?.label ?? null, found: !!row, cited: !!row && row.refCount > 0, claimText });
    if (!row) flags.push(makeFlag('claim_figure_missing', { subject: cf.claimId, label: cf.figureId, message: `Claim ${cf.claimId}${claimText ? ` ("${shorten(claimText, 60)}")` : ''} is carried by ${cf.figureId}, which is not a float of the paper yet (needs a run or a \\label).` }));
    else if (row.refCount === 0) flags.push(makeFlag('claim_figure_uncited', { subject: cf.claimId, label: row.label, message: `Claim ${cf.claimId} rests on ${row.kind === 'figure' ? 'Fig.' : 'Table'} ${row.number} (${row.label}), which the text never cites.` }));
  }
  return { floats: rows, claims: claimsOut, flags };
}
