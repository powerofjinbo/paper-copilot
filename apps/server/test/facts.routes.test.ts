import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FactsResponse, PanelsResponse, route, ROUTES, type Claim, type Fact } from '@paper-copilot/core';
import type { FactService, LitService } from '../src/contracts';
import { registerFactsRoutes } from '../src/routes/facts';
import { PANELS_ROUTE, registerPanelsRoutes } from '../src/routes/panels';
import { createFactService, type FactServiceImpl } from '../src/services/facts/factService';
import { createLitService } from '../src/services/lit/litService';
import { makeTempProject, makeTestCtx, type TempProject } from './helpers/ctx';

let project: TempProject;
let app: FastifyInstance;
let facts: FactServiceImpl;

beforeEach(async () => {
  project = await makeTempProject();
  const ctx = makeTestCtx(project);
  facts = createFactService(ctx);
  (ctx as { facts: FactService }).facts = facts;
  (ctx as { lit: LitService }).lit = createLitService(ctx, { fetch: async () => Promise.reject(new Error('offline')) });
  app = Fastify();
  registerFactsRoutes(app, ctx);
  registerPanelsRoutes(app, ctx);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await facts.flush();
  project.cleanup();
});

describe('fact routes', () => {
  it('GET /api/facts scans on first use and returns a valid FactsResponse', async () => {
    const res = await app.inject({ method: 'GET', url: ROUTES.facts });
    expect(res.statusCode).toBe(200);
    const body = FactsResponse.parse(res.json());
    expect(body.facts.length).toBeGreaterThan(100);
    expect(Number(res.headers['x-total-count'])).toBe(body.facts.length);
    expect(body.facts.find((f) => f.id === 'f.g1.delta_points')?.unit).toBe('points');
    expect(Array.isArray(body.unresolved)).toBe(true);
  });

  it('filters and pages', async () => {
    await facts.rescan();
    const cuts = FactsResponse.parse((await app.inject({ method: 'GET', url: `${ROUTES.facts}?kind=cut&unresolved=0` })).json());
    expect(cuts.facts.length).toBeGreaterThan(0);
    expect(cuts.facts.every((f) => f.kind === 'cut')).toBe(true);
    const q = await app.inject({ method: 'GET', url: `${ROUTES.facts}?q=delta_points&limit=1` });
    expect(FactsResponse.parse(q.json()).facts.map((f) => f.id)).toEqual(['f.g1.delta_points']);
    expect(Number(q.headers['x-total-count'])).toBe(1);
    const stale = FactsResponse.parse((await app.inject({ method: 'GET', url: `${ROUTES.facts}?stale=1` })).json());
    expect(stale.facts).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `${ROUTES.facts}?limit=-1` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `${ROUTES.facts}?stale=maybe` })).statusCode).toBe(400);
  });

  it('GET and PATCH one fact', async () => {
    await facts.rescan();
    const url = route(ROUTES.fact, { id: 'f.g1.eff_A' });
    expect((await app.inject({ method: 'GET', url })).json().value).toBe(0.9694221201683888);
    const patched = await app.inject({ method: 'PATCH', url, payload: { confirmed: true, tags: ['headline'] } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<Fact>()).toMatchObject({ id: 'f.g1.eff_A', confirmed: true, tags: ['headline'] });
    expect((await app.inject({ method: 'PATCH', url, payload: { confirmed: 'yes' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: route(ROUTES.fact, { id: 'f.nope' }), payload: { confirmed: true } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: route(ROUTES.fact, { id: 'f.nope' }) })).statusCode).toBe(404);
  });

  it('POST rescan and manual', async () => {
    const r = await app.inject({ method: 'POST', url: ROUTES.factsRescan });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ stale: [] });
    const manual = { id: 'f.manual.lumi', kind: 'setting', value: 139, unit: 'fb^-1', definition: 'Integrated luminosity', uncertainties: {} };
    const m = await app.inject({ method: 'POST', url: ROUTES.factsManual, payload: manual });
    expect(m.statusCode).toBe(201);
    expect(m.json<Fact>()).toMatchObject({ id: 'f.manual.lumi', confirmed: true });
    expect((await app.inject({ method: 'POST', url: ROUTES.factsManual, payload: { ...manual, id: 'f.g1.eff_A' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: ROUTES.factsManual, payload: { id: 'x' } })).statusCode).toBe(400);
  });
});

describe('panel routes', () => {
  it('GET/PUT claims, figures, terminology and GET /api/panels', async () => {
    expect((await app.inject({ method: 'GET', url: ROUTES.claims })).json()).toEqual([]);
    const claim: Claim = { claimId: 'G1', text: 't', evidence: ['f.g1.delta_points'], citations: [], qualification: 'within this simulation', status: 'supported', sentenceIds: [], section: null, move: null };
    const put = await app.inject({ method: 'PUT', url: ROUTES.claims, payload: [claim] });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual([claim]);
    expect((await app.inject({ method: 'PUT', url: ROUTES.claims, payload: [{ claimId: 'x' }] })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: ROUTES.claims, payload: { not: 'an array' } })).statusCode).toBe(400);
    const term = { term: 'double majority', definition: 'matching rule', acronym: 'DM', firstUseSentenceId: null, variants: [], symbol: null };
    expect((await app.inject({ method: 'PUT', url: ROUTES.terminology, payload: [term] })).json()).toEqual([term]);
    expect((await app.inject({ method: 'GET', url: ROUTES.figures })).json()).toEqual([]);
    const panels = PanelsResponse.parse((await app.inject({ method: 'GET', url: PANELS_ROUTE })).json());
    expect(panels.claims).toEqual([claim]);
    expect(panels.terminology).toEqual([term]);
    expect(panels.lit.map((r) => r.key)).toEqual(['Wang2022LRT', 'Ju2022Zenodo']);
  });
});
