/**
 * Labels and one-line explanations, in English and Chinese, for every code the panels show: gate issue
 * codes, lint check keys (style_check.py's ten checks, the AI-ese linter, the gate's claim-strength hint),
 * submission checklist items, consistency/terminology/figure-plan flag kinds and caption checklist keys.
 *
 * OWNER: core-features agent. Each table is typed as a complete record of its code union, so adding a
 * code without a translation fails the typecheck.
 */
import type { CaptionCheckKey, ConsistencyFlagKind, SubmissionItemId } from '../api';
import type { GateIssueCode } from '../gate/gate';

export interface Message {
  label: string;
  explain: string;
}
export interface Bilingual {
  en: Message;
  zh: Message;
}

const m = (enLabel: string, enExplain: string, zhLabel: string, zhExplain: string): Bilingual => ({ en: { label: enLabel, explain: enExplain }, zh: { label: zhLabel, explain: zhExplain } });

export const GATE_MESSAGES: Record<GateIssueCode, Bilingual> = {
  unmatched_number: m('Number not in the facts', 'This number matches no fact of the analysis; it was replaced by a [fact?: ...] placeholder.', '数字无出处', '该数字与分析结果中的任何事实都不对应，已替换为 [fact?: ...] 占位符。'),
  unmatched_cut: m('Cut not in the facts', 'A value with a unit next to a comparison reads as a selection cut, but no cut or definition has it.', '选择条件无出处', '带单位且有比较符号的数值像是选择条件，但没有对应的 cut 或定义。'),
  percent_scale: m('Percent or fraction mix-up', 'The number fits a fact only at another scale (0.97 vs 97%, percent vs percentage points).', '百分比与小数混淆', '该数字只有换算尺度后才与事实相符（0.97 与 97%，百分比与百分点）。'),
  factor_percent: m('Factor and percent mixed', 'The same result is given both as a factor and as a percent; keep one form.', '倍数与百分比混用', '同一结果同时用倍数和百分比表述，请统一一种。'),
  unknown_cite: m('Unknown citation', 'The citation key is not in the resolved bibliography; it was replaced by [ref].', '未知引用', '引用键不在已核实的参考文献中，已替换为 [ref]。'),
  unknown_ref: m('Unknown reference target', 'The \\ref target does not exist in the project.', '交叉引用目标不存在', '\\ref 指向的标签在项目中不存在。'),
  latex_changed: m('Notation changed', 'The AI changed a \\cite, \\ref, \\label, math or macro; these must stay exactly as written.', 'LaTeX 记号被改动', 'AI 改动了 \\cite、\\ref、\\label、公式或宏，这些必须保持原样。'),
  fictional_number: m('Number from the skill examples', 'The number comes from the writing skill’s invented examples, not from this analysis.', '来自示例的虚构数字', '该数字来自写作技能中的虚构示例，而非本分析。'),
  duplicate_placeholder: m('Duplicate placeholder', 'The same placeholder appears twice; give each missing item its own description.', '重复占位符', '同一占位符出现两次，请分别描述缺失的内容。'),
  claim_strength: m('Claim stronger than the evidence', 'A strong verb (exclude, demonstrate, improve) needs a linked fact of matching strength.', '论断强于证据', '强动词（排除、证明、提升）需要有相应强度的事实支撑。'),
  cjk_in_text: m('Chinese text in the paper', 'Chinese/CJK characters must not reach the English paper text.', '正文含中文', '中文（CJK）字符不能出现在英文正文中。'),
  too_long: m('Sentence too long', 'The sentence exceeds the word limit; split it or cut a clause.', '句子过长', '句子超过字数上限，请拆分或删去一个从句。'),
  reasoning_leak: m('Model chatter', 'The output reads like model reasoning or chat, not one paper sentence.', '模型自述泄漏', '输出像是模型的推理或对话，而不是一句论文正文。'),
  empty: m('Empty output', 'The model returned no sentence.', '空输出', '模型没有返回句子。'),
  unlinked_number: m('Number from your note', 'Accepted because you typed it in your note; it is not linked to a fact yet.', '来自笔记的数字', '因你在笔记中写过而被接受，但尚未关联到事实。'),
  number_changed: m('Number dropped or changed', 'The rewrite lost or changed a number of the original; keep every number.', '数字被删改', '改写丢失或改变了原句中的数字，请保留所有数字。'),
  bad_latex: m('Broken LaTeX', 'A bare % after a number comments out the rest of the line; write \\%.', 'LaTeX 错误', '数字后的裸 % 会注释掉本行其余内容，请写成 \\%。'),
  loose_number: m('Number in words', 'A result restated in words or as a rough ratio; write the measured value as a numeral.', '数字以文字表述', '结果用文字或粗略比例表述，请写出带精度的测量值。'),
  direction: m('Direction contradicts the sign', 'The direction word (higher, lower, rises) contradicts the sign of the linked difference.', '方向与符号矛盾', '方向词（更高、更低、上升）与所关联差值的符号相反。'),
  meaning_changed: m('Meaning changed', 'A negation or a direction word changed; this is not a grammar-only fix.', '语义被改变', '否定词或方向词发生了变化，这不只是语法修正。'),
  gate_error: m('Check failed', 'The faithfulness check failed internally; the sentence is not shown as grounded.', '检查出错', '忠实性检查内部出错，该句不被视为有依据。'),
};

/** style_check.py check keys (checks 1-10), the AI-ese linter and the gate's lint hints. */
export const LINT_CHECK_KEYS = ['long', 'verb', 'connectors', 'vocab', 'hype', 'vague', 'acronyms', 'terms', 'figures', 'passive', 'excess_vocab', 'ai_pattern', 'claim_strength'] as const;
export type LintCheckKey = (typeof LINT_CHECK_KEYS)[number];

export const LINT_MESSAGES: Record<LintCheckKey, Bilingual> = {
  long: m('Long sentence', 'Longer than the corpus norm for this part of the paper; split it at the clause boundary.', '长句', '比语料中该部分的常见长度更长，请在从句处拆分。'),
  verb: m('Late main verb', 'The main verb comes late; put the subject and verb first.', '主动词靠后', '主动词出现得太晚，请把主语和动词放在前面。'),
  connectors: m('Stock connector', 'A filler opener (Moreover, Furthermore, It is worth noting that); start with the content.', '套话连接词', '套话式开头（Moreover、Furthermore、It is worth noting that），请直接说内容。'),
  vocab: m('Inflated word', 'An inflated word or phrase with a plain alternative (utilize → use).', '浮夸用词', '有更朴素替代的浮夸词语（utilize → use）。'),
  hype: m('Hype or intensifier', 'An intensifier or hype word (very, novel, remarkable) the evidence does not need.', '夸张或强调词', '证据并不需要的强调或夸张词（very、novel、remarkable）。'),
  vague: m('Vague result claim', 'A result claim without a number or a baseline; give the value and what it is compared with.', '模糊的结果表述', '结果表述没有数字或比较基准，请给出数值和比较对象。'),
  acronyms: m('Acronym', 'An acronym used before its definition, never defined, or defined only in the abstract.', '缩写', '缩写在定义前使用、从未定义，或只在摘要中定义。'),
  terms: m('Term variant', 'One term written in several ways (hyphen, case, spelling); keep one.', '术语写法不一', '同一术语有多种写法（连字符、大小写、拼写），请统一。'),
  figures: m('Figure reference', 'A figure or table reference form that differs from the corpus (passive "is shown in").', '图表引用方式', '图表引用方式与语料不同（被动的 "is shown in"）。'),
  passive: m('Passive voice', 'More passive voice than the corpus norm; say who does what.', '被动语态', '被动语态多于语料常见水平，请说明谁做了什么。'),
  excess_vocab: m('LLM-marker word', 'A word whose frequency rose sharply with LLM-assisted writing (Kobak et al. 2025); keep it only if it is exact.', 'AI 腔词汇', '在 LLM 辅助写作中频率激增的词（Kobak 等 2025），只在确实贴切时保留。'),
  ai_pattern: m('AI-style pattern', 'A phrase pattern typical of AI text ("not only ... but also", "plays a crucial role"); heuristic.', 'AI 式句型', 'AI 文本常见的句型（"not only ... but also"、"plays a crucial role"），启发式判断。'),
  claim_strength: m('Claim stronger than the evidence', 'A strong verb (exclude, demonstrate, improve) needs a linked fact of matching strength.', '论断强于证据', '强动词（排除、证明、提升）需要有相应强度的事实支撑。'),
};

export const SUBMISSION_MESSAGES: Record<SubmissionItemId, Bilingual> = {
  unreviewed: m('Unreviewed AI sentences', 'AI-proposed sentences still waiting for your review; accept, edit or reject each.', '未审阅的 AI 句子', '仍有 AI 提议的句子等待审阅，请逐句接受、修改或拒绝。'),
  unsupported: m('Unsupported AI sentences', 'AI sentences that failed the faithfulness check; rewrite or reject them.', '未通过核查的 AI 句子', '未通过忠实性检查的 AI 句子，请重写或拒绝。'),
  placeholders: m('Placeholders', 'Sentences with [fact?: ...], [ref] or [claim: ...?]; fill in or remove them.', '占位符', '含有 [fact?: ...]、[ref] 或 [claim: ...?] 的句子，请补全或删除。'),
  intent_lines: m('Intent notes', 'Lines with your (Chinese) intent notes are still in the source; render or delete them.', '意图笔记', '源文件中仍有中文意图笔记行，请转写成英文或删除。'),
  cjk: m('Chinese text', 'Chinese/Japanese/Korean characters outside comments.', '中文字符', '注释之外仍有中日韩字符。'),
  merge_conflicts: m('Merge conflicts', 'Unresolved merge markers (<<<<<<<, =======, >>>>>>>).', '合并冲突', '存在未解决的合并冲突标记（<<<<<<<、=======、>>>>>>>）。'),
  compile_errors: m('Compile errors', 'The paper does not compile cleanly (or has not been compiled yet).', '编译错误', '论文无法正常编译（或尚未编译）。'),
  undefined_cites: m('Undefined citations', '\\cite keys that are not in the .bib file.', '未定义的引用', '\\cite 中的键不在 .bib 文件里。'),
  ai_unmatched_numbers: m('AI numbers without a source', 'Numbers in AI-touched sentences that match no fact or derived relation.', 'AI 句中数字无出处', 'AI 参与过的句子中有数字与任何事实或派生关系都不对应。'),
  stale_facts: m('Stale facts', 'Sentences state facts whose result files changed since they were linked.', '过期事实', '句子引用的事实所在结果文件已经改变。'),
  disclosure: m('AI disclosure', 'AI-assisted text needs the venue’s disclosure statement in the main file.', 'AI 使用声明', '使用了 AI 辅助写作，主文件中需要包含期刊要求的声明。'),
  unresolved_cites: m('Unverified citations', 'Citations in the .bib that are not resolved on INSPIRE nor confirmed by you.', '未核实的引用', '.bib 中的引用尚未在 INSPIRE 上核实，也未经你确认。'),
  unmatched_numbers: m('Numbers without a source', 'Numbers in your own sentences that match no fact; check them against the analysis.', '数字无出处', '你自己写的句子中有数字不对应任何事实，请与分析结果核对。'),
  echo_drift: m('Inconsistent numbers', 'The same result is stated with different values, precision or form across the paper.', '数字前后不一致', '同一结果在文中以不同数值、精度或形式出现。'),
  uncited_floats: m('Uncited figures and tables', 'Floats that the text never cites.', '未被引用的图表', '正文从未引用的图或表。'),
  acronyms_before_definition: m('Acronyms before definition', 'Acronyms used before they are defined.', '缩写先用后定义', '缩写在定义之前就被使用。'),
  lint_warnings: m('Style warnings', 'Open style, AI-ese and claim-strength warnings.', '文风警告', '尚未处理的文风、AI 腔和论断强度警告。'),
  ambiguous_numbers: m('Ambiguous numbers', 'Numerals that fit several facts with different values; link the one you mean.', '有歧义的数字', '数字同时符合多个不同数值的事实，请关联你指的那一个。'),
};

export const CONSISTENCY_MESSAGES: Record<ConsistencyFlagKind, Bilingual> = {
  drift_precision: m('Precision drift', 'The same quantity is quoted with different precision in different places.', '精度不一致', '同一数值在不同位置以不同精度给出。'),
  drift_form: m('Form drift', 'The same quantity is a percent in one place and a fraction in another.', '形式不一致', '同一数值在一处是百分比，另一处是小数。'),
  drift_value: m('Value drift (heuristic)', 'A number matches no fact but is close to one stated elsewhere; an old or mistyped copy?', '数值漂移（启发式）', '某数字不对应任何事实，但接近文中别处的数值，可能是旧值或笔误。'),
  factor_percent: m('Factor vs percent', 'One comparison is given as a factor in one place and as a percent in another.', '倍数与百分比', '同一比较在一处用倍数，另一处用百分比。'),
  condition_dropped: m('Condition dropped (heuristic)', 'A headline number appears without the condition the body states with it.', '条件缺失（启发式）', '主要数字出现时缺少正文中与之同时给出的条件。'),
  stale_fact: m('Stale fact', 'The result file behind this number changed; reread the sentences.', '事实已过期', '该数字所依据的结果文件已改变，请重读相关句子。'),
  ambiguous_number: m('Ambiguous number', 'The numeral fits several facts with different values.', '数字有歧义', '该数字同时符合多个不同数值的事实。'),
  key_phrase_missing: m('Key phrase missing', 'The story’s key phrase is not echoed in the title, abstract, contribution or conclusions.', '缺少关键短语', '故事的关键短语没有在标题、摘要、贡献句或结论中呼应。'),
  key_phrase_partial: m('Key phrase reworded', 'The words of the key phrase are there, but not the phrase itself.', '关键短语被改写', '关键短语的词都在，但不是原短语。'),
  no_contribution_sentence: m('No contribution sentence', 'The introduction has no "In this paper, we ..." sentence.', '缺少贡献句', '引言中没有 "In this paper, we ..." 这样的贡献句。'),
  headline_missing: m('Headline number missing', 'The headline number of the outline is not stated in the abstract or conclusions.', '缺少主要数字', '大纲中的主要数字没有出现在摘要或结论中。'),
  headline_baseline: m('Headline without baseline', 'The headline number appears without the baseline it is compared with.', '主要数字缺少基准', '主要数字出现时没有给出其比较基准。'),
  headline_condition: m('Headline without condition', 'The headline number appears without its condition (heuristic).', '主要数字缺少条件', '主要数字出现时没有给出其适用条件（启发式）。'),
  acronym_before_definition: m('Acronym before definition', 'The acronym is used before it is defined.', '缩写先用后定义', '缩写在定义之前就被使用。'),
  acronym_undefined: m('Acronym never defined', 'The acronym is never spelled out.', '缩写未定义', '缩写从未给出全称。'),
  acronym_abstract_only: m('Acronym defined only in the abstract', 'Define it again at its first use in the main text.', '缩写只在摘要中定义', '请在正文首次出现时再定义一次。'),
  acronym_abstract_undefined: m('Acronym undefined in the abstract', 'The abstract is read alone: spell the acronym out there.', '摘要中缩写未定义', '摘要会被单独阅读，请在摘要中写出全称。'),
  acronym_redefined: m('Acronym defined twice', 'The acronym is defined more than once; once is enough.', '缩写重复定义', '缩写被定义了不止一次，一次即可。'),
  acronym_defined_unused: m('Acronym defined but unused', 'Defined and never used again; spell the term out instead.', '缩写定义后未使用', '定义后再未使用，不如直接写全称。'),
  variant_hyphen: m('Hyphenation variants', 'One term written hyphenated, open and closed (pile-up, pile up, pileup).', '连字符写法不一', '同一术语有连字符、分开和连写多种形式（pile-up、pile up、pileup）。'),
  variant_case: m('Capitalization variants', 'One term capitalized in different ways mid-sentence.', '大小写不一', '同一术语在句中的大小写不一致。'),
  variant_spelling: m('US/UK spelling mixed', 'British and American spellings are mixed (favour/favor, -ise/-ize).', '英美拼写混用', '英式和美式拼写混用（favour/favor，-ise/-ize）。'),
  float_uncited: m('Float not cited', 'The figure or table is never cited in the text.', '图表未被引用', '正文从未引用这张图或表。'),
  float_order: m('Cited out of order', 'The float is cited before a float with a lower number.', '引用顺序错乱', '该图表在编号更小的图表之前就被引用。'),
  float_no_label: m('Float without label', 'The float has no \\label, so the text cannot cite it.', '图表缺少标签', '图表没有 \\label，正文无法引用。'),
  float_no_caption: m('Float without caption', 'The float has no caption.', '图表缺少图注', '图表没有图注。'),
  caption_anatomy: m('Caption checklist', 'The caption may lack a part: quantity vs variable, conditions, key, panel map, takeaway (heuristic).', '图注要素', '图注可能缺少某些要素：量与变量、条件、图例、分图说明、结论（启发式）。'),
  claim_figure_missing: m('Claim figure missing', 'The figure that carries this claim is not in the paper yet.', '论点对应的图缺失', '承载该论点的图尚未出现在论文中。'),
  claim_figure_uncited: m('Claim figure not cited', 'The figure that carries this claim is never cited in the text.', '论点对应的图未被引用', '承载该论点的图在正文中从未被引用。'),
};

export const CAPTION_MESSAGES: Record<CaptionCheckKey, Bilingual> = {
  quantity: m('Quantity vs variable', 'Says what is plotted against what ("efficiency versus displacement").', '量与变量', '说明画的是什么量随什么变化（"efficiency versus displacement"）。'),
  conditions: m('Conditions', 'Says for which sample, selection or setting the plot holds.', '条件', '说明图对应的样本、选择条件或设置。'),
  encoding: m('Encoding key', 'Says what the lines, markers, bands and colours mean.', '图例说明', '说明线型、标记、误差带和颜色的含义。'),
  panels: m('Panel map', 'For several panels, says what each panel shows ((a), (b), left, right).', '分图说明', '多个子图时，说明每个子图的内容（(a)、(b)、左、右）。'),
  takeaway: m('Reading rule or takeaway', 'Tells the reader how to read it or what to see ("a ratio above one means ...").', '读图要点', '告诉读者如何读图或应看出什么（"a ratio above one means ..."）。'),
};
