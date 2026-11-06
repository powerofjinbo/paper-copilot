/**
 * GET /api/disclosure?venue=aps|elsevier|arxiv|springer -> DisclosureResponse (default: the project's venue).
 * Also writes .paper/ai_use_record.json. Counting rules: services/disclosure.ts.
 */
import type { FastifyInstance } from 'fastify';
import { ROUTES, Venue } from '@paper-copilot/core';
import { z } from 'zod';
import type { Ctx } from '../contracts';
import { createDisclosureService } from '../services/disclosure';
import { parseWith } from './project';

export function registerDisclosureRoutes(app: FastifyInstance, ctx: Ctx): void {
  const svc = createDisclosureService(ctx);
  app.get(ROUTES.disclosure, async (req) => {
    const q = parseWith(z.object({ venue: Venue.optional() }), req.query, 'query');
    return svc.generate(q.venue ?? ctx.config.venue);
  });
}
