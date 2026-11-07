/**
 * Review 2 (integrity): the direction check of a stored difference reads only the comparative word,
 * not who is compared with whom. f.g1.delta_points = eff_A - eff_B = +2.32 points (A = Canto-L, B = acorn).
 * "Canto-L finds 2.3 points FEWER targets than acorn" gets a direction warning (control), but the same
 * reversal written with the subjects swapped ("ACORN finds 2.3 points more targets than Canto-L", i.e.
 * the baseline wins) is accepted and linked to f.g1.delta_points with no issue at all.
 */
import { describe, expect, it } from 'vitest';
import { derivedRelations } from '../../src/meta/derived';
import { gateSentence } from '../../src/gate/gate';
import { FX, loadFacts } from './_facts';

const FACTS = loadFacts(FX('canto-demo/repo'));
const DERIVED = derivedRelations(FACTS);
const gate = (text: string) => gateSentence(text, { mode: 'ghost', facts: FACTS, allowedCiteKeys: [], knownLabels: [], fictionalNumbers: [], derived: DERIVED });
const flagged = (text: string): boolean => {
  const r = gate(text);
  return !r.ok || r.issues.some((i) => i.code === 'direction');
};

describe('a reversed difference written with the subjects swapped', () => {
  it('control: "Canto-L finds 2.3 points fewer targets than acorn" is flagged (direction)', () => {
    expect(flagged('Canto-L finds 2.3 points fewer targets than acorn.')).toBe(true);
  });

  it.each([
    'Acorn finds 2.3 points more targets than Canto-L.',
    'The baseline acorn improves the efficiency by 2.3 points over Canto-L.',
  ])('"%s" is flagged', (text) => {
    // today: ok, linked to f.g1.delta_points, no issue
    expect(gate(text).factIds).toContain('f.g1.delta_points');
    expect(flagged(text)).toBe(true);
  });
});
