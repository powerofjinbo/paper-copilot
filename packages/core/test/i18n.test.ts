/**
 * i18n: Chinese and English labels and one-line explanations for every gate issue code, lint check key
 * (the skill's style_check.py checks, the AI-ese linter), submission item id, consistency flag kind and
 * caption checklist key; `t(code, lang)` lookups and fallbacks.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CaptionCheckKey, ConsistencyFlagKind, SubmissionItemId } from '../src/api';
import { describeCode, i18nCodes, i18nEntry, I18N_ALIASES, I18N_TABLES, LINT_CHECK_KEYS, normalizeLang, t } from '../src/i18n/index';

const CJK = /[一-鿿]/;
const src = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

/** GateIssueCode members, read from the union in gate.ts (so a new code without a translation fails here too). */
const GATE_CODES = [...(/export type GateIssueCode =([^;]+);/.exec(src('../src/gate/gate.ts'))![1]!.matchAll(/'([a-z_]+)'/g))].map((m) => m[1]!);
/** style_check.py CHECKS keys, from the user's skill script (the sidecar maps check numbers to these). */
const STYLE_CHECK_KEYS = [...(/CHECKS = \[([\s\S]*?)\n\]/.exec(src('../../../.skill/scripts/style_check.py'))![1]!.matchAll(/\(\d+, '([a-z]+)'/g))].map((m) => m[1]!);

describe('coverage', () => {
  it('reads the code lists it checks against', () => {
    expect(GATE_CODES).toContain('unmatched_number');
    expect(GATE_CODES.length).toBeGreaterThanOrEqual(21);
    expect(STYLE_CHECK_KEYS).toEqual(['long', 'verb', 'connectors', 'vocab', 'hype', 'vague', 'acronyms', 'terms', 'figures', 'passive']);
  });

  const namespaces: Array<[string, readonly string[]]> = [
    ['gate', GATE_CODES],
    ['lint', [...STYLE_CHECK_KEYS, 'excess_vocab', 'ai_pattern', 'claim_strength']],
    ['submission', SubmissionItemId.options],
    ['consistency', ConsistencyFlagKind.options],
    ['caption', CaptionCheckKey.options],
  ];
  for (const [ns, codes] of namespaces) {
    it(`${ns}: every code has zh and en labels and explanations, and nothing extra`, () => {
      expect(Object.keys(I18N_TABLES[ns as keyof typeof I18N_TABLES]).sort()).toEqual([...codes].sort());
      for (const c of codes) {
        const e = i18nEntry(`${ns}.${c}`)!;
        expect(e, c).not.toBeNull();
        for (const lang of ['en', 'zh'] as const) {
          expect(e[lang].label.trim().length, `${c} ${lang}`).toBeGreaterThan(1);
          expect(e[lang].explain.trim().length, `${c} ${lang}`).toBeGreaterThan(lang === 'zh' ? 4 : 8);
          expect(e[lang].label.length, `${c} ${lang} label stays short`).toBeLessThanOrEqual(40);
        }
        expect(e.zh.label, c).toMatch(CJK);
        expect(e.zh.explain, c).toMatch(CJK);
        expect(e.en.label + e.en.explain, c).not.toMatch(CJK);
      }
    });
  }

  it('labels are distinct inside a namespace (a panel can tell items apart)', () => {
    for (const [ns, table] of Object.entries(I18N_TABLES)) {
      for (const lang of ['en', 'zh'] as const) {
        const labels = Object.entries(table).filter(([k]) => !(ns === 'lint' && k === 'claim_strength')).map(([, v]) => v[lang].label);
        expect(new Set(labels).size, `${ns} ${lang}`).toBe(labels.length);
      }
    }
  });

  it('LINT_CHECK_KEYS lists the lint table', () => {
    expect([...LINT_CHECK_KEYS].sort()).toEqual(Object.keys(I18N_TABLES.lint).sort());
    expect(i18nCodes()).toContain('lint.passive');
    expect(i18nCodes().length).toBe(Object.values(I18N_TABLES).reduce((n, tb) => n + Object.keys(tb).length, 0));
  });
});

describe('t(code, lang)', () => {
  it('returns the label in the asked language; namespaced and bare codes', () => {
    expect(t('gate.unmatched_number', 'en')).toBe('Number not in the facts');
    expect(t('gate.unmatched_number', 'zh')).toBe('数字无出处');
    expect(t('unmatched_number', 'zh')).toBe('数字无出处');
    expect(t('submission.unreviewed', 'zh')).toBe('未审阅的 AI 句子');
    expect(t('consistency.drift_precision', 'en')).toBe('Precision drift');
    expect(t('lint.long', 'zh')).toBe('长句');
    expect(t('caption.takeaway', 'en', 'explain')).toMatch(/how to read it/);
  });

  it('bare codes resolve in namespace order (gate before lint for claim_strength)', () => {
    expect(i18nEntry('claim_strength')).toBe(I18N_TABLES.gate.claim_strength);
    expect(t('lint.claim_strength', 'en')).toBe(t('gate.claim_strength', 'en'));
  });

  it('normalizes language tags and falls back safely', () => {
    expect(normalizeLang('zh-CN')).toBe('zh');
    expect(normalizeLang('zh_TW')).toBe('zh');
    expect(normalizeLang('en-US')).toBe('en');
    expect(normalizeLang(null)).toBe('en');
    expect(normalizeLang('fr')).toBe('en');
    expect(t('gate.unmatched_number', 'zh-Hans')).toBe('数字无出处');
    expect(t('no_such_code', 'zh')).toBe('no_such_code');
    expect(t('gate.no_such_code', 'en')).toBe('gate.no_such_code');
    expect(t('toString', 'en')).toBe('toString');
    expect(t('gate.constructor', 'en')).toBe('gate.constructor');
    expect(t(undefined as unknown as string)).toBe('');
  });

  it('describeCode returns both strings', () => {
    expect(describeCode('submission.disclosure', 'zh')).toEqual({ label: 'AI 使用声明', explain: expect.stringMatching(/声明/) });
  });
});

describe('aliases: the names the lint pipeline actually emits', () => {
  it('style_check numbers, the AI-ese kinds and source, gate codes under lint', () => {
    STYLE_CHECK_KEYS.forEach((key, i) => {
      expect(t(`lint.${i + 1}`, 'zh')).toBe(t(`lint.${key}`, 'zh'));
      expect(t(`lint.check${i + 1}`, 'en')).toBe(t(`lint.${key}`, 'en'));
    });
    expect(t('lint.pattern', 'en')).toBe(t('lint.ai_pattern', 'en'));
    expect(t('pattern', 'zh')).toBe('AI 式句型');
    expect(t('lint.aiese', 'zh')).toBe(t('lint.excess_vocab', 'zh'));
    expect(t('lint.unmatched_number', 'en')).toBe(t('gate.unmatched_number', 'en'));
    expect(t('lint.11', 'en')).toBe('lint.11');
    for (const target of Object.values(I18N_ALIASES)) expect(i18nEntry(target), target).not.toBeNull();
  });
});
