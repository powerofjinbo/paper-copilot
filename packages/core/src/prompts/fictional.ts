/**
 * Numbers from the skill's invented examples, and cleanup of single-sentence model output.
 */
import { cmp, normText } from './xml';
import { extractNumeralDetails } from '../facts/numerals';

const DRAFT_START = /^\s*\*\*Draft violation and fix\.?\*\*/;
const DRAFT_END = /^\s*(?:\*\*Boundaries\.?\*\*|\*\*Rule\.?\*\*|\*\*Exemplars\.?\*\*|#{1,6}\s)/;
/** "- Before: ...", "*After:* ...", "> Before: ...", "1. After: ..." */
const BEFORE_AFTER = /^\s*(?:(?:[-*+>]|\d+[.)])\s+)*[*_]{0,2}(?:Before|After)[*_]{0,2}\s*[:：]/;

/**
 * Numerals with a decimal point or with 2+ digits. Digits glued to letters (`q0`, `L1`, `2nd`, `3D`) and
 * structural numbers right after Fig./Figure/Table/Sec./Section/Appendix/Eq./slip are skipped.
 */
const NUM = /(?<![\p{L}\p{N}_.,])(\d{1,3}(?:,\d{3})+(?![\d,])|\d+)(\.\d+)?(?![\p{L}\p{N}_])/gu;
const STRUCT_BEFORE = /(?:\bFigs?\.|\bFigures?|\bTables?|\bTab\.|\bSecs?\.|\bSections?|\bApp\.|\bAppendix|\bEqs?\.|\bEquations?|\bslip|\bstep|¶|§)\s*$/i;

/** Word numerals of an example line ("a hundredfold", "five times", "thirty percent"), as their normalized phrase. */
function wordNumbersIn(text: string, out: Set<string>): void {
  try {
    // a bare small cardinal ("at least three segments") is too generic to mark; factors, percents and
    // large cardinals are the invented results
    for (const t of extractNumeralDetails(text.replace(/[*_]/g, ' '))) {
      if (t.word && !t.structural && t.phrase && (t.factor || t.percent || t.points || t.value > 10)) out.add(t.phrase);
    }
  } catch {
    /* an unreadable line adds nothing */
  }
}

function numbersIn(text: string, out: Set<string>): void {
  wordNumbersIn(text, out);
  NUM.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUM.exec(text))) {
    const int = m[1] ?? '';
    const frac = m[2] ?? '';
    const digits = int.replace(/,/g, '');
    if (!frac && digits.length < 2) continue;
    if (STRUCT_BEFORE.test(text.slice(Math.max(0, m.index - 14), m.index))) continue;
    out.add(digits + frac);
  }
}

/**
 * Numbers in the "**Draft violation and fix.**" sections (up to "**Boundaries.**") and in any line that
 * starts with "Before:" / "After:" in the reference files: digit numerals sorted by value, then text,
 * followed by the word numerals of those lines as phrases ("hundredfold", "five times", "three times"),
 * sorted; no duplicates. The gate matches a word numeral against these phrases.
 */
export function fictionalNumbers(references: Record<string, string>): string[] {
  const out = new Set<string>();
  const refs = references && typeof references === 'object' ? references : {};
  for (const name of Object.keys(refs).sort(cmp)) {
    const text = normText(refs[name]);
    let inDraft = false;
    for (const line of text.split('\n')) {
      if (DRAFT_START.test(line)) {
        inDraft = true;
        numbersIn(line.replace(DRAFT_START, ''), out);
        continue;
      }
      if (inDraft && DRAFT_END.test(line)) inDraft = false;
      if (inDraft || BEFORE_AFTER.test(line)) numbersIn(line, out);
    }
  }
  // numerals by value, then the word phrases ("five times", "hundredfold") alphabetically
  const nums = [...out].filter((x) => /^[\d.]+$/.test(x)).sort((a, b) => Number(a) - Number(b) || cmp(a, b));
  const words = [...out].filter((x) => !/^[\d.]+$/.test(x)).sort(cmp);
  return [...nums, ...words];
}

/* ------------------------------------------------------------------------------------ */
/* cleanModelSentence                                                                    */
/* ------------------------------------------------------------------------------------ */

const QUOTE_PAIRS: Array<[string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['«', '»'],
  ['「', '」'],
  ['『', '』'],
];

const LABEL =
  /^(?:(?:here\s+(?:is|are)|here's)\b[^:\n]{0,80}[:：]\s*|(?:(?:the\s+)?(?:revised|rewritten|corrected|edited|new|final|improved|suggested|proposed|polished|english|next|continued|completed)\s+)?(?:sentence|text|rewrite|revision|version|output|answer|result|translation|suggestion|continuation|completion|proposal|alternative|option)(?:\s*(?:#\s*)?\d+)?\s*[:：]\s*|(?:句子|改写|改写后|修改后|译文|翻译|结果|建议)\s*[:：]\s*)/i;
const BULLET = /^(?:[-*+•·]\s+|\d{1,2}[.)]\s+|>\s*)/;

function stripOnce(s: string): string {
  let t = s.trim();
  // fenced code block: keep its content
  const fence = /^```[\w-]*\s*\n?([\s\S]*?)\n?```$/.exec(t);
  if (fence) return (fence[1] ?? '').trim();
  t = t.replace(BULLET, '');
  t = t.replace(LABEL, '');
  // bold/italic wrapper
  const em = /^(\*\*|__)([\s\S]+)\1$/.exec(t);
  if (em && !(em[2] ?? '').includes(em[1] ?? '')) t = (em[2] ?? '').trim();
  // inline code wrapper (never touches LaTeX ``quotes'', which end with '')
  if (t.length >= 2 && t.startsWith('`') && t.endsWith('`') && !t.startsWith('``')) {
    const inner = t.slice(1, -1);
    if (!inner.includes('`')) t = inner.trim();
  }
  for (const [o, c] of QUOTE_PAIRS) {
    if (t.length >= 2 && t.startsWith(o) && t.endsWith(c)) {
      const inner = t.slice(o.length, t.length - c.length);
      // only when the pair wraps the whole text, not `"a" and "b"`
      if (!inner.includes(o) && !inner.includes(c)) {
        t = inner.trim();
        break;
      }
    }
  }
  return t;
}

/** Strip wrappers a model may add around one sentence: surrounding quotes/backticks, "Sentence:" labels, markdown bullets. */
export function cleanSentence(text: string): string {
  let t = normText(typeof text === 'string' ? text : '').trim();
  if (!t) return '';
  const fenced = /```[\w-]*\s*\n([\s\S]*?)\n?```/.exec(t);
  if (fenced && !/^```/.test(t)) t = (fenced[1] ?? '').trim();
  // Anything after the first blank line is commentary ("Note: ...").
  t = t.split(/\n[ \t]*\n/)[0] ?? '';
  // A trailing "(Note: ...)" / "Note: ..." line.
  t = t.replace(/\n\s*(?:\(?\s*(?:note|notes|explanation|changes?|注|说明)\s*[:：][\s\S]*)$/i, '');
  for (let i = 0; i < 6; i++) {
    const next = stripOnce(t);
    if (next === t) break;
    t = next;
  }
  return t.trim();
}
