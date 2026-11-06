/**
 * The real (non-fake) path, driven without an API key: the Agent SDK module is mocked so query() runs a
 * scripted session that calls the very hooks and MCP handlers the service passes in. Core prompt
 * builders are stubbed so this test does not depend on their wording.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Outline, emptyOutline, type ServerMessage } from '@paper-copilot/core';
import type { HookCallback, Options, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { Ctx, DocService, FactService, LitService, LlmService, PaperDb } from '../src/contracts';
import { createAgentService, DRAFTER_SESSION_KEY } from '../src/services/agents/service';
import { makeTempProject, makeTestCtx, type TempProject } from './helpers/ctx';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ prompt: string; options: Record<string, unknown> }>,
  script: null as null | ((options: Record<string, unknown>) => AsyncGenerator<unknown>),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt, options }: { prompt: string; options: Record<string, unknown> }) => {
    h.calls.push({ prompt, options });
    const gen = h.script!(options);
    return Object.assign(gen, { close() {} });
  },
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown, extras: unknown) => ({ name, description, inputSchema, handler, extras }),
  createSdkMcpServer: (o: { name: string; tools: unknown[] }) => ({ type: 'sdk', name: o.name, instance: { tools: o.tools } }),
}));

vi.mock('@paper-copilot/core', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@paper-copilot/core')>();
  return {
    ...orig,
    repoReaderTask: () => 'READ THE REPOSITORY',
    draftTask: () => 'DRAFT THE SECTION',
    outputJsonSchema: (task: string) => ({ type: 'object', title: task }),
    extractFictionalNumbers: () => ['7.77'],
    renderFact: (f: { id: string; value: unknown }) => `${f.id} = ${String(f.value)}`,
    frozenOutline: () => 'OUTLINE',
    gateSentence: (text: string, c: { fictionalNumbers: string[] }) => {
      const bad = c.fictionalNumbers.find((n) => text.includes(n));
      return bad
        ? { ok: false, issues: [{ code: 'fictional_number', severity: 'block', message: `${bad} is a fictional example number`, raw: bad }], repaired: text.replace(bad, '[fact?: value]'), factIds: [], citeKeys: [], unlinked: [], placeholders: ['[fact?: value]'] }
        : { ok: true, issues: [], repaired: text, factIds: [], citeKeys: [], unlinked: [], placeholders: [] };
    },
  };
});

const usage = (inputTokens: number, costUSD: number) => ({ inputTokens, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD, contextWindow: 1, maxOutputTokens: 1 });
const init = (skills: string[], session = 'sess-1') => ({ type: 'system', subtype: 'init', skills, session_id: session, cwd: '/x', tools: [], mcp_servers: [], model: 'm', permissionMode: 'dontAsk', slash_commands: [], output_style: 'default', plugins: [], apiKeySource: 'ANTHROPIC_API_KEY', claude_code_version: '2', uuid: 'u' });
const toolUse = (name: string, input: unknown) => ({ type: 'assistant', parent_tool_use_id: null, session_id: 's', uuid: 'u', message: { content: [{ type: 'tool_use', id: 't', name, input }] } });
const success = (o: { structured?: unknown; session?: string; modelUsage?: Record<string, unknown> }) => ({
  type: 'result', subtype: 'success', is_error: false, result: 'done', structured_output: o.structured, session_id: o.session ?? 'sess-1', total_cost_usd: 0.12, num_turns: 4, modelUsage: o.modelUsage ?? {}, duration_ms: 1, duration_api_ms: 1, stop_reason: null, usage: {}, permission_denials: [], uuid: 'u',
});

async function callHook(options: Record<string, unknown>, event: 'PreToolUse' | 'PostToolUse', input: Record<string, unknown>): Promise<SyncHookJSONOutput> {
  const hooks = (options.hooks as Options['hooks'])![event]!;
  const out: SyncHookJSONOutput = {};
  for (const m of hooks) {
    if (m.matcher && m.matcher !== input.tool_name) continue;
    for (const fn of m.hooks as HookCallback[]) Object.assign(out, await fn({ session_id: 's', transcript_path: '', cwd: '/', hook_event_name: event, ...input } as never, 'tu', { signal: new AbortController().signal }));
  }
  return out;
}

let project: TempProject;
let ctx: Ctx & { events: ServerMessage[] };
const recorded: Array<{ model: string; route: string; input: number }> = [];
const added: unknown[] = [];
const kv = new Map<string, string>();

beforeEach(async () => {
  h.calls.length = 0;
  recorded.length = 0;
  added.length = 0;
  kv.clear();
  project = await makeTempProject();
  ctx = makeTestCtx(project, {
    fakeLlm: false,
    llm: {
      systemFor: (task: string) => [{ type: 'text', text: `BLOCK A for ${task}` }, { type: 'text', text: 'BLOCK B' }],
      recordUsage: (model: string, u: { input_tokens: number }, route: string) => void recorded.push({ model, route, input: u.input_tokens }),
    } as unknown as LlmService,
    facts: {
      all: () => [],
      forPrompt: () => [],
      addCandidates: async (c: unknown[]) => (added.push(...c), { added: [], rejected: [] }),
      figures: () => [],
      terminology: () => [],
      saveFigures: async () => {},
      saveTerminology: async () => {},
    } as unknown as FactService,
    lit: { allowedKeys: () => [], records: () => [] } as unknown as LitService,
    db: { kvGet: (k: string) => kv.get(k), kvSet: (k: string, v: string) => void kv.set(k, v) } as unknown as PaperDb,
    docs: {
      get: () => undefined,
      open: async () => ({ file: 'main.tex', version: 2, text: 'x', units: [], intentLines: [], seg: { sentences: [], sections: [], paragraphs: [], intentLines: [], labels: [], refs: [], cites: [], fragment: false } }),
      allUnits: () => [],
      unitText: () => null,
      labels: () => [],
    } as unknown as DocService,
  });
  ctx.agents = createAgentService(ctx, { baseEnv: { PATH: '/usr/bin' } });
});

afterEach(() => project.cleanup());

async function finish(jobId: string) {
  for (let i = 0; i < 500; i++) {
    const j = ctx.jobs.get(jobId);
    if (j && (j.state === 'done' || j.state === 'error')) return j;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timeout');
}

describe('real mode with a scripted SDK session', () => {
  it('readRepo: read-only options, guarded tools, structured brief, path-checked candidates, usage', async () => {
    h.script = async function* (options) {
      const denied = await callHook(options, 'PreToolUse', { tool_name: 'Write', tool_input: { file_path: '/tmp/x', content: 'y' }, tool_use_id: 't1' });
      expect((denied.hookSpecificOutput as { permissionDecision: string }).permissionDecision).toBe('deny');
      yield init(['hep-paper-writing']);
      yield toolUse('Read', { file_path: `${project.repoDir}/README.md` });
      yield success({
        structured: {
          brief_markdown: '# Brief\n\nThe Canto tracker.',
          fact_candidates: [
            { proposed_id: 'f.g1.delta', definition_paraphrase: 'difference', artifact: 'results/addendum_g_g1_v1_claim.json', locator: '#/delta_points', kind: 'number', condition: 'P_G' },
            { proposed_id: 'f.evil', definition_paraphrase: 'x', artifact: '/etc/passwd', locator: '#/x', kind: 'number', condition: '' },
          ],
          figures: [{ path: 'figures/missing.pdf', job: 'efficiency vs d0', status: 'exists' }],
          terminology: [{ term: 'Double majority (DM)', definition: 'matching rule' }],
          unknowns: ['which file is authoritative'],
        },
        modelUsage: { 'claude-sonnet-5-5': usage(1000, 0.1) },
      });
    };
    const j = await finish(ctx.agents.readRepo());
    expect(j.state, j.message).toBe('done');
    const { prompt, options } = h.calls[0]!;
    expect(prompt).toBe('READ THE REPOSITORY');
    expect(options).toMatchObject({
      model: 'claude-sonnet-5-5',
      cwd: project.paths.claudeCwd,
      settingSources: ['project'],
      skills: ['hep-paper-writing'],
      tools: ['Read', 'Glob', 'Grep', 'Skill'],
      permissionMode: 'dontAsk',
      outputFormat: { type: 'json_schema', schema: { type: 'object', title: 'repo_reader' } },
      maxBudgetUsd: 5,
      persistSession: false,
      systemPrompt: 'BLOCK A for repo_reader\n\nBLOCK B',
      additionalDirectories: [project.repoDir, project.paths.tex, ctx.config.skillDir],
      env: expect.objectContaining({ PATH: '/usr/bin', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }),
    });
    expect(options.permissionMode).not.toBe('bypassPermissions');
    // The absolute artifact path never reached the facts service.
    expect(added).toEqual([expect.objectContaining({ proposed_id: 'f.g1.delta' })]);
    const result = j.result as { facts: { rejected: Array<{ reason: string }> }; terms: number };
    expect(result.facts.rejected[0]!.reason).toMatch(/absolute/);
    expect(readFileSync(project.paths.repoBrief, 'utf8')).toContain('## Unknowns');
    expect(recorded).toEqual([{ model: 'claude-sonnet-5-5', route: 'reader', input: 1000 }]);
    expect(ctx.events.some((e) => e.type === 'job.progress' && /Read: .*README\.md/.test(e.message))).toBe(true);
  });

  it('draft: editor MCP handler -> PostToolUse gate -> draft.proposed; the session is stored and resumed with usage deltas', async () => {
    const o = emptyOutline();
    o.authorFilled = true;
    o.sections = [{ id: 'sec:r', title: 'Results', question: 'q', template: 'results', ghostMode: 'auto-propose', provenance: 'author', paragraphs: [{ pid: 'p1', job: 'Give the result', moves: [], claimIds: [], intentNotes: [], provenance: 'author', plan: { job: 'Give the result', claimIds: [], said: {}, remaining: [] } }] }];
    await ctx.files.writeJson(project.paths.outline, Outline.parse(o));

    let cumulative = 0;
    h.script = async function* (options) {
      cumulative += 500;
      yield init(['hep-paper-writing'], 'sess-9');
      const editor = (options.mcpServers as Record<string, { instance: { tools: Array<{ name: string; handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }> } }>).editor!;
      const propose = editor.instance.tools.find((t) => t.name === 'propose_paragraph')!;
      for (const text of ['The gain reaches 7.77 points.', 'The gain reaches 7.77 points.']) {
        const args = { pid: 'p1', job: 'Give the result', sentences: [{ text: 'We find a clear gain.' }, { text }] };
        const res = await propose.handler(args, { _meta: { 'claudecode/toolUseId': 'tu-x' } });
        expect(res.content[0]!.text).toMatch(/Received paragraph/);
        const post = await callHook(options, 'PostToolUse', { tool_name: 'mcp__editor__propose_paragraph', tool_input: args, tool_response: res.content, tool_use_id: 'tu-x' });
        const out = (post.hookSpecificOutput as { updatedToolOutput: Array<{ text: string }> }).updatedToolOutput[0]!.text;
        expect(out).toMatch(/Faithfulness gate/);
      }
      yield success({ session: 'sess-9', modelUsage: { 'claude-opus-5-5': usage(cumulative, cumulative / 1000) } });
    };
    const req = { sectionId: 'sec:r', paragraphIds: null, fromNotes: false, file: 'main.tex', afterSentenceId: null };
    const j1 = await finish(ctx.agents.draft(req));
    expect(j1.state, j1.message).toBe('done');
    const first = h.calls[0]!.options;
    expect(first).toMatchObject({ model: 'claude-opus-5-5', persistSession: true, allowedTools: expect.arrayContaining(['mcp__editor__propose_paragraph', 'mcp__editor__get_facts']) });
    expect(first.resume).toBeUndefined();
    expect(first.outputFormat).toBeUndefined();
    const ev = ctx.events.find((e) => e.type === 'draft.proposed') as Extract<ServerMessage, { type: 'draft.proposed' }>;
    expect(ev.paragraphs[0]!.sentences.map((s) => s.state)).toEqual(['proposed', 'unsupported']);
    expect(ev.paragraphs[0]!.sentences[1]!.text).toBe('The gain reaches [fact?: value] points.');
    expect(JSON.parse(kv.get(DRAFTER_SESSION_KEY)!)).toMatchObject({ sessionId: 'sess-9', model: 'claude-opus-5-5' });

    const j2 = await finish(ctx.agents.draft(req));
    expect(j2.state, j2.message).toBe('done');
    expect(h.calls[1]!.options.resume).toBe('sess-9');
    // The resumed result carries cumulative totals (1000); only the new 500 are recorded.
    expect(recorded.map((r) => r.input)).toEqual([500, 500]);
  });

  it('fails clearly when the run stops before any paragraph, and warns when the skill is not discovered', async () => {
    const o = emptyOutline();
    o.sections = [{ id: 'sec:r', title: 'Results', question: 'q', template: null, ghostMode: 'auto-propose', provenance: 'author', paragraphs: [{ pid: 'p1', job: 'j', moves: [], claimIds: [], intentNotes: [], provenance: 'author', plan: { job: 'j', claimIds: [], said: {}, remaining: [] } }] }];
    await ctx.files.writeJson(project.paths.outline, Outline.parse(o));
    h.script = async function* () {
      yield init([]);
      yield { ...success({}), subtype: 'error_max_budget_usd', errors: ['budget of $5 exceeded'] };
    };
    const j = await finish(ctx.agents.draft({ sectionId: 'sec:r', paragraphIds: null, fromNotes: false, file: 'main.tex', afterSentenceId: null }));
    expect(j.state).toBe('error');
    expect(j.message).toMatch(/no paragraph.*budget/);
    expect(ctx.events.some((e) => e.type === 'job.progress' && /skill was not discovered/.test(e.message))).toBe(true);
    expect(ctx.events.some((e) => e.type === 'draft.proposed')).toBe(false);
  });
});
