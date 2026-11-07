/**
 * GET /api/facts on a multi-file paper (fixtures/large-multifile): the unresolved numerals cover every
 * typeset file with their file, line and text, whether or not the editor opened the file, so the list
 * and the rail's ② count do not change when the author visits another file.
 */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FactsResponse, ROUTES } from '@paper-copilot/core';
import { createCtx, type AppCtx } from '../src/ctx';
import { initProject } from '../src/project/init';
import { registerFactsRoutes } from '../src/routes/facts';
import { REPO_ROOT, SKILL_DIR } from './helpers/ctx';

describe('unresolved numerals of a multi-file paper', () => {
  let root: string;
  let ctx: AppCtx;
  let app: FastifyInstance;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'paper-test-unresolved-'));
    cpSync(join(REPO_ROOT, 'fixtures', 'large-multifile', 'tex'), join(root, 'tex'), { recursive: true });
    cpSync(join(REPO_ROOT, 'fixtures', 'large-multifile', 'repo'), join(root, 'repo'), { recursive: true });
    await initProject(root, { repo: join(root, 'repo'), skill: SKILL_DIR });
    ctx = await createCtx({ root, fake: true, logLevel: 'error', watch: false, lintSidecar: false, docs: { segmentDebounceMs: 20, writeDebounceMs: 50 } });
    await ctx.start();
    app = Fastify();
    registerFactsRoutes(app, ctx);
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await ctx?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('covers every typeset file (file, line, text) before any file is opened, and stays the same after', async () => {
    expect(ctx.docs.get('sections/results.tex')).toBeFalsy();
    const first = FactsResponse.parse((await app.inject({ method: 'GET', url: ROUTES.facts })).json());
    const files = new Set(first.unresolved.map((u) => u.file));
    expect(files.size).toBeGreaterThan(1);
    expect([...files].every((f) => f === 'main.tex' || f?.startsWith('sections/'))).toBe(true);
    for (const u of first.unresolved) {
      expect(typeof u.line).toBe('number');
      const unit = ctx.docs.get(u.file!)!.units.find((x) => x.id === u.sentenceId)!;
      expect(unit.line).toBe(u.line);
      expect(u.text).toBe(ctx.docs.unitText(u.sentenceId));
      expect(u.text).toContain(u.raw.replace(/\\,/g, ''));
    }
    // every typeset file is open now; a second call lists the same numerals
    expect(ctx.docs.get('sections/appendix.tex')).toBeTruthy();
    const again = FactsResponse.parse((await app.inject({ method: 'GET', url: ROUTES.facts })).json());
    expect(again.unresolved).toEqual(first.unresolved);
  });
});
