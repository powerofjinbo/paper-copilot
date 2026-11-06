/**
 * Deterministic "simulated AI" for the in-browser demo. Nothing here calls a model: every text is
 * built from fixed templates and from real fact values, and every note says "(simulated)" /
 * "（模拟）". The MockApiClient runs each sentence through core gateSentence before it offers it.
 */
import type { Fact, NotesLanguage, Outline, RefereeQuestion } from '@paper-copilot/core';
import { factBySuffix } from './mockData';

export const SIM_EN = '(simulated)';
export const SIM_ZH = '（模拟）';
export const SIM_MODEL = 'simulated';

export function simTag(lang: NotesLanguage): string {
  return lang === 'zh' ? SIM_ZH : SIM_EN;
}

/* ------------------------------------------------------------------------------------ */
/* Fact renderings (always from the fact store, so the gate can match them)              */
/* ------------------------------------------------------------------------------------ */

export interface FactWords {
  effA: string;
  effB: string;
  delta: string;
  sigma: string;
  fakeA: string;
  fakeB: string;
  n: string;
  margin: string;
  ids: Record<string, string>;
}

function num(f: Fact | undefined): number | null {
  return f && typeof f.value === 'number' ? f.value : null;
}

function pct(f: Fact | undefined, digits = 2): string {
  const v = num(f);
  return v === null ? '[fact?: efficiency]' : `${(v * 100).toFixed(digits)}\\%`;
}

function fixed(f: Fact | undefined, digits = 2): string {
  const v = num(f);
  return v === null ? '[fact?: value]' : v.toFixed(digits);
}

function count(f: Fact | undefined): string {
  const v = num(f);
  if (v === null) return '[fact?: count]';
  return Math.round(v).toLocaleString('en-US');
}

export function factWords(facts: Fact[]): FactWords {
  const pick = (k: string) => factBySuffix(facts, k);
  const ids: Record<string, string> = {};
  for (const k of ['eff_A', 'eff_B', 'delta_points', 'sigma_points', 'fake_rate_A', 'fake_rate_B', 'n_targets', 'margin']) {
    const f = pick(k);
    if (f) ids[k] = f.id;
  }
  return {
    effA: pct(pick('eff_A')),
    effB: pct(pick('eff_B')),
    delta: fixed(pick('delta_points')),
    sigma: fixed(pick('sigma_points')),
    fakeA: pct(pick('fake_rate_A')),
    fakeB: pct(pick('fake_rate_B')),
    n: count(pick('n_targets')),
    margin: fixed(pick('margin'), 1),
    ids,
  };
}

/* ------------------------------------------------------------------------------------ */
/* Ghost continuation                                                                    */
/* ------------------------------------------------------------------------------------ */

const VERBS = new Set(['is', 'are', 'was', 'were', 'reaches', 'reach', 'gives', 'give', 'yields', 'yield', 'becomes', 'remains', 'stays']);
const PREPS = new Set(['of', 'for', 'with', 'than', 'at', 'on', 'in', 'to', 'by', 'from', 'against']);
const DETS = new Set(['the', 'a', 'an', 'this', 'its', 'their', 'our', 'that']);
const PRONOUNS = new Set(['we', 'they']);

/**
 * Candidate continuations of the sentence typed so far, best first. Each continues `prefix`
 * verbatim (the returned strings are only the part after the prefix) and uses real fact numbers.
 * `needsSpace` tells whether the character before the cursor is not whitespace.
 */
export function ghostCandidates(prefix: string, w: FactWords, needsSpace: boolean): string[] {
  const p = prefix.replace(/\s+$/, '');
  const sp = needsSpace ? ' ' : '';
  const result = `the new tracker finds ${w.effA} of the targets, compared with ${w.effB} for the baseline.`;
  if (!p) {
    return [
      `${sp}The efficiency difference is ${w.delta} points, with a total uncertainty of ${w.sigma} points.`,
      `${sp}The new tracker finds ${w.effA} of the targets, compared with ${w.effB} for the baseline.`,
      `${sp}The fake-track rate is ${w.fakeA} against ${w.fakeB} for the baseline.`,
    ];
  }
  const last = (/([A-Za-z]+)[^A-Za-z]*$/.exec(p)?.[1] ?? '').toLowerCase();
  if (/[,;:]$/.test(p)) return [`${sp}${result}`, `${sp}the difference is ${w.delta} points.`];
  if (PRONOUNS.has(last)) return [`${sp}find an efficiency of ${w.effA}, compared with ${w.effB} for the baseline.`, `${sp}find a difference of ${w.delta} points.`];
  if (VERBS.has(last)) return [`${sp}${w.delta} points higher than for the baseline, with a total uncertainty of ${w.sigma} points.`, `${sp}${w.effA} for the new tracker.`];
  if (PREPS.has(last)) return [`${sp}the ${w.n} targets of the test set.`, `${sp}the baseline, which finds ${w.effB} of the targets.`];
  if (DETS.has(last)) return [`${sp}new tracker finds ${w.effA} of the targets, compared with ${w.effB} for the baseline.`, `${sp}difference of ${w.delta} points.`];
  return [`${sp}finds ${w.effA} of the targets, compared with ${w.effB} for the baseline.`, `${sp}reaches an efficiency of ${w.effA}.`, `${sp}gives a difference of ${w.delta} points.`];
}

/* ------------------------------------------------------------------------------------ */
/* Rewrites (instruct, alternatives), grammar, intent rendering                          */
/* ------------------------------------------------------------------------------------ */

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

function capitalize(s: string): string {
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
  const m = /^(\s*)(.+?),\s+compared with\s+([^,;.]+)([,;.].*)$/s.exec(s);
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

const VOWEL_AN_EXCEPTIONS = /^(?:one|once|uni|use|usu|eu|ur)/i;

/** Grammar-only: articles, doubled words, double spaces. Nothing else. */
export function simulatedGrammar(sentence: string): Rewrite {
  const en: string[] = [];
  const zh: string[] = [];
  let t = sentence;
  const t1 = t.replace(/\b(the|a|an|of|to|and|is|in)\s+\1\b/gi, '$1');
  if (t1 !== t) {
    en.push('removed a doubled word');
    zh.push('删去重复的词');
    t = t1;
  }
  const t2 = t.replace(/\b([Aa])\s+([aeioAEIO][a-z]+)/g, (m0, a: string, w: string) => (VOWEL_AN_EXCEPTIONS.test(w) ? m0 : `${a}n ${w}`));
  if (t2 !== t) {
    en.push('"a" before a vowel became "an"');
    zh.push('元音前的 a 改为 an');
    t = t2;
  }
  const t3 = t.replace(/\b([Aa])n\s+([bcdfgjklmnpqrstvwxyzBCDFGJKLMNPQRSTVWXYZ][a-z]+)/g, '$1 $2');
  if (t3 !== t) {
    en.push('"an" before a consonant became "a"');
    zh.push('辅音前的 an 改为 a');
    t = t3;
  }
  const t4 = t.replace(/([^\s]) {2,}(?=\S)/g, '$1 ');
  if (t4 !== t) {
    en.push('removed a double space');
    zh.push('删去多余空格');
    t = t4;
  }
  return { text: t, en: en.join('; '), zh: zh.join('；') };
}

/** English renderings of an intent note, best first (keyword routing, fact numbers only). */
export function simulatedIntent(note: string, w: FactWords): string[] {
  const result = `The new tracker finds ${w.effA} of the targets, compared with ${w.effB} for the signal-trained baseline.`;
  const diff = `The efficiency difference is ${w.delta} points, with a total uncertainty of ${w.sigma} points.`;
  const fake = `The fake-track rate is ${w.fakeA} against ${w.fakeB} for the baseline.`;
  const size = `The test set holds ${w.n} targets.`;
  if (/假|fake/i.test(note)) return [fake, result, diff];
  if (/差|提高|提升|gain|differ/i.test(note)) return [diff, result, fake];
  if (/样本|数量|多少|target|sample/i.test(note)) return [size, result, diff];
  return [result, diff, fake];
}

/* ------------------------------------------------------------------------------------ */
/* Drafts, framings, referee questions                                                   */
/* ------------------------------------------------------------------------------------ */

export interface DraftSeed {
  text: string;
  move: string;
  factKeys: string[];
  noteZh: string;
  noteEn: string;
  refereeQuestion: string | null;
  /** Expected to fail the gate (it holds numbers that are in no fact). */
  expectUnsupported: boolean;
}

/** Two sentences that pass the gate and one that does not (it lands as `unsupported`). */
export function draftSeeds(w: FactWords): DraftSeed[] {
  return [
    {
      text: `The new tracker finds ${w.effA} of the ${w.n} targets, compared with ${w.effB} for acorn (HNL) with the same track builder.`,
      move: 'result',
      factKeys: ['eff_A', 'n_targets', 'eff_B'],
      noteZh: '（模拟）主结果：效率与基线放在同一句里。',
      noteEn: '(simulated) The main result, with its baseline in the same sentence.',
      refereeQuestion: null,
      expectUnsupported: false,
    },
    {
      text: `The difference, ${w.delta} points with a total uncertainty of ${w.sigma} points, is larger than the pre-registered margin of ${w.margin} points.`,
      move: 'significance',
      factKeys: ['delta_points', 'sigma_points', 'margin'],
      noteZh: '（模拟）给出差值、总不确定度和预注册的门槛。',
      noteEn: '(simulated) The difference, its total uncertainty and the pre-registered margin.',
      refereeQuestion: 'Is the margin fixed before the result was seen?',
      expectUnsupported: false,
    },
    {
      text: 'The gain grows to 3.1 points for particles produced more than 300 mm from the beam line.',
      move: 'mechanism',
      factKeys: [],
      noteZh: '（模拟）这句的数字不在事实库中，未通过检查，标为“未支持”。',
      noteEn: '(simulated) Its numbers are not in the fact store, so it failed the gate and lands as unsupported.',
      refereeQuestion: null,
      expectUnsupported: true,
    },
  ];
}

export function simulatedFramings(outline: Outline, w: FactWords): string[] {
  const contrast = outline.contrast.text.trim() || outline.gap.text.trim();
  const story = outline.story.text.trim();
  const key = outline.story.keyPhrase.trim();
  return [
    `Result first: a tracker trained without the signal finds ${w.delta} points more displaced targets than the signal-trained baseline, at a lower fake-track rate.`,
    `Contrast first: ${contrast ? contrast.replace(/[.\s]+$/, '') : 'standard trackers are trained on the signal they are meant to find'}; we show that this is not needed${key ? `, which is the point of "${key}"` : ''}.`,
    `Question first: can a tracker that never saw the signal find displaced particles as well as one trained on it? ${story ? `Our answer: ${story.replace(/[.\s]+$/, '')}.` : 'On this test set it finds more.'}`,
  ];
}

export function simulatedReferee(sectionId: string, title: string, lang: NotesLanguage, w: FactWords, firstSentenceId: string | null): Array<Omit<RefereeQuestion, 'id'>> {
  const zh = lang === 'zh';
  const t = `${title} ${sectionId}`.toLowerCase();
  const q = (question: string, estimate: string | null, anchored = true): Omit<RefereeQuestion, 'id'> => ({ sectionId, sentenceId: anchored ? firstSentenceId : null, question, estimate });
  const deltaN = Number(w.delta);
  const sigmaN = Number(w.sigma);
  const signif = Number.isFinite(deltaN) && Number.isFinite(sigmaN) && sigmaN > 0 ? (deltaN / sigmaN).toFixed(1) : null;
  if (/result/.test(t)) {
    return [
      q(zh ? `${SIM_ZH}${w.delta} 个百分点的差值，相对于三个训练种子的离散是否显著？` : `${SIM_EN} Is the ${w.delta}-point difference significant given the spread of the three training seeds?`, signif ? (zh ? `${w.delta} / ${w.sigma} ≈ ${signif} 倍总不确定度` : `${w.delta} / ${w.sigma} ≈ ${signif} total sigma`) : null),
      q(zh ? `${SIM_ZH}基线是否使用了相同的轨迹构建器、相同的样本和相同的工作点？` : `${SIM_EN} Does the baseline use the same track builder, sample and working point?`, null, false),
      q(zh ? `${SIM_ZH}假轨迹率 ${w.fakeA} 和 ${w.fakeB} 是在什么条件下比较的？` : `${SIM_EN} Under which condition are the fake-track rates ${w.fakeA} and ${w.fakeB} compared?`, null, false),
    ];
  }
  if (/intro/.test(t)) {
    return [
      q(zh ? `${SIM_ZH}引言里的“信号”具体指哪个样本？测试集与训练集是什么关系？` : `${SIM_EN} Which sample is "the signal" in the introduction, and how does the test set relate to training?`, null),
      q(zh ? `${SIM_ZH}最接近的前人工作没有做的那一件事，是否在一句话里说清楚了？` : `${SIM_EN} Does one sentence say what the closest earlier work did not do?`, null, false),
    ];
  }
  if (/method|selection/.test(t)) {
    return [
      q(zh ? `${SIM_ZH}效率的分子和分母是否来自同一个粒子集合？` : `${SIM_EN} Do the numerator and denominator of the efficiency use the same population?`, null),
      q(zh ? `${SIM_ZH}“双多数”匹配对很短的轨迹是否过于宽松？` : `${SIM_EN} Is double-majority matching too loose for very short tracks?`, null, false),
    ];
  }
  if (/conclu/.test(t)) {
    return [q(zh ? `${SIM_ZH}结论是否重复了摘要中的同一个数字和同一个条件？` : `${SIM_EN} Do the conclusions repeat the abstract's number and condition?`, null)];
  }
  return [q(zh ? `${SIM_ZH}这一节回答的问题是什么？第一句话是否说明了这一点？` : `${SIM_EN} Which question does this section answer, and does its first sentence say so?`, null)];
}
