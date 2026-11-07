/**
 * Batch B report routes (paths in FEATURE_ROUTES / REPORT_ROUTES of @paper-copilot/core). Every report is
 * computed on demand from the CURRENT text of every .tex file of the main file's \input tree (open mirrors;
 * included files nobody opened yet are opened first, so their sentences have ids and links) and the
 * current stores (facts, derived relations, outline, terminology, figures, claims, literature, lint,
 * compile status):
 *   GET /api/consistency          EchoReport          (core echoCheck)            alias /api/reports/consistency
 *   GET /api/terminology-report   TerminologyReport   (core terminologyReport)    alias /api/reports/terminology
 *   GET /api/figure-plan          FigurePlanReport    (core figurePlan)           alias /api/reports/figure-plan
 *   GET /api/submission-check     SubmissionReport    (core submissionCheck; ?venue=aps|elsevier|arxiv|springer)
 *                                                                                  alias /api/reports/submission
 *   GET /api/facts/derived        DerivedRelationData[] (the derived numbers every gate call accepts)
 *   GET /api/files                ProjectFilesResponse (the \input tree in document order, per-file counts;
 *                                 never opens a file: counts of a file never opened come from the segmenter)
 * Files nothing \input-s are not typeset, so they are left out of the reports (they are listed by /api/files).
 */
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import {
  FEATURE_ROUTES,
  Outline,
  REPORT_ROUTES,
  Venue,
  derivedRelations,
  echoCheck,
  emptyOutline,
  extractTitle,
  figurePlan,
  orderUnits,
  projectFileOrder,
  segment,
  submissionCheck,
  terminologyReport,
  unitsWithText,
  type CompileError,
  type ConsistencyUnit,
  type DerivedRelation,
  type EchoReport,
  type Fact,
  type FigurePlanFile,
  type FigurePlanReport,
  type LintFlag,
  type ProjectFileEntry,
  type ProjectOrderEntry,
  type SentenceUnit,
  type SubmissionReport,
  type TerminologyReport,
} from '@paper-copilot/core';
import { z } from 'zod';
import type { Ctx } from '../contracts';
import { fromDisk, resolveInTex } from '../docs/text';
import { parseWith } from './project';

function soft<T>(ctx: Ctx, what: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (e) {
    ctx.log.debug(`reports: ${what} unavailable`, e instanceof Error ? e.message : String(e));
    return fallback;
  }
}

/** The derived relations the gate accepts (the fact service's cached list, else computed). */
export function derivedOf(ctx: Ctx, facts?: Fact[]): DerivedRelation[] {
  return soft(ctx, 'facts.derived', () => (typeof ctx.facts.derived === 'function' ? ctx.facts.derived() : derivedRelations(facts ?? ctx.facts.all())), []);
}

async function diskText(ctx: Ctx, file: string): Promise<string | null> {
  try {
    const { abs } = resolveInTex(ctx.paths.tex, file);
    return fromDisk(await readFile(abs, 'utf8')).text;
  } catch {
    return null;
  }
}

/** Current text of every .tex file (open mirror, else disk), in the docs service's order (main file first). */
async function currentTexts(ctx: Ctx): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  for (const f of await ctx.docs.files()) {
    const open = ctx.docs.get(f);
    const t = open ? open.text : await diskText(ctx, f);
    if (t !== null) texts.set(f, t);
  }
  return texts;
}

export interface ProjectSnapshot {
  mainFile: string;
  order: ProjectOrderEntry[];
  /** The typeset files (the \input tree), document order, with their current text. */
  files: FigurePlanFile[];
  /** Their units with LaTeX source, in document order (orphans dropped, appendix parts fixed). */
  units: ConsistencyUnit[];
  facts: Fact[];
  derived: DerivedRelation[];
  outline: Outline;
  title: string | null;
}

/**
 * Every typeset file with its current text and units. Included files that are not open are opened (an
 * import on the very first open: every sentence is the author's), and pending typing is segmented first,
 * so the spans describe the text on screen. Without a main file in the tree, every .tex file is used.
 */
export async function projectSnapshot(ctx: Ctx): Promise<ProjectSnapshot> {
  const mainFile = ctx.config.mainFile;
  const ensure = (ctx.facts as { ensureScanned?: () => Promise<void> }).ensureScanned;
  if (typeof ensure === 'function') await ensure.call(ctx.facts).catch(() => undefined);
  let texts = await currentTexts(ctx);
  let order = projectFileOrder(mainFile, Object.fromEntries(texts));
  let included = order.filter((e) => e.included);
  if (included.length === 0) included = order;
  let opened = false;
  for (const e of included) {
    if (ctx.docs.get(e.file)) {
      await ctx.docs.flush(e.file);
      continue;
    }
    try {
      await ctx.docs.open(e.file);
      opened = true;
    } catch (err) {
      ctx.log.warn(`reports: cannot open ${e.file}; its sentences are left out`, err instanceof Error ? err.message : String(err));
    }
  }
  if (opened) {
    texts = await currentTexts(ctx);
    order = projectFileOrder(mainFile, Object.fromEntries(texts));
    included = order.filter((e) => e.included);
    if (included.length === 0) included = order;
  }
  const files: FigurePlanFile[] = [];
  const units: SentenceUnit[] = [];
  const mirror = new Map<string, string>();
  for (const e of included) {
    const st = ctx.docs.get(e.file);
    const text = st ? st.text : texts.get(e.file);
    if (text === undefined) continue;
    mirror.set(e.file, text);
    files.push(st ? { file: e.file, text, seg: st.seg } : { file: e.file, text });
    if (st) units.push(...st.units);
  }
  const facts = soft(ctx, 'facts.all', () => ctx.facts.all(), [] as Fact[]);
  const typeset = included.map((e) => e.file);
  return {
    mainFile,
    order: order.filter((e) => typeset.includes(e.file)),
    files,
    units: orderUnits(unitsWithText(units, mirror), order),
    facts,
    derived: derivedOf(ctx, facts),
    outline: soft(ctx, 'outline', () => ctx.files.readJson(ctx.paths.outline, Outline, emptyOutline()), emptyOutline()),
    title: mirror.has(mainFile) ? extractTitle(mirror.get(mainFile)!) : null,
  };
}

export function consistencyReport(snap: ProjectSnapshot): EchoReport {
  return echoCheck(snap.units, snap.facts, snap.outline, { title: snap.title, derived: snap.derived });
}

export function terminologyOf(ctx: Ctx, snap: ProjectSnapshot): TerminologyReport {
  return terminologyReport(snap.units, soft(ctx, 'facts.terminology', () => ctx.facts.terminology(), []));
}

export function figurePlanOf(ctx: Ctx, snap: ProjectSnapshot): FigurePlanReport {
  return figurePlan(snap.files, snap.units, snap.outline, {
    order: snap.order,
    figures: soft(ctx, 'facts.figures', () => ctx.facts.figures(), []),
    claims: soft(ctx, 'facts.claims', () => ctx.facts.claims(), []),
  });
}

/** The last compile as submissionCheck reads it (null: never compiled in this launch). */
function compileState(ctx: Ctx): { state: 'idle' | 'running' | 'ok' | 'error'; errors: CompileError[] } | null {
  const st = soft(ctx, 'build.status', () => ctx.build.status(), null);
  if (!st) return null;
  if (st.state === 'idle' && st.pdfVersion === null) return null;
  return { state: st.state, errors: st.errors };
}

export async function submissionReport(ctx: Ctx, venue: Venue): Promise<SubmissionReport> {
  const snap = await projectSnapshot(ctx);
  const lintFlags: LintFlag[] = [];
  for (const f of snap.files) lintFlags.push(...soft(ctx, 'lint.flags', () => ctx.lint.flags(f.file), [] as LintFlag[]));
  const echo = consistencyReport(snap);
  return submissionCheck({
    mainFile: snap.mainFile,
    files: snap.files.map((f) => ({ file: f.file, text: f.text })),
    units: snap.units,
    facts: snap.facts,
    venue,
    bibKeys: soft(ctx, 'lit.bibKeys', () => ctx.lit.bibKeys(), []),
    lit: soft(ctx, 'lit.records', () => ctx.lit.records(), []),
    compile: compileState(ctx),
    lintFlags,
    outline: snap.outline,
    terms: soft(ctx, 'facts.terminology', () => ctx.facts.terminology(), []),
    derived: snap.derived,
    echo,
    figures: figurePlanOf(ctx, snap),
    terminology: terminologyOf(ctx, snap),
  });
}

/* ------------------------------------------------------------------------------------ */
/* GET /api/files                                                                        */
/* ------------------------------------------------------------------------------------ */

const sameAnchor = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export async function projectFiles(ctx: Ctx): Promise<ProjectFileEntry[]> {
  const texts = await currentTexts(ctx);
  const main = ctx.config.mainFile;
  const order = projectFileOrder(main, Object.fromEntries(texts));
  return order.map((e) => {
    const anchor = e.included ? (e.anchor ?? []) : [];
    const parent = e.included && anchor.length > 0 ? (order.find((p) => p.included && sameAnchor(p.anchor ?? [], anchor.slice(0, -1)))?.file ?? null) : null;
    const st = ctx.docs.get(e.file);
    let units: SentenceUnit[] = st ? st.units : soft(ctx, 'db.units', () => ctx.db.units(e.file), [] as SentenceUnit[]);
    units = units.filter((u) => !u.orphaned);
    let count = units.length;
    if (!st && units.length === 0) {
      // never opened: the sentences the segmenter finds (all the author's; nothing is AI yet)
      const text = texts.get(e.file);
      count = text ? soft(ctx, 'segment', () => segment(text).sentences.length, 0) : 0;
    }
    return {
      file: e.file,
      main: e.file === main,
      parent,
      depth: anchor.length,
      included: e.included,
      appendix: e.appendix,
      open: !!st,
      units: count,
      proposed: units.filter((u) => u.state === 'proposed').length,
      unsupported: units.filter((u) => u.state === 'unsupported').length,
      placeholders: units.filter((u) => u.state === 'placeholder' || u.placeholders.length > 0).length,
      aiTouched: units.filter((u) => u.everAi).length,
    };
  });
}

/* ------------------------------------------------------------------------------------ */
/* Routes                                                                                */
/* ------------------------------------------------------------------------------------ */

const VenueQuery = z.object({ venue: Venue.optional() });

export function registerReportsRoutes(app: FastifyInstance, ctx: Ctx): void {
  const consistency = async () => consistencyReport(await projectSnapshot(ctx));
  const terminology = async () => terminologyOf(ctx, await projectSnapshot(ctx));
  const figures = async () => figurePlanOf(ctx, await projectSnapshot(ctx));
  const submission = async (req: { query: unknown }) => {
    const q = parseWith(VenueQuery, req.query, 'query');
    return submissionReport(ctx, q.venue ?? ctx.config.venue);
  };

  app.get(FEATURE_ROUTES.consistency, consistency);
  app.get(REPORT_ROUTES.consistency, consistency);
  app.get(FEATURE_ROUTES.terminologyReport, terminology);
  app.get(REPORT_ROUTES.terminology, terminology);
  app.get(FEATURE_ROUTES.figurePlan, figures);
  app.get(REPORT_ROUTES.figurePlan, figures);
  app.get(FEATURE_ROUTES.submissionCheck, submission);
  app.get(REPORT_ROUTES.submission, submission);
  app.get(FEATURE_ROUTES.factsDerived, async () => {
    const ensure = (ctx.facts as { ensureScanned?: () => Promise<void> }).ensureScanned;
    if (typeof ensure === 'function') await ensure.call(ctx.facts).catch(() => undefined);
    return derivedOf(ctx);
  });
  app.get(FEATURE_ROUTES.files, async () => projectFiles(ctx));
}
