/**
 * Deterministic fake LLM client (Ctx.fakeLlm: no API key, PAPER_FAKE_LLM=1, and every test).
 *
 * Output is schema-valid and built from `req.fakeHint` (set by the LLM service for each task; see
 * FakeHint), falling back to a minimal schema-valid object for tasks without a hint. It never invents a
 * number: the only numerals it writes are renderings of facts the service passed in the hint. Results
 * are labelled with model `fake-<model>` and cost nothing. Latency simulation is off unless
 * `latencyMs` > 0 (the server may set PAPER_FAKE_LATENCY_MS for UI work).
 */
import type { LlmClient, LlmRequest, LlmResponse } from '../../contracts';

/* ------------------------------------------------------------------------------------ */
/* Hints                                                                                 */
/* ------------------------------------------------------------------------------------ */

export interface FakeGhostHint {
  task: 'ghost';
  prefix: string;
  /** The next plan step, if any. */
  step: { id: string; intent: string; factIds: string[] } | null;
  /** Renderings of facts the sentence may state (id -> prose rendering such as "2.3 points"). */
  facts: Array<{ id: string; rendering: string }>;
}
export interface FakeInstructHint {
  task: 'instruct';
  sentence: string;
  instruction: string;
  notesLanguage: 'zh' | 'en';
  factIds: string[];
  citeKeys: string[];
}
export interface FakeAlternativesHint {
  task: 'alternatives';
  sentence: string;
  n: number;
  notesLanguage: 'zh' | 'en';
}
export interface FakeGrammarHint {
  task: 'grammar';
  sentence: string;
  notesLanguage: 'zh' | 'en';
}
export interface FakeIntentHint {
  task: 'intent';
  note: string;
  n: number;
  notesLanguage: 'zh' | 'en';
}
export interface FakeReplanHint {
  task: 'replan';
  downstream: Array<{ id: string; text: string }>;
  remaining: Array<{ intent: string; factIds: string[]; move: string | null }>;
}
export type FakeHint = FakeGhostHint | FakeInstructHint | FakeAlternativesHint | FakeGrammarHint | FakeIntentHint | FakeReplanHint;

/** A scripted reply: JSON object (serialized as the text) or raw text. Return undefined to use the default. */
export type FakeOutput = { json: unknown } | { text: string };
export type FakeResponder = (req: LlmRequest, attempt: number) => FakeOutput | undefined;

/* ------------------------------------------------------------------------------------ */
/* Deterministic text helpers                                                            */
/* ------------------------------------------------------------------------------------ */

const CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/g;

/** Words of a plan intent, safe for paper text: no digits, CJK, brackets or LaTeX. */
function safeWords(s: string, max: number): string[] {
  return s
    .replace(CJK, ' ')
    .replace(/\\[a-zA-Z]+(\{[^}]*\})?/g, ' ')
    .replace(/[0-9]+/g, ' ')
    .replace(/[^A-Za-z\s'-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, max);
}

/** Small, LaTeX-safe edits the fake applies as its "rewrite": plain-word swaps and spacing only. */
export function tidySentence(s: string): string {
  return s
    .replace(/\butiliz(e|es|ed|ing)\b/g, (_m, e: string) => ({ e: 'use', es: 'uses', ed: 'used', ing: 'using' })[e] ?? 'use')
    .replace(/\bin order to\b/g, 'to')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.;:])/g, '$1')
    .trim();
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

function fakeGhost(h: FakeGhostHint): unknown {
  const prefix = h.prefix ?? '';
  const prefixWords = wordCount(prefix);
  const budget = Math.max(3, 28 - prefixWords);
  const intent = safeWords(h.step?.intent ?? '', budget);
  const words = intent.length > 0 ? intent : ['continues', 'the', 'argument', 'of', 'this', 'paragraph'];
  const fact = h.step ? h.facts.find((f) => h.step!.factIds.includes(f.id)) : undefined;
  let body: string;
  if (prefix.trim().length === 0) {
    const ws = words[0]!.toLowerCase() === 'we' && words.length > 1 ? words.slice(1) : words;
    body = `We ${ws[0]!.toLowerCase()} ${ws.slice(1).join(' ')}`.trim();
  } else if (/[.!?]\s*$/.test(prefix)) {
    return { text: prefix, fact_ids: [], cite_keys: [], fulfilled_move_ids: [] };
  } else {
    // The prefix stays verbatim (including a trailing space the author typed).
    body = `${prefix}${/\s$/.test(prefix) ? '' : ' '}relates to ${words.join(' ').toLowerCase()}`;
  }
  const text = `${body}${fact ? ` (${fact.rendering})` : ''}.`;
  return {
    text,
    fact_ids: fact ? [fact.id] : [],
    cite_keys: [],
    fulfilled_move_ids: h.step ? [h.step.id] : [],
  };
}

function note(lang: 'zh' | 'en', zh: string, en: string): string {
  return lang === 'zh' ? zh : en;
}

const ALT_OPENERS = ['', 'In short, ', 'Here, '];
const LOWERABLE = /^(We|The|This|These|Our|In|A|An|It|For|At|With|Each)\b/;

function fakeFor(hint: FakeHint): unknown {
  switch (hint.task) {
    case 'ghost':
      return fakeGhost(hint);
    case 'instruct':
      return {
        text: tidySentence(hint.sentence),
        notes: note(hint.notesLanguage, `模拟模式（未调用模型）：已收到指令“${hint.instruction}”，句子只做了措辞整理。`, `Simulated mode (no model call): received the instruction "${hint.instruction}"; only wording was tidied.`),
        drift: { actor: false, scope: false, direction: false, condition: false },
        fact_ids: [...hint.factIds],
        cite_keys: [...hint.citeKeys],
      };
    case 'alternatives': {
      const n = Math.max(1, Math.min(ALT_OPENERS.length, Math.floor(hint.n)));
      const base = tidySentence(hint.sentence);
      const alternatives = ALT_OPENERS.slice(0, n).map((op, i) => {
        const text = op && LOWERABLE.test(base) ? op + base.charAt(0).toLowerCase() + base.slice(1) : op + base;
        return { text, note: note(hint.notesLanguage, `模拟备选 ${i + 1}`, `Simulated alternative ${i + 1}`) };
      });
      return { alternatives };
    }
    case 'grammar': {
      const text = tidySentence(hint.sentence);
      const changes = text === hint.sentence.trim() ? [] : [note(hint.notesLanguage, '整理空格与标点（模拟）', 'tidied spacing and punctuation (simulated)')];
      return { text, changes };
    }
    case 'intent': {
      const n = Math.max(1, Math.min(3, Math.floor(hint.n)));
      return {
        proposals: Array.from({ length: n }, (_v, i) => ({
          text: `This sentence states the point of the author's note [claim: rendering of the intent note${n > 1 ? `, option ${i + 1}` : ''}?].`,
          fact_ids: [],
          cite_keys: [],
          note: note(hint.notesLanguage, '模拟模式：未调用模型，无法转写意图，请自行填写。', 'Simulated mode: no model call, the note was not rendered; please write it.'),
        })),
      };
    }
    case 'replan':
      return {
        items: hint.downstream.map((d) => ({ sentence_id: d.id, action: 'keep', text: null, reason: 'simulated re-plan: no change' })),
        remaining: hint.remaining.map((r) => ({ intent: r.intent, fact_ids: [...r.factIds], move: r.move })),
        paragraph_complete: false,
        next_opener: null,
      };
    default:
      return null;
  }
}

/**
 * A minimal value valid against a structured-output JSON schema: objects get every required property,
 * strings '', numbers 0, booleans false, arrays [], enums their first value, anyOf its null branch if any.
 */
export function fakeFromSchema(schema: unknown, depth = 0): unknown {
  if (!schema || typeof schema !== 'object' || depth > 12) return null;
  const s = schema as Record<string, unknown>;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  if ('const' in s) return s.const;
  const anyOf = (s.anyOf ?? s.oneOf) as unknown[] | undefined;
  if (Array.isArray(anyOf) && anyOf.length > 0) {
    const nul = anyOf.find((x) => x && typeof x === 'object' && (x as { type?: unknown }).type === 'null');
    return nul ? null : fakeFromSchema(anyOf[0], depth + 1);
  }
  const type = Array.isArray(s.type) ? (s.type.includes('null') ? 'null' : s.type[0]) : s.type;
  switch (type) {
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(props)) out[k] = fakeFromSchema(props[k], depth + 1);
      return out;
    }
    case 'array':
      return [];
    case 'string':
      return '';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------------------------ */
/* Client                                                                                */
/* ------------------------------------------------------------------------------------ */

/** First match of <tag>...</tag> or a "Label: ..." line in the tail. */
function tailField(tail: string, tags: string[], labels: string[]): string | null {
  for (const t of tags) {
    const m = new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`, 'i').exec(tail);
    if (m) return m[1]!.trim();
  }
  for (const l of labels) {
    const m = new RegExp(`^\\s*${l}\\s*:\\s*(.*)$`, 'im').exec(tail);
    if (m) return m[1]!.trim().replace(/^["“]|["”]$/g, '');
  }
  return null;
}

/**
 * Fallback when a request carries no fakeHint: recover the typed prefix / the sentence from the tail
 * text (XML-ish tags or "Label:" lines), so the fake still answers on topic.
 */
export function hintFromTail(req: LlmRequest): FakeHint | null {
  const tail = req.messages.map((m) => m.content).join('\n');
  switch (req.task) {
    case 'ghost': {
      const prefix = tailField(tail, ['prefix', 'typed', 'sentence_so_far'], ['Prefix', 'Typed so far', 'Sentence so far']);
      return { task: 'ghost', prefix: prefix ?? '', step: null, facts: [] };
    }
    case 'instruct':
    case 'alternatives':
    case 'grammar': {
      const sentence = tailField(tail, ['sentence', 'original'], ['Sentence', 'Original']);
      if (!sentence) return null;
      if (req.task === 'instruct') return { task: 'instruct', sentence, instruction: tailField(tail, ['instruction'], ['Instruction']) ?? '', notesLanguage: 'zh', factIds: [], citeKeys: [] };
      if (req.task === 'alternatives') return { task: 'alternatives', sentence, n: 3, notesLanguage: 'zh' };
      return { task: 'grammar', sentence, notesLanguage: 'zh' };
    }
    case 'intent': {
      const note = tailField(tail, ['intent_note', 'intent', 'note'], ['Intent note', 'Note']);
      return note ? { task: 'intent', note, n: 1, notesLanguage: 'zh' } : null;
    }
    default:
      return null;
  }
}

function isHint(x: unknown): x is FakeHint {
  return !!x && typeof x === 'object' && typeof (x as { task?: unknown }).task === 'string';
}

function approxTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}

export interface FakeClientOptions {
  latencyMs?: number;
  respond?: FakeResponder;
}

export function createFakeLlmClient(opts: FakeClientOptions = {}): LlmClient & { calls: LlmRequest[] } {
  let seq = 0;
  const calls: LlmRequest[] = [];
  const attempts = new Map<string, number>();
  const latency = Math.max(0, opts.latencyMs ?? 0);

  const wait = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      if (ms <= 0) return queueMicrotask(resolve);
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });

  return {
    fake: true,
    calls,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      calls.push(req);
      const t0 = performance.now();
      const key = `${req.route}:${req.task}`;
      const attempt = attempts.get(key) ?? 0;
      attempts.set(key, attempt + 1);
      await wait(latency, req.signal);
      if (req.signal?.aborted) throw abortError();
      const scripted = opts.respond?.(req, attempt);
      let text: string;
      let json: unknown = null;
      if (scripted && 'text' in scripted) {
        text = scripted.text;
        if (req.schema) {
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
        }
      } else {
        const hint = isHint(req.fakeHint) ? req.fakeHint : hintFromTail(req);
        const value = scripted && 'json' in scripted ? scripted.json : hint ? fakeFor(hint) : req.schema ? fakeFromSchema(req.schema) : null;
        if (req.schema) {
          json = value ?? fakeFromSchema(req.schema);
          text = JSON.stringify(json);
        } else {
          text = typeof value === 'string' ? value : value == null ? 'Simulated response.' : JSON.stringify(value);
        }
      }
      const inChars = req.system.reduce((n, b) => n + b.text.length, 0) + req.messages.reduce((n, m) => n + m.content.length, 0);
      const ms = Math.round(performance.now() - t0);
      return {
        text,
        json,
        model: `fake-${req.model}`,
        usage: { input_tokens: approxTokens(inChars), output_tokens: approxTokens(text.length), cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        stopReason: 'end_turn',
        requestId: `fake-req-${++seq}`,
        ms,
        ttftMs: ms,
        costUsd: 0,
      };
    },
    async prewarm() {
      return null;
    },
  };
}

function abortError(): Error {
  const e = new Error('request aborted');
  e.name = 'LlmAbortError';
  return e;
}
