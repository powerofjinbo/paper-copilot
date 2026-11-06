/**
 * Lint routes:
 *   GET  /api/lint?file=            { flags } the full current list for a file
 *   POST /api/lint/:id/dismiss      { ok, known } marks a flag dismissed (persisted, survives re-lint);
 *                                   a lint.update with the full list follows on the WebSocket
 */
import type { FastifyInstance } from 'fastify';
import { ROUTES } from '@paper-copilot/core';
import { HttpError, type Ctx } from '../contracts';

const FLAG_ID = /^[A-Za-z0-9:._-]{1,200}$/;

export function registerLintRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/lint', async (req) => {
    const file = (req.query as { file?: unknown }).file;
    if (typeof file !== 'string' || !file) throw new HttpError(400, 'file is required');
    if (!ctx.docs.get(file)) throw new HttpError(404, `${file} is not open`);
    return { flags: ctx.lint.flags(file) };
  });
  app.post(ROUTES.lintDismiss, async (req) => {
    const id = (req.params as { id?: unknown }).id;
    if (typeof id !== 'string' || !FLAG_ID.test(id)) throw new HttpError(400, 'invalid flag id');
    return { ok: true, known: ctx.lint.dismiss(id) };
  });
}
