/**
 * Fact routes (paths from ROUTES in @paper-copilot/core):
 *   GET   /api/facts              FactsResponse { facts, unresolved }; scans the repository on the very first call.
 *                                 Optional query: q (substring of id/definition/value), kind (comma list),
 *                                 stale=1, excluded=0 (hide excluded), artifact (path prefix), ids (comma
 *                                 list), unresolved=0 (skip the document scan), limit, offset. The total
 *                                 before limit/offset is in the `x-total-count` header.
 *   GET   /api/facts/:id          one Fact
 *   PATCH /api/facts/:id          FactPatch -> Fact
 *   POST  /api/facts/rescan       -> { count, stale }
 *   POST  /api/facts/manual       ManualFact -> Fact (201)
 */
import type { FastifyInstance } from 'fastify';
import { FactPatch, ManualFact, ROUTES, type Fact, type FactsResponse } from '@paper-copilot/core';
import { z } from 'zod';
import { HttpError, type Ctx } from '../contracts';

/** Validate a request body; a ZodError becomes HTTP 400 with the issues. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown, what = 'body'): T {
  const p = schema.safeParse(body);
  if (!p.success) throw new HttpError(400, `invalid ${what}: ${p.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  return p.data;
}

const FactsQuery = z.object({
  q: z.string().optional(),
  kind: z.string().optional(),
  stale: z.enum(['0', '1', 'true', 'false']).optional(),
  excluded: z.enum(['0', '1', 'true', 'false']).optional(),
  artifact: z.string().optional(),
  ids: z.string().optional(),
  unresolved: z.enum(['0', '1', 'true', 'false']).optional(),
  limit: z.coerce.number().int().min(0).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const truthy = (v: string | undefined) => v === '1' || v === 'true';
const falsy = (v: string | undefined) => v === '0' || v === 'false';

function filterFacts(facts: Fact[], q: z.infer<typeof FactsQuery>): Fact[] {
  let out = facts;
  if (q.ids) {
    const want = new Set(q.ids.split(',').map((s) => s.trim()).filter(Boolean));
    out = out.filter((f) => want.has(f.id));
  }
  if (q.kind) {
    const kinds = new Set(q.kind.split(',').map((s) => s.trim()).filter(Boolean));
    out = out.filter((f) => kinds.has(f.kind));
  }
  if (truthy(q.stale)) out = out.filter((f) => f.stale);
  if (falsy(q.excluded)) out = out.filter((f) => !f.excluded);
  if (q.artifact) out = out.filter((f) => f.artifact.startsWith(q.artifact!));
  if (q.q && q.q.trim()) {
    const needle = q.q.trim().toLowerCase();
    out = out.filter((f) => f.id.toLowerCase().includes(needle) || f.definition.toLowerCase().includes(needle) || String(f.value).toLowerCase().includes(needle));
  }
  return out;
}

export function registerFactsRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get(ROUTES.facts, async (req, reply) => {
    const q = parseBody(FactsQuery, req.query ?? {}, 'query');
    const svc = ctx.facts as typeof ctx.facts & { ensureScanned?: () => Promise<void> };
    if (typeof svc.ensureScanned === 'function') await svc.ensureScanned();
    const all = filterFacts(ctx.facts.all(), q);
    reply.header('x-total-count', String(all.length));
    const offset = q.offset ?? 0;
    const facts = q.limit !== undefined ? all.slice(offset, offset + q.limit) : all.slice(offset);
    const unresolved = falsy(q.unresolved) ? [] : ctx.facts.unresolved();
    const res: FactsResponse = { facts, unresolved };
    return res;
  });

  app.get<{ Params: { id: string } }>(ROUTES.fact, async (req) => {
    const f = ctx.facts.get(req.params.id);
    if (!f) throw new HttpError(404, `unknown fact: ${req.params.id}`);
    return f;
  });

  app.patch<{ Params: { id: string } }>(ROUTES.fact, async (req) => {
    const patch = parseBody(FactPatch, req.body ?? {}, 'fact patch');
    return ctx.facts.patch(req.params.id, patch);
  });

  app.post(ROUTES.factsRescan, async () => ctx.facts.rescan());

  app.post(ROUTES.factsManual, async (req, reply) => {
    const m = parseBody(ManualFact, req.body, 'manual fact');
    const f = ctx.facts.addManual(m);
    reply.code(201);
    return f;
  });
}
