/**
 * Venue disclosure of AI use (docs/design.md, "Faithfulness and provenance"):
 * GET /api/disclosure?venue=aps|elsevier|arxiv|springer -> DisclosureResponse, and .paper/ai_use_record.json.
 *
 * Which sentences are counted (decision): the CURRENT text only, i.e. the live units of every .tex file
 * (the open mirrors, else the units stored for files not open). Removed units (sentences deleted from
 * the paper) and orphans (lost their anchor after a co-author edit) are NOT counted as sentences, even
 * when AI touched them, because the disclosure describes the manuscript being submitted. Their AI
 * versions still count toward the tools/models used and the time span (core computeDisclosureStats
 * reads every version row), so a model that drafted text later deleted is still named.
 *
 * The record (ai_use_record.json) keeps the counts, the models, the first/last AI use, the venue text
 * and where the full per-sentence log is (.paper/history.jsonl). Nothing here is sent anywhere.
 */
import { computeDisclosureStats, renderDisclosure, type DisclosureResponse, type SentenceUnit, type Venue } from '@paper-copilot/core';
import type { Ctx } from '../contracts';
import { isTexName, listFiles } from '../docs/text';
import { SERVER_VERSION } from '../version';

export const TOOL_NAME = 'paper-copilot';
/** Record path as written into the venue text (relative to the project root, never an absolute home path). */
export const RECORD_PATH = '.paper/history.jsonl';

export interface DisclosureService {
  generate(venue: Venue): Promise<DisclosureResponse>;
}

/** Live units of the whole manuscript: open mirrors first, the stored units of every other .tex file. */
export function manuscriptUnits(ctx: Ctx): SentenceUnit[] {
  const out: SentenceUnit[] = [];
  const seen = new Set<string>();
  const files = new Set<string>(listFiles(ctx.paths.tex, isTexName));
  for (const f of files) {
    const open = ctx.docs.get(f);
    const units = open ? open.units : safe(() => ctx.db.units(f), []);
    for (const u of units) {
      if (u.orphaned || seen.has(u.id)) continue;
      seen.add(u.id);
      out.push(u);
    }
  }
  return out;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function createDisclosureService(ctx: Ctx): DisclosureService {
  return {
    async generate(venue) {
      // make sure pending typing is segmented so the counts describe the text on screen
      for (const f of await ctx.docs.files()) if (ctx.docs.get(f)) await ctx.docs.flush(f);
      const units = manuscriptUnits(ctx);
      const versions = ctx.db.allVersions();
      const stats = computeDisclosureStats(units, versions);
      const text = renderDisclosure(venue, stats, { toolName: TOOL_NAME, toolVersion: SERVER_VERSION, recordPath: RECORD_PATH });
      const record = {
        generatedAt: new Date().toISOString(),
        tool: { name: TOOL_NAME, version: SERVER_VERSION },
        venue,
        models: stats.models,
        firstAiUse: stats.firstTs,
        lastAiUse: stats.lastTs,
        counting: 'Sentences in the current manuscript text; deleted and orphaned sentences are not counted, their AI versions count toward models and dates.',
        stats,
        disclosure: { latex: text.latex, plain: text.plain, placement: text.placement },
        log: RECORD_PATH,
      };
      try {
        await ctx.files.writeJson(ctx.paths.aiUseRecord, record);
      } catch (e) {
        ctx.log.warn('disclosure: cannot write ai_use_record.json', String(e));
      }
      return { venue, latex: text.latex, plain: text.plain, placement: text.placement, stats: stats as unknown as Record<string, unknown> };
    },
  };
}
