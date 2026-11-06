/**
 * The REAL direct-API path, without an API key: LlmService -> createLlmClient (fake=false, key
 * 'sk-ant-test' from ANTHROPIC_API_KEY, base URL from PAPER_ANTHROPIC_BASE_URL) -> @anthropic-ai/sdk ->
 * HTTP -> a local mock of the Messages API (test/support/mockAnthropic.ts), which validates every
 * request against the API's rules and paper-copilot's own request policy and records it.
 *
 * Covered: ghost (stream, TTFT, gate, one regeneration, no retries), instruct / alternatives / grammar
 * / intent / re-plan request shapes, pre-warm and keep-alive shapes and their cache reads, retries with
 * backoff on 429 / 529 / mid-stream overload / connection resets for actions only, abort mid-stream,
 * stalled and truncated streams, malformed and partial JSON, max_tokens stops, unknown-model cost.
 * Every test ends with zero validation violations recorded by the mock.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage, SentenceVersion } from '@paper-copilot/core';
import type { Ctx } from '../src/contracts';
import { createLlmService, createRealLlmClient } from '../src/services/llm';
import { SKILL_DIR, makeTempProject, makeTestCtx, type TempProject } from './helpers/ctx';
import { DRAFT, MAIN, MAIN_TEXT, PREFIX, U1, fakeDb, fakeFacts, fakeLit, fakeVoice, outline, standardDocs, type FakeDocs } from './support/llmFixtures';
import { errorReply, jsonReply, startMockAnthropic, textReply, type MockAnthropic, type RecordedRequest } from './support/mockAnthropic';

const PERF_SLACK = process.env.CI ? 3 : 1;
const KEY = 'sk-ant-test';

let mock: MockAnthropic;
let project: TempProject;
let ctx: Ctx & { events: ServerMessage[] };
let docs: FakeDocs;
let versions: Map<string, SentenceVersion[]>;
let built: Array<ReturnType<typeof createLlmService>> = [];
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['ANTHROPIC_API_KEY', 'PAPER_ANTHROPIC_BASE_URL', 'PAPER_PREWARM_MODE', 'PAPER_FAKE_LATENCY_MS'];

beforeEach(async () => {
  mock = await startMockAnthropic({ apiKey: KEY, policy: 'app' });
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.ANTHROPIC_API_KEY = KEY;
  process.env.PAPER_ANTHROPIC_BASE_URL = mock.url;
  delete process.env.PAPER_PREWARM_MODE;
  delete process.env.PAPER_FAKE_LATENCY_MS;
  // This sandbox (and other tools on a laptop) export ANTHROPIC_BASE_URL for themselves; the app must
  // never follow it. It stays set to the public API here: if the client used it, the mock would see nothing.
  expect(process.env.ANTHROPIC_BASE_URL ?? 'unset').not.toBe(mock.url);

  project = await makeTempProject();
  versions = new Map();
  docs = standardDocs();
  ctx = makeTestCtx(project, { fakeLlm: false, docs, facts: fakeFacts(), lit: fakeLit(), voice: fakeVoice(), db: fakeDb(versions) });
  await ctx.files.writeJson(ctx.paths.outline, outline());
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const svc of built.splice(0)) await svc.close?.();
  const violations = mock.describeViolations();
  await mock.close();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  project.cleanup();
  // Every request any test sent satisfies the API's rules and the app's own policy.
  expect(violations).toBe('');
});

function build(): ReturnType<typeof createLlmService> {
  const svc = createLlmService(ctx, { skillCheckIntervalMs: 0 });
  built.push(svc);
  (ctx as { llm: unknown }).llm = svc;
  return svc;
}

function ghostMsg(over: Partial<{ requestId: string; cursor: number; prefix: string; trigger: 'boundary' | 'pause' | 'manual'; version: number; file: string }> = {}) {
  return { type: 'ghost.request' as const, requestId: 'g1', file: MAIN, version: 1, cursor: MAIN_TEXT.length, trigger: 'pause' as const, prefix: PREFIX, ...over };
}

async function ghost(svc: ReturnType<typeof createLlmService>, msg = ghostMsg()): Promise<ServerMessage[]> {
  const sent: ServerMessage[] = [];
  await svc.handleGhostRequest(msg, (m) => sent.push(m));
  return sent;
}

const ghostOut = (text: string, extra: Partial<{ fact_ids: string[]; cite_keys: string[]; fulfilled_move_ids: string[] }> = {}) => ({ text, fact_ids: [], cite_keys: [], fulfilled_move_ids: [], ...extra });
const GOOD_GHOST = ghostOut(`${PREFIX} 2.32~points over the baseline.`, { fact_ids: ['f.g1.delta_points'], fulfilled_move_ids: ['step-gain'] });
const INSTRUCT_OUT = { text: 'We compare both trackers on the same events, as in Ref.~\\cite{Wang2022LRT}.', notes: '更简洁。', drift: { actor: false, scope: false, direction: false, condition: false }, fact_ids: [], cite_keys: ['Wang2022LRT'] };

const userText = (r: RecordedRequest): string => {
  const msgs = (r.body?.messages ?? []) as Array<{ content: unknown }>;
  return msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
};
const systemOf = (r: RecordedRequest) => r.body!.system as Array<{ type: string; text: string; cache_control?: { type: string; ttl?: string } }>;

async function costLines(svc: ReturnType<typeof createLlmService>): Promise<Array<Record<string, unknown>>> {
  await svc.close?.();
  if (!existsSync(ctx.paths.costLog)) return [];
  return readFileSync(ctx.paths.costLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/* ------------------------------------------------------------------------------------ */
/* Ghost                                                                                 */
/* ------------------------------------------------------------------------------------ */

describe('ghost on the real client', () => {
  it('streams one Haiku request with the app headers and body; TTFT is measured; the gated continuation is sent', async () => {
    mock.enqueue(jsonReply(GOOD_GHOST, { firstByteDelayMs: 60, eventDelayMs: 2, chunkChars: 7 }));
    const svc = build();
    expect(svc.client.fake).toBe(false);
    const sent = await ghost(svc);
    expect(sent.map((m) => m.type)).toEqual(['ghost.result']);
    const r = sent[0]!;
    if (r.type !== 'ghost.result') return;
    expect(r.text).toBe(' 2.32~points over the baseline.');
    expect(r.factIds).toEqual(['f.g1.delta_points']);
    expect(r.fulfilledMoveIds).toEqual(['step-gain']);
    expect(r.model).toBe('claude-haiku-5-5');

    const reqs = mock.messages();
    expect(reqs).toHaveLength(1);
    const q = reqs[0]!;
    // @anthropic-ai/sdk 1.x sends the API key as a Bearer credential; exactly one auth header, the app's key.
    expect(q.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(q.headers['x-api-key']).toBeUndefined();
    expect(q.headers['anthropic-version']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(q.headers['x-stainless-retry-count']).toBe('0');
    expect(q.stream).toBe(true);
    expect(q.body).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 200, thinking: { type: 'disabled' }, output_config: { effort: 'low', format: { type: 'json_schema' } }, stream: true });
    for (const k of ['temperature', 'top_p', 'top_k', 'cache_control', 'tools']) expect(q.body).not.toHaveProperty(k);
    const sys = systemOf(q);
    // [A skill 1h, B paper 5m, C exemplars 5m, task rules uncached]: the 1h breakpoint comes first.
    expect(sys.map((b) => b.cache_control)).toEqual([{ type: 'ephemeral', ttl: '1h' }, { type: 'ephemeral', ttl: '5m' }, { type: 'ephemeral', ttl: '5m' }, undefined]);
    // block A carries the author's skill file unchanged
    expect(sys[0]!.text).toContain(readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8').split('\n').find((l) => l.trim().length > 20)!.trim());
    expect(userText(q)).toContain(PREFIX);

    const lines = await costLines(svc);
    const usage = lines.find((l) => l.kind === 'usage' && l.route === 'ghost')!;
    expect(usage).toBeTruthy();
    expect(usage.model).toBe('claude-haiku-5-5');
    expect(usage.ttftMs as number).toBeGreaterThanOrEqual(55);
    expect(usage.ttftMs as number).toBeLessThanOrEqual(usage.ms as number);
    expect(usage.requestId).toMatch(/^req_mock/);
    // First request: the whole prefix is written (1h for block A, 5m for B and C); the price is known.
    const u = usage.usage as { cache_creation_input_tokens: number; cache_read_input_tokens: number; cache_creation: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number } };
    expect(u.cache_read_input_tokens).toBe(0);
    expect(u.cache_creation.ephemeral_1h_input_tokens).toBeGreaterThan(0);
    expect(u.cache_creation.ephemeral_5m_input_tokens).toBeGreaterThan(0);
    expect(usage.usd as number).toBeGreaterThan(0);
  });

  it('a second ghost on the same prefix reads the cache (byte-stable blocks A-C)', async () => {
    mock.enqueue(jsonReply(GOOD_GHOST), jsonReply(GOOD_GHOST));
    const svc = build();
    await ghost(svc, ghostMsg({ requestId: 'a' }));
    await ghost(svc, ghostMsg({ requestId: 'b' }));
    const lines = (await costLines(svc)).filter((l) => l.kind === 'usage');
    const second = lines[1]!.usage as { cache_read_input_tokens: number; cache_creation_input_tokens: number };
    expect(second.cache_read_input_tokens).toBeGreaterThan(1000);
    expect(second.cache_creation_input_tokens).toBe(0);
  });

  it('an invented number fails the gate: exactly one regeneration with the feedback, then the grounded sentence', async () => {
    mock.enqueue(jsonReply(ghostOut(`${PREFIX} 7.5 points over the baseline.`)), jsonReply(GOOD_GHOST));
    const svc = build();
    const sent = await ghost(svc);
    expect(sent.map((m) => m.type)).toEqual(['ghost.result']);
    const reqs = mock.messages();
    expect(reqs).toHaveLength(2);
    expect(userText(reqs[0]!)).not.toContain('previous_attempt_rejected');
    expect(userText(reqs[1]!)).toContain('<previous_attempt_rejected>');
    expect(userText(reqs[1]!)).toContain('7.5 points');
    // The regeneration changes only the tail: same system blocks, so it reads the cache.
    expect(systemOf(reqs[1]!)).toEqual(systemOf(reqs[0]!));
  });

  it('two gate failures: ghost.empty, never a third request, nothing shown', async () => {
    mock.enqueue(jsonReply(ghostOut(`${PREFIX} 7.5 points.`)), jsonReply(ghostOut(`${PREFIX} 9.1 points.`)));
    const svc = build();
    const sent = await ghost(svc);
    expect(sent.map((m) => m.type)).toEqual(['ghost.empty']);
    expect(mock.messages()).toHaveLength(2);
  });

  it('no retries on the ghost route: a 429 or a 529 is one request and a ghost.error', async () => {
    mock.enqueue(errorReply(429, 'rate_limit_error', { retryAfter: 0 }), errorReply(529, 'overloaded_error'));
    const svc = build();
    const a = await ghost(svc, ghostMsg({ requestId: 'r1' }));
    expect(a.map((m) => m.type)).toEqual(['ghost.error']);
    expect(mock.messages()).toHaveLength(1);
    const b = await ghost(svc, ghostMsg({ requestId: 'r2' }));
    expect(b.map((m) => m.type)).toEqual(['ghost.error']);
    expect(mock.messages()).toHaveLength(2);
    if (b[0]!.type === 'ghost.error') expect(b[0]!.message).toMatch(/529|overloaded/i);
  });

  it('cancel mid-stream aborts the HTTP request at once and sends nothing', async () => {
    const svc = build();
    let arrived!: () => void;
    const got = new Promise<void>((r) => (arrived = r));
    mock.enqueue(() => {
      arrived();
      return jsonReply(GOOD_GHOST, { eventDelayMs: 40, chunkChars: 2 });
    });
    const sent: ServerMessage[] = [];
    const t0 = performance.now();
    const p = svc.handleGhostRequest(ghostMsg({ requestId: 'c1' }), (m) => sent.push(m));
    await got;
    await new Promise((r) => setTimeout(r, 120));
    svc.cancelGhost('c1');
    await p;
    const ms = performance.now() - t0;
    expect(sent).toEqual([]);
    // the full stream would take > 60 events x 40 ms
    expect(ms).toBeLessThan(1500 * PERF_SLACK);
    expect(mock.messages()).toHaveLength(1);
  });

  it('a newer request for the same file supersedes the running one (aborted, silent)', async () => {
    const svc = build();
    mock.enqueue(jsonReply(GOOD_GHOST, { eventDelayMs: 40, chunkChars: 2 }), jsonReply(GOOD_GHOST));
    const first: ServerMessage[] = [];
    const p1 = svc.handleGhostRequest(ghostMsg({ requestId: 's1' }), (m) => first.push(m));
    await vi.waitFor(() => expect(mock.messages()).toHaveLength(1));
    const second = await ghost(svc, ghostMsg({ requestId: 's2' }));
    await p1;
    expect(first).toEqual([]);
    expect(second.map((m) => m.type)).toEqual(['ghost.result']);
  });

  it('a truncated JSON whose text is complete is still shown (max_tokens stop)', async () => {
    mock.enqueue(textReply(`{"text":"${PREFIX} 2.32~points over the baseline.","fact_ids":["f.g1.de`, { stopReason: 'max_tokens' }));
    const svc = build();
    const sent = await ghost(svc);
    expect(sent.map((m) => m.type)).toEqual(['ghost.result']);
    expect(mock.messages()).toHaveLength(1);
  });

  it('malformed output (not JSON) is regenerated once, never shown', async () => {
    mock.enqueue(textReply('Sure! Here is a sentence: The efficiency gain is 2.32 points.'), textReply('{"text": "The efficiency gain is'));
    const svc = build();
    const sent = await ghost(svc);
    expect(sent.map((m) => m.type)).toEqual(['ghost.empty']);
    expect(mock.messages()).toHaveLength(2);
  });

  it('a stream cut before message_stop is not taken as a complete answer', async () => {
    // The text is a complete, grounded JSON object, but the stream never finished: a ghost must not be
    // built from a response the server did not complete.
    mock.enqueue(jsonReply(GOOD_GHOST, { truncate: true }));
    const svc = build();
    const sent = await ghost(svc);
    expect(sent.map((m) => m.type)).toEqual(['ghost.error']);
    expect(mock.messages()).toHaveLength(1);
  });

  it('ANTHROPIC_CUSTOM_HEADERS of another tool never reaches the API (it would replace the app key)', async () => {
    const saved = process.env.ANTHROPIC_CUSTOM_HEADERS;
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'Authorization: Bearer sk-ant-other-tool\nx-gateway-tenant: someone-else';
    try {
      mock.enqueue(jsonReply(GOOD_GHOST));
      const svc = build();
      const sent = await ghost(svc);
      expect(sent.map((m) => m.type)).toEqual(['ghost.result']);
      const q = mock.messages()[0]!;
      expect(q.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(q.headers['x-gateway-tenant']).toBeUndefined();
      // the variable is restored for whoever set it
      expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toContain('x-gateway-tenant');
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_CUSTOM_HEADERS;
      else process.env.ANTHROPIC_CUSTOM_HEADERS = saved;
    }
  });

  it('a stalled stream (headers, then silence) ends with an error after the idle timeout instead of hanging', async () => {
    const client = createRealLlmClient({ apiKey: KEY, baseURL: mock.url, streamIdleTimeoutMs: 300 });
    const svc = createLlmService(ctx, { client, skillCheckIntervalMs: 0 });
    built.push(svc);
    mock.enqueue(jsonReply(GOOD_GHOST, { eventDelayMs: 5000, chunkChars: 400 }));
    const t0 = performance.now();
    const sent = await ghost(svc);
    expect(performance.now() - t0).toBeLessThan(3000 * PERF_SLACK);
    expect(sent.map((m) => m.type)).toEqual(['ghost.error']);
  });
});

/* ------------------------------------------------------------------------------------ */
/* Actions                                                                               */
/* ------------------------------------------------------------------------------------ */

describe('sentence actions on the real client', () => {
  it('instruct: Sonnet with thinking between_tools, effort low, strict schema; the proposal is gated', async () => {
    mock.enqueue(jsonReply(INSTRUCT_OUT));
    const svc = build();
    const p = await svc.instruct('u1', '更简洁', 'zh');
    expect(p.text).toBe(INSTRUCT_OUT.text);
    expect(p.model).toBe('claude-sonnet-5-5');
    expect(p.issues.filter((i) => i.severity === 'block')).toEqual([]);
    const q = mock.messages()[0]!;
    expect(q.body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 2048, thinking: { type: 'between_tools' }, output_config: { effort: 'low', format: { type: 'json_schema' } }, stream: true });
    expect(userText(q)).toContain('更简洁');
    expect(userText(q)).toContain(U1);
  });

  it('alternatives, grammar and intent rendering send valid requests and return gated proposals', async () => {
    mock.enqueue(
      jsonReply({ alternatives: [{ text: 'Both trackers run on the same events, as in Ref.~\\cite{Wang2022LRT}.', note: 'a' }, { text: 'We run both trackers on the same events, as in Ref.~\\cite{Wang2022LRT}.', note: 'b' }] }),
      jsonReply({ text: U1, changes: [] }),
      jsonReply({ proposals: [{ text: 'The tracker gains 2.32~points.', fact_ids: ['f.g1.delta_points'], cite_keys: [], note: '一' }] }),
    );
    const svc = build();
    const alts = await svc.alternatives('u1', 2);
    expect(alts).toHaveLength(2);
    const g = await svc.grammar('u1');
    expect(g.origin).toBe('grammar_fix');
    const ps = await svc.renderIntent({ file: MAIN, line: 3, text: '效率提高 2.32 个点', n: 1 });
    expect(ps).toHaveLength(1);
    expect(ps[0]!.origin).toBe('ai_intent');
    const reqs = mock.messages();
    expect(reqs.map((r) => r.body!.max_tokens)).toEqual([3072, 1024, 3072]);
    expect(reqs.every((r) => (r.body!.thinking as { type: string }).type === 'between_tools')).toBe(true);
    // each task has its own output schema
    const schemas = reqs.map((r) => JSON.stringify((r.body!.output_config as { format: { schema: unknown } }).format.schema));
    expect(new Set(schemas).size).toBe(3);
  });

  it('re-plan: one actions request; only downstream proposed sentences may change', async () => {
    mock.enqueue(
      jsonReply({
        items: [
          { sentence_id: 'd1', action: 'revise', text: 'The training uses one seed set for both trackers.', reason: 'match' },
          { sentence_id: 'd2', action: 'drop', text: null, reason: 'accepted: ignored' },
          { sentence_id: 'd4', action: 'drop', text: null, reason: 'repeats' },
        ],
        remaining: [],
        paragraph_complete: true,
        next_opener: null,
      }),
    );
    const svc = build();
    await svc.replanAfterEdit(DRAFT, 'd0');
    expect(mock.messages()).toHaveLength(1);
    const ev = ctx.events.find((e) => e.type === 'replan.proposed');
    if (ev?.type !== 'replan.proposed') throw new Error('no replan.proposed');
    expect(ev.items.map((i) => i.sentenceId).sort()).toEqual(['d1', 'd4']);
  });

  it('retries 429 (honouring retry-after) and 529 for actions, then succeeds; the retries carry the same body', async () => {
    mock.enqueue(errorReply(429, 'rate_limit_error', { retryAfter: 0 }), errorReply(529, 'overloaded_error', { retryAfter: 0 }), jsonReply(INSTRUCT_OUT));
    const svc = build();
    const p = await svc.instruct('u1', 'shorter', 'en');
    expect(p.text).toBe(INSTRUCT_OUT.text);
    const reqs = mock.messages();
    expect(reqs.map((r) => r.status)).toEqual([429, 529, 200]);
    expect(JSON.stringify(reqs[2]!.body)).toBe(JSON.stringify(reqs[0]!.body));
    // the SDK's own retries are off: every attempt is a fresh request with retry count 0
    expect(reqs.every((r) => r.headers['x-stainless-retry-count'] === '0')).toBe(true);
  });

  it('retries a 529 without retry-after with exponential backoff (jittered), at most 2 retries, then 502', async () => {
    const waits: number[] = [];
    const client = createRealLlmClient({ apiKey: KEY, baseURL: mock.url, sleep: async (ms) => void waits.push(ms) });
    const svc = createLlmService(ctx, { client, skillCheckIntervalMs: 0 });
    built.push(svc);
    mock.enqueue(errorReply(529, 'overloaded_error'), errorReply(529, 'overloaded_error'), errorReply(529, 'overloaded_error'));
    await expect(svc.instruct('u1', 'shorter', 'en')).rejects.toMatchObject({ status: 502 });
    expect(mock.messages()).toHaveLength(3);
    expect(waits).toHaveLength(2);
    expect(waits[0]!).toBeGreaterThanOrEqual(250);
    expect(waits[0]!).toBeLessThanOrEqual(750);
    expect(waits[1]!).toBeGreaterThanOrEqual(500);
    expect(waits[1]!).toBeLessThanOrEqual(1500);
  });

  it('retries an overload that arrives as an error event mid-stream, and a 500', async () => {
    mock.enqueue(jsonReply(INSTRUCT_OUT, { streamError: { type: 'overloaded_error', message: 'Overloaded', afterEvents: 3 } }), errorReply(500, 'api_error', { retryAfter: 0 }), jsonReply(INSTRUCT_OUT));
    const client = createRealLlmClient({ apiKey: KEY, baseURL: mock.url, sleep: async () => {} });
    const svc = createLlmService(ctx, { client, skillCheckIntervalMs: 0 });
    built.push(svc);
    const p = await svc.instruct('u1', 'shorter', 'en');
    expect(p.text).toBe(INSTRUCT_OUT.text);
    expect(mock.messages()).toHaveLength(3);
  });

  it('retries a connection reset (before the response and in the middle of the stream) and a truncated stream', async () => {
    mock.enqueue({ kind: 'reset' }, jsonReply(INSTRUCT_OUT, { resetAfterEvents: 4 }), jsonReply(INSTRUCT_OUT, { truncate: true }), jsonReply(INSTRUCT_OUT));
    const client = createRealLlmClient({ apiKey: KEY, baseURL: mock.url, sleep: async () => {}, maxRetries: 3 });
    const svc = createLlmService(ctx, { client, skillCheckIntervalMs: 0 });
    built.push(svc);
    const p = await svc.instruct('u1', 'shorter', 'en');
    expect(p.text).toBe(INSTRUCT_OUT.text);
    expect(mock.messages()).toHaveLength(4);
  });

  it('a 400 is not retried', async () => {
    mock.enqueue(errorReply(400, 'invalid_request_error', { message: 'bad' }));
    const svc = build();
    await expect(svc.instruct('u1', 'shorter', 'en')).rejects.toMatchObject({ status: 502 });
    expect(mock.messages()).toHaveLength(1);
  });

  it('malformed JSON -> 502 "invalid response"; a max_tokens stop -> 502 "cut off"; a refusal -> 422', async () => {
    mock.enqueue(textReply('I cannot produce JSON today.'), textReply('{"text":"We compare', { stopReason: 'max_tokens' }), textReply('', { stopReason: 'refusal' }));
    const svc = build();
    await expect(svc.instruct('u1', 'a', 'en')).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/invalid response/) });
    await expect(svc.instruct('u1', 'b', 'en')).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/cut off/) });
    await expect(svc.instruct('u1', 'c', 'en')).rejects.toMatchObject({ status: 422 });
    expect(mock.messages()).toHaveLength(3);
  });

  it('an unknown model is still served; its cost is recorded as 0 and the request is valid for it', async () => {
    await ctx.saveConfig({ ...ctx.config, models: { ...ctx.config.models, actions: 'claude-unknown-9' } });
    mock.enqueue(jsonReply(INSTRUCT_OUT));
    const svc = build();
    const p = await svc.instruct('u1', 'shorter', 'en');
    expect(p.model).toBe('claude-unknown-9');
    const q = mock.messages()[0]!;
    expect(q.body!.model).toBe('claude-unknown-9');
    const usage = (await costLines(svc)).find((l) => l.kind === 'usage')!;
    expect(usage.model).toBe('claude-unknown-9');
    expect(usage.usd).toBe(0);
  });
});

/* ------------------------------------------------------------------------------------ */
/* Pre-warm and keep-alive                                                               */
/* ------------------------------------------------------------------------------------ */

describe('pre-warm and keep-alive on the real client', () => {
  it('default pre-warm: one non-streaming max_tokens 1 request per route with the route format; the next real request reads it', async () => {
    mock.fallback = () => textReply('{');
    const svc = build();
    await svc.prewarm(MAIN);
    const warms = mock.messages();
    expect(warms).toHaveLength(2);
    for (const w of warms) {
      expect(w.stream).toBe(false);
      expect(w.body!.max_tokens).toBe(1);
      expect(systemOf(w)).toHaveLength(2);
      expect((w.body!.output_config as { format?: unknown }).format).toBeTruthy();
    }
    const ghostWarm = warms.find((w) => w.body!.model === 'claude-haiku-5-5')!;
    const actionsWarm = warms.find((w) => w.body!.model === 'claude-sonnet-5-5')!;
    expect(ghostWarm.body).toMatchObject({ thinking: { type: 'disabled' }, output_config: { effort: 'low' } });
    expect(actionsWarm.body).toMatchObject({ thinking: { type: 'between_tools' }, output_config: { effort: 'low' } });

    mock.fallback = null;
    mock.enqueue(jsonReply(GOOD_GHOST), jsonReply(INSTRUCT_OUT));
    await ghost(svc);
    await svc.instruct('u1', 'shorter', 'en');
    const lines = (await costLines(svc)).filter((l) => l.kind === 'usage');
    const routeOf = (r: string) => lines.find((l) => l.route === r)!.usage as { cache_read_input_tokens: number };
    expect(routeOf('prewarm:ghost')).toBeTruthy();
    expect(routeOf('ghost').cache_read_input_tokens).toBeGreaterThan(1000);
    expect(routeOf('actions').cache_read_input_tokens).toBeGreaterThan(1000);
  });

  it('PAPER_PREWARM_MODE=zero: max_tokens 0, non-streaming, no output format (the API rejects max_tokens 0 with a format or a stream)', async () => {
    process.env.PAPER_PREWARM_MODE = 'zero';
    mock.fallback = () => textReply('');
    const svc = build();
    await svc.prewarm(MAIN);
    const warms = mock.messages();
    expect(warms).toHaveLength(2);
    for (const w of warms) {
      expect(w.body!.max_tokens).toBe(0);
      expect(w.stream).toBe(false);
      expect((w.body!.output_config as { format?: unknown }).format).toBeUndefined();
      expect(w.status).toBe(200);
    }
  });

  it('keep-alive refreshes the route prefix with the shape of the last real request', async () => {
    const pending: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 270_000) {
        pending.push(fn);
        return realSetTimeout(() => {}, 2 ** 31 - 1).unref();
      }
      return realSetTimeout(fn, ms, ...(rest as []));
    }) as typeof setTimeout);
    mock.enqueue(jsonReply(GOOD_GHOST));
    mock.fallback = () => textReply('{');
    const svc = build();
    await ghost(svc);
    expect(pending.length).toBeGreaterThanOrEqual(1);
    pending.shift()!();
    await vi.waitFor(() => expect(mock.messages()).toHaveLength(2));
    const [real, keep] = mock.messages();
    expect(keep!.stream).toBe(false);
    expect(keep!.body!.max_tokens).toBe(1);
    expect(keep!.body!.model).toBe(real!.body!.model);
    expect(keep!.body!.thinking).toEqual(real!.body!.thinking);
    expect(keep!.body!.output_config).toEqual(real!.body!.output_config);
    expect(systemOf(keep!)).toEqual(systemOf(real!).slice(0, 2));
    await vi.waitFor(async () => {
      const lines = await costLines(svc);
      expect(lines.some((l) => l.route === 'keepalive:ghost')).toBe(true);
    });
    const ka = (await costLines(svc)).find((l) => l.route === 'keepalive:ghost')!.usage as { cache_read_input_tokens: number };
    expect(ka.cache_read_input_tokens).toBeGreaterThan(1000);
  });
});
