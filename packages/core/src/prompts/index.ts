/**
 * Prompt assembly. Pure functions: the server reads files (SKILL.md, references, briefs) and passes
 * their text in. Every LLM route uses the same layout so that prompt caching works
 * (docs/design.md, "Skill and voice system", Prompt layout):
 *
 *   system[0] = role + task rules + BLOCK A [SKILL.md + routed references (wrapped as fictional
 *               examples) + voice memo + author norms]                cache_control ttl 1h
 *   system[1] = BLOCK B [repo brief + literature brief + frozen outline (five items + section jobs;
 *               NOT the live paragraph plan) + terminology + allowed cite keys + fact table]
 *                                                                     cache_control ttl 5m
 *   system[2] = BLOCK C [author exemplars for this section type]      cache_control ttl 5m (omitted if none)
 *   user      = the volatile tail for this request (live plan, context, prefix, instruction...).
 *
 * Byte-stability matters: the same inputs must produce byte-identical blocks (sorted keys, fixed
 * ordering, no timestamps), or the cache misses.
 *
 * OWNER: core-prompts agent.
 */
import { z } from 'zod';
import type { EditPair, Fact, GhostMode, Outline, OutlineParagraph, OutlineSection, ParagraphPlan, PlanStep, TermEntry } from '../schemas';
import { hashString } from '../text/hash';
import { stableStringify } from '../util';
import { cleanSentence, fictionalNumbers } from './fictional';
import { toStrictJsonSchema } from './jsonschema';
import { exemplarList, renderCiteKeys, renderFactTable, renderFrozenOutline, renderPlan, renderPlanStep, renderTerminology } from './render';
import { roleText, taskRules } from './rules';
import { block, clampInt, clean, cmp, inline, joinParts, langName, normText, notesLang, oneLine, uniq } from './xml';

export type TaskKind =
  | 'ghost'
  | 'intent'
  | 'instruct'
  | 'alternatives'
  | 'grammar'
  | 'replan'
  | 'draft'
  | 'repo_reader'
  | 'lit_reader'
  | 'framings'
  | 'referee'
  | 'memo';

/** Every task kind, in a fixed order (for iteration in servers and tests). */
export const TASK_KINDS: readonly TaskKind[] = ['ghost', 'intent', 'instruct', 'alternatives', 'grammar', 'replan', 'draft', 'repo_reader', 'lit_reader', 'framings', 'referee', 'memo'];

export interface PromptBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral'; ttl?: '5m' | '1h' };
}

export interface SkillBundle {
  dir: string;
  /** SKILL.md text. */
  skillMd: string;
  /** reference file name (e.g. 'sentences-and-words.md') -> text. */
  references: Record<string, string>;
  /** Content hash (or git revision) of the skill, logged with every prompt. */
  version: string;
}

const STORY = 'story-and-structure.md';
const FLOW = 'layering-and-flow.md';
const SENT = 'sentences-and-words.md';
const FIG = 'figures-and-evidence.md';

/** At most this many reference files per request (the skill: "read only the one or two references the task needs"). */
export const MAX_REFERENCES = 2;

/**
 * Which reference files each task loads, following the skill's own routing table ("Bundled resources"):
 * title/abstract/intro/conclusions/outline -> story-and-structure.md; organizing a section, flow ->
 * layering-and-flow.md; polishing sentences -> sentences-and-words.md; figures, captions, results,
 * limitations -> figures-and-evidence.md. At most two per request. `draft` depends on the section
 * template: use `referencesFor('draft', template)`.
 */
export const ROUTING: Record<TaskKind, string[]> = {
  ghost: ['sentences-and-words.md'],
  intent: ['sentences-and-words.md'],
  instruct: ['sentences-and-words.md'],
  alternatives: ['sentences-and-words.md'],
  grammar: [],
  replan: ['layering-and-flow.md'],
  draft: ['layering-and-flow.md'],
  repo_reader: ['story-and-structure.md'],
  lit_reader: [],
  framings: ['story-and-structure.md'],
  referee: ['figures-and-evidence.md'],
  memo: [],
};

export type TemplateKind = 'abstract' | 'introduction' | 'section' | 'results' | 'conclusions' | 'caption';

/**
 * Normalize a section template or a corpus section type to the skill's template names
 * (abstract | introduction | section | results | conclusions | caption), or null when unknown/absent.
 */
export function normalizeTemplate(t: string | null | undefined): TemplateKind | null {
  const s = typeof t === 'string' ? t.trim().toLowerCase() : '';
  if (!s) return null;
  if (s === 'abstract') return 'abstract';
  if (s === 'intro' || s === 'introduction') return 'introduction';
  if (s === 'concl' || s === 'conclusion' || s === 'conclusions' || s === 'summary' || s === 'discussion') return 'conclusions';
  if (s === 'results' || s === 'result') return 'results';
  if (s === 'caption' || s === 'captions' || s === 'figure' || s === 'figures') return 'caption';
  if (['section', 'body', 'method', 'methods', 'setup', 'model', 'app', 'appendix', 'other', 'footnote'].includes(s)) return 'section';
  return null;
}

/** Reference files for a task, specialised by section template (abstract | introduction | section | results | conclusions | caption). */
export function referencesFor(task: TaskKind, template?: string | null): string[] {
  const t = normalizeTemplate(template);
  let refs: string[];
  switch (task) {
    case 'ghost':
      // Latency-critical (Haiku, every pause): one reference, plus the caption anatomy inside captions.
      refs = t === 'caption' ? [SENT, FIG] : [SENT];
      break;
    case 'intent':
    case 'instruct':
    case 'alternatives':
    case 'grammar':
    case 'replan':
      // Every request on the actions route gets the SAME references for a given template, so they all
      // share one cached block A (warmed once per section type). Captions and results also need the
      // caption anatomy and result rules; elsewhere the flow rules serve rewrites and re-planning.
      refs = t === 'caption' || t === 'results' ? [SENT, FIG] : [SENT, FLOW];
      break;
    case 'draft':
      refs =
        t === 'abstract'
          ? [STORY, SENT]
          : t === 'introduction'
            ? [STORY, FLOW]
            : t === 'conclusions'
              ? [STORY, FIG]
              : t === 'results'
                ? [FIG, FLOW]
                : t === 'caption'
                  ? [FIG]
                  : [FLOW];
      break;
    case 'referee':
      refs = t === 'abstract' || t === 'introduction' || t === 'conclusions' ? [FIG, STORY] : [FIG];
      break;
    default:
      refs = ROUTING[task] ?? [];
  }
  return refs.slice(0, MAX_REFERENCES);
}

export interface SystemInput {
  task: TaskKind;
  skill: SkillBundle;
  /** Override ROUTING (still at most two). */
  referenceKeys?: string[];
  /** Voice memo (CIPHER-style preferences), may be ''. */
  memo: string;
  /** Short rendered table: the author's measured norms next to the skill's corpus norms. */
  authorNorms: string;
  notesLanguage: 'zh' | 'en';
  repoBrief: string;
  litBrief: string;
  outline: Outline;
  terminology: TermEntry[];
  citeKeys: Array<{ key: string; title: string }>;
  facts: Fact[];
  /** Block C: the author's own sentences for this section type (omitted when empty). */
  exemplars: string[];
  sectionType: string;
}

/** Look a reference up by exact key, then by basename ("references/x.md" ~ "x.md"). */
function findReference(refs: Record<string, string>, name: string): { name: string; text: string } | null {
  if (!refs || typeof refs !== 'object') return null;
  const base = (k: string): string => k.replace(/\\/g, '/').split('/').pop() ?? k;
  if (typeof refs[name] === 'string') return { name: base(name), text: refs[name] };
  const want = base(name);
  const key = Object.keys(refs)
    .sort(cmp)
    .find((k) => base(k) === want);
  return key !== undefined && typeof refs[key] === 'string' ? { name: want, text: refs[key] } : null;
}

/** The reference files block A will carry for this input (resolved, deduplicated, at most two). */
export function resolvedReferenceNames(input: Pick<SystemInput, 'task' | 'skill' | 'referenceKeys' | 'sectionType'>): string[] {
  const wanted = uniq(Array.isArray(input.referenceKeys) ? input.referenceKeys : referencesFor(input.task, input.sectionType));
  const out: string[] = [];
  for (const k of wanted) {
    if (out.length >= MAX_REFERENCES) break;
    const r = findReference(input.skill?.references ?? {}, k);
    if (r && clean(r.text) && !out.includes(r.name)) out.push(r.name);
  }
  return out;
}

const or = (s: string, fallback: string): string => (clean(s) ? clean(s) : fallback);

/**
 * Build system blocks [A(+role), B, C?, task rules] with cache_control as described above (the task
 * rules come last and uncached, so all tasks of a route share block A). The role text states:
 * paper text is English; notes, questions and explanations go in `notesLanguage`; never invent
 * numbers, citations, results, cuts or causal explanations; write `[fact?: ...]`, `[ref]` or a
 * descriptive `[...?]` placeholder instead; keep \cite \ref \label, math and macros exactly; plain
 * verbs, verb by about word 5, one claim per sentence; avoid the AI-ese words listed by the linter; the
 * reference examples are fictional (wrapped in <reference fictional_examples="true" name="...">) and
 * their numbers must never appear in output.
 */
export function buildSystemBlocks(input: SystemInput): PromptBlock[] {
  const lang = notesLang(input.notesLanguage);
  const skill = input.skill ?? { dir: '', skillMd: '', references: {}, version: '' };

  // ---------------------------------------------------------------- block A (1 h)
  const refs = resolvedReferenceNames({ ...input, skill }).map((name) => {
    const r = findReference(skill.references, name);
    return block('reference', r ? r.text : '', { fictional_examples: 'true', name });
  });
  const memo = clean(input.memo);
  const norms = clean(input.authorNorms);
  const a = joinParts([
    roleText(lang),
    clean(skill.skillMd) ? block('skill', skill.skillMd, { name: 'hep-paper-writing', version: oneLine(skill.version) }) : '',
    ...refs,
    memo
      ? block(
          'voice_memo',
          `The author's writing preferences, learned from their own edits and kept editable by them. Where a preference differs from the skill, follow the preference: it describes this author.\n\n${memo}`,
        )
      : '',
    norms
      ? block(
          'author_norms',
          `Measured on the author's own unassisted writing, beside the skill's corpus norms. Where they differ, aim for the author's values.\n\n${norms}`,
        )
      : '',
  ]);

  // ---------------------------------------------------------------- block B (5 m)
  const b = block(
    'project_context',
    joinParts([
      'Context for this paper. It changes rarely; the live paragraph plan, the surrounding text and the request come in the user message.',
      block('repo_brief', or(input.repoBrief, '(not written yet)')),
      block('literature_brief', or(input.litBrief, '(not written yet)')),
      block('outline', renderFrozenOutline(input.outline)),
      block('terminology', renderTerminology(input.terminology)),
      block('allowed_cite_keys', renderCiteKeys(input.citeKeys)),
      block(
        'fact_table',
        `The only numbers, cuts and definitions paper text may state. Write a number as its rendering shows (or rounded to one significant figure fewer), and refer to a fact by its id in fact_ids.\n${renderFactTable(input.facts)}`,
      ),
    ]),
  );

  const blocks: PromptBlock[] = [
    { type: 'text', text: a, cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: b, cache_control: { type: 'ephemeral', ttl: '5m' } },
  ];

  // ---------------------------------------------------------------- block C (5 m, optional)
  const ex = exemplarList(input.exemplars, 1000);
  if (ex.length) {
    const st = oneLine(input.sectionType) || 'other';
    const c = block(
      'author_exemplars',
      joinParts([
        `Sentences the author wrote without AI help, for this kind of section (${st}). Match their sentence length, openings, verbs and connectors. They come from the author's other documents, so borrow their wording and shape, never their facts or numbers.`,
        ex.map((s) => inline('exemplar', s)).join('\n'),
      ]),
      { section_type: st },
    );
    blocks.push({ type: 'text', text: c, cache_control: { type: 'ephemeral', ttl: '5m' } });
  }
  // ---------------------------------------------------------------- task rules (uncached, small)
  // Kept out of block A so every task on a route reuses the same cached prefix; the few hundred
  // tokens of task rules after the last breakpoint cost almost nothing to send uncached.
  blocks.push({ type: 'text', text: taskRules(input.task, lang) });
  return blocks;
}

/** Deterministic fact table (sorted by id; excluded facts omitted): `id | rendering | kind | definition | validation`. */
export function factTable(facts: Fact[]): string {
  return renderFactTable(facts);
}

/** The five Step-0 items and section jobs/questions, without live plans (stable across sentence edits). */
export function frozenOutline(outline: Outline): string {
  return renderFrozenOutline(outline);
}

/** hashString of the stable serialization of system blocks + tail; logged with each version row. */
export function promptHash(system: PromptBlock[], tail: string): string {
  const sys = (Array.isArray(system) ? system : []).map((b) => ({
    type: b?.type ?? 'text',
    text: typeof b?.text === 'string' ? b.text : '',
    cache_control: b?.cache_control ? { type: b.cache_control.type, ttl: b.cache_control.ttl ?? null } : null,
  }));
  return hashString(stableStringify({ system: sys, tail: typeof tail === 'string' ? tail : '' }));
}

/**
 * Numbers that appear in the skill's invented Before/After examples (inside each rule's
 * "**Draft violation and fix.**" section, up to "**Boundaries.**") and in any line starting with
 * "Before" / "After" in the reference files. Only numerals with a decimal point or with 2+ digits.
 * The gate blocks them in AI output unless they are also real fact values.
 */
export function extractFictionalNumbers(references: Record<string, string>): string[] {
  return fictionalNumbers(references);
}

/** Strip wrappers a model may add around one sentence: surrounding quotes/backticks, "Sentence:" labels, markdown bullets. */
export function cleanModelSentence(text: string): string {
  return cleanSentence(text);
}

/* ------------------------------------------------------------------------------------ */
/* Volatile tails (user message text)                                                    */
/* ------------------------------------------------------------------------------------ */

/** Default ghost word limit (the gate's GHOST_MAX_WORDS). */
const GHOST_WORDS = 35;

const MODE_TEXT: Record<GhostMode, string> = {
  'complete-my-sentence': 'The author owns the subject and the verb in this section: continue the sentence they started and finish their thought.',
  'auto-propose': 'In this section you may propose whole sentences.',
  'questions-only': 'This section is questions-only: the author writes all prose here.',
};

const NUMBER_WORDS = ['zero', 'one', 'two', 'three'];
const count = (n: number): string => NUMBER_WORDS[n] ?? String(n);

export interface GhostTailInput {
  mode: GhostMode;
  sectionTitle: string;
  sectionType: string;
  paragraphJob: string;
  plan: ParagraphPlan | null;
  /** Up to two previous paragraphs (LaTeX). */
  previousParagraphs: string[];
  /** Current paragraph text before the cursor's sentence. */
  paragraphBefore: string;
  /** The sentence typed so far (the continuation must start with it verbatim). May be ''. */
  prefix: string;
  intentNote: string | null;
  /** Up to six of the author's sentences for this move/section (retrieved by BM25). */
  moveExemplars: string[];
  /** Fact ids the next sentence may use (paragraph plan first). */
  allowedFactIds: string[];
  maxWords: number;
}
export function ghostTail(i: GhostTailInput): string {
  const mode: GhostMode = i.mode && i.mode in MODE_TEXT ? i.mode : 'complete-my-sentence';
  const prefix = normText(i.prefix);
  const hasPrefix = prefix.trim() !== '';
  const maxWords = clampInt(i.maxWords, 1, 200, GHOST_WORDS);
  const ids = uniq(i.allowedFactIds);
  const prev = (Array.isArray(i.previousParagraphs) ? i.previousParagraphs : []).map(clean).filter(Boolean).slice(-2);
  const ex = exemplarList(i.moveExemplars, 6);
  const note = clean(i.intentNote);

  const request = block(
    'ghost_request',
    joinParts([
      block('section', `Title: ${oneLine(i.sectionTitle) || '(untitled)'}\nType: ${oneLine(i.sectionType) || 'other'}\nParagraph job: ${oneLine(i.paragraphJob) || '(not stated)'}`),
      block('paragraph_plan', renderPlan(i.plan)),
      prev.length ? block('previous_paragraphs', prev.map((p) => block('paragraph', p)).join('\n')) : '',
      block('paragraph_so_far', clean(i.paragraphBefore) || '(the next sentence opens the paragraph)'),
      note ? block('intent_note', `The author's note for this sentence; the sentence says what it says.\n${note}`) : '',
      ex.length ? block('author_sentences', ex.map((s) => inline('sentence', s)).join('\n')) : '',
      inline('allowed_fact_ids', ids.length ? ids.join(', ') : '(none: write [fact?: ...] for any number)'),
      inline('prefix', prefix),
    ]),
    { mode },
  );

  const rules: string[] = [];
  if (mode === 'questions-only') {
    rules.push('This section is questions-only, so write no new prose: return "text" equal to the prefix exactly, and empty lists.');
  } else {
    if (hasPrefix) {
      rules.push(MODE_TEXT[mode]);
      const ws = /\s$/.test(prefix) ? ' (it ends with a space, which stays)' : /[\p{L}\p{N}]$/u.test(prefix) ? ' (it does not end with a space: if it ends inside a word, finish that word; otherwise start the continuation with a space)' : '';
      rules.push(`- "text" is the whole sentence: the exact characters inside <prefix>${ws}, then your continuation. Keep the prefix as typed.`);
    } else if (mode === 'complete-my-sentence') {
      rules.push('The author has not started this sentence. Propose a plain sentence for the plan\'s next step, opening the way the author\'s sentences open, so the author can take it over.');
    } else {
      rules.push(`${MODE_TEXT[mode]} The prefix is empty: write the sentence that the plan's next step asks for, opening the way the author's sentences open.`);
    }
    rules.push(`- One sentence of at most ${maxWords} words, counting the prefix, ending with its final punctuation.`);
    rules.push(
      ids.length
        ? `- Numbers and definitions only from these facts: ${ids.join(', ')}, written as the fact table renders them. Anything else becomes [fact?: ...].`
        : '- No fact is available for this sentence: write [fact?: ...] wherever a number or cut would go.',
    );
    rules.push(note ? '- Say what the intent note says, and nothing it does not say.' : '- Follow the paragraph plan\'s next step.');
    if (ex.length) rules.push('- Prefer the wording of <author_sentences> to your own phrasing.');
    rules.push('- Cite only allowed keys; add no new notation.');
    rules.push('- "fulfilled_move_ids": the ids of the plan steps this sentence completes, or [].');
  }
  return joinParts([request, rules.join('\n')]);
}

export interface IntentTailInput {
  intentNote: string;
  sectionTitle: string;
  paragraphBefore: string;
  paragraphAfter: string;
  n: number;
  moveExemplars: string[];
  notesLanguage: 'zh' | 'en';
}
export function intentTail(i: IntentTailInput): string {
  const n = clampInt(i.n, 1, 3, 1);
  const ex = exemplarList(i.moveExemplars, 6);
  const request = block(
    'intent_request',
    joinParts([
      block('section', `Title: ${oneLine(i.sectionTitle) || '(untitled)'}`),
      block('paragraph_before', clean(i.paragraphBefore) || '(the sentence opens the paragraph)'),
      block('intent_note', clean(i.intentNote) || '(empty note)'),
      block('paragraph_after', clean(i.paragraphAfter) || '(nothing follows yet)'),
      ex.length ? block('author_sentences', ex.map((s) => inline('sentence', s)).join('\n')) : '',
    ]),
  );
  const rules = [
    `Render <intent_note> into ${n === 1 ? 'one English sentence' : `${count(n)} alternative English sentences`} that fit between <paragraph_before> and <paragraph_after>. Return exactly ${count(n)} ${n === 1 ? 'proposal' : 'proposals'}.`,
    '- Each proposal is one sentence that says what the note says, at its scope and certainty, and adds no claim, number, comparison or reason of its own.',
    '- A missing number, baseline or condition becomes a descriptive placeholder; a number the note states stays exactly as written.',
    ex.length ? '- Write it the way <author_sentences> are written.' : '',
    `- "note": in ${langName(i.notesLanguage)}, at most two short lines, or "" when there is nothing to say.`,
  ];
  return joinParts([request, rules.filter(Boolean).join('\n')]);
}

export interface InstructTailInput {
  sentence: string;
  instruction: string;
  /** Language of the instruction (notes come back in the notes language). */
  lang: string | null;
  before: string;
  after: string;
  notesLanguage: 'zh' | 'en';
}
export function instructTail(i: InstructTailInput): string {
  const lang = oneLine(i.lang);
  const request = block(
    'instruct_request',
    joinParts([
      block('before', clean(i.before) || '(start of paragraph)'),
      inline('sentence', clean(i.sentence)),
      block('after', clean(i.after) || '(end of paragraph)'),
      block('instruction', clean(i.instruction) || '(no instruction: make the sentence follow the style rules)', lang ? { lang } : undefined),
    ]),
  );
  const rules = [
    'Rewrite <sentence> following <instruction>, and change only what the instruction asks.',
    '- Keep every claim, number, unit, condition, \\cite, \\ref, \\label and math span of the original.',
    '- Fill "drift" by rereading your sentence against the original: actor, scope, direction, condition; true means it changed, and set it when unsure.',
    `- "notes": in ${langName(i.notesLanguage)}, one or two short lines on what changed and what to check.`,
  ];
  return joinParts([request, rules.join('\n')]);
}

export function alternativesTail(i: { sentence: string; n: number; before: string; after: string; notesLanguage: 'zh' | 'en' }): string {
  const n = clampInt(i.n, 1, 3, 3);
  const request = block(
    'alternatives_request',
    joinParts([
      block('before', clean(i.before) || '(start of paragraph)'),
      inline('sentence', clean(i.sentence)),
      block('after', clean(i.after) || '(end of paragraph)'),
    ]),
  );
  const rules = [
    `Write exactly ${count(n)} ${n === 1 ? 'alternative' : 'alternatives'} to <sentence>, each fitting between <before> and <after>.`,
    '- Same claims, numbers, units, conditions, citations and LaTeX as the original; different structure.',
    `- "note": in ${langName(i.notesLanguage)}, one short line on how this version differs.`,
  ];
  return joinParts([request, rules.join('\n')]);
}

/** Grammar-only: fix grammar, articles, agreement, spelling; change nothing else (no rephrasing). */
export function grammarTail(i: { sentence: string; notesLanguage: 'zh' | 'en' }): string {
  const rules = [
    'Correct the grammar of <sentence> with the smallest possible edit: articles, agreement, tense, prepositions, spelling and punctuation only.',
    '- Keep every other word, the word order and the LaTeX exactly as written; do not rephrase or improve the style.',
    '- If nothing needs fixing, return the sentence unchanged and "changes": [].',
    `- "changes": one short item per fix, in ${langName(i.notesLanguage)}.`,
  ];
  return joinParts([block('grammar_request', inline('sentence', clean(i.sentence))), rules.join('\n')]);
}

export interface ReplanTailInput {
  paragraphJob: string;
  sentencesSoFar: Array<{ id: string; text: string; state: string }>;
  remaining: PlanStep[];
  /** Downstream sentences still in state 'proposed' (the only ones the re-planner may revise). */
  downstreamProposed: Array<{ id: string; text: string }>;
  edited: { id: string; before: string; after: string } | null;
}
export function replanTail(i: ReplanTailInput): string {
  const sofar = (Array.isArray(i.sentencesSoFar) ? i.sentencesSoFar : []).filter((s) => s && typeof s.id === 'string');
  const down = (Array.isArray(i.downstreamProposed) ? i.downstreamProposed : []).filter((s) => s && typeof s.id === 'string');
  const rem = Array.isArray(i.remaining) ? i.remaining : [];
  const ids = uniq(down.map((s) => s.id));
  const request = block(
    'replan_request',
    joinParts([
      block('paragraph_job', oneLine(i.paragraphJob) || '(not stated)'),
      block(
        'sentences_so_far',
        sofar.length ? sofar.map((s) => inline('sentence', clean(s.text), { id: s.id, state: oneLine(s.state) || 'human' })).join('\n') : '(none yet)',
      ),
      i.edited
        ? block('latest_edit', `${inline('before', clean(i.edited.before))}\n${inline('after', clean(i.edited.after) || '(deleted or rejected)')}`, { sentence_id: i.edited.id })
        : '',
      block('remaining_plan', rem.length ? rem.map(renderPlanStep).join('\n') : '(nothing listed)'),
      block('downstream_proposed', down.length ? down.map((s) => inline('sentence', clean(s.text), { id: s.id })).join('\n') : '(none)'),
    ]),
  );
  const rules = [
    ids.length
      ? `Return one item for each downstream proposed sentence, using only these sentence ids: ${ids.join(', ')}. Every other sentence stays exactly as it is.`
      : 'There are no downstream proposed sentences, so "items" is []. Every sentence stays exactly as it is.',
    '- "keep" unless the latest edit made the sentence wrong, repetitive or out of order; "text" is null for keep and drop.',
    '- "remaining": 0 to 4 plain-word steps the paragraph still owes after these sentences, with fact ids.',
    '- "paragraph_complete": true when the job is done, with "next_opener" saying what the next paragraph opens with; otherwise "next_opener" is null.',
  ];
  return joinParts([request, rules.join('\n')]);
}

export interface DraftTaskInput {
  section: OutlineSection;
  paragraphs: OutlineParagraph[];
  fromNotes: boolean;
  notesLanguage: 'zh' | 'en';
  /** Existing text of the section (for continuity), LaTeX. */
  existing: string;
}

const TEMPLATE_HINT: Record<TemplateKind, string> = {
  abstract: 'Follow the skill\'s Abstract template: context, status quo by its mechanism, a short gap on However, the aim with one plain verb, the method in one line, the result with number and baseline, an optional implication.',
  introduction: 'Follow the skill\'s Introduction template: territory, status quo, gap (However, ...), enabler, "In this paper, we", roadmap; open each paragraph by picking up the end of the one before.',
  section: 'Open the section with its purpose or a bridge from what the reader has to what comes next; give the overview before the parts.',
  results: 'Follow the skill\'s Results paragraph template: the claim with number and baseline, then the figure pointer, regime by regime, then the mechanism.',
  conclusions: 'Follow the skill\'s Conclusions template: re-establish the problem, "We have ...", the headline number with the same baseline and condition as the abstract, further results in ladder order, the principal limitation, the implication.',
  caption: 'Follow the skill\'s caption anatomy: quantity versus variable as a noun phrase, conditions, encoding key, panel map, the point or a reading rule.',
};

/** Instructions for the drafter agent: call get_* tools, then propose_paragraph once per paragraph. */
export function draftTask(i: DraftTaskInput): string {
  const s = i.section;
  const lang = langName(i.notesLanguage);
  const tpl = normalizeTemplate(s?.template ?? null);
  const paras = (Array.isArray(i.paragraphs) ? i.paragraphs : []).filter((p) => p && typeof p.pid === 'string');
  const pids = paras.map((p) => p.pid);

  const paraBlocks = paras.map((p) => {
    const notes = uniq(p.intentNotes);
    const rem = Array.isArray(p.plan?.remaining) ? p.plan.remaining : [];
    const parts = [
      `Job: ${oneLine(p.job) || '(not stated)'}`,
      uniq(p.moves).length ? `Moves: ${uniq(p.moves).join(', ')}` : '',
      uniq(p.claimIds).length ? `Claims: ${uniq(p.claimIds).join(', ')}` : '',
      rem.length ? `Plan steps:\n${rem.map(renderPlanStep).join('\n')}` : 'Plan steps: (none yet)',
      notes.length ? `Author's notes, in order:\n${notes.map((n) => `- ${oneLine(n)}`).join('\n')}` : '',
    ];
    return block('paragraph', parts.filter(Boolean).join('\n'), { pid: p.pid });
  });

  const source = i.fromNotes
    ? 'Draft from the author\'s notes. Each paragraph\'s notes give its content, in order: render each note into the author\'s English and add no claim the notes and plan steps do not make. Where a note is unclear, keep its claim and ask in note_zh.'
    : 'Draft from the outline. Each paragraph\'s job and plan steps give its content; add no claim beyond them.';

  return joinParts([
    block(
      'draft_request',
      joinParts([
        block(
          'section',
          `Id: ${oneLine(s?.id) || '?'}\nTitle: ${oneLine(s?.title) || '(untitled)'}\nQuestion it answers: ${oneLine(s?.question) || '(not stated)'}\nTemplate: ${oneLine(s?.template) || 'section'}`,
        ),
        paraBlocks.length ? paraBlocks.join('\n') : '(no paragraphs requested)',
        block('existing_text', clean(i.existing) || '(the section is empty)'),
      ]),
    ),
    [
      'How to work:',
      '1. Read what you need with the editor tools: get_outline for the story and the neighbouring sections, get_plan for each paragraph, get_facts for the facts and their renderings, get_sentences for the text around the section, get_lit and lookup_cite for citable keys.',
      `2. Call propose_paragraph once per paragraph, in this order: ${pids.length ? pids.join(', ') : '(none)'}. Use each pid exactly as given; propose each paragraph whole, one sentence per item.`,
      '3. If propose_paragraph reports a gate failure, fix only the sentences it names and propose the same paragraph again.',
      '4. When every paragraph is proposed, end with one short line.',
      '',
      source,
      tpl ? TEMPLATE_HINT[tpl] : TEMPLATE_HINT.section,
      '- Open each paragraph with its job; keep cases in ladder order; state each result as number, baseline and condition.',
      '- Fit the existing text: reuse its terms and do not repeat what it already says.',
      '- Numbers only from get_facts, citations only from allowed keys; a missing piece becomes a descriptive placeholder, listed in "placeholders".',
      `- note_zh: in ${lang}, only when the author needs to know something (an assumption, a suggested mechanism to confirm), else null.`,
    ].join('\n'),
  ]);
}

/** Instructions for the read-only repo reader: summarize the project, return fact candidates as LOCATORS only. */
export function repoReaderTask(i: { globs: string[]; notesLanguage: 'zh' | 'en' }): string {
  const globs = uniq(i.globs);
  const lang = langName(i.notesLanguage);
  return joinParts([
    block('read_scope', globs.length ? `Read only files that match these globs, relative to the repository root:\n${globs.map((g) => `- ${g}`).join('\n')}` : 'Read the README, docs/, results/ and configs/ of the repository.'),
    [
      'Read the repository (README, docs, result files, configs, figure producers, decision logs) and return:',
      '- "brief_markdown": the repository brief, in English, at most about 6,000 tokens, with these sections: project summary; pipeline stages, in the repository\'s own names; samples and definitions; results, as tables whose cells name the artifact and locator (or proposed fact id) behind each value instead of the value; claims register (from docs/preregistration.md if present); figure inventory with exists or needs run; terminology; unknowns.',
      '- "fact_candidates": every number, cut, definition, sample, setting, figure or table the paper may state, each as {proposed_id, definition_paraphrase, artifact, locator, kind, condition}. "proposed_id" looks like f.<artifact stem>.<key>. "artifact" is the path relative to the repository root. "locator" is a JSON pointer ("#/delta_points"), a CSV cell ("csv:row=3;col=eff"), a YAML key ("yaml:cuts.pt_min") or "md:line=12". "definition_paraphrase" says what the number is, from the artifact\'s own metadata (sample, population, model, label, n, split). "condition" holds the selection, sample or working point the value depends on; for a number that appears only in README or docs prose, start it with "prose-only".',
      '- Leave every value out of fact_candidates and out of the brief\'s tables: the backend reads values from the artifacts at your locators.',
      '- "figures": each figure file or producer with its job in the story and whether it exists or needs a run.',
      '- "terminology": the analysis\'s own terms with one-line definitions.',
      `- "unknowns": in ${lang}, what you could not determine, one short item each (which file is authoritative, a missing baseline, an unclear selection).`,
    ].join('\n'),
  ]);
}

/** Instructions for the read-only literature reader (lit_reader): resolve keys and collect verbatim quotes. */
export function litReaderTask(i: { keys: Array<{ key: string; title: string }>; notesLanguage: 'zh' | 'en' }): string {
  return joinParts([
    block('bibliography', renderCiteKeys(i.keys)),
    [
      'Resolve each key with the literature tools and return one record per key you could resolve: its INSPIRE texkey, recid and arXiv id when the tools give them, the title and abstract as returned, and "quotable": verbatim quotes that could support a sentence of this paper, each with the claim it supports and its locator.',
      '- Put every key you could not match with confidence in "unresolved".',
      `- "usable_for": in ${langName(i.notesLanguage)}, what this paper could cite the record for, one short item each.`,
    ].join('\n'),
  ]);
}

/** Three alternative framings of the paper, AFTER the author filled the five items. */
export function framingsTask(i: { outline: Outline; notesLanguage: 'zh' | 'en' }): string {
  const filled = !!i.outline?.authorFilled;
  return joinParts([
    block('author_items', renderFrozenOutline(i.outline)),
    [
      filled ? '' : 'The author has not marked the five items as complete; build only on what is written, and use placeholders for the rest.',
      'Propose exactly three framings of this paper\'s one-sentence story, each built from the author\'s items above.',
      '- Each framing leads with something different: the method, the physics reach, or the contrast with the standard approach.',
      '- Use the author\'s key phrase, facts and baseline; write a placeholder for any missing piece.',
      `- "why": in ${langName(i.notesLanguage)}, what the framing emphasizes and which reader it serves.`,
    ]
      .filter(Boolean)
      .join('\n'),
  ]);
}

/** At most four referee questions for a section, most important first, in the notes language. */
export function refereeTask(i: { sectionTitle: string; sectionText: string; notesLanguage: 'zh' | 'en' }): string {
  return joinParts([
    block('section', `${inline('title', oneLine(i.sectionTitle) || '(untitled)')}\n${block('text', clean(i.sectionText) || '(empty section)')}`),
    [
      'Read this section as a referee and return at most four questions, the most important first.',
      `- Write questions and estimates in ${langName(i.notesLanguage)}; keep each question to one or two sentences.`,
      '- "sentence_hint": a few words copied verbatim from the sentence the question is about, or null.',
      '- "estimate": a quick estimate that settles the point, with its assumption, or null. Estimates stay in the notes, never in the paper.',
    ].join('\n'),
  ]);
}

/** Short stable id of an edit pair, as the memo cites it ("e" + 6 hex chars). */
export function pairId(p: Pick<EditPair, 'sentenceId' | 'ts' | 'aiText' | 'humanText'>): string {
  return 'e' + hashString(`${p.sentenceId}|${p.ts}|${p.aiText}|${p.humanText}`).slice(-6);
}

/** Pairs the memo may learn from: not grammar-only, and the author actually changed the text. Sorted by time. */
export function learnablePairs(pairs: EditPair[]): EditPair[] {
  return (Array.isArray(pairs) ? pairs : [])
    .filter((p) => !!p && !p.grammarOnly && typeof p.aiText === 'string' && typeof p.humanText === 'string' && clean(p.aiText) !== clean(p.humanText))
    .slice()
    .sort((a, b) => cmp(String(a.ts), String(b.ts)) || cmp(String(a.sentenceId), String(b.sentenceId)) || cmp(pairId(a), pairId(b)));
}

/** Update the CIPHER-style voice memo (<= 400 words) from new (AI text -> author text) pairs. */
export function memoTask(i: { currentMemo: string; pairs: EditPair[] }): string {
  const pairs = learnablePairs(i.pairs);
  const skipped = (Array.isArray(i.pairs) ? i.pairs : []).length - pairs.length;
  const pairText = pairs.map((p) => {
    const ed = typeof p.editDistance === 'number' && Number.isFinite(p.editDistance) ? p.editDistance.toFixed(2) : '';
    const body = [inline('ai_text', clean(p.aiText)), inline('author_text', clean(p.humanText)), p.instruction ? inline('instruction', clean(p.instruction)) : ''].filter(Boolean).join('\n');
    return block('pair', body, { id: pairId(p), section_type: oneLine(p.sectionType) || 'other', edit_distance: ed });
  });
  return joinParts([
    block('current_memo', clean(i.currentMemo) || '(empty: no preferences learned yet)'),
    block('edit_pairs', pairText.length ? pairText.join('\n') : '(none)'),
    [
      pairs.length
        ? `Update the memo from ${pairs.length === 1 ? 'this edit pair' : `these ${pairs.length} edit pairs`}: each shows a sentence the AI wrote and the author's version of it.`
        : 'There are no new pairs to learn from: return the current memo unchanged.',
      skipped > 0 ? `(${skipped} grammar-only or unchanged ${skipped === 1 ? 'pair was' : 'pairs were'} left out: a grammar fix shows the model's English, not the author's.)` : '',
      '- Return the whole memo as markdown bullets of plain preferences, at most 400 words.',
      '- End every bullet with its evidence count and up to three pair ids, e.g. "(3 pairs: e1a2b3c, e4d5e6f, e7a8b9c)".',
      '- A preference needs at least two supporting pairs to enter the memo; a single pair is noise.',
      '- Keep the current memo\'s bullets and wording unless the new pairs contradict them.',
    ]
      .filter(Boolean)
      .join('\n'),
  ]);
}

/* ------------------------------------------------------------------------------------ */
/* Structured outputs                                                                    */
/* ------------------------------------------------------------------------------------ */

export const GhostOutput = z.object({
  /** First property, so a truncated response still carries the sentence. */
  text: z.string(),
  fact_ids: z.array(z.string()),
  cite_keys: z.array(z.string()),
  fulfilled_move_ids: z.array(z.string()),
});
export type GhostOutput = z.infer<typeof GhostOutput>;

export const IntentOutput = z.object({
  proposals: z.array(z.object({ text: z.string(), fact_ids: z.array(z.string()), cite_keys: z.array(z.string()), note: z.string() })),
});
export type IntentOutput = z.infer<typeof IntentOutput>;

export const InstructOutput = z.object({
  text: z.string(),
  notes: z.string(),
  drift: z.object({ actor: z.boolean(), scope: z.boolean(), direction: z.boolean(), condition: z.boolean() }),
  fact_ids: z.array(z.string()),
  cite_keys: z.array(z.string()),
});
export type InstructOutput = z.infer<typeof InstructOutput>;

export const AlternativesOutput = z.object({
  alternatives: z.array(z.object({ text: z.string(), note: z.string() })),
});
export type AlternativesOutput = z.infer<typeof AlternativesOutput>;

export const GrammarOutput = z.object({ text: z.string(), changes: z.array(z.string()) });
export type GrammarOutput = z.infer<typeof GrammarOutput>;

export const ReplanOutput = z.object({
  items: z.array(z.object({ sentence_id: z.string(), action: z.enum(['keep', 'revise', 'drop', 'insert_before']), text: z.string().nullable(), reason: z.string() })),
  remaining: z.array(z.object({ intent: z.string(), fact_ids: z.array(z.string()), move: z.string().nullable() })),
  paragraph_complete: z.boolean(),
  next_opener: z.string().nullable(),
});
export type ReplanOutput = z.infer<typeof ReplanOutput>;

export const DraftParagraphOutput = z.object({
  pid: z.string(),
  sentences: z.array(
    z.object({
      text: z.string(),
      move: z.string().nullable(),
      fact_ids: z.array(z.string()),
      cite_keys: z.array(z.string()),
      placeholders: z.array(z.string()),
      note_zh: z.string().nullable(),
      referee_question: z.string().nullable(),
    }),
  ),
});
export type DraftParagraphOutput = z.infer<typeof DraftParagraphOutput>;

export const RepoBriefOutput = z.object({
  brief_markdown: z.string(),
  fact_candidates: z.array(
    z.object({
      proposed_id: z.string(),
      definition_paraphrase: z.string(),
      artifact: z.string(),
      locator: z.string(),
      kind: z.enum(['number', 'cut', 'definition', 'sample', 'setting', 'figure', 'table']),
      condition: z.string(),
    }),
  ),
  figures: z.array(z.object({ path: z.string(), job: z.string(), status: z.enum(['exists', 'needs_run']) })),
  terminology: z.array(z.object({ term: z.string(), definition: z.string() })),
  unknowns: z.array(z.string()),
});
export type RepoBriefOutput = z.infer<typeof RepoBriefOutput>;

/** Literature reader output (the lit/<texkey>.json shape, docs/design.md "Grounding pipeline"). */
export const LitReaderOutput = z.object({
  records: z.array(
    z.object({
      key: z.string(),
      texkey: z.string().nullable(),
      recid: z.number().int().nullable(),
      arxiv: z.string().nullable(),
      title: z.string(),
      abstract: z.string().nullable(),
      quotable: z.array(z.object({ claim: z.string(), quote: z.string(), locator: z.string() })),
      usable_for: z.array(z.string()),
    }),
  ),
  unresolved: z.array(z.string()),
});
export type LitReaderOutput = z.infer<typeof LitReaderOutput>;

export const FramingsOutput = z.object({ framings: z.array(z.object({ text: z.string(), why: z.string() })) });
export type FramingsOutput = z.infer<typeof FramingsOutput>;

export const RefereeOutput = z.object({
  questions: z.array(z.object({ question: z.string(), sentence_hint: z.string().nullable(), estimate: z.string().nullable() })),
});
export type RefereeOutput = z.infer<typeof RefereeOutput>;

export const MemoOutput = z.object({ memo_markdown: z.string() });
export type MemoOutput = z.infer<typeof MemoOutput>;

/** The zod schema each task's structured output is parsed with. */
export const OUTPUT_SCHEMAS: Record<TaskKind, z.ZodType> = {
  ghost: GhostOutput,
  intent: IntentOutput,
  instruct: InstructOutput,
  alternatives: AlternativesOutput,
  grammar: GrammarOutput,
  replan: ReplanOutput,
  draft: DraftParagraphOutput,
  repo_reader: RepoBriefOutput,
  lit_reader: LitReaderOutput,
  framings: FramingsOutput,
  referee: RefereeOutput,
  memo: MemoOutput,
};

/** Field descriptions the model sees in the schema (path -> text). */
const DESCRIPTIONS: Partial<Record<TaskKind, Record<string, string>>> = {
  ghost: {
    '/text': "The whole sentence: the author's prefix exactly as typed, then the continuation.",
    '/fact_ids': 'Ids of the facts whose numbers or definitions the sentence states.',
    '/cite_keys': 'Keys cited in the sentence.',
    '/fulfilled_move_ids': 'Ids of the paragraph-plan steps this sentence completes.',
  },
  intent: { '/proposals/[]/text': 'One English sentence saying what the note says.', '/proposals/[]/note': 'Short note in the notes language, or empty.' },
  instruct: {
    '/text': 'The rewritten sentence.',
    '/notes': 'One or two short lines in the notes language.',
    '/drift': 'True for each aspect that changed relative to the original sentence.',
  },
  grammar: { '/text': 'The sentence with grammar fixes only.', '/changes': 'One short item per fix, in the notes language.' },
  replan: {
    '/items/[]/sentence_id': 'Id of a downstream proposed sentence.',
    '/items/[]/text': 'New text for revise and insert_before; null for keep and drop.',
    '/next_opener': 'What the next paragraph opens with, when this one is complete; else null.',
  },
  draft: { '/sentences/[]/note_zh': 'Short note to the author in the notes language, or null.' },
  repo_reader: {
    '/fact_candidates/[]/locator': 'JSON pointer, CSV cell (csv:row=N;col=NAME), YAML key (yaml:a.b) or md:line=N. Never the value.',
    '/unknowns': 'What could not be determined, in the notes language.',
  },
  referee: { '/questions/[]/sentence_hint': 'A few words copied verbatim from the sentence the question is about, or null.', '/questions/[]/estimate': 'A quick estimate for the notes, or null.' },
  memo: { '/memo_markdown': 'The whole updated memo: markdown bullets, at most 400 words, each with its evidence count and pair ids.' },
};

const schemaCache = new Map<TaskKind, Record<string, unknown>>();

/**
 * JSON Schemas for output_config.format / Agent SDK outputFormat, one per task, derived from the zod
 * schemas above and post-processed to satisfy structured-output rules: every object has
 * `additionalProperties: false` and lists all properties in `required`; nullable fields are
 * `anyOf: [{type: X}, {type: 'null'}]`; no minLength/maxLength/minimum/maximum/minItems/maxItems; no
 * recursive refs; enums of strings only; draft-07 compatible (no `$schema` 2020-12 keywords).
 */
export function outputJsonSchema(task: TaskKind): Record<string, unknown> {
  const schema = OUTPUT_SCHEMAS[task];
  if (!schema) throw new Error(`no output schema for task "${String(task)}"`);
  let s = schemaCache.get(task);
  if (!s) {
    s = toStrictJsonSchema(schema, DESCRIPTIONS[task] ?? {});
    schemaCache.set(task, s);
  }
  // A fresh deep copy each call, so a caller that mutates the schema cannot change later prompts.
  return JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
}
