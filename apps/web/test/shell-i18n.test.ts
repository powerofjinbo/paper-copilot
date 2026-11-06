/** UI strings: both languages complete, same placeholders, interpolation and English singulars. */
import { describe, expect, it } from 'vitest';
import { MESSAGES, translate, type MsgKey } from '../src/i18n';

const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n', () => {
  it('has a non-empty Chinese string for every English key, with the same placeholders', () => {
    const keys = Object.keys(MESSAGES.en) as MsgKey[];
    expect(keys.length).toBeGreaterThan(200);
    for (const k of keys) {
      expect(MESSAGES.zh[k], k).toBeTruthy();
      expect(MESSAGES.en[k].trim(), k).not.toBe('');
      expect(vars(MESSAGES.zh[k]), k).toEqual(vars(MESSAGES.en[k]));
    }
    expect(Object.keys(MESSAGES.zh).sort()).toEqual([...keys].sort());
  });

  it('interpolates and leaves unknown placeholders visible', () => {
    expect(translate('en', 'status.reviewed', { reviewed: 12, total: 37 })).toBe('12 of 37 reviewed');
    expect(translate('zh', 'status.reviewed', { reviewed: 12, total: 37 })).toBe('已审阅 12 / 37');
    expect(translate('en', 'status.reviewed', { reviewed: 1 })).toBe('1 of {total} reviewed');
  });

  it('uses English singulars after exactly one', () => {
    expect(translate('en', 'status.lint', { warn: 1, hint: 2 })).toBe('1 warning · 2 hints');
    expect(translate('en', 'status.lint', { warn: 11, hint: 1 })).toBe('11 warnings · 1 hint');
    expect(translate('en', 'status.units', { n: 1 })).toBe('1 sentence');
    expect(translate('en', 'status.units', { n: 21 })).toBe('21 sentences');
    expect(translate('zh', 'status.lint', { warn: 1, hint: 1 })).toBe('1 个警告 · 1 个提示');
  });

  it('labels the simulated AI clearly in both languages', () => {
    expect(MESSAGES.en['top.fakeLlm']).toMatch(/Simulated AI/);
    expect(MESSAGES.zh['top.fakeLlm']).toMatch(/模拟/);
  });
});
