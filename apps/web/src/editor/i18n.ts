/**
 * Editor chrome in the UI language the shell chose (EN / 中文 toggle in the top bar): the sentence card,
 * the slim editor bar and the gutter tooltips. The shell owns the language (state/extra.ts `useShell`);
 * the editor only reads it. English strings are the editor's originals (labels.ts); sentence text, AI
 * notes and instructions are never translated.
 */
import { i18nEntry, t as coreT, type SentenceState, type VersionOrigin } from '@paper-copilot/core';
import { useShell, type Lang } from '../state/extra';
import { ALT_KEY, GHOST_KEY, MOD_KEY, ORIGIN_LABEL, STATE_LABEL, STATE_SHORT } from './labels';

const STATE_LABEL_ZH: Record<SentenceState, string> = {
  human: '你写的',
  'ai-from-intent': 'AI 据你的笔记生成',
  'ai-drafted': 'AI 起草，已接受',
  'ai-edited': 'AI 起草，你已修改',
  proposed: 'AI 提议，尚未审阅',
  external: '在应用外被修改',
  placeholder: '占位符',
  unsupported: '未通过事实检查',
};

const STATE_SHORT_ZH: Record<SentenceState, string> = {
  human: '你写的',
  'ai-from-intent': '据笔记',
  'ai-drafted': 'AI 已接受',
  'ai-edited': 'AI 已修改',
  proposed: '待审阅',
  external: '外部',
  placeholder: '占位符',
  unsupported: '未通过',
};

const ORIGIN_LABEL_ZH: Record<VersionOrigin, string> = {
  import: '导入',
  human_typed: '你输入的',
  human_edit: '你修改的',
  ai_ghost: '接受了补全',
  ai_intent: '由你的笔记生成',
  ai_draft: 'AI 起草',
  ai_rewrite: 'AI 改写',
  grammar_fix: '语法修正',
  replan: '重新规划的修改',
  external_edit: '在应用外被修改',
};

const EN = {
  cardLabel: 'Sentence card: {state}',
  aiTouched: 'AI-touched',
  aiTouchedTitle: 'Some AI text was involved at some point; this never clears.',
  grammarFixed: 'grammar fixed',
  changed: '{n}% changed',
  imported: 'imported',
  close: 'Close sentence card',
  closeTitle: 'Close (Esc)',
  instructionLabel: 'Instruction (中文 or English)',
  rewriteBtn: 'Rewrite',
  recent: 'Recent instructions',
  alternatives: 'Alternatives',
  noAlternatives: 'No alternatives came back.',
  history: 'History',
  noVersions: 'No versions recorded.',
  actions: 'Sentence actions',
  accept: 'Accept',
  discard: 'Discard',
  back: 'Back',
  instruct: 'Instruct',
  grammar: 'Grammar',
  rewriteMyself: 'Rewrite myself',
  reject: 'Reject',
  hintLetters: 'to use the letter keys',
  hintNext: 'next to review',
  grammarOnly: 'Grammar only (minimal change)',
  rewriteFor: 'Rewrite for “{instruction}”',
  rewrite: 'Rewrite',
  driftList: 'Meaning drift checklist',
  'drift.actor': 'actor',
  'drift.scope': 'scope',
  'drift.direction': 'direction',
  'drift.condition': 'condition',
  driftChanged: 'changed',
  driftKept: 'kept',
  factGate: 'Fact gate',
  facts: 'Facts',
  stale: 'stale',
  staleTitle: 'STALE: the artifact changed',
  noFactFor: 'No fact for',
  candidates: 'Candidates: {ids}',
  noCandidate: 'No candidate fact',
  cites: 'cites',
  yourNote: 'your note',
  aiNote: 'AI note',
  referee: 'referee',
  lint: 'Lint',
  corpus: 'corpus',
  you: 'you',
  busyRewrite: 'Rewriting…',
  busyGrammar: 'Checking grammar…',
  busyAlternatives: 'Writing alternatives…',
  busyHistory: 'Loading history…',
  restore: 'Restore this version',
  restoreTitle: 'Put this text back as one change; its provenance is kept (AI text stays AI text)',
  busyRestore: 'Restoring…',
  restored: 'Restored version {n}.',
  restoreNoop: 'The sentence already reads like version {n}.',
  restoreChanged: 'The sentence changed while restoring; open the history again.',
  restoreIssues: 'Restored text: {issues}',
  current: 'current',
  replan: 'Re-plan proposal',
  replanSuggests: 'Re-plan suggests:',
  replanRevise: 'a revision',
  replanDrop: 'dropping this sentence',
  replanInsert: 'a sentence before this one',
  useRevision: 'Use revision',
  deleteSentence: 'Delete sentence',
  insertIt: 'Insert it',
  keep: 'Keep',
  dismiss: 'Dismiss',
  dismissLint: 'Hide this hint for this sentence (kept hidden after re-lint)',
  offline: 'offline: your edits are kept and sent on reconnect',
  toReview: '{n} to review',
  legend: 'Ownership heatmap legend',
  heatmap: 'Ownership',
  heatmapLabel: 'Ownership heatmap: tint sentences by who wrote them',
  heatmapTitle: 'Ownership heatmap ({mod}+{alt}+O)',
  justNow: 'just now',
  minAgo: '{n} min ago',
  hAgo: '{n} h ago',
  dAgo: '{n} d ago',
  notApplied: 'The sentence changed or disappeared; the proposal was not applied.',
  noChange: 'The proposal is identical to your sentence; nothing was changed (it stays yours).',
  irTitle: 'Intent note: excluded from compile and lint. {mod}+Enter renders it into an English sentence.',
  irHint: '{mod}+Enter → English · Alt+Enter → 3 options',
  irGroup: 'English rendering of your note',
  irHead: 'English, in your voice',
  irHeadChoose: 'English, in your voice: choose one',
  irLoading: 'Rendering your note…',
  irLoading3: 'Rendering three options…',
  irFailed: 'Rendering failed.',
  irOptions: 'Proposed sentences',
  ir3: '3 options',
  rwSelected: 'Rewrite in your own words: start typing',
  rwTyping: 'Type your version; the struck words go when you type the final period',
  rwIntent: 'intent',
  rwEsc: 'Esc to finish',
  mono: 'Mono',
  monoTitle: 'Set the whole source in a monospace font (prose is set in a text font by default)',
  noReview: 'nothing left to review',
  noGrounded: 'no grounded suggestion',
  ghostTimeout: 'no answer from the ghost service',
  ghostUnavailable: 'ghost unavailable: {message}',
  questionsOnly: 'questions-only section: see the Questions panel',
  ghostPending: 'Ghost suggestion requested…',
  ghostHint: 'Tab accept · {mod}+→ one word · Esc dismiss',
  opening: 'Opening the document…',
  alreadyAccepted: 'already accepted: {mod}+Enter accepts proposed sentences only',
  syncMerged: '{file}: merged a change from the server (pull, disk edit or another tab) with your unsent typing.',
  syncConflict: '{file}: your edit and a change from the server (pull, disk edit or another tab) touched the same text at line {lines}. Both texts were kept; please check.',
  syncRestored: '{file}: the server restarted without your latest unsaved edits; they were re-sent from the editor.',
  syncRestoredConflict: '{file}: the server restarted, and line {lines} changed both on disk and in the editor. Both versions were kept (the editor version first, the disk version below it); keep the one you want.',
  syncLegacy: '{file}: re-synced with the server by sending the editor text.',
} as const;

export type EdKey = keyof typeof EN;

const ZH: Record<EdKey, string> = {
  cardLabel: '句子卡片：{state}',
  aiTouched: '经过 AI',
  aiTouchedTitle: '这句话曾经有 AI 参与；此标记永不清除。',
  grammarFixed: '已修语法',
  changed: '改动 {n}%',
  imported: '导入',
  close: '关闭句子卡片',
  closeTitle: '关闭 (Esc)',
  instructionLabel: '指令（中文或英文）',
  rewriteBtn: '改写',
  recent: '最近的指令',
  alternatives: '备选',
  noAlternatives: '没有返回备选句。',
  history: '历史',
  noVersions: '没有记录的版本。',
  actions: '句子操作',
  accept: '接受',
  discard: '放弃',
  back: '返回',
  instruct: '指令',
  grammar: '语法',
  rewriteMyself: '自己重写',
  reject: '拒绝',
  hintLetters: '后可用字母键',
  hintNext: '下一句待审阅',
  grammarOnly: '只改语法（最小改动）',
  rewriteFor: '按“{instruction}”改写',
  rewrite: '改写',
  driftList: '语义漂移检查',
  'drift.actor': '主语',
  'drift.scope': '范围',
  'drift.direction': '方向',
  'drift.condition': '条件',
  driftChanged: '有变化',
  driftKept: '未变',
  factGate: '事实检查',
  facts: '事实',
  stale: '已过期',
  staleTitle: '已过期：来源文件已改变',
  noFactFor: '没有对应事实',
  candidates: '候选：{ids}',
  noCandidate: '没有候选事实',
  cites: '引用',
  yourNote: '你的笔记',
  aiNote: 'AI 说明',
  referee: '审稿人',
  lint: '文风提示',
  corpus: '语料',
  you: '你',
  busyRewrite: '正在改写…',
  busyGrammar: '正在检查语法…',
  busyAlternatives: '正在写备选句…',
  busyHistory: '正在加载历史…',
  restore: '恢复此版本',
  restoreTitle: '把这段文字作为一次修改放回原处；来源记录保留（AI 文字仍标为 AI）',
  busyRestore: '正在恢复…',
  restored: '已恢复第 {n} 版。',
  restoreNoop: '这句话已经与第 {n} 版相同。',
  restoreChanged: '恢复时这句话被修改了；请重新打开历史。',
  restoreIssues: '恢复的文字：{issues}',
  current: '当前',
  replan: '重新规划建议',
  replanSuggests: '重新规划建议：',
  replanRevise: '修改这句',
  replanDrop: '删去这句',
  replanInsert: '在前面加一句',
  useRevision: '采用修改',
  deleteSentence: '删除句子',
  insertIt: '插入',
  keep: '保留',
  dismiss: '忽略',
  dismissLint: '隐藏这条提示（重新检查后仍保持隐藏）',
  offline: '离线：你的修改已保留，重新连接后发送',
  toReview: '{n} 句待审阅',
  legend: '归属热图图例',
  heatmap: '归属',
  heatmapLabel: '归属热图：按作者给句子着色',
  heatmapTitle: '归属热图 ({mod}+{alt}+O)',
  justNow: '刚刚',
  minAgo: '{n} 分钟前',
  hAgo: '{n} 小时前',
  dAgo: '{n} 天前',
  notApplied: '句子已改变或已不存在，提议没有应用。',
  noChange: '提议与原句完全相同，未做任何修改（句子仍归你）。',
  irTitle: '意图笔记：不参与编译和文风检查。{mod}+Enter 把它写成一句英文。',
  irHint: '{mod}+Enter → 英文 · Alt+Enter → 3 个选项',
  irGroup: '你的笔记的英文版本',
  irHead: '英文，用你的口吻',
  irHeadChoose: '英文，用你的口吻：选一句',
  irLoading: '正在把笔记写成英文…',
  irLoading3: '正在写三个选项…',
  irFailed: '生成失败。',
  irOptions: '提议的句子',
  ir3: '3 个选项',
  rwSelected: '用你自己的话重写：直接开始输入',
  rwTyping: '输入你的版本；输入句末句号后，划掉的旧词会删除',
  rwIntent: '意图',
  rwEsc: 'Esc 结束',
  mono: '等宽',
  monoTitle: '整个源文件使用等宽字体（默认正文使用文本字体）',
  noReview: '没有待审阅的句子了',
  noGrounded: '没有有依据的补全',
  ghostTimeout: '补全服务没有响应',
  ghostUnavailable: '补全不可用：{message}',
  questionsOnly: '此节只提问题：请看“问题”面板',
  ghostPending: '已请求补全…',
  ghostHint: 'Tab 接受 · {mod}+→ 接受一个词 · Esc 放弃',
  opening: '正在打开文档…',
  alreadyAccepted: '已接受：{mod}+Enter 只接受待审阅的句子',
  syncMerged: '{file}：服务器上的改动（拉取、磁盘修改或另一个标签页）已与你尚未发送的输入合并。',
  syncConflict: '{file}：你的修改和服务器上的改动（拉取、磁盘修改或另一个标签页）改了同一处文字（第 {lines} 行）。两边的文字都保留了，请检查。',
  syncRestored: '{file}：服务器重启后丢失了你最近未保存的修改；已从编辑器重新发送。',
  syncRestoredConflict: '{file}：服务器重启了，第 {lines} 行在磁盘上和编辑器里都被改过。两个版本都保留了：编辑器的在前，磁盘上的在后；请保留你想要的那一个。',
  syncLegacy: '{file}：已用编辑器中的文字与服务器重新同步。',
};

/** The UI language right now (outside React, e.g. CodeMirror gutter markers). */
export function currentLang(): Lang {
  try {
    return useShell.getState().lang === 'zh' ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

export function edText(lang: Lang, key: EdKey, vars?: Record<string, string | number>): string {
  let s: string = lang === 'zh' ? ZH[key] : EN[key];
  // platform key names ({mod}: ⌘ / Ctrl, {alt}: ⌥ / Alt) unless the caller passes its own
  const all: Record<string, string | number> = { mod: MOD_KEY, alt: ALT_KEY, ghostKey: GHOST_KEY, ...vars };
  for (const [k, v] of Object.entries(all)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

export type EdT = (key: EdKey, vars?: Record<string, string | number>) => string;

/** React hook: a translator that re-renders when the UI language changes. */
export function useEdT(): { t: EdT; lang: Lang } {
  const lang = useShell((s) => (s.lang === 'zh' ? 'zh' : 'en'));
  return { t: (key, vars) => edText(lang, key, vars), lang };
}

export function stateLabel(state: SentenceState, lang: Lang = currentLang()): string {
  return lang === 'zh' ? STATE_LABEL_ZH[state] : STATE_LABEL[state];
}

export function stateShort(state: SentenceState, lang: Lang = currentLang()): string {
  return lang === 'zh' ? STATE_SHORT_ZH[state] : STATE_SHORT[state];
}

export function originLabel(origin: VersionOrigin | string, lang: Lang = currentLang()): string {
  const table: Record<string, string> = lang === 'zh' ? ORIGIN_LABEL_ZH : ORIGIN_LABEL;
  return table[origin] ?? origin;
}

/** labels.ts relativeTime in the UI language. */
export function relTime(iso: string | null | undefined, lang: Lang = currentLang(), now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.round((now - t) / 1000);
  if (s < 45) return edText(lang, 'justNow');
  const m = Math.max(1, Math.round(s / 60));
  if (m < 60) return edText(lang, 'minAgo', { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return edText(lang, 'hAgo', { n: h });
  const d = Math.round(h / 24);
  if (d < 30) return edText(lang, 'dAgo', { n: d });
  return new Date(t).toISOString().slice(0, 10);
}

/** Core i18n label of a code in a namespace ('gate', 'lint'), or the bare code when there is none. */
function nsLabel(ns: 'gate' | 'lint', code: string, lang: Lang, field: 'label' | 'explain' = 'label'): string {
  try {
    const key = `${ns}.${code}`;
    return i18nEntry(key) ? coreT(key, lang, field) : code;
  } catch {
    return code;
  }
}

/** Label of a faithfulness-gate issue code ("unmatched_number" -> "Number not in the facts" / "数字无出处"). */
export function issueLabel(code: string, lang: Lang = currentLang()): string {
  return nsLabel('gate', code, lang);
}

/** Label of a lint check key ("long", "hype", "7", "pattern", "aiese" ...). */
export function lintLabel(check: string, lang: Lang = currentLang()): string {
  return nsLabel('lint', check, lang);
}

/** One-line explanation of a lint check ('' when the core has none). */
export function lintExplain(check: string, lang: Lang = currentLang()): string {
  const s = nsLabel('lint', check, lang, 'explain');
  return s === check ? '' : s;
}
