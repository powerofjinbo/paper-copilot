/**
 * Review 2 (security, SEC2-1 / SEC2-2): the gate, the echo check and the terminology report run in time
 * linear in a sentence's length. A numeral-dense paragraph ("1\% and " x 4000) used to take ~10 s in the
 * gate alone (placeholder context re-scanned the whole prefix per numeral; description suffixes probed
 * linearly), and one 80 KB letter run ~6 s in the terminology report (an unanchored definition regex).
 */
import { describe, expect, it } from 'vitest';
import { gateSentence } from '../../src/gate/gate';
import { terminologyReport } from '../../src/consistency/terms';
import { projectFileOrder } from '../../src/consistency/common';

const ms = (f: () => void): number => {
  const t0 = performance.now();
  f();
  return performance.now() - t0;
};

describe('pathological input stays linear', () => {
  it('gateSentence on 4000 numerals', () => {
    for (const unit of ['1\\% and ', '3 times and ', '5 GeV and ']) {
      const t = unit.repeat(4000);
      expect(ms(() => gateSentence(t, { mode: 'draft', facts: [], allowedCiteKeys: [], knownLabels: [], fictionalNumbers: [] }))).toBeLessThan(1500);
    }
  });

  it('every repaired placeholder still gets its own description', () => {
    const r = gateSentence('1\\% and '.repeat(5), { mode: 'draft', facts: [], allowedCiteKeys: [], knownLabels: [], fictionalNumbers: [] });
    const ph = r.repaired.match(/\[fact\?: [^\]]*\]/g) ?? [];
    expect(ph.length).toBe(5);
    expect(new Set(ph).size).toBe(5);
  });

  it('terminologyReport on one 80,000-letter run', () => {
    const text = 'See x' + 'a'.repeat(80_000) + '.';
    const u = { id: 'u1', file: 'main.tex', line: 1, part: 'body', kind: 'prose', sectionId: null, text, start: 0, end: text.length, state: 'human', everAi: false };
    expect(ms(() => terminologyReport([u as never], []))).toBeLessThan(1500);
  });
});

describe('R2-I-9: files typeset through the import package are part of the document', () => {
  it('\\import and \\subimport', () => {
    const order = projectFileOrder('main.tex', {
      'main.tex': '\\import{sections/}{extra}\n\\subimport*{app/}{a}',
      'sections/extra.tex': '\\subimport{more/}{deep}',
      'sections/more/deep.tex': 'x',
      'app/a.tex': 'y',
    });
    expect(order.filter((e) => e.included).map((e) => e.file)).toEqual(['main.tex', 'sections/extra.tex', 'sections/more/deep.tex', 'app/a.tex']);
  });
});
