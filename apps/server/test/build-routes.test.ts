import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROUTES } from '@paper-copilot/core';
import { HttpError, type BuildService, type CompileStatus, type Ctx } from '../src/contracts';
import { registerBuildRoutes } from '../src/routes/build';
import { makeTempProject, makeTestCtx, type TempProject } from './helpers/ctx';

let project: TempProject;
let app: FastifyInstance;
let calls: unknown[][];
let pdf: string | null;

const OK: CompileStatus = { state: 'ok', pdfVersion: 3, errors: [], logTail: 'done', durationMs: 10 };

function stubBuild(): BuildService {
  return {
    available: () => ({ latexmk: true, synctex: true }),
    compile: async (reason) => (calls.push(['compile', reason]), OK),
    scheduleCompile: () => undefined,
    status: () => OK,
    pdfPath: () => pdf,
    forward: async (file, line) => (calls.push(['forward', file, line]), line === 99 ? null : { page: 1, x: 10, y: 20, w: 30, h: 8 }),
    inverse: async (page, x, y) => (calls.push(['inverse', page, x, y]), page === 9 ? null : { file: 'main.tex', line: 49 }),
  };
}

async function build(ctx: Ctx) {
  const a = Fastify();
  a.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: 'internal' });
  });
  registerBuildRoutes(a, ctx);
  await a.ready();
  return a;
}

beforeEach(async () => {
  calls = [];
  pdf = null;
  project = await makeTempProject();
  app = await build(makeTestCtx(project, { build: stubBuild() }));
});
afterEach(async () => {
  await app?.close();
  project.cleanup();
});

describe('build routes', () => {
  it('POST /api/compile returns the status and defaults to a manual compile', async () => {
    const r = await app.inject({ method: 'POST', url: ROUTES.compile, payload: {} });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(OK);
    const s = await app.inject({ method: 'POST', url: ROUTES.compile, payload: { reason: 'save' } });
    expect(s.statusCode).toBe(200);
    expect(calls).toEqual([['compile', 'manual'], ['compile', 'save']]);
    expect((await app.inject({ method: 'POST', url: ROUTES.compile, payload: { reason: 'bogus' } })).statusCode).toBe(400);
  });

  it('GET /api/pdf streams the PDF with no-store, 404 before the first compile', async () => {
    expect((await app.inject({ method: 'GET', url: `${ROUTES.pdf}?v=1&token=t` })).statusCode).toBe(404);
    pdf = join(project.root, 'x.pdf');
    writeFileSync(pdf, '%PDF-1.5\nfake\n%%EOF\n');
    const r = await app.inject({ method: 'GET', url: `${ROUTES.pdf}?v=1&token=t` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toBe('%PDF-1.5\nfake\n%%EOF\n');
  });

  it('GET /api/synctex/forward validates and returns the box or null', async () => {
    const r = await app.inject({ method: 'GET', url: `${ROUTES.synctexForward}?file=main.tex&line=49` });
    expect(r.json()).toEqual({ page: 1, x: 10, y: 20, w: 30, h: 8 });
    const none = await app.inject({ method: 'GET', url: `${ROUTES.synctexForward}?file=main.tex&line=99` });
    expect(none.statusCode).toBe(200);
    expect(none.json()).toBeNull();
    for (const q of ['file=main.tex', 'line=3', 'file=../x.tex&line=3', 'file=/etc/passwd&line=3', 'file=a/../../b.tex&line=1', 'file=main.tex&line=-2', 'file=main.tex&line=abc']) {
      expect((await app.inject({ method: 'GET', url: `${ROUTES.synctexForward}?${q}` })).statusCode, q).toBe(400);
    }
    expect(calls.filter((c) => c[0] === 'forward')).toEqual([['forward', 'main.tex', 49], ['forward', 'main.tex', 99]]);
  });

  it('GET /api/synctex/inverse validates numbers', async () => {
    const r = await app.inject({ method: 'GET', url: `${ROUTES.synctexInverse}?page=1&x=100.5&y=200` });
    expect(r.json()).toEqual({ file: 'main.tex', line: 49 });
    expect((await app.inject({ method: 'GET', url: `${ROUTES.synctexInverse}?page=9&x=1&y=2` })).json()).toBeNull();
    expect((await app.inject({ method: 'GET', url: `${ROUTES.synctexInverse}?page=0&x=1&y=2` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `${ROUTES.synctexInverse}?page=1&x=NaN&y=2` })).statusCode).toBe(400);
    expect(calls).toContainEqual(['inverse', 1, 100.5, 200]);
  });
});
