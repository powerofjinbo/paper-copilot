/**
 * Review 2 (integrity): derived relations and "N out of M" ratios in the faithfulness gate.
 *
 * Every test here states what the gate SHOULD do with an AI sentence; each one failing is a way an
 * invented or reversed number reaches the page as "grounded" (linked to facts, no block, often no warn).
 * Facts: fixtures/canto-demo/repo (claim G1: A = Canto-L (ttbar), B = acorn (HNL) + LM;
 * fake_rate_A = 0.548%, fake_rate_B = 1.377%, so Canto-L has 2.5 times FEWER fake tracks, 60% fewer).
 */
import { describe, expect, it } from 'vitest';
import { derivedRelations } from '../../src/meta/derived';
import { gateSentence, type DerivedRelation } from '../../src/gate/gate';
import { FX, loadFacts } from './_facts';

const FACTS = loadFacts(FX('canto-demo/repo'));
const DERIVED = derivedRelations(FACTS);
const gate = (text: string, derived: DerivedRelation[] = DERIVED) =>
  gateSentence(text, { mode: 'ghost', facts: FACTS, allowedCiteKeys: [], knownLabels: [], fictionalNumbers: [], derived });
const flagged = (text: string): boolean => {
  const r = gate(text);
  return !r.ok || r.issues.some((i) => i.code === 'direction');
};

describe('derived relations: sign / direction', () => {
  it('a reversed relative change ("Canto-L has a 60% HIGHER fake rate") is blocked or flagged like a reversed fact', () => {
    // control: the stored difference fact in the opposite direction IS blocked (direction)
    expect(gate('Canto-L is 0.83 points higher in fake rate than acorn.').issues.map((i) => i.code)).toContain('direction');
    // the same reversal through a derived relation passes silently
    const r = gate('The fake-track rate of Canto-L is 60\\% higher than that of acorn.');
    expect(r.factIds).toEqual(['f.g1.fake_rate_A', 'f.g1.fake_rate_B']);
    expect(flagged('The fake-track rate of Canto-L is 60\\% higher than that of acorn.')).toBe(true);
  });

  it('a reversed factor ("Canto-L makes 2.5 times MORE fake tracks") is blocked or flagged', () => {
    expect(flagged('Canto-L makes 2.5 times more fake tracks than acorn.')).toBe(true);
  });
});

describe('derived relations: a coincidental pair must not ground an unrelated number', () => {
  it('an absolute efficiency of 60% is not accepted because the fake-rate RELATIVE change is 60%', () => {
    const r = gate('The tracking efficiency of Canto-L reaches 60\\%.');
    // today: ok, linked to the two fake-rate facts (provenance points at numbers the sentence never states)
    expect({ ok: r.ok, factIds: r.factIds }).toEqual({ ok: false, factIds: [] });
  });

  it('an efficiency above 100% ("151%") is not accepted as a derived number', () => {
    expect(gate('The tracking efficiency of Canto-L reaches 151\\%.').ok).toBe(false);
  });

  it('an invented pileup loss in points is not grounded by the difference of two unrelated ceilings', () => {
    // nothing in the repository is about pileup; 4.7 points = ceiling(Canto-L HNL) - ceiling(acorn ttbar+LM)
    const r = gate('With pileup, the efficiency of Canto-L drops by 4.7 points.');
    expect({ ok: r.ok, factIds: r.factIds }).toEqual({ ok: false, factIds: [] });
  });

  it('few invented "X points" values pass by coincidence (measured: 27 of 99 values 0.1-9.9 that no fact holds)', () => {
    const passed: string[] = [];
    for (let n = 1; n <= 99; n++) {
      const x = (n / 10).toFixed(1);
      const t = `With pileup, the efficiency drops by ${x} points.`;
      if (gate(t).ok && !gate(t, []).ok) passed.push(x);
    }
    expect(passed).toEqual([]);
  });

  it('few invented absolute percents pass by coincidence (measured: 14 of 99)', () => {
    const passed: number[] = [];
    for (let n = 1; n <= 99; n++) {
      const t = `The tracking efficiency of the new model is ${n}\\% for these tracks.`;
      if (gate(t).ok && !gate(t, []).ok) passed.push(n);
    }
    expect(passed).toEqual([]);
  });
});

describe('"N out of M": the denominator is a number too', () => {
  it('an invented sample size ("out of 12,000 targets"; the test set holds 8,710) is not accepted', () => {
    // 11,633 / 12,000 = 0.96942 = eff_A, so the ratio "matches"; 12,000 is never checked (structural)
    const r = gate('Canto-L finds 11,633 out of 12,000 targets.');
    expect(r.ok).toBe(false);
  });
});
