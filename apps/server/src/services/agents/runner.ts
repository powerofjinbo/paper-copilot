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
      } else if (msg.type === 'result') {
        final = msg;
      }
    }
  } catch (e) {
    // A single-shot query() throws after yielding an error result; keep that result if we have it.
    const m = e instanceof Error ? e.message : String(e);
    if (!final) out.errors.push(out.timedOut ? `timed out after ${Math.round(spec.timeoutMs / 1000)} s` : m);
    spec.log.debug(`${spec.label}: query ended with an exception`, m);
  } finally {
    clearTimeout(timer);
    try {
      q.close();
    } catch {
      /* already closed */
    }
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
