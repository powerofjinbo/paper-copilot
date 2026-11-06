/**
 * The read-only PreToolUse guard every agent runs with.
 *
 * It is an allowlist, evaluated on every tool call (no matcher):
 * - Write, Edit, MultiEdit, NotebookEdit, Bash, PowerShell (and every other tool that writes, executes,
 *   reaches the network or spawns agents) are denied absolutely;
 * - Read, Glob and Grep must target a path whose real location (symlinks resolved) is inside one of the
 *   allowed roots: the analysis repo, the LaTeX tree, .paper/claude and the skill checkout;
 * - inside the analysis repo, Read is further limited to the globs the author confirmed
 *   (config.readerGlobs + config.factGlobs);
 * - secret-looking files (.env, keys, credential stores, .git/.ssh/.aws internals) are denied anywhere;
 * - Skill may load only the allowed skills; the role's own MCP tools and the CLI's StructuredOutput /
 *   ToolSearch helpers pass through.
 * A permitted call returns `{}` (no opinion), so the CLI's own deny rules and `dontAsk` still apply.
 * The guard never throws: an internal error is a denial.
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import type { HookCallback, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

export type RootKind = 'repo' | 'tex' | 'claude' | 'skill';

export interface ReadPolicy {
  roots: Array<{ dir: string; kind: RootKind }>;
  /** Globs relative to the repo root that Read may open (empty: any non-secret file in the repo). */
  repoGlobs: string[];
  /** Fully qualified MCP tool names the role may call. */
  mcpTools: string[];
  /** Skill names the Skill tool may load. */
  skills: string[];
  /** The agent's cwd (default search path for Glob/Grep, base for relative paths). */
  cwd: string;
}

export type GuardDecision = { allow: true } | { allow: false; reason: string };

/** Tools that change files, run commands, reach the network or spawn other agents. Never allowed. */
const NEVER = new Set([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'BashOutput', 'KillShell', 'KillBash', 'PowerShell',
  'WebFetch', 'WebSearch', 'Agent', 'Task', 'Workflow', 'Monitor', 'CronCreate', 'CronDelete', 'RemoteTrigger',
  'SendMessage', 'TodoWrite', 'EnterWorktree', 'ExitWorktree', 'LSP',
]);

/** CLI helpers with no file or network access. */
const HELPERS = new Set(['StructuredOutput', 'ToolSearch']);

const SECRET_SEGMENTS = new Set(['.git', '.ssh', '.aws', '.gnupg', '.docker', '.kube', '.azure']);
const SECRET_NAMES = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|kdbx)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.(netrc|npmrc|pypirc|git-credentials|htpasswd|pgpass)$/i,
  /^credentials(\.json)?$/i,
  /^secrets?\.(json|ya?ml|toml|env|txt)$/i,
];

const GLOB_CHARS = /[*?[\]{}]/;

/** Real path of `p`; for a path that does not exist yet, the real path of its deepest existing ancestor plus the rest. */
export function realOrNearest(p: string): string {
  const abs = resolve(p);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpathSync(cur);
      return rest.length ? join(real, ...rest.reverse()) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

function inside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function isSecretPath(p: string): boolean {
  const parts = resolve(p).split(/[\\/]+/).filter(Boolean);
  if (parts.some((s) => SECRET_SEGMENTS.has(s))) return true;
  const name = parts[parts.length - 1] ?? '';
  return SECRET_NAMES.some((re) => re.test(name));
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Glob patterns may not climb out of their base directory. */
function climbs(pattern: string): boolean {
  return pattern.split(/[\\/]+/).includes('..');
}

/** The literal directory prefix of a glob pattern ("/a/b/**\/*.md" -> "/a/b"). */
function staticPrefix(pattern: string): string {
  const parts = pattern.split(/[\\/]/);
  const out: string[] = [];
  for (const part of parts) {
    if (GLOB_CHARS.test(part)) break;
    out.push(part);
  }
  return out.join('/') || (pattern.startsWith('/') ? '/' : '.');
}

/**
 * A compiled policy: roots resolved once (both as given and with symlinks resolved).
 */
export class ReadOnlyPolicy {
  private readonly roots: Array<{ real: string; kind: RootKind }>;

  constructor(readonly policy: ReadPolicy) {
    this.roots = policy.roots.filter((r) => r.dir).map((r) => ({ real: realOrNearest(r.dir), kind: r.kind }));
  }

  private rootOf(realPath: string): { real: string; kind: RootKind } | null {
    // Longest root first, so a skill checkout inside the repo counts as the skill.
    let best: { real: string; kind: RootKind } | null = null;
    for (const r of this.roots) if (inside(realPath, r.real) && (!best || r.real.length > best.real.length)) best = r;
    return best;
  }

  /** May the agent see this path at all (directory or file)? */
  checkPath(raw: string, what: string, opts: { file: boolean }): GuardDecision {
    if (raw.includes('\0')) return { allow: false, reason: `${what}: invalid path` };
    if (/^\\\\|^\/\//.test(raw)) return { allow: false, reason: `${what}: network paths are not allowed` };
    const abs = isAbsolute(raw) ? raw : resolve(this.policy.cwd, raw);
    const real = realOrNearest(abs);
    if (isSecretPath(abs) || isSecretPath(real)) return { allow: false, reason: `${what}: ${raw} looks like a secret or credential file; agents never read it` };
    const root = this.rootOf(real);
    if (!root) {
      return {
        allow: false,
        reason: `${what}: ${raw} is outside the folders this agent may read (analysis repository, LaTeX tree, skill)`,
      };
    }
    if (opts.file && root.kind === 'repo' && this.policy.repoGlobs.length > 0 && real !== root.real) {
      const rel = relative(root.real, real).split(sep).join('/');
      if (!this.policy.repoGlobs.some((g) => posix.matchesGlob(rel, g))) {
        return { allow: false, reason: `${what}: ${rel} is not in the reading scope the author confirmed (${this.policy.repoGlobs.join(', ')})` };
      }
    }
    return { allow: true };
  }

  check(toolName: string, input: unknown): GuardDecision {
    const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    if (NEVER.has(toolName)) return { allow: false, reason: `paper-copilot agents are read-only: ${toolName} is never allowed` };
    if (HELPERS.has(toolName)) return { allow: true };
    if (toolName.startsWith('mcp__')) {
      return this.policy.mcpTools.includes(toolName) ? { allow: true } : { allow: false, reason: `${toolName} is not one of this agent's tools` };
    }
    switch (toolName) {
      case 'Skill': {
        const name = str(args.skill) ?? str(args.command) ?? str(args.name);
        if (name === null) return { allow: true }; // shape unknown: the session's `skills` list still filters
        const bare = name.replace(/^\//, '').split(/\s/)[0] ?? '';
        return this.policy.skills.includes(bare) ? { allow: true } : { allow: false, reason: `skill ${bare} is not enabled for this agent` };
      }
      case 'Read': {
        const p = str(args.file_path) ?? str(args.path);
        if (p === null) return { allow: false, reason: 'Read: no file_path given' };
        return this.checkPath(p, 'Read', { file: true });
      }
      case 'Glob': {
        const pattern = str(args.pattern);
        if (pattern === null) return { allow: false, reason: 'Glob: no pattern given' };
        if (climbs(pattern)) return { allow: false, reason: 'Glob: patterns may not contain ".."' };
        const base = str(args.path) ?? this.policy.cwd;
        const baseCheck = this.checkPath(base, 'Glob', { file: false });
        if (!baseCheck.allow) return baseCheck;
        if (isAbsolute(pattern)) return this.checkPath(staticPrefix(pattern), 'Glob', { file: false });
        return { allow: true };
      }
      case 'Grep': {
        const glob = str(args.glob);
        if (glob !== null && (climbs(glob) || isAbsolute(glob))) return { allow: false, reason: 'Grep: the glob filter may not leave the search folder' };
        const base = str(args.path) ?? this.policy.cwd;
        // A single file is a read: apply the file rules. A folder is a search: apply the folder rules.
        const looksLikeFile = /\.[A-Za-z0-9]{1,8}$/.test(base) && !GLOB_CHARS.test(base);
        return this.checkPath(base, 'Grep', { file: looksLikeFile });
      }
      default:
        return { allow: false, reason: `${toolName} is not available to paper-copilot agents (read-only: Read, Glob, Grep, Skill)` };
    }
  }
}

export function denyOutput(reason: string): HookJSONOutput {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

/**
 * The PreToolUse hook callback. `onDecision` sees every decision (for job progress and logs).
 */
export function createReadOnlyGuard(policy: ReadPolicy, onDecision?: (tool: string, decision: GuardDecision) => void): HookCallback {
  const compiled = new ReadOnlyPolicy(policy);
  return async (input) => {
    try {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const decision = compiled.check(input.tool_name, input.tool_input);
      onDecision?.(input.tool_name, decision);
      return decision.allow ? {} : denyOutput(decision.reason);
    } catch (e) {
      return denyOutput(`read-only guard error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}
