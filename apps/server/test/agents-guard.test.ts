import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HookCallback, PreToolUseHookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { createReadOnlyGuard, isSecretPath, ReadOnlyPolicy, type ReadPolicy } from '../src/services/agents/guard';

let base: string;
let policy: ReadPolicy;
let guard: HookCallback;
const decisions: Array<{ tool: string; allow: boolean }> = [];

function pre(tool: string, input: Record<string, unknown>): PreToolUseHookInput {
  return { hook_event_name: 'PreToolUse', session_id: 's', transcript_path: '', cwd: policy.cwd, tool_name: tool, tool_input: input, tool_use_id: 't1' };
}

async function decide(tool: string, input: Record<string, unknown>): Promise<{ denied: boolean; reason: string }> {
  const out = (await guard(pre(tool, input), 't1', { signal: new AbortController().signal })) as SyncHookJSONOutput;
  const spec = out.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string } | undefined;
  return { denied: spec?.permissionDecision === 'deny', reason: spec?.permissionDecisionReason ?? '' };
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'paper-guard-'));
  for (const d of ['repo/results', 'repo/docs', 'repo/src', 'tex', '.paper/claude/.claude/skills', 'skill/references', 'outside']) mkdirSync(join(base, d), { recursive: true });
  writeFileSync(join(base, 'repo/README.md'), '# r\n');
  writeFileSync(join(base, 'repo/results/a_claim.json'), '{"x": 1}');
  writeFileSync(join(base, 'repo/src/train.py'), 'print(1)\n');
  writeFileSync(join(base, 'repo/.env'), 'ANTHROPIC_API_KEY=sk-ant-xxx\n');
  writeFileSync(join(base, 'tex/main.tex'), '\\documentclass{article}\n');
  writeFileSync(join(base, 'skill/SKILL.md'), '---\nname: hep-paper-writing\n---\n');
  writeFileSync(join(base, 'skill/references/x.md'), 'ref\n');
  writeFileSync(join(base, 'outside/notes.txt'), 'top secret\n');
  writeFileSync(join(base, '.paper/paper.db'), 'db');
  symlinkSync(join(base, 'skill'), join(base, '.paper/claude/.claude/skills/hep-paper-writing'), 'dir');
  // A symlink inside the repo that points outside every root.
  symlinkSync(join(base, 'outside'), join(base, 'repo/results/escape'), 'dir');
  policy = {
    roots: [
      { dir: join(base, 'repo'), kind: 'repo' },
      { dir: join(base, 'tex'), kind: 'tex' },
      { dir: join(base, '.paper/claude'), kind: 'claude' },
      { dir: join(base, 'skill'), kind: 'skill' },
    ],
    repoGlobs: ['README.md', 'docs/**/*.md', 'results/**/*.{json,csv,md}'],
    mcpTools: ['mcp__editor__get_facts', 'mcp__editor__propose_paragraph'],
    skills: ['hep-paper-writing'],
    cwd: join(base, '.paper/claude'),
  };
  guard = createReadOnlyGuard(policy, (tool, d) => decisions.push({ tool, allow: d.allow }));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('read-only PreToolUse guard', () => {
  it('denies every write, shell and network tool absolutely, whatever the input', async () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'Agent', 'Task']) {
      const r = await decide(tool, { file_path: join(base, 'repo/README.md'), command: 'ls', content: 'x' });
      expect(r.denied, tool).toBe(true);
      expect(r.reason).toMatch(/read-only|never allowed/);
    }
  });

  it('allows reads inside the roots and passes them on without approving them', async () => {
    const out = await guard(pre('Read', { file_path: join(base, 'repo/results/a_claim.json') }), 't', { signal: new AbortController().signal });
    expect(out).toEqual({}); // no opinion: the CLI's deny rules and dontAsk still apply
    expect((await decide('Read', { file_path: join(base, 'tex/main.tex') })).denied).toBe(false);
    expect((await decide('Read', { file_path: join(base, 'repo/README.md') })).denied).toBe(false);
    // The skill through its symlink in .paper/claude, and directly.
    expect((await decide('Read', { file_path: join(base, '.paper/claude/.claude/skills/hep-paper-writing/references/x.md') })).denied).toBe(false);
    expect((await decide('Read', { file_path: join(base, 'skill/SKILL.md') })).denied).toBe(false);
  });

  it('denies reads outside the roots, including the sidecar database and relative escapes', async () => {
    for (const p of [join(base, 'outside/notes.txt'), '/etc/passwd', join(base, '.paper/paper.db'), '../paper.db', join(base, 'repo/../outside/notes.txt')]) {
      const r = await decide('Read', { file_path: p });
      expect(r.denied, p).toBe(true);
    }
  });

  it('denies a symlink that escapes a root (real path checked)', async () => {
    const r = await decide('Read', { file_path: join(base, 'repo/results/escape/notes.txt') });
    expect(r.denied).toBe(true);
    expect(r.reason).toMatch(/outside/);
  });

  it('limits repo reads to the confirmed globs and never opens secret files', async () => {
    expect((await decide('Read', { file_path: join(base, 'repo/src/train.py') })).reason).toMatch(/reading scope/);
    const env = await decide('Read', { file_path: join(base, 'repo/.env') });
    expect(env.denied).toBe(true);
    expect(env.reason).toMatch(/secret/);
    expect(isSecretPath('/x/.git/config')).toBe(true);
    expect(isSecretPath('/x/id_ed25519')).toBe(true);
    expect(isSecretPath('/x/results/a.json')).toBe(false);
  });

  it('checks Glob and Grep search folders and patterns', async () => {
    expect((await decide('Glob', { pattern: '**/*.json', path: join(base, 'repo') })).denied).toBe(false);
    expect((await decide('Glob', { pattern: '**/*.md' })).denied).toBe(false); // default: the agent cwd
    expect((await decide('Glob', { pattern: '../../**' , path: join(base, 'repo') })).denied).toBe(true);
    expect((await decide('Glob', { pattern: '/etc/*' })).denied).toBe(true);
    expect((await decide('Glob', { pattern: '*', path: '/home' })).denied).toBe(true);
    expect((await decide('Grep', { pattern: 'eff', path: join(base, 'repo/results') })).denied).toBe(false);
    expect((await decide('Grep', { pattern: 'KEY', path: join(base, 'repo/.env') })).denied).toBe(true);
    expect((await decide('Grep', { pattern: 'x', path: join(base, 'outside') })).denied).toBe(true);
    expect((await decide('Grep', { pattern: 'x', path: join(base, 'repo'), glob: '../**' })).denied).toBe(true);
  });

  it("allows only the role's MCP tools, the enabled skill and the CLI helpers", async () => {
    expect((await decide('mcp__editor__get_facts', { query: 'eff' })).denied).toBe(false);
    expect((await decide('mcp__editor__delete_everything', {})).denied).toBe(true);
    expect((await decide('mcp__other__x', {})).denied).toBe(true);
    expect((await decide('Skill', { skill: 'hep-paper-writing' })).denied).toBe(false);
    expect((await decide('Skill', { skill: 'some-other-skill' })).denied).toBe(true);
    expect((await decide('StructuredOutput', { anything: 1 })).denied).toBe(false);
    expect((await decide('SomeFutureTool', {})).denied).toBe(true);
  });

  it('fails closed on malformed input and ignores other events', async () => {
    expect((await decide('Read', {})).denied).toBe(true);
    expect((await decide('Read', { file_path: 'a\0b' })).denied).toBe(true);
    const other = await guard({ hook_event_name: 'PostToolUse', session_id: 's', transcript_path: '', cwd: '', tool_name: 'Read', tool_input: {}, tool_response: '', tool_use_id: 't' }, 't', { signal: new AbortController().signal });
    expect(other).toEqual({});
    expect(decisions.length).toBeGreaterThan(10);
    expect(new ReadOnlyPolicy(policy).check('Read', null).allow).toBe(false);
  });
});
