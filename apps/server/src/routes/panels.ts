/**
 * Panel data routes:
 *   GET /api/panels        PanelsResponse { claims, figures, terminology, lit } (one round trip for the side panels)
 *   GET /api/claims        Claim[]          PUT /api/claims        Claim[] -> Claim[]
 *   GET /api/figures       FigureEntry[]    PUT /api/figures       FigureEntry[] -> FigureEntry[]
 *   GET /api/terminology   TermEntry[]      PUT /api/terminology   TermEntry[] -> TermEntry[]
 * PUT replaces the whole list (validated; duplicates by id/term: the last wins).
 */
import type { FastifyInstance } from 'fastify';
import { Claim, FigureEntry, ROUTES, TermEntry, type PanelsResponse } from '@paper-copilot/core';
import { z } from 'zod';
import type { Ctx } from '../contracts';
import { parseBody } from './facts';

export const PANELS_ROUTE = '/api/panels';

export function registerPanelsRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get(PANELS_ROUTE, async () => {
    const res: PanelsResponse = { claims: ctx.facts.claims(), figures: ctx.facts.figures(), terminology: ctx.facts.terminology(), lit: ctx.lit.records() };
    return res;
  });

  app.get(ROUTES.claims, async () => ctx.facts.claims());
  app.put(ROUTES.claims, async (req) => {
    await ctx.facts.saveClaims(parseBody(z.array(Claim), req.body, 'claims'));
    return ctx.facts.claims();
  });

  app.get(ROUTES.figures, async () => ctx.facts.figures());
  app.put(ROUTES.figures, async (req) => {
    await ctx.facts.saveFigures(parseBody(z.array(FigureEntry), req.body, 'figures'));
    return ctx.facts.figures();
  });

  app.get(ROUTES.terminology, async () => ctx.facts.terminology());
  app.put(ROUTES.terminology, async (req) => {
    await ctx.facts.saveTerminology(parseBody(z.array(TermEntry), req.body, 'terminology'));
    return ctx.facts.terminology();
  });
}
