/**
 * Review 2 (integrity): a number the AI invents, or a result it reverses, reaches the manuscript as
 * grounded AI text through the derived relations, end to end through the REAL services: the instruct
 * gate (scripted simulated model), the doc service (accepted as 'ai-drafted') and the submission check
 * (ai_unmatched_numbers stays ok). canto-demo: fake_rate_A (Canto-L) = 0.548%, fake_rate_B (acorn) = 1.377%.
 */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { ChangeSet } from '@codemirror/state';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClientMessage, FEATURE_ROUTES, SubmissionReport, type ChangeAnnotation, type Proposal } from '@paper-copilot/core';
import { createCtx, type AppCtx } from '../../src/ctx';
import { initProject } from '../../src/project/init';
import { registerReportsRoutes } from '../../src/routes/reports';
import { createLlmService } from '../../src/services/llm/llmService';
import { createFakeLlmClient } from '../../src/services/llm/fake';
import { REPO_ROOT, SKILL_DIR } from '../helpers/ctx';

let root = '';
let ctx: AppCtx;
let app: FastifyInstance;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'paper-review2-derived-'));
  cpSync(join(REPO_ROOT, 'fixtures', 'canto-demo', 'tex'), join(root, 'tex'), { recursive: true });
  cpSync(join(REPO_ROOT, 'fixtures', 'canto-demo', 'repo'), join(root, 'repo'), { recursive: true });
  await initProject(root, { repo: join(root, 'repo'), skill: SKILL_DIR });
  ctx = await createCtx({ root, fake: true, logLevel: 'error', watch: false, lintSidecar: false, docs: { segmentDebounceMs: 20, writeDebounceMs: 50 } });
  await ctx.start();
  await ctx.facts.rescan();
  app = Fastify();
  registerReportsRoutes(app, ctx);
  await app.ready();
  await app.inject({ method: 'GET', url: FEATURE_ROUTES.submissionCheck }); // opens main.tex
}, 60_000);

afterAll(async () => {
  await app?.close();
  await ctx?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

async function instructWith(modelText: string): Promise<{ id: string; p: Proposal }> {
  const client = createFakeLlmClient({
    respond: (req) => (req.task === 'instruct' ? { json: { text: modelText, notes: 'simulated', drift: { actor: false, scope: false, direction: false, condition: false }, fact_ids: [], cite_keys: [] } } : undefined),
  });
  const llm = createLlmService(ctx, { client });
  try {
    const target = ctx.docs.allUnits().find((u) => u.kind === 'prose' && u.state === 'human' && !/[\d\\$]/.test(ctx.docs.unitText(u.id) ?? '1'))!;
    return { id: target.id, p: await llm.instruct(target.id, 'add the result', 'en') };
  } finally {
    await llm.close?.();
  }
}

/** Accept the proposal as the sentence card does (Card.tsx: state 'ai-drafted'). */
async function accept(id: string, p: Proposal): Promise<void> {
  const u = ctx.docs.unit(id)!;
  const st = ctx.docs.get(u.file)!;
  const annotation: ChangeAnnotation = { origin: p.origin, sentenceIds: [id], state: 'ai-drafted', model: p.model, promptHash: p.promptHash, instruction: 'add the result', lang: 'en', intentNote: null, factIds: p.factIds, citeKeys: p.citeKeys, move: null, requestId: null };
  const msg = ClientMessage.parse(JSON.parse(JSON.stringify({ type: 'doc.change', file: u.file, baseVersion: st.version, changes: ChangeSet.of([{ from: u.start, to: u.end, insert: p.text }], st.text.length).toJSON(), annotation })));
  expect(await ctx.docs.applyClientChange(msg as Extract<ClientMessage, { type: 'doc.change' }>)).toBe(true);
  await ctx.docs.flush(u.file);
}

describe('derived relations through the real services', () => {
  it.each([
    ['an invented absolute efficiency (= the fake-rate relative change)', 'The tracking efficiency of Canto-L reaches 60 percent on these particles.'],
    ['a reversed result (acorn has the HIGHER fake-track rate)', 'The fake-track rate of acorn is 60 percent lower than that of Canto-L.'],
    ['an invented pileup loss (= the difference of two unrelated ceilings)', 'With pileup, the efficiency of Canto-L drops by 4.7 points.'],
  ])('%s is blocked by the instruct gate and blocks the submission once accepted', async (_what, modelText) => {
    const { id, p } = await instructWith(modelText);
    const blocked = p.issues.some((i) => i.severity === 'block') || p.text !== modelText;
    await accept(id, p);
    const rep = SubmissionReport.parse((await app.inject({ method: 'GET', url: FEATURE_ROUTES.submissionCheck })).json());
    const ai = rep.items.find((i) => i.id === 'ai_unmatched_numbers')!;
    // today: { blocked: false, factIds: [two unrelated facts], submissionFlags: false }
    expect({ blocked, submissionFlags: ai.items.some((e) => e.sentenceId === id) }).toEqual({ blocked: true, submissionFlags: true });
  });
});
