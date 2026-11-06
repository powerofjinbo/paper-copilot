/**
 * Shared data model for paper-copilot.
 *
 * Every persisted object and every object that crosses the server/web boundary is
 * defined here as a zod schema, so the server, the web client and later clients agree
 * on one shape. Field names follow docs/design.md, section "Data model".
 *
 * Offsets are UTF-16 code-unit offsets into the file text (what JavaScript strings and
 * CodeMirror use). `end` is exclusive. Lines are 1-based.
 */
import { z } from 'zod';

/* ------------------------------------------------------------------------------------ */
/* Enumerations                                                                          */
/* ------------------------------------------------------------------------------------ */

/** Part of the paper a sentence belongs to (same vocabulary as the skill's style_check.py). */
export const Part = z.enum(['abstract', 'intro', 'body', 'concl', 'app', 'caption', 'footnote']);
export type Part = z.infer<typeof Part>;

/** Kind of text unit. Headings are not sentence units. */
export const UnitKind = z.enum(['prose', 'caption', 'footnote']);
export type UnitKind = z.infer<typeof UnitKind>;

/**
 * Provenance state of a sentence.
 * - human: typed by the author (or imported; see `imported`).
 * - ai-from-intent: rendered by the AI from the author's (often Chinese) intent note, then accepted.
 * - ai-drafted: proposed by the AI (ghost or draft) and accepted without edits.
 * - ai-edited: AI text that the author then edited (editDistance > 0).
 * - proposed: AI text awaiting review. Never pushed to co-authors.
 * - external: changed by someone else (pulled from Overleaf / edited on disk outside the app).
 * - placeholder: a sentence that is only a placeholder such as `[claim: ...?]`.
 * - unsupported: AI text that failed the faithfulness gate after retries; shown red, never pushed.
 */
export const SentenceState = z.enum([
  'human',
  'ai-from-intent',
  'ai-drafted',
  'ai-edited',
  'proposed',
  'external',
  'placeholder',
  'unsupported',
]);
export type SentenceState = z.infer<typeof SentenceState>;

/** States that must block a push to co-authors. */
export const UNREVIEWED_STATES: readonly SentenceState[] = ['proposed', 'unsupported', 'placeholder'];

/** Origin of one version of a sentence. */
export const VersionOrigin = z.enum([
  'import',
  'human_typed',
  'human_edit',
  'ai_ghost',
  'ai_intent',
  'ai_draft',
  'ai_rewrite',
  'grammar_fix',
  'replan',
  'external_edit',
]);
export type VersionOrigin = z.infer<typeof VersionOrigin>;

/** Origins that make a sentence "ever AI-touched". `everAi` can never be cleared. */
export const AI_ORIGINS: readonly VersionOrigin[] = ['ai_ghost', 'ai_intent', 'ai_draft', 'ai_rewrite', 'grammar_fix', 'replan'];

export const Venue = z.enum(['aps', 'elsevier', 'arxiv', 'springer']);
export type Venue = z.infer<typeof Venue>;

export const NotesLanguage = z.enum(['zh', 'en']);
export type NotesLanguage = z.infer<typeof NotesLanguage>;

/** Ghost-text behavior per outline section (docs/design.md, Core loops, Ghost mode). */
export const GhostMode = z.enum(['complete-my-sentence', 'auto-propose', 'questions-only']);
export type GhostMode = z.infer<typeof GhostMode>;

/** Who wrote an outline item. */
export const Provenance = z.enum(['author', 'ai-proposed', 'ai-edited']);
export type Provenance = z.infer<typeof Provenance>;

/* ------------------------------------------------------------------------------------ */
/* Sentence units                                                                        */
/* ------------------------------------------------------------------------------------ */

export const SentenceUnit = z.object({
  /** ULID, stable across edits, pulls and re-segmentation. */
  id: z.string(),
  /** Path of the .tex file relative to the tex root, e.g. "main.tex". */
  file: z.string(),
  /** UTF-16 offsets into the current file text; end exclusive; trimmed of surrounding whitespace. */
  start: z.number().int(),
  end: z.number().int(),
  /** 1-based line of `start`. */
  line: z.number().int(),
  /** hashString(normalizeForHash(text)). */
  hash: z.string(),
  /** hashString(prevUnit.hash + '|' + nextUnit.hash) within the same paragraph; '' at edges. */
  ctxHash: z.string(),
  /** normalizeForHash(text), kept for fuzzy matching. */
  textNorm: z.string(),
  sectionId: z.string(),
  paragraphId: z.string(),
  part: Part,
  kind: UnitKind,
  /** Rhetorical move from the skill's templates (e.g. "gap", "result"), if known. */
  move: z.string().nullable(),
  state: SentenceState,
  /** True once any AI origin touched this sentence. Never cleared, even after a human rewrite. */
  everAi: z.boolean(),
  /** True if a grammar-only fix was applied (state unchanged). */
  grammarFixed: z.boolean(),
  /** True if the sentence existed when the document was imported (provenance before the log is unknown). */
  imported: z.boolean(),
  /** Model id of the last AI version, from the API response. */
  model: z.string().nullable(),
  promptHash: z.string().nullable(),
  createdAt: z.string(),
  acceptedAt: z.string().nullable(),
  /** Word-level normalized edit distance between the last AI version and the current text (0..1). */
  editDistance: z.number().nullable(),
  /** The author's intent note (often Chinese) that this sentence was rendered from. */
  intentNote: z.string().nullable(),
  /** Linked fact ids, cite keys, claim ids, placeholders found in the text. */
  facts: z.array(z.string()),
  cites: z.array(z.string()),
  claims: z.array(z.string()),
  placeholders: z.array(z.string()),
  /** True if the sentence could not be re-anchored after an external change. Metadata is kept. */
  orphaned: z.boolean(),
  /** If this unit was split from another unit, that unit's id. */
  splitFrom: z.string().nullable(),
});
export type SentenceUnit = z.infer<typeof SentenceUnit>;

export const SentenceVersion = z.object({
  sentenceId: z.string(),
  /** 0-based, increasing per sentence. */
  version: z.number().int(),
  ts: z.string(),
  text: z.string(),
  origin: VersionOrigin,
  model: z.string().nullable(),
  promptHash: z.string().nullable(),
  /** Instruction the author gave (for ai_rewrite), or the intent note (for ai_intent). */
  instruction: z.string().nullable(),
  lang: z.string().nullable(),
  parentVersion: z.number().int().nullable(),
  /** Edit distance to the parent version (0..1). */
  editDistance: z.number().nullable(),
});
export type SentenceVersion = z.infer<typeof SentenceVersion>;

/* ------------------------------------------------------------------------------------ */
/* Lint                                                                                  */
/* ------------------------------------------------------------------------------------ */

export const LintSource = z.enum(['style_check', 'aiese', 'heuristic', 'gate']);
export type LintSource = z.infer<typeof LintSource>;

export const LintFlag = z.object({
  /** Stable id: hashString(source + check + sentenceId + word + msg). */
  id: z.string(),
  sentenceId: z.string().nullable(),
  /** style_check check key (long, verb, connectors, vocab, hype, vague, acronyms, terms, figures, passive), or an aiese/gate code. */
  check: z.string(),
  source: LintSource,
  msg: z.string(),
  /** The offending word or phrase, if any (used to underline it inside the sentence). */
  word: z.string().nullable(),
  line: z.number().int().nullable(),
  excerpt: z.string().nullable(),
  /** Flags per 1,000 words in the skill's five-paper corpus, when known. */
  corpusRate: z.number().nullable(),
  /** The same rate in this document. */
  userRate: z.number().nullable(),
  severity: z.enum(['hint', 'warn']),
  dismissed: z.boolean(),
});
export type LintFlag = z.infer<typeof LintFlag>;

/* ------------------------------------------------------------------------------------ */
/* Facts and claims (HEP-Pilot results-manifest and note-writer claim-map shapes)        */
/* ------------------------------------------------------------------------------------ */

export const FactKind = z.enum(['number', 'cut', 'definition', 'sample', 'setting', 'figure', 'table']);
export type FactKind = z.infer<typeof FactKind>;

export const ValidationState = z.enum(['candidate', 'reproduced', 'independently_validated']);
export type ValidationState = z.infer<typeof ValidationState>;

export const Fact = z.object({
  /** Deterministic id derived from artifact + locator, e.g. "f.g1.delta_points". */
  id: z.string(),
  kind: FactKind,
  /** Numeric value as stored in the artifact, or a string for definitions/settings. */
  value: z.union([z.number(), z.string()]),
  /** Significant figures to render at (null = derive from the artifact text). */
  sigfigs: z.number().int().nullable(),
  /** Unit as written in prose ("points", "%", "GeV", "mm", "" for dimensionless). */
  unit: z.string(),
  /** Named uncertainties, same unit/scale as `value` (e.g. {total, boot, seeds}). */
  uncertainties: z.record(z.string(), z.number()),
  /** Plain-English definition built from artifact metadata (never invented by a model). */
  definition: z.string(),
  /** Where the definition came from (e.g. "metadata: A, B, population, split, n_targets"). */
  definitionSource: z.string(),
  /** Path relative to the analysis repo root. */
  artifact: z.string(),
  /** JSON pointer ("#/delta_points"), CSV cell ("csv:row=3;col=eff"), YAML key, or "md:line=12". */
  locator: z.string(),
  artifactSha256: z.string(),
  /** hashString(artifactSha256 + '|' + locator + '|' + String(value)). Changes mark the fact stale. */
  fingerprint: z.string(),
  stale: z.boolean(),
  /** Defaults to candidate; rises only through an evidence record. Reading a value is not reproducing it. */
  validationState: ValidationState,
  /** Renderings derived from value + sigfigs only (e.g. ["2.3 points", "2.32 points"]). */
  aliases: z.array(z.string()),
  /** The author confirmed this fact may be used in prose. */
  confirmed: z.boolean(),
  /** The author excluded this fact from prompts and matching. */
  excluded: z.boolean(),
  /** The value exists only in README/prose, not in a machine-readable artifact. */
  proseOnly: z.boolean(),
  tags: z.array(z.string()),
});
export type Fact = z.infer<typeof Fact>;

export const EvidenceRecord = z.object({
  ts: z.string(),
  factIds: z.array(z.string()),
  command: z.string(),
  artifact: z.string(),
  sha256: z.string(),
  note: z.string().nullable(),
});
export type EvidenceRecord = z.infer<typeof EvidenceRecord>;

export const ClaimStatus = z.enum(['supported', 'placeholder', 'excluded']);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

export const Claim = z.object({
  claimId: z.string(),
  text: z.string(),
  /** Fact ids that support the claim. */
  evidence: z.array(z.string()),
  /** INSPIRE texkeys or .bib keys. */
  citations: z.array(z.string()),
  /** Scope or uncertainty qualifier that must travel with the claim. */
  qualification: z.string(),
  status: ClaimStatus,
  sentenceIds: z.array(z.string()),
  section: z.string().nullable(),
  move: z.string().nullable(),
});
export type Claim = z.infer<typeof Claim>;

/* ------------------------------------------------------------------------------------ */
/* Outline (the skill's Step 0 five items + section plans)                               */
/* ------------------------------------------------------------------------------------ */

export const PlanStep = z.object({
  id: z.string(),
  /** What the next sentence should say, in plain words. */
  intent: z.string(),
  factIds: z.array(z.string()),
  citeKeys: z.array(z.string()),
  move: z.string().nullable(),
});
export type PlanStep = z.infer<typeof PlanStep>;

export const ParagraphPlan = z.object({
  /** The paragraph's one job, stated in its first sentence (skill principle 4). */
  job: z.string(),
  claimIds: z.array(z.string()),
  /** claimId (or plan step id) -> sentence id that said it. */
  said: z.record(z.string(), z.string()),
  remaining: z.array(PlanStep),
});
export type ParagraphPlan = z.infer<typeof ParagraphPlan>;

export const OutlineParagraph = z.object({
  pid: z.string(),
  job: z.string(),
  moves: z.array(z.string()),
  claimIds: z.array(z.string()),
  intentNotes: z.array(z.string()),
  plan: ParagraphPlan,
  provenance: Provenance,
});
export type OutlineParagraph = z.infer<typeof OutlineParagraph>;

export const OutlineSection = z.object({
  id: z.string(),
  title: z.string(),
  /** The one question this section answers. */
  question: z.string(),
  /** Skill template name: abstract | introduction | section | results | conclusions | caption | null. */
  template: z.string().nullable(),
  ghostMode: GhostMode,
  paragraphs: z.array(OutlineParagraph),
  provenance: Provenance,
});
export type OutlineSection = z.infer<typeof OutlineSection>;

const ProvText = z.object({ text: z.string(), provenance: Provenance });

export const Outline = z.object({
  /** 1. The one-sentence story, plus the key phrase echoed in title/abstract/contribution/conclusions. */
  story: z.object({ text: z.string(), keyPhrase: z.string(), provenance: Provenance }),
  /** 2. The gap and the enabler. */
  gap: ProvText,
  enabler: ProvText,
  /** The one assumption of the standard approach the paper changes (STORY-2). */
  contrast: ProvText,
  /** 3. The ladder of cases, easy to hard. */
  ladder: z.array(z.object({ id: z.string(), text: z.string(), factIds: z.array(z.string()), provenance: Provenance })),
  /** 4. The figure that carries each claim. */
  claimFigures: z.array(z.object({ claimId: z.string(), figureId: z.string() })),
  /** 5. The headline number with its baseline and condition. */
  headline: z.object({
    factId: z.string().nullable(),
    baselineFactId: z.string().nullable(),
    condition: z.string(),
    text: z.string(),
    provenance: Provenance,
  }),
  /** Alternative framings proposed by the outliner (never adopted without the author). */
  framings: z.array(z.object({ id: z.string(), text: z.string(), provenance: Provenance, adopted: z.boolean() })),
  sections: z.array(OutlineSection),
  /** True once the author filled the five items (the outliner only runs after this). */
  authorFilled: z.boolean(),
});
export type Outline = z.infer<typeof Outline>;

/* ------------------------------------------------------------------------------------ */
/* Figures, terminology, literature                                                      */
/* ------------------------------------------------------------------------------------ */

export const FigureEntry = z.object({
  figureId: z.string(),
  label: z.string().nullable(),
  path: z.string().nullable(),
  sha256: z.string().nullable(),
  producerScript: z.string().nullable(),
  claimIds: z.array(z.string()),
  captionSentenceIds: z.array(z.string()),
  status: z.enum(['exists', 'needs_run']),
  job: z.string(),
});
export type FigureEntry = z.infer<typeof FigureEntry>;

export const TermEntry = z.object({
  term: z.string(),
  definition: z.string(),
  acronym: z.string().nullable(),
  firstUseSentenceId: z.string().nullable(),
  variants: z.array(z.string()),
  symbol: z.string().nullable(),
});
export type TermEntry = z.infer<typeof TermEntry>;

export const CiteStatus = z.enum(['resolved', 'unresolved', 'user_confirmed']);
export type CiteStatus = z.infer<typeof CiteStatus>;

export const LitRecord = z.object({
  /** The key used in \cite (INSPIRE texkey when resolved). */
  key: z.string(),
  status: CiteStatus,
  texkey: z.string().nullable(),
  recid: z.number().int().nullable(),
  arxiv: z.string().nullable(),
  doi: z.string().nullable(),
  title: z.string(),
  authors: z.string(),
  year: z.number().int().nullable(),
  abstract: z.string().nullable(),
  /** Verbatim quotes usable as support, in the shape of the author's docs/paper_facts.md. */
  quotable: z.array(z.object({ claim: z.string(), quote: z.string(), locator: z.string() })),
  usableFor: z.array(z.string()),
  source: z.enum(['bib', 'inspire', 'semantic_scholar', 'manual']),
});
export type LitRecord = z.infer<typeof LitRecord>;

/* ------------------------------------------------------------------------------------ */
/* Voice                                                                                 */
/* ------------------------------------------------------------------------------------ */

export const CorpusEntry = z.object({
  id: z.string(),
  text: z.string(),
  source: z.string(),
  /** abstract | intro | body | results | concl | caption | other */
  sectionType: z.string(),
  /** The author confirmed this text was written without AI help. Only these feed exemplars. */
  unassisted: z.boolean(),
});
export type CorpusEntry = z.infer<typeof CorpusEntry>;

export const EditPair = z.object({
  sentenceId: z.string(),
  ts: z.string(),
  aiText: z.string(),
  humanText: z.string(),
  instruction: z.string().nullable(),
  sectionType: z.string(),
  /** Grammar-only pairs are excluded from voice learning (Agarwal et al. CHI 2025). */
  grammarOnly: z.boolean(),
  editDistance: z.number(),
});
export type EditPair = z.infer<typeof EditPair>;

/* ------------------------------------------------------------------------------------ */
/* Project configuration (.paper/project.json)                                           */
/* ------------------------------------------------------------------------------------ */

export const ModelRoutes = z.object({
  /** Ghost text: direct Messages API, thinking disabled, effort low. */
  ghost: z.string(),
  /** Instruct / alternatives / grammar / intent rendering / re-plan. */
  actions: z.string(),
  /** Section drafting, outline framings, referee pass. */
  drafter: z.string(),
  /** Repository and literature readers. */
  reader: z.string(),
});
export type ModelRoutes = z.infer<typeof ModelRoutes>;

export const DEFAULT_MODEL_ROUTES: ModelRoutes = {
  ghost: 'claude-haiku-5-5',
  actions: 'claude-sonnet-5-5',
  drafter: 'claude-opus-5-5',
  reader: 'claude-sonnet-5-5',
};

export const ProjectConfig = z.object({
  schemaVersion: z.literal(1),
  name: z.string(),
  /** Absolute path of the LaTeX tree (the Overleaf clone). Nothing outside it is ever synced. */
  texRoot: z.string(),
  /** Main file relative to texRoot. */
  mainFile: z.string(),
  /** Absolute path of the analysis repository (read-only), or null. */
  repoDir: z.string().nullable(),
  /** Absolute path of the hep-paper-writing skill checkout. */
  skillDir: z.string(),
  /** .bib files relative to texRoot. */
  bibFiles: z.array(z.string()),
  venue: Venue,
  notesLanguage: NotesLanguage,
  /** Globs (relative to repoDir) the deterministic fact extractor reads. */
  factGlobs: z.array(z.string()),
  /** Globs (relative to repoDir) the repo-reader agent may read. */
  readerGlobs: z.array(z.string()),
  models: ModelRoutes,
  sync: z.object({
    mode: z.enum(['git', 'ols', 'none']),
    remote: z.string().nullable(),
    branch: z.string(),
  }),
  /** Per-run budget cap for agent jobs, USD. */
  maxBudgetUsd: z.number(),
  /** One sentence per line in prose paragraphs (semantic line breaks) was applied at import. */
  semanticLines: z.boolean(),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

/* ------------------------------------------------------------------------------------ */
/* Helpers                                                                               */
/* ------------------------------------------------------------------------------------ */

export function emptyOutline(): Outline {
  const p = (text = ''): { text: string; provenance: Provenance } => ({ text, provenance: 'author' });
  return {
    story: { text: '', keyPhrase: '', provenance: 'author' },
    gap: p(),
    enabler: p(),
    contrast: p(),
    ladder: [],
    claimFigures: [],
    headline: { factId: null, baselineFactId: null, condition: '', text: '', provenance: 'author' },
    framings: [],
    sections: [],
    authorFilled: false,
  };
}
