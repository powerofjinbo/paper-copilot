/**
 * SDK review (reviewer, sdk lens): Claude API and Agent SDK correctness without an API key.
 *
 * Direct API: the REAL client (createRealLlmClient, @anthropic-ai/sdk 1.6) runs with an injected fetch
 * that records every HTTP body and answers with scripted SSE / JSON, so these tests see the exact
 * request the SDK would put on the wire for each route.
 *
 * Agent SDK: the real @anthropic-ai/claude-agent-sdk 0.3.318 drives the real Claude Code binary
 * (/opt/claude-code/bin/claude, 2.1.318) against a local fake Messages API on 127.0.0.1, so skill
 * discovery, the MCP editor server, the PostToolUse gate hook and the outgoing request bodies are
 * checked end to end. Those tests are skipped when the binary is missing.
 *
 * Tests whose name starts with "BUG:" fail on the current code and demonstrate a finding; the others
 * are regression tests for properties that hold today.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as agentSdk from '@anthropic-ai/claude-agent-sdk';
import {
  PRICES,
  costOf,
  emptyOutline,
  hashString,
  normalizeForHash,
  outputJsonSchema,
  type Fact,
  type Outline,
  type PlanStep,
  type SentenceUnit,
  type ServerMessage,
} from '@paper-copilot/core';
import { HttpError, type Ctx, type DocService, type DocState, type FactService, type LitService, type PaperDb, type VoiceService } from '../../src/contracts';
import { createRealLlmClient } from '../../src/services/llm/client';
import { resolveBaseUrl } from '../../src/services/llm/apiKey';
import { createLlmService } from '../../src/services/llm';
import { buildQueryOptions, ISOLATION_ENV } from '../../src/services/agents/options';
import { buildEditorServer, EDITOR_TOOL_NAMES } from '../../src/services/agents/editor';
import { DraftCollector, createGateHook, PROPOSE_TOOL } from '../../src/services/agents/collector';
import { makeTempProject, makeTestCtx, SKILL_DIR, type TempProject } from '../helpers/ctx';

/* ------------------------------------------------------------------------------------ */
/* SSE helpers                                                                           */
/* ------------------------------------------------------------------------------------ */

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((d) => `event: ${String(d.type)}\ndata: ${JSON.stringify(d)}\n\n`).join('');
}
const U0 = { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 27000, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } };

function textStream(model: string, text: string): string {
  return sse([
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: U0 } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 40 } },
    { type: 'message_stop' },
  ]);
}

function toolUseStream(model: string, name: string, input: unknown): string {
  return sse([
    { type: 'message_start', message: { id: 'msg_u', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: U0 } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_01', name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]);
}

type Body = Record<string, any>;
type Reply = (body: Body, n: number) => Response;

/** A fetch for the SDK that records request bodies and answers with `reply`. Never touches the network. */
function recordingFetch(reply: Reply): { fetch: typeof fetch; bodies: Body[]; headers: Array<Record<string, string>> } {
  const bodies: Body[] = [];
  const headers: Array<Record<string, string>> = [];
  const f = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Body;
    bodies.push(body);
    const h: Record<string, string> = {};
    new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).forEach((v, k) => (h[k] = v));
    headers.push(h);
    return reply(body, bodies.length);
  }) as unknown as typeof fetch;
  return { fetch: f, bodies, headers };
}

const sseResponse = (s: string) => new Response(s, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_1' } });
const jsonError = (status: number, type: string, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: 'error', error: { type, message: type } }), { status, headers: { 'content-type': 'application/json', ...extra } });

/* ------------------------------------------------------------------------------------ */
/* Minimal ctx fakes (the core prompt builders and gate are real)                        */
/* ------------------------------------------------------------------------------------ */

function fact(p: Partial<Fact> & Pick<Fact, 'id' | 'value'>): Fact {
  return {
    kind: 'number',
    sigfigs: null,
    unit: '',
    uncertainties: {},
    definition: '',
    definitionSource: 'test',
    artifact: 'results/x.json',
    locator: `#/${p.id}`,
    artifactSha256: 'sha',
    fingerprint: 'fp',
    stale: false,
    validationState: 'candidate',
    aliases: [],
    confirmed: true,
    excluded: false,
    proseOnly: false,
    tags: [],
    ...p,
  };
}
const FACTS: Fact[] = [fact({ id: 'f.g1.delta_points', value: 2.3191733639494783, unit: 'points', uncertainties: { total: 0.2793 }, aliases: ['2.32~points'], definition: 'Efficiency difference' })];

const MAIN = 'main.tex';
const U1 = 'We compare the two trackers on the same events.';
const P1 = 'The efficiency gain is';
const P2 = 'The efficiency gain is about';
const textWith = (prefix: string) => `\\section{Results}\\label{sec:results}\n\n${U1}\n${prefix}`;

function unitAt(text: string, sub: string, id: string): SentenceUnit {
  const start = text.indexOf(sub);
  return {
    id, file: MAIN, start, end: start + sub.length, line: 3, hash: hashString(normalizeForHash(sub)), ctxHash: '', textNorm: normalizeForHash(sub),
    sectionId: 'sec:results', paragraphId: 'sec:results/p0', part: 'body', kind: 'prose', move: null, state: 'human', everAi: false, grammarFixed: false,
    imported: false, model: null, promptHash: null, createdAt: '2026-11-06T00:00:00Z', acceptedAt: null, editDistance: null, intentNote: null,
    facts: [], cites: [], claims: [], placeholders: [], orphaned: false, splitFrom: null,
  };
}

function makeDocs(): DocService & { setText(t: string): void } {
  let doc: DocState;
  const set = (t: string) => {
    doc = { file: MAIN, version: 1, text: t, units: [unitAt(t, U1, 'u1')], seg: {} as DocState['seg'], intentLines: [] };
  };
  set(textWith(P1));
  const find = (id: string) => doc.units.find((u) => u.id === id);
  return {
    setText: set,
    files: async () => [MAIN],
    open: async (f: string) => {
      if (f !== MAIN) throw new HttpError(404, 'no');
      return doc;
    },
    get: (f: string) => (f === MAIN ? doc : undefined),
    unit: find,
    unitText: (id: string) => {
      const u = find(id);
      return u ? doc.text.slice(u.start, u.end) : null;
    },
    context: (id: string) => {
      const u = find(id);
      if (!u) return null;
      return { before: '', after: '', paragraphBefore: '', paragraphAfter: '', previousParagraphs: [], sectionId: u.sectionId, sectionTitle: 'Results', part: u.part };
    },
    labels: () => ['sec:results'],
    allUnits: () => doc.units,
  } as unknown as DocService & { setText(t: string): void };
}

const STEP: PlanStep = { id: 'step-gain', intent: 'state the efficiency gain', factIds: ['f.g1.delta_points'], citeKeys: [], move: 'result' };
function outline(): Outline {
  const o = emptyOutline();
  o.authorFilled = true;
  o.sections = [
    {
      id: 'sec:results', title: 'Results', question: 'How much better?', template: 'results', ghostMode: 'auto-propose', provenance: 'author',
      paragraphs: [{ pid: 'sec:results/p0', job: 'State the gain', moves: ['result'], claimIds: [], intentNotes: [], provenance: 'author', plan: { job: 'State the gain', claimIds: [], said: {}, remaining: [STEP, { id: 'step-next', intent: 'say why it matters', factIds: [], citeKeys: [], move: 'implication' }] } }],
    },
  ] as Outline['sections'];
  return o;
}

let project: TempProject;
let ctx: Ctx & { events: ServerMessage[] };
let docs: ReturnType<typeof makeDocs>;

beforeEach(async () => {
  project = await makeTempProject();
  docs = makeDocs();
  const facts = {
    all: () => FACTS,
    get: (id: string) => FACTS.find((f) => f.id === id),
    forPrompt: ({ factIds, limit }: { factIds?: string[]; limit?: number }) => {
      const out: Fact[] = [];
      for (const id of factIds ?? []) {
        const f = FACTS.find((x) => x.id === id);
        if (f && !out.includes(f)) out.push(f);
      }
      for (const f of FACTS) if (!out.includes(f)) out.push(f);
      return out.slice(0, limit ?? 50);
    },
    terminology: () => [],
  } as unknown as FactService;
  const lit = { allowedKeys: () => [{ key: 'Wang2022LRT', title: 'Tracking' }], brief: () => 'LIT BRIEF' } as unknown as LitService;
  const voice = { memo: () => 'MEMO', authorNormsTable: () => 'NORMS', exemplars: (_s: string, _q: string, k: number) => ['We measure the efficiency on the test sample.', 'The tracker finds more tracks.'].slice(0, k) } as unknown as VoiceService;
  const kv = new Map<string, string>();
  const db = { kvGet: (k: string) => kv.get(k), kvSet: (k: string, v: string) => void kv.set(k, v), transaction: <T>(fn: () => T) => fn(), versions: () => [] } as unknown as PaperDb;
  ctx = makeTestCtx(project, { docs, facts, lit, voice, db, fakeLlm: false });
  await ctx.files.writeJson(ctx.paths.outline, outline());
});
/** Services built by the current test: closed (timers stopped, cost-log writes drained) before cleanup. */
let built: Array<ReturnType<typeof createLlmService>> = [];
afterEach(async () => {
  // a cost record appended after the temp dir is removed would re-create it (appendJsonl makes the folder)
  for (const svc of built.splice(0)) await svc.close?.();
  project.cleanup();
});

const ghostJson = (text: string, extra: Record<string, unknown> = {}) => JSON.stringify({ text, fact_ids: [], cite_keys: [], fulfilled_move_ids: [], ...extra });
const ghostMsg = (requestId: string, prefix: string) => ({ type: 'ghost.request' as const, requestId, file: MAIN, version: 1, cursor: textWith(prefix).length, trigger: 'pause' as const, prefix });

function service(reply: Reply, opts: { maxRetries?: number } = {}) {
  const rec = recordingFetch(reply);
  const client = createRealLlmClient({ apiKey: 'sk-ant-test-000000000', baseURL: 'https://api.anthropic.com', fetch: rec.fetch, sleep: async () => {}, maxRetries: opts.maxRetries, log: ctx.log });
  const svc = createLlmService(ctx, { client, skillCheckIntervalMs: 0 });
  built.push(svc);
  (ctx as { llm: unknown }).llm = svc;
  return { svc, rec };
}

async function ghost(svc: ReturnType<typeof createLlmService>, id: string, prefix: string): Promise<ServerMessage[]> {
  docs.setText(textWith(prefix));
  const sent: ServerMessage[] = [];
  await svc.handleGhostRequest(ghostMsg(id, prefix), (m) => sent.push(m));
  return sent;
}

/** The fields of a body that are part of the prompt-cache key (stream is a transport option). */
function cacheKey(b: Body) {
  return { model: b.model, system: b.system, tools: b.tools ?? null, tool_choice: b.tool_choice ?? null, thinking: b.thinking, output_config: b.output_config };
}

/* ------------------------------------------------------------------------------------ */
/* Direct Messages API: exact request bodies                                             */
/* ------------------------------------------------------------------------------------ */

describe('direct API request bodies (real SDK client, recorded fetch)', () => {
  it('Haiku ghost: thinking disabled, effort low, strict json_schema, max_tokens 200, no sampling params, 1h block before 5m blocks', async () => {
    const { svc, rec } = service((b) => sseResponse(textStream(b.model, ghostJson(`${P1} 2.32~points over the baseline.`, { fact_ids: ['f.g1.delta_points'], fulfilled_move_ids: ['step-gain'] }))));
    const sent = await ghost(svc, 'g1', P1);
    expect(sent.map((m) => m.type)).toEqual(['ghost.result']);
    expect(rec.bodies).toHaveLength(1);
    const b = rec.bodies[0]!;
    expect(b.model).toBe('claude-haiku-5-5');
    expect(b.thinking).toEqual({ type: 'disabled' });
    expect(b.output_config.effort).toBe('low');
    expect(b.output_config.format.type).toBe('json_schema');
    expect(b.output_config.format.schema).toEqual(outputJsonSchema('ghost'));
    expect(b.output_config.format.schema.properties && Object.keys(b.output_config.format.schema.properties)[0]).toBe('text');
    expect(b.max_tokens).toBe(200);
    expect(b.stream).toBe(true);
    for (const k of ['temperature', 'top_p', 'top_k', 'cache_control', 'tools', 'tool_choice', 'stop_sequences']) expect(b).not.toHaveProperty(k);
    const ttls = (b.system as Array<{ cache_control?: { ttl?: string } }>).map((s) => s.cache_control?.ttl ?? 'none');
    expect(ttls[0]).toBe('1h');
    // after the 1h block A: 5m blocks, then the small uncached task-rules block last
    expect(ttls[ttls.length - 1]).toBe('none');
    expect(ttls.slice(1, -1).every((t) => t === '5m')).toBe(true);
    expect(ttls.length).toBeLessThanOrEqual(4);
    // the volatile tail carries no cache marker
    expect(JSON.stringify(b.messages)).not.toContain('cache_control');
    // SDK 1.6 sends the explicit key as a bearer credential; nothing from ANTHROPIC_* env is used
    expect(rec.headers[0]!['authorization']).toBe('Bearer sk-ant-test-000000000');
    expect(rec.headers[0]!['anthropic-version']).toBe('2026-10-21');
  });

  it('Sonnet actions (instruct): thinking between_tools (never disabled), effort low, strict schema, no sampling params', async () => {
    const { svc, rec } = service((b) => sseResponse(textStream(b.model, JSON.stringify({ text: U1, notes: '', drift: { actor: false, scope: false, direction: false, condition: false }, fact_ids: [], cite_keys: [] }))));
    await svc.instruct('u1', 'make it shorter', 'en');
    const b = rec.bodies[0]!;
    expect(b.model).toBe('claude-sonnet-5-5');
    expect(b.thinking).toEqual({ type: 'between_tools' });
    expect(b.output_config).toEqual({ effort: 'low', format: { type: 'json_schema', schema: outputJsonSchema('instruct') } });
    expect(b.max_tokens).toBeGreaterThanOrEqual(1024);
    for (const k of ['temperature', 'top_p', 'top_k', 'tool_choice']) expect(b).not.toHaveProperty(k);
  });

  it('Opus 5.5 on the actions route never gets thinking disabled or between_tools', async () => {
    await ctx.saveConfig({ ...ctx.config, models: { ...ctx.config.models, actions: 'claude-opus-5-5', ghost: 'claude-opus-5-5' } });
    const { svc, rec } = service((b) =>
      sseResponse(textStream(b.model, b.output_config?.format?.schema?.properties?.drift ? JSON.stringify({ text: U1, notes: '', drift: { actor: false, scope: false, direction: false, condition: false }, fact_ids: [], cite_keys: [] }) : ghostJson(`${P1} 2.32~points.`, { fact_ids: ['f.g1.delta_points'] }))),
    );
    await svc.instruct('u1', 'shorter', 'en');
    await ghost(svc, 'g-opus', P1);
    for (const b of rec.bodies) {
      expect(b.thinking).toEqual({ type: 'adaptive' });
      expect(b).not.toHaveProperty('temperature');
    }
  });

  it('prompt caching: consecutive ghost requests in one paragraph (prefix grows, plan advances) send byte-identical system blocks', async () => {
    const { svc, rec } = service((b, n) => sseResponse(textStream(b.model, ghostJson(n === 1 ? `${P1} 2.32~points over the baseline.` : `${P2} 2.32~points.`, { fact_ids: ['f.g1.delta_points'], fulfilled_move_ids: ['step-gain'] }))));
    const a = await ghost(svc, 'g1', P1);
    expect(a[0]?.type).toBe('ghost.result');
    // the author accepts the first ghost: the plan advances (said/remaining change in outline.json)
    svc.ghostFeedback({ type: 'ghost.feedback', requestId: 'g1', outcome: 'accepted', acceptedText: ' 2.32~points over the baseline.' } as never);
    await new Promise((r) => setTimeout(r, 50));
    const o = ctx.files.readJson(ctx.paths.outline, (await import('@paper-copilot/core')).Outline, emptyOutline());
    expect(o.sections[0]!.paragraphs[0]!.plan.said['step-gain']).toBeTruthy();
    await ghost(svc, 'g2', P2);
    expect(rec.bodies).toHaveLength(2);
    expect(JSON.stringify(rec.bodies[1]!.system)).toBe(JSON.stringify(rec.bodies[0]!.system));
    expect(cacheKey(rec.bodies[1]!)).toEqual(cacheKey(rec.bodies[0]!));
    // and the tails differ (the volatile part really is in messages)
    expect(JSON.stringify(rec.bodies[1]!.messages)).not.toBe(JSON.stringify(rec.bodies[0]!.messages));
  });

  it('regression (SDK-3): the default document-open pre-warm carries the same output_config.format as the real ghost requests, so they can read the entry it writes', async () => {
    const replies: Reply = (b) => (b.stream ? sseResponse(textStream(b.model, ghostJson(`${P1} 2.32~points.`, { fact_ids: ['f.g1.delta_points'] }))) : new Response(JSON.stringify({ id: 'msg_w', type: 'message', role: 'assistant', model: b.model, content: [], stop_reason: 'max_tokens', stop_sequence: null, usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 27000 } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const { svc, rec } = service(replies);
    await svc.prewarm();
    const warm = rec.bodies.find((b) => !b.stream && b.model === 'claude-haiku-5-5')!;
    expect(warm).toBeTruthy();
    // max_tokens 0 rejects output_config.format (prompt-caching docs, "Rejected combinations"), so a warm
    // that matches the structured requests is the max_tokens 1 shape: non-streaming, one output token,
    // no forced tool_choice
    expect(warm.max_tokens).toBe(1);
    expect(warm.stream).toBe(false);
    expect(warm).not.toHaveProperty('tool_choice');
    await ghost(svc, 'g1', P1);
    const real = rec.bodies.find((b) => b.stream && b.model === 'claude-haiku-5-5')!;
    // blocks A and B are the shared prefix the warm-up is meant to write
    expect(warm.system).toEqual(real.system.slice(0, 2));
    // ...but "setting or changing a structured-output format" is a cache breaker (claude-api skill,
    // cost-optimization.md "mid-task cache-breakers"; structured outputs inject the schema into the
    // prompt), so every cache-relevant parameter must match the real request:
    expect(warm.output_config).toEqual(real.output_config);
  });

  it('regression (SDK-4, server part): the actions-route pre-warm warms the block A of the open document\'s sections (Results: the results references), which a real instruct there reads', async () => {
    const okInstruct = JSON.stringify({ text: U1, notes: '', drift: { actor: false, scope: false, direction: false, condition: false }, fact_ids: [], cite_keys: [] });
    const replies: Reply = (b) =>
      b.stream
        ? sseResponse(textStream(b.model, okInstruct))
        : new Response(JSON.stringify({ id: 'msg_w', type: 'message', role: 'assistant', model: b.model, content: [], stop_reason: 'max_tokens', stop_sequence: null, usage: { input_tokens: 4, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    const { svc, rec } = service(replies);
    await svc.prewarm(MAIN);
    const warm = rec.bodies.find((b) => !b.stream && b.model === 'claude-sonnet-5-5')!;
    await svc.instruct('u1', 'shorter', 'en'); // u1 sits in the Results section (template "results")
    const real = rec.bodies.find((b) => b.stream && b.model === 'claude-sonnet-5-5')!;
    const refsOf = (t: string) => [...t.matchAll(/<reference fictional_examples="true" name="([^"]+)"/g)].map((x) => x[1]);
    expect(refsOf(warm.system[0].text)).toEqual(['sentences-and-words.md', 'figures-and-evidence.md']);
    expect(real.system.slice(0, 2)).toEqual(warm.system);
    expect(cacheKey({ ...real, system: real.system.slice(0, 2) })).toEqual(cacheKey(warm));
    svc.close?.();
  });

  it('regression (SDK-4): alternatives/grammar/intent/replan share the warmed block A of the actions route', async () => {
    const okInstruct = JSON.stringify({ text: U1, notes: '', drift: { actor: false, scope: false, direction: false, condition: false }, fact_ids: [], cite_keys: [] });
    const replies: Reply = (b) =>
      b.stream
        ? sseResponse(textStream(b.model, b.output_config?.format?.schema?.properties?.alternatives ? JSON.stringify({ alternatives: [{ text: U1, note: '' }] }) : okInstruct))
        : new Response(JSON.stringify({ id: 'msg_w', type: 'message', role: 'assistant', model: b.model, content: [], stop_reason: 'max_tokens', stop_sequence: null, usage: { input_tokens: 4, output_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    const { svc, rec } = service(replies);
    await svc.prewarm();
    const warm = rec.bodies.find((b) => !b.stream && b.model === 'claude-sonnet-5-5')!;
    expect(warm.thinking).toEqual({ type: 'between_tools' }); // valid with max_tokens 0
    await svc.instruct('u1', 'shorter', 'en'); // u1 sits in the Results section (template "results")
    await svc.alternatives('u1', 2);
    const real = rec.bodies.filter((b) => b.stream && b.model === 'claude-sonnet-5-5');
    expect(real).toHaveLength(2);
    // The warm-up exists to give these requests a cache hit on block A (the 1 h, ~12k-token block).
    expect(real[0]!.system[0].text).toBe(warm.system[0].text); // instruct: holds (server part)
    expect(real[1]!.system[0].text).toBe(warm.system[0].text); // alternatives: needs the core change
    svc.close?.();
  });

  it('regression (SDK-5): keep-alive: after the pre-warm the prefix is refreshed about every 4.5 min while the author is active, and stops when idle', async () => {
    const replies: Reply = (b) => new Response(JSON.stringify({ id: 'msg_w', type: 'message', role: 'assistant', model: b.model, content: [], stop_reason: 'max_tokens', stop_sequence: null, usage: { input_tokens: 4, output_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    const { svc, rec } = service(replies);
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] });
    try {
      await svc.prewarm();
      const after = rec.bodies.length;
      await vi.advanceTimersByTimeAsync(4.6 * 60_000);
      expect(rec.bodies.length).toBeGreaterThan(after);
      // the refresh has the shape of the warm-up (same cache key: system A+B, thinking, effort, format)
      const first = rec.bodies.slice(0, after);
      for (const b of rec.bodies.slice(after)) expect(first.some((w) => JSON.stringify(cacheKey(w)) === JSON.stringify(cacheKey(b)))).toBe(true);
      // no author activity for a long time: the refreshes stop (no endless spend on an idle window)
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      const idle = rec.bodies.length;
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(rec.bodies.length).toBe(idle);
      svc.close?.();
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ------------------------------------------------------------------------------------ */
/* Retries                                                                               */
/* ------------------------------------------------------------------------------------ */

describe('retry / backoff', () => {
  const okInstruct = (b: Body) => sseResponse(textStream(b.model, JSON.stringify({ text: U1, notes: '', drift: { actor: false, scope: false, direction: false, condition: false }, fact_ids: [], cite_keys: [] })));

  it('actions retry 429 then 529 and succeed on the third attempt (SDK retries off: exactly 3 HTTP calls)', async () => {
    const { svc, rec } = service((b, n) => (n === 1 ? jsonError(429, 'rate_limit_error', { 'retry-after': '1' }) : n === 2 ? jsonError(529, 'overloaded_error') : okInstruct(b)));
    const p = await svc.instruct('u1', 'shorter', 'en');
    expect(p.text).toBe(U1);
    expect(rec.bodies).toHaveLength(3);
  });

  it('actions retry an overloaded_error that arrives mid-stream as an SSE error event', async () => {
    const midStreamError = sse([
      { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: U0 } },
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    ]);
    const { svc, rec } = service((b, n) => (n === 1 ? sseResponse(midStreamError) : okInstruct(b)));
    await svc.instruct('u1', 'shorter', 'en');
    expect(rec.bodies).toHaveLength(2);
  });

  it('a 400 is not retried; the ghost route never retries (a stale ghost is worthless)', async () => {
    const a = service(() => jsonError(400, 'invalid_request_error'));
    await expect(a.svc.instruct('u1', 'shorter', 'en')).rejects.toThrow();
    expect(a.rec.bodies).toHaveLength(1);
    const g = service(() => jsonError(529, 'overloaded_error'));
    const sent = await ghost(g.svc, 'g1', P1);
    expect(sent.map((m) => m.type)).toEqual(['ghost.error']);
    expect(g.rec.bodies).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------------------ */
/* Cost accounting                                                                       */
/* ------------------------------------------------------------------------------------ */

describe('cost accounting', () => {
  it('Haiku 5.5 long-context tier: a prompt of exactly 100k tokens is on the standard card, 100k+1 on the long card (5x)', () => {
    const at = (n: number) => costOf('claude-haiku-5-5', { input_tokens: n, output_tokens: 0 });
    expect(at(100_000)).toBeCloseTo(100_000 * 0.1e-6, 10);
    expect(at(100_001)).toBeCloseTo(100_001 * 0.5e-6, 10);
    // cache reads count toward the prompt length
    expect(costOf('claude-haiku-5-5', { input_tokens: 1_000, output_tokens: 100, cache_read_input_tokens: 100_000 })).toBeCloseTo((1_000 * 0.5 + 100 * 2.5 + 100_000 * 0.05) / 1e6, 10);
  });

  it('BUG: Sonnet 5.5 cache reads are priced at $0.10/MTok; the list price is $0.20/MTok (0.1x of $2 input)', () => {
    // claude-api skill: "Claude Sonnet 5.5 ... ($2 / $10 per MTok, cache reads $0.20)" (SKILL.md and
    // shared/models.md); prompt-caching.md: reads are 0.1x input except Opus 5.5 (0.05x) and Fable 5.1 (0.025x).
    expect(PRICES['claude-sonnet-5-5']!.cacheRead).toBe(0.2);
    // A typical actions call (27k cached prefix, 1.5k fresh, 300 out) is under-reported by ~$0.0027 each.
    expect(costOf('claude-sonnet-5-5', { input_tokens: 1_500, output_tokens: 300, cache_read_input_tokens: 27_000 })).toBeCloseTo((1_500 * 2 + 300 * 10 + 27_000 * 0.2) / 1e6, 10);
  });

  it('the other cache multipliers match the skill (writes 1.25x / 2x; reads 0.1x Haiku, 0.05x Opus 5.5, 0.025x Fable 5.1)', () => {
    const p = PRICES;
    expect(p['claude-haiku-5-5']!).toMatchObject({ input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 });
    expect(p['claude-opus-5-5']!).toMatchObject({ input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 });
    expect(p['claude-fable-5-1']!).toMatchObject({ input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 });
    expect(p['claude-sonnet-5-5']!).toMatchObject({ input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4 });
  });
});

/* ------------------------------------------------------------------------------------ */
/* Agent SDK options                                                                     */
/* ------------------------------------------------------------------------------------ */

function baseInput(over: Partial<Parameters<typeof buildQueryOptions>[0]> = {}): Parameters<typeof buildQueryOptions>[0] {
  return {
    role: 'drafter',
    model: 'claude-opus-5-5',
    claudeCwd: '/tmp/x/.paper/claude',
    repoDir: null,
    texRoot: '/tmp/x/tex',
    skillDir: SKILL_DIR,
    systemPrompt: 'SYSTEM',
    outputSchema: null,
    maxBudgetUsd: 5,
    maxTurns: 10,
    guard: async () => ({}),
    persistSession: false,
    abortController: new AbortController(),
    baseEnv: {},
    ...over,
  };
}

describe('Agent SDK options', () => {
  it('options match the 0.3.318 .d.ts semantics: project settings only, one skill, read-only tools, dontAsk, no thinking override', () => {
    const o = buildQueryOptions(baseInput({ mcpTools: EDITOR_TOOL_NAMES }));
    expect(o.settingSources).toEqual(['project']);
    expect(o.skills).toEqual(['hep-paper-writing']);
    expect(o.tools).toEqual(['Read', 'Glob', 'Grep', 'Skill']);
    expect(o.permissionMode).toBe('dontAsk');
    expect(o.allowDangerouslySkipPermissions).toBeUndefined();
    expect(o.thinking).toBeUndefined(); // Opus 5.5 cannot disable thinking; the CLI default (adaptive) applies
    expect(o.strictMcpConfig).toBe(true);
    expect(o.allowedTools).toEqual(EDITOR_TOOL_NAMES);
    expect(o.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'NotebookEdit']));
  });

  it('regression (SDK-2): the Claude Code subprocess does not inherit ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN from the environment, like the direct client (and gets the app key)', () => {
    // The direct client deliberately ignores ANTHROPIC_BASE_URL (apiKey.ts: "the app never inherits
    // ANTHROPIC_BASE_URL silently") and resolves the key from env OR the OS keychain. The agents get
    // `{...process.env, ...ISOLATION_ENV}` (service.ts baseEnv: process.env), so:
    //  - a base URL / bearer token another tool exported is used for the drafter's requests,
    //  - PAPER_ANTHROPIC_BASE_URL is not honoured for agents,
    //  - a key stored only in the keychain (ctx.fakeLlm = false, real mode) never reaches the CLI, which
    //    then falls back to whatever Claude login the machine has, or fails.
    const env = { PATH: '/usr/bin', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/other-tool-proxy', ANTHROPIC_AUTH_TOKEN: 'other-tool-token' };
    const o = buildQueryOptions(baseInput({ baseEnv: env }));
    expect(o.env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe(ISOLATION_ENV.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC);
    expect(o.env?.ANTHROPIC_BASE_URL ?? resolveBaseUrl(env)).toBe(resolveBaseUrl(env)); // https://api.anthropic.com
    expect(o.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    // with the app's auth: exactly that key and endpoint, and nothing an outer Claude Code session set
    const o2 = buildQueryOptions(baseInput({ baseEnv: { ...env, PAPER_ANTHROPIC_BASE_URL: 'https://gw.example', CLAUDECODE: '1', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: 'sk-other' }, auth: { apiKey: 'sk-app', baseUrl: resolveBaseUrl({ PAPER_ANTHROPIC_BASE_URL: 'https://gw.example' }) } }));
    expect(o2.env?.ANTHROPIC_API_KEY).toBe('sk-app');
    expect(o2.env?.ANTHROPIC_BASE_URL).toBe('https://gw.example');
    expect(o2.env?.CLAUDECODE).toBeUndefined();
    expect(o2.env?.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(o2.env?.PATH).toBe('/usr/bin');
  });
});

/* ------------------------------------------------------------------------------------ */
/* Agent SDK end to end against the real Claude Code binary and a local fake API         */
/* ------------------------------------------------------------------------------------ */

const CLAUDE_BIN = '/opt/claude-code/bin/claude';

const DUMMY_KEY = 'sk-ant-dummy-0000000';
/** Which credential a request carried (never the value: a real login token must not reach test output). */
type AuthKind = 'app-key' | 'oauth-login' | 'other' | 'none';
function authKind(h: IncomingMessage['headers']): AuthKind {
  const v = String(h['x-api-key'] ?? h['authorization'] ?? '');
  if (!v) return 'none';
  if (v === DUMMY_KEY || v === `Bearer ${DUMMY_KEY}`) return 'app-key';
  if (/sk-ant-oat/.test(v)) return 'oauth-login';
  return 'other';
}

interface FakeApi {
  port: number;
  bodies: Array<{ path: string; body: Body; auth: AuthKind }>;
  close(): Promise<void>;
}

async function fakeApi(reply: (body: Body, mainIndex: number) => string): Promise<FakeApi> {
  const bodies: Array<{ path: string; body: Body; auth: AuthKind }> = [];
  let main = 0;
  const srv: Server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let buf = Buffer.concat(chunks);
    if (req.headers['content-encoding'] === 'gzip') buf = gunzipSync(buf);
    let body: Body = {};
    try {
      body = JSON.parse(buf.toString('utf8') || '{}') as Body;
    } catch {
      body = {};
    }
    const path = req.url ?? '';
    bodies.push({ path, body, auth: authKind(req.headers) });
    if (!path.startsWith('/v1/messages') || path.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 10, data: [] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(reply(body, main++));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { port: (srv.address() as { port: number }).port, bodies, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

function claudeCwd(): { root: string; cwd: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'paper-sdk-review-'));
  const cwd = join(root, '.paper', 'claude');
  mkdirSync(join(cwd, '.claude', 'skills'), { recursive: true });
  // the layout ensureSkillLink() creates: .paper/claude/.claude/skills/hep-paper-writing -> skill checkout
  symlinkSync(SKILL_DIR, join(cwd, '.claude', 'skills', 'hep-paper-writing'), 'dir');
  const home = join(root, 'home');
  mkdirSync(home);
  return { root, cwd, home };
}

async function drain(q: AsyncIterable<unknown> & { close(): void }, ac: AbortController): Promise<Array<Record<string, any>>> {
  const msgs: Array<Record<string, any>> = [];
  try {
    for await (const m of q) {
      msgs.push(m as Record<string, any>);
      if ((m as { type?: string }).type === 'result') break;
    }
  } finally {
    ac.abort();
    try {
      q.close();
    } catch {
      /* closed */
    }
  }
  return msgs;
}

describe.skipIf(!existsSync(CLAUDE_BIN))('Agent SDK end to end (real CLI 2.1.318, local fake API)', () => {
  it('the symlinked project skill is discovered from cwd/.claude/skills with settingSources [project]; the drafter request uses adaptive thinking, effort high, no sampling params', async () => {
    const api = await fakeApi((b) => textStream(b.model, 'done'));
    const { root, cwd, home } = claudeCwd();
    const ac = new AbortController();
    try {
      const options = buildQueryOptions(baseInput({ claudeCwd: cwd, texRoot: root, abortController: ac, maxBudgetUsd: 1, maxTurns: 2, baseEnv: { PATH: process.env.PATH, HOME: home }, auth: { apiKey: DUMMY_KEY, baseUrl: `http://127.0.0.1:${api.port}` } }));
      options.pathToClaudeCodeExecutable = CLAUDE_BIN;
      const msgs = await drain(agentSdk.query({ prompt: 'hello', options }) as never, ac);
      const init = msgs.find((m) => m.type === 'system' && m.subtype === 'init');
      expect(init?.skills).toContain('hep-paper-writing');
      expect(init?.tools).toEqual(expect.arrayContaining(['Read', 'Glob', 'Grep', 'Skill']));
      expect(init?.tools).not.toContain('Bash');
      const main = api.bodies.filter((x) => x.path.startsWith('/v1/messages') && x.body.model === 'claude-opus-5-5');
      expect(main.length).toBeGreaterThan(0);
      // with ANTHROPIC_API_KEY in the subprocess env, the app's key is what the CLI sends
      expect(main.every((x) => x.auth === 'app-key')).toBe(true);
      for (const { body } of main) {
        expect(body.thinking?.type).toBe('adaptive');
        expect(body.output_config?.effort).toBe('high');
        for (const k of ['temperature', 'top_p', 'top_k']) expect(body).not.toHaveProperty(k);
        // the skill listing reaches the model
        expect(JSON.stringify(body)).toContain('hep-paper-writing');
      }
      const listing = JSON.stringify(main[0]!.body.messages);
      const m = /The following skills are available for use with the Skill tool:([\s\S]{0,4000})/.exec(listing);
      const listed = m ? m[1]!.replace(/\\n/g, '\n').split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).split(':')[0]) : [];
      // `skills: ['hep-paper-writing']` hides the CLI's bundled skills from the model
      expect(listed).toEqual(['hep-paper-writing']);
    } finally {
      await api.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);

  it('regression (SDK-1): when the API key comes from the OS keychain (no ANTHROPIC_API_KEY in process.env), agents authenticate with the app key, never the machine\'s Claude Code login', async () => {
    // The service resolves the key exactly like the direct client (env or keychain) and the endpoint
    // with resolveBaseUrl (PAPER_ANTHROPIC_BASE_URL); an inherited ANTHROPIC_BASE_URL is ignored.
    const api = await fakeApi((b) => textStream(b.model, 'done'));
    const { root, cwd, home } = claudeCwd();
    const ac = new AbortController();
    try {
      const { resolveApiKey } = await import('../../src/services/llm/apiKey');
      const key = resolveApiKey({ env: {}, platform: 'linux', run: (cmd) => (cmd === 'secret-tool' ? DUMMY_KEY : null) });
      expect(key).toEqual({ key: DUMMY_KEY, source: 'keychain' });
      const appEnv = { PAPER_ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}` };
      const options = buildQueryOptions(
        baseInput({
          claudeCwd: cwd, texRoot: root, abortController: ac, maxBudgetUsd: 1, maxTurns: 1,
          baseEnv: { PATH: process.env.PATH, HOME: home, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/other-tool-proxy', ANTHROPIC_AUTH_TOKEN: 'other-tool-token', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-other' },
          auth: { apiKey: key.key!, baseUrl: resolveBaseUrl(appEnv) },
        }),
      );
      expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      options.pathToClaudeCodeExecutable = CLAUDE_BIN;
      const timer = setTimeout(() => ac.abort(), 30_000);
      await drain(agentSdk.query({ prompt: 'hello', options }) as never, ac).catch(() => []);
      clearTimeout(timer);
      const kinds = api.bodies.filter((x) => x.path.startsWith('/v1/messages')).map((x) => x.auth);
      // Every request the agent makes carries the app's own key, and it reached the app's endpoint.
      expect(kinds.length).toBeGreaterThan(0);
      expect(kinds.filter((k) => k !== 'app-key')).toEqual([]);
    } finally {
      await api.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);

  it('PreToolUse read-only guard + dontAsk: a Read in an additionalDirectory (the repo) runs, a Read outside every root is denied with the guard reason', async () => {
    const { root, cwd, home } = claudeCwd();
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(repo, 'README.md'), 'REPO-README-CONTENT\n');
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, 'OUTSIDE-CONTENT\n');
    const reads = [join(repo, 'README.md'), outside];
    const api = await fakeApi((b, n) => (n < reads.length ? toolUseStream(b.model, 'Read', { file_path: reads[n] }).replace(/toolu_01/g, `toolu_0${n + 1}`) : textStream(b.model, 'done')));
    const { createReadOnlyGuard } = await import('../../src/services/agents/guard');
    const decisions: Array<[string, boolean]> = [];
    const guard = createReadOnlyGuard(
      { roots: [{ dir: repo, kind: 'repo' }, { dir: join(root, 'tex'), kind: 'tex' }, { dir: cwd, kind: 'claude' }, { dir: SKILL_DIR, kind: 'skill' }], repoGlobs: ['README.md'], mcpTools: [], skills: ['hep-paper-writing'], cwd },
      (t, d) => decisions.push([t, d.allow]),
    );
    const ac = new AbortController();
    try {
      mkdirSync(join(root, 'tex'));
      const options = buildQueryOptions(
        baseInput({ role: 'repo-reader', model: 'claude-sonnet-5-5', claudeCwd: cwd, repoDir: repo, texRoot: join(root, 'tex'), guard, abortController: ac, maxBudgetUsd: 1, maxTurns: 5, baseEnv: { PATH: process.env.PATH, HOME: home }, auth: { apiKey: DUMMY_KEY, baseUrl: `http://127.0.0.1:${api.port}` } }),
      );
      options.pathToClaudeCodeExecutable = CLAUDE_BIN;
      await drain(agentSdk.query({ prompt: 'read', options }) as never, ac);
      const last = api.bodies.filter((x) => x.path.startsWith('/v1/messages') && x.body.model === 'claude-sonnet-5-5').pop()!;
      const results = (last.body.messages as Array<{ content: unknown }>).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c: { type?: string }) => c.type === 'tool_result');
      expect(results).toHaveLength(2);
      expect(JSON.stringify(results[0])).toContain('REPO-README-CONTENT');
      expect(JSON.stringify(results[1])).not.toContain('OUTSIDE-CONTENT');
      expect(JSON.stringify(results[1])).toContain('outside the folders this agent may read');
      expect(decisions).toEqual([['Read', true], ['Read', false]]);
    } finally {
      await api.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);

  it('the PostToolUse gate hook replaces the MCP propose_paragraph result the model sees (updatedToolOutput), and the zod shapes become a valid input_schema', async () => {
    const api = await fakeApi((b, n) => (n === 0 ? toolUseStream(b.model, PROPOSE_TOOL, { pid: 'p1', job: 'j', sentences: [{ text: 'The gain is 7.77 points.' }] }) : textStream(b.model, 'done')));
    const { root, cwd, home } = claudeCwd();
    const ac = new AbortController();
    const gate = (text: string) =>
      text.includes('7.77')
        ? { ok: false, issues: [{ code: 'fictional_number', severity: 'block', message: 'fictional example number', raw: '7.77' }], repaired: text.replace('7.77', '[fact?: gain]'), factIds: [], citeKeys: [], unlinked: [], placeholders: [] }
        : { ok: true, issues: [], repaired: text, factIds: [], citeKeys: [], unlinked: [], placeholders: [] };
    const collector = new DraftCollector([{ pid: 'p1', job: 'j', intentNotes: [] }], () => ({ facts: [], allowedCiteKeys: [], knownLabels: [], fictionalNumbers: ['7.77'] }), gate as never);
    const verdicts: string[] = [];
    const hook = createGateHook(collector, (v) => verdicts.push(v.status));
    const editor = buildEditorServer(agentSdk, { outline: emptyOutline, facts: () => [], sentences: () => [], allowedKeys: () => [], litRecord: () => undefined, collector });
    try {
      const options = buildQueryOptions(
        baseInput({
          claudeCwd: cwd, texRoot: root, abortController: ac, maxBudgetUsd: 1, maxTurns: 4,
          mcpServers: { editor }, mcpTools: EDITOR_TOOL_NAMES, hooks: { PostToolUse: [{ matcher: PROPOSE_TOOL, hooks: [hook] }] },
          baseEnv: { PATH: process.env.PATH, HOME: home }, auth: { apiKey: DUMMY_KEY, baseUrl: `http://127.0.0.1:${api.port}` },
        }),
      );
      options.pathToClaudeCodeExecutable = CLAUDE_BIN;
      await drain(agentSdk.query({ prompt: 'draft p1', options }) as never, ac);
      expect(verdicts).toEqual(['retry']);
      const main = api.bodies.filter((x) => x.path.startsWith('/v1/messages') && Array.isArray(x.body.tools) && x.body.tools.some((t: { name: string }) => t.name === PROPOSE_TOOL));
      const tool = main[0]!.body.tools.find((t: { name: string }) => t.name === PROPOSE_TOOL);
      expect(tool.input_schema.required).toEqual(['pid', 'job', 'sentences']);
      expect(tool.input_schema.properties.sentences.items.required).toEqual(['text']);
      const results = main.flatMap((x) => (x.body.messages as Array<{ content: unknown }>).flatMap((m) => (Array.isArray(m.content) ? m.content : []))).filter((c: { type?: string }) => c.type === 'tool_result');
      expect(results.length).toBeGreaterThan(0);
      const seen = JSON.stringify(results[0]);
      expect(seen).toContain('NOT accepted yet');
      expect(seen).not.toContain('if you can read this, the gate did not run');
    } finally {
      await api.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
