/**
 * LlmService: prompt assembly, the ghost route, sentence actions (instruct / alternatives / grammar /
 * intent rendering), the re-planner, cache pre-warming and cost accounting.
 *
 * Every route builds its system prompt through `systemFor` (core buildSystemBlocks: block A skill +
 * memo + norms, ttl 1h; block B briefs + frozen outline + terminology + cite keys + fact table, 5 min;
 * block C exemplars, 5 min), and only the volatile tail (core *Tail builders) changes per request, so
 * the cached prefix is byte-stable. Every AI sentence passes core gateSentence before anyone sees it;
 * a ghost that fails twice is never shown (ghost.empty), a rewrite that fails is offered with its
 * issues and with visible placeholders in place of ungrounded numbers or citations.
 *
 * Routes and models (ctx.config.models):
 *   ghost   -> models.ghost (Haiku 5.5), thinking disabled, effort low, max_tokens 200, schema 'ghost',
 *              no retries;
 *   actions -> models.actions (Sonnet 5.5), thinking between_tools, effort low, retries with jitter.
 */
import {
  AlternativesOutput,
  CostMeter,
  emptyOutline,
  GHOST_MAX_WORDS,
  GhostOutput,
  GrammarOutput,
  InstructOutput,
  IntentOutput,
  Outline,
  ReplanOutput,
  alternativesTail,
  buildSystemBlocks,
  cleanModelSentence,
  gateSentence,
  ghostTail,
  grammarTail,
  hashString,
  instructTail,
  intentTail,
  nowIso,
  outputJsonSchema,
  promptHash,
  referencesFor,
  factAliases,
  renderFact,
  replanTail,
  shortId,
  wordDiff,
  type ClientMessage,
  type CostTotals,
  type Fact,
  type GateContext,
  type GateIssue,
  type GateMode,
  type GateResult,
  type GateIssueWire,
  type IntentRenderRequest,
  type PlanStep,
  type PromptBlock,
  type Proposal,
  type ServerMessage,
  type SkillBundle,
  type TaskKind,
  type Usage,
  type VersionOrigin,
} from '@paper-copilot/core';
import { z } from 'zod';
import { HttpError, type Ctx, type DocState, type LlmClient, type LlmRequest, type LlmResponse, type LlmService } from '../../contracts';
import { resolveApiKey, resolveBaseUrl } from './apiKey';
import { createLlmClient, describeError, isAbortError } from './client';
import { cursorPlace, defaultGhostMode, englishWordCount, findOutlinePlace, lineContext, mostlyCjk, nearestIntentNote, oneLine, sectionTypeOf, splitPrefix } from './context';
import type { FakeHint } from './fake';
import { createSkillLoader, type SkillLoader } from './skill';

/* ------------------------------------------------------------------------------------ */
/* Constants                                                                             */
/* ------------------------------------------------------------------------------------ */

/** Facts in block B (the whole usable table for a normal paper; ranked by the fact service). */
export const BLOCK_B_FACT_LIMIT = 400;
/** Facts the ghost tail lists as allowed for the next sentence. */
export const GHOST_ALLOWED_FACTS = 12;
export const GHOST_MAX_TOKENS = 200;
const MOVE_EXEMPLARS = 6;
const BLOCK_C_EXEMPLARS = 8;

const ACTION_MAX_TOKENS: Record<'instruct' | 'alternatives' | 'grammar' | 'intent' | 'replan', number> = {
  instruct: 2048,
  alternatives: 3072,
  grammar: 1024,
  intent: 3072,
  replan: 3072,
};

const EMPTY_SKILL: SkillBundle = { dir: '', skillMd: '', references: {}, version: 'none' };

/** One line of .paper/cost.jsonl. */
export const CostRecord = z.object({
  kind: z.literal('usage'),
  ts: z.string(),
  route: z.string(),
  model: z.string(),
  task: z.string().nullable().optional(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_read_input_tokens: z.number().nullable().optional(),
    cache_creation_input_tokens: z.number().nullable().optional(),
    cache_creation: z.object({ ephemeral_5m_input_tokens: z.number().nullable().optional(), ephemeral_1h_input_tokens: z.number().nullable().optional() }).nullable().optional(),
  }),
  usd: z.number(),
  requestId: z.string().nullable().optional(),
  ms: z.number().nullable().optional(),
  ttftMs: z.number().nullable().optional(),
});
export type CostRecord = z.infer<typeof CostRecord>;

const ZERO_TOTALS: CostTotals = { usd: 0, byRoute: {}, byModel: {}, requests: 0, cacheReadTokens: 0, inputTokens: 0, outputTokens: 0 };

/* ------------------------------------------------------------------------------------ */
/* Options                                                                               */
/* ------------------------------------------------------------------------------------ */

export interface LlmServiceOptions {
  /** Inject a client (tests, benches). Default: real client with a key, else the fake. */
  client?: LlmClient;
  /** How often the skill directory is re-stat'ed (ms). */
  skillCheckIntervalMs?: number;
}

type GhostRequestMsg = Extract<ClientMessage, { type: 'ghost.request' }>;
type GhostFeedbackMsg = Extract<ClientMessage, { type: 'ghost.feedback' }>;

interface InflightGhost {
  requestId: string;
  file: string;
  ctl: AbortController;
  /** Why it stopped: cancelled by the client, or superseded by a newer request for the same file. */
  stopped: 'cancelled' | 'superseded' | null;
}

interface PendingFulfilled {
  file: string;
  cursor: number;
  sectionId: string;
  paragraphId: string | null;
  paragraphIndex: number | null;
  stepIds: string[];
}

/** Text the result must still sit next to for the ghost to apply (stale check). */
interface GhostAnchor {
  file: string;
  /** Up to 60 chars before the cursor, ending with the prefix. */
  before: string;
  cursor: number;
}

/* ------------------------------------------------------------------------------------ */
/* Small helpers                                                                         */
/* ------------------------------------------------------------------------------------ */

function toWire(issues: GateIssue[], withOffsets: boolean): GateIssueWire[] {
  return issues.map((i) => {
    const w: GateIssueWire = { code: i.code, severity: i.severity, message: i.message };
    if (withOffsets && typeof i.start === 'number') w.start = i.start;
    if (withOffsets && typeof i.end === 'number') w.end = i.end;
    if (typeof i.raw === 'string') w.raw = i.raw;
    return w;
  });
}

function blockIssue(code: string, message: string): GateIssue {
  return { code: code as GateIssue['code'], severity: 'block', message };
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function clampInt(n: unknown, lo: number, hi: number, dflt: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : dflt;
  return Math.max(lo, Math.min(hi, v));
}

/** How a fact reads in a sentence ("2.32 points"): its first alias, else renderFact without the "id =" label. */
function proseRendering(f: Fact): string {
  try {
    const a = (f.aliases?.length ? f.aliases : factAliases(f))[0];
    if (a) return a;
  } catch {
    /* fall back to renderFact */
  }
  try {
    return renderFact(f).replace(/^[^=:]*[=:]\s*/, '').trim();
  } catch {
    return '';
  }
}

function stillApplies(doc: DocState | undefined, anchor: GhostAnchor): boolean {
  if (!doc) return false;
  if (!anchor.before) return true;
  const lo = Math.max(0, anchor.cursor - anchor.before.length - 4000);
  const hi = Math.min(doc.text.length, anchor.cursor + 4000);
  return doc.text.slice(lo, hi).includes(anchor.before);
}

/** The gate feedback appended to the tail for the one regeneration. */
export function regenerationFeedback(previous: string, issues: GateIssue[]): string {
  const lines = issues.filter((i) => i.severity === 'block').map((i) => `- ${i.code}: ${i.message}`);
  return [
    '',
    '<previous_attempt_rejected>',
    'Your previous suggestion was rejected by the faithfulness check and was not shown to the author.',
    `Rejected suggestion: ${JSON.stringify(previous)}`,
    'Problems:',
    ...lines,
    'Write a new suggestion that fixes every problem. Continue the typed text verbatim. Use only numbers of the allowed facts and only the allowed citation keys; where a number or citation is missing, write a descriptive placeholder such as [fact?: ...] or [ref] instead.',
    '</previous_attempt_rejected>',
  ].join('\n');
}

/* ------------------------------------------------------------------------------------ */
/* Service                                                                               */
/* ------------------------------------------------------------------------------------ */

export function createLlmService(ctx: Ctx, opts: LlmServiceOptions = {}): LlmService & { skillLoader: SkillLoader } {
  const log = ctx.log;
  let client: LlmClient | null = opts.client ?? null;
  const getClient = (): LlmClient => {
    if (client) return client;
    const fakeLatencyMs = Number(process.env.PAPER_FAKE_LATENCY_MS ?? 0) || 0;
    if (ctx.fakeLlm) {
      client = createLlmClient({ apiKey: null, fake: true, fakeLatencyMs });
    } else {
      const { key, source } = resolveApiKey();
      if (!key) {
        log.warn('no Anthropic API key (ANTHROPIC_API_KEY or keychain service "paper-copilot"); using the simulated AI');
        client = createLlmClient({ apiKey: null, fake: true, fakeLatencyMs });
      } else {
        log.info(`Anthropic API key from ${source}`);
        client = createLlmClient({ apiKey: key, fake: false, log, baseURL: resolveBaseUrl() });
      }
    }
    return client;
  };

  const skillLoader = createSkillLoader(() => ctx.config.skillDir, { log, checkIntervalMs: opts.skillCheckIntervalMs });

  /* ---------------------------------- safe reads ---------------------------------- */

  const warned = new Set<string>();
  function safe<T>(what: string, fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (e) {
      if (!warned.has(what)) {
        warned.add(what);
        log.warn(`llm: ${what} unavailable; using a default`, describeError(e));
      }
      return fallback;
    }
  }

  const readOutline = (): Outline => ctx.files.readJson(ctx.paths.outline, Outline, emptyOutline());
  const notesLanguage = (): 'zh' | 'en' => (ctx.config.notesLanguage === 'en' ? 'en' : 'zh');
  const usableFacts = (): Fact[] => safe('facts.all', () => ctx.facts.all().filter((f) => !f.excluded), []);
  const allowedCiteKeys = (): Array<{ key: string; title: string }> => safe('lit.allowedKeys', () => ctx.lit.allowedKeys(), []);

  /* ---------------------------------- outline lock -------------------------------- */

  let outlineChain: Promise<unknown> = Promise.resolve();
  function withOutline(fn: (o: Outline) => boolean | Promise<boolean>): Promise<void> {
    const run = outlineChain.then(async () => {
      const o = readOutline();
      const changed = await fn(o);
      if (!changed) return;
      const parsed = Outline.safeParse(o);
      if (!parsed.success) {
        log.warn('llm: refusing to write an invalid outline', parsed.error.message.slice(0, 300));
        return;
      }
      await ctx.files.writeJson(ctx.paths.outline, parsed.data);
      ctx.bus.emit({ type: 'plan.updated', outline: parsed.data });
    });
    outlineChain = run.catch((e) => log.warn('llm: outline update failed', describeError(e)));
    return run.then(
      () => undefined,
      () => undefined,
    );
  }

  /* ---------------------------------- cost ---------------------------------------- */

  let meter: CostMeter | null = null;
  let meterBroken = false;
  const unknownModels = new Set<string>();
  let costChain: Promise<unknown> = Promise.resolve();

  function getMeter(): CostMeter | null {
    if (meter || meterBroken) return meter;
    try {
      const m = new CostMeter();
      for (const r of ctx.files.readJsonl(ctx.paths.costLog, z.unknown())) {
        const p = CostRecord.safeParse(r);
        if (p.success) m.add(p.data.model, p.data.usage as Usage, p.data.route);
      }
      meter = m;
    } catch (e) {
      meterBroken = true;
      log.warn('llm: cost meter unavailable', describeError(e));
      // Try again later (core may still be loading in development).
      setTimeout(() => (meterBroken = false), 5000).unref?.();
    }
    return meter;
  }

  function totals(): CostTotals {
    const m = getMeter();
    if (!m) return { ...ZERO_TOTALS };
    try {
      return m.totals();
    } catch {
      return { ...ZERO_TOTALS };
    }
  }

  function appendCost(line: unknown): void {
    costChain = costChain.then(() => ctx.files.appendJsonl(ctx.paths.costLog, line)).catch((e) => log.warn('llm: cannot append to cost log', describeError(e)));
  }

  function record(model: string, usage: Usage, route: string, extra: { task?: string | null; requestId?: string | null; ms?: number | null; ttftMs?: number | null } = {}): number {
    const m = getMeter();
    let usd = 0;
    if (m) {
      try {
        usd = m.add(model, usage, route);
      } catch (e) {
        log.warn('llm: cost meter failed', describeError(e));
      }
    }
    if (usd === 0 && !model.startsWith('fake-') && (usage.input_tokens > 0 || usage.output_tokens > 0) && !unknownModels.has(model)) {
      unknownModels.add(model);
      log.warn(`llm: no price for model ${model}; its cost is counted as 0`);
    }
    const line: CostRecord = { kind: 'usage', ts: nowIso(), route, model, task: extra.task ?? null, usage, usd, requestId: extra.requestId ?? null, ms: extra.ms ?? null, ttftMs: extra.ttftMs ?? null };
    appendCost(line);
    ctx.bus.emit({ type: 'cost.update', totals: totals() });
    return usd;
  }

  const recordResponse = (res: LlmResponse, route: string, task: TaskKind) => record(res.model, res.usage, route, { task, requestId: res.requestId, ms: res.ms, ttftMs: res.ttftMs });

  /* ---------------------------------- prompts ------------------------------------- */

  function systemFor(task: TaskKind, o: { sectionType: string; template?: string | null; query?: string; factIds?: string[] }): PromptBlock[] {
    const skill = skillLoader.get();
    const query = o.query?.trim() ? o.query : undefined;
    return buildSystemBlocks({
      task,
      skill: skill ?? EMPTY_SKILL,
      referenceKeys: safe<string[] | undefined>('referencesFor', () => referencesFor(task, o.template ?? null), undefined),
      memo: safe('voice.memo', () => ctx.voice.memo(), ''),
      authorNorms: safe('voice.authorNormsTable', () => ctx.voice.authorNormsTable(), ''),
      notesLanguage: notesLanguage(),
      repoBrief: safe('repo brief', () => ctx.files.readText(ctx.paths.repoBrief) ?? '', ''),
      litBrief: safe('lit.brief', () => ctx.lit.brief(), ''),
      outline: safe('outline', readOutline, emptyOutline()),
      terminology: safe('facts.terminology', () => ctx.facts.terminology(), []),
      citeKeys: allowedCiteKeys(),
      facts: safe('facts.forPrompt', () => ctx.facts.forPrompt({ factIds: o.factIds, query, limit: BLOCK_B_FACT_LIMIT }), []),
      exemplars: safe('voice.exemplars', () => ctx.voice.exemplars(o.sectionType, query ?? '', BLOCK_C_EXEMPLARS), []),
      sectionType: o.sectionType,
    });
  }

  function gateContext(mode: GateMode, extra: Partial<GateContext> = {}): GateContext {
    return {
      mode,
      facts: usableFacts(),
      allowedCiteKeys: allowedCiteKeys().map((k) => k.key),
      knownLabels: safe('docs.labels', () => ctx.docs.labels(), []),
      fictionalNumbers: skillLoader.fictionalNumbers(),
      ...extra,
    };
  }

  function runGate(text: string, gctx: GateContext): GateResult {
    try {
      return gateSentence(text, gctx);
    } catch (e) {
      // The gate fails closed.
      log.error('llm: gate failed', describeError(e));
      return { ok: false, issues: [blockIssue('gate_error', 'The faithfulness check failed internally.')], repaired: text, factIds: [], citeKeys: [], unlinked: [], placeholders: [] };
    }
  }

  /* ---------------------------------- ghost --------------------------------------- */

  const inflight = new Map<string, InflightGhost>();
  const earlyCancelled: string[] = [];
  const pending = new Map<string, PendingFulfilled>();

  function rememberEarlyCancel(id: string) {
    earlyCancelled.push(id);
    if (earlyCancelled.length > 200) earlyCancelled.shift();
  }

  async function handleGhostRequest(msg: GhostRequestMsg, send: (m: ServerMessage) => void): Promise<void> {
    const ec = earlyCancelled.indexOf(msg.requestId);
    if (ec >= 0) {
      earlyCancelled.splice(ec, 1);
      return;
    }
    // A newer request for the same file supersedes every older one.
    for (const r of inflight.values()) {
      if (r.file === msg.file && r.requestId !== msg.requestId) {
        r.stopped = 'superseded';
        r.ctl.abort();
        inflight.delete(r.requestId);
      }
    }
    const entry: InflightGhost = { requestId: msg.requestId, file: msg.file, ctl: new AbortController(), stopped: null };
    inflight.set(msg.requestId, entry);
    const live = () => entry.stopped === null && !entry.ctl.signal.aborted;
    const reply = (m: ServerMessage) => {
      if (live()) send(m);
    };
    try {
      await runGhost(msg, entry, reply, live);
    } catch (e) {
      if (isAbortError(e) || !live()) return;
      log.warn('ghost request failed', describeError(e));
      reply({ type: 'ghost.error', requestId: msg.requestId, message: e instanceof HttpError ? e.message : `The suggestion failed: ${describeError(e)}` });
    } finally {
      if (inflight.get(msg.requestId) === entry) inflight.delete(msg.requestId);
    }
  }

  async function runGhost(msg: GhostRequestMsg, entry: InflightGhost, reply: (m: ServerMessage) => void, live: () => boolean): Promise<void> {
    const empty = (reason: string) => reply({ type: 'ghost.empty', requestId: msg.requestId, reason });
    const doc = ctx.docs.get(msg.file) ?? (await ctx.docs.open(msg.file));
    if (!live()) return;
    const cursor = clampInt(msg.cursor, 0, doc.text.length, doc.text.length);
    const prefix = oneLine(msg.prefix ?? '');
    if (prefix.length > 2000) return empty('The sentence typed so far is too long for a suggestion.');
    if (mostlyCjk(prefix)) return empty('This looks like an intent note; render it with Ctrl+Enter instead.');

    const place = cursorPlace(doc, ctx.docs, cursor, prefix);
    const outline = safe('outline', readOutline, emptyOutline());
    const { section, paragraph } = findOutlinePlace(outline, place.sectionId, place.paragraphId, place.paragraphIndex);
    const sectionType = sectionTypeOf(section?.template, place.part, section?.title ?? place.sectionTitle);
    const mode = section?.ghostMode ?? defaultGhostMode(sectionType);
    if (mode === 'questions-only') return empty('This section is set to questions only: no prose suggestions.');
    if (mode === 'complete-my-sentence' && msg.trigger !== 'manual') {
      if (msg.trigger === 'boundary') return empty('This section is set to complete-my-sentence: suggestions start after you type.');
      if (englishWordCount(prefix) < 3) return empty('This section is set to complete-my-sentence: type at least three words first.');
    }

    const plan = paragraph?.plan ?? null;
    const nextStep: PlanStep | null = plan?.remaining[0] ?? null;
    const intentNote = nearestIntentNote(doc, cursor) ?? (place.anchor && !place.newParagraph ? place.anchor.intentNote : null) ?? null;
    const query = [nextStep?.intent, paragraph?.job, prefix, intentNote].filter((s): s is string => !!s && s.trim().length > 0).join(' ');
    const moveExemplars = safe('voice.exemplars', () => ctx.voice.exemplars(sectionType, query, MOVE_EXEMPLARS), []);
    const planFactIds = uniq((plan?.remaining ?? []).flatMap((s) => s.factIds));
    const allowedFacts = safe('facts.forPrompt', () => ctx.facts.forPrompt({ factIds: planFactIds, query, limit: GHOST_ALLOWED_FACTS }), []);
    const allowedFactIds = allowedFacts.map((f) => f.id);

    const system = systemFor('ghost', { sectionType, template: section?.template ?? null });
    const tail = ghostTail({
      mode,
      sectionTitle: section?.title ?? place.sectionTitle,
      sectionType,
      paragraphJob: paragraph?.job ?? '',
      plan,
      previousParagraphs: place.previousParagraphs.slice(-2),
      paragraphBefore: place.paragraphBefore,
      prefix,
      intentNote,
      moveExemplars,
      allowedFactIds,
      maxWords: GHOST_MAX_WORDS,
    });

    const factsById = new Map(usableFacts().map((f) => [f.id, f]));
    const hintFacts = allowedFactIds
      .map((id) => factsById.get(id))
      .filter((f): f is Fact => !!f)
      .map((f) => ({ id: f.id, rendering: proseRendering(f) }))
      .filter((f) => f.rendering.length > 0);
    const hint: FakeHint = { task: 'ghost', prefix, step: nextStep ? { id: nextStep.id, intent: nextStep.intent, factIds: nextStep.factIds } : null, facts: hintFacts };
    const baseGate = gateContext('ghost', { maxWords: GHOST_MAX_WORDS, intentText: [intentNote ?? '', prefix].filter(Boolean).join('\n') || null });
    const stepIds = new Set((plan?.remaining ?? []).map((s) => s.id));
    const anchor: GhostAnchor = { file: msg.file, before: doc.text.slice(Math.max(0, cursor - 60), cursor), cursor };

    let feedback = '';
    let lastIssues: GateIssue[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const fullTail = tail + feedback;
      const req: LlmRequest = {
        route: 'ghost',
        task: 'ghost',
        model: ctx.config.models.ghost,
        system,
        messages: [{ role: 'user', content: fullTail }],
        maxTokens: GHOST_MAX_TOKENS,
        thinking: 'disabled',
        effort: 'low',
        schema: outputJsonSchema('ghost'),
        signal: entry.ctl.signal,
        fakeHint: hint,
      };
      const res = await getClient().complete(req);
      recordResponse(res, 'ghost', 'ghost');
      if (!live()) return;
      const out = parseGhost(res);
      if (!out) {
        lastIssues = [blockIssue('empty', res.stopReason === 'refusal' ? 'The model declined to suggest a sentence.' : 'The model returned no sentence.')];
        if (res.stopReason === 'refusal') break;
        feedback = regenerationFeedback('', lastIssues);
        continue;
      }
      const ev = evaluateGhost(out.text, prefix, { ...baseGate, claimedFactIds: out.fact_ids });
      if (!ev.ok) {
        lastIssues = ev.issues;
        feedback = regenerationFeedback(out.text, ev.issues);
        continue;
      }
      if (!stillApplies(ctx.docs.get(msg.file), anchor)) return empty('stale: the text changed while the suggestion was computed');
      const fulfilled = uniq(out.fulfilled_move_ids.filter((id) => stepIds.has(id)));
      if (fulfilled.length > 0) {
        pending.set(msg.requestId, { file: msg.file, cursor, sectionId: place.sectionId, paragraphId: place.paragraphId, paragraphIndex: place.paragraphIndex, stepIds: fulfilled });
        if (pending.size > 100) pending.delete(pending.keys().next().value as string);
      }
      reply({
        type: 'ghost.result',
        requestId: msg.requestId,
        version: msg.version,
        cursor: msg.cursor,
        text: ev.continuation,
        factIds: ev.gate.factIds,
        citeKeys: ev.gate.citeKeys,
        fulfilledMoveIds: fulfilled,
        issues: toWire(ev.issues, false),
        model: res.model,
        promptHash: promptHash(system, fullTail),
      });
      return;
    }
    const codes = uniq(lastIssues.filter((i) => i.severity === 'block').map((i) => i.code));
    empty(`No grounded suggestion${codes.length ? ` (${codes.join(', ')})` : ''}.`);
  }

  function parseGhost(res: LlmResponse): z.infer<typeof GhostOutput> | null {
    if (res.stopReason === 'refusal') return null;
    const p = GhostOutput.safeParse(res.json);
    if (p.success) return p.data.text.trim() ? p.data : null;
    // Truncated JSON: `text` is the first property, so a complete text string can still be recovered.
    const m = /^\s*\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(res.text);
    if (m) {
      try {
        const text = JSON.parse(`"${m[1]}"`) as string;
        if (text.trim()) return { text, fact_ids: [], cite_keys: [], fulfilled_move_ids: [] };
      } catch {
        /* fall through */
      }
    }
    return null;
  }

  /** Clean, check the prefix, gate the whole sentence; issues that lie inside the author's own prefix are not the AI's. */
  function evaluateGhost(raw: string, prefix: string, gctx: GateContext): { ok: boolean; continuation: string; issues: GateIssue[]; gate: GateResult } {
    const cleaned = oneLine(safe('cleanModelSentence', () => cleanModelSentence(raw), raw.trim()));
    const split = splitPrefix(cleaned, prefix);
    const noGate: GateResult = { ok: false, issues: [], repaired: cleaned, factIds: [], citeKeys: [], unlinked: [], placeholders: [] };
    if (!split) {
      return { ok: false, continuation: '', issues: [blockIssue('prefix_mismatch', 'The suggestion did not continue the typed text verbatim.')], gate: noGate };
    }
    const continuation = split.continuation.replace(/\s+$/, '');
    if (continuation.trim().length === 0) return { ok: false, continuation: '', issues: [blockIssue('empty', 'The suggestion adds nothing to the typed text.')], gate: noGate };
    const full = prefix + continuation;
    const g = runGate(full, gctx);
    const authorEnd = prefix.length;
    const issues = g.issues.filter((i) => !(typeof i.start === 'number' && typeof i.end === 'number' && i.end <= authorEnd));
    return { ok: !issues.some((i) => i.severity === 'block'), continuation, issues, gate: g };
  }

  function cancelGhost(requestId: string): void {
    const r = inflight.get(requestId);
    if (!r) {
      rememberEarlyCancel(requestId);
      return;
    }
    r.stopped = 'cancelled';
    r.ctl.abort();
    inflight.delete(requestId);
  }

  function ghostFeedback(msg: GhostFeedbackMsg): void {
    const key = `llm.ghost.outcome.${msg.outcome}`;
    safe('db.kv', () => {
      ctx.db.transaction(() => {
        const n = Number(ctx.db.kvGet(key) ?? '0') || 0;
        ctx.db.kvSet(key, String(n + 1));
        const t = Number(ctx.db.kvGet('llm.ghost.outcome.total') ?? '0') || 0;
        ctx.db.kvSet('llm.ghost.outcome.total', String(t + 1));
      });
    }, undefined);
    appendCost({ kind: 'ghost.feedback', ts: nowIso(), requestId: msg.requestId, outcome: msg.outcome, acceptedChars: msg.acceptedText?.length ?? 0 });
    const p = pending.get(msg.requestId);
    pending.delete(msg.requestId);
    // Only a fully accepted sentence fulfils its plan steps (a dismissed ghost says nothing).
    if (!p || msg.outcome !== 'accepted') return;
    const doc = ctx.docs.get(p.file);
    const unit = doc?.units.find((u) => u.start <= p.cursor && p.cursor <= u.end) ?? null;
    const sid = unit?.id ?? `ghost:${msg.requestId}`;
    void withOutline((o) => {
      const { paragraph } = findOutlinePlace(o, p.sectionId, p.paragraphId, p.paragraphIndex);
      if (!paragraph) return false;
      let changed = false;
      for (const id of p.stepIds) {
        const idx = paragraph.plan.remaining.findIndex((s) => s.id === id);
        if (idx < 0) continue;
        paragraph.plan.remaining.splice(idx, 1);
        paragraph.plan.said[id] = sid;
        changed = true;
      }
      return changed;
    });
  }

  /* ---------------------------------- actions ------------------------------------- */

  async function actionCall<T>(task: 'instruct' | 'alternatives' | 'grammar' | 'intent' | 'replan', system: PromptBlock[], tail: string, schema: z.ZodType<T>, hint: FakeHint): Promise<{ out: T; res: LlmResponse }> {
    const req: LlmRequest = {
      route: 'actions',
      task,
      model: ctx.config.models.actions,
      system,
      messages: [{ role: 'user', content: tail }],
      maxTokens: ACTION_MAX_TOKENS[task],
      thinking: 'between_tools',
      effort: 'low',
      schema: outputJsonSchema(task),
      fakeHint: hint,
    };
    let res: LlmResponse;
    try {
      res = await getClient().complete(req);
    } catch (e) {
      log.warn(`llm ${task} failed`, describeError(e));
      throw new HttpError(502, `The AI request failed: ${describeError(e)}`);
    }
    recordResponse(res, 'actions', task);
    if (res.stopReason === 'refusal') throw new HttpError(422, 'The model declined this request.');
    const p = schema.safeParse(res.json);
    if (!p.success) {
      log.warn(`llm ${task}: output did not match the schema`, `${res.stopReason ?? ''} ${res.text.slice(0, 200)}`);
      throw new HttpError(502, res.stopReason === 'max_tokens' ? 'The AI response was cut off; try again.' : 'The AI returned an invalid response; try again.');
    }
    return { out: p.data, res };
  }

  interface UnitInfo {
    id: string;
    text: string;
    sectionType: string;
    template: string | null;
    paragraphBefore: string;
    paragraphAfter: string;
    factIds: string[];
    citeKeys: string[];
  }

  function unitInfo(sentenceId: string): UnitInfo {
    const unit = ctx.docs.unit(sentenceId);
    const text = unit ? ctx.docs.unitText(sentenceId) : null;
    if (!unit || text === null) throw new HttpError(404, `unknown sentence ${sentenceId}`);
    const c = ctx.docs.context(sentenceId);
    const outline = safe('outline', readOutline, emptyOutline());
    const { section } = findOutlinePlace(outline, c?.sectionId ?? unit.sectionId, unit.paragraphId);
    return {
      id: sentenceId,
      text,
      sectionType: sectionTypeOf(section?.template, c?.part ?? unit.part, section?.title ?? c?.sectionTitle ?? ''),
      template: section?.template ?? null,
      paragraphBefore: c?.paragraphBefore ?? '',
      paragraphAfter: c?.paragraphAfter ?? '',
      factIds: unit.facts ?? [],
      citeKeys: unit.cites ?? [],
    };
  }

  function makeProposal(p: { sentenceId: string | null; original: string; text: string; notes: string; drift: Proposal['drift']; gate: GateResult; origin: VersionOrigin; model: string; promptHash: string }): Proposal {
    // Never offer an ungrounded number or citation as clean text: a blocked proposal carries the gate's
    // visible placeholders ([fact?: ...], [ref]) and its issues.
    const text = p.gate.ok ? p.text : p.gate.repaired;
    return {
      proposalId: shortId('p'),
      sentenceId: p.sentenceId,
      text,
      diff: wordDiff(p.original, text),
      notes: p.notes,
      drift: p.drift,
      issues: toWire(p.gate.issues, text === p.text),
      factIds: p.gate.factIds,
      citeKeys: p.gate.citeKeys,
      origin: p.origin,
      model: p.model,
      promptHash: p.promptHash,
    };
  }

  const cleanOut = (s: string): string => oneLine(safe('cleanModelSentence', () => cleanModelSentence(s), s.trim())).trim();

  async function instruct(sentenceId: string, instruction: string, lang: string | null): Promise<Proposal> {
    const ins = (instruction ?? '').trim();
    if (!ins) throw new HttpError(400, 'instruction is empty');
    if (ins.length > 4000) throw new HttpError(400, 'instruction is too long');
    const u = unitInfo(sentenceId);
    const system = systemFor('instruct', { sectionType: u.sectionType, template: u.template });
    const tail = instructTail({ sentence: u.text, instruction: ins, lang, before: u.paragraphBefore, after: u.paragraphAfter, notesLanguage: notesLanguage() });
    const { out, res } = await actionCall('instruct', system, tail, InstructOutput, { task: 'instruct', sentence: u.text, instruction: ins, notesLanguage: notesLanguage(), factIds: u.factIds, citeKeys: u.citeKeys });
    const text = cleanOut(out.text);
    const gate = runGate(text, gateContext('rewrite', { original: u.text, intentText: ins, claimedFactIds: uniq([...out.fact_ids, ...u.factIds]) }));
    return makeProposal({ sentenceId, original: u.text, text, notes: out.notes, drift: out.drift, gate, origin: 'ai_rewrite', model: res.model, promptHash: promptHash(system, tail) });
  }

  async function alternatives(sentenceId: string, n: number): Promise<Proposal[]> {
    const k = clampInt(n, 1, 5, 3);
    const u = unitInfo(sentenceId);
    const system = systemFor('alternatives', { sectionType: u.sectionType, template: u.template });
    const tail = alternativesTail({ sentence: u.text, n: k, before: u.paragraphBefore, after: u.paragraphAfter, notesLanguage: notesLanguage() });
    const { out, res } = await actionCall('alternatives', system, tail, AlternativesOutput, { task: 'alternatives', sentence: u.text, n: k, notesLanguage: notesLanguage() });
    const ph = promptHash(system, tail);
    const seen = new Set<string>();
    const proposals: Proposal[] = [];
    for (const alt of out.alternatives) {
      const text = cleanOut(alt.text);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      const gate = runGate(text, gateContext('rewrite', { original: u.text, claimedFactIds: u.factIds }));
      proposals.push(makeProposal({ sentenceId, original: u.text, text, notes: alt.note, drift: null, gate, origin: 'ai_rewrite', model: res.model, promptHash: ph }));
      if (proposals.length >= k) break;
    }
    return proposals;
  }

  async function grammar(sentenceId: string): Promise<Proposal> {
    const u = unitInfo(sentenceId);
    const system = systemFor('grammar', { sectionType: u.sectionType, template: u.template });
    const tail = grammarTail({ sentence: u.text, notesLanguage: notesLanguage() });
    const { out, res } = await actionCall('grammar', system, tail, GrammarOutput, { task: 'grammar', sentence: u.text, notesLanguage: notesLanguage() });
    const text = cleanOut(out.text);
    const gate = runGate(text, gateContext('grammar', { original: u.text, claimedFactIds: u.factIds }));
    const notes = out.changes.length > 0 ? out.changes.join('\n') : notesLanguage() === 'zh' ? '没有语法问题。' : 'No grammar problems found.';
    return makeProposal({ sentenceId, original: u.text, text, notes, drift: null, gate, origin: 'grammar_fix', model: res.model, promptHash: promptHash(system, tail) });
  }

  async function renderIntent(req: z.infer<typeof IntentRenderRequest>): Promise<Proposal[]> {
    const note = (req.text ?? '').trim();
    if (!note) throw new HttpError(400, 'intent text is empty');
    if (note.length > 4000) throw new HttpError(400, 'intent text is too long');
    const k = clampInt(req.n, 1, 3, 1);
    let doc: DocState;
    try {
      doc = ctx.docs.get(req.file) ?? (await ctx.docs.open(req.file));
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(404, `cannot open ${req.file}`);
    }
    const lc = lineContext(doc, ctx.docs, req.line);
    const outline = safe('outline', readOutline, emptyOutline());
    const { section } = findOutlinePlace(outline, lc.sectionId, lc.paragraphId);
    const sectionType = sectionTypeOf(section?.template, lc.part, section?.title ?? lc.sectionTitle);
    const moveExemplars = safe('voice.exemplars', () => ctx.voice.exemplars(sectionType, `${lc.paragraphBefore} ${lc.paragraphAfter}`.slice(-600), MOVE_EXEMPLARS), []);
    const system = systemFor('intent', { sectionType, template: section?.template ?? null });
    const tail = intentTail({ intentNote: note, sectionTitle: section?.title ?? lc.sectionTitle, paragraphBefore: lc.paragraphBefore, paragraphAfter: lc.paragraphAfter, n: k, moveExemplars, notesLanguage: notesLanguage() });
    const { out, res } = await actionCall('intent', system, tail, IntentOutput, { task: 'intent', note, n: k, notesLanguage: notesLanguage() });
    const ph = promptHash(system, tail);
    const seen = new Set<string>();
    const proposals: Proposal[] = [];
    for (const p of out.proposals) {
      const text = cleanOut(p.text);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      const gate = runGate(text, gateContext('intent', { intentText: note, claimedFactIds: p.fact_ids }));
      proposals.push(makeProposal({ sentenceId: null, original: '', text, notes: p.note, drift: null, gate, origin: 'ai_intent', model: res.model, promptHash: ph }));
      if (proposals.length >= k) break;
    }
    return proposals;
  }

  /* ---------------------------------- re-plan ------------------------------------- */

  async function replanAfterEdit(file: string, sentenceId: string): Promise<void> {
    const doc = ctx.docs.get(file);
    const unit = doc?.units.find((u) => u.id === sentenceId) ?? ctx.docs.unit(sentenceId);
    if (!doc || !unit) return;
    const para = doc.units.filter((u) => u.paragraphId === unit.paragraphId && u.sectionId === unit.sectionId).sort((a, b) => a.start - b.start);
    const pos = para.findIndex((u) => u.id === sentenceId);
    if (pos < 0) return;
    const textOf = (id: string) => ctx.docs.unitText(id) ?? '';
    // Only downstream sentences still awaiting review may change; accepted sentences never do.
    const downstream = para.slice(pos + 1).filter((u) => u.state === 'proposed');
    if (downstream.length === 0) return;
    const downstreamIds = new Set(downstream.map((u) => u.id));
    const outline = safe('outline', readOutline, emptyOutline());
    const { section, paragraph } = findOutlinePlace(outline, unit.sectionId, unit.paragraphId);
    const c = ctx.docs.context(sentenceId);
    const sectionType = sectionTypeOf(section?.template, c?.part ?? unit.part, section?.title ?? c?.sectionTitle ?? '');
    const versions = safe('db.versions', () => ctx.db.versions(sentenceId), []);
    const after = textOf(sentenceId);
    const beforeText = versions.length >= 2 ? (versions[versions.length - 2]?.text ?? null) : null;
    const system = systemFor('replan', { sectionType, template: section?.template ?? null });
    const remaining = paragraph?.plan.remaining ?? [];
    const tail = replanTail({
      paragraphJob: paragraph?.job ?? '',
      sentencesSoFar: para.slice(0, pos + 1).map((u) => ({ id: u.id, text: textOf(u.id), state: u.state })),
      remaining,
      downstreamProposed: downstream.map((u) => ({ id: u.id, text: textOf(u.id) })),
      edited: beforeText !== null && beforeText !== after ? { id: sentenceId, before: beforeText, after } : null,
    });
    let out: z.infer<typeof ReplanOutput>;
    try {
      ({ out } = await actionCall('replan', system, tail, ReplanOutput, {
        task: 'replan',
        downstream: downstream.map((u) => ({ id: u.id, text: textOf(u.id) })),
        remaining: remaining.map((r) => ({ intent: r.intent, factIds: r.factIds, move: r.move })),
      }));
    } catch (e) {
      // A background pass: a failed re-plan leaves the proposed sentences as they are.
      log.warn('re-plan failed; downstream sentences unchanged', describeError(e));
      return;
    }

    const items: Array<{ sentenceId: string; action: 'keep' | 'revise' | 'drop' | 'insert_before'; text: string | null; reason: string }> = [];
    const seen = new Set<string>();
    for (const it of out.items) {
      if (!downstreamIds.has(it.sentence_id)) continue; // never touch accepted or upstream sentences
      if (it.action !== 'insert_before') {
        if (seen.has(it.sentence_id)) continue;
        seen.add(it.sentence_id);
      }
      if (it.action === 'revise' || it.action === 'insert_before') {
        const text = it.text ? cleanOut(it.text) : '';
        if (!text) {
          if (it.action === 'revise') items.push({ sentenceId: it.sentence_id, action: 'keep', text: null, reason: it.reason });
          continue;
        }
        const gate = runGate(text, gateContext('draft', { claimedFactIds: [] }));
        if (!gate.ok) {
          const codes = uniq(gate.issues.filter((i) => i.severity === 'block').map((i) => i.code)).join(', ');
          if (it.action === 'revise') items.push({ sentenceId: it.sentence_id, action: 'keep', text: null, reason: `${it.reason} (revision withheld: failed the faithfulness check: ${codes})` });
          continue;
        }
        items.push({ sentenceId: it.sentence_id, action: it.action, text, reason: it.reason });
      } else {
        items.push({ sentenceId: it.sentence_id, action: it.action, text: null, reason: it.reason });
      }
    }
    ctx.bus.emit({ type: 'replan.proposed', file, items });

    if (!paragraph) return;
    const knownFacts = new Set(usableFacts().map((f) => f.id));
    const saidUnits = para.slice(0, pos + 1);
    await withOutline((o) => {
      const { paragraph: p } = findOutlinePlace(o, unit.sectionId, unit.paragraphId);
      if (!p) return false;
      const old = p.plan.remaining;
      const byIntent = new Map(old.map((s) => [s.intent.trim().toLowerCase(), s]));
      const next: PlanStep[] = out.paragraph_complete
        ? []
        : out.remaining.map((r) => {
            const reuse = byIntent.get(r.intent.trim().toLowerCase());
            const factIds = r.fact_ids.filter((id) => knownFacts.has(id));
            return { id: reuse?.id ?? `step-${hashString(`${p.pid}|${r.intent}|${factIds.join(',')}`)}`, intent: r.intent, factIds, citeKeys: reuse?.citeKeys ?? [], move: r.move };
          });
      const keptIds = new Set(next.map((s) => s.id));
      // Steps that left the plan and whose facts a sentence so far states were said by that sentence.
      for (const s of old) {
        if (keptIds.has(s.id) || p.plan.said[s.id]) continue;
        const by = saidUnits.find((u) => s.factIds.length > 0 && s.factIds.some((f) => u.facts.includes(f)));
        if (by) p.plan.said[s.id] = by.id;
      }
      p.plan.remaining = next;
      return true;
    });
  }

  /* ---------------------------------- pre-warm ------------------------------------ */

  async function prewarm(): Promise<void> {
    const c = getClient();
    if (c.fake) return;
    if (!skillLoader.get()) return;
    const routes: Array<{ route: 'ghost' | 'actions'; task: TaskKind; model: string; thinking: LlmRequest['thinking']; schema: Record<string, unknown> }> = [
      { route: 'ghost', task: 'ghost', model: ctx.config.models.ghost, thinking: 'disabled', schema: outputJsonSchema('ghost') },
      { route: 'actions', task: 'instruct', model: ctx.config.models.actions, thinking: 'between_tools', schema: outputJsonSchema('instruct') },
    ];
    await Promise.allSettled(
      routes.map(async (r) => {
        // Blocks A and B are shared by every request of the route; block C depends on the section, so
        // it is not warmed (the first request of a section writes it).
        const system = systemFor(r.task, { sectionType: 'body', template: null }).slice(0, 2);
        const usage = await c.prewarm({ route: r.route, task: r.task, model: r.model, system, messages: [{ role: 'user', content: 'warmup' }], maxTokens: 0, thinking: r.thinking, effort: 'low', schema: r.schema });
        if (usage) record(r.model, usage, `prewarm:${r.route}`, { task: r.task });
      }),
    );
  }

  return {
    get client() {
      return getClient();
    },
    skillLoader,
    handleGhostRequest,
    cancelGhost,
    ghostFeedback,
    instruct,
    alternatives,
    grammar,
    renderIntent,
    replanAfterEdit,
    prewarm,
    skill: () => skillLoader.get(),
    systemFor,
    costTotals: totals,
    recordUsage: (model, usage, route) => {
      record(model, usage, route);
    },
  };
}
