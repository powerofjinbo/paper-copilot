import { EditorSelection, type EditorState } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import type { Fact, LintFlag } from '@paper-copilot/core';
import { describe, expect, it } from 'vitest';
import { cardField, openCardEffect } from '../src/editor/card/cardState';
import { setCtxEffect } from '../src/editor/context';
import { buildActiveMarks, buildDetailRanges, buildSentenceMarks, factMarksFor, findLintWord } from '../src/editor/decorations';
import { provenanceMarkerFor, provenanceTitle } from '../src/editor/gutters';
import { allIntentLines, intentLinesField } from '../src/editor/intent';
import { stateWith, unit, unitsFor } from '../src/editor/testing/fixtures';
import { unitsField } from '../src/editor/units';

function marks(set: DecorationSet, state: EditorState): Array<{ text: string; cls: string; attrs: Record<string, string> }> {
  const out: Array<{ text: string; cls: string; attrs: Record<string, string> }> = [];
  const it = set.iter();
  while (it.value) {
    const spec = it.value.spec as { class?: string; attributes?: Record<string, string> };
    out.push({ text: state.doc.sliceString(it.from, it.to), cls: spec.class ?? '', attrs: spec.attributes ?? {} });
    it.next();
  }
  return out;
}

const fact = (id: string, value: number, unitName: string, unc: Record<string, number> = {}): Fact => ({
  id,
  kind: 'number',
  value,
  sigfigs: null,
  unit: unitName,
  uncertainties: unc,
  definition: id,
  definitionSource: '',
  artifact: 'results/x.json',
  locator: '#/x',
  artifactSha256: 'sha',
  fingerprint: 'fp',
  stale: false,
  validationState: 'candidate',
  aliases: [],
  confirmed: true,
  excluded: false,
  proseOnly: false,
  tags: [],
});

const FACTS = [fact('f.delta', 2.3191733639494783, 'points', { total: 0.27929769909842683 }), fact('f.n', 8710, ''), fact('f.fake', 0.0054838384739537, '')];

describe('sentence marks', () => {
  const doc = 'Alpha one. Beta two. Gamma three.';
  const units = unitsFor(doc, [['Alpha one.', { state: 'human' }], ['Beta two.', { state: 'proposed' }], ['Gamma three.', { state: 'unsupported' }]]);

  it('one mark per unit with pc-s pc-s-<state> and data attributes', () => {
    const state = stateWith(doc, units);
    const m = marks(buildSentenceMarks(state.field(unitsField).units), state);
    expect(m.map((x) => [x.text, x.cls])).toEqual([
      ['Alpha one.', 'pc-s pc-s-human'],
      ['Beta two.', 'pc-s pc-s-proposed'],
      ['Gamma three.', 'pc-s pc-s-unsupported'],
    ]);
    expect(m[1]!.attrs['data-unit']).toBe('u2');
    expect(m[1]!.attrs['data-state']).toBe('proposed');
  });

  it('skips collapsed units', () => {
    const state = stateWith(doc, [...units.slice(0, 1), unit('gone', 11, 11)]);
    expect(marks(buildSentenceMarks(state.field(unitsField).units), state).length).toBe(1);
  });

  it('marks the active sentence (cursor inside) and the sentence whose card is open', () => {
    let state = stateWith(doc, units, [cardField]);
    state = state.update({ selection: EditorSelection.cursor(doc.indexOf('two')) }).state;
    expect(marks(buildActiveMarks(state), state)).toEqual([{ text: 'Beta two.', cls: 'pc-s-active', attrs: {} }]);
    state = state.update({ effects: openCardEffect.of({ id: 'u3', pinned: true, focus: false, above: false, view: 'main' }) }).state;
    const m = marks(buildActiveMarks(state), state);
    expect(m.map((x) => [x.text, x.cls])).toEqual([
      ['Beta two.', 'pc-s-active'],
      ['Gamma three.', 'pc-s-carded'],
    ]);
  });
});

describe('fact, lint and placeholder details', () => {
  const text = 'The tracker finds 2.32~$\\pm$~0.28 points more on 8,710 targets, with a fake rate of 0.55\\% and 3.7 unknowns.';

  it('links numerals to facts (value, uncertainty, percent of a fraction) and flags numerals with no fact', () => {
    const byId = new Map(FACTS.map((f) => [f.id, f]));
    const m = factMarksFor(text, FACTS, byId);
    const linked = m.filter((x) => x.linked).map((x) => [text.slice(x.from, x.to), x.factIds.join(',')]);
    expect(linked).toEqual([
      ['2.32', 'f.delta'],
      ['0.28', 'f.delta'],
      ['8,710', 'f.n'],
      ['0.55', 'f.fake'],
    ]);
    const delta = m.find((x) => text.slice(x.from, x.to) === '2.32')!;
    expect(delta.title).toContain('f.delta');
    expect(m.find((x) => text.slice(x.from, x.to) === '0.28')!.title).toContain('uncertainty: total');
    expect(m.filter((x) => !x.linked).map((x) => text.slice(x.from, x.to))).toEqual(['3.7']);
  });

  it('no facts loaded: no numeral marks at all (nothing is flagged before grounding exists)', () => {
    expect(factMarksFor(text, [], new Map())).toEqual([]);
  });

  it('finds lint words as whole words, case-insensitively', () => {
    expect(findLintWord('The principal limitation', 'principal')).toBe(4);
    expect(findLintWord('Principally, the principal one', 'principal')).toBe(17);
    expect(findLintWord('was studied by Wang', 'was studied')).toBe(0);
    expect(findLintWord('nothing here', 'delve')).toBe(-1);
  });

  it('builds detail decorations for visible units and lines', () => {
    const doc = 'The gain is 2.32 points.\nThe principal limitation is [fact?: rate at large radius].';
    const units = unitsFor(doc, [['The gain is 2.32 points.'], ['The principal limitation is [fact?: rate at large radius].']]);
    const lint: LintFlag = {
      id: 'l1',
      sentenceId: 'u2',
      check: 'vocab',
      source: 'aiese',
      msg: 'Excess vocabulary',
      word: 'principal',
      line: 2,
      excerpt: null,
      corpusRate: 0.3,
      userRate: null,
      severity: 'warn',
      dismissed: false,
    };
    let state = stateWith(doc, units);
    state = state.update({ effects: setCtxEffect.of({ facts: FACTS, lint: [lint] }) }).state;
    const ranges = buildDetailRanges(state, 0, doc.length).map((r) => ({
      text: doc.slice(r.from, r.to),
      cls: (r.value.spec as { class: string }).class,
      title: ((r.value.spec as { attributes?: { title?: string } }).attributes ?? {}).title ?? '',
    }));
    expect(ranges.find((r) => r.text === '2.32')!.cls).toBe('pc-fact');
    expect(ranges.find((r) => r.text === 'principal')!.cls).toBe('pc-lint pc-lint-warn');
    expect(ranges.find((r) => r.text === 'principal')!.title).toBe('vocab: Excess vocabulary · corpus 0.3/1k words');
    const ph = ranges.find((r) => r.cls.startsWith('pc-ph'))!;
    expect(ph.text).toBe('[fact?: rate at large radius]');
    expect(ph.cls).toBe('pc-ph pc-ph-fact');
  });
});

describe('provenance gutter', () => {
  it('shows nothing for human-only lines and words for every state', () => {
    expect(provenanceMarkerFor([unit('a', 0, 5)])).toBeNull();
    const m = provenanceMarkerFor([unit('a', 0, 5, { state: 'ai-edited', editDistance: 0.4, model: 'claude-opus-5-5' }), unit('b', 6, 9, { state: 'proposed' })])!;
    expect(m.segs.map((s) => s.state)).toEqual(['ai-edited', 'proposed']);
    expect(m.segs[0]!.fill).toBe(0.4);
    expect(m.label).toBe('AI drafted, edited by you (40% changed) · claude-opus-5-5\nProposed, not yet reviewed');
  });

  it('says when a human sentence was AI-touched before', () => {
    expect(provenanceTitle(unit('a', 0, 1, { state: 'human', everAi: true }))).toBe('Written by you · AI-touched before');
  });
});

describe('intent lines', () => {
  it('are recomputed locally on every change', () => {
    const doc = 'English line.\n这里说明为什么只用通用事件训练。\nMore English.';
    let state = stateWith(doc, [], [intentLinesField]);
    expect(allIntentLines(state).map((l) => l.line)).toEqual([2]);
    state = state.update({ changes: { from: doc.length, insert: '\n再补一句：基线放在前面。' } }).state;
    expect(allIntentLines(state).map((l) => l.line)).toEqual([2, 4]);
    state = state.update({ changes: { from: 0, to: state.doc.line(2).to + 1 } }).state;
    expect(allIntentLines(state).map((l) => l.line)).toEqual([2]);
  });

  it('a comment with Chinese is not an intent line', () => {
    const state = stateWith('% 这里是注释，不是意图行。\nText.', [], [intentLinesField]);
    expect(allIntentLines(state)).toEqual([]);
  });
});
