/**
 * Build routes: compile, the PDF, SyncTeX.
 *
 *   POST /api/compile                      -> CompileStatus (waits for the run; concurrent calls coalesce)
 *   GET  /api/pdf?v=<pdfVersion>&token=    -> the last good PDF (application/pdf, Cache-Control: no-store)
 *   GET  /api/synctex/forward?file=&line=  -> { page, x, y, w, h } in PDF points, top-left origin, or null
 *   GET  /api/synctex/inverse?page=&x=&y=  -> { file, line } (texRoot-relative) or null
 *
 * The token check (header or ?token= for the PDF URL) is done by the hub for every /api request.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { ROUTES } from '@paper-copilot/core';
import { z } from 'zod';
import { HttpError, type Ctx } from '../contracts';

const CompileBody = z.object({ reason: z.enum(['save', 'manual']).optional() }).passthrough();
const ForwardQuery = z.object({ file: z.string().min(1).max(1024), line: z.coerce.number().int().min(1).max(10_000_000) });
const InverseQuery = z.object({
  page: z.coerce.number().int().min(1).max(100_000),
  x: z.coerce.number().finite().min(-100_000).max(100_000),
  y: z.coerce.number().finite().min(-100_000).max(100_000),
});

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw new HttpError(400, `invalid ${what}: ${r.error.issues.map((i) => `${i.path.join('.') || what}: ${i.message}`).join('; ')}`);
  return r.data;
}

/** Client file paths are texRoot-relative; refuse absolute paths and any `..` segment outright. */
function checkRelPath(file: string): string {
  const f = file.replace(/\\/g, '/');
  if (f.includes('\0') || f.startsWith('/') || /^[a-zA-Z]:/.test(f) || f.split('/').includes('..')) throw new HttpError(400, 'file must be a path relative to the LaTeX tree');
  return f.replace(/^\.\//, '');
}

export function registerBuildRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.post(ROUTES.compile, async (req) => {
    const body = parse(CompileBody, req.body, 'request body');
    return ctx.build.compile(body.reason ?? 'manual');
  });

  app.get(ROUTES.pdf, async (_req, reply) => {
    const path = ctx.build.pdfPath();
    if (!path) throw new HttpError(404, 'no PDF yet: compile first');
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      throw new HttpError(404, 'no PDF yet: compile first');
    }
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', 'inline; filename="paper.pdf"')
      .header('Content-Length', String(size))
      .type('application/pdf');
    return reply.send(createReadStream(path));
  });

  app.get(ROUTES.synctexForward, async (req) => {
    const q = parse(ForwardQuery, req.query, 'query');
    const box = await ctx.build.forward(checkRelPath(q.file), q.line);
    return box ?? null;
  });

  app.get(ROUTES.synctexInverse, async (req) => {
    const q = parse(InverseQuery, req.query, 'query');
    const hit = await ctx.build.inverse(q.page, q.x, q.y);
    return hit ?? null;
  });
}
