import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROUTES, type RefereeQuestion } from '@paper-copilot/core';
import { HttpError, type AgentService, type Ctx } from '../src/contracts';
import { registerAgentRoutes, registerAgentsRoutes } from '../src/routes/agents';
import { createAgentService } from '../src/services/agents/service';
import { makeTempProject, makeTestCtx, waitForJob, type TempProject } from './helpers/ctx';

let project: TempProject;
let app: FastifyInstance;
let calls: Array<[string, unknown]>;

const Q: RefereeQuestion = { id: 'q1', sectionId: 'sec:results', sentenceId: null, question: 'Which baseline?', estimate: null };

function stubAgents(): AgentService {
  return {
    readRepo: () => (calls.push(['readRepo', null]), 'job-r'),
    framings: () => {
      throw new HttpError(409, 'fill in the five items first');
    },
    draft: (req) => (calls.push(['draft', req]), 'job-d'),
    referee: (id) => (calls.push(['referee', id]), 'job-q'),
    updateMemo: () => 'job-m',
    questions: (id) => (calls.push(['questions', id]), id === 'sec:results' || id === undefined ? [Q] : []),
  };
}

async function build(ctx: Ctx) {
  const a = Fastify();
  // The hub maps HttpError to its status; reproduced here for the test.
  a.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: 'internal' });
  });
  registerAgentsRoutes(a, ctx);
  await a.ready();
  return a;
}

beforeEach(async () => {
  calls = [];
  project = await makeTempProject();
});

afterEach(async () => {
  await app?.close();
  project.cleanup();
});

describe('agent routes', () => {
  it('starts jobs and validates bodies with the core schemas', async () => {
    app = await build(makeTestCtx(project, { agents: stubAgents() }));
    expect((await app.inject({ method: 'POST', url: ROUTES.agentsReadRepo })).json()).toEqual({ jobId: 'job-r' });
    const body = { sectionId: 'sec:results', paragraphIds: null, fromNotes: true, file: 'main.tex', afterSentenceId: null };
    const d = await app.inject({ method: 'POST', url: ROUTES.agentsDraft, payload: body });
    expect(d.statusCode).toBe(200);
    expect(d.json()).toEqual({ jobId: 'job-d' });
    expect(calls).toContainEqual(['draft', body]);
    const bad = await app.inject({ method: 'POST', url: ROUTES.agentsDraft, payload: { sectionId: 3 } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/invalid request body/);
    expect((await app.inject({ method: 'POST', url: ROUTES.agentsReferee, payload: { sectionId: 'sec:results' } })).json()).toEqual({ jobId: 'job-q' });
    expect((await app.inject({ method: 'POST', url: ROUTES.agentsReferee, payload: {} })).statusCode).toBe(400);
    const f = await app.inject({ method: 'POST', url: ROUTES.agentsFramings });
    expect(f.statusCode).toBe(409);
    expect(f.json().error).toMatch(/five items/);
  });

  it('lists referee questions, optionally for one section', async () => {
    app = await build(makeTestCtx(project, { agents: stubAgents() }));
    expect((await app.inject({ method: 'GET', url: `${ROUTES.questions}?sectionId=sec:results` })).json()).toEqual([Q]);
    expect((await app.inject({ method: 'GET', url: `${ROUTES.questions}?sectionId=sec:other` })).json()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: ROUTES.questions })).json()).toEqual([Q]);
    expect(calls.filter((c) => c[0] === 'questions').map((c) => c[1])).toEqual(['sec:results', 'sec:other', undefined]);
    expect(registerAgentRoutes).toBe(registerAgentsRoutes);
  });

  it('works end to end with the fake-mode service', async () => {
    const ctx = makeTestCtx(project, {
      facts: { addCandidates: async () => ({ added: [], rejected: [] }), figures: () => [], terminology: () => [], saveFigures: async () => {}, saveTerminology: async () => {} } as unknown as Ctx['facts'],
    });
    ctx.agents = createAgentService(ctx);
    app = await build(ctx);
    const r = await app.inject({ method: 'POST', url: ROUTES.agentsReadRepo });
    const { jobId } = r.json() as { jobId: string };
    const result = (await waitForJob(ctx, jobId)) as { simulated: boolean };
    expect(result.simulated).toBe(true);
    // Framings before the author filled the outline: refused by the service with 409.
    expect((await app.inject({ method: 'POST', url: ROUTES.agentsFramings })).statusCode).toBe(409);
    // Unknown section: 404 from the service.
    const d = await app.inject({ method: 'POST', url: ROUTES.agentsDraft, payload: { sectionId: 'sec:x', paragraphIds: null, fromNotes: false, file: 'main.tex', afterSentenceId: null } });
    expect(d.statusCode).toBe(404);
  });
});
