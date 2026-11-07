/**
 * Deterministic fake LLM client (Ctx.fakeLlm: no API key, PAPER_FAKE_LLM=1, and every test).
 *
 * Output is schema-valid and built from `req.fakeHint` (set by the LLM service for each task; see
 * FakeHint), falling back to a minimal schema-valid object for tasks without a hint. It never invents a
 * number: the only numerals it writes are renderings of facts the service passed in the hint. Results
 * are labelled with model `fake-<model>` and cost nothing. Latency simulation is off unless
 * `latencyMs` > 0 (the server may set PAPER_FAKE_LATENCY_MS for UI work).
 */
import { readFileSync } from 'node:fs';
import { renderFact, simulatedRewrite, type Fact } from '@paper-copilot/core';
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
  /** Labels of the project (fig:..., tab:...) a simulated sentence may point to; the gate checks \\ref targets. */
  refs?: string[];
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

/** Finite verbs and auxiliaries that tell a clause ("We train on generic events") from a bare noun phrase ("The gain"). */
const VERBISH = /\b(is|are|was|were|be|been|being|has|have|had|do|does|did|can|could|will|would|may|might|must|shall|should|finds?|shows?|gives?|holds?|uses?|trains?|stud(?:y|ies)|compares?|reach(?:es)?|keeps?|loses?|starts?|looks?|describes?|combines?|match(?:es)?|measures?|improves?|reduces?|increases?|exceeds?|remains?|yields?|provides?|reports?|tests?|evaluates?|lies|lie|depends?|follows?|leads?|[a-z]{3,}ed)\b/i;

/** A prefix ending in a copula wants a complement ("The gain is" -> "... 2.32 points."). */
const COPULA = new Set(['is', 'are', 'was', 'were', 'be', 'been', 'remains', 'remain', 'becomes', 'become']);
/** Prepositions, articles and transitive verbs that also want a complement. */
const OPEN_END = new Set(['the', 'a', 'an', 'of', 'by', 'with', 'than', 'to', 'in', 'on', 'at', 'for', 'from', 'about', 'finds', 'find', 'gives', 'give', 'shows', 'show', 'reaches', 'reach', 'yields', 'yield', 'reports', 'report']);

/** `Fig.~\\ref{fig:x}` / `Table~\\ref{tab:x}` for the first figure or table label the project defines. */
function refPhrase(refs: readonly string[] | undefined): string | null {
  const fig = refs?.find((r) => /^fig:/i.test(r));
  if (fig) return `Fig.~\\ref{${fig}}`;
  const tab = refs?.find((r) => /^tab:/i.test(r));
  if (tab) return `Table~\\ref{${tab}}`;
  return null;
}

/**
 * The simulated ghost: grammatical, deterministic and built only from the paragraph plan, the facts the
 * service allowed (step facts only) and labels that exist in the project, so it always passes the gate.
 *   prefix "The gain"                 -> "The gain is shown in Fig.~\\ref{fig:eff}." (or "is <fact>" when the plan step names one)
 *   prefix "We train on generic events" -> "We train on generic events (see Fig.~\\ref{fig:eff})."
 *   empty prefix                       -> "The next point of this paragraph is <plan intent>."
 * Returns the WHOLE sentence (prefix verbatim + continuation), like the real model.
 */
function fakeGhost(h: FakeGhostHint): unknown {
  const prefix = h.prefix ?? '';
  const fact = h.step ? h.facts.find((f) => h.step!.factIds.includes(f.id)) : undefined;
  const ref = refPhrase(h.refs);
  const factIds = fact ? [fact.id] : [];
  const fulfilled = h.step ? [h.step.id] : [];
  if (/[.!?]\s*$/.test(prefix)) return { text: prefix, fact_ids: [], cite_keys: [], fulfilled_move_ids: [] };
  let text: string;
  if (prefix.trim().length === 0) {
    const topic = safeWords(h.step?.intent ?? '', 16).join(' ').toLowerCase();
    text = `The next point of this paragraph is ${topic || 'the claim it still owes'}${fact ? ` (${fact.rendering})` : ''}${ref ? `; see ${ref}` : ''}.`;
  } else {
    const sep = /\s$/.test(prefix) ? '' : ' ';
    const last = (/([A-Za-z]+)[\s~]*$/.exec(prefix)?.[1] ?? '').toLowerCase();
    let cont: string;
    if (COPULA.has(last)) cont = fact ? `${fact.rendering}${ref ? ` (see ${ref})` : ''}` : ref ? `shown in ${ref}` : 'discussed below';
    else if (OPEN_END.has(last)) cont = fact ? `${fact.rendering}${ref ? ` (see ${ref})` : ''}` : ref ? `the result shown in ${ref}` : 'the result discussed below';
    else if (VERBISH.test(prefix)) cont = fact ? `(${fact.rendering}${ref ? `; see ${ref}` : ''})` : ref ? `(see ${ref})` : 'as discussed below';
    else cont = fact ? `is ${fact.rendering}${ref ? ` (see ${ref})` : ''}` : ref ? `is shown in ${ref}` : 'is discussed below';
    text = `${prefix}${sep}${cont}.`; // the prefix stays verbatim (trailing space included)
  }
  return { text, fact_ids: factIds, cite_keys: [], fulfilled_move_ids: fulfilled };
}

/* ------------------------------------------------------------------------------------ */
/* Simulated drafter text                                                                */
/* ------------------------------------------------------------------------------------ */

export interface FakeDraftStep {
  intent: string;
  move: string | null;
  /** Facts the step may state: id, LaTeX-safe rendering (a fact alias) and the fact's definition. */
  facts: Array<{ id: string; rendering: string; definition: string }>;
  /** Cite keys the step may use (already restricted to resolved keys). */
  citeKeys: string[];
}

export interface FakeDraftInput {
  job: string;
  sectionTitle: string;
  moves: string[];
  steps: FakeDraftStep[];
}

export interface FakeDraftSentence {
  text: string;
  move: string | null;
  factIds: string[];
  citeKeys: string[];
}

/** Words a plan sentence starts with that are instructions to the writer, not part of the topic. */
const PLAN_LEADS = new Set(
  'show shows explain explains state states give gives introduce introduces describe describes motivate motivates present presents compare compares report reports argue argues establish establishes say tell list define defines summarize summarise summarizes discuss discusses note mention quote claim claims demonstrate demonstrates point make set put lay highlight emphasize stress conclude recall review why how what that which we our us it its this these those here there then also now first next finally briefly clearly to'.split(
    ' ',
  ),
);
const ARTICLES = new Set(['the', 'a', 'an']);
/** Words a noun phrase must not end with. */
const DANGLING = new Set('of the a an and or to for with in on at by from than over against as into versus vs is are was were be that which'.split(' '));

/**
 * A short noun phrase naming the topic of a plan sentence, never the sentence itself:
 * "Show the efficiency gain of the GNN over the baseline" -> "efficiency gain of the GNN".
 * Digits, CJK and LaTeX are dropped (numbers come only from facts); empty when nothing usable is left.
 */
export function topicPhrase(raw: string, maxWords = 6): string {
  const words = safeWords(raw ?? '', 40);
  let i = 0;
  while (i < words.length && (PLAN_LEADS.has(words[i]!.toLowerCase()) || ARTICLES.has(words[i]!.toLowerCase()))) i++;
  const out: string[] = [];
  for (let k = i; k < words.length && out.length < maxWords; k++) {
    const w = words[k]!;
    // stop at the clause's verb: the topic is the noun phrase before it
    if (out.length > 0 && VERBISH.test(w) && !/^[A-Z]/.test(w)) break;
    if (/^(?:and|but|so|because|while|whereas|which|that)$/i.test(w) && out.length > 0) break;
    out.push(w);
  }
  while (out.length && DANGLING.has(out[out.length - 1]!.toLowerCase())) out.pop();
  if (out.length && /^[A-Z][a-z]+$/.test(out[0]!) && !/^[A-Z][a-z]+[A-Z]/.test(out[0]!)) out[0] = out[0]!.toLowerCase();
  return out.join(' ');
}

/**
 * The alias a paper would print for a numeric fact: the prose form core renderFact chooses ("96.94%" for
 * the efficiency 0.9694, "2.32 ± 0.28 points"), when it is one of the fact's aliases (the gate matches
 * aliases); else the first alias. Plain text: callers make it LaTeX-safe.
 */
export function preferredAlias(f: Fact): string | null {
  if (f.kind !== 'number' || typeof f.value !== 'number') return null;
  const aliases = f.aliases.map((a) => a.trim()).filter((a) => a.length > 0);
  if (!aliases.length) return null;
  let prose: string | null = null;
  try {
    const m = /=\s*(.*?)(?:\s+\(([^()]*)\))?\s*$/.exec(renderFact(f));
    prose = m ? (m[2] ?? m[1] ?? null) : null;
  } catch {
    prose = null;
  }
  return prose && aliases.includes(prose.trim()) ? prose.trim() : aliases[0]!;
}

const STEP_OPENERS = ['We then discuss the ', 'Next we consider the ', 'We also examine the '];

function withCites(body: string, keys: readonly string[]): string {
  return keys.length ? `${body}~\\cite{${keys.join(',')}}` : body;
}

/**
 * The simulated drafter's sentences for one paragraph: an opening sentence that names the paragraph's
 * topic (built from the job, never a copy of it), then one sentence per remaining plan step. Numbers are
 * only the facts' own renderings (aliases), cite keys only the resolved keys the step names, so every
 * sentence passes the faithfulness gate. Deterministic: same plan, same text.
 */
export function fakeDraftSentences(input: FakeDraftInput): FakeDraftSentence[] {
  const out: FakeDraftSentence[] = [];
  const jobTopic = topicPhrase(input.job) || topicPhrase(input.sectionTitle);
  out.push({
    text: jobTopic ? `We now turn to the ${jobTopic}.` : 'We now turn to the next point of this section.',
    move: input.moves[0] ?? null,
    factIds: [],
    citeKeys: [],
  });
  input.steps.forEach((step, k) => {
    const topic = topicPhrase(step.intent) || (step.facts[0] ? topicPhrase(step.facts[0].definition) : '') || jobTopic;
    const facts = step.facts.filter((f) => f.rendering.trim().length > 0).slice(0, 3);
    let body: string;
    if (facts.length === 0) {
      body = `${STEP_OPENERS[k % STEP_OPENERS.length]}${topic || 'remaining point of this paragraph'}`;
    } else {
      const r = facts.map((f) => f.rendering);
      const stated = r.length === 1 ? r[0]! : r.length === 2 ? `${r[0]}, compared with ${r[1]}` : `${r.slice(0, -1).join(', ')} and ${r[r.length - 1]}`;
      body = topic ? `For the ${topic}, we find ${stated}` : `We find ${stated}`;
    }
    out.push({ text: `${withCites(body, step.citeKeys)}.`, move: step.move, factIds: facts.map((f) => f.id), citeKeys: [...step.citeKeys] });
  });
  return out;
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
    case 'instruct': {
      // A fixed, keyword-chosen, LaTeX-safe edit (core simulatedRewrite), never a model's reading of the instruction.
      const r = simulatedRewrite(hint.sentence, hint.instruction);
      const text = tidySentence(r.text);
      const what =
        r.text !== hint.sentence
          ? note(hint.notesLanguage, r.zh, r.en)
          : text !== hint.sentence.trim()
            ? note(hint.notesLanguage, '只做了措辞整理', 'only wording was tidied')
            : note(hint.notesLanguage, '模拟改写找不到可改之处，句子没有改动', 'the simulated rewrite found nothing to change; the sentence is unchanged');
      return {
        text,
        notes: note(hint.notesLanguage, `模拟模式（未调用模型）：已收到指令“${hint.instruction}”；${what}。`, `Simulated mode (no model call): received the instruction "${hint.instruction}"; ${what}.`),
        drift: { actor: false, scope: false, direction: false, condition: false },
        fact_ids: [...hint.factIds],
        cite_keys: [...hint.citeKeys],
      };
    }
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

/**
 * Scripted replies from a JSON file (PAPER_FAKE_SCRIPT, simulated AI only; the full-stack e2e uses it to
 * make the simulated AI say one specific thing, e.g. a derived "2.5 times" the gate must accept):
 *   { "rules": [ { "task": "instruct", "match": "<substring>", "json": { ... } } | { ..., "text": "..." } ] }
 * The first rule whose `task` (if given) equals the request's task and whose `match` (if given) occurs in
 * the request's instruction / note / prefix or a message wins. The file is re-read on every call, so a
 * running server picks up a new script; a missing or malformed file scripts nothing (the default
 * simulated output). The output still goes through every gate like any model output.
 */
export function fileScriptResponder(path: string): FakeResponder {
  return (req) => {
    let rules: unknown;
    try {
      rules = (JSON.parse(readFileSync(path, 'utf8')) as { rules?: unknown }).rules;
    } catch {
      return undefined;
    }
    if (!Array.isArray(rules)) return undefined;
    const hint = (req.fakeHint && typeof req.fakeHint === 'object' ? req.fakeHint : {}) as Record<string, unknown>;
    const hay = [hint.instruction, hint.note, hint.prefix, hint.sentence, ...req.messages.map((m) => m.content)].filter((x): x is string => typeof x === 'string');
    for (const r of rules as Array<Record<string, unknown>>) {
      if (!r || typeof r !== 'object') continue;
      if (typeof r.task === 'string' && r.task !== req.task) continue;
      if (typeof r.match === 'string' && !hay.some((h) => h.includes(r.match as string))) continue;
      if ('json' in r) return { json: r.json };
      if (typeof r.text === 'string') return { text: r.text };
    }
    return undefined;
  };
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
