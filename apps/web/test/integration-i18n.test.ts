import { describe, expect, it } from 'vitest';
import { edText, originLabel, relTime, stateLabel, stateShort } from '../src/editor/i18n';
import { provenanceTitle } from '../src/editor/gutters';
import { useShell } from '../src/state/extra';
import type { SentenceUnit } from '@paper-copilot/core';

describe('editor chrome follows the shell language', () => {
  it('translates state labels, origins and card strings', () => {
    expect(stateLabel('human', 'en')).toBe('Written by you');
    expect(stateLabel('human', 'zh')).toBe('你写的');
    expect(stateShort('proposed', 'zh')).toBe('待审阅');
    expect(originLabel('ai_rewrite', 'zh')).toBe('AI 改写');
    expect(originLabel('something_new', 'zh')).toBe('something_new');
    expect(edText('zh', 'toReview', { n: 3 })).toBe('3 句待审阅');
    expect(edText('en', 'rewriteFor', { instruction: '把基线放在前面' })).toBe('Rewrite for “把基线放在前面”');
  });

  it('relative times in both languages', () => {
    const now = Date.parse('2026-11-06T10:00:00Z');
    expect(relTime('2026-11-06T09:59:50Z', 'en', now)).toBe('just now');
    expect(relTime('2026-11-06T09:50:00Z', 'zh', now)).toBe('10 分钟前');
    expect(relTime('2026-11-06T07:00:00Z', 'en', now)).toBe('3 h ago');
  });

  it('gutter tooltip uses the current UI language', () => {
    const u = { state: 'ai-edited', editDistance: 0.25, model: 'claude-haiku-5-5', everAi: true, grammarFixed: false } as unknown as SentenceUnit;
    const prev = useShell.getState().lang;
    useShell.getState().setLang('zh');
    try {
      expect(provenanceTitle(u)).toBe('AI 起草，你已修改（改动 25%） · claude-haiku-5-5');
      useShell.getState().setLang('en');
      expect(provenanceTitle(u)).toBe('AI drafted, edited by you (25% changed) · claude-haiku-5-5');
    } finally {
      useShell.getState().setLang(prev);
    }
  });
});
