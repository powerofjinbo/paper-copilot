/**
 * A local mock of the Anthropic Messages API (node:http on 127.0.0.1, ephemeral port), so the REAL
 * network paths (the @anthropic-ai/sdk client of services/llm and the Claude Code process the Agent
 * SDK spawns) can be driven without an API key and without the internet.
 *
 * What it serves:
 * - POST /v1/messages (also with ?beta=true): streaming SSE in the exact Anthropic event order
 *   (message_start, content_block_start, ping, content_block_delta [text_delta | input_json_delta |
 *   thinking_delta | signature_delta], content_block_stop, message_delta with cumulative usage,
 *   message_stop) and non-streaming JSON; text, tool_use and thinking blocks;
 * - POST /v1/messages/count_tokens, GET /v1/models[/id], HEAD/GET / (probes); anything else is a 404
 *   that is recorded, so a test can see every endpoint a client touched.
 *
 * Replies are scripted per test: a FIFO queue of replies (or functions of the request), then an
 * optional fallback handler. Errors can be injected: an HTTP error with the API's error body (429 with
 * retry-after, 529 overloaded_error, 500 api_error, ...), a connection reset before the response or
 * after N events, a slow first byte, a stream that ends without message_stop, an `event: error` in the
 * middle of the stream, or a hang until the client aborts.
 *
 * Every request is recorded (method, path, headers, parsed body) together with the request-validation
 * violations found in it:
 * - level 'api': what the real API rejects with a 400 (the mock then answers 400 invalid_request_error
 *   as the API would): missing/wrong x-api-key or anthropic-version, temperature / top_p / top_k,
 *   the model-specific thinking rules of Haiku 5.5 / Sonnet 5.5 / Opus 5.5 (and Fable / Mythos),
 *   effort values, cache_control type/ttl, more than 4 breakpoints, a 1h breakpoint after a 5m one,
 *   max_tokens 0 with stream / output_config.format / enabled thinking, structured-output schemas that
 *   are not strict (additionalProperties must be false on every object, unsupported keywords),
 *   forced tool_choice on Opus 5.5 / Sonnet 5.5, assistant prefill, whitespace-only stop sequences,
 *   the deprecated top-level output_format;
 * - level 'app': paper-copilot's own stricter request policy (only checked with `policy: 'app'`):
 *   cache_control only on system blocks, no top-level automatic caching, structured-output `required`
 *   listing every property.
 *
 * A small prompt-cache simulation fills usage honestly: tokens are chars/4; the prefix through each
 * cache_control breakpoint (tools, system, messages in render order, plus model, thinking, effort and
 * output format, which the API renders into the prompt) is a cache key; the longest breakpoint already
 * written is a read (cache_read_input_tokens), everything up to the last breakpoint is written
 * (cache_creation_input_tokens, split by TTL in usage.cache_creation), the rest is input_tokens.
 *
 * Deterministic: ids are counters, no randomness, no wall-clock in bodies.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/* ------------------------------------------------------------------------------------ */
/* Types                                                                                 */
/* ------------------------------------------------------------------------------------ */

export type MockBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: unknown; id?: string }
  | { type: 'thinking'; thinking: string; signature?: string };

export interface MockMessageReply {
  kind?: 'message';
  content: MockBlock[];
  stopReason?: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'refusal' | 'pause_turn';
  stopSequence?: string | null;
  /** Model echoed in the response (default: the request's model). */
  model?: string;
  /** Output tokens reported (default: chars/4 of the content, at least 1). */
  outputTokens?: number;
  /** Override the simulated input-side usage. */
  usage?: Partial<{ input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }>;
  /** Delay before the response headers (slow first byte), ms. */
  firstByteDelayMs?: number;
  /** Delay between SSE events, ms. */
  eventDelayMs?: number;
  /** Size of each text / partial_json delta (default 12 characters). */
  chunkChars?: number;
  /** Streaming only: destroy the socket after this many events (a connection reset mid-stream). */
  resetAfterEvents?: number;
  /** Streaming only: send `event: error` with this error after `afterEvents` events, then end. */
  streamError?: { type: string; message: string; afterEvents: number };
  /** Streaming only: end the response without message_delta / message_stop. */
  truncate?: boolean;
  /** Extra response headers. */
  headers?: Record<string, string>;
}

export interface MockErrorReply {
  kind: 'error';
  status: number;
  type: string;
  message?: string;
  /** retry-after header, seconds. */
  retryAfter?: number;
  headers?: Record<string, string>;
  firstByteDelayMs?: number;
}

/** Destroy the connection before any response byte (ECONNRESET on the client). */
export interface MockResetReply {
  kind: 'reset';
}

/** Never answer; the request ends only when the client aborts (or the mock closes). */
export interface MockHangReply {
  kind: 'hang';
}

export type MockReply = MockMessageReply | MockErrorReply | MockResetReply | MockHangReply;

export interface Violation {
  level: 'api' | 'app';
  code: string;
  message: string;
}

export interface RecordedRequest {
  /** Sequence number (0-based) over every request the mock received. */
  seq: number;
  method: string;
  path: string;
  /** Path without the query string. */
  route: string;
  headers: Record<string, string>;
  /** Parsed JSON body (null when there is none or it is not JSON). */
  body: Record<string, unknown> | null;
  /** True for POST /v1/messages with stream: true. */
  stream: boolean;
  violations: Violation[];
  /** What the mock answered: HTTP status (0 for a reset / hang). */
  status: number;
  /** ms from the mock start (monotonic), for ordering assertions. */
  at: number;
}

export type ReplyFn = (req: RecordedRequest, mock: MockAnthropic) => MockReply | Promise<MockReply>;

export interface MockOptions {
  /** The x-api-key the mock accepts (default 'sk-ant-test'). null: any non-empty key. */
  apiKey?: string | null;
  /** 'api' checks what the real API rejects; 'app' adds paper-copilot's own policy (default 'api'). */
  policy?: 'api' | 'app';
  /** Answer api-level violations with a 400 as the real API does (default true). */
  rejectInvalid?: boolean;
  /** Used when the queue is empty (default: a 500 api_error plus an 'unscripted' violation). */
  fallback?: ReplyFn;
}

/* ------------------------------------------------------------------------------------ */
/* Validation                                                                            */
/* ------------------------------------------------------------------------------------ */

type Fam = 'haiku-5-5' | 'sonnet-5-5' | 'always-thinking' | 'other';

function family(model: string): Fam {
  if (/^claude-haiku-5-5(?:$|[-@[])/.test(model)) return 'haiku-5-5';
  if (/^claude-sonnet-5-5(?:$|[-@[])/.test(model)) return 'sonnet-5-5';
  if (/^claude-(?:opus-5-5|fable|mythos)/.test(model)) return 'always-thinking';
  return 'other';
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const UNSUPPORTED_SCHEMA_KEYWORDS = [
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength',
  'maxItems', 'uniqueItems', 'contains', 'minContains', 'maxContains', 'patternProperties', 'propertyNames',
  'minProperties', 'maxProperties', 'dependentRequired', 'dependentSchemas', 'if', 'then', 'else', 'not',
  'unevaluatedProperties', 'unevaluatedItems',
];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Structured-output schema strictness. Paths are JSON-pointer-ish for the message. */
export function checkStrictSchema(schema: unknown, policy: 'api' | 'app', path = '#'): Violation[] {
  const out: Violation[] = [];
  const walk = (s: unknown, p: string) => {
    if (Array.isArray(s)) {
      s.forEach((x, i) => walk(x, `${p}/${i}`));
      return;
    }
    if (!isObj(s)) return;
    for (const k of UNSUPPORTED_SCHEMA_KEYWORDS) {
      if (k in s) out.push({ level: 'api', code: 'schema_unsupported_keyword', message: `${p}: "${k}" is not supported by structured outputs` });
    }
    if (typeof s.minItems === 'number' && s.minItems > 1) out.push({ level: 'api', code: 'schema_unsupported_keyword', message: `${p}: minItems > 1 is not supported` });
    const isObject = s.type === 'object' || (Array.isArray(s.type) && s.type.includes('object')) || isObj(s.properties);
    if (isObject) {
      if (s.additionalProperties !== false) out.push({ level: 'api', code: 'schema_additional_properties', message: `${p}: every object needs additionalProperties: false` });
      const props = isObj(s.properties) ? Object.keys(s.properties) : [];
      const req = Array.isArray(s.required) ? (s.required as unknown[]).map(String) : [];
      for (const r of req) if (!props.includes(r)) out.push({ level: 'api', code: 'schema_required_unknown', message: `${p}: required "${r}" is not a property` });
      if (policy === 'app') {
        const missing = props.filter((k) => !req.includes(k));
        if (missing.length) out.push({ level: 'app', code: 'schema_required_incomplete', message: `${p}: required must list every property (missing ${missing.join(', ')})` });
      }
    }
    for (const [k, v] of Object.entries(s)) {
      if (k === 'properties' && isObj(v)) for (const [pk, pv] of Object.entries(v)) walk(pv, `${p}/properties/${pk}`);
      else if (k === 'enum' || k === 'const' || k === 'required' || k === 'description' || k === 'title' || k === 'default' || k === 'examples') continue;
      else if (isObj(v) || Array.isArray(v)) walk(v, `${p}/${k}`);
    }
  };
  walk(schema, path);
  return out;
}

interface Breakpoint {
  where: 'tools' | 'system' | 'messages';
  ttl: '5m' | '1h';
}

function cacheControlOf(block: unknown, where: Breakpoint['where'], v: Violation[]): Breakpoint | null {
  if (!isObj(block) || block.cache_control == null) return null;
  const cc = block.cache_control;
  if (!isObj(cc) || cc.type !== 'ephemeral') {
    v.push({ level: 'api', code: 'cache_control_type', message: `${where}: cache_control.type must be "ephemeral"` });
    return null;
  }
  if (cc.ttl !== undefined && cc.ttl !== '5m' && cc.ttl !== '1h') v.push({ level: 'api', code: 'cache_control_ttl', message: `${where}: cache_control.ttl must be "5m" or "1h" (got ${JSON.stringify(cc.ttl)})` });
  return { where, ttl: cc.ttl === '1h' ? '1h' : '5m' };
}

function contentBlocks(content: unknown): unknown[] {
  return Array.isArray(content) ? content : [];
}

/** All violations of one /v1/messages (or count_tokens) request. */
export function validateMessagesRequest(headers: Record<string, string>, body: Record<string, unknown> | null, o: { apiKey: string | null; policy: 'api' | 'app'; countTokens?: boolean }): Violation[] {
  const v: Violation[] = [];
  // An API key travels as `x-api-key` (the Claude Code CLI, older SDKs) or as `Authorization: Bearer
  // <key>` (@anthropic-ai/sdk 1.x sends every credential that way); the API accepts both.
  const xKey = headers['x-api-key'] || null;
  const bearer = /^Bearer\s+(\S+)$/i.exec(headers.authorization ?? '')?.[1] ?? null;
  const key = xKey ?? bearer;
  if (!key) v.push({ level: 'api', code: 'auth_missing', message: `no x-api-key or Authorization: Bearer header${headers.authorization ? ' (a non-Bearer Authorization header was sent)' : ''}` });
  else if (o.apiKey !== null && key !== o.apiKey) v.push({ level: 'api', code: 'auth_wrong_key', message: 'the credential sent is not the expected test key' });
  if (xKey && bearer && xKey !== bearer) v.push({ level: 'api', code: 'auth_conflict', message: 'x-api-key and Authorization carry different credentials' });
  if (o.policy === 'app' && (xKey && bearer)) v.push({ level: 'app', code: 'auth_two_headers', message: 'paper-copilot sends its key in exactly one header' });
  if (!headers['anthropic-version']) v.push({ level: 'api', code: 'version_missing', message: 'no anthropic-version header' });
  if (!body) {
    v.push({ level: 'api', code: 'body_not_json', message: 'request body is not a JSON object' });
    return v;
  }
  const model = typeof body.model === 'string' ? body.model : '';
  if (!model) v.push({ level: 'api', code: 'model_missing', message: 'model is required' });
  const fam = family(model);

  if (!o.countTokens) {
    if (typeof body.max_tokens !== 'number' || !Number.isInteger(body.max_tokens) || body.max_tokens < 0) v.push({ level: 'api', code: 'max_tokens', message: 'max_tokens must be a non-negative integer' });
  }
  for (const k of ['temperature', 'top_p', 'top_k']) if (k in body) v.push({ level: 'api', code: 'sampling_param', message: `${k} is not accepted on current models` });
  if ('output_format' in body) v.push({ level: 'api', code: 'output_format_deprecated', message: 'use output_config.format, not output_format' });

  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || messages.length === 0) v.push({ level: 'api', code: 'messages_empty', message: 'messages must be a non-empty array' });
  else {
    const first = messages[0] as { role?: string };
    if (first?.role !== 'user') v.push({ level: 'api', code: 'first_not_user', message: 'the first message must have role "user"' });
    const last = messages[messages.length - 1] as { role?: string };
    if (last?.role === 'assistant') v.push({ level: 'api', code: 'prefill', message: 'assistant prefill is not supported on current models' });
  }

  // effort
  const oc = isObj(body.output_config) ? body.output_config : null;
  const effort = oc && typeof oc.effort === 'string' ? oc.effort : null;
  if (oc && oc.effort !== undefined && !EFFORTS.includes(String(oc.effort))) v.push({ level: 'api', code: 'effort', message: `unknown effort ${JSON.stringify(oc.effort)}` });
  const effortLevel = effort ?? (fam === 'haiku-5-5' || fam === 'always-thinking' ? 'medium' : 'high');
  const highOrBelow = ['low', 'medium', 'high'].includes(effortLevel);

  // thinking
  const th = isObj(body.thinking) ? body.thinking : null;
  const thType = th ? String(th.type) : null;
  if (th) {
    if (!['adaptive', 'disabled', 'enabled', 'between_tools'].includes(String(thType))) v.push({ level: 'api', code: 'thinking_type', message: `unknown thinking type ${JSON.stringify(thType)}` });
    if (thType === 'enabled' || 'budget_tokens' in th) {
      if (fam !== 'other') v.push({ level: 'api', code: 'thinking_budget', message: `${model}: thinking budgets ("enabled", budget_tokens) are rejected; use adaptive thinking` });
    }
    if (thType === 'between_tools') {
      if (fam !== 'sonnet-5-5') v.push({ level: 'api', code: 'thinking_between_tools', message: `${model}: thinking "between_tools" is accepted only by claude-sonnet-5-5` });
      const extra = Object.keys(th).filter((k) => k !== 'type');
      if (extra.length) v.push({ level: 'api', code: 'thinking_between_tools_fields', message: `between_tools takes no other field (got ${extra.join(', ')})` });
      if (!highOrBelow) v.push({ level: 'api', code: 'thinking_between_tools_effort', message: `between_tools is accepted only at effort high or below (effort ${effortLevel})` });
    }
    if (thType === 'disabled') {
      if (fam === 'sonnet-5-5') v.push({ level: 'api', code: 'thinking_disabled', message: `${model}: thinking "disabled" is rejected; use "between_tools"` });
      if (fam === 'always-thinking') v.push({ level: 'api', code: 'thinking_disabled', message: `${model}: thinking cannot be disabled` });
      if (fam === 'haiku-5-5' && !highOrBelow) v.push({ level: 'api', code: 'thinking_disabled_effort', message: `${model}: thinking "disabled" only at effort high or below (effort ${effortLevel})` });
    }
  }

  // forced tool choice
  const tc = isObj(body.tool_choice) ? body.tool_choice : null;
  if (tc && (tc.type === 'any' || tc.type === 'tool') && (fam === 'sonnet-5-5' || fam === 'always-thinking')) v.push({ level: 'api', code: 'tool_choice_forced', message: `${model}: tool_choice "${String(tc.type)}" is not supported` });

  // stop sequences
  if (Array.isArray(body.stop_sequences)) {
    for (const s of body.stop_sequences) if (typeof s !== 'string' || s.trim() === '') v.push({ level: 'api', code: 'stop_sequence', message: 'each stop sequence must contain non-whitespace' });
  }

  // cache_control: placement, TTL order (tools -> system -> messages), at most 4 breakpoints
  const bps: Breakpoint[] = [];
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    const b = cacheControlOf(t, 'tools', v);
    if (b) bps.push(b);
  }
  const system = body.system;
  if (Array.isArray(system)) {
    for (const s of system) {
      if (!isObj(s) || s.type !== 'text' || typeof s.text !== 'string') v.push({ level: 'api', code: 'system_block', message: 'system blocks must be {type:"text", text}' });
      const b = cacheControlOf(s, 'system', v);
      if (b) bps.push(b);
    }
  } else if (system !== undefined && typeof system !== 'string') v.push({ level: 'api', code: 'system_type', message: 'system must be a string or an array of text blocks' });
  for (const m of messages ?? []) {
    for (const c of contentBlocks((m as { content?: unknown }).content)) {
      const b = cacheControlOf(c, 'messages', v);
      if (b) bps.push(b);
    }
  }
  if (body.cache_control != null) {
    const top = cacheControlOf({ cache_control: body.cache_control }, 'messages', v);
    if (top) bps.push(top);
    if (o.policy === 'app') v.push({ level: 'app', code: 'cache_top_level', message: 'paper-copilot never uses top-level automatic caching (the volatile tail must not be written)' });
  }
  if (bps.length > 4) v.push({ level: 'api', code: 'cache_breakpoints', message: `at most 4 cache_control breakpoints (got ${bps.length})` });
  let seen5m = false;
  for (const b of bps) {
    if (b.ttl === '5m') seen5m = true;
    else if (seen5m) {
      v.push({ level: 'api', code: 'cache_ttl_order', message: 'a 1h cache_control breakpoint may not follow a 5m one' });
      break;
    }
  }
  if (o.policy === 'app' && bps.some((b) => b.where !== 'system')) v.push({ level: 'app', code: 'cache_outside_system', message: 'paper-copilot puts cache_control only on system blocks' });

  // output_config.format
  const fmt = oc && isObj(oc.format) ? oc.format : null;
  if (fmt) {
    if (fmt.type !== 'json_schema') v.push({ level: 'api', code: 'format_type', message: `output_config.format.type must be "json_schema" (got ${JSON.stringify(fmt.type)})` });
    if (!isObj(fmt.schema)) v.push({ level: 'api', code: 'format_schema', message: 'output_config.format.schema must be an object' });
    else v.push(...checkStrictSchema(fmt.schema, o.policy));
  }

  // max_tokens 0 (pre-warm)
  if (body.max_tokens === 0 && !o.countTokens) {
    if (body.stream === true) v.push({ level: 'api', code: 'prewarm_stream', message: 'max_tokens 0 is rejected with stream: true' });
    if (fmt) v.push({ level: 'api', code: 'prewarm_format', message: 'max_tokens 0 is rejected with output_config.format' });
    if (thType === 'enabled') v.push({ level: 'api', code: 'prewarm_thinking', message: 'max_tokens 0 is rejected with thinking "enabled"' });
    if (tc && (tc.type === 'any' || tc.type === 'tool')) v.push({ level: 'api', code: 'prewarm_tool_choice', message: 'max_tokens 0 is rejected with a forced tool_choice' });
  }
  return v;
}

/* ------------------------------------------------------------------------------------ */
/* Cache simulation                                                                      */
/* ------------------------------------------------------------------------------------ */

const tokensOf = (s: string): number => Math.ceil(s.length / 4);

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObj(v)) {
    return `{${Object.keys(v)
      .filter((k) => k !== 'cache_control')
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

interface Segment {
  text: string;
  ttl: '5m' | '1h' | null;
}

/** The request in render order (tools, system, messages), one segment per block. */
function segments(body: Record<string, unknown>): Segment[] {
  const out: Segment[] = [];
  const ttl = (b: unknown): '5m' | '1h' | null => (isObj(b) && isObj(b.cache_control) ? (b.cache_control.ttl === '1h' ? '1h' : '5m') : null);
  for (const t of Array.isArray(body.tools) ? body.tools : []) out.push({ text: canonical(t), ttl: ttl(t) });
  if (typeof body.system === 'string') out.push({ text: body.system, ttl: null });
  for (const s of Array.isArray(body.system) ? body.system : []) out.push({ text: isObj(s) ? String(s.text ?? '') : '', ttl: ttl(s) });
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    const c = (m as { content?: unknown }).content;
    if (typeof c === 'string') out.push({ text: c, ttl: null });
    else for (const b of contentBlocks(c)) out.push({ text: isObj(b) && typeof b.text === 'string' ? b.text : canonical(b), ttl: ttl(b) });
  }
  return out;
}

/* ------------------------------------------------------------------------------------ */
/* Server                                                                                */
/* ------------------------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class MockAnthropic {
  readonly requests: RecordedRequest[] = [];
  private readonly queue: Array<MockReply | ReplyFn> = [];
  private readonly sockets = new Set<Socket>();
  private readonly cache = new Map<string, { ttl: '5m' | '1h' }>();
  private server: Server | null = null;
  private seq = 0;
  private ids = 0;
  private readonly t0 = performance.now();
  url = '';
  port = 0;
  fallback: ReplyFn | null;
  readonly opts: { apiKey: string | null; policy: 'api' | 'app'; rejectInvalid: boolean };

  constructor(opts: MockOptions = {}) {
    this.opts = { apiKey: opts.apiKey === undefined ? 'sk-ant-test' : opts.apiKey, policy: opts.policy ?? 'api', rejectInvalid: opts.rejectInvalid ?? true };
    this.fallback = opts.fallback ?? null;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    this.url = `http://127.0.0.1:${this.port}`;
    return this;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = null;
  }

  /** Queue replies, consumed in order by POST /v1/messages. */
  enqueue(...replies: Array<MockReply | ReplyFn>): this {
    this.queue.push(...replies);
    return this;
  }

  pending(): number {
    return this.queue.length;
  }

  reset(): void {
    this.requests.length = 0;
    this.queue.length = 0;
    this.cache.clear();
  }

  /** Requests to POST /v1/messages only. */
  messages(): RecordedRequest[] {
    return this.requests.filter((r) => r.method === 'POST' && r.route === '/v1/messages');
  }

  violations(level?: 'api' | 'app'): Array<Violation & { seq: number; path: string }> {
    return this.requests.flatMap((r) => r.violations.filter((x) => !level || x.level === level).map((x) => ({ ...x, seq: r.seq, path: r.path })));
  }

  /** A readable list of violations for assertion messages. */
  describeViolations(level?: 'api' | 'app'): string {
    return this.violations(level).map((x) => `#${x.seq} ${x.path} [${x.level}] ${x.code}: ${x.message}`).join('\n');
  }

  nextId(prefix: string): string {
    this.ids++;
    return `${prefix}_mock${String(this.ids).padStart(6, '0')}`;
  }

  /* ------------------------------------------------------------------------------ */

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const headers: Record<string, string> = {};
    for (const [k, val] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(val) ? val.join(', ') : String(val ?? '');
    let body: Record<string, unknown> | null = null;
    let text = raw.toString('utf8');
    if (raw.length > 0 && /gzip/i.test(headers['content-encoding'] ?? '')) {
      try {
        const { gunzipSync } = await import('node:zlib');
        text = gunzipSync(raw).toString('utf8');
      } catch {
        /* keep raw */
      }
    }
    if (text.trim()) {
      try {
        const p = JSON.parse(text) as unknown;
        body = isObj(p) ? p : null;
      } catch {
        body = null;
      }
    }
    const path = req.url ?? '/';
    const route = path.split('?')[0]!.replace(/\/+$/, '') || '/';
    const method = (req.method ?? 'GET').toUpperCase();
    const rec: RecordedRequest = { seq: this.seq++, method, path, route, headers, body, stream: false, violations: [], status: 0, at: Math.round(performance.now() - this.t0) };
    this.requests.push(rec);

    const json = (status: number, payload: unknown, extra: Record<string, string> = {}) => {
      rec.status = status;
      if (res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json', 'request-id': this.nextId('req'), ...extra });
      res.end(method === 'HEAD' ? undefined : JSON.stringify(payload));
    };
    const apiError = (status: number, type: string, message: string, extra: Record<string, string> = {}) => json(status, { type: 'error', error: { type, message }, request_id: this.nextId('req') }, extra);

    if (route === '/' && (method === 'HEAD' || method === 'GET')) return json(200, { ok: true });
    if (method === 'GET' && route === '/v1/models') {
      return json(200, { data: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map((id) => ({ type: 'model', id, display_name: id, created_at: '2026-01-01T00:00:00Z' })), has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-haiku-5-5' });
    }
    if (method === 'GET' && route.startsWith('/v1/models/')) {
      const id = decodeURIComponent(route.slice('/v1/models/'.length));
      return json(200, { type: 'model', id, display_name: id, created_at: '2026-01-01T00:00:00Z' });
    }
    if (method === 'POST' && route === '/v1/messages/count_tokens') {
      rec.violations = validateMessagesRequest(headers, body, { ...this.opts, countTokens: true });
      if (this.opts.rejectInvalid && rec.violations.some((x) => x.level === 'api')) return apiError(400, 'invalid_request_error', rec.violations.map((x) => x.message).join('; '));
      const n = body ? segments(body).reduce((a, s) => a + tokensOf(s.text), 0) : 0;
      return json(200, { input_tokens: n });
    }
    if (method !== 'POST' || route !== '/v1/messages') return apiError(404, 'not_found_error', `mock: no route ${method} ${route}`);

    rec.stream = body?.stream === true;
    rec.violations = validateMessagesRequest(headers, body, this.opts);
    const authFail = rec.violations.find((x) => x.code === 'auth_missing' || x.code === 'auth_wrong_key' || x.code === 'auth_conflict');
    if (authFail) return apiError(401, 'authentication_error', 'invalid x-api-key');
    if (this.opts.rejectInvalid && rec.violations.some((x) => x.level === 'api')) return apiError(400, 'invalid_request_error', rec.violations.filter((x) => x.level === 'api').map((x) => x.message).join('; '));

    let reply: MockReply;
    const next = this.queue.shift();
    try {
      if (next) reply = typeof next === 'function' ? await next(rec, this) : next;
      else if (this.fallback) reply = await this.fallback(rec, this);
      else {
        rec.violations.push({ level: 'api', code: 'unscripted', message: 'the mock had no scripted reply for this request' });
        return apiError(500, 'api_error', 'mock: no scripted reply');
      }
    } catch (e) {
      rec.violations.push({ level: 'api', code: 'script_error', message: `the reply function threw: ${e instanceof Error ? e.message : String(e)}` });
      return apiError(500, 'api_error', 'mock: reply function threw');
    }

    if (reply.kind === 'reset') {
      req.socket.destroy();
      return;
    }
    if (reply.kind === 'hang') {
      await new Promise<void>((r) => {
        res.on('close', () => r());
        req.socket.on('close', () => r());
      });
      return;
    }
    if (reply.kind === 'error') {
      if (reply.firstByteDelayMs) await sleep(reply.firstByteDelayMs);
      const extra: Record<string, string> = { ...(reply.headers ?? {}) };
      if (reply.retryAfter !== undefined) extra['retry-after'] = String(reply.retryAfter);
      if (reply.type === 'rate_limit_error' || reply.type === 'overloaded_error') extra['x-should-retry'] ??= 'true';
      return apiError(reply.status, reply.type, reply.message ?? reply.type.replace(/_/g, ' '), extra);
    }
    await this.respondMessage(rec, body!, reply, res, req);
  }

  /** usage for a request from the cache simulation (and writes the entries it creates). */
  simulateUsage(body: Record<string, unknown>): { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; cache_creation: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } } {
    const segs = segments(body);
    const oc = isObj(body.output_config) ? body.output_config : {};
    const settings = canonical({ model: body.model, thinking: body.thinking ?? null, effort: oc.effort ?? null, format: oc.format ?? null });
    const keys: Array<{ idx: number; key: string; ttl: '5m' | '1h' }> = [];
    const h = createHash('sha256').update(settings);
    segs.forEach((s, i) => {
      h.update(`\u0000${s.text}`);
      if (s.ttl) keys.push({ idx: i, key: h.copy().digest('hex'), ttl: s.ttl });
    });
    const tok = segs.map((s) => tokensOf(s.text));
    const upTo = (idx: number) => tok.slice(0, idx + 1).reduce((a, b) => a + b, 0);
    const total = tok.reduce((a, b) => a + b, 0);
    let readIdx = -1;
    for (const k of keys) if (this.cache.has(k.key)) readIdx = k.idx;
    const read = readIdx >= 0 ? upTo(readIdx) : 0;
    let c5 = 0;
    let c1 = 0;
    let prev = readIdx;
    for (const k of keys) {
      if (k.idx <= readIdx) continue;
      const n = upTo(k.idx) - (prev >= 0 ? upTo(prev) : 0);
      if (k.ttl === '1h') c1 += n;
      else c5 += n;
      prev = k.idx;
      this.cache.set(k.key, { ttl: k.ttl });
    }
    const lastBp = keys.length ? upTo(keys[keys.length - 1]!.idx) : 0;
    const input = Math.max(1, total - Math.max(read, lastBp));
    return { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: c5 + c1, cache_creation: { ephemeral_5m_input_tokens: c5, ephemeral_1h_input_tokens: c1 } };
  }

  private async respondMessage(rec: RecordedRequest, body: Record<string, unknown>, reply: MockMessageReply, res: ServerResponse, req: IncomingMessage): Promise<void> {
    const model = reply.model ?? String(body.model);
    const usageIn = { ...this.simulateUsage(body), ...(reply.usage ?? {}) };
    const content = reply.content.map((b) => (b.type === 'tool_use' ? { ...b, id: b.id ?? this.nextId('toolu') } : b));
    const outTok =
      reply.outputTokens ??
      (body.max_tokens === 0 ? 0 : Math.max(1, content.reduce((a, b) => a + tokensOf(b.type === 'text' ? b.text : b.type === 'thinking' ? b.thinking : JSON.stringify(b.input)), 0)));
    const hasTool = content.some((b) => b.type === 'tool_use');
    const stopReason = reply.stopReason ?? (body.max_tokens === 0 ? 'max_tokens' : hasTool ? 'tool_use' : 'end_turn');
    const id = this.nextId('msg');
    if (reply.firstByteDelayMs) await sleep(reply.firstByteDelayMs);
    if (res.destroyed) return;

    if (!rec.stream) {
      const blocks = content.map((b) =>
        b.type === 'text' ? { type: 'text', text: b.text } : b.type === 'thinking' ? { type: 'thinking', thinking: b.thinking, signature: b.signature ?? 'sig' } : { type: 'tool_use', id: b.id, name: b.name, input: b.input },
      );
      rec.status = 200;
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': this.nextId('req'), ...(reply.headers ?? {}) });
      res.end(
        JSON.stringify({
          id,
          type: 'message',
          role: 'assistant',
          model,
          content: body.max_tokens === 0 ? [] : blocks,
          stop_reason: stopReason,
          stop_sequence: reply.stopSequence ?? null,
          stop_details: null,
          usage: { ...usageIn, output_tokens: outTok, service_tier: 'standard' },
        }),
      );
      return;
    }

    rec.status = 200;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'request-id': this.nextId('req'), ...(reply.headers ?? {}) });
    let sent = 0;
    let aborted = false;
    req.socket.on('close', () => (aborted = true));
    const send = async (event: string, data: unknown): Promise<boolean> => {
      if (aborted || res.destroyed) return false;
      if (reply.resetAfterEvents !== undefined && sent >= reply.resetAfterEvents) {
        req.socket.destroy();
        return false;
      }
      if (reply.streamError && sent === reply.streamError.afterEvents) {
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: reply.streamError.type, message: reply.streamError.message } })}\n\n`);
        res.end();
        return false;
      }
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      sent++;
      if (reply.eventDelayMs) await sleep(reply.eventDelayMs);
      return true;
    };
    const chunk = Math.max(1, reply.chunkChars ?? 12);
    const pieces = (s: string): string[] => {
      const out: string[] = [];
      const cps = [...s];
      for (let i = 0; i < cps.length; i += chunk) out.push(cps.slice(i, i + chunk).join(''));
      return out;
    };

    const ok = await send('message_start', {
      type: 'message_start',
      message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usageIn, output_tokens: 1, service_tier: 'standard' } },
    });
    if (!ok) return;
    let index = 0;
    for (const b of content) {
      if (b.type === 'text') {
        if (!(await send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }))) return;
        if (index === 0 && !(await send('ping', { type: 'ping' }))) return;
        for (const p of pieces(b.text)) if (!(await send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: p } }))) return;
      } else if (b.type === 'thinking') {
        if (!(await send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } }))) return;
        for (const p of pieces(b.thinking)) if (!(await send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: p } }))) return;
        if (!(await send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: b.signature ?? 'sig' } }))) return;
      } else {
        if (!(await send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }))) return;
        for (const p of pieces(JSON.stringify(b.input ?? {}))) if (!(await send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: p } }))) return;
      }
      if (!(await send('content_block_stop', { type: 'content_block_stop', index }))) return;
      index++;
    }
    if (reply.truncate) {
      res.end();
      return;
    }
    if (!(await send('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: reply.stopSequence ?? null, stop_details: null }, usage: { ...usageIn, output_tokens: outTok } }))) return;
    if (!(await send('message_stop', { type: 'message_stop' }))) return;
    res.end();
  }
}

/* ------------------------------------------------------------------------------------ */
/* Reply helpers                                                                         */
/* ------------------------------------------------------------------------------------ */

export const textReply = (text: string, over: Partial<MockMessageReply> = {}): MockMessageReply => ({ content: [{ type: 'text', text }], ...over });
export const jsonReply = (value: unknown, over: Partial<MockMessageReply> = {}): MockMessageReply => textReply(JSON.stringify(value), over);
export const toolReply = (name: string, input: unknown, over: Partial<MockMessageReply> & { text?: string; id?: string } = {}): MockMessageReply => {
  const { text, id, ...rest } = over;
  return { content: [...(text ? [{ type: 'text' as const, text }] : []), { type: 'tool_use', name, input, ...(id ? { id } : {}) }], stopReason: 'tool_use', ...rest };
};
export const errorReply = (status: number, type: string, over: Partial<MockErrorReply> = {}): MockErrorReply => ({ kind: 'error', status, type, ...over });

export async function startMockAnthropic(opts: MockOptions = {}): Promise<MockAnthropic> {
  return new MockAnthropic(opts).start();
}
