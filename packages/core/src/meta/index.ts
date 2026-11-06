/**
 * Disclosure generator, cost meter, style features/distance, AI-ese linter and BM25 retrieval.
 *
 * OWNER: core-meta agent. The implementations live in the files below; everything is re-exported here.
 * - disclosure.ts: computeDisclosureStats, renderDisclosure (docs/design.md, Faithfulness and provenance)
 * - cost.ts: PRICES, costOf, CostMeter (list prices, USD per million tokens)
 * - style.ts: styleFeatures, styleDistance, furthestSentences, SKILL_CORPUS_NORMS
 * - aiese.ts: EXCESS_VOCAB, AI_PATTERNS, aieseFlags (Kobak et al. 2025 excess vocabulary)
 * - bm25.ts: Bm25Index
 * - data/: lists copied from the skill's style_check.py and the vendored Kobak et al. data (THIRD_PARTY.md)
 */
export { computeDisclosureStats, renderDisclosure, modelDisplayName, texEscapeDisclosure, type DisclosureStats, type DisclosureText } from './disclosure';
export { PRICES, costOf, priceFor, usageTokens, CostMeter, type ModelPrice, type Usage } from './cost';
export { SKILL_CORPUS_NORMS, STYLE_SPREADS, HEDGE_RE, styleFeatures, styleDistance, furthestSentences, type StyleFeatures, type StyleFeatureKey } from './style';
export {
  EXCESS_VOCAB,
  AI_PATTERNS,
  AIESE_MIN_RATIO,
  AIESE_TOP_GAP,
  AIESE_TOP_GAP_MIN_RATIO,
  HEP_NEUTRAL,
  aieseFlags,
  excessHits,
  excessWord,
  type AieseFlag,
  type ExcessWord,
} from './aiese';
export { Bm25Index, BM25_STOPWORDS, bm25Tokens, type Bm25Doc } from './bm25';
export { KOBAK_2024_STYLE, KOBAK_SOURCE, KOBAK_UNMEASURED_INFLECTIONS } from './data/excessVocab';
export * as STYLE_CHECK_LISTS from './data/styleCheckLists';
export { capitalize as capitalizeFirst, plainWords, verbFirst, baselineFirst, splitSentence, simulatedRewrite, simulatedAlternatives, type Rewrite } from './simulate';
