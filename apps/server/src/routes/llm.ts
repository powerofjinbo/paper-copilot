/**
 * Sentence actions and cost (ROUTES in packages/core/src/api.ts).
 *
 *   POST /api/sentences/:id/instruct      { instruction, lang }  -> Proposal
 *   POST /api/sentences/:id/alternatives  { n }                  -> { proposals: Proposal[] }
 *   POST /api/sentences/:id/grammar       {}                     -> Proposal
 *   POST /api/intent/render               { file, line, text, n } -> { proposals: Proposal[] }
 *   GET  /api/cost                                               -> CostTotals
 *
 * Every proposal has already passed the faithfulness gate; blocked ones carry their issues and show
 * placeholders instead of ungrounded numbers or citations. Nothing here changes the document: the
 * client applies an accepted proposal as an annotated transaction.
 */
import type { FastifyInstance } from 'fastify';
import { AlternativesRequest, InstructRequest, IntentRenderRequest, ROUTES } from '@paper-copilot/core';
import { z } from 'zod';
import { HttpError, type Ctx } from '../contracts';

const IdParams = z.object({ id: z.string().min(1).max(200) });

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw new HttpError(400, `invalid ${what}: ${r.error.issues.map((i) => `${i.path.join('.') || what}: ${i.message}`).join('; ')}`);
  return r.data;
}

export function registerLlmRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.post(ROUTES.sentenceInstruct, async (req) => {
    const { id } = parse(IdParams, req.params, 'sentence id');
    const body = parse(InstructRequest, req.body, 'body');
    return ctx.llm.instruct(id, body.instruction, body.lang);
  });

  app.post(ROUTES.sentenceAlternatives, async (req) => {
    const { id } = parse(IdParams, req.params, 'sentence id');
    const body = parse(AlternativesRequest, req.body, 'body');
    if (body.n < 1 || body.n > 5) throw new HttpError(400, 'n must be between 1 and 5');
    return { proposals: await ctx.llm.alternatives(id, body.n) };
  });

  app.post(ROUTES.sentenceGrammar, async (req) => {
    const { id } = parse(IdParams, req.params, 'sentence id');
    return ctx.llm.grammar(id);
  });

  app.post(ROUTES.intentRender, async (req) => {
    const body = parse(IntentRenderRequest, req.body, 'body');
    if (body.n < 1 || body.n > 3) throw new HttpError(400, 'n must be between 1 and 3');
    if (body.line < 1) throw new HttpError(400, 'line must be >= 1');
    return { proposals: await ctx.llm.renderIntent(body) };
  });

  app.get(ROUTES.cost, async () => ctx.llm.costTotals());
}
