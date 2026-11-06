/**
 * Disclosure generator, cost meter, style features/distance, AI-ese linter and BM25 retrieval.
 *
 * OWNER: core-meta agent. Replace the `notImplemented` bodies; keep exported names and types.
 * (Split into several files under src/meta/ if you like; re-export everything from here.)
 */
import type { SentenceState, SentenceUnit, SentenceVersion, Venue } from '../schemas';
import { notImplemented } from '../util';

/* ------------------------------------------------------------------------------------ */
/* Disclosure (docs/design.md, Faithfulness and provenance)                              */
/* ------------------------------------------------------------------------------------ */

export interface DisclosureStats {
  totalSentences: number;
  byState: Record<SentenceState, number>;
  /** Sentences ever touched by AI (everAi), whatever their state now. */
  everAi: number;
  /** Drafted by AI from the outline and result files, accepted without edits. */
  aiDrafted: number;
  /** Drafted by AI, then edited by the authors; with the mean word-level edit distance. */
  aiEdited: number;
  meanEditDistance: number | null;
  /** Rendered from the authors' own notes (e.g. Chinese intent notes). */
  aiFromIntent: number;
  /** Grammar/language polish only. */
  grammarFixed: number;
  /** Existed when the document was imported (provenance before the log is unknown). */
  imported: number;
  humanWritten: number;
  external: number;
  /** Distinct model ids seen in versions. */
  models: string[];
  firstTs: string | null;
  lastTs: string | null;
}

export function computeDisclosureStats(units: SentenceUnit[], versions: SentenceVersion[]): DisclosureStats {
  return notImplemented('computeDisclosureStats', units, versions);
}

export interface DisclosureText {
  /** LaTeX to paste (e.g. an \section*{Declaration ...} for Elsevier, an acknowledgments sentence for APS). */
  latex: string;
  plain: string;
  /** Where it goes, in words ("Acknowledgments or Methods (APS)", "above the references (Elsevier)"...). */
  placement: string;
}

/**
 * Venue rules: APS (June 2026 policy): name tools and versions, how they assisted (with counts), how
 * the authors directed and verified the output (every number and citation checked against result files
 * and the bibliography; every sentence reread), and that records are kept (path). Elsevier: a section
 * titled "Declaration of generative AI and AI-assisted technologies in the writing process" above the
 * references. Springer/JHEP: a Methods-section paragraph (copy-editing alone needs no declaration).
 * arXiv: one comment line reporting significant use. Never claim more verification than the log shows.
 */
export function renderDisclosure(venue: Venue, stats: DisclosureStats, opts: { toolName: string; toolVersion: string; recordPath: string }): DisclosureText {
  return notImplemented('renderDisclosure', venue, stats, opts);
}

/* ------------------------------------------------------------------------------------ */
/* Cost meter (list prices, USD per million tokens)                                      */
/* ------------------------------------------------------------------------------------ */

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** Prompts above this many tokens use the `long` prices (Haiku 5.5: 100k). */
  longThreshold?: number;
  long?: Omit<ModelPrice, 'longThreshold' | 'long'>;
}

/**
 * claude-haiku-5-5: 0.10 in / 0.50 out / 0.01 cache read / 0.125 write 5m / 0.20 write 1h; above 100k
 * prompt tokens 0.50 / 2.50 / 0.05 / 0.625 / 1.00. claude-sonnet-5-5: 2 / 10 / 0.10 / 2.50 / 4.
 * claude-opus-5-5: 4 / 20 / 0.20 / 5 / 8. claude-fable-5-1: 10 / 50 / 0.25 / 12.50 / 20.
 * (platform.claude.com pricing page, read 2026-11-06.)
 */
export const PRICES: Record<string, ModelPrice> = {};

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
}

/** USD for one response. Unknown model -> 0 and the caller logs it. cache_creation split wins over the total. */
export function costOf(model: string, usage: Usage): number {
  return notImplemented('costOf', model, usage);
}

export class CostMeter {
  add(_model: string, _usage: Usage, _route: string): number {
    return notImplemented('CostMeter.add');
  }
  totals(): { usd: number; byRoute: Record<string, number>; byModel: Record<string, number>; requests: number; cacheReadTokens: number; inputTokens: number; outputTokens: number } {
    return notImplemented('CostMeter.totals');
  }
}

/* ------------------------------------------------------------------------------------ */
/* Style features and distance                                                           */
/* ------------------------------------------------------------------------------------ */

export interface StyleFeatures {
  n: number;
  medianLen: number;
  p90Len: number;
  /** Median position of the first finite verb (heuristic verb list). */
  verbPos: number;
  passiveShare: number;
  /** we/our/us per 1,000 words. */
  weRate: number;
  hedgeRate: number;
  intensifierRate: number;
  /** Sentences opening with Moreover/Furthermore/Additionally/... per 1,000 words. */
  connectorOpenerRate: number;
  /** Inflated words (utilize, leverage, ...) per 1,000 words. */
  inflatedRate: number;
  /** AI-ese excess vocabulary per 1,000 words. */
  excessVocabRate: number;
  /** Type-token ratio on the first 1,000 words. */
  ttr: number;
  lenStd: number;
  /** Em/en dashes used as punctuation per 1,000 words. */
  dashRate: number;
}

/**
 * The skill's measured five-paper norms (SKILL.md principle 5 and references/sentences-and-words.md):
 * median 23 words, p90 41, verb at median word 5, passive 35% of prose sentences, we 13.6/1k,
 * hedges 3.8/1k, intensifiers 2.1/1k, connector openers ~0.6/1k (4 of 672 sentences), semicolons 2.2/1k,
 * dashes 0.3/1k. Fields the skill does not measure use neutral values documented in the code.
 */
export const SKILL_CORPUS_NORMS: StyleFeatures = {
  n: 985, medianLen: 23, p90Len: 41, verbPos: 5, passiveShare: 0.352, weRate: 13.6, hedgeRate: 3.8,
  intensifierRate: 2.1, connectorOpenerRate: 0.6, inflatedRate: 0.2, excessVocabRate: 0.5, ttr: 0.45, lenStd: 11, dashRate: 0.3,
};

/** Features of a list of plain-text sentences. Empty input -> n = 0 and zeros. */
export function styleFeatures(sentences: string[]): StyleFeatures {
  return notImplemented('styleFeatures', sentences);
}

/** Scaled distance (0 = identical; ~1 = typical difference between authors) and per-feature contributions. */
export function styleDistance(a: StyleFeatures, b: StyleFeatures): { distance: number; perFeature: Record<string, number> } {
  return notImplemented('styleDistance', a, b);
}

/** The k sentences whose removal moves the set closest to `target` (largest contribution first), with a plain reason. */
export function furthestSentences(sentences: Array<{ id: string; text: string }>, target: StyleFeatures, k = 3): Array<{ id: string; contribution: number; why: string }> {
  return notImplemented('furthestSentences', sentences, target, k);
}

/* ------------------------------------------------------------------------------------ */
/* AI-ese linter                                                                         */
/* ------------------------------------------------------------------------------------ */

export interface ExcessWord {
  word: string;
  /** Excess frequency ratio r from Kobak et al. (Sci. Adv. 2025) when known, else null. */
  ratio: number | null;
  source: string;
}

/**
 * Excess-vocabulary list. Source: Kobak, Gonzalez-Marquez, Horvat, Lause, "Delving into LLM-assisted
 * writing in biomedical publications through excess vocabulary", Science Advances 11 (2025),
 * data at github.com/berenslab/llm-excess-vocab (check its licence before vendoring data; if it cannot
 * be vendored, ship the words the paper names with their ratios and document how to load the full list).
 */
export const EXCESS_VOCAB: ExcessWord[] = [];

/** Labelled heuristics (no measured rate): "not only ... but also", "serves as", "plays a crucial role", "In today's", "It is worth noting that", rule-of-three adjective triplets, ... */
export const AI_PATTERNS: Array<{ id: string; pattern: RegExp; label: string }> = [];

export interface AieseFlag {
  start: number;
  end: number;
  word: string;
  kind: 'excess_vocab' | 'pattern';
  ratio: number | null;
  label: string;
}

/** Flags in plain text: excess words (all inflections: delve/delves/delving/delved) and patterns. */
export function aieseFlags(plain: string): AieseFlag[] {
  return notImplemented('aieseFlags', plain);
}

/* ------------------------------------------------------------------------------------ */
/* BM25 retrieval over the author's corpus                                               */
/* ------------------------------------------------------------------------------------ */

export interface Bm25Doc {
  id: string;
  text: string;
  tags?: string[];
}

export class Bm25Index {
  constructor(_docs: Bm25Doc[], _opts: { k1?: number; b?: number } = {}) {}
  /** Top-k documents by BM25 score (score > 0 only), optionally restricted to docs having all `tags`. */
  search(_query: string, _k: number, _tags?: string[]): Array<{ id: string; score: number }> {
    return notImplemented('Bm25Index.search');
  }
  get size(): number {
    return notImplemented('Bm25Index.size');
  }
}
