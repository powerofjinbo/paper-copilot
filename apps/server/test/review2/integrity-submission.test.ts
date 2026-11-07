/**
 * Review 2 (integrity): can the submission check report a blocker as cleared while it is still in the
 * typeset paper? Driven through the REAL services (createCtx, simulated AI) and the real report route.
 *
 * 1. Stale facts: a re-run of the analysis changes eff_A (0.96942 -> 0.97121). The abstract still says
 *    "96.94\%". The check blocks (stale_facts) until the server restarts, or until the author touches the
 *    sentence: "retro-grounding" (linkAll on every open) and linkUnit re-link the sentence's numerals
 *    against the NEW values, the stale link is dropped, and nothing blocks the stale number any more.
 * 2. \import{dir}{file} (import package; \subimport likewise) is typeset by LaTeX but not followed by
 *    projectFileOrder, so the reports leave the file out: its placeholders are not blockers.
 * 3. Placeholders outside sentence units (a table cell, a \section title) are typeset but not reported.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { ChangeSet } from '@codemirror/state';
import { afterEach, describe, expect, it } from 'vitest';
import { ClientMessage, FEATURE_ROUTES, SubmissionReport } from '@paper-copilot/core';
import { createCtx, type AppCtx } from '../../src/ctx';
import { initProject } from '../../src/project/init';
import { registerReportsRoutes } from '../../src/routes/reports';
import { REPO_ROOT, SKILL_DIR } from '../helpers/ctx';

const EFF_A_OLD = '0.9694221201683888';
const EFF_A_NEW = '0.9712123456789012';
const FAKE_A_OLD = '0.0054838384739537';
const FAKE_A_NEW = '0.0061234567890123';

let root = '';
let ctx: AppCtx | null = null;
let app: FastifyInstance | null = null;

async function boot(): Promise<void> {
  ctx = await createCtx({ root, fake: true, logLevel: 'error', watch: false, lintSidecar: false, docs: { segmentDebounceMs: 20, writeDebounceMs: 50 } });
  await ctx.start();
  app = Fastify();
  registerReportsRoutes(app, ctx);
  await app.ready();
}
async function shutdown(): Promise<void> {
  await app?.close();
  await ctx?.close();
  app = null;
  ctx = null;
}
async function project(name: 'canto-demo' | 'large-multifile'): Promise<void> {
  root = mkdtempSync(join(tmpdir(), 'paper-review2-'));
  cpSync(join(REPO_ROOT, 'fixtures', name, 'tex'), join(root, 'tex'), { recursive: true });
  cpSync(join(REPO_ROOT, 'fixtures', name, 'repo'), join(root, 'repo'), { recursive: true });
  await initProject(root, { repo: join(root, 'repo'), skill: SKILL_DIR });
}
async function submission(): Promise<SubmissionReport> {
  const res = await app!.inject({ method: 'GET', url: `${FEATURE_ROUTES.submissionCheck}?venue=aps` });
  expect(res.statusCode, res.body).toBe(200);
  return SubmissionReport.parse(res.json());
}
const item = (r: SubmissionReport, id: string) => r.items.find((i) => i.id === id)!;
/** Every blocking item that names this sentence (by id or by its text). */
const blockersOf = (r: SubmissionReport, id: string, needle: string) =>
  r.items.filter((i) => i.severity === 'block' && !i.ok && i.items.some((e) => e.sentenceId === id || e.text.includes(needle))).map((i) => i.id);

afterEach(async () => {
  await shutdown();
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

/** Re-run of the analysis: replace a value in the result files (claim JSON and, where it is, the CSV row). */
function rerun(oldV: string, newV: string): void {
  let hit = 0;
  for (const f of ['results/addendum_g_g1_v1_claim.json', 'results/addendum_g_g1_v1.csv']) {
    const p = join(root, 'repo', f);
    const s = readFileSync(p, 'utf8');
    if (!s.includes(oldV)) continue;
    hit++;
    writeFileSync(p, s.split(oldV).join(newV));
  }
  expect(hit).toBeGreaterThan(0);
}

const abstractUnit = () => ctx!.docs.get('main.tex')!.units.find((u) => (ctx!.docs.unitText(u.id) ?? '').includes('96.94'))!;
const resultsUnit = () => ctx!.docs.get('main.tex')!.units.find((u) => (ctx!.docs.unitText(u.id) ?? '').startsWith('The fake-track rate is 0.55'))!;

describe('stale facts stay blockers', () => {
  it('the headline efficiency (held by the claim JSON AND the CSV row) changes: the abstract sentence stating 96.94% blocks', async () => {
    await project('canto-demo');
    await boot();
    await ctx!.facts.rescan();
    expect(item(await submission(), 'stale_facts').ok).toBe(true);
    rerun(EFF_A_OLD, EFF_A_NEW);
    const { stale } = await ctx!.facts.rescan();
    expect(stale).toEqual(expect.arrayContaining(['f.g1.eff_A']));
    const r = await submission();
    // today: stale_facts ok, note "2 stale fact(s), none stated in the text."; the sentence was never linked
    // to eff_A (two facts hold 0.96942, so the numeral is "ambiguous" and stays unlinked)
    expect(blockersOf(r, abstractUnit().id, '96.94')).toContain('stale_facts');
  });

  it('control: a uniquely linked fact (fake_rate_A, 0.55%) changes: its sentence blocks right after the rescan', async () => {
    await project('canto-demo');
    await boot();
    await ctx!.facts.rescan();
    await submission(); // opens main.tex: every sentence linked
    expect(resultsUnit().facts).toContain('f.g1.fake_rate_A');
    rerun(FAKE_A_OLD, FAKE_A_NEW);
    expect((await ctx!.facts.rescan()).stale).toContain('f.g1.fake_rate_A');
    expect(blockersOf(await submission(), resultsUnit().id, '0.55')).toContain('stale_facts');
  });

  it('after a server restart the same stale sentence is still a blocker', async () => {
    await project('canto-demo');
    await boot();
    await ctx!.facts.rescan();
    await submission();
    rerun(FAKE_A_OLD, FAKE_A_NEW);
    await ctx!.facts.rescan();
    expect(blockersOf(await submission(), resultsUnit().id, '0.55')).toContain('stale_facts');
    await shutdown(); // the laptop restarts / `paper open` again
    await boot();
    expect(ctx!.facts.all().find((f) => f.id === 'f.g1.fake_rate_A')!.stale).toBe(true); // stale is sticky
    const r = await submission();
    expect(ctx!.docs.unitText(resultsUnit().id)).toContain('0.55');
    // today: the reopen re-links every sentence against the new values; the stale link is dropped
    expect(blockersOf(r, resultsUnit().id, '0.55')).toContain('stale_facts');
  });

  it('after the author fixes a word elsewhere in that sentence it is still a blocker', async () => {
    await project('canto-demo');
    await boot();
    await ctx!.facts.rescan();
    await submission();
    rerun(FAKE_A_OLD, FAKE_A_NEW);
    await ctx!.facts.rescan();
    let u = resultsUnit();
    expect(blockersOf(await submission(), u.id, '0.55')).toContain('stale_facts');
    const st = ctx!.docs.get('main.tex')!;
    const at = u.start + (ctx!.docs.unitText(u.id) ?? '').indexOf('for the baseline');
    const msg = ClientMessage.parse(JSON.parse(JSON.stringify({ type: 'doc.change', file: 'main.tex', baseVersion: st.version, changes: ChangeSet.of([{ from: at, to: at + 'for the baseline'.length, insert: 'for acorn' }], st.text.length).toJSON(), annotation: null })));
    expect(await ctx!.docs.applyClientChange(msg as Extract<ClientMessage, { type: 'doc.change' }>)).toBe(true);
    await ctx!.docs.flush('main.tex');
    u = resultsUnit();
    expect(ctx!.docs.unitText(u.id)).toContain('for acorn');
    expect(blockersOf(await submission(), u.id, '0.55')).toContain('stale_facts');
  });
});

describe('every typeset file is checked', () => {
  it('a placeholder in a file typeset with \\import{sections/}{extra} is a blocker', async () => {
    await project('canto-demo');
    const main = join(root, 'tex', 'main.tex');
    const src = readFileSync(main, 'utf8')
      .replace('\\usepackage{hyperref}', '\\usepackage{hyperref}\n\\usepackage{import}')
      .replace('\\section{Conclusions}', '\\import{sections/}{extra}\n\n\\section{Conclusions}');
    writeFileSync(main, src);
    const dir = join(root, 'tex', 'sections');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'extra.tex'), 'At high pileup the efficiency falls to [fact?: efficiency at high pileup].\n');
    await boot();
    await ctx!.facts.rescan();
    const r = await submission();
    expect(item(r, 'placeholders').items.map((e) => e.file)).toContain('sections/extra.tex');
  });

  it('a placeholder in a table cell or a section title is a blocker', async () => {
    await project('canto-demo');
    const main = join(root, 'tex', 'main.tex');
    const src = readFileSync(main, 'utf8').replace('acorn (HNL) & 94.62 \\\\', 'acorn (HNL) & [fact?: acorn efficiency] \\\\').replace('\\section{Method}', '\\section{Method at [fact?: beam energy]}');
    writeFileSync(main, src);
    await boot();
    await ctx!.facts.rescan();
    const r = await submission();
    const texts = item(r, 'placeholders').items.map((e) => e.text).join(' | ');
    expect(texts).toContain('acorn efficiency');
    expect(texts).toContain('beam energy');
  });
});
