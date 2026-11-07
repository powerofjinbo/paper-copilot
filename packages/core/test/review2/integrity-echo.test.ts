/**
 * Review 2 (integrity): can the echo check's resolution hide a drifted copy of a headline number?
 *
 * Abstract of fixtures/canto-demo: "it finds 96.94\% of the targets" (eff_A, the mean of three seeds).
 * A co-author (or a stale paste) changes the conclusions' copy by one digit. The panel's own test covers
 * 96.94 -> 96.49 (unmatched, drift_value). A one-digit typo that happens to equal another fact is not
 * reported at all: 96.84 and 96.75 are two of the three PER-SEED values (eff_A_seeds.0 / .2), which the
 * report treats as separate quantities; the gate also accepts them, so nothing anywhere flags it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { derivedRelations } from '../../src/meta/derived';
import { echoCheck } from '../../src/consistency/echo';
import { segment } from '../../src/latex/segment';
import { submissionCheck } from '../../src/meta/submission';
import type { ConsistencyUnit } from '../../src/consistency/common';
import { FX, loadFacts } from './_facts';

const FACTS = loadFacts(FX('canto-demo/repo'));
const DERIVED = derivedRelations(FACTS);
const MAIN = readFileSync(FX('canto-demo/tex/main.tex'), 'utf8');
const CONCL = 'We have shown that a tracker trained without the signal finds more displaced particles than one trained on it.';
const unitsOf = (text: string): ConsistencyUnit[] =>
  segment(text).sentences.map((s, i) => ({ id: `main.tex#${i}`, file: 'main.tex', line: s.line, part: s.part, kind: s.kind, sectionId: s.sectionId, text: s.text, start: s.start, end: s.end, state: 'human', everAi: false }));
const withConclusion = (x: string): string => MAIN.replace(CONCL, `We have shown that a tracker trained without the signal finds ${x}\\% of the displaced particles.`);
const driftFlags = (text: string) => echoCheck(unitsOf(text), FACTS, null, { derived: DERIVED }).flags.filter((f) => f.kind.startsWith('drift'));

describe('echo check: a one-digit typo of the headline that equals a per-seed value', () => {
  it('control: 96.49 (no fact) is reported as drift_value', () => {
    expect(driftFlags(withConclusion('96.49')).map((f) => f.kind)).toEqual(['drift_value']);
  });

  it.each(['96.84', '96.75'])('%s in the conclusions against 96.94 in the abstract is reported', (typo) => {
    expect(driftFlags(withConclusion(typo)).length).toBeGreaterThan(0);
  });

  it('and the submission check shows it among its warnings (echo_drift)', () => {
    const text = withConclusion('96.84');
    const rep = submissionCheck({ mainFile: 'main.tex', files: [{ file: 'main.tex', text }], units: unitsOf(text), facts: FACTS, venue: 'arxiv', bibKeys: ['Ju2022Zenodo', 'Wang2022LRT'], compile: { state: 'ok', errors: [] }, derived: DERIVED });
    expect(rep.items.find((i) => i.id === 'echo_drift')!.ok).toBe(false);
  });
});
