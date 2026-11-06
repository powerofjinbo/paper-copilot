/**
 * UI strings for codes the server reports: `t(code, lang)` returns the label (or, with field
 * 'explain', the one-line explanation) in Chinese or English.
 *
 * OWNER: core-features agent.
 *
 * Codes are namespaced ('gate.unmatched_number', 'lint.long', 'submission.unreviewed',
 * 'consistency.drift_precision', 'caption.takeaway'); a bare code is looked up in that namespace order.
 * Unknown codes fall back to the English entry, then to the code itself, so a new server code never
 * renders as an empty string.
 */
import { CAPTION_MESSAGES, CONSISTENCY_MESSAGES, GATE_MESSAGES, LINT_CHECK_KEYS, LINT_MESSAGES, SUBMISSION_MESSAGES, type Bilingual, type Message } from './messages';

export { CAPTION_MESSAGES, CONSISTENCY_MESSAGES, GATE_MESSAGES, LINT_CHECK_KEYS, LINT_MESSAGES, SUBMISSION_MESSAGES, type Bilingual, type Message as I18nMessage, type LintCheckKey } from './messages';

export type Lang = 'zh' | 'en';
export type I18nNamespace = 'gate' | 'lint' | 'submission' | 'consistency' | 'caption';

export const I18N_TABLES: Readonly<Record<I18nNamespace, Readonly<Record<string, Bilingual>>>> = {
  gate: GATE_MESSAGES,
  lint: LINT_MESSAGES,
  submission: SUBMISSION_MESSAGES,
  consistency: CONSISTENCY_MESSAGES,
  caption: CAPTION_MESSAGES,
};

const NAMESPACES: readonly I18nNamespace[] = ['gate', 'lint', 'submission', 'consistency', 'caption'];

/**
 * Other names the system uses for a code: the AI-ese linter's pattern kind ('pattern') and its flag
 * source ('aiese', the excess-vocabulary check), style_check.py check numbers ('lint.7', 'lint.check7',
 * as the sidecar reports them) and the gate issue for a flag the lint panel shows ('lint.unmatched_number').
 */
export const I18N_ALIASES: Readonly<Record<string, string>> = {
  'lint.pattern': 'lint.ai_pattern',
  pattern: 'lint.ai_pattern',
  'lint.aiese': 'lint.excess_vocab',
  aiese: 'lint.excess_vocab',
  ...Object.fromEntries(
    (['long', 'verb', 'connectors', 'vocab', 'hype', 'vague', 'acronyms', 'terms', 'figures', 'passive'] as const).flatMap((key, i) => [
      [`lint.${i + 1}`, `lint.${key}`],
      [`lint.check${i + 1}`, `lint.${key}`],
    ]),
  ),
};

/** The bilingual entry of a code ('ns.code', a bare code or an alias), or null. */
export function i18nEntry(code: string): Bilingual | null {
  const raw = String(code ?? '');
  const c = Object.prototype.hasOwnProperty.call(I18N_ALIASES, raw) ? I18N_ALIASES[raw]! : raw;
  const dot = c.indexOf('.');
  if (dot > 0) {
    const ns = c.slice(0, dot) as I18nNamespace;
    const table = I18N_TABLES[ns];
    if (table) {
      if (Object.prototype.hasOwnProperty.call(table, c.slice(dot + 1))) return table[c.slice(dot + 1)]!;
      // a lint flag that carries a gate issue code (the gate's hints in the lint panel)
      return ns === 'lint' && Object.prototype.hasOwnProperty.call(I18N_TABLES.gate, c.slice(dot + 1)) ? I18N_TABLES.gate[c.slice(dot + 1)]! : null;
    }
  }
  for (const ns of NAMESPACES) {
    const table = I18N_TABLES[ns];
    if (Object.prototype.hasOwnProperty.call(table, c)) return table[c]!;
  }
  return null;
}

/** Normalize a language tag ('zh-CN', 'zh_TW', 'en-US', null) to 'zh' or 'en'. */
export function normalizeLang(lang: string | null | undefined): Lang {
  return /^zh\b|^zh[-_]/i.test(String(lang ?? '')) ? 'zh' : 'en';
}

/** Label (default) or explanation of a code in `lang` ('zh' | 'en' or a tag such as 'zh-CN'). */
export function t(code: string, lang: string | null | undefined = 'en', field: keyof Message = 'label'): string {
  const e = i18nEntry(code);
  if (!e) return String(code ?? '');
  const l = normalizeLang(lang);
  return e[l][field] || e.en[field] || String(code);
}

/** Both the label and the explanation of a code in `lang`. */
export function describeCode(code: string, lang: string | null | undefined = 'en'): Message {
  return { label: t(code, lang, 'label'), explain: t(code, lang, 'explain') };
}

/** Every namespaced code with a translation (for tests and for the web client's coverage check). */
export function i18nCodes(): string[] {
  return NAMESPACES.flatMap((ns) => Object.keys(I18N_TABLES[ns]).map((k) => `${ns}.${k}`));
}

