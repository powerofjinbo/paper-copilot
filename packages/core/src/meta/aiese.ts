/**
 * AI-ese linter: the Kobak et al. excess vocabulary (measured) and phrase patterns (labelled heuristics).
 *
 * FLAG RULE (docs/design.md: "flags words with excess ratio >= 3 or in the top 100"). A word of the 2024 excess
 * style vocabulary is flagged when
 *   (a) its excess frequency ratio r >= 3, or
 *   (b) it is among the 100 words with the largest excess frequency gap delta and has r >= 1.5
 *       (the r floor drops function words such as "these", "while", "into", whose large gap comes from
 *       their sheer frequency, r ~ 1.0-1.2),
 * and it is not in HEP_NEUTRAL (ordinary technical words in physics prose, below). Words that are not flagged
 * stay in EXCESS_VOCAB with their ratio (`flagged: false`) and do not count toward the style meter. Inflections are covered because the paper
 * measures each form separately (delve 7.9, delves 28.0, delving 6.9, delved 12.2 are all listed); forms it
 * could not measure (below its frequency cutoff) are added from KOBAK_UNMEASURED_INFLECTIONS with ratio null.
 * Matching is case-insensitive on whole words.
 */
import { KOBAK_2024_STYLE, KOBAK_SOURCE, KOBAK_UNMEASURED_INFLECTIONS } from './data/excessVocab';

export interface ExcessWord {
  word: string;
  /** Excess frequency ratio r from Kobak et al. (Sci. Adv. 2025) when known, else null. */
  ratio: number | null;
  source: string;
  /** Excess frequency gap delta (2024 frequency minus the projection), when known. */
  gap?: number | null;
  /** Part of speech as annotated by Kobak et al. ("verb", "adjective", ...). */
  pos?: string | null;
  /** True if aieseFlags flags this word (FLAG RULE above). */
  flagged?: boolean;
  /** For an unmeasured inflection: the listed word it inflects. */
  inflectionOf?: string | null;
}

export const AIESE_MIN_RATIO = 3;
export const AIESE_TOP_GAP = 100;
export const AIESE_TOP_GAP_MIN_RATIO = 1.5;

/**
 * Excess words that are routine in physics prose and are not flagged: "the relation holds", "aligning the
 * tracker", "the distribution exhibits a peak", "distinct", "precise", "substantial" (the skill recommends
 * *substantial* over *significant*), "presents", "primarily", "particularly", "challenges", "employed",
 * "explores", "focusing", "contributing", "emerge(s/d)", "achieving", "addressing", "offer", "stands",
 * "diverse", "demonstrates" (claim strength is checked by the gate instead).
 */
export const HEP_NEUTRAL: ReadonlySet<string> = new Set(
  `achieving addressing aligning challenges contributing demonstrates distinct diverse emerged emerges employed
  exhibit exhibited exhibits explores focusing holds offer particularly precise presents primarily stands
  substantial`.split(/\s+/),
);

function buildVocab(): ExcessWord[] {
  const byGap = [...KOBAK_2024_STYLE].sort((x, y) => y[2] - x[2] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const topGap = new Set(byGap.slice(0, AIESE_TOP_GAP).map((r) => r[0]));
  const out: ExcessWord[] = KOBAK_2024_STYLE.map(([word, ratio, gap, pos]) => ({
    word,
    ratio,
    gap,
    pos,
    source: KOBAK_SOURCE,
    flagged: !HEP_NEUTRAL.has(word) && (ratio >= AIESE_MIN_RATIO || (topGap.has(word) && ratio >= AIESE_TOP_GAP_MIN_RATIO)),
    inflectionOf: null,
  }));
  const flagged = new Set(out.filter((w) => w.flagged).map((w) => w.word));
  const listed = new Set(out.map((w) => w.word));
  for (const [form, of] of KOBAK_UNMEASURED_INFLECTIONS) {
    if (listed.has(form)) continue;
    out.push({
      word: form,
      ratio: null,
      gap: null,
      pos: out.find((w) => w.word === of)?.pos ?? null,
      source: `${KOBAK_SOURCE}; unmeasured inflection of "${of}"`,
      flagged: flagged.has(of),
      inflectionOf: of,
    });
  }
  return out;
}

/**
 * Excess-vocabulary list. Source: Kobak, Gonzalez-Marquez, Horvat, Lause, "Delving into LLM-assisted
 * writing in biomedical publications through excess vocabulary", Science Advances 11 (2025),
 * data at github.com/berenslab/llm-excess-vocab (MIT; vendored with attribution in packages/core/THIRD_PARTY.md):
 * the 2024 excess words annotated as style words, with r and delta recomputed by the paper's own formula,
 * plus unmeasured inflections of flagged words (ratio null).
 */
export const EXCESS_VOCAB: ExcessWord[] = buildVocab();

const FLAGGED = new Map<string, ExcessWord>(EXCESS_VOCAB.filter((w) => w.flagged).map((w) => [w.word, w]));

/** The flagged excess word for a token (any case), or null. */
export function excessWord(token: string): ExcessWord | null {
  return FLAGGED.get(token.toLowerCase()) ?? null;
}

const EVALUATIVE =
  'robust|efficient|scalable|accurate|reliable|powerful|flexible|comprehensive|seamless|innovative|novel|' +
  'versatile|effective|intuitive|interpretable|transparent|remarkable|unprecedented|significant|crucial|' +
  'pivotal|vital|essential|critical|key|important|valuable|promising|groundbreaking|transformative|holistic|' +
  'nuanced|dynamic|rich|intricate|diverse|profound|meaningful|impactful|insightful|elegant|sophisticated|' +
  'compelling|exceptional|outstanding|impressive|practical|principled|sustainable|cost-effective|' +
  'user-friendly|cutting-edge|state-of-the-art|lightweight|adaptable|actionable|streamlined|unified';

/** Labelled heuristics (no measured rate): "not only ... but also", "serves as", "plays a crucial role", "In today's", "It is worth noting that", rule-of-three adjective triplets, ... */
export const AI_PATTERNS: Array<{ id: string; pattern: RegExp; label: string }> = [
  { id: 'not_only_but_also', pattern: /\bnot only\b[^.;:!?]{1,120}?\bbut(?: also)?\b/gi, label: 'Heuristic: "not only ... but also" construction' },
  { id: 'serves_as', pattern: /\bserv(?:e|es|ed|ing) as (?:a|an|the)\b/gi, label: 'Heuristic: "serves as a" (write "is" or say what it does)' },
  {
    id: 'plays_role',
    pattern: /\bplay(?:s|ed|ing)? (?:a|an) (?:key|crucial|vital|pivotal|important|central|essential|critical|significant|major|fundamental) role\b/gi,
    label: 'Heuristic: "plays a crucial role" (say how it matters)',
  },
  { id: 'in_todays', pattern: /\bin today['’]s\b|\bin the (?:modern|current|present|digital) (?:era|age|landscape|world)\b/gi, label: 'Heuristic: "In today\'s ..." opener' },
  {
    id: 'worth_noting',
    pattern: /\bit is (?:worth (?:noting|mentioning|highlighting|emphasi[sz]ing)|important to (?:note|highlight|emphasi[sz]e|recogni[sz]e)|noteworthy) that\b/gi,
    label: 'Heuristic: "It is worth noting that" (state the point)',
  },
  {
    id: 'rule_of_three',
    pattern: new RegExp(`\\b(?:${EVALUATIVE}),\\s+(?:${EVALUATIVE}),?\\s+(?:and|or)\\s+(?:${EVALUATIVE})\\b`, 'gi'),
    label: 'Heuristic: rule-of-three adjective triplet',
  },
  { id: 'paves_the_way', pattern: /\bpav(?:e|es|ed|ing) the way\b/gi, label: 'Heuristic: "paves the way" (say what it enables)' },
  { id: 'testament', pattern: /\b(?:a|is a|stands as a) testament to\b/gi, label: 'Heuristic: "a testament to"' },
  { id: 'tapestry', pattern: /\b(?:rich |intricate |complex |vibrant )?tapestry\b/gi, label: 'Heuristic: "tapestry" metaphor' },
  {
    id: 'landscape_of',
    pattern: /\b(?:the|this|an?) (?:(?:evolving|ever-evolving|broader|intricate|complex|rapidly evolving|current) )?landscape of\b/gi,
    label: 'Heuristic: "the landscape of" metaphor',
  },
  { id: 'navigate_complexities', pattern: /\bnavigat(?:e|es|ed|ing) (?:the )?(?:complexities|intricacies|challenges|landscape)\b/gi, label: 'Heuristic: "navigate the complexities"' },
  { id: 'harness_power', pattern: /\bharness(?:es|ed|ing)? the (?:full )?power of\b/gi, label: 'Heuristic: "harness the power of"' },
  { id: 'unlock_potential', pattern: /\bunlock(?:s|ed|ing)? (?:the |its |their )?(?:full )?potential\b/gi, label: 'Heuristic: "unlock the potential"' },
  { id: 'shed_light', pattern: /\bsh(?:ed|eds|edding) (?:new |more |further )?light on\b/gi, label: 'Heuristic: "shed light on" (say what it shows)' },
  { id: 'ever_evolving', pattern: /\bever-(?:evolving|changing|growing|increasing)\b/gi, label: 'Heuristic: "ever-evolving" filler' },
];

export interface AieseFlag {
  start: number;
  end: number;
  word: string;
  kind: 'excess_vocab' | 'pattern';
  ratio: number | null;
  label: string;
}

const WORD_TOKEN_RE = /\p{L}+/gu;

function excessLabel(w: ExcessWord): string {
  if (w.ratio !== null) return `Excess word "${w.word}" (r = ${w.ratio.toFixed(1)} in 2024, Kobak et al. 2025)`;
  if (w.inflectionOf) return `Excess word family of "${w.inflectionOf}" (Kobak et al. 2025; no measured ratio for "${w.word}")`;
  return `Excess word "${w.word}" (Kobak et al. 2025; no measured ratio)`;
}

/** Excess-vocabulary hits only (the style meter counts these). */
export function excessHits(plain: string): AieseFlag[] {
  const out: AieseFlag[] = [];
  for (const m of plain.matchAll(WORD_TOKEN_RE)) {
    const w = FLAGGED.get(m[0].toLowerCase());
    if (!w) continue;
    const start = m.index ?? 0;
    out.push({ start, end: start + m[0].length, word: m[0], kind: 'excess_vocab', ratio: w.ratio, label: excessLabel(w) });
  }
  return out;
}

/** Flags in plain text: excess words (all inflections: delve/delves/delving/delved) and patterns. */
export function aieseFlags(plain: string): AieseFlag[] {
  if (!plain) return [];
  const out = excessHits(plain);
  for (const p of AI_PATTERNS) {
    for (const m of plain.matchAll(p.pattern)) {
      if (m[0].length === 0) continue;
      const start = m.index ?? 0;
      out.push({ start, end: start + m[0].length, word: m[0], kind: 'pattern', ratio: null, label: p.label });
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}
