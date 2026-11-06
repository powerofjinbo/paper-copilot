/**
 * Real-mode Agent SDK configuration, built by one pure function so it can be verified without an API
 * key (docs/design.md, "Grounding pipeline" and "Architecture").
 *
 * Every agent runs read-only:
 * - built-in tools limited to Read/Glob/Grep/Skill (`tools` = availability), plus the MCP tools a role
 *   needs (pre-approved by exact name in `allowedTools`);
 * - write, shell, network and notebook tools removed (`disallowedTools`);
 * - `permissionMode: 'dontAsk'`, so anything not pre-approved and not a plain read inside a working
 *   directory is denied instead of prompting (there is nobody to prompt);
 * - a PreToolUse guard (guard.ts) that denies writes absolutely and reads outside the allowed roots,
 *   registered with `onFailure: 'block'` so a crashing guard blocks rather than allows;
 * - `bypassPermissions` is never used; `maxBudgetUsd` and `maxTurns` bound every run.
 *
 * Skill loading: `cwd` is `.paper/claude`, which holds `.claude/skills/hep-paper-writing` (a symlink to
 * the author's skill checkout); `settingSources: ['project']` makes the CLI discover it and
 * `skills: ['hep-paper-writing']` enables only that skill. The analysis repo, the LaTeX tree and the
 * skill checkout come in through `additionalDirectories`.
 *
 * This module imports SDK *types* only; the SDK runtime is loaded lazily by runner.ts in real mode.
 */
import type { HookCallback, HookCallbackMatcher, HookEvent, McpServerConfig, Options } from '@anthropic-ai/claude-agent-sdk';

export const SKILL_NAME = 'hep-paper-writing';

/** Built-in tools every agent may use (availability). */
export const READ_ONLY_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep', 'Skill'];

/** Built-in tools removed from every agent's context (bare names remove the tool definition). */
export const DISALLOWED_TOOLS: readonly string[] = ['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'NotebookEdit'];

/** Environment variables that isolate the Claude Code process from the user's own Claude setup. */
export const ISOLATION_ENV: Readonly<Record<string, string>> = {
  /** No auto-memory files are read or written. */
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  /** No built-in general-purpose subagent (agents here are single, subagent-free queries). */
  CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
  /** No telemetry, error reporting or auto-update traffic from a tool that reads unpublished results. */
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  /** Identifies the app in the User-Agent header. */
  CLAUDE_AGENT_SDK_CLIENT_APP: 'paper-copilot',
};

/** The agent roles of this service. */
export type AgentRole = 'repo-reader' | 'outliner' | 'drafter' | 'referee' | 'memo';

/** Per-role bounds. Turns count model round-trips; a tool call costs one. */
export const ROLE_LIMITS: Record<AgentRole, { maxTurns: number; timeoutMs: number; effort: 'low' | 'medium' | 'high' }> = {
  'repo-reader': { maxTurns: 60, timeoutMs: 20 * 60_000, effort: 'medium' },
  outliner: { maxTurns: 12, timeoutMs: 10 * 60_000, effort: 'high' },
  drafter: { maxTurns: 80, timeoutMs: 25 * 60_000, effort: 'high' },
  referee: { maxTurns: 16, timeoutMs: 10 * 60_000, effort: 'medium' },
  memo: { maxTurns: 6, timeoutMs: 5 * 60_000, effort: 'low' },
};

/** Turn budget for drafting `n` paragraphs: a few lookups plus up to two proposals per paragraph. */
export function draftMaxTurns(paragraphs: number): number {
  return Math.min(ROLE_LIMITS.drafter.maxTurns, 12 + 8 * Math.max(1, paragraphs));
}

export interface QueryOptionsInput {
  role: AgentRole;
  model: string;
  /** .paper/claude */
  claudeCwd: string;
  /** Absolute; null when no analysis repository is configured. */
  repoDir: string | null;
  texRoot: string;
  skillDir: string;
  systemPrompt: string;
  /** JSON schema for the final structured output, or null (the drafter returns paragraphs through a tool). */
  outputSchema: Record<string, unknown> | null;
  maxBudgetUsd: number;
  maxTurns: number;
  /** The PreToolUse read-only guard (guard.ts). */
  guard: HookCallback;
  /** In-process MCP servers by name (e.g. { editor }). */
  mcpServers?: Record<string, McpServerConfig>;
  /** Fully qualified MCP tool names this role may call (mcp__<server>__<tool>). */
  mcpTools?: string[];
  /** Extra hooks (e.g. the drafter's PostToolUse gate on propose_paragraph). */
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** Session to resume (drafter only). */
  resume?: string | null;
  /** Keep the transcript on disk (needed to resume); one-shot jobs do not persist. */
  persistSession: boolean;
  abortController: AbortController;
  /** Environment the Claude Code process inherits; ISOLATION_ENV is applied on top. */
  baseEnv: Record<string, string | undefined>;
  /** Receives the CLI's stderr (logged at debug level). */
  stderr?: (data: string) => void;
}

/** Unique, non-empty absolute directories in order. */
function dirs(list: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const d of list) if (d && !out.includes(d)) out.push(d);
  return out;
}

/** Build the `query()` options for one agent run. Pure: no I/O, no SDK runtime. */
export function buildQueryOptions(i: QueryOptionsInput): Options {
  const mcpTools = [...new Set(i.mcpTools ?? [])];
  const allowedTools = [...mcpTools];
  // The CLI adds StructuredOutput itself when outputFormat is set; pre-approve it explicitly so that
  // dontAsk can never turn the final answer into a denial.
  if (i.outputSchema) allowedTools.push('StructuredOutput');

  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
    ...(i.hooks ?? {}),
    // No matcher: the guard sees every tool call and decides itself (an allowlist, see guard.ts).
    PreToolUse: [{ hooks: [i.guard], onFailure: 'block' }, ...(i.hooks?.PreToolUse ?? [])],
  };

  const options: Options = {
    model: i.model,
    cwd: i.claudeCwd,
    additionalDirectories: dirs([i.repoDir, i.texRoot, i.skillDir]),
    settingSources: ['project'],
    skills: [SKILL_NAME],
    tools: [...READ_ONLY_TOOLS],
    disallowedTools: [...DISALLOWED_TOOLS],
    allowedTools,
    permissionMode: 'dontAsk',
    systemPrompt: i.systemPrompt,
    hooks,
    maxBudgetUsd: i.maxBudgetUsd,
    maxTurns: i.maxTurns,
    effort: ROLE_LIMITS[i.role].effort,
    env: { ...i.baseEnv, ...ISOLATION_ENV },
    abortController: i.abortController,
    includePartialMessages: false,
    persistSession: i.persistSession,
    strictMcpConfig: true,
  };
  if (i.mcpServers && Object.keys(i.mcpServers).length > 0) options.mcpServers = i.mcpServers;
  if (i.outputSchema) options.outputFormat = { type: 'json_schema', schema: i.outputSchema };
  if (i.resume) options.resume = i.resume;
  if (i.stderr) options.stderr = i.stderr;
  return options;
}
