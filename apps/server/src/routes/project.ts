/**
 * Project routes:
 *   GET /api/project      ProjectInfo { config, files, fakeLlm, skill, stats }
 *   GET /api/jobs         JobInfo[] (background jobs of this launch)
 *   GET /api/jobs/:id     JobInfo
 */
import type { FastifyInstance } from 'fastify';
import { ROUTES, type ProjectInfo } from '@paper-copilot/core';
import { z } from 'zod';
import { HttpError, type Ctx } from '../contracts';
import { manuscriptUnits } from '../services/disclosure';

/** Validate a request body/query with a zod schema; failures become HTTP 400 with the issues. */
export function parseWith<T>(schema: z.ZodType<T>, value: unknown, what = 'body'): T {
  const p = schema.safeParse(value ?? {});
  if (!p.success) throw new HttpError(400, `invalid ${what}: ${p.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  return p.data;
}

function soft<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export async function projectInfo(ctx: Ctx): Promise<ProjectInfo> {
  const files = await ctx.docs.files();
  const skill = soft(() => ctx.llm.skill(), null);
  const units = soft(() => manuscriptUnits(ctx), []);
  return {
    config: ctx.config,
    files,
    fakeLlm: ctx.fakeLlm,
    skill: { found: !!skill, dir: ctx.config.skillDir, version: skill?.version ?? null, references: skill ? Object.keys(skill.references).sort() : [] },
    stats: {
      units: units.length,
      proposed: units.filter((u) => u.state === 'proposed').length,
      facts: soft(() => ctx.facts.all().length, 0),
      placeholders: units.filter((u) => u.state === 'placeholder' || u.placeholders.length > 0).length,
    },
  };
}

export function registerProjectRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get(ROUTES.project, async () => projectInfo(ctx));
  app.get('/api/jobs', async () => ctx.jobs.list());
  app.get('/api/jobs/:id', async (req) => {
    const { id } = parseWith(z.object({ id: z.string().min(1).max(200) }), req.params, 'params');
    const j = ctx.jobs.get(id);
    if (!j) throw new HttpError(404, `no such job: ${id}`);
    return j;
  });
}
