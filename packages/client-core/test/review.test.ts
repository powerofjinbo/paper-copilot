import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { segment, type SentenceState, type SentenceUnit } from '@paper-copilot/core';
import { nextInQueue, reviewProgress, reviewQueue, unitAt } from '../src/review';

let n = 0;
function unit(start: number, end: number, state: SentenceState = 'human', over: Partial<SentenceUnit> = {}): SentenceUnit {
  n++;
  return {
    id: over.id ?? `u${String(n).padStart(3, '0')}`,
    file: 'main.tex',
    start,
    end,
    line: 1,
    hash: `h${n}`,
    ctxHash: '',
    textNorm: '',
    sectionId: 'sec:intro',
    paragraphId: 'p1',
    part: 'body',
    kind: 'prose',
    move: null,
    state,
    everAi: state === 'proposed' || state === 'unsupported' || state.startsWith('ai-'),
    grammarFixed: false,
    imported: false,
    model: null,
    promptHash: null,
    createdAt: '2026-11-06T00:00:00.000Z',
    acceptedAt: null,
    editDistance: null,
    intentNote: null,
    facts: [],
    cites: [],
    claims: [],
    placeholders: [],
    orphaned: false,
    splitFrom: null,
    ...over,
  };
}

const cantoSrc = readFileSync(fileURLToPath(new URL('../../../fixtures/canto-demo/tex/main.tex', import.meta.url)), 'utf8');

const ids = (us: SentenceUnit[]) => us.map((u) => u.id);

/** A small document: human, proposed, accepted, unsupported, proposed, human. */
function doc() {
  const a = unit(0, 10, 'human', { id: 'a' });
  const b = unit(12, 30, 'proposed', { id: 'b' });
  const c = unit(32, 50, 'ai-drafted', { id: 'c' });
  const d = unit(52, 70, 'unsupported', { id: 'd' });
  const e = unit(72, 90, 'proposed', { id: 'e' });
  const f = unit(92, 99, 'human', { id: 'f' });
  return { a, b, c, d, e, f, all: [a, b, c, d, e, f] };
}

describe('reviewQueue', () => {
  it('keeps proposed and unsupported units in document order', () => {
    const { all } = doc();
    expect(ids(reviewQueue(all))).toEqual(['b', 'd', 'e']);
  });

  it('sorts unsorted input without mutating it', () => {
    const { all } = doc();
    const shuffled = Object.freeze([all[4]!, all[0]!, all[3]!, all[1]!]) as unknown as SentenceUnit[];
    expect(ids(reviewQueue(shuffled))).toEqual(['b', 'd', 'e']);
    expect(ids(shuffled)).toEqual(['e', 'a', 'd', 'b']);
  });

  it('excludes every other state (placeholder is unreviewed for push, but not a review-queue item)', () => {
    const states: SentenceState[] = ['human', 'ai-from-intent', 'ai-drafted', 'ai-edited', 'external', 'placeholder'];
    expect(reviewQueue(states.map((s, i) => unit(i * 10, i * 10 + 5, s)))).toEqual([]);
  });

  it('is empty for no units and deterministic for equal spans', () => {
    expect(reviewQueue([])).toEqual([]);
    const x = unit(5, 9, 'proposed', { id: 'x' });
    const w = unit(5, 9, 'proposed', { id: 'w' });
    expect(ids(reviewQueue([x, w]))).toEqual(['w', 'x']);
  });
});

describe('nextInQueue', () => {
  it('returns null for an empty queue', () => {
    expect(nextInQueue([], 0, 1)).toBeNull();
    expect(nextInQueue([unit(0, 5, 'human')], 3, -1)).toBeNull();
  });

  it('forward from a position between units goes to the next queued unit', () => {
    const { all } = doc();
    expect(nextInQueue(all, 0, 1)?.id).toBe('b');
    expect(nextInQueue(all, 11, 1)?.id).toBe('b');
    expect(nextInQueue(all, 40, 1)?.id).toBe('d');
    expect(nextInQueue(all, 71, 1)?.id).toBe('e');
  });

  it('forward from inside (or at the edges of) a queued unit goes past it', () => {
    const { all } = doc();
    for (const pos of [12, 20, 30]) expect(nextInQueue(all, pos, 1)?.id).toBe('d');
    expect(nextInQueue(all, 60, 1)?.id).toBe('e');
  });

  it('wraps around both ways', () => {
    const { all } = doc();
    expect(nextInQueue(all, 80, 1)?.id).toBe('b');
    expect(nextInQueue(all, 95, 1)?.id).toBe('b');
    expect(nextInQueue(all, 5, -1)?.id).toBe('e');
    expect(nextInQueue(all, 20, -1)?.id).toBe('e');
  });

  it('backward from a position goes to the previous queued unit, from inside one to the one before it', () => {
    const { all } = doc();
    expect(nextInQueue(all, 99, -1)?.id).toBe('e');
    expect(nextInQueue(all, 71, -1)?.id).toBe('d');
    expect(nextInQueue(all, 60, -1)?.id).toBe('b');
    expect(nextInQueue(all, 80, -1)?.id).toBe('d');
    expect(nextInQueue(all, 40, -1)?.id).toBe('b');
  });

  it('repeated steps visit the whole queue in order and come back', () => {
    const { all } = doc();
    const visit = (dir: 1 | -1) => {
      const seen: string[] = [];
      let pos = 0;
      for (let i = 0; i < 4; i++) {
        const u = nextInQueue(all, pos, dir)!;
        seen.push(u.id);
        pos = u.start;
      }
      return seen;
    };
    expect(visit(1)).toEqual(['b', 'd', 'e', 'b']);
    expect(visit(-1)).toEqual(['e', 'd', 'b', 'e']);
  });

  it('a single queued unit is returned from anywhere, including from itself', () => {
    const only = [unit(0, 5, 'human'), unit(10, 20, 'proposed', { id: 'p' })];
    for (const pos of [0, 10, 15, 20, 30]) for (const dir of [1, -1] as const) expect(nextInQueue(only, pos, dir)?.id).toBe('p');
  });

  it('at a shared edge the earlier unit is the current one', () => {
    const x = unit(0, 10, 'proposed', { id: 'x' });
    const y = unit(10, 20, 'proposed', { id: 'y' });
    const z = unit(25, 30, 'proposed', { id: 'z' });
    expect(nextInQueue([x, y, z], 10, 1)?.id).toBe('y');
    expect(nextInQueue([x, y, z], 10, -1)?.id).toBe('z');
  });

  it('works on unsorted input and skips orphaned units', () => {
    const { b, d, e, a } = doc();
    const orphan = unit(40, 45, 'proposed', { id: 'o', orphaned: true });
    const units = [e, orphan, a, d, b];
    expect(nextInQueue(units, 31, 1)?.id).toBe('d');
    expect(nextInQueue(units, 51, -1)?.id).toBe('b');
    expect(nextInQueue([orphan], 0, 1)).toBeNull();
  });
});

describe('reviewProgress', () => {
  it('reviewed = everAi units out of the queue; total = reviewed + queue length', () => {
    const units = [
      unit(0, 5, 'human'), // never AI: not counted
      unit(6, 9, 'proposed'),
      unit(10, 15, 'unsupported'),
      unit(16, 20, 'ai-drafted'), // accepted
      unit(21, 25, 'ai-edited'), // edited
      unit(26, 30, 'human', { everAi: true }), // rewritten by the author
      unit(31, 35, 'placeholder', { everAi: true }), // rejected into [claim: ...?]
      unit(36, 40, 'external', { everAi: true }), // advisor edited an AI sentence
      unit(41, 45, 'external'), // advisor's own sentence
      unit(46, 50, 'ai-from-intent'),
    ];
    expect(reviewProgress(units)).toEqual({ reviewed: 6, total: 8 });
  });

  it('is 0 of 0 for a purely human document and for no units', () => {
    expect(reviewProgress([])).toEqual({ reviewed: 0, total: 0 });
    expect(reviewProgress([unit(0, 5, 'human'), unit(6, 9, 'external')])).toEqual({ reviewed: 0, total: 0 });
  });

  it('counts queued units even if everAi was not set on them', () => {
    expect(reviewProgress([unit(0, 5, 'proposed', { everAi: false })])).toEqual({ reviewed: 0, total: 1 });
  });

  it('progress moves as the author acts: accepting one moves it from queue to reviewed, total unchanged', () => {
    const before = [unit(0, 5, 'proposed', { id: 'p1' }), unit(6, 9, 'proposed', { id: 'p2' }), unit(10, 15, 'proposed', { id: 'p3' })];
    expect(reviewProgress(before)).toEqual({ reviewed: 0, total: 3 });
    const after = before.map((u) => (u.id === 'p2' ? { ...u, state: 'ai-drafted' as const } : u));
    expect(reviewProgress(after)).toEqual({ reviewed: 1, total: 3 });
    const done = after.map((u) => ({ ...u, state: 'ai-edited' as const }));
    const p = reviewProgress(done);
    expect(p.reviewed).toBe(p.total);
    expect(reviewQueue(done)).toEqual([]);
  });
});

describe('unitAt', () => {
  it('finds the unit with start <= pos <= end', () => {
    const { all } = doc();
    expect(unitAt(all, 0)?.id).toBe('a');
    expect(unitAt(all, 10)?.id).toBe('a');
    expect(unitAt(all, 12)?.id).toBe('b');
    expect(unitAt(all, 29)?.id).toBe('b');
    expect(unitAt(all, 99)?.id).toBe('f');
  });

  it('returns null in gaps, before the first and after the last unit, and for no units', () => {
    const { all } = doc();
    expect(unitAt(all, 11)).toBeNull();
    expect(unitAt(all, 100)).toBeNull();
    expect(unitAt(all, -1)).toBeNull();
    expect(unitAt([], 0)).toBeNull();
  });

  it('at a shared edge the earlier unit wins; collapsed units only as a fallback', () => {
    const x = unit(0, 10, 'human', { id: 'x' });
    const y = unit(10, 20, 'human', { id: 'y' });
    expect(unitAt([x, y], 10)?.id).toBe('x');
    const empty = unit(25, 25, 'human', { id: 'empty' });
    const z = unit(25, 30, 'human', { id: 'z' });
    expect(unitAt([x, y, empty, z], 25)?.id).toBe('z');
    expect(unitAt([x, empty], 25)?.id).toBe('empty');
  });

  it('agrees with a linear scan on every offset of the Canto fixture', () => {
    const src = cantoSrc;
    const seg = segment(cantoSrc);
    const units = seg.sentences.map((s, i) => unit(s.start, s.end, i % 3 === 0 ? 'proposed' : 'human', { id: `s${i}` }));
    expect(units.length).toBeGreaterThan(20);
    const linear = (pos: number) => units.find((u) => u.end > u.start && u.start <= pos && pos <= u.end) ?? null;
    for (let pos = 0; pos <= src.length + 1; pos++) expect(unitAt(units, pos)?.id).toBe(linear(pos)?.id);
    // queue navigation over the real document visits every queued unit once per lap
    const q = reviewQueue(units);
    let pos = 0;
    const seen = new Set<string>();
    for (let i = 0; i < q.length; i++) {
      const u = nextInQueue(units, pos, 1)!;
      seen.add(u.id);
      pos = u.start;
    }
    expect(seen.size).toBe(q.length);
  });
});
