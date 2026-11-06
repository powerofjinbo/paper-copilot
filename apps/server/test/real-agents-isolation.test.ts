/**
 * The REAL Agent SDK path (AgentService -> @anthropic-ai/claude-agent-sdk query() -> the bundled Claude
 * Code process -> HTTP -> the local mock Messages API of test/support/mockAnthropic.ts), for what
 * real-agents.test.ts does not cover: isolation and failure handling.
 *
 * - Isolation from the author's own Claude setup and from the parent process: a decoy ~/.claude (a user
 *   skill, a CLAUDE.md, settings that allow Bash and Write) is not picked up; the model sees only the
 *   hep-paper-writing skill in its listing (not the CLI's bundled skills); the spawned process's
 *   environment, read from /proc, carries the app's endpoint and key and none of the CLAUDE* /
 *   ANTHROPIC_* variables this sandbox's own Claude Code session exports (ANTHROPIC_BASE_URL included).
 * - API errors: 529 / 429 are retried by the CLI and shown as job progress; a rejected key (401) stops
 *   the run within seconds. Before the fix in runner.ts (fatalRetryReason) the CLI retried the 401 with
 *   backoff and the job hung until the role timeout (20 minutes for the reader).
 * - Structured output that does not match the schema is refused by the CLI, the model retries, and the
 *   job validates the final value.
 *
 * The SDK is the real one; vi.mock only records the messages query() yields (init message). HOME is a
 * temporary directory. If the native binary is missing or cannot start, the suite is skipped and the
 * reason is in its title.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fact, ServerMessage } from '@paper-copilot/core';
import type { SDKMessage, SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Ctx, DocService, FactService, LitService, LlmService, PaperDb, VoiceService } from '../src/contracts';
import { createAgentService, type AgentServiceExt } from '../src/services/agents/service';
import { SKILL_NAME } from '../src/services/agents/options';
import { fatalRetryReason } from '../src/services/agents/runner';
import { skillLinkPath } from '../src/services/agents/skill';
import { makeTempProject, makeTestCtx, type TempProject } from './helpers/ctx';
import { startMockAnthropic, textReply, toolReply, type MockAnthropic, type MockReply, type RecordedRequest } from './support/mockAnthropic';

const KEY = 'sk-ant-test';
const PERF_SLACK = process.env.CI ? 3 : 1;

/* ------------------------------------------------------------------------------------ */
/* The real SDK, with every message it yields recorded                                    */
/* ------------------------------------------------------------------------------------ */

const sdkSeen = vi.hoisted(() => ({ messages: [] as unknown[] }));

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return {
    ...real,
    query: (args: Parameters<typeof real.query>[0]) => {
      const q = real.query(args);
      const iterate = async function* () {
        for await (const m of q) {
          sdkSeen.messages.push(m);
          yield m;
        }
      };
      return Object.assign(iterate(), { close: () => q.close(), interrupt: () => q.interrupt() });
    },
  };
});

/* ------------------------------------------------------------------------------------ */
/* Can the Claude Code process run here?                                                 */
/* ------------------------------------------------------------------------------------ */

const CLI_PROBLEM: string | null = (() => {
  let bin: string;
  try {
    const sdkEntry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
    const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    bin = join(createRequire(sdkEntry).resolve(`${pkg}/package.json`), '..', process.platform === 'win32' ? 'claude.exe' : 'claude');
  } catch (e) {
    return `the Agent SDK platform package is not installed (${e instanceof Error ? e.message : String(e)})`;
  }
  if (!existsSync(bin)) return `the Claude Code binary is missing (${bin})`;
  const scratch = mkdtempSync(join(tmpdir(), 'paper-cli-probe-'));
  try {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH ?? '', HOME: scratch } });
    if (r.status !== 0) return `the Claude Code binary does not start (${r.error?.message ?? (r.stderr || `exit ${r.status}`).slice(0, 200)})`;
    return null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
})();

/* ------------------------------------------------------------------------------------ */
/* Request helpers                                                                       */
/* ------------------------------------------------------------------------------------ */

type Block = { type: string; text?: string; id?: string; name?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
type Msg = { role: string; content: string | Block[] };
interface Result {
  name: string;
  text: string;
  isError: boolean;
}

const msgs = (r: RecordedRequest): Msg[] => (r.body?.messages ?? []) as Msg[];
const blocks = (m: Msg): Block[] => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content);
const systemText = (r: RecordedRequest): string => {
  const s = r.body?.system;
  if (typeof s === 'string') return s;
  return Array.isArray(s) ? (s as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n') : '';
};
const contentText = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? (c as Block[]).map((b) => (b.type === 'text' ? (b.text ?? '') : JSON.stringify(b))).join('\n') : JSON.stringify(c ?? '');

/**
 * The tool results the model is answering: those of the last `user` message (the CLI appends
 * mid-conversation `system` messages such as the USD budget after it), plus the text blocks that follow
 * a result in that message (the Skill tool adds the skill body there).
 */
function lastResults(r: RecordedRequest): Result[] {
  const m = msgs(r);
  const names = new Map<string, string>();
  for (const x of m) if (x.role === 'assistant') for (const b of blocks(x)) if (b.type === 'tool_use' && b.id && b.name) names.set(b.id, b.name);
  let last: Msg | undefined;
  for (let i = m.length - 1; i >= 0 && m[i]!.role !== 'assistant'; i--) {
    if (m[i]!.role === 'user') {
      last = m[i];
      break;
    }
  }
  const out: Result[] = [];
  for (const b of last ? blocks(last) : []) {
    if (b.type === 'tool_result') out.push({ name: names.get(b.tool_use_id ?? '') ?? '?', text: contentText(b.content), isError: b.is_error === true });
    else if (b.type === 'text' && out.length > 0) out[out.length - 1]!.text += `\n${b.text ?? ''}`;
  }
  return out;
}

const assistantTurns = (r: RecordedRequest): number => msgs(r).filter((m) => m.role === 'assistant').length;

interface Conversation {
  /** Tool results the model saw before step i. */
  seen: Result[][];
  main: RecordedRequest[];
  /** Requests outside the agent's main thread (none expected). */
  side: RecordedRequest[];
}

/** Play the model: step i answers the main-thread request (system prompt carries `marker`) with i assistant turns. */
function converse(mock: MockAnthropic, marker: string, steps: Array<MockReply | ((r: RecordedRequest) => MockReply)>): Conversation {
  const conv: Conversation = { seen: [], main: [], side: [] };
  mock.fallback = (r) => {
    if (!systemText(r).includes(marker)) {
      conv.side.push(r);
      return textReply('ok');
    }
    conv.main.push(r);
    const i = assistantTurns(r);
    conv.seen[i] = lastResults(r);
    const step = steps[Math.min(i, steps.length - 1)]!;
    return typeof step === 'function' ? step(r) : step;
  };
  return conv;
}

/** Claude Code processes that are children of this test process, with their environment (Linux /proc). */
function childClaudeProcesses(): Array<{ pid: number; env: Record<string, string> }> {
  if (process.platform !== 'linux') return [];
  const out: Array<{ pid: number; env: Record<string, string> }> = [];
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) !== process.pid) continue;
      if (!/claude/.test(readFileSync(`/proc/${pid}/cmdline`, 'utf8'))) continue;
      const env: Record<string, string> = {};
      for (const kv of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
        const i = kv.indexOf('=');
        if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
      }
      out.push({ pid: Number(pid), env });
    } catch {
      /* exited meanwhile */
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------ */
/* Harness                                                                               */
/* ------------------------------------------------------------------------------------ */

const FACTS = [
  {
    id: 'f.g1.delta_points', value: 2.3191733639494783, unit: 'points', aliases: ['2.32~points'], definition: 'Efficiency difference, Canto-L minus acorn',
    kind: 'number', sigfigs: null, uncertainties: {}, definitionSource: 'test', artifact: 'results/addendum_g_g1_v1_claim.json', locator: '#/delta_points',
    artifactSha256: 'sha', fingerprint: 'fp', stale: false, validationState: 'candidate', confirmed: true, excluded: false, proseOnly: false, tags: [],
  },
] as unknown as Fact[];

const BRIEF = {
  brief_markdown: '# Brief\n\nThe Canto tracker and its efficiency study.',
  fact_candidates: [{ proposed_id: 'f.g1.delta', definition_paraphrase: 'efficiency difference', artifact: 'results/addendum_g_g1_v1_claim.json', locator: '#/delta_points', kind: 'number', condition: 'P_G' }],
  figures: [],
  terminology: [{ term: 'Double majority (DM)', definition: 'matching rule' }],
  unknowns: ['哪个文件是权威的'],
};
const MARKER = 'PAPER-COPILOT AGENT repo_reader SYSTEM';

/** This process's environment with the CLI's writable locations moved into the temporary home. */
function agentEnv(): Record<string, string | undefined> {
  mkdirSync(join(home, 'tmp'), { recursive: true });
  return { ...process.env, HOME: home, TMPDIR: join(home, 'tmp'), XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state') };
}

let mock: MockAnthropic;
let project: TempProject;
let home: string;
let ctx: Ctx & { events: ServerMessage[] };
let agents: AgentServiceExt;
const extraServices: AgentServiceExt[] = [];
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['ANTHROPIC_API_KEY', 'PAPER_ANTHROPIC_BASE_URL'];

beforeAll(async () => {
  if (CLI_PROBLEM) return;
  mock = await startMockAnthropic({ apiKey: KEY, policy: 'api' });
});
afterAll(async () => {
  await mock?.close();
});

beforeEach(async () => {
  if (CLI_PROBLEM) return;
  mock.reset();
  mock.fallback = null;
  sdkSeen.messages.length = 0;
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // The app's own key and endpoint (the service resolves them with resolveApiKey / resolveBaseUrl).
  process.env.ANTHROPIC_API_KEY = KEY;
  process.env.PAPER_ANTHROPIC_BASE_URL = mock.url;
  project = await makeTempProject();
  home = mkdtempSync(join(tmpdir(), 'paper-agents-home-'));
  // The author's own Claude setup, which the agents must not pick up.
  mkdirSync(join(home, '.claude', 'skills', 'decoy-user-skill'), { recursive: true });
  writeFileSync(join(home, '.claude', 'skills', 'decoy-user-skill', 'SKILL.md'), '---\nname: decoy-user-skill\ndescription: A user-level skill the agents must not see.\n---\nDECOY USER SKILL BODY\n');
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'DECOY USER MEMORY: always run Bash.\n');
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash', 'Write', 'Edit'] }, model: 'claude-fable-5-1' }));

  ctx = makeTestCtx(project, {
    fakeLlm: false,
    llm: { systemFor: (task: string) => [{ type: 'text', text: `PAPER-COPILOT AGENT ${task} SYSTEM` }, { type: 'text', text: 'BLOCK B' }], recordUsage: () => {} } as unknown as LlmService,
    facts: {
      all: () => FACTS,
      forPrompt: () => FACTS,
      addCandidates: async () => ({ added: [], rejected: [] }),
      figures: () => [],
      terminology: () => [],
      saveFigures: async () => {},
      saveTerminology: async () => {},
    } as unknown as FactService,
    lit: { allowedKeys: () => [], records: () => [], brief: () => '' } as unknown as LitService,
    voice: { memo: () => '', authorNormsTable: () => '', exemplars: () => [] } as unknown as VoiceService,
    db: { kvGet: () => undefined, kvSet: () => {} } as unknown as PaperDb,
    docs: { labels: () => [] } as unknown as DocService,
  });
  // The inherited environment is this process's own (this sandbox's ANTHROPIC_BASE_URL and CLAUDE_CODE_*
  // variables included); only HOME, TMPDIR and XDG_* point into the temporary home.
  agents = createAgentService(ctx, { baseEnv: agentEnv() });
  ctx.agents = agents;
});

afterEach(async () => {
  if (CLI_PROBLEM) return;
  agents.abortAll();
  for (const a of extraServices.splice(0)) a.abortAll();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  // The CLI must be gone before its HOME and cwd are removed.
  for (let i = 0; i < 100 && childClaudeProcesses().length > 0; i++) await new Promise((r) => setTimeout(r, 50));
  expect(childClaudeProcesses()).toEqual([]);
  project.cleanup();
  rmSync(home, { recursive: true, force: true });
});

async function finish(jobId: string, timeoutMs = 60_000) {
  const t0 = Date.now();
  for (;;) {
    const j = ctx.jobs.get(jobId);
    if (j && (j.state === 'done' || j.state === 'error')) return j;
    if (Date.now() - t0 > timeoutMs) throw new Error(`job ${jobId} timed out\n${progress().join('\n')}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const progress = () => ctx.events.flatMap((e) => (e.type === 'job.progress' ? [e.message] : []));
const initMessages = () => sdkSeen.messages.filter((m): m is SDKSystemMessage => (m as SDKMessage).type === 'system' && (m as { subtype?: string }).subtype === 'init');

/** Every request the CLI made: POST /v1/messages only, with the app's key, and no API rule broken. */
function expectCleanTraffic(): void {
  expect(mock.requests.length).toBeGreaterThan(0);
  expect(mock.requests.map((r) => `${r.method} ${r.route}`).filter((x) => x !== 'POST /v1/messages')).toEqual([]);
  for (const r of mock.requests) {
    expect(r.headers['x-api-key']).toBe(KEY);
    expect(r.headers.authorization).toBeUndefined();
  }
  expect(mock.describeViolations('api')).toBe('');
}

/* ------------------------------------------------------------------------------------ */
/* Tests                                                                                 */
/* ------------------------------------------------------------------------------------ */

describe('fatalRetryReason', () => {
  it('stops on errors a retry cannot fix, keeps retrying transient ones', () => {
    expect(fatalRetryReason({ error: 'authentication_failed', error_status: 401 })).toMatch(/401 authentication_failed\): the API key was rejected/);
    expect(fatalRetryReason({ error: 'unknown', error_status: 403 })).toMatch(/403 unknown/);
    expect(fatalRetryReason({ error: 'billing_error', error_status: 400 })).toMatch(/billing/);
    expect(fatalRetryReason({ error: 'model_not_found', error_status: 404 })).toMatch(/model names/);
    expect(fatalRetryReason({ error: 'overloaded', error_status: 529 })).toBeNull();
    expect(fatalRetryReason({ error: 'rate_limit', error_status: 429 })).toBeNull();
    expect(fatalRetryReason({ error: 'server_error', error_status: 500 })).toBeNull();
    expect(fatalRetryReason({ error: 'unknown', error_status: null })).toBeNull();
  });
});

describe.skipIf(!!CLI_PROBLEM)(`real Agent SDK: isolation and API errors${CLI_PROBLEM ? ` [skipped: ${CLI_PROBLEM}]` : ''}`, () => {
  it("isolation: the author's ~/.claude and this process's CLAUDE* / ANTHROPIC_* variables do not reach the agent; the model sees only hep-paper-writing", async () => {
    let spawned: Array<{ pid: number; env: Record<string, string> }> = [];
    const conv = converse(mock, MARKER, [
      () => {
        spawned = childClaudeProcesses();
        return toolReply('Skill', { skill: 'decoy-user-skill' });
      },
      toolReply('Skill', { skill: SKILL_NAME }),
      toolReply('StructuredOutput', BRIEF),
      textReply('Done.'),
    ]);
    const j = await finish(agents.readRepo());
    expect(j.state, `${j.message}\n${progress().join('\n')}`).toBe('done');

    // The CLI discovered the project skill through the symlink, and nothing from ~/.claude.
    const init = initMessages();
    expect(init).toHaveLength(1);
    expect(init[0]!.skills).toContain(SKILL_NAME);
    expect(init[0]!.skills).not.toContain('decoy-user-skill');
    expect(init[0]!.apiKeySource).toBe('ANTHROPIC_API_KEY');
    expect(init[0]!.model).toBe('claude-sonnet-5-5');
    expect(init[0]!.tools.filter((t) => /^(Write|Edit|Bash|WebFetch|WebSearch|NotebookEdit|Agent|Task)$/.test(t))).toEqual([]);

    // The decoy user skill cannot be loaded; the project skill can, from the link.
    expect(conv.seen[1]![0]).toMatchObject({ name: 'Skill', isError: true });
    expect(conv.seen[1]![0]!.text).not.toContain('DECOY USER SKILL BODY');
    expect(conv.seen[2]![0]).toMatchObject({ name: 'Skill', isError: false });
    expect(conv.seen[2]![0]!.text).toContain(`Base directory for this skill: ${skillLinkPath(project.paths.claudeCwd)}`);

    // What the model is told: the app's system prompt, one skill in the listing, no user memory. The
    // CLI's bundled skills (claude-api, dataviz, ...) are discovered (init lists them) but `skills`
    // hides them from the model.
    const first = conv.main[0]!;
    expect(first.body!.model).toBe('claude-sonnet-5-5');
    expect(systemText(first)).toContain(MARKER);
    const listing = /The following skills are available for use with the Skill tool:\n\n([\s\S]*?)(?:\n\n[^-]|$)/.exec(JSON.stringify(first.body).replace(/\\n/g, '\n'));
    expect(listing, 'skill listing in the request').toBeTruthy();
    expect([...listing![1]!.matchAll(/^- ([\w:-]+):/gm)].map((m) => m[1])).toEqual([SKILL_NAME]);
    const all = JSON.stringify(mock.requests.map((r) => r.body));
    expect(all).not.toContain('DECOY USER MEMORY');
    expect(all).not.toContain('decoy-user-skill: A user-level skill');
    expect(conv.side).toEqual([]);
    expectCleanTraffic();

    // The process environment: the app's endpoint and key only.
    if (process.platform === 'linux') {
      expect(spawned).toHaveLength(1);
      const env = spawned[0]!.env;
      expect(env.ANTHROPIC_BASE_URL).toBe(mock.url);
      expect(env.ANTHROPIC_API_KEY).toBe(KEY);
      expect(env.HOME).toBe(home);
      expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
      if (process.env.ANTHROPIC_BASE_URL) expect(env.ANTHROPIC_BASE_URL).not.toBe(process.env.ANTHROPIC_BASE_URL);
      // The SDK sets a few variables of its own (entrypoint, version); none is inherited from here.
      const ours = new Set(['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'CLAUDE_AGENT_SDK_CLIENT_APP']);
      const sdkSets = new Set(['CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SDK_READS_SESSION_STATE']);
      const inherited = Object.keys(process.env).filter((k) => /^(CLAUDE|ANTHROPIC_)/.test(k) && !ours.has(k) && !sdkSets.has(k) && env[k] !== undefined && env[k] === process.env[k]);
      expect(inherited).toEqual([]);
    }
  });

  it('API errors: 529 and 429 are retried by the CLI and shown as progress; a rejected key stops the run at once instead of retrying for minutes', { timeout: 60_000 }, async () => {
    let n = 0;
    converse(mock, MARKER, [
      () => (++n === 1 ? { kind: 'error', status: 529, type: 'overloaded_error' } : n === 2 ? { kind: 'error', status: 429, type: 'rate_limit_error', retryAfter: 0 } : toolReply('StructuredOutput', BRIEF)),
      textReply('Done.'),
    ]);
    const j = await finish(agents.readRepo());
    expect(j.state, `${j.message}\n${progress().join('\n')}`).toBe('done');
    expect(mock.messages().map((r) => r.status).slice(0, 3)).toEqual([529, 429, 200]);
    expect(progress().some((m) => /^API 529 error \(overloaded\); retry 1 of \d+/.test(m))).toBe(true);
    expect(progress().some((m) => /^API 429 error \(rate_limit\); retry 2 of \d+/.test(m))).toBe(true);
    expectCleanTraffic();

    // A key the API rejects.
    mock.reset();
    process.env.ANTHROPIC_API_KEY = 'sk-ant-revoked-key';
    const other = createAgentService(ctx, { baseEnv: agentEnv() });
    extraServices.push(other);
    converse(mock, MARKER, [toolReply('StructuredOutput', BRIEF)]);
    const t0 = Date.now();
    const j2 = await finish(other.readRepo(), 30_000);
    expect(j2.state).toBe('error');
    expect(j2.message).toMatch(/the Anthropic API refused the request \(401 authentication_failed\): the API key was rejected/);
    expect(Date.now() - t0).toBeLessThan(15_000 * PERF_SLACK);
    expect(mock.messages().length).toBeGreaterThan(0);
    expect(mock.messages().every((r) => r.status === 401)).toBe(true);
    expect(mock.messages().length).toBeLessThanOrEqual(3);
  });

  it('structured output that does not match the schema is refused by the CLI; the model retries and the job validates the final value', async () => {
    const conv = converse(mock, MARKER, [toolReply('StructuredOutput', { brief_markdown: 42 }), toolReply('StructuredOutput', BRIEF), textReply('Done.')]);
    const j = await finish(agents.readRepo());
    expect(j.state, `${j.message}\n${progress().join('\n')}`).toBe('done');
    expect(conv.seen[1]![0]).toMatchObject({ name: 'StructuredOutput', isError: true });
    expect(readFileSync(project.paths.repoBrief, 'utf8')).toContain('The Canto tracker and its efficiency study.');
    expectCleanTraffic();
  });
});
