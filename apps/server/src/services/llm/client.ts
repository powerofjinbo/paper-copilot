/**
 * The LLM client: one `complete()` for every direct-API route (ghost, actions, memo...), on the official
 * @anthropic-ai/sdk (1.6), plus a deterministic fake for tests and keyless runs (./fake.ts).
 *
 * Request rules (claude-api skill, Haiku 5.5 / Sonnet 5.5 / Opus 5.5):
 * - `system` is sent as text blocks carrying the `cache_control` the prompt builder put on them
 *   (block A ttl 1h, blocks B and C 5m); no top-level automatic caching, so the volatile tail is never
 *   written to the cache.
 * - thinking: Haiku 5.5 `{type:'disabled'}` (accepted at effort <= high); Sonnet 5.5 never 'disabled'
 *   (a 400): `{type:'between_tools'}` to keep thinking off; Opus 5.5 / Fable / Mythos cannot turn it off
 *   at all, so they get `{type:'adaptive'}` and the low effort keeps them short.
 * - `output_config: {effort, format: {type:'json_schema', schema}}` (the SDK 1.6 types carry
 *   output_config natively, so no extra-body mechanism is needed).
 * - temperature / top_p / top_k are NEVER sent (rejected on current models; the SDK 1.6 params type does
 *   not even have them).
 * - Streaming always, so TTFT can be measured from the first text delta.
 * - Retries: none on the ghost route (latency matters; a stale ghost is worthless); up to 2 with
 *   exponential backoff + jitter on 429 / 529 / overloaded / 5xx / connection errors for other routes.
 *   The SDK's own retries are disabled (maxRetries 0) so the two never stack.
 * - The API key is passed explicitly (never read from other env vars by the SDK) and `baseURL` is
 *   passed explicitly (PAPER_ANTHROPIC_BASE_URL or the public API), so ANTHROPIC_BASE_URL set by the
 *   environment for another tool is not inherited silently.
 */
import Anthropic from '@anthropic-ai/sdk';
import { costOf, type Usage } from '@paper-copilot/core';
import type { LlmClient, LlmRequest, LlmResponse, Logger } from '../../contracts';
import { DEFAULT_BASE_URL } from './apiKey';
import { createFakeLlmClient, type FakeResponder } from './fake';

/* ------------------------------------------------------------------------------------ */
/* Errors                                                                                */
/* ------------------------------------------------------------------------------------ */

/** Thrown when a request was cancelled through its AbortSignal. */
export class LlmAbortError extends Error {
  constructor(message = 'request aborted') {
    super(message);
    this.name = 'LlmAbortError';
  }
}

export function isAbortError(e: unknown): boolean {
  if (e instanceof LlmAbortError) return true;
  if (e instanceof Anthropic.APIUserAbortError) return true;
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'LlmAbortError');
}

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const RETRY_TYPES = new Set(['overloaded_error', 'rate_limit_error', 'api_error', 'timeout_error']);

/** 429 / 529 / overloaded / 5xx / connection errors are worth a retry; 4xx client errors are not. */
export function isRetryable(e: unknown): boolean {
  if (isAbortError(e)) return false;
  if (e instanceof Anthropic.APIConnectionError) return true;
  if (e instanceof Anthropic.APIError) {
    if (typeof e.status === 'number' && RETRY_STATUS.has(e.status)) return true;
    const type = (e as { type?: string | null }).type ?? (e.error as { error?: { type?: string } } | undefined)?.error?.type ?? null;
    return typeof type === 'string' && RETRY_TYPES.has(type);
  }
  return false;
}

/** Backoff for retry `attempt` (0-based): honour retry-after (capped), else 0.5 s * 2^attempt with +-50% jitter. */
export function retryDelayMs(e: unknown, attempt: number, rand: () => number = Math.random): number {
  const headers = e instanceof Anthropic.APIError ? (e.headers as Headers | undefined) : undefined;
  const ra = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  const secs = ra != null ? Number(ra) : NaN;
  if (Number.isFinite(secs) && secs >= 0) return Math.min(8000, Math.round(secs * 1000)) + Math.round(rand() * 250);
  const base = 500 * 2 ** attempt;
  return Math.round(base * (0.5 + rand()));
}

/** A short, key-free description of an error for logs and for the UI. */
export function describeError(e: unknown): string {
  if (e instanceof Anthropic.APIError) {
    const status = e.status ?? 'stream';
    const type = (e as { type?: string | null }).type ?? '';
    return `Anthropic API error ${status}${type ? ` (${type})` : ''}`;
  }
  if (e instanceof Error) return e.message.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***').slice(0, 300);
  return String(e).slice(0, 300);
}

/* ------------------------------------------------------------------------------------ */
/* Request builder (pure; snapshot-tested)                                               */
/* ------------------------------------------------------------------------------------ */

export type ModelFamily = 'haiku-5-5' | 'sonnet-5-5' | 'always-thinking' | 'other';

export function modelFamily(model: string): ModelFamily {
  if (/^claude-haiku-5-5(?:$|[-@[])/.test(model)) return 'haiku-5-5';
  if (/^claude-sonnet-5-5(?:$|[-@[])/.test(model)) return 'sonnet-5-5';
  if (/^claude-(?:opus-5-5|fable|mythos)/.test(model)) return 'always-thinking';
  return 'other';
}

/**
 * The thinking parameter for a model and a requested mode. Never 'disabled' on Sonnet 5.5 or on the
 * always-thinking models; 'between_tools' only on Sonnet 5.5 (the only model that accepts it).
 */
export function thinkingParam(model: string, mode: LlmRequest['thinking']): Anthropic.ThinkingConfigParam {
  const fam = modelFamily(model);
  if (mode === 'adaptive') return { type: 'adaptive' };
  switch (fam) {
    case 'sonnet-5-5':
      return { type: 'between_tools' };
    case 'always-thinking':
      return { type: 'adaptive' };
    case 'haiku-5-5':
    case 'other':
    default:
      return { type: 'disabled' };
  }
}

export interface BuildOptions {
  stream: boolean;
  /** Override req.maxTokens (pre-warm: 0 or 1). */
  maxTokens?: number;
  /** Send output_config.format when req.schema is set (default true; a max_tokens 0 pre-warm must not). */
  includeFormat?: boolean;
}

/** The exact Messages API body for a request. No temperature/top_p/top_k, ever. */
export function buildMessageParams(req: LlmRequest, opts: BuildOptions): Anthropic.MessageCreateParams {
  const system: Anthropic.TextBlockParam[] = req.system.map((b) => {
    const block: Anthropic.TextBlockParam = { type: 'text', text: b.text };
    if (b.cache_control) block.cache_control = b.cache_control.ttl ? { type: 'ephemeral', ttl: b.cache_control.ttl } : { type: 'ephemeral' };
    return block;
  });
  const messages: Anthropic.MessageParam[] = req.messages.map((m) => ({ role: m.role, content: m.content }));
  const outputConfig: Anthropic.OutputConfig = { effort: req.effort };
  if (req.schema && opts.includeFormat !== false) outputConfig.format = { type: 'json_schema', schema: req.schema };
  const params: Anthropic.MessageCreateParams = {
    model: req.model,
    max_tokens: opts.maxTokens ?? req.maxTokens,
    system,
    messages,
    thinking: thinkingParam(req.model, req.thinking),
    output_config: outputConfig,
    stream: opts.stream,
  };
  const stops = (req.stopSequences ?? []).filter((s) => typeof s === 'string' && s.length > 0);
  if (stops.length > 0) params.stop_sequences = stops;
  return params;
}

/* ------------------------------------------------------------------------------------ */
/* Usage and stream consumption                                                          */
/* ------------------------------------------------------------------------------------ */

const nz = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** SDK usage (Usage or MessageDeltaUsage) -> the core Usage the cost meter prices. */
export function usageFromApi(u: Partial<Anthropic.Usage> | null | undefined): Usage {
  const out: Usage = {
    input_tokens: nz(u?.input_tokens),
    output_tokens: nz(u?.output_tokens),
    cache_read_input_tokens: nz(u?.cache_read_input_tokens),
    cache_creation_input_tokens: nz(u?.cache_creation_input_tokens),
  };
  if (u?.cache_creation) {
    out.cache_creation = {
      ephemeral_5m_input_tokens: nz(u.cache_creation.ephemeral_5m_input_tokens),
      ephemeral_1h_input_tokens: nz(u.cache_creation.ephemeral_1h_input_tokens),
    };
  }
  return out;
}

export interface StreamResult {
  text: string;
  model: string | null;
  messageId: string | null;
  usage: Usage;
  stopReason: string | null;
  /** ms from `t0` to the first text delta (null if no text arrived). */
  ttftMs: number | null;
}

/**
 * Fold a Messages stream into text + usage. message_start carries the input-side usage (including the
 * cache_creation split); message_delta carries cumulative counters (output tokens, and input-side
 * counters when the server revises them).
 */
export async function consumeStream(events: AsyncIterable<Anthropic.RawMessageStreamEvent>, t0: number, now: () => number = () => performance.now()): Promise<StreamResult> {
  let text = '';
  let model: string | null = null;
  let messageId: string | null = null;
  let usage: Usage = { input_tokens: 0, output_tokens: 0 };
  let stopReason: string | null = null;
  let ttftMs: number | null = null;
  for await (const ev of events) {
    switch (ev.type) {
      case 'message_start':
        model = ev.message.model ?? null;
        messageId = ev.message.id ?? null;
        usage = usageFromApi(ev.message.usage);
        break;
      case 'content_block_delta':
        if (ev.delta.type === 'text_delta') {
          if (ttftMs === null && ev.delta.text.length > 0) ttftMs = Math.max(0, now() - t0);
          text += ev.delta.text;
        }
        break;
      case 'message_delta': {
        stopReason = ev.delta.stop_reason ?? stopReason;
        const u = ev.usage;
        if (u) {
          usage.output_tokens = nz(u.output_tokens);
          if (u.input_tokens != null) usage.input_tokens = nz(u.input_tokens);
          if (u.cache_read_input_tokens != null) usage.cache_read_input_tokens = nz(u.cache_read_input_tokens);
          if (u.cache_creation_input_tokens != null) usage.cache_creation_input_tokens = nz(u.cache_creation_input_tokens);
        }
        break;
      }
      default:
        break;
    }
  }
  return { text, model, messageId, usage, stopReason, ttftMs };
}

/** Parse structured output; null when it is not JSON (truncation, refusal). */
export function parseJsonOutput(text: string): unknown {
  const t = text.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    // A model may wrap JSON in a fence despite structured outputs; accept exactly one fenced object.
    const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
    if (m && m[1]) {
      try {
        return JSON.parse(m[1]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/* ------------------------------------------------------------------------------------ */
/* Real client                                                                           */
/* ------------------------------------------------------------------------------------ */

export interface RealClientOptions {
  apiKey: string;
  /** Explicit base URL (see apiKey.ts resolveBaseUrl). Defaults to the public API, never ANTHROPIC_BASE_URL. */
  baseURL?: string | null;
  log?: Logger;
  /** Injected SDK client (tests). */
  sdk?: Anthropic;
  /** Injected fetch for the SDK (tests: an SSE stub; never a network call). */
  fetch?: typeof fetch;
  /** Max retries for non-ghost routes (default 2). */
  maxRetries?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Pre-warm shape:
   *   'one-with-format'  max_tokens 1, non-streaming, with the route's output_config.format (default:
   *                      one output token billed). Structured outputs inject the schema into the prompt
   *                      and setting or changing the format is a cache breaker, so only a warm that
   *                      carries the same format as the real ghost/actions requests writes an entry they
   *                      read; max_tokens 0 rejects output_config.format (prompt-caching docs).
   *   'zero'             max_tokens 0 without the format (cheaper, but its entry is likely never read;
   *                      scripts/bench/prewarm-format.ts measures it),
   *   'zero-with-format' max_tokens 0 with the format (documented as rejected; bench only).
   * Default: PAPER_PREWARM_MODE, else 'one-with-format'. A 400 on a zero-token warm falls back to 'one-with-format'.
   */
  prewarmMode?: PrewarmMode;
  /** Request timeouts per route class, ms. */
  ghostTimeoutMs?: number;
  actionTimeoutMs?: number;
}

export type PrewarmMode = 'zero' | 'zero-with-format' | 'one-with-format';

export function prewarmModeFromEnv(env: NodeJS.ProcessEnv = process.env): PrewarmMode {
  const v = env.PAPER_PREWARM_MODE?.trim();
  return v === 'zero' || v === 'zero-with-format' ? v : 'one-with-format';
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new LlmAbortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new LlmAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The SDK client with an explicit key and base URL (never ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN /
 * profiles from the environment) and SDK retries off. Also used by scripts/bench.
 */
export function createAnthropicSdk(opts: { apiKey: string; baseURL?: string | null; fetch?: typeof fetch; maxRetries?: number }): Anthropic {
  return new Anthropic({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL || DEFAULT_BASE_URL,
    maxRetries: opts.maxRetries ?? 0,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}

export function createRealLlmClient(opts: RealClientOptions): LlmClient {
  const sdk = opts.sdk ?? createAnthropicSdk({ apiKey: opts.apiKey, baseURL: opts.baseURL, fetch: opts.fetch });
  const log = opts.log;
  const maxRetries = Math.max(0, Math.min(5, opts.maxRetries ?? 2));
  const sleep = opts.sleep ?? abortableSleep;
  /** Models for which a max_tokens 0 pre-warm was rejected: they use max_tokens 1 (with the format). */
  const prewarmNeedsOne = new Set<string>();
  const prewarmMode: PrewarmMode = opts.prewarmMode ?? prewarmModeFromEnv();

  async function once(req: LlmRequest): Promise<LlmResponse> {
    const params = buildMessageParams(req, { stream: true }) as Anthropic.MessageCreateParamsStreaming;
    const t0 = performance.now();
    const timeout = req.route === 'ghost' ? (opts.ghostTimeoutMs ?? 15_000) : (opts.actionTimeoutMs ?? 180_000);
    const { data: stream, request_id } = await sdk.messages.create(params, { signal: req.signal ?? null, timeout, maxRetries: 0 }).withResponse();
    const r = await consumeStream(stream, t0);
    // The SDK ends iteration silently when the request signal aborts; surface it as an abort.
    if (req.signal?.aborted) throw new LlmAbortError();
    const model = r.model ?? req.model;
    const json = req.schema ? parseJsonOutput(r.text) : null;
    let costUsd = 0;
    try {
      costUsd = costOf(model, r.usage);
    } catch (e) {
      log?.warn('cost meter unavailable', describeError(e));
    }
    return {
      text: r.text,
      json,
      model,
      usage: r.usage,
      stopReason: r.stopReason,
      requestId: request_id ?? r.messageId,
      ms: Math.round(performance.now() - t0),
      ttftMs: r.ttftMs === null ? null : Math.round(r.ttftMs),
      costUsd,
    };
  }

  return {
    fake: false,
    async complete(req) {
      const retries = req.route === 'ghost' ? 0 : maxRetries;
      for (let attempt = 0; ; attempt++) {
        if (req.signal?.aborted) throw new LlmAbortError();
        try {
          return await once(req);
        } catch (e) {
          if (isAbortError(e) || req.signal?.aborted) throw new LlmAbortError();
          if (attempt >= retries || !isRetryable(e)) throw e;
          const wait = retryDelayMs(e, attempt);
          log?.warn(`LLM ${req.route} request failed, retrying in ${wait} ms`, describeError(e));
          await sleep(wait, req.signal);
        }
      }
    },
    async prewarm(req) {
      const send = async (maxTokens: number, includeFormat: boolean) => {
        const params = buildMessageParams(
          { ...req, messages: req.messages.length > 0 ? req.messages : [{ role: 'user', content: 'warmup' }] },
          { stream: false, maxTokens, includeFormat },
        ) as Anthropic.MessageCreateParamsNonStreaming;
        const msg = await sdk.messages.create(params, { signal: req.signal ?? null, timeout: 60_000, maxRetries: 0 });
        return usageFromApi(msg.usage);
      };
      try {
        if (prewarmMode !== 'one-with-format' && !prewarmNeedsOne.has(req.model)) {
          try {
            // Opt-in (PAPER_PREWARM_MODE): max_tokens 0 is documented to reject output_config.format, so
            // the zero-token warm omits it; whether requests that carry the format read that entry is
            // what scripts/bench/prewarm-format.ts measures.
            return await send(0, prewarmMode === 'zero-with-format');
          } catch (e) {
            if (!(e instanceof Anthropic.BadRequestError)) throw e;
            prewarmNeedsOne.add(req.model);
            log?.info(`pre-warm with max_tokens 0 rejected for ${req.model}; using max_tokens 1`);
          }
        }
        return await send(1, true);
      } catch (e) {
        if (!isAbortError(e)) log?.warn(`pre-warm failed for ${req.model}`, describeError(e));
        return null;
      }
    },
  };
}

/* ------------------------------------------------------------------------------------ */
/* Factory                                                                               */
/* ------------------------------------------------------------------------------------ */

export interface CreateLlmClientOptions {
  apiKey: string | null;
  fake: boolean;
  log?: Logger;
  baseURL?: string | null;
  /** Fake only: simulated latency (0 in tests). */
  fakeLatencyMs?: number;
  /** Fake only: scripted outputs (tests). */
  respond?: FakeResponder;
}

/** Real client when a key is present and fake is false; otherwise the deterministic fake. */
export function createLlmClient(opts: CreateLlmClientOptions): LlmClient {
  if (opts.fake || !opts.apiKey) return createFakeLlmClient({ latencyMs: opts.fakeLatencyMs ?? 0, respond: opts.respond });
  return createRealLlmClient({ apiKey: opts.apiKey, baseURL: opts.baseURL ?? DEFAULT_BASE_URL, log: opts.log });
}
