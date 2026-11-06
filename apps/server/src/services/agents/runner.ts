/**
 * Real-mode execution of one Agent SDK query. The SDK module is imported lazily here and nowhere else,
 * so fake mode (tests, no API key) never loads it or spawns the Claude Code process.
 */
import type { ModelUsage, Options, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '../../contracts';
import { SKILL_NAME } from './options';

export type Sdk = typeof import('@anthropic-ai/claude-agent-sdk');

let sdkPromise: Promise<Sdk> | null = null;
export function loadSdk(): Promise<Sdk> {
  sdkPromise ??= import('@anthropic-ai/claude-agent-sdk');
  return sdkPromise;
}

export interface RunSpec {
  label: string;
  prompt: string;
  options: Options;
  timeoutMs: number;
  progress: (message: string) => void;
  log: Logger;
}

export interface RunOutcome {
  ok: boolean;
  /** Result subtype ('success', 'error_max_budget_usd', ...) or 'no_result'. */
  subtype: string;
  errors: string[];
  /** Final assistant text (success only). */
  result: string | null;
  structured: unknown;
  sessionId: string | null;
  modelUsage: Record<string, ModelUsage>;
  costUsd: number;
  numTurns: number;
  /** Skills listed by the init message (null if no init message arrived). */
  skills: string[] | null;
  /** True once the model produced any output (a failed resume produces none). */
  sawAssistant: boolean;
  timedOut: boolean;
  /** The credential source the init message reported (null if no init message arrived). */
  apiKeySource: string | null;
  /** True when the run was stopped because the CLI did not use the app's API key. */
  refusedAuth: boolean;
  /** Set when the run was stopped on an API error that retrying cannot fix (bad key, billing, unknown model). */
  fatalApiError: string | null;
}

/**
 * API errors the Claude Code process retries (with backoff, for minutes) although a retry cannot help:
 * a rejected key, a billing or account problem, an unknown model. The run is stopped at the first one.
 */
const FATAL_API_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'billing_error', 'model_not_found', 'invalid_request', 'cloud_credential_error']);

const FATAL_HINT: Record<string, string> = {
  authentication_failed: 'the API key was rejected; check ANTHROPIC_API_KEY or the "paper-copilot" keychain entry (paper doctor)',
  billing_error: 'the Anthropic account has a billing problem (credit balance)',
  model_not_found: 'the model is not available to this key; check the model names in .paper/project.json',
};

/** The message for a fatal api_retry event, or null when retrying is reasonable (429, 529, 5xx, network). */
export function fatalRetryReason(m: { error?: string | null; error_status?: number | null }): string | null {
  const status = typeof m.error_status === 'number' ? m.error_status : null;
  const kind = m.error ?? 'unknown';
  if (!FATAL_API_ERRORS.has(kind) && status !== 401 && status !== 403) return null;
  const hint = FATAL_HINT[kind] ?? (status === 401 ? FATAL_HINT.authentication_failed : 'retrying cannot fix it');
  return `the Anthropic API refused the request (${status ?? 'no status'} ${kind}): ${hint}; stopped instead of retrying`;
}

/** One line describing a tool call, for job progress (never the file contents). */
export function describeToolUse(name: string, input: unknown): string | null {
  if (name === 'StructuredOutput' || name === 'ToolSearch') return null;
  const a = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const target = [a.file_path, a.pattern, a.path, a.skill, a.section_id, a.pid, a.query, a.key].find((v) => typeof v === 'string' && v.length > 0);
  const short = name.replace(/^mcp__editor__/, '');
  return target ? `${short}: ${String(target).slice(0, 160)}` : short;
}

export async function runAgentQuery(spec: RunSpec): Promise<RunOutcome> {
  const sdk = await loadSdk();
  const out: RunOutcome = {
    ok: false,
    subtype: 'no_result',
    errors: [],
    result: null,
    structured: undefined,
    sessionId: null,
    modelUsage: {},
    costUsd: 0,
    numTurns: 0,
    skills: null,
    sawAssistant: false,
    timedOut: false,
    apiKeySource: null,
    refusedAuth: false,
    fatalApiError: null,
  };
  const controller = spec.options.abortController;
  const timer = setTimeout(() => {
    out.timedOut = true;
    controller?.abort();
  }, spec.timeoutMs);
  timer.unref?.();

  let final: SDKResultMessage | null = null;
  const q = sdk.query({ prompt: spec.prompt, options: spec.options });
  try {
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        out.sessionId = msg.session_id;
        out.skills = msg.skills;
        out.apiKeySource = msg.apiKeySource ?? null;
        spec.log.debug(`${spec.label}: session initialised`, {
          model: msg.model,
          permissionMode: msg.permissionMode,
          apiKeySource: msg.apiKeySource,
          skills: msg.skills,
          tools: msg.tools,
          mcpServers: msg.mcp_servers,
          cwd: msg.cwd,
        });
        // The app passes its own key as ANTHROPIC_API_KEY (options.ts buildAgentEnv). Any other source
        // (a /login subscription, an OAuth token, an apiKeyHelper from settings) is another account:
        // stop before the first model call is billed to it.
        if (msg.apiKeySource !== 'ANTHROPIC_API_KEY') {
          out.errors.push(`the agent would not use the app's API key (Claude Code reports the credential source "${String(msg.apiKeySource)}"); stopped`);
          out.refusedAuth = true;
          controller?.abort();
          break;
        }
        if (!msg.skills.includes(SKILL_NAME)) {
          spec.log.warn(`${spec.label}: the ${SKILL_NAME} skill was not discovered; SKILL.md is still in the system prompt`, { cwd: msg.cwd, skills: msg.skills });
          spec.progress(`warning: the ${SKILL_NAME} skill was not discovered (check .paper/claude/.claude/skills)`);
        }
      } else if (msg.type === 'assistant') {
        out.sawAssistant = true;
        if (msg.parent_tool_use_id !== null) continue;
        for (const block of msg.message.content) {
          if (block.type !== 'tool_use') continue;
          const line = describeToolUse(block.name, block.input);
          if (line) spec.progress(line);
        }
      } else if (msg.type === 'system' && msg.subtype === 'api_retry') {
        // The CLI retries on its own (up to ~10 times with backoff). Transient errors are shown as
        // progress; one that a retry cannot fix (a rejected key) stops the run now instead of after
        // minutes of backoff or the role timeout.
        const fatal = fatalRetryReason(msg);
        if (fatal) {
          out.fatalApiError = fatal;
          out.errors.push(fatal);
          spec.log.warn(`${spec.label}: ${fatal}`);
          controller?.abort();
          break;
        }
        spec.progress(`API ${msg.error_status ?? 'connection'} error (${msg.error}); retry ${msg.attempt} of ${msg.max_retries} in ${Math.max(1, Math.round(msg.retry_delay_ms / 1000))} s`);
      } else if (msg.type === 'result') {
        final = msg;
      }
    }
  } catch (e) {
    // A single-shot query() throws after yielding an error result; keep that result if we have it.
    const m = e instanceof Error ? e.message : String(e);
    if (!final && !out.refusedAuth && !out.fatalApiError) out.errors.push(out.timedOut ? `timed out after ${Math.round(spec.timeoutMs / 1000)} s` : m);
    spec.log.debug(`${spec.label}: query ended with an exception`, m);
  } finally {
    clearTimeout(timer);
    try {
      q.close();
    } catch {
      /* already closed */
    }
  }

  if (out.refusedAuth) {
    out.subtype = 'refused_auth';
    out.ok = false;
    return out;
  }
  if (out.fatalApiError) {
    out.subtype = 'error_api';
    out.ok = false;
    return out;
  }
  if (final) {
    out.subtype = final.subtype;
    out.sessionId = final.session_id ?? out.sessionId;
    out.modelUsage = final.modelUsage ?? {};
    out.costUsd = final.total_cost_usd ?? 0;
    out.numTurns = final.num_turns ?? 0;
    if (final.subtype === 'success') {
      out.result = final.result;
      out.structured = final.structured_output;
      out.ok = !final.is_error;
      if (final.is_error) out.errors.push(final.result || 'the model API returned an error');
    } else {
      out.errors.push(...(final.errors ?? []));
      if (out.errors.length === 0) out.errors.push(final.subtype.replace(/^error_/, '').replace(/_/g, ' '));
    }
  }
  if (out.timedOut && !out.errors.some((e) => e.startsWith('timed out'))) out.errors.push(`timed out after ${Math.round(spec.timeoutMs / 1000)} s`);
  return out;
}
