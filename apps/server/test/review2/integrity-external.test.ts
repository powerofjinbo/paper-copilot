/**
 * Review 2 (integrity): an unreviewed AI sentence stops being a blocker as soon as its text is touched
 * OUTSIDE the app. design.md: "Push ... is refused while `proposed` or `unsupported` sentences ... exist".
 * core anchor/assign.ts maps ANY external edit of a unit to state 'external' (`if (external || ...)
 * next.state = 'external'`), whatever the unit's review state was. 'external' is not in
 * UNREVIEWED_STATES, so the push guard and the submission check no longer see the draft: the author
 * fixing one typo in their other editor (VS Code, Overleaf sync, a `git pull` that touched the line)
 * clears the review of a sentence nobody has read, and its text reaches co-authors on the next push.
 * A later in-app edit then turns the 'external' unit into 'ai-edited' (an accepted state).
 * Real services (createCtx, sync mode none, doc service reloadFromDisk('external') as the tex watcher
 * calls it; 'pull' as the sync service calls it).
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { ChangeSet } from '@codemirror/state';
import { afterEach, describe, expect, it } from 'vitest';
import { ClientMessage, FEATURE_ROUTES, SubmissionReport, type ChangeAnnotation } from '@paper-copilot/core';
import { createCtx, type AppCtx } from '../../src/ctx';
import { initProject } from '../../src/project/init';
import { registerReportsRoutes } from '../../src/routes/reports';
import { REPO_ROOT, SKILL_DIR } from '../helpers/ctx';

let root = '';
let ctx: AppCtx | null = null;
let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  await ctx?.close();
  app = null;
  ctx = null;
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

const DRAFT = 'The model wrote this sentence about the tracker and nobody has read it yet.';
const DRAFT_EDITED = 'The model wrote this sentence about the tracker and no one has read it yet.';

async function setup(state: 'proposed' | 'unsupported'): Promise<string> {
  root = mkdtempSync(join(tmpdir(), 'paper-review2-ext-'));
  cpSync(join(REPO_ROOT, 'fixtures', 'canto-demo', 'tex'), join(root, 'tex'), { recursive: true });
  cpSync(join(REPO_ROOT, 'fixtures', 'canto-demo', 'repo'), join(root, 'repo'), { recursive: true });
  await initProject(root, { repo: join(root, 'repo'), skill: SKILL_DIR });
  ctx = await createCtx({ root, fake: true, logLevel: 'error', watch: false, lintSidecar: false, docs: { segmentDebounceMs: 20, writeDebounceMs: 50 } });
  await ctx.start();
  await ctx.facts.rescan();
  app = Fastify();
  registerReportsRoutes(app, ctx);
  await app.ready();
  await ctx.docs.open('main.tex');
  const st = ctx.docs.get('main.tex')!;
  const u = st.units.find((x) => x.kind === 'prose' && x.state === 'human' && !/[\d\\$]/.test(ctx!.docs.unitText(x.id) ?? '1') && (ctx!.docs.unitText(x.id) ?? '').split(' ').length > 6)!;
  const annotation: ChangeAnnotation = { origin: 'ai_draft', sentenceIds: [u.id], state, model: 'claude-opus-5-5', promptHash: 'ph', instruction: null, lang: 'en', intentNote: null, factIds: [], citeKeys: [], move: null, requestId: null };
  const msg = ClientMessage.parse(JSON.parse(JSON.stringify({ type: 'doc.change', file: 'main.tex', baseVersion: st.version, changes: ChangeSet.of([{ from: u.start, to: u.end, insert: DRAFT }], st.text.length).toJSON(), annotation })));
  expect(await ctx.docs.applyClientChange(msg as Extract<ClientMessage, { type: 'doc.change' }>)).toBe(true);
  await ctx.docs.flush('main.tex');
  expect(ctx.docs.unit(u.id)).toMatchObject({ state, everAi: true });
  return u.id;
}

async function blockers(id: string): Promise<{ push: boolean; submission: boolean; state: string }> {
  const check = await ctx!.sync.pushCheck();
  const rep = SubmissionReport.parse((await app!.inject({ method: 'GET', url: `${FEATURE_ROUTES.submissionCheck}?venue=aps` })).json());
  const sub = rep.items.some((i) => i.severity === 'block' && !i.ok && (i.id === 'unreviewed' || i.id === 'unsupported') && i.items.some((e) => e.sentenceId === id));
  return { push: check.blockers.some((b) => b.sentenceId === id), submission: sub, state: ctx!.docs.unit(id)!.state };
}

function editOnDisk(): void {
  const p = join(root, 'tex', 'main.tex');
  const s = readFileSync(p, 'utf8');
  expect(s).toContain(DRAFT);
  writeFileSync(p, s.replace(DRAFT, DRAFT_EDITED));
}

describe('an unreviewed AI sentence edited outside the app stays unreviewed', () => {
  it.each(['proposed', 'unsupported'] as const)('a one-word fix on disk (another editor) of a %s draft', async (state) => {
    const id = await setup(state);
    expect(await blockers(id)).toEqual({ push: true, submission: true, state }); // control
    editOnDisk();
    await ctx!.docs.reloadFromDisk('main.tex', 'external');
    expect(ctx!.docs.unitText(id)).toBe(DRAFT_EDITED);
    // today: { push: false, submission: false, state: 'external' }
    expect(await blockers(id)).toEqual({ push: true, submission: true, state });
  });

  it('the same edit arriving through a pull (re-anchor with source "pull")', async () => {
    const id = await setup('proposed');
    editOnDisk();
    await ctx!.docs.reloadFromDisk('main.tex', 'pull');
    expect(ctx!.docs.unitText(id)).toBe(DRAFT_EDITED);
    expect(await blockers(id)).toEqual({ push: true, submission: true, state: 'proposed' });
  });
});
