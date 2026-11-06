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
 * OWNER: core-prompts agent. Replace the `notImplemented` bodies; keep exported names and types.
 */
import { z } from 'zod';
import type { EditPair, Fact, GhostMode, Outline, OutlineParagraph, OutlineSection, ParagraphPlan, PlanStep, TermEntry } from '../schemas';
import { notImplemented } from '../util';

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

/** Reference files for a task, specialised by section template (abstract | introduction | section | results | conclusions | caption). */
export function referencesFor(task: TaskKind, template?: string | null): string[] {
  return notImplemented('referencesFor', task, template);
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

/**
 * Build system blocks [A(+role), B, C?] with cache_control as described above. The role text states:
 * paper text is English; notes, questions and explanations go in `notesLanguage`; never invent
 * numbers, citations, results, cuts or causal explanations; write `[fact?: ...]`, `[ref]` or a
 * descriptive `[...?]` placeholder instead; keep \cite \ref \label, math and macros exactly; plain
 * verbs, verb by about word 5, one claim per sentence; avoid the AI-ese words listed by the linter; the
 * reference examples are fictional (wrapped in <reference fictional_examples="true" name="...">) and
 * their numbers must never appear in output.
 */
export function buildSystemBlocks(input: SystemInput): PromptBlock[] {
  return notImplemented('buildSystemBlocks', input);
}

/** Deterministic fact table (sorted by id; excluded facts omitted): `id | rendering | kind | definition | validation`. */
export function factTable(facts: Fact[]): string {
  return notImplemented('factTable', facts);
}

/** The five Step-0 items and section jobs/questions, without live plans (stable across sentence edits). */
export function frozenOutline(outline: Outline): string {
  return notImplemented('frozenOutline', outline);
}

/** hashString of the stable serialization of system blocks + tail; logged with each version row. */
export function promptHash(system: PromptBlock[], tail: string): string {
  return notImplemented('promptHash', system, tail);
}

/**
 * Numbers that appear in the skill's invented Before/After examples (inside each rule's
 * "**Draft violation and fix.**" section, up to "**Boundaries.**") and in any line starting with
 * "Before" / "After" in the reference files. Only numerals with a decimal point or with 2+ digits.
 * The gate blocks them in AI output unless they are also real fact values.
 */
export function extractFictionalNumbers(references: Record<string, string>): string[] {
  return notImplemented('extractFictionalNumbers', references);
}

/** Strip wrappers a model may add around one sentence: surrounding quotes/backticks, "Sentence:" labels, markdown bullets. */
export function cleanModelSentence(text: string): string {
  return notImplemented('cleanModelSentence', text);
}

/* ------------------------------------------------------------------------------------ */
/* Volatile tails (user message text)                                                    */
/* ------------------------------------------------------------------------------------ */

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
  return notImplemented('ghostTail', i);
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
  return notImplemented('intentTail', i);
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
  return notImplemented('instructTail', i);
}

export function alternativesTail(i: { sentence: string; n: number; before: string; after: string; notesLanguage: 'zh' | 'en' }): string {
  return notImplemented('alternativesTail', i);
}

/** Grammar-only: fix grammar, articles, agreement, spelling; change nothing else (no rephrasing). */
export function grammarTail(i: { sentence: string; notesLanguage: 'zh' | 'en' }): string {
  return notImplemented('grammarTail', i);
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
  return notImplemented('replanTail', i);
}

export interface DraftTaskInput {
  section: OutlineSection;
  paragraphs: OutlineParagraph[];
  fromNotes: boolean;
  notesLanguage: 'zh' | 'en';
  /** Existing text of the section (for continuity), LaTeX. */
  existing: string;
}
/** Instructions for the drafter agent: call get_* tools, then propose_paragraph once per paragraph. */
export function draftTask(i: DraftTaskInput): string {
  return notImplemented('draftTask', i);
}

/** Instructions for the read-only repo reader: summarize the project, return fact candidates as LOCATORS only. */
export function repoReaderTask(i: { globs: string[]; notesLanguage: 'zh' | 'en' }): string {
  return notImplemented('repoReaderTask', i);
}

/** Three alternative framings of the paper, AFTER the author filled the five items. */
export function framingsTask(i: { outline: Outline; notesLanguage: 'zh' | 'en' }): string {
  return notImplemented('framingsTask', i);
}

/** At most four referee questions for a section, most important first, in the notes language. */
export function refereeTask(i: { sectionTitle: string; sectionText: string; notesLanguage: 'zh' | 'en' }): string {
  return notImplemented('refereeTask', i);
}

/** Update the CIPHER-style voice memo (<= 400 words) from new (AI text -> author text) pairs. */
export function memoTask(i: { currentMemo: string; pairs: EditPair[] }): string {
  return notImplemented('memoTask', i);
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

export const FramingsOutput = z.object({ framings: z.array(z.object({ text: z.string(), why: z.string() })) });
export type FramingsOutput = z.infer<typeof FramingsOutput>;

export const RefereeOutput = z.object({
  questions: z.array(z.object({ question: z.string(), sentence_hint: z.string().nullable(), estimate: z.string().nullable() })),
});
export type RefereeOutput = z.infer<typeof RefereeOutput>;

export const MemoOutput = z.object({ memo_markdown: z.string() });
export type MemoOutput = z.infer<typeof MemoOutput>;

/**
 * JSON Schemas for output_config.format / Agent SDK outputFormat, one per task, derived from the zod
 * schemas above and post-processed to satisfy structured-output rules: every object has
 * `additionalProperties: false` and lists all properties in `required`; nullable fields are
 * `anyOf: [{type: X}, {type: 'null'}]`; no minLength/maxLength/minimum/maximum/minItems/maxItems; no
 * recursive refs; enums of strings only; draft-07 compatible (no `$schema` 2020-12 keywords).
 */
export function outputJsonSchema(task: TaskKind): Record<string, unknown> {
  return notImplemented('outputJsonSchema', task);
}
