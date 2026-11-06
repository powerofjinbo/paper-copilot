/**
 * Agent routes: start read-only agent jobs and read referee questions.
 *
 *   POST /api/agents/read-repo          -> { jobId }
 *   POST /api/agents/outline-framings   -> { jobId }
 *   POST /api/agents/draft      (DraftRequest)   -> { jobId }
 *   POST /api/agents/referee    (RefereeRequest) -> { jobId }
 *   GET  /api/questions?sectionId=      -> RefereeQuestion[]
 *
 * Job progress and results arrive as job.progress events; a draft ends with one draft.proposed event.
 * Client errors (bad body, unknown section, a drafting job already running...) are HttpErrors.
 */
import type { FastifyInstance } from 'fastify';
import { DraftRequest, ROUTES, RefereeRequest } from '@paper-copilot/core';
import type { z } from 'zod';
import { HttpError, type Ctx } from '../contracts';

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    throw new HttpError(400, `invalid request body: ${r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}`);
  }
  return r.data;
}

export function registerAgentsRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.post(ROUTES.agentsReadRepo, async () => ({ jobId: ctx.agents.readRepo() }));
  app.post(ROUTES.agentsFramings, async () => ({ jobId: ctx.agents.framings() }));
  app.post(ROUTES.agentsDraft, async (req) => ({ jobId: ctx.agents.draft(parseBody(DraftRequest, req.body)) }));
  app.post(ROUTES.agentsReferee, async (req) => ({ jobId: ctx.agents.referee(parseBody(RefereeRequest, req.body).sectionId) }));
  app.get(ROUTES.questions, async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const sectionId = typeof q.sectionId === 'string' && q.sectionId.length > 0 ? q.sectionId : undefined;
    return ctx.agents.questions(sectionId);
  });
}

/** Alias (route modules are named register<Area>Routes; the area here is "agents"). */
export const registerAgentRoutes = registerAgentsRoutes;
