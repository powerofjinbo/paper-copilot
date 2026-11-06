import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { buildQueryOptions, DISALLOWED_TOOLS, draftMaxTurns, ISOLATION_ENV, READ_ONLY_TOOLS } from '../src/services/agents/options';
import { ensureSkillLink, skillLinkPath } from '../src/services/agents/skill';
import { deltaTotals, toCoreUsage, totalsByModel, totalsOf } from '../src/services/agents/usage';
import { SKILL_DIR } from './helpers/ctx';

const guard: HookCallback = async () => ({});
const gate: HookCallback = async () => ({});

function base(over: Partial<Parameters<typeof buildQueryOptions>[0]> = {}) {
  return buildQueryOptions({
    role: 'drafter',
    model: 'claude-opus-5-5',
    claudeCwd: '/p/.paper/claude',
    repoDir: '/p/repo',
    texRoot: '/p/tex',
    skillDir: '/skills/hep-paper-writing',
    systemPrompt: 'BLOCK A\n\nBLOCK B',
    outputSchema: null,
    maxBudgetUsd: 5,
    maxTurns: 28,
    guard,
    mcpServers: { editor: { type: 'sdk', name: 'editor', instance: {} as never } },
    mcpTools: ['mcp__editor__get_facts', 'mcp__editor__propose_paragraph'],
    hooks: { PostToolUse: [{ matcher: 'mcp__editor__propose_paragraph', hooks: [gate] }] },
    resume: 'sess-1',
    persistSession: true,
    abortController: new AbortController(),
    baseEnv: { PATH: '/usr/bin', HOME: '/home/u', ANTHROPIC_API_KEY: 'inherited-key', ANTHROPIC_BASE_URL: 'https://other-tool.example', ANTHROPIC_AUTH_TOKEN: 't', CLAUDECODE: '1' },
    auth: { apiKey: 'k', baseUrl: 'https://api.anthropic.com' },
    ...over,
  });
}

describe('buildQueryOptions (real-mode SDK options, verified without a key)', () => {
  it('matches the required read-only, skill-loading configuration (snapshot)', () => {
    const o = base();
    const { abortController, hooks, mcpServers, ...rest } = o;
    expect(abortController).toBeInstanceOf(AbortController);
    expect(rest).toEqual({
      model: 'claude-opus-5-5',
      cwd: '/p/.paper/claude',
      additionalDirectories: ['/p/repo', '/p/tex', '/skills/hep-paper-writing'],
      settingSources: ['project'],
      skills: ['hep-paper-writing'],
      tools: ['Read', 'Glob', 'Grep', 'Skill'],
      disallowedTools: ['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'NotebookEdit'],
      allowedTools: ['mcp__editor__get_facts', 'mcp__editor__propose_paragraph'],
      permissionMode: 'dontAsk',
      systemPrompt: 'BLOCK A\n\nBLOCK B',
      maxBudgetUsd: 5,
      maxTurns: 28,
      effort: 'high',
      env: {
        PATH: '/usr/bin',
        HOME: '/home/u',
        // the app's own key and endpoint (as the direct client), never the inherited ones
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        ANTHROPIC_API_KEY: 'k',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
        CLAUDE_AGENT_SDK_CLIENT_APP: 'paper-copilot',
      },
      includePartialMessages: false,
      persistSession: true,
      strictMcpConfig: true,
      resume: 'sess-1',
    });
    expect(Object.keys(mcpServers ?? {})).toEqual(['editor']);
    // The guard sees every tool (no matcher) and blocks when it fails; the gate hook is kept.
    expect(hooks?.PreToolUse).toEqual([{ hooks: [guard], onFailure: 'block' }]);
    expect(hooks?.PostToolUse).toEqual([{ matcher: 'mcp__editor__propose_paragraph', hooks: [gate] }]);
  });

  it('never bypasses permissions and never pre-approves the file tools', () => {
    for (const role of ['repo-reader', 'outliner', 'drafter', 'referee', 'memo'] as const) {
      const o = base({ role, mcpTools: [], mcpServers: undefined, hooks: undefined, resume: null, persistSession: false });
      expect(o.permissionMode).toBe('dontAsk');
      expect(o.allowDangerouslySkipPermissions).toBeUndefined();
      // Read/Glob/Grep are not in allowedTools: dontAsk denies reads outside the working directories.
      expect(o.allowedTools).toEqual([]);
      expect(o.tools).toEqual([...READ_ONLY_TOOLS]);
      expect(o.disallowedTools).toEqual([...DISALLOWED_TOOLS]);
      expect(o.env).toMatchObject(ISOLATION_ENV);
      expect(o.resume).toBeUndefined();
      expect(o.mcpServers).toBeUndefined();
    }
  });

  it('adds the structured output format for one-shot roles', () => {
    const schema = { type: 'object', properties: { brief_markdown: { type: 'string' } }, required: ['brief_markdown'], additionalProperties: false };
    const o = base({ role: 'repo-reader', model: 'claude-sonnet-5-5', outputSchema: schema, mcpTools: [], mcpServers: undefined, resume: null, persistSession: false, repoDir: null });
    expect(o.outputFormat).toEqual({ type: 'json_schema', schema });
    expect(o.allowedTools).toEqual(['StructuredOutput']);
    expect(o.additionalDirectories).toEqual(['/p/tex', '/skills/hep-paper-writing']);
    expect(o.effort).toBe('medium');
    expect(o.persistSession).toBe(false);
  });

  it('bounds the drafter turns by paragraph count', () => {
    expect(draftMaxTurns(1)).toBe(20);
    expect(draftMaxTurns(2)).toBe(28);
    expect(draftMaxTurns(50)).toBe(80);
  });
});

describe('skill symlink', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const fresh = () => {
    const d = mkdtempSync(join(tmpdir(), 'paper-skill-'));
    dirs.push(d);
    return join(d, 'claude');
  };

  it('creates .claude/skills/hep-paper-writing pointing at the skill checkout', async () => {
    const cwd = fresh();
    const r = await ensureSkillLink(cwd, SKILL_DIR);
    const link = skillLinkPath(cwd);
    expect(r.action).toBe('created');
    expect(r.skillFound).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(SKILL_DIR));
    expect(existsSync(join(link, 'SKILL.md'))).toBe(true);
    expect((await ensureSkillLink(cwd, SKILL_DIR)).action).toBe('ok');
  });

  it('repairs a dangling or wrong link and moves a real directory aside', async () => {
    const cwd = fresh();
    const link = skillLinkPath(cwd);
    mkdirSync(join(cwd, '.claude', 'skills'), { recursive: true });
    symlinkSync(join(cwd, 'nowhere'), link, 'dir');
    expect((await ensureSkillLink(cwd, SKILL_DIR)).action).toBe('repaired');
    expect(realpathSync(link)).toBe(realpathSync(SKILL_DIR));

    rmSync(link);
    mkdirSync(link);
    writeFileSync(join(link, 'note.txt'), 'kept');
    const r = await ensureSkillLink(cwd, SKILL_DIR);
    expect(r.action).toBe('replaced-directory');
    expect(readlinkSync(link)).toBe(SKILL_DIR);
  });

  it('reports a missing skill', async () => {
    const cwd = fresh();
    const r = await ensureSkillLink(cwd, join(cwd, 'no-skill-here'));
    expect(r.skillFound).toBe(false);
  });
});

describe('usage accounting', () => {
  const mu = { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 1000, cacheCreationInputTokens: 300, cacheCreationEphemeral1hInputTokens: 200, costUSD: 0.5, webSearchRequests: 0, contextWindow: 1, maxOutputTokens: 1 };

  it('converts SDK model usage to core usage, unattributed cache writes at the 5m rate', () => {
    expect(toCoreUsage(totalsOf(mu))).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
    });
  });

  it('subtracts the totals a resumed session carries over, and survives a reset', () => {
    const prev = totalsOf({ ...mu, inputTokens: 40, outputTokens: 10, cacheReadInputTokens: 400, cacheCreationInputTokens: 100, cacheCreationEphemeral1hInputTokens: 50, costUSD: 0.2 });
    const d = deltaTotals(totalsOf(mu), prev);
    expect(d.inputTokens).toBe(60);
    expect(d.cacheCreation1hInputTokens).toBe(150);
    expect(d.costUsd).toBeCloseTo(0.3);
    const reset = deltaTotals(totalsOf({ ...mu, inputTokens: 5 }), prev);
    expect(reset.inputTokens).toBe(5);
    expect(Object.keys(totalsByModel({ 'claude-opus-5-5': mu }))).toEqual(['claude-opus-5-5']);
  });
});
