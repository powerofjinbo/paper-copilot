/**
 * The analysis-repository watcher (services/facts/repoWatcher.ts) and the simulated drafter's text
 * (services/llm/fake.ts fakeDraftSentences, used by agents/fake.ts fakeParagraph).
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gateSentence, type Fact, type OutlineParagraph, type OutlineSection, type ServerMessage } from '@paper-copilot/core';
import { createCtx, type AppCtx } from '../src/ctx';
import { initProject } from '../src/project/init';
import { createRepoWatcher, repoChangeNotice } from '../src/services/facts/repoWatcher';
import type { FactServiceImpl } from '../src/services/facts/factService';
import { fakeDraftSentences, topicPhrase } from '../src/services/llm/fake';
import { fakeParagraph } from '../src/services/agents/fake';
import { REPO_ROOT, SKILL_DIR, makeTempProject, makeTestCtx, type TempProject } from './helpers/ctx';

const PERF_SLACK = process.env.CI ? 3 : 1;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out waiting');
    await sleep(25);
  }
}

describe('repository watcher (unit)', () => {
  let project: TempProject;
  beforeEach(async () => {
    project = await makeTempProject();
  });
  afterEach(() => project.cleanup());

  it('is a no-op without repoDir', async () => {
    const ctx = makeTestCtx(project);
    await ctx.saveConfig({ ...ctx.config, repoDir: null });
    let scans = 0;
    const w = createRepoWatcher(ctx, { rescan: async () => (scans++, { count: 0, stale: [] }), staleIds: () => [] });
    expect(w.active).toBe(false);
    await w.ready;
    await w.close();
    expect(scans).toBe(0);
  });

  it('debounces a burst of artifact writes into one rescan, ignores files outside the fact globs', async () => {
    const ctx = makeTestCtx(project);
    let scans = 0;
    const w = createRepoWatcher(ctx, { rescan: async () => (scans++, { count: 7, stale: ['f.x'] }), staleIds: () => [] }, { debounceMs: 300, usePolling: true, interval: 50 });
    expect(w.active).toBe(true);
    await w.ready;
    const csv = join(project.repoDir, 'results', 'addendum_g_g1_v1.csv');
    const json = join(project.repoDir, 'results', 'addendum_g_g1_v1_claim.json');
    // not a fact glob: never a rescan
    writeFileSync(join(project.repoDir, 'README.md'), 'changed\n');
    await sleep(700);
    expect(scans).toBe(0);
    writeFileSync(csv, readFileSync(csv, 'utf8') + '\n');
    await sleep(60);
    writeFileSync(json, readFileSync(json, 'utf8').replace('"n_targets": 8710', '"n_targets": 8711'));
    await until(() => scans > 0, 5000 * PERF_SLACK);
    await w.idle();
    await sleep(500);
    expect(scans).toBe(1);
    const notices = ctx.events.filter((e): e is Extract<ServerMessage, { type: 'notice' }> => e.type === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.level).toBe('warn');
    expect(notices[0]!.message).toContain('results/addendum_g_g1_v1');
    await w.close();
  });

  it('writes the notice in the notes language', () => {
    expect(repoChangeNotice('zh', ['results/a.json'], 10, ['f.a'])).toMatch(/分析结果已更新.*1 个数值变了/);
    expect(repoChangeNotice('en', ['a', 'b', 'c', 'd'], 10, [])).toMatch(/a, b, c and 1 more.*no stated value changed/);
  });
});

describe('repository watcher through the fact service', () => {
  let root: string;
  let ctx: AppCtx;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'paper-watch-'));
    cpSync(join(REPO_ROOT, 'fixtures', 'canto-demo', 'tex'), join(root, 'tex'), { recursive: true });
    cpSync(join(REPO_ROOT, 'fixtures', 'canto-demo', 'repo'), join(root, 'repo'), { recursive: true });
    await initProject(root, { repo: join(root, 'repo'), skill: SKILL_DIR });
    ctx = await createCtx({ root, fake: true, logLevel: 'error', watch: false, lintSidecar: false });
    await ctx.start();
    await ctx.facts.rescan();
  });
  afterEach(async () => {
    await ctx.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('a re-run result marks its facts stale and emits facts.updated + a notice', async () => {
    const events: ServerMessage[] = [];
    const off = ctx.bus.subscribe((m) => events.push(m));
    const facts = ctx.facts as FactServiceImpl;
    const w = facts.watchRepo({ debounceMs: 200, usePolling: true, interval: 50 });
    expect(facts.watchRepo()).toBe(w); // one watcher per service
    await w.ready;
    const json = join(root, 'repo', 'results', 'addendum_g_g1_v1_claim.json');
    writeFileSync(json, readFileSync(json, 'utf8').replace('"eff_A": 0.9694221201683888', '"eff_A": 0.9701'));
    await until(() => events.some((e) => e.type === 'notice'), 6000 * PERF_SLACK);
    const upd = events.find((e): e is Extract<ServerMessage, { type: 'facts.updated' }> => e.type === 'facts.updated')!;
    expect(upd.stale).toContain('f.g1.eff_A');
    expect(ctx.facts.get('f.g1.eff_A')).toMatchObject({ stale: true, value: 0.9701 });
    const notice = events.find((e): e is Extract<ServerMessage, { type: 'notice' }> => e.type === 'notice')!;
    expect(notice.level).toBe('warn');
    expect(notice.message).toContain('results/addendum_g_g1_v1_claim.json');
    // the derived relations follow the new value
    expect(ctx.facts.derived!().some((r) => r.factIds.includes('f.g1.eff_A') && r.kind === 'difference' && Math.abs(r.value - (97.01 - 94.6230386528894)) < 1e-6)).toBe(true);
    off();
    await facts.close();
  });

  it('ctx.start() starts it when watching is on, and close() stops it', async () => {
    const root2 = mkdtempSync(join(tmpdir(), 'paper-watch2-'));
    try {
      cpSync(join(REPO_ROOT, 'fixtures', 'canto-demo', 'tex'), join(root2, 'tex'), { recursive: true });
      cpSync(join(REPO_ROOT, 'fixtures', 'canto-demo', 'repo'), join(root2, 'repo'), { recursive: true });
      await initProject(root2, { repo: join(root2, 'repo'), skill: SKILL_DIR });
      const c2 = await createCtx({ root: root2, fake: true, logLevel: 'error', lintSidecar: false });
      await c2.start();
      const w = (c2.facts as FactServiceImpl).watchRepo();
      expect(w.active).toBe(true);
      await c2.close();
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  });
});

describe('simulated drafter text', () => {
  const facts: Fact[] = [];
  let project: TempProject;
  beforeEach(async () => {
    project = await makeTempProject();
  });
  afterEach(() => project.cleanup());

  it('names the topic without copying the job', () => {
    expect(topicPhrase('Show the efficiency gain of the GNN over the baseline')).toBe('efficiency gain of the GNN');
    expect(topicPhrase('Explain why the tracker keeps its efficiency on displaced tracks')).toBe('tracker');
    expect(topicPhrase('解释为什么 3 个种子')).toBe('');
    const out = fakeDraftSentences({ job: 'Show the efficiency gain of the GNN over the baseline', sectionTitle: 'Results', moves: ['result'], steps: [] });
    expect(out[0]!.text).toBe('We now turn to the efficiency gain of the GNN.');
    expect(out[0]!.text).not.toContain('Show the efficiency gain');
  });

  it('every simulated draft sentence of a plan with facts and cites passes the gate', async () => {
    const ctx = makeTestCtx(project);
    const { createFactService } = await import('../src/services/facts/factService');
    const fs = createFactService(ctx);
    await fs.rescan();
    facts.push(...fs.all().filter((f) => !f.excluded));
    await fs.flush();
    const byId = new Map(facts.map((f) => [f.id, f]));
    const pick = ['f.g1.eff_A', 'f.g1.eff_B', 'f.g1.delta_points'].filter((id) => byId.has(id));
    expect(pick.length).toBe(3);
    const paragraph: OutlineParagraph = {
      pid: 'results/p0',
      job: 'Show that the GNN finds more displaced targets than the baseline 解释',
      moves: ['result'],
      claimIds: [],
      intentNotes: [],
      provenance: 'author',
      plan: {
        job: 'Show that the GNN finds more displaced targets than the baseline',
        claimIds: [],
        said: {},
        remaining: [
          { id: 's1', intent: 'State the efficiencies of both trackers', factIds: ['f.g1.eff_A', 'f.g1.eff_B'], citeKeys: ['Ju:2020xty'], move: 'result' },
          { id: 's2', intent: 'Give the gain in points', factIds: ['f.g1.delta_points'], citeKeys: [], move: 'result' },
          { id: 's3', intent: 'Explain the training sample', factIds: [], citeKeys: [], move: 'method' },
        ],
      },
    };
    const section: OutlineSection = { id: 'sec:results', title: 'Results', question: 'Does it work?', template: 'results', ghostMode: 'complete-my-sentence', paragraphs: [paragraph], provenance: 'author' };
    const input = fakeParagraph({ section, paragraph, facts, allowedKeys: ['Ju:2020xty'], fromNotes: false, lang: 'en', extraSentence: null });
    expect(input.sentences).toHaveLength(4);
    for (const s of input.sentences) {
      expect(s.text).toMatch(/^[A-Z].*\.$/);
      expect(s.text).not.toMatch(/[一-鿿]/);
      expect(s.text.toLowerCase()).not.toContain(paragraph.job.toLowerCase().slice(0, 30));
      const g = gateSentence(s.text, { mode: 'draft', facts, allowedCiteKeys: ['Ju:2020xty'], knownLabels: [], fictionalNumbers: [], claimedFactIds: s.fact_ids ?? [] });
      expect(g.ok, `${s.text}: ${JSON.stringify(g.issues)}`).toBe(true);
    }
    expect(input.sentences[1]!.fact_ids).toEqual(['f.g1.eff_A', 'f.g1.eff_B']);
    expect(input.sentences[1]!.text).toContain('\\cite{Ju:2020xty}');
    expect(input.sentences[1]!.text).toMatch(/^For the efficiencies of both trackers, we find 96\.9.*compared with 94\.6/);
    expect(input.sentences[3]!.text).toBe('We also examine the training sample.');
    // deterministic
    expect(fakeParagraph({ section, paragraph, facts, allowedKeys: ['Ju:2020xty'], fromNotes: false, lang: 'en', extraSentence: null })).toEqual(input);
  });
});
