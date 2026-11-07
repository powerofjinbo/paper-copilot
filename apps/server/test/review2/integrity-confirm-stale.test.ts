/**
 * Review 2 (integrity): confirming the NEW value of a stale fact clears the blocker of the sentence that
 * still states the OLD value. canto-demo: the re-run changes fake_rate_A 0.548% -> 0.612%. The results
 * sentence "The fake-track rate is 0.55\% against 1.38\% ..." blocks (stale_facts, control). The author
 * opens the Facts panel and confirms the new value (PATCH /api/facts/:id {confirmed: true}, which the
 * route hands to facts.patch): factService clears `stale`, the echo check reports no stale fact, and the
 * sentence that still says 0.55% is left with a WARNING among "the authors' own unmatched numbers".
 * The submission check is then free of number blockers while the paper states a result the analysis no
 * longer gives. (For an AI-touched sentence ai_unmatched_numbers would block; for the author's own
 * sentence nothing does.)
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FEATURE_ROUTES, SubmissionReport } from '@paper-copilot/core';
import { createCtx, type AppCtx } from '../../src/ctx';
import { initProject } from '../../src/project/init';
import { registerReportsRoutes } from '../../src/routes/reports';
import { REPO_ROOT, SKILL_DIR } from '../helpers/ctx';

let root = '';
let ctx: AppCtx;
let app: FastifyInstance;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'paper-review2-confirm-'));
  cpSync(join(REPO_ROOT, 'fixtures', 'canto-demo', 'tex'), join(root, 'tex'), { recursive: true });
  cpSync(join(REPO_ROOT, 'fixtures', 'canto-demo', 'repo'), join(root, 'repo'), { recursive: true });
  await initProject(root, { repo: join(root, 'repo'), skill: SKILL_DIR });
  ctx = await createCtx({ root, fake: true, logLevel: 'error', watch: false, lintSidecar: false, docs: { segmentDebounceMs: 20, writeDebounceMs: 50 } });
  await ctx.start();
  await ctx.facts.rescan();
  app = Fastify();
  registerReportsRoutes(app, ctx);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await ctx?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

const report = async () => SubmissionReport.parse((await app.inject({ method: 'GET', url: `${FEATURE_ROUTES.submissionCheck}?venue=aps` })).json());

it('confirming the new value of a stale fact does not clear the blocker of a sentence that states the old value', async () => {
  await report(); // opens main.tex, links every sentence
  const sentence = () => ctx.docs.get('main.tex')!.units.find((u) => (ctx.docs.unitText(u.id) ?? '').startsWith('The fake-track rate is 0.55'))!;
  expect(sentence().facts).toContain('f.g1.fake_rate_A');
  for (const f of ['results/addendum_g_g1_v1_claim.json', 'results/addendum_g_g1_v1.csv']) {
    const p = join(root, 'repo', f);
    const s = readFileSync(p, 'utf8');
    if (s.includes('0.0054838384739537')) writeFileSync(p, s.split('0.0054838384739537').join('0.0061234567890123'));
  }
  expect((await ctx.facts.rescan()).stale).toContain('f.g1.fake_rate_A');
  const id = sentence().id;
  const blocks = (r: SubmissionReport) => r.items.filter((i) => i.severity === 'block' && !i.ok && i.items.some((e) => e.sentenceId === id)).map((i) => i.id);
  expect(blocks(await report())).toContain('stale_facts'); // control

  ctx.facts.patch('f.g1.fake_rate_A', { confirmed: true }); // "yes, 0.612% is the new result"
  const r = await report();
  expect(ctx.docs.unitText(id)).toContain('0.55\\%');
  // today: [] (the sentence is only listed under unmatched_numbers, severity warn)
  expect(blocks(r)).not.toEqual([]);
});
