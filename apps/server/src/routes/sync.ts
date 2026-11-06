/**
 * Overleaf sync routes:
 *   GET  /api/sync/status       { mode, remote, branch, ahead, behind, dirty }
 *   POST /api/sync/pull         ReanchorReport[] (409 on conflict: the tree is restored)
 *   GET  /api/sync/push-check   PushCheck { ok, blockers, diff, files }
 *   POST /api/sync/push         PushRequest { message } -> { ok, output, check } (ok false = refused)
 */
import type { FastifyInstance } from 'fastify';
import { PushRequest, ROUTES } from '@paper-copilot/core';
import type { Ctx } from '../contracts';
import { parseWith } from './project';

export function registerSyncRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/sync/status', async () => ctx.sync.status());
  app.post(ROUTES.syncPull, async () => ctx.sync.pull());
  app.get(ROUTES.syncPushCheck, async () => ctx.sync.pushCheck());
  app.post(ROUTES.syncPush, async (req) => {
    const { message } = parseWith(PushRequest, req.body);
    return ctx.sync.push(message);
  });
}
