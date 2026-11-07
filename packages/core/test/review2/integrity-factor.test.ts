/**
 * Review 2 (integrity): a FACTOR ("N times faster", "a factor of N") is grounded by any fact whose value
 * is N, whatever that fact measures. canto-demo has no timing at all; still the gate (ghost mode, the
 * derived relations on or off) accepts
 *   "3 times faster"   -> equals n_seeds = 3 (a count of training seeds; several facts, so unlinked, no issue)
 *   "2 times faster"   -> linked to f.g1.delta_minus_2sigma = 1.76 (a lower bound in efficiency POINTS)
 *   "three times"      -> f.g1.delta_plus_2sigma = 2.88 points (only a loose-number warning: "write the numeral")
 * while 4, 5, 6, 7, 8, 9 and 10 times are blocked ("give it as a derived relation of two facts").
 * A factor is a ratio of two quantities; a count or a difference in points is never one.
 */
import { describe, expect, it } from 'vitest';
import { derivedRelations } from '../../src/meta/derived';
import { gateSentence } from '../../src/gate/gate';
import { FX, loadFacts } from './_facts';

const FACTS = loadFacts(FX('canto-demo/repo'));
const DERIVED = derivedRelations(FACTS);
const gate = (text: string, derived = DERIVED) => gateSentence(text, { mode: 'ghost', facts: FACTS, allowedCiteKeys: [], knownLabels: [], fictionalNumbers: [], derived });

describe('a factor is not grounded by a count or a difference in points', () => {
  it('control: 6 times faster (no fact holds 6) is blocked', () => {
    expect(gate('The new tracker is 6 times faster than acorn.').ok).toBe(false);
  });

  it.each([
    ['3 times faster (= n_seeds)', 'The new tracker is 3 times faster than acorn.'],
    ['3.0 times faster (= n_seeds)', 'The new tracker is 3.0 times faster than acorn.'],
    ['a factor of 3 fewer fakes (= n_seeds)', 'Canto-L reduces the fake rate by a factor of 3.'],
    ['2 times faster (= delta_minus_2sigma, 1.76 points)', 'The new tracker is 2 times faster than acorn.'],
  ])('%s is blocked', (_what, text) => {
    const r = gate(text);
    // today: ok, no blocking issue; "2 times" is even linked to f.g1.delta_minus_2sigma
    expect({ ok: r.ok, factIds: r.factIds }).toEqual({ ok: false, factIds: [] });
  });

  it('"three times faster" (= delta_plus_2sigma, 2.88 points) is not linked to a points value', () => {
    const r = gate('The new tracker is three times faster than acorn.');
    expect(r.ok).toBe(false);
  });
});
