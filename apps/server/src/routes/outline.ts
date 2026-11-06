/**
 * Outline routes (.paper/outline.json):
 *   GET /api/outline   Outline (an empty outline until the author fills the five items)
 *   PUT /api/outline   Outline -> Outline (validated with the core schema; emits plan.updated)
 */
import type { FastifyInstance } from 'fastify';
import { Outline, ROUTES, emptyOutline } from '@paper-copilot/core';
import type { Ctx } from '../contracts';
import { parseWith } from './project';

export function readOutline(ctx: Ctx): Outline {
  return ctx.files.readJson(ctx.paths.outline, Outline, emptyOutline());
}

export function registerOutlineRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get(ROUTES.outline, async () => readOutline(ctx));
  app.put(ROUTES.outline, { bodyLimit: 16 * 1024 * 1024 }, async (req) => {
    const outline = parseWith(Outline, req.body, 'outline');
    await ctx.files.writeJson(ctx.paths.outline, outline);
    ctx.bus.emit({ type: 'plan.updated', outline });
    return outline;
  });
}
