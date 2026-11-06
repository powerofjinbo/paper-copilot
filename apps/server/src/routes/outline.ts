/**
 * Outline routes (.paper/outline.json):
 *   GET /api/outline   Outline (an empty outline until the author fills the five items); while it has no
 *                      sections, the main file's \section headings are offered as sections (titles only,
 *                      not saved until the author saves the outline)
 *   PUT /api/outline   Outline -> Outline (validated with the core schema; emits plan.updated)
 */
import type { FastifyInstance } from 'fastify';
import { Outline, ROUTES, emptyOutline, type OutlineSection } from '@paper-copilot/core';
import { defaultGhostMode, sectionTypeOf } from '../services/llm/context';
import type { Ctx } from '../contracts';
import { parseWith } from './project';

export function readOutline(ctx: Ctx): Outline {
  return ctx.files.readJson(ctx.paths.outline, Outline, emptyOutline());
}

/** Skill template for a heading (the names OutlineSection.template documents). */
function templateFor(title: string, id: string, part: string): string {
  const t = `${title} ${id} ${part}`.toLowerCase();
  if (/abstract/.test(t)) return 'abstract';
  if (/intro/.test(t)) return 'introduction';
  if (/conclu|summary|outlook/.test(t)) return 'conclusions';
  if (/result|performance/.test(t)) return 'results';
  return 'section';
}

/** The outline, with the main file's top-level headings as sections when it has none yet. */
export async function outlineWithDocSections(ctx: Ctx): Promise<Outline> {
  const outline = readOutline(ctx);
  if (outline.sections.length > 0) return outline;
  let doc;
  try {
    doc = ctx.docs.get(ctx.config.mainFile) ?? (await ctx.docs.open(ctx.config.mainFile));
  } catch {
    return outline;
  }
  const seen = new Set<string>();
  const sections: OutlineSection[] = [];
  for (const h of doc.seg.sections) {
    if (h.level > 1 || seen.has(h.id)) continue;
    seen.add(h.id);
    const template = templateFor(h.title, h.id, h.part);
    sections.push({ id: h.id, title: h.title, question: '', template, ghostMode: defaultGhostMode(sectionTypeOf(template, h.part, h.title)), paragraphs: [], provenance: 'author' });
  }
  return { ...outline, sections };
}

export function registerOutlineRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get(ROUTES.outline, async () => outlineWithDocSections(ctx));
  app.put(ROUTES.outline, { bodyLimit: 16 * 1024 * 1024 }, async (req) => {
    const outline = parseWith(Outline, req.body, 'outline');
    await ctx.files.writeJson(ctx.paths.outline, outline);
    ctx.bus.emit({ type: 'plan.updated', outline });
    return outline;
  });
}
