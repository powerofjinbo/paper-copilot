/**
 * Deterministic, LaTeX-safe "simulated rewrites" shared by the in-browser demo (apps/web mock client) and
 * the server's fake LLM (PAPER_FAKE_LLM=1 / no API key). Nothing here calls a model: each transform is a
 * fixed, keyword-chosen edit of the sentence (plain words for inflated ones, verb first, baseline first,
 * split at a semicolon or which-clause) that never touches a LaTeX token, number, \cite or \ref, so the
 * rewrite passes the faithfulness gate's invariance check. Notes are returned in English and Chinese.
 */
export interface Rewrite {
  text: string;
  /** What changed, per language (empty when nothing changed). */
  en: string;
  zh: string;
}

const INFLATED: Array<[RegExp, string]> = [
  [/\bIn order to\b/g, 'To'],
  [/\bin order to\b/g, 'to'],
  [/\butilizes\b/g, 'uses'],
  [/\butilized\b/g, 'used'],
  [/\butilizing\b/g, 'using'],
  [/\butilize\b/g, 'use'],
  [/\bleverages\b/g, 'uses'],
  [/\bleveraged\b/g, 'used'],
  [/\bleveraging\b/g, 'using'],
  [/\bleverage\b/g, 'use'],
  [/\bfacilitates\b/g, 'helps'],
  [/\bfacilitate\b/g, 'help'],
  [/\ba large number of\b/g, 'many'],
  [/\bis able to\b/g, 'can'],
  [/\bare able to\b/g, 'can'],
  [/\bdue to the fact that\b/g, 'because'],
  [/\bthe fact that\b/g, 'that'],
  [/\bvery\s+/g, ''],
  [/\breally\s+/g, ''],
];

export function capitalize(s: string): string {
  return s.replace(/^(\s*)([a-z])/, (_m, sp: string, c: string) => sp + c.toUpperCase());
}

function lowerFirst(s: string): string {
  // Keep acronyms and proper names: only lower-case a capitalized ordinary word.
  return s.replace(/^([A-Z])([a-z])/, (_m, a: string, b: string) => a.toLowerCase() + b);
}

export function plainWords(s: string): Rewrite {
  let t = s;
  for (const [re, rep] of INFLATED) t = t.replace(re, rep);
  t = t.replace(/^(\s*)(?:Moreover|Furthermore|Additionally|It is worth noting that),?\s+(\S)/, (_m, sp: string, c: string) => sp + c.toUpperCase());
  return t === s ? { text: s, en: '', zh: '' } : { text: t, en: 'replaced inflated words and filler with plain ones', zh: '把冗词换成了简单的词' };
}

/** Split off the sentence's trailing part: "; see Fig..." or the final punctuation. */
function splitTail(s: string): { main: string; tail: string } {
  const semi = s.indexOf('; ');
  if (semi > 0) return { main: s.slice(0, semi), tail: s.slice(semi) };
  const m = /([.?!]["”’)\]]*)\s*$/.exec(s);
  if (m) return { main: s.slice(0, m.index), tail: s.slice(m.index) };
  return { main: s, tail: '' };
}

const OPENER = /^(\s*)((?:In|On|For|At|With|Using|After|Before|Within|Across|Over|Under|By|Among)\s[^,;$\\]{2,60}),\s+(.+)$/s;

export function verbFirst(s: string): Rewrite {
  const m = OPENER.exec(s);
  if (!m) return { text: s, en: '', zh: '' };
  const [, sp = '', opener = '', rest = ''] = m;
  const { main, tail } = splitTail(rest);
  if (!main.trim()) return { text: s, en: '', zh: '' };
  const text = `${sp}${capitalize(main)} ${lowerFirst(opener)}${tail}`;
  return { text, en: 'moved the opening phrase after the verb, so the subject and verb come first', zh: '把句首的状语移到动词之后，让主语和动词先出现' };
}

export function baselineFirst(s: string): Rewrite {
  const m = /^(\s*)(.+?),\s+compared with\s+((?:[^,;.]|\.(?=\d))+)([,;.].*)$/s.exec(s);
  if (!m) return { text: s, en: '', zh: '' };
  const [, sp = '', main = '', baseline = '', tail = ''] = m;
  const end = tail.startsWith(',') ? tail.slice(1).trimStart() : tail;
  const text = end.startsWith('.') || end.startsWith(';') ? `${sp}Compared with ${baseline}, ${lowerFirst(main)}${end}` : `${sp}Compared with ${baseline}, ${lowerFirst(main)}, ${end}`;
  return { text, en: 'put the baseline at the start of the sentence', zh: '把基线放在了句首' };
}

export function splitSentence(s: string): Rewrite {
  const semi = /^(.+?);\s+(\S.*)$/s.exec(s);
  if (semi) {
    const [, a = '', b = ''] = semi;
    return { text: `${a}. ${capitalize(b)}`, en: 'split the sentence in two at the semicolon', zh: '在分号处拆成了两句' };
  }
  const which = /^(.+?),\s+which\s+(\S.*)$/s.exec(s);
  if (which) {
    const [, a = '', b = ''] = which;
    return { text: `${a}. This ${b}`, en: 'split off the which-clause as its own sentence', zh: '把 which 从句拆成了单独一句' };
  }
  return { text: s, en: '', zh: '' };
}

type Transform = (s: string) => Rewrite;

function transformsFor(instruction: string): Transform[] {
  const i = instruction.toLowerCase();
  if (/基线|baseline|对比|比较|compar/.test(i)) return [baselineFirst, verbFirst, plainWords];
  if (/动词|主语|verb|subject|前置|front|先说/.test(i)) return [verbFirst, plainWords, baselineFirst];
  if (/拆|分成|split|short|简短|简洁|太长|long/.test(i)) return [splitSentence, plainWords, verbFirst];
  return [plainWords, verbFirst, splitSentence, baselineFirst];
}

/** One deterministic rewrite guided by keywords of the instruction; never changes LaTeX tokens. */
export function simulatedRewrite(sentence: string, instruction: string): Rewrite {
  for (const tf of transformsFor(instruction)) {
    const r = tf(sentence);
    if (r.text !== sentence) {
      const p = plainWords(r.text);
      return p.text !== r.text ? { text: p.text, en: `${r.en}; ${p.en}`, zh: `${r.zh}；${p.zh}` } : r;
    }
  }
  return { text: sentence, en: '', zh: '' };
}

/** Up to n distinct alternatives. */
export function simulatedAlternatives(sentence: string, n: number): Rewrite[] {
  const out: Rewrite[] = [];
  const seen = new Set<string>([sentence]);
  for (const tf of [verbFirst, splitSentence, baselineFirst, plainWords]) {
    if (out.length >= n) break;
    const r = tf(sentence);
    if (!seen.has(r.text)) {
      seen.add(r.text);
      out.push(r);
    }
  }
  return out;
}
