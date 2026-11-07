/**
 * Review 2 (integrity): the submission check's compile item reports the LAST compile, not the current
 * text. A co-author edit (Dropbox/Overleaf sync, a second editor) that lands on disk in an \input file
 * nobody has open is ignored by the tex watcher (docs/watcher.ts: "the next open re-anchors"), so no
 * compile is scheduled; the submission check then opens the file, reports its text, and still says
 * "compile: ok" from before the edit. Real services, real latexmk, large-multifile fixture.
 */
import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, expect, it } from 'vitest';
import { FEATURE_ROUTES, SubmissionReport } from '@paper-copilot/core';
import { createCtx, type AppCtx } from '../../src/ctx';
import { initProject } from '../../src/project/init';
import { registerReportsRoutes } from '../../src/routes/reports';
import { REPO_ROOT, SKILL_DIR } from '../helpers/ctx';

let root = '';
let ctx: AppCtx | null = null;
let app: FastifyInstance | null = null;

afterAll(async () => {
  await app?.close();
  await ctx?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

it('a compile error introduced on disk in an unopened \\input file is not reported as "compiled ok"', async () => {
  root = mkdtempSync(join(tmpdir(), 'paper-review2-compile-'));
  cpSync(join(REPO_ROOT, 'fixtures', 'large-multifile', 'tex'), join(root, 'tex'), { recursive: true });
  cpSync(join(REPO_ROOT, 'fixtures', 'large-multifile', 'repo'), join(root, 'repo'), { recursive: true });
  await initProject(root, { repo: join(root, 'repo'), skill: SKILL_DIR });
  ctx = await createCtx({ root, fake: true, logLevel: 'error', watch: true, lintSidecar: false, docs: { segmentDebounceMs: 20, writeDebounceMs: 50 } });
  await ctx.start();
  await ctx.facts.rescan();
  app = Fastify();
  registerReportsRoutes(app, ctx);
  await app.ready();
  const first = await ctx.build.compile('manual');
  expect(first.state).toBe('ok');
  expect(ctx.docs.get('sections/method.tex')).toBeFalsy();

  // the co-author's edit lands on disk: an undefined macro in the method section
  appendFileSync(join(root, 'tex', 'sections', 'method.tex'), '\nThe resolution is \\resolutionvalue{} in every layer.\n');
  await new Promise((r) => setTimeout(r, 4500)); // watcher stability + the 2 s compile debounce, had one been scheduled

  const res = await app.inject({ method: 'GET', url: `${FEATURE_ROUTES.submissionCheck}?venue=arxiv` });
  const rep = SubmissionReport.parse(res.json());
  const reported = rep.items.find((i) => i.id === 'compile_errors')!;
  expect(ctx.docs.unitText(ctx.docs.get('sections/method.tex')!.units.find((u) => (ctx!.docs.unitText(u.id) ?? '').includes('resolutionvalue'))!.id)).toContain('resolutionvalue');
  const now = await ctx.build.compile('manual');
  // today: { reportedOk: true, compileNow: 'error' }
  expect({ reportedOk: reported.ok, compileNow: now.state }).toEqual({ reportedOk: false, compileNow: 'error' });
}, 120_000);

it('without a watcher-scheduled compile, the check still says the last compile predates the current text', async () => {
  await app?.close();
  await ctx?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  root = mkdtempSync(join(tmpdir(), 'paper-review2-compile-'));
  cpSync(join(REPO_ROOT, 'fixtures', 'large-multifile', 'tex'), join(root, 'tex'), { recursive: true });
  cpSync(join(REPO_ROOT, 'fixtures', 'large-multifile', 'repo'), join(root, 'repo'), { recursive: true });
  await initProject(root, { repo: join(root, 'repo'), skill: SKILL_DIR });
  ctx = await createCtx({ root, fake: true, logLevel: 'error', watch: false, lintSidecar: false, docs: { segmentDebounceMs: 20, writeDebounceMs: 50 } });
  await ctx.start();
  app = Fastify();
  registerReportsRoutes(app, ctx);
  await app.ready();
  expect((await ctx.build.compile('manual')).state).toBe('ok');
  const check = async () => SubmissionReport.parse((await app!.inject({ method: 'GET', url: `${FEATURE_ROUTES.submissionCheck}?venue=arxiv` })).json()).items.find((i) => i.id === 'compile_errors')!;
  expect(ctx.docs.get('sections/method.tex')).toBeFalsy();
  appendFileSync(join(root, 'tex', 'sections', 'method.tex'), '\nA sentence a co-author added.\n');
  const stale = await check();
  expect(stale.ok).toBe(false);
  expect(stale.items.map((e) => e.text).join(' ')).toContain('sections/method.tex');
  // compiling the current text clears it
  expect((await ctx.build.compile('manual')).state).toBe('ok');
  expect((await check()).ok).toBe(true);
}, 120_000);
