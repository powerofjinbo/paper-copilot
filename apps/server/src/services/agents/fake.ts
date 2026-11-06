/**
 * FAKE MODE (ctx.fakeLlm): deterministic, schema-valid stand-ins for every agent, computed only from
 * the inputs, so the whole pipeline (post-processing, gate, storage, events) runs without an API key.
 * Every output is labelled: notes start with "（模拟）" (zh) or "(simulated)" (en).
 * Nothing here invents a number: fact candidates are locators into real files (the facts service reads
 * the values), and drafted numbers are the facts' own renderings.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import type {
  EditPair,
  Fact,
  FramingsOutput,
  MemoOutput,
  Outline,
  OutlineParagraph,
  OutlineSection,
  RefereeOutput,
  RepoBriefOutput,
} from '@paper-copilot/core';
import { isSecretPath } from './guard';
import type { ProposeInput, Verdict } from './collector';

export type Lang = 'zh' | 'en';

export function simLabel(lang: Lang): string {
  return lang === 'zh' ? '（模拟）' : '(simulated) ';
}

/* ------------------------------------------------------------------------------------ */
/* Repo reader                                                                           */
/* ------------------------------------------------------------------------------------ */

const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'build', 'dist', '.venv', 'venv']);
const MAX_FILES = 300;

/** Files under `root` matching any glob (POSIX relative paths, sorted), secret-looking files excluded. */
export function inventory(root: string, globs: string[]): Array<{ path: string; bytes: number }> {
  const out: Array<{ path: string; bytes: number }> = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || out.length >= MAX_FILES) return;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (out.length >= MAX_FILES) return;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!name.startsWith('.') && !SKIP_DIRS.has(name)) walk(full, depth + 1);
        continue;
      }
      const rel = relative(root, full).split(sep).join('/');
      if (isSecretPath(full)) continue;
      if (globs.length === 0 || globs.some((g) => posix.matchesGlob(rel, g))) out.push({ path: rel, bytes: st.size });
    }
  };
  walk(root, 0);
  return out;
}

function escapePointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

function idPart(s: string): string {
  return s.replace(/\.[^.]+$/, '').replace(/_claim$/, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

/** Fact candidates (locators only) for the numeric leaves of a JSON artifact. */
export function jsonCandidates(repoDir: string, rel: string, limit = 24): RepoBriefOutput['fact_candidates'] {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(join(repoDir, rel), 'utf8'));
  } catch {
    return [];
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const obj = data as Record<string, unknown>;
  const meta = ['claim', 'A', 'B', 'population', 'split', 'sample', 'model', 'label']
    .filter((k) => typeof obj[k] === 'string')
    .map((k) => `${k} = ${String(obj[k])}`);
  const condition = ['population', 'split', 'sample'].filter((k) => typeof obj[k] === 'string').map((k) => `${k} ${String(obj[k])}`).join('; ');
  const stem = idPart(rel.split('/').pop() ?? rel);
  const out: RepoBriefOutput['fact_candidates'] = [];
  const push = (pointer: string, label: string) => {
    if (out.length >= limit) return;
    out.push({
      proposed_id: `f.${stem}.${label}`,
      definition_paraphrase: `${label.replace(/_/g, ' ')} in ${rel}${meta.length ? ` (${meta.join(', ')})` : ''}`,
      artifact: rel,
      locator: pointer,
      kind: 'number',
      condition,
    });
  };
  for (const [k, v] of Object.entries(obj)) if (typeof v === 'number' && Number.isFinite(v)) push(`#/${escapePointer(k)}`, idPart(k));
  for (const [k, v] of Object.entries(obj)) {
    if (!Array.isArray(v)) continue;
    v.forEach((x, i) => {
      if (typeof x === 'number' && Number.isFinite(x)) push(`#/${escapePointer(k)}/${i}`, `${idPart(k)}_${i}`);
    });
  }
  return out;
}

/** `- **Term**: definition` lines of markdown docs. */
export function markdownTerms(text: string): Array<{ term: string; definition: string }> {
  const out: Array<{ term: string; definition: string }> = [];
  const re = /^\s*(?:[-*]\s+)?\*\*([^*\n]{2,80})\*\*\s*:\s*(.+)$/gm;
  for (const m of text.matchAll(re)) {
    const term = m[1]!.trim();
    const sentence = (m[2]!.match(/^.*?[.;](?=\s|$)/)?.[0] ?? m[2]!).trim();
    if (!out.some((t) => t.term.toLowerCase() === term.toLowerCase())) out.push({ term, definition: sentence.slice(0, 240) });
  }
  return out;
}

export function fakeRepoBrief(i: { repoDir: string; globs: string[]; factGlobs: string[]; lang: Lang }): RepoBriefOutput {
  const L = simLabel(i.lang);
  const files = inventory(i.repoDir, [...new Set([...i.globs, ...i.factGlobs])]);
  let readme = '';
  try {
    readme = readFileSync(join(i.repoDir, 'README.md'), 'utf8');
  } catch {
    readme = '';
  }
  const headings = readme.split('\n').filter((l) => /^#{1,6}\s/.test(l)).map((l) => l.trim());
  const firstPara = readme
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith('#'));
  const jsonFiles = files.filter((f) => f.path.endsWith('.json') && i.factGlobs.some((g) => posix.matchesGlob(f.path, g)));
  const candidates = jsonFiles.flatMap((f) => jsonCandidates(i.repoDir, f.path)).slice(0, 60);
  const figures = files
    .filter((f) => /^figures\//.test(f.path) && /\.(pdf|png|jpe?g|svg|eps)$/i.test(f.path))
    .map((f) => ({ path: f.path, job: `${L}figure found in the repository; its job is not known yet`, status: 'exists' as const }));
  const terminology = files
    .filter((f) => f.path.endsWith('.md') && f.path !== 'README.md')
    .flatMap((f) => {
      try {
        return markdownTerms(readFileSync(join(i.repoDir, f.path), 'utf8'));
      } catch {
        return [];
      }
    })
    .slice(0, 40);
  const unknowns =
    i.lang === 'zh'
      ? [`${L}哪些结果文件是权威来源，需要作者确认。`, `${L}图的生成脚本未知（模拟模式不读取代码）。`]
      : [`${L}Which result files are authoritative needs the author's confirmation.`, `${L}Figure producer scripts are unknown (simulated mode reads no code).`];
  const md = [
    `# Repository brief ${L.trim()}`,
    '',
    `> ${L}Built without a model from the README headings and the file inventory. Fact values are read by code at their locators, never from this text.`,
    '',
    '## Project summary',
    '',
    firstPara ?? '(no README found)',
    '',
    '## README outline',
    '',
    ...(headings.length ? headings.map((h) => `- ${h.replace(/^#+\s*/, '')}`) : ['- (none)']),
    '',
    '## Files in the reading scope',
    '',
    ...(files.length ? files.map((f) => `- \`${f.path}\` (${f.bytes} bytes)`) : ['- (none)']),
    '',
    '## Result artifacts',
    '',
    ...(jsonFiles.length ? jsonFiles.map((f) => `- \`${f.path}\`: ${candidates.filter((c) => c.artifact === f.path).length} numeric fields`) : ['- (none)']),
    '',
    '## Terminology',
    '',
    ...(terminology.length ? terminology.map((t) => `- **${t.term}**: ${t.definition}`) : ['- (none)']),
    '',
    '## Unknowns',
    '',
    ...unknowns.map((u) => `- ${u}`),
    '',
  ].join('\n');
  return { brief_markdown: md, fact_candidates: candidates, figures, terminology, unknowns };
}

/* ------------------------------------------------------------------------------------ */
/* Outliner                                                                              */
/* ------------------------------------------------------------------------------------ */

const trimEnd = (s: string) => s.trim().replace(/[.;:!?\s]+$/, '');

/** Three framings that only rearrange the author's own five items. */
export function fakeFramings(outline: Outline, lang: Lang): FramingsOutput {
  const L = simLabel(lang);
  const story = trimEnd(outline.story.text) || trimEnd(outline.headline.text) || 'the paper';
  const gap = trimEnd(outline.gap.text);
  const enabler = trimEnd(outline.enabler.text);
  const contrast = trimEnd(outline.contrast.text);
  const headline = trimEnd(outline.headline.text);
  const zh = lang === 'zh';
  return {
    framings: [
      { text: `${L}${gap ? `${gap}. ` : ''}${story}.`, why: `${L}${zh ? '先讲空白，再给出故事句（漏斗式引言）。' : 'Gap first, then the story sentence (funnel opening).'}` },
      { text: `${L}${contrast ? `${contrast}. ` : enabler ? `${enabler}. ` : ''}${story}.`, why: `${L}${zh ? '先点明本文改变的那一个假设，再讲结果。' : 'Name the one assumption the paper changes, then the result.'}` },
      { text: `${L}${headline ? `${headline}. ` : ''}${enabler ? `${enabler}.` : `${story}.`}`, why: `${L}${zh ? '结果先行：先给头条数字及其基线，再讲为什么现在能做到。' : 'Result first: the headline with its baseline, then why it is possible now.'}` },
    ],
  };
}

/* ------------------------------------------------------------------------------------ */
/* Drafter                                                                               */
/* ------------------------------------------------------------------------------------ */

export interface FakeDraftHint {
  /** Add one sentence with a number no fact supports; it is resubmitted unchanged and lands 'unsupported'. */
  unsupported?: boolean;
  /** Add one such sentence but replace its number with a placeholder on the retry (lands 'proposed'). */
  retryFixes?: boolean;
}

const CJK = /[⺀-鿿가-힯豈-﫿＀-￯　-〿]/g;

/** A plain English statement from plan text: no digits (numbers come only from facts), no CJK. */
export function planStatement(raw: string, fallback: string): string {
  const s = raw.replace(CJK, ' ').replace(/\S*\d\S*/g, ' ').replace(/[\\{}$%&#^_~]/g, ' ').replace(/\s+/g, ' ').trim();
  const body = trimEnd(s);
  if (body.split(' ').filter(Boolean).length < 3) return fallback;
  return body.charAt(0).toUpperCase() + body.slice(1);
}

function rendering(f: Fact): string | null {
  if (f.kind !== 'number' || typeof f.value !== 'number') return null;
  const alias = f.aliases.find((a) => a.trim().length > 0);
  return alias ? alias.trim() : null;
}

/** A sentence with a number that no fact supports (searched against the gate, so it really fails). */
export function unsupportedSentence(fails: (text: string) => boolean): string {
  for (const x of ['7.77', '8.88', '9.99', '77.7', '88.8', '6.66', '55.5']) {
    const t = `The improvement reaches ${x} points over the baseline.`;
    if (fails(t)) return t;
  }
  return 'The improvement reaches 7.77 points over the baseline.';
}

export function fakeParagraph(i: {
  section: OutlineSection;
  paragraph: OutlineParagraph;
  facts: Fact[];
  allowedKeys: string[];
  fromNotes: boolean;
  lang: Lang;
  extraSentence: string | null;
}): ProposeInput {
  const L = simLabel(i.lang);
  const zh = i.lang === 'zh';
  const byId = new Map(i.facts.map((f) => [f.id, f]));
  const notes = i.fromNotes && i.paragraph.intentNotes.length ? `${zh ? '意图笔记' : 'intent notes'}: ${i.paragraph.intentNotes.join(' / ')}` : '';
  const note = (what: string) => `${L}${zh ? '依据段落计划：' : 'from the paragraph plan: '}${what}${notes ? `; ${notes}` : ''}`;
  const sentences: ProposeInput['sentences'] = [];
  const job = i.paragraph.job || i.section.question || i.section.title;
  sentences.push({
    text: `${planStatement(job, `This paragraph addresses ${planStatement(i.section.title, 'this section').toLowerCase()}`)}.`,
    move: i.paragraph.moves[0] ?? null,
    fact_ids: [],
    cite_keys: [],
    placeholders: [],
    note_zh: note(job),
    referee_question: null,
  });
  i.paragraph.plan.remaining.forEach((step, k) => {
    const used = step.factIds.map((id) => byId.get(id)).filter((f): f is Fact => !!f && rendering(f) !== null);
    const keys = step.citeKeys.filter((key) => i.allowedKeys.includes(key));
    let text = planStatement(step.intent, `We state point ${['one', 'two', 'three', 'four', 'five', 'six'][k] ?? 'next'} of this paragraph`);
    if (used.length) text += `: ${used.map((f) => rendering(f)!).join(' against ')}`;
    if (keys.length) text += `~\\cite{${keys.join(',')}}`;
    sentences.push({
      text: `${text}.`,
      move: step.move,
      fact_ids: used.map((f) => f.id),
      cite_keys: keys,
      placeholders: [],
      note_zh: note(step.intent),
      referee_question: null,
    });
  });
  if (i.extraSentence) {
    sentences.push({ text: i.extraSentence, move: 'result', fact_ids: [], cite_keys: [], placeholders: [], note_zh: `${L}${zh ? '故意加入的无依据数字（测试）' : 'deliberately unsupported number (test)'}`, referee_question: null });
  }
  return { pid: i.paragraph.pid, job: i.paragraph.job, sentences };
}

/**
 * The fake model's reaction to a refused attempt: failing sentences are replaced by the gate's own
 * repaired text (numbers become [fact?: ...] placeholders), except the deliberately unsupported one
 * when `keepFailing` is set, which is resubmitted unchanged.
 */
export function fakeRevise(input: ProposeInput, verdict: Verdict, keepFailing: (text: string) => boolean): ProposeInput {
  const fix = new Map(verdict.failing.map((f) => [f.index, f.repaired]));
  return {
    ...input,
    sentences: input.sentences.map((s, idx) => {
      const repaired = fix.get(idx);
      if (repaired === undefined || keepFailing(s.text)) return s;
      return { ...s, text: repaired.trim() || s.text };
    }),
  };
}

/* ------------------------------------------------------------------------------------ */
/* Referee                                                                               */
/* ------------------------------------------------------------------------------------ */

export function fakeReferee(units: Array<{ text: string }>, lang: Lang): RefereeOutput {
  const L = simLabel(lang);
  const zh = lang === 'zh';
  const find = (re: RegExp) => units.find((u) => re.test(u.text))?.text ?? null;
  const hint = (t: string | null) => (t ? t.slice(0, 120) : null);
  const withNumber = find(/\d/);
  const resultVerb = find(/\b(find|finds|found|improv\w*|outperform\w*|holds?|higher|lower|better|more than|less than)\b/i);
  const uncertainty = find(/\\pm|±|\buncertaint|\bpoints?\b|\\%|%/);
  const figure = find(/\\(?:ref|cref|autoref)\{(?:fig|tab)/);
  const qs: RefereeOutput['questions'] = [];
  if (withNumber || units.length) {
    qs.push({
      question: zh
        ? `${L}本节每个数字对应的基线是什么？是否在相同条件下（同一样本、选择和训练种子）比较？`
        : `${L}Which baseline is each number in this section compared with, and under the same conditions (sample, selection, training seeds)?`,
      sentence_hint: hint(withNumber ?? units[0]?.text ?? null),
      estimate: null,
    });
  }
  qs.push({
    question: zh ? `${L}主要结论在什么条件下成立（哪个模拟、哪个样本）？条件是否紧跟在数字旁边？` : `${L}Under which condition does the main claim hold (which simulation, which sample)? Is the condition stated next to the number?`,
    sentence_hint: hint(resultVerb),
    estimate: null,
  });
  if (uncertainty) {
    qs.push({
      question: zh ? `${L}头条差值的不确定度是多少，如何估计（自助法、种子间离散）？` : `${L}What is the uncertainty on the headline difference, and how was it estimated (bootstrap, spread over seeds)?`,
      sentence_hint: hint(uncertainty),
      estimate: null,
    });
  }
  if (figure) {
    qs.push({
      question: zh ? `${L}图或表是否显示了正文所说的全部内容，基线曲线是否在同一张图上？` : `${L}Does the figure or table show everything the text claims, with the baseline in the same panel?`,
      sentence_hint: hint(figure),
      estimate: null,
    });
  }
  return { questions: qs.slice(0, 4) };
}

/* ------------------------------------------------------------------------------------ */
/* Voice memo                                                                            */
/* ------------------------------------------------------------------------------------ */

export function fakeMemo(currentMemo: string, pairs: EditPair[], lang: Lang): MemoOutput {
  const L = simLabel(lang);
  const zh = lang === 'zh';
  const mean = pairs.length ? pairs.reduce((a, p) => a + p.editDistance, 0) / pairs.length : 0;
  const bySection = new Map<string, number>();
  for (const p of pairs) bySection.set(p.sectionType, (bySection.get(p.sectionType) ?? 0) + 1);
  const byInstruction = new Map<string, string[]>();
  for (const p of pairs) if (p.instruction) byInstruction.set(p.instruction, [...(byInstruction.get(p.instruction) ?? []), p.sentenceId]);
  const sections = [...bySection.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s, c]) => `${s} ${c}`).join(', ');
  const instructions = [...byInstruction.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).slice(0, 5);
  const lines = [
    `${L}${zh ? `根据 ${pairs.length} 条编辑对更新（平均编辑距离 ${mean.toFixed(2)}）。` : `Updated from ${pairs.length} edit pairs (mean edit distance ${mean.toFixed(2)}).`}`,
    `- ${L}${zh ? '按章节：' : 'By section: '}${sections || '-'}`,
    ...instructions.map(([ins, ids]) => `- ${L}${zh ? '常用指令' : 'Frequent instruction'} "${ins}" (${ids.length}; ${ids.slice(0, 3).join(', ')})`),
  ];
  const kept = currentMemo
    .split('\n')
    .filter((l) => l.trim() && !l.includes(simLabel('zh').trim()) && !l.includes(simLabel('en').trim()));
  return { memo_markdown: [...lines, ...(kept.length ? ['', ...kept] : [])].join('\n') + '\n' };
}
