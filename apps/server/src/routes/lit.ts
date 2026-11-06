/**
 * Literature routes:
 *   GET  /api/lit                   LitRecord[] (every .bib key, with its resolution status)
 *   POST /api/lit/resolve           { force?, keys? } -> 202 { jobId }; runs job 'resolve-lit' (progress via job.progress)
 *   POST /api/lit/reload            re-read the .bib files -> { keys, errors }
 *   GET  /api/lit/:key              one LitRecord
 *   POST /api/lit/:key/confirm      { confirmed?: boolean (default true) } -> LitRecord (user_confirmed)
 */
import type { FastifyInstance } from 'fastify';
import { ROUTES, type LitRecord } from '@paper-copilot/core';
import { z } from 'zod';
import { HttpError, type Ctx, type LitService } from '../contracts';
import { parseBody } from './facts';

const ResolveBody = z.object({ force: z.boolean().optional(), keys: z.array(z.string()).optional() }).strict();
const ConfirmBody = z.object({ confirmed: z.boolean().optional() }).strict();

type LitWithOptions = LitService & {
  resolveAll(opts?: { force?: boolean; keys?: string[]; progress?: (m: string) => void }): Promise<LitRecord[]>;
  confirm(key: string, confirmed?: boolean): LitRecord;
  record?: (key: string) => LitRecord | undefined;
  bibErrors?: () => string[];
};

export function registerLitRoutes(app: FastifyInstance, ctx: Ctx): void {
  const lit = () => ctx.lit as LitWithOptions;

  app.get(ROUTES.lit, async () => ctx.lit.records());

  app.post(ROUTES.litResolve, async (req, reply) => {
    const body = parseBody(ResolveBody, req.body ?? {}, 'resolve request');
    const known = new Set(ctx.lit.bibKeys());
    const unknown = (body.keys ?? []).filter((k) => !known.has(k));
    if (unknown.length) throw new HttpError(400, `unknown .bib key(s): ${unknown.join(', ')}`);
    const jobId = ctx.jobs.start('resolve-lit', async (progress) => {
      const recs = await lit().resolveAll({ force: body.force, keys: body.keys, progress });
      return {
        total: recs.length,
        resolved: recs.filter((r) => r.status === 'resolved').length,
        userConfirmed: recs.filter((r) => r.status === 'user_confirmed').length,
        unresolved: recs.filter((r) => r.status === 'unresolved').map((r) => r.key),
      };
    });
    reply.code(202);
    return { jobId };
  });

  app.post(`${ROUTES.lit}/reload`, async () => {
    await ctx.lit.reloadBib();
    return { keys: ctx.lit.bibKeys().length, errors: lit().bibErrors?.() ?? [] };
  });

  app.get<{ Params: { key: string } }>(`${ROUTES.lit}/:key`, async (req) => {
    const rec = lit().record ? lit().record!(req.params.key) : ctx.lit.records().find((r) => r.key === req.params.key);
    if (!rec) throw new HttpError(404, `unknown .bib key: ${req.params.key}`);
    return rec;
  });

  app.post<{ Params: { key: string } }>(`${ROUTES.lit}/:key/confirm`, async (req) => {
    const body = parseBody(ConfirmBody, req.body ?? {}, 'confirm request');
    return lit().confirm(req.params.key, body.confirmed ?? true);
  });
}
