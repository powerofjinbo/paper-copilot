/**
 * Every path in core's ROUTES table (the wire contract shared with the web client) is registered on the
 * real server, with the HTTP method the web client (apps/web/src/api/client.ts) uses for it. /ws is the
 * WebSocket upgrade and is checked separately.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTES } from '@paper-copilot/core';
import { createCtx, type AppCtx } from '../src/ctx';
import { createServer, ROUTE_MODULES, SESSION_ROUTE, type PaperServer } from '../src/server';
import { initProject } from '../src/project/init';
import { makeTempProject, SKILL_DIR, type TempProject } from './helpers/ctx';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type RouteKey = Exclude<keyof typeof ROUTES, 'ws'>;

/** The methods each ROUTES entry must answer (from the web client's calls and the design). */
const EXPECTED: Record<RouteKey, Method[]> = {
  project: ['GET'],
  doc: ['GET'],
  facts: ['GET'],
  fact: ['PATCH'],
  factsRescan: ['POST'],
  factsManual: ['POST'],
  claims: ['GET'],
  figures: ['GET'],
  terminology: ['GET'],
  lit: ['GET'],
  litResolve: ['POST'],
  outline: ['GET', 'PUT'],
  sentenceHistory: ['GET'],
  sentenceInstruct: ['POST'],
  sentenceAlternatives: ['POST'],
  sentenceGrammar: ['POST'],
  sentenceAccept: ['POST'],
  sentenceReject: ['POST'],
  intentRender: ['POST'],
  agentsReadRepo: ['POST'],
  agentsFramings: ['POST'],
  agentsDraft: ['POST'],
  agentsReferee: ['POST'],
  compile: ['POST'],
  pdf: ['GET'],
  synctexForward: ['GET'],
  synctexInverse: ['GET'],
  syncPull: ['POST'],
  syncPushCheck: ['GET'],
  syncPush: ['POST'],
  disclosure: ['GET'],
  styleDistance: ['GET'],
  voice: ['GET'],
  voiceMemo: ['PUT'],
  voiceCorpus: ['POST'],
  cost: ['GET'],
  questions: ['GET'],
  lintDismiss: ['POST'],
};

/** Server routes outside ROUTES that the web client calls directly. */
const EXTRA: Array<[Method, string]> = [
  ['GET', SESSION_ROUTE],
  ['PATCH', `${ROUTES.voiceCorpus}/:id`],
  ['GET', '/api/panels'],
  ['GET', '/api/jobs/:id'],
  ['GET', '/api/lint'],
];

describe('route table coverage', () => {
  let project: TempProject;
  let ctx: AppCtx;
  let server: PaperServer;

  beforeAll(async () => {
    project = await makeTempProject();
    await initProject(project.root, { repo: project.repoDir, skill: SKILL_DIR });
    ctx = await createCtx({ root: project.root, fake: true, logLevel: 'error', watch: false, lintSidecar: false });
    server = await createServer({ ctx, port: 0, pingIntervalMs: 60_000 });
  });

  afterAll(async () => {
    await server?.close();
    await ctx?.close();
    project?.cleanup();
  });

  it('the expectation table names every ROUTES entry except /ws', () => {
    const keys = Object.keys(ROUTES).filter((k) => k !== 'ws').sort();
    expect(Object.keys(EXPECTED).sort()).toEqual(keys);
  });

  it.each(Object.entries(EXPECTED) as Array<[RouteKey, Method[]]>)('%s is registered', (key, methods) => {
    const url = ROUTES[key].split('?')[0]!;
    for (const method of methods) {
      expect(server.app.hasRoute({ method, url }), `${method} ${url}`).toBe(true);
    }
  });

  it('/ws is a GET (WebSocket upgrade) route', () => {
    expect(server.app.hasRoute({ method: 'GET', url: ROUTES.ws })).toBe(true);
  });

  it.each(EXTRA)('extra route %s %s is registered', (method, url) => {
    expect(server.app.hasRoute({ method, url })).toBe(true);
  });

  it('every route module is listed once', () => {
    const names = ROUTE_MODULES.map(([n]) => n);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(['project', 'doc', 'outline', 'sentences', 'sync', 'disclosure', 'facts', 'panels', 'lit', 'llm', 'agents', 'build', 'voice']));
  });
});
