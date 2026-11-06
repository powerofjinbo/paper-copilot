import { describe, expect, it } from 'vitest';
import { BM25_STOPWORDS, Bm25Index, bm25Tokens } from '../src/meta/index';

describe('bm25Tokens', () => {
  it('lower-cases word tokens and drops stopwords', () => {
    expect(bm25Tokens('The Tracker finds 96.94% of THE targets, and we use it.')).toEqual(['tracker', 'finds', '96', '94', 'targets', 'use']);
    expect(bm25Tokens('')).toEqual([]);
    expect(BM25_STOPWORDS.has('energy')).toBe(false);
  });
});

describe('Bm25Index', () => {
  it('matches a hand-computed score', () => {
    // N = 2 docs; "tracker" appears in d1 only (df = 1): idf = ln(1 + (2 - 1 + 0.5) / (1 + 0.5)) = ln 2.
    // d1 has 2 tokens, d2 has 1, avgdl = 1.5. tf = 1:
    // score = ln2 * 1 * 2.2 / (1 + 1.2 * (0.25 + 0.75 * 2 / 1.5)) = ln2 * 2.2 / 2.5 = 0.609970...
    const idx = new Bm25Index([{ id: 'd1', text: 'tracker efficiency' }, { id: 'd2', text: 'pileup' }]);
    const r = idx.search('tracker', 5);
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe('d1');
    expect(r[0]!.score).toBeCloseTo((Math.LN2 * 2.2) / 2.5, 12);
  });

  const docs = [
    { id: 'a', text: 'We measure the tracking efficiency for displaced particles.', tags: ['st:results', 'move:result'] },
    { id: 'b', text: 'The fake-track rate is low for the baseline tracker.', tags: ['st:results'] },
    { id: 'c', text: 'Long-lived particles decay far from the collision point.', tags: ['st:intro'] },
    { id: 'd', text: 'Efficiency efficiency efficiency of the trigger, and many other words that make this sentence long and diluted.', tags: ['st:body'] },
    { id: 'e', text: 'Displaced particles are hard to track.' },
  ];
  const idx = new Bm25Index(docs);

  it('ranks the most relevant document first and returns only positive scores', () => {
    const r = idx.search('displaced particles tracking efficiency', 10);
    expect(r[0]!.id).toBe('a');
    expect(r.every((x) => x.score > 0)).toBe(true);
    expect(r.map((x) => x.id)).not.toContain('b');
    for (let i = 1; i < r.length; i++) expect(r[i - 1]!.score).toBeGreaterThanOrEqual(r[i]!.score);
  });

  it('is case-insensitive and ignores stopword-only or empty queries', () => {
    expect(idx.search('DISPLACED', 3).map((x) => x.id)).toEqual(idx.search('displaced', 3).map((x) => x.id));
    expect(idx.search('the and of', 5)).toEqual([]);
    expect(idx.search('', 5)).toEqual([]);
    expect(idx.search('unrelatedword', 5)).toEqual([]);
  });

  it('restricts to documents carrying all requested tags', () => {
    expect(idx.search('particles', 10, ['st:results']).map((x) => x.id)).toEqual(['a']);
    expect(idx.search('particles efficiency', 10, ['st:results', 'move:result']).map((x) => x.id)).toEqual(['a']);
    expect(idx.search('particles', 10, ['st:nothing'])).toEqual([]);
    // An empty tag list means no filter.
    expect(idx.search('particles', 10, []).length).toBe(idx.search('particles', 10).length);
  });

  it('honours k', () => {
    expect(idx.search('particles efficiency tracker', 2)).toHaveLength(2);
    expect(idx.search('particles', 0)).toEqual([]);
    expect(idx.search('particles', -1)).toEqual([]);
    expect(idx.search('particles', 1.9)).toHaveLength(1);
  });

  it('normalizes by length with b and saturates tf with k1', () => {
    const two = [
      { id: 'short', text: 'efficiency' },
      { id: 'long', text: 'efficiency trigger detector calorimeter magnet solenoid' },
    ];
    expect(new Bm25Index(two).search('efficiency', 2).map((x) => x.id)).toEqual(['short', 'long']);
    const flat = new Bm25Index(two, { b: 0 }).search('efficiency', 2);
    expect(flat[0]!.score).toBeCloseTo(flat[1]!.score, 12);
    // Repeated terms raise the score less than linearly (k1 saturation).
    const tf = new Bm25Index([{ id: 'x1', text: 'muon' }, { id: 'x3', text: 'muon muon muon' }, { id: 'y', text: 'electron' }], { b: 0 }).search('muon', 2);
    expect(tf[0]!.id).toBe('x3');
    expect(tf[0]!.score / tf[1]!.score).toBeLessThan(3);
  });

  it('weighs rare terms above common ones and counts a repeated query term once', () => {
    const r = idx.search('particles collision', 5);
    expect(r[0]!.id).toBe('c');
    expect(idx.search('collision collision collision', 5)).toEqual(idx.search('collision', 5));
  });

  it('is deterministic on ties (insertion order) and reports its size', () => {
    const tie = new Bm25Index([{ id: 'p', text: 'jet' }, { id: 'q', text: 'jet' }, { id: 'r', text: 'jet' }]);
    expect(tie.search('jet', 3).map((x) => x.id)).toEqual(['p', 'q', 'r']);
    expect(tie.size).toBe(3);
    expect(new Bm25Index([]).size).toBe(0);
    expect(new Bm25Index([]).search('jet', 3)).toEqual([]);
    expect(new Bm25Index([{ id: 'z', text: '' }]).search('jet', 3)).toEqual([]);
  });

  it('handles non-ASCII letters', () => {
    const r = new Bm25Index([{ id: 'g', text: 'The Λ baryon and the Σ hyperon' }, { id: 'h', text: 'Plain words' }]).search('λ', 2);
    expect(r.map((x) => x.id)).toEqual(['g']);
  });
});
