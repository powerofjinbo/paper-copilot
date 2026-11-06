import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LitRecord, ROUTES } from '@paper-copilot/core';
import type { LitService } from '../src/contracts';
import { registerLitRoutes } from '../src/routes/lit';
import type { FetchLike } from '../src/services/lit/inspire';
import { createLitService, type LitServiceImpl } from '../src/services/lit/litService';
import { makeTempProject, makeTestCtx, waitForJob, type TempProject } from './helpers/ctx';

const WANG = {
  id: '2061419',
  metadata: {
    control_number: 2061419,
    texkeys: ['Wang:2022oer'],
    titles: [{ title: 'Reconstruction of Large Radius Tracks with the Exa.TrkX pipeline' }],
    authors: [{ full_name: 'Wang, Chun-Yi' }],
    arxiv_eprints: [{ value: '2203.08800' }],
    dois: [{ value: '10.1088/1742-6596/2438/1/012117' }],
  },
};

const fetchStub: FetchLike = async (u) => {
  const url = new URL(u);
  const q = url.searchParams.get('q') ?? '';
  const hits = url.hostname === 'inspirehep.net' && q.includes('2203.08800') ? [WANG] : [];
  if (url.hostname !== 'inspirehep.net') return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ hits: { total: hits.length, hits } }) };
};

let project: TempProject;
let app: FastifyInstance;
let lit: LitServiceImpl;
let ctx: ReturnType<typeof makeTestCtx>;

beforeEach(async () => {
  project = await makeTempProject();
  ctx = makeTestCtx(project);
  lit = createLitService(ctx, { fetch: fetchStub, sleep: async () => undefined });
  (ctx as { lit: LitService }).lit = lit;
  app = Fastify();
  registerLitRoutes(app, ctx);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await lit.flush();
  project.cleanup();
});

describe('literature routes', () => {
  it('GET /api/lit lists LitRecords', async () => {
    const res = await app.inject({ method: 'GET', url: ROUTES.lit });
    expect(res.statusCode).toBe(200);
    const recs = res.json<unknown[]>().map((r) => LitRecord.parse(r));
    expect(recs.map((r) => [r.key, r.status])).toEqual([
      ['Wang2022LRT', 'unresolved'],
      ['Ju2022Zenodo', 'unresolved'],
    ]);
  });

  it('POST /api/lit/resolve starts a resolve-lit job that resolves keys', async () => {
    const res = await app.inject({ method: 'POST', url: ROUTES.litResolve, payload: {} });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json<{ jobId: string }>();
    expect(ctx.jobs.get(jobId)?.kind).toBe('resolve-lit');
    const result = (await waitForJob(ctx, jobId)) as { resolved: number; unresolved: string[] };
    expect(result).toMatchObject({ total: 2, resolved: 1, userConfirmed: 0, unresolved: ['Ju2022Zenodo'] });
    expect(ctx.events.some((e) => e.type === 'job.progress' && e.jobId === jobId && e.state === 'done')).toBe(true);
    const one = await app.inject({ method: 'GET', url: `${ROUTES.lit}/Wang2022LRT` });
    expect(one.json()).toMatchObject({ status: 'resolved', texkey: 'Wang:2022oer' });
    expect((await app.inject({ method: 'POST', url: ROUTES.litResolve, payload: { keys: ['Nope'] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: ROUTES.litResolve, payload: { force: 'yes' } })).statusCode).toBe(400);
  });

  it('confirm, reload and 404s', async () => {
    const c = await app.inject({ method: 'POST', url: `${ROUTES.lit}/Ju2022Zenodo/confirm`, payload: {} });
    expect(c.statusCode).toBe(200);
    expect(c.json()).toMatchObject({ key: 'Ju2022Zenodo', status: 'user_confirmed' });
    expect(lit.allowedKeys().map((k) => k.key)).toEqual(['Ju2022Zenodo']);
    const un = await app.inject({ method: 'POST', url: `${ROUTES.lit}/Ju2022Zenodo/confirm`, payload: { confirmed: false } });
    expect(un.json()).toMatchObject({ status: 'unresolved' });
    expect((await app.inject({ method: 'POST', url: `${ROUTES.lit}/Nope/confirm`, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `${ROUTES.lit}/Nope` })).statusCode).toBe(404);
    const r = await app.inject({ method: 'POST', url: `${ROUTES.lit}/reload` });
    expect(r.json()).toEqual({ keys: 2, errors: [] });
  });
});
