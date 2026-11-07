/**
 * LLM client: the exact request bodies (Haiku ghost, Sonnet actions), stream folding, retries, pre-warm
 * fallback, key / base URL resolution, the fake client and the skill loader. No network: the real
 * client runs against an injected fetch that serves a recorded-shape SSE stream.
 */
import { cpSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { GhostOutput, InstructOutput, extractFictionalNumbers } from '@paper-copilot/core';
import type { LlmRequest } from '../src/contracts';
import {
  DEFAULT_BASE_URL,
  buildMessageParams,
  consumeStream,
  createFakeLlmClient,
  createLlmClient,
  createRealLlmClient,
  createSkillLoader,
  fakeFromSchema,
  fileScriptResponder,
  isRetryable,
  keychainLookup,
  modelFamily,
  parseJsonOutput,
  readSkillBundle,
  resolveApiKey,
  resolveBaseUrl,
  retryDelayMs,
  thinkingParam,
  usageFromApi,
} from '../src/services/llm';
import { SKILL_DIR } from './helpers/ctx';

const GHOST_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' }, fact_ids: { type: 'array', items: { type: 'string' } }, cite_keys: { type: 'array', items: { type: 'string' } }, fulfilled_move_ids: { type: 'array', items: { type: 'string' } } },
  required: ['text', 'fact_ids', 'cite_keys', 'fulfilled_move_ids'],
  additionalProperties: false,
};

const SYSTEM = [
  { type: 'text' as const, text: 'BLOCK A', cache_control: { type: 'ephemeral' as const, ttl: '1h' as const } },
  { type: 'text' as const, text: 'BLOCK B', cache_control: { type: 'ephemeral' as const, ttl: '5m' as const } },
  { type: 'text' as const, text: 'BLOCK C', cache_control: { type: 'ephemeral' as const, ttl: '5m' as const } },
];

function ghostReq(over: Partial<LlmRequest> = {}): LlmRequest {
  return {
    route: 'ghost',
    task: 'ghost',
    model: 'claude-haiku-5-5',
    system: SYSTEM,
    messages: [{ role: 'user', content: 'TAIL' }],
    maxTokens: 200,
    thinking: 'disabled',
    effort: 'low',
    schema: GHOST_SCHEMA,
    ...over,
  };
}

function actionsReq(over: Partial<LlmRequest> = {}): LlmRequest {
  return { ...ghostReq(), route: 'actions', task: 'instruct', model: 'claude-sonnet-5-5', maxTokens: 2048, thinking: 'between_tools', schema: { type: 'object' }, ...over };
}

function keysDeep(v: unknown, out = new Set<string>()): Set<string> {
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysDeep(x, out);
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------ */

describe('request builder', () => {
  it('Haiku 5.5 ghost: exact body (cache_control on the system blocks, thinking disabled, effort low, json_schema, no sampling params)', () => {
    const body = buildMessageParams(ghostReq(), { stream: true });
    expect(body).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 200,
      system: [
        { type: 'text', text: 'BLOCK A', cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: 'BLOCK B', cache_control: { type: 'ephemeral', ttl: '5m' } },
        { type: 'text', text: 'BLOCK C', cache_control: { type: 'ephemeral', ttl: '5m' } },
      ],
      messages: [{ role: 'user', content: 'TAIL' }],
      thinking: { type: 'disabled' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: GHOST_SCHEMA } },
      stream: true,
    });
    // The serialized body: cache_control only on system blocks; never on the tail; no top-level cache_control.
    const json = JSON.stringify(body);
    expect(json.match(/cache_control/g)?.length).toBe(3);
    const keys = keysDeep(body);
    for (const k of ['temperature', 'top_p', 'top_k', 'budget_tokens']) expect(keys.has(k)).toBe(false);
    expect('cache_control' in body).toBe(false);
  });

  it('Sonnet 5.5 actions: exact body (thinking between_tools, never disabled)', () => {
    const body = buildMessageParams(actionsReq({ stopSequences: ['\n\n', ''] }), { stream: true });
    expect(body).toEqual({
      model: 'claude-sonnet-5-5',
      max_tokens: 2048,
      system: [
        { type: 'text', text: 'BLOCK A', cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: 'BLOCK B', cache_control: { type: 'ephemeral', ttl: '5m' } },
        { type: 'text', text: 'BLOCK C', cache_control: { type: 'ephemeral', ttl: '5m' } },
      ],
      messages: [{ role: 'user', content: 'TAIL' }],
      thinking: { type: 'between_tools' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object' } } },
      stream: true,
      stop_sequences: ['\n\n'],
    });
    for (const k of ['temperature', 'top_p', 'top_k']) expect(keysDeep(body).has(k)).toBe(false);
  });

  it('a block without cache_control stays without it; a pre-warm body omits the format and carries max_tokens 0', () => {
    const body = buildMessageParams(ghostReq({ system: [{ type: 'text', text: 'X' }, { type: 'text', text: 'Y', cache_control: { type: 'ephemeral' } }] }), { stream: false, maxTokens: 0, includeFormat: false });
    expect(body.system).toEqual([{ type: 'text', text: 'X' }, { type: 'text', text: 'Y', cache_control: { type: 'ephemeral' } }]);
    expect(body.max_tokens).toBe(0);
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body.stream).toBe(false);
  });

  it('thinking per model: never disabled on Sonnet 5.5 / Opus 5.5; between_tools only on Sonnet 5.5', () => {
    expect(thinkingParam('claude-haiku-5-5', 'disabled')).toEqual({ type: 'disabled' });
    expect(thinkingParam('claude-haiku-5-5', 'between_tools')).toEqual({ type: 'disabled' });
    expect(thinkingParam('claude-sonnet-5-5', 'disabled')).toEqual({ type: 'between_tools' });
    expect(thinkingParam('claude-sonnet-5-5', 'between_tools')).toEqual({ type: 'between_tools' });
    expect(thinkingParam('claude-opus-5-5', 'disabled')).toEqual({ type: 'adaptive' });
    expect(thinkingParam('claude-opus-5-5', 'between_tools')).toEqual({ type: 'adaptive' });
    expect(thinkingParam('claude-fable-5-1', 'disabled')).toEqual({ type: 'adaptive' });
    expect(thinkingParam('claude-sonnet-5-5', 'adaptive')).toEqual({ type: 'adaptive' });
    expect(modelFamily('claude-haiku-5-5')).toBe('haiku-5-5');
    expect(modelFamily('claude-sonnet-5')).toBe('other');
    expect(thinkingParam('claude-sonnet-5', 'between_tools')).toEqual({ type: 'disabled' });
  });
});

/* ------------------------------------------------------------------------------------ */

type Ev = Anthropic.RawMessageStreamEvent;

function streamEvents(text: string[], opts: { model?: string; stop?: string } = {}): Ev[] {
  const evs: unknown[] = [
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: opts.model ?? 'claude-haiku-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 27000, cache_creation_input_tokens: 120, cache_creation: { ephemeral_5m_input_tokens: 120, ephemeral_1h_input_tokens: 0 } },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...text.map((t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: opts.stop ?? 'end_turn', stop_sequence: null }, usage: { output_tokens: 42, input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null } },
    { type: 'message_stop' },
  ];
  return evs as Ev[];
}

async function* iter(evs: Ev[]): AsyncGenerator<Ev> {
  for (const e of evs) yield e;
}

describe('stream folding and usage', () => {
  it('accumulates text, keeps the cache_creation split, takes output tokens from message_delta, measures TTFT at the first text delta', async () => {
    let t = 100;
    const now = () => (t += 10);
    const r = await consumeStream(iter(streamEvents(['{"text":"We', ' measure."', ',"fact_ids":[],"cite_keys":[],"fulfilled_move_ids":[]}'])), 100, now);
    expect(r.text).toBe('{"text":"We measure.","fact_ids":[],"cite_keys":[],"fulfilled_move_ids":[]}');
    expect(r.model).toBe('claude-haiku-5-5');
    expect(r.stopReason).toBe('end_turn');
    expect(r.ttftMs).toBe(10);
    expect(r.usage).toEqual({
      input_tokens: 40,
      output_tokens: 42,
      cache_read_input_tokens: 27000,
      cache_creation_input_tokens: 120,
      cache_creation: { ephemeral_5m_input_tokens: 120, ephemeral_1h_input_tokens: 0 },
    });
    expect(GhostOutput.parse(parseJsonOutput(r.text))).toEqual({ text: 'We measure.', fact_ids: [], cite_keys: [], fulfilled_move_ids: [] });
  });

  it('usageFromApi tolerates nulls; parseJsonOutput rejects truncation and accepts one fenced object', () => {
    expect(usageFromApi({ input_tokens: 3, output_tokens: 2, cache_read_input_tokens: null, cache_creation_input_tokens: null, cache_creation: null })).toEqual({ input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    expect(parseJsonOutput('{"text":"We mea')).toBeNull();
    expect(parseJsonOutput('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonOutput('')).toBeNull();
  });
});

/* ------------------------------------------------------------------------------------ */

function sseResponse(evs: Ev[]): Response {
  const body = evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_test_1' } });
}

function errorResponse(status: number, type: string): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message: type } }), { status, headers: { 'content-type': 'application/json' } });
}

describe('real client over the SDK (injected fetch, no network)', () => {
  const saved = { base: process.env.ANTHROPIC_BASE_URL, paper: process.env.PAPER_ANTHROPIC_BASE_URL };
  afterEach(() => {
    if (saved.base === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = saved.base;
    if (saved.paper === undefined) delete process.env.PAPER_ANTHROPIC_BASE_URL;
    else process.env.PAPER_ANTHROPIC_BASE_URL = saved.paper;
  });

  it('streams a ghost request to the public API (ignores ANTHROPIC_BASE_URL), sends the key once as the bearer credential, returns usage, TTFT and cost', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://sandbox-proxy.invalid';
    const seen: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return sseResponse(streamEvents(['{"text":"We measure the efficiency.","fact_ids":[],"cite_keys":[],"fulfilled_move_ids":[]}']));
    }) as typeof fetch;
    const client = createRealLlmClient({ apiKey: 'sk-ant-test-0123456789', baseURL: resolveBaseUrl(), fetch: fetchStub });
    const res = await client.complete(ghostReq());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`${DEFAULT_BASE_URL}/v1/messages`);
    // SDK 1.6 sends the API key as `Authorization: Bearer <key>`.
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer sk-ant-test-0123456789');
    expect(seen[0]!.headers.get('x-api-key')).toBeNull();
    expect(seen[0]!.body).toEqual(JSON.parse(JSON.stringify(buildMessageParams(ghostReq(), { stream: true }))));
    expect(res.text).toContain('We measure the efficiency.');
    expect(res.json).toEqual({ text: 'We measure the efficiency.', fact_ids: [], cite_keys: [], fulfilled_move_ids: [] });
    expect(res.model).toBe('claude-haiku-5-5');
    expect(res.requestId).toBe('req_test_1');
    expect(res.usage.cache_read_input_tokens).toBe(27000);
    expect(res.ttftMs).not.toBeNull();
    expect(res.stopReason).toBe('end_turn');
    expect(typeof res.costUsd).toBe('number');
  });

  it('PAPER_ANTHROPIC_BASE_URL is the only base URL override', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://sandbox-proxy.invalid';
    delete process.env.PAPER_ANTHROPIC_BASE_URL;
    expect(resolveBaseUrl()).toBe(DEFAULT_BASE_URL);
    process.env.PAPER_ANTHROPIC_BASE_URL = 'https://gateway.example.org/anthropic/';
    expect(resolveBaseUrl()).toBe('https://gateway.example.org/anthropic');
    process.env.PAPER_ANTHROPIC_BASE_URL = 'not a url';
    expect(resolveBaseUrl()).toBe(DEFAULT_BASE_URL);
  });

  it('actions: retries 529 / 429 twice with backoff, then gives up; ghost: never retries', async () => {
    let calls = 0;
    const statuses = [529, 429, 200];
    const fetchStub = (async () => {
      const s = statuses[calls++] ?? 200;
      return s === 200 ? sseResponse(streamEvents(['{"ok":true}'], { model: 'claude-sonnet-5-5' })) : errorResponse(s, s === 529 ? 'overloaded_error' : 'rate_limit_error');
    }) as typeof fetch;
    const waits: number[] = [];
    const client = createRealLlmClient({ apiKey: 'sk-ant-test-0123456789', fetch: fetchStub, sleep: async (ms) => void waits.push(ms) });
    const res = await client.complete(actionsReq());
    expect(calls).toBe(3);
    expect(waits).toHaveLength(2);
    expect(res.json).toEqual({ ok: true });

    calls = 0;
    statuses.splice(0, 3, 529, 529, 529, 529);
    await expect(client.complete(actionsReq())).rejects.toBeInstanceOf(Anthropic.APIError);
    expect(calls).toBe(3);

    calls = 0;
    await expect(client.complete(ghostReq())).rejects.toBeInstanceOf(Anthropic.APIError);
    expect(calls).toBe(1);
  });

  it('a 400 is not retried; an aborted request throws an abort error', async () => {
    let calls = 0;
    const client = createRealLlmClient({ apiKey: 'sk-ant-test-0123456789', fetch: (async () => (calls++, errorResponse(400, 'invalid_request_error'))) as typeof fetch, sleep: async () => {} });
    await expect(client.complete(actionsReq())).rejects.toBeInstanceOf(Anthropic.BadRequestError);
    expect(calls).toBe(1);
    const ctl = new AbortController();
    ctl.abort();
    await expect(client.complete(actionsReq({ signal: ctl.signal }))).rejects.toMatchObject({ name: 'LlmAbortError' });
  });

  it('pre-warm: default max_tokens 1 with the format (the cache key of the structured requests); opt-in zero mode sends max_tokens 0 without it and falls back to 1 when 0 is rejected', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let reject0 = false;
    const fetchStub = (async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (reject0 && body.max_tokens === 0) return errorResponse(400, 'invalid_request_error');
      return new Response(
        JSON.stringify({ id: 'msg_w', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: 'max_tokens', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: 9000, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 4000, ephemeral_1h_input_tokens: 5000 } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const def = createRealLlmClient({ apiKey: 'sk-ant-test-0123456789', fetch: fetchStub });
    await def.prewarm(ghostReq({ messages: [] }));
    expect(bodies[0]).toMatchObject({ max_tokens: 1, stream: false, output_config: { effort: 'low', format: { type: 'json_schema', schema: GHOST_SCHEMA } }, thinking: { type: 'disabled' } });
    bodies.length = 0;
    const client = createRealLlmClient({ apiKey: 'sk-ant-test-0123456789', fetch: fetchStub, prewarmMode: 'zero' });
    const u = await client.prewarm(ghostReq({ messages: [] }));
    expect(u?.cache_creation_input_tokens).toBe(9000);
    expect(bodies[0]).toMatchObject({ max_tokens: 0, stream: false, output_config: { effort: 'low' }, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'warmup' }] });
    expect((bodies[0]!.output_config as Record<string, unknown>).format).toBeUndefined();

    reject0 = true;
    bodies.length = 0;
    const client2 = createRealLlmClient({ apiKey: 'sk-ant-test-0123456789', fetch: fetchStub, prewarmMode: 'zero' });
    const u2 = await client2.prewarm(ghostReq({ model: 'claude-haiku-5-5' }));
    expect(u2).not.toBeNull();
    expect(bodies.map((b) => b.max_tokens)).toEqual([0, 1]);
    expect((bodies[1]!.output_config as Record<string, unknown>).format).toEqual({ type: 'json_schema', schema: GHOST_SCHEMA });
    bodies.length = 0;
    await client2.prewarm(ghostReq({ model: 'claude-haiku-5-5' }));
    expect(bodies.map((b) => b.max_tokens)).toEqual([1]);
  });

  it('retry classification and backoff', () => {
    const h = new Headers();
    expect(isRetryable(Anthropic.APIError.generate(529, { error: { type: 'overloaded_error' } }, 'x', h))).toBe(true);
    expect(isRetryable(Anthropic.APIError.generate(429, { error: { type: 'rate_limit_error' } }, 'x', h))).toBe(true);
    expect(isRetryable(Anthropic.APIError.generate(400, { error: { type: 'invalid_request_error' } }, 'x', h))).toBe(false);
    expect(isRetryable(new Anthropic.APIUserAbortError())).toBe(false);
    const ra = new Headers({ 'retry-after': '2' });
    expect(retryDelayMs(Anthropic.APIError.generate(429, {}, 'x', ra), 0, () => 0)).toBe(2000);
    expect(retryDelayMs(new Error('x'), 1, () => 0.5)).toBe(1000);
  });
});

/* ------------------------------------------------------------------------------------ */

describe('API key resolution (env or keychain only, fail soft)', () => {
  it('prefers ANTHROPIC_API_KEY, then the keychain helper, else none', () => {
    const calls: string[][] = [];
    const run = (cmd: string, args: string[]) => (calls.push([cmd, ...args]), 'sk-ant-from-keychain-123');
    expect(resolveApiKey({ env: { ANTHROPIC_API_KEY: ' sk-ant-env-0123456 ' }, run })).toEqual({ key: 'sk-ant-env-0123456', source: 'env' });
    expect(calls).toHaveLength(0);
    expect(resolveApiKey({ env: {}, platform: 'darwin', run })).toEqual({ key: 'sk-ant-from-keychain-123', source: 'keychain' });
    expect(calls[0]).toEqual(['security', 'find-generic-password', '-s', 'paper-copilot', '-w']);
    expect(resolveApiKey({ env: {}, platform: 'linux', run }).source).toBe('keychain');
    expect(calls[1]).toEqual(['secret-tool', 'lookup', 'service', 'paper-copilot']);
    expect(resolveApiKey({ env: {}, platform: 'linux', run: () => null })).toEqual({ key: null, source: 'none' });
    expect(resolveApiKey({ env: {}, platform: 'win32', run })).toEqual({ key: null, source: 'none' });
    // A keychain prompt or error text is not a key.
    expect(keychainLookup('linux', () => 'No such secret here')).toBeNull();
  });

  it('createLlmClient: fake without a key or when asked', () => {
    expect(createLlmClient({ apiKey: null, fake: false }).fake).toBe(true);
    expect(createLlmClient({ apiKey: 'sk-ant-x-0123456789', fake: true }).fake).toBe(true);
    expect(createLlmClient({ apiKey: 'sk-ant-x-0123456789', fake: false }).fake).toBe(false);
  });
});

/* ------------------------------------------------------------------------------------ */

describe('fake client', () => {
  it('ghost: deterministic, schema-valid, continues the prefix, states only hinted fact renderings, labelled fake-<model>', async () => {
    const c = createFakeLlmClient();
    const req = ghostReq({ fakeHint: { task: 'ghost', prefix: 'The efficiency gain', step: { id: 's1', intent: 'state the gain over the 2 baselines', factIds: ['f1'] }, facts: [{ id: 'f1', rendering: '2.32~points' }] } });
    const a = await c.complete(req);
    const b = await c.complete(req);
    expect(a.text).toBe(b.text);
    const out = GhostOutput.parse(a.json);
    expect(out.text.startsWith('The efficiency gain ')).toBe(true);
    // grammatical: a bare noun phrase gets a verb ("The efficiency gain is 2.32~points.")
    expect(out.text).toBe('The efficiency gain is 2.32~points.');
    expect(out.text.replace('2.32', '')).not.toMatch(/\d/);
    expect(out.fact_ids).toEqual(['f1']);
    expect(out.fulfilled_move_ids).toEqual(['s1']);
    expect(a.model).toBe('fake-claude-haiku-5-5');
    expect(a.costUsd).toBe(0);
    expect(await c.prewarm(req)).toBeNull();
  });

  it('instruct and other tasks are schema-valid; unknown tasks get a minimal schema-valid object', async () => {
    const c = createFakeLlmClient();
    const r = await c.complete(actionsReq({ fakeHint: { task: 'instruct', sentence: 'We utilize  the tracker \\cite{a}.', instruction: '更简洁', notesLanguage: 'zh', factIds: [], citeKeys: ['a'] } }));
    const out = InstructOutput.parse(r.json);
    expect(out.text).toBe('We use the tracker \\cite{a}.');
    expect(out.notes).toMatch(/模拟/);
    expect(fakeFromSchema({ type: 'object', properties: { a: { type: 'string' }, b: { anyOf: [{ type: 'string' }, { type: 'null' }] }, c: { type: 'array' }, d: { enum: ['x', 'y'] } } })).toEqual({ a: '', b: null, c: [], d: 'x' });
  });

  it('without a hint, recovers the prefix / sentence from the tail text', async () => {
    const c = createFakeLlmClient();
    const g = await c.complete(ghostReq({ messages: [{ role: 'user', content: 'Context...\n<prefix>We train the</prefix>\n' }] }));
    expect(GhostOutput.parse(g.json).text.startsWith('We train the ')).toBe(true);
    const i = await c.complete(actionsReq({ messages: [{ role: 'user', content: 'Sentence: We utilize the tracker.\nInstruction: shorter' }] }));
    expect(InstructOutput.parse(i.json).text).toBe('We use the tracker.');
    const j = await c.complete(actionsReq({ messages: [{ role: 'user', content: '<sentence>We utilize X.</sentence>\n<instruction lang="zh">\n更简洁\n</instruction>' }] }));
    expect(InstructOutput.parse(j.json).notes).toContain('更简洁');
  });

  it('PAPER_FAKE_SCRIPT responder: first matching rule by task and substring, re-read per call, missing/malformed file scripts nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'paper-test-script-'));
    try {
      const file = join(dir, 'script.json');
      const c = createFakeLlmClient({ respond: fileScriptResponder(file) });
      const hint = { task: 'instruct', sentence: 'We utilize the tracker.', instruction: 'say the factor', notesLanguage: 'en', factIds: [], citeKeys: [] };
      // no file yet: the default simulated rewrite
      expect(InstructOutput.parse((await c.complete(actionsReq({ fakeHint: hint }))).json).text).toBe('We use the tracker.');
      const scripted = { text: 'We use the tracker, which keeps 2.5 times fewer fake tracks.', notes: 'scripted', drift: { actor: false, scope: false, direction: false, condition: false }, fact_ids: [], cite_keys: [] };
      writeFileSync(file, JSON.stringify({ rules: [{ task: 'ghost', json: { text: 'never' } }, { task: 'instruct', match: 'nothing like this', text: 'never' }, { task: 'instruct', match: 'the factor', json: scripted }] }));
      const r = await c.complete(actionsReq({ fakeHint: hint }));
      expect(InstructOutput.parse(r.json)).toEqual(scripted);
      expect(r.model).toMatch(/^fake-/);
      // a raw-text rule (the client parses it against the schema)
      writeFileSync(file, JSON.stringify({ rules: [{ match: 'the factor', text: JSON.stringify(scripted) }] }));
      expect((await c.complete(actionsReq({ fakeHint: hint }))).json).toEqual(scripted);
      writeFileSync(file, '{ not json');
      expect(InstructOutput.parse((await c.complete(actionsReq({ fakeHint: hint }))).json).text).toBe('We use the tracker.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honours abort during simulated latency', async () => {
    const c = createFakeLlmClient({ latencyMs: 200 });
    const ctl = new AbortController();
    const p = c.complete(ghostReq({ signal: ctl.signal }));
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: 'LlmAbortError' });
  });
});

/* ------------------------------------------------------------------------------------ */

function coreFictionalReady(): boolean {
  try {
    extractFictionalNumbers({});
    return true;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('not implemented')) return false;
    throw e;
  }
}

describe('skill loader', () => {
  let tmp: string | null = null;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it('loads SKILL.md + references, version = sha256 of contents (stable), reloads on change', () => {
    tmp = mkdtempSync(join(tmpdir(), 'skill-'));
    cpSync(SKILL_DIR, tmp, { recursive: true });
    const a = readSkillBundle(tmp)!;
    const b = readSkillBundle(SKILL_DIR)!;
    expect(a.version).toMatch(/^[0-9a-f]{64}$/);
    expect(a.version).toBe(b.version);
    expect(Object.keys(a.references).sort()).toEqual(['figures-and-evidence.md', 'layering-and-flow.md', 'sentences-and-words.md', 'story-and-structure.md']);
    expect(a.skillMd.length).toBeGreaterThan(1000);

    const loader = createSkillLoader(() => tmp!, { checkIntervalMs: 0 });
    const v1 = loader.get()!.version;
    expect(loader.get()!.version).toBe(v1);
    const f = join(tmp, 'references', 'sentences-and-words.md');
    writeFileSync(f, a.references['sentences-and-words.md'] + '\nAn extra line.\n');
    const later = new Date(Date.now() + 5000);
    utimesSync(f, later, later);
    const v2 = loader.get()!.version;
    expect(v2).not.toBe(v1);
    writeFileSync(join(tmp, 'references', 'new-ref.md'), '# new\n');
    expect(Object.keys(loader.get()!.references)).toContain('new-ref.md');
    rmSync(join(tmp, 'SKILL.md'));
    expect(loader.get()).toBeNull();
    expect(loader.fictionalNumbers()).toEqual([]);
  });

  it.skipIf(!coreFictionalReady())('fictional numbers are extracted once per version and sorted', () => {
    const loader = createSkillLoader(() => SKILL_DIR, { checkIntervalMs: 0 });
    const n1 = loader.fictionalNumbers();
    const n2 = loader.fictionalNumbers();
    expect(n2).toBe(n1);
    expect([...n1].sort()).toEqual(n1);
  });
});
