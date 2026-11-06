/**
 * Deterministic meaning checks shared by the gate (grammar and rewrite modes, direction of a result) and
 * by the disclosure (is a grammar fix really language polishing only?).
 *
 * OWNER: core-gate agent.
 *
 * - Direction words: a closed lexicon of words that state which way a quantity goes ("rises", "lower",
 *   "fewer", "loses"). Evaluative words ("better", "improves", "gains") are not in it: an improvement of a
 *   fake rate is a decrease.
 * - Negation: not, no, never, without, cannot, n't, neither, nor, none, nothing, fail(s) to.
 * - Content words: words outside a stop list, reduced by a crude English stemmer (inflection only:
 *   -s, -es, -ed, -ing, -ly), so "lower" and "lowers" are the same word but "lower" and "raise" are not.
 */
import { scanLatex } from '../latex/tokens';
import { editDistanceWords } from '../text/normalize';

export type Direction = 'up' | 'down';

const UP_WORDS =
  'rise rises rose risen rising increase increases increased increasing higher more greater larger raise raises raised raising ' +
  'grow grows grew grown growing exceed exceeds exceeded exceeding up upward upwards climb climbs climbed climbing';
const DOWN_WORDS =
  'fall falls fell fallen falling drop drops dropped dropping decrease decreases decreased decreasing lower lowers lowered lowering ' +
  'less fewer smaller lose loses lost losing loss losses reduce reduces reduced reducing reduction reductions down downward downwards ' +
  'decline declines declined declining trail trails trailed trailing shrink shrinks shrank shrunk shrinking halve halves halved halving ' +
  'suppress suppresses suppressed suppressing cut cuts';
const UP = new Set(UP_WORDS.split(' '));
const DOWN = new Set(DOWN_WORDS.split(' '));

const NEGATIONS = new Set(['not', 'no', 'never', 'without', 'cannot', 'neither', 'nor', 'none', 'nothing', 'nowhere', 'fail', 'fails', 'failed', 'unable']);

const STOP = new Set(
  (
    'a an the of to in on at by for with from as is are was were be been being am do does did done has have had having ' +
    'and or but if so then than that this these those it its we our us they their them he she his her which who whom whose ' +
    'what when where while also only very much many more most less least such both each every any some all other others ' +
    'can could may might must shall should will would into onto over under about across after before between during ' +
    'here there thus hence however therefore further furthermore moreover indeed just even still yet again'
  ).split(' '),
);

/** Visible prose of a LaTeX sentence: math, comments and command names removed, lowercased words. */
export function proseWords(latex: string): Array<{ w: string; start: number; end: number }> {
  const text = typeof latex === 'string' ? latex : '';
  let masked = text;
  try {
    const scan = scanLatex(text);
    for (const sp of [...scan.math, ...scan.comments]) masked = masked.slice(0, sp.start) + ' '.repeat(Math.max(0, sp.end - sp.start)) + masked.slice(sp.end);
  } catch {
    /* unreadable LaTeX: use the raw text */
  }
  masked = masked.replace(/\\[A-Za-z]+\*?/g, (m) => ' '.repeat(m.length));
  const out: Array<{ w: string; start: number; end: number }> = [];
  const re = /[A-Za-z]+(?:'[a-z]+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const raw = m[0].toLowerCase();
    if (raw.endsWith("n't")) {
      out.push({ w: raw.slice(0, -3), start: m.index, end: m.index + raw.length - 3 });
      out.push({ w: 'not', start: m.index + raw.length - 3, end: m.index + raw.length });
    } else out.push({ w: raw.replace(/'s$/, ''), start: m.index, end: m.index + raw.length });
  }
  return out;
}

/** Direction words of a sentence with their positions. */
export function directionWords(latex: string): Array<{ dir: Direction; word: string; start: number; end: number }> {
  const out: Array<{ dir: Direction; word: string; start: number; end: number }> = [];
  for (const t of proseWords(latex)) {
    if (UP.has(t.w)) out.push({ dir: 'up', word: t.w, start: t.start, end: t.end });
    else if (DOWN.has(t.w)) out.push({ dir: 'down', word: t.w, start: t.start, end: t.end });
  }
  return out;
}

/** Number of negations in a sentence ("does not", "never", "without", "isn't", "fails to"). */
export function negationCount(latex: string): number {
  return proseWords(latex).filter((t) => NEGATIONS.has(t.w)).length;
}

/** Crude inflection stem: "lowers" -> "lower", "reduced" -> "reduc", "studies" -> "studi". */
export function stem(w: string): string {
  let s = w.toLowerCase();
  if (s.length > 4 && s.endsWith('ies')) s = s.slice(0, -3) + 'i';
  else if (s.length > 4 && /(?:ches|shes|sses|xes|zes)$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss') && !s.endsWith('us') && !s.endsWith('is')) s = s.slice(0, -1);
  if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2);
  else if (s.length > 4 && s.endsWith('ly')) s = s.slice(0, -2);
  if (s.length > 3 && s.endsWith('e')) s = s.slice(0, -1);
  if (s.length > 3 && s.endsWith('i')) s = s.slice(0, -1) + 'y';
  return s;
}

function contentStems(latex: string): string[] {
  return proseWords(latex)
    .map((t) => t.w)
    .filter((w) => !STOP.has(w) && !NEGATIONS.has(w) && w.length > 1)
    .map(stem);
}

function multisetDiff(a: string[], b: string[]): string[] {
  const pool = new Map<string, number>();
  for (const x of b) pool.set(x, (pool.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of a) {
    const n = pool.get(x) ?? 0;
    if (n > 0) pool.set(x, n - 1);
    else out.push(x);
  }
  return out;
}

export interface MeaningChange {
  /** A negation was added or removed. */
  negation: boolean;
  /** The direction words differ (an "up" word became a "down" word or vice versa, or one was added/removed). */
  direction: boolean;
  /** Content words (by stem) added and removed. */
  added: string[];
  removed: string[];
  /** max(added, removed): content-word substitutions. */
  contentChanged: number;
  /** Content words in the original. */
  contentTotal: number;
  /** Normalized word-level edit distance (editDistanceWords). */
  editDistance: number;
}

/** What changed between an original sentence and its rewrite or grammar fix, deterministically. */
export function meaningChange(original: string, revised: string): MeaningChange {
  const a = contentStems(original);
  const b = contentStems(revised);
  const added = multisetDiff(b, a);
  const removed = multisetDiff(a, b);
  const dirSig = (t: string): string =>
    directionWords(t)
      .map((d) => d.dir)
      .sort()
      .join(',');
  let ed = 0;
  try {
    ed = editDistanceWords(original, revised);
  } catch {
    ed = 1;
  }
  return {
    negation: negationCount(original) !== negationCount(revised),
    direction: dirSig(original) !== dirSig(revised),
    added,
    removed,
    contentChanged: Math.max(added.length, removed.length),
    contentTotal: a.length,
    editDistance: ed,
  };
}

/** Limits of a grammar-only fix: at most this many content words substituted, and this share of them. */
export const GRAMMAR_MAX_CONTENT_CHANGES = 3;
export const GRAMMAR_MAX_CONTENT_SHARE = 0.34;
/** A grammar fix that changes more than this share of all words is a rewrite whatever the words are. */
export const GRAMMAR_MAX_EDIT_DISTANCE = 0.6;

/**
 * Is `fixed` a grammar/language fix of `original` (no negation or direction change, a few content-word
 * substitutions at most, not most of the words)? Returns the reasons it is not; [] means it is.
 */
export function grammarOnlyReasons(original: string, fixed: string): string[] {
  const c = meaningChange(original, fixed);
  const why: string[] = [];
  if (c.negation) why.push('adds or removes a negation');
  if (c.direction) why.push('changes a direction word (higher/lower, rises/falls)');
  const share = c.contentTotal > 0 ? c.contentChanged / c.contentTotal : c.contentChanged > 0 ? 1 : 0;
  if (c.contentChanged > GRAMMAR_MAX_CONTENT_CHANGES || (c.contentChanged >= 2 && share > GRAMMAR_MAX_CONTENT_SHARE)) {
    why.push(`changes ${c.contentChanged} content word${c.contentChanged === 1 ? '' : 's'} (${[...c.removed.slice(0, 3), '->', ...c.added.slice(0, 3)].join(' ')})`);
  }
  if (c.editDistance > GRAMMAR_MAX_EDIT_DISTANCE) why.push(`rewrites ${Math.round(c.editDistance * 100)}% of the words`);
  return why;
}
