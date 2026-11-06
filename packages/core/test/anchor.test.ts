import { describe, expect, it } from 'vitest';
import { ChangeSet, Text } from '@codemirror/state';
import { assignUnits, changedRanges, diffChanges, mapUnits, reanchor, type AssignInput, type AssignResult, type TextAnalysis } from '../src/anchor/units';
import { defaultAnalyze } from '../src/anchor/adapter';
import type { ChangeAnnotation } from '../src/api';
import { AI_ORIGINS, type SentenceState, type SentenceUnit, type SentenceVersion, type VersionOrigin } from '../src/schemas';
import type { Segmentation, SegSentence } from '../src/latex/segment';

/* ------------------------------------------------------------------------------------ */
/* Helpers: a tiny hand-written segmenter and an in-memory version store                 */
/* ------------------------------------------------------------------------------------ */

/** Paragraphs split at blank lines; sentences at [.?!] + whitespace before an upper-case letter or `[`. */
function seg(text: string, sectionTitle = 'Results'): Segmentation {
  const sentences: SegSentence[] = [];
  const paragraphs: Segmentation['paragraphs'] = [];
  const paraRe = /[^\n](?:[\s\S]*?)(?=\n[ \t]*\n|$)/g;
  let pIndex = 0;
  for (let pm = paraRe.exec(text); pm; pm = paraRe.exec(text)) {
    const pStart = pm.index;
    const body = pm[0];
    const idx: number[] = [];
    let cur = 0;
    const push = (a: number, b: number): void => {
      const raw = body.slice(a, b);
      const lead = raw.length - raw.trimStart().length;
      const t = raw.trim();
      if (!t) return;
      const start = pStart + a + lead;
      idx.push(sentences.length);
      sentences.push({
        start,
        end: start + t.length,
        line: text.slice(0, start).split('\n').length,
        text: t,
        part: 'body',
        kind: 'prose',
        sectionId: 'sec:results',
        sectionTitle,
        paragraphIndex: pIndex,
        indexInParagraph: idx.length - 1,
      });
    };
    const re = /[.?!]["”’)\]]*(?=\s+[A-Z[\\])/g;
    for (let m = re.exec(body); m; m = re.exec(body)) {
      push(cur, m.index + m[0].length);
      cur = m.index + m[0].length;
    }
    push(cur, body.length);
    if (idx.length) paragraphs.push({ index: pIndex, start: pStart, end: pStart + body.length, sectionId: 'sec:results', part: 'body', kind: 'prose', sentenceIndices: idx });
    pIndex++;
  }
  return { sentences, sections: [], paragraphs, intentLines: [], labels: [], refs: [], cites: [], fragment: true };
}

const analyze = (t: string): TextAnalysis => defaultAnalyze(t);
const NOW = '2026-11-06T10:00:00.000Z';

function ann(origin: VersionOrigin, state: SentenceState | null, extra: Partial<ChangeAnnotation> = {}): ChangeAnnotation {
  return {
    origin,
    sentenceIds: [],
    state,
    model: AI_ORIGINS.includes(origin) ? 'claude-sonnet-5-5' : null,
    promptHash: AI_ORIGINS.includes(origin) ? 'ph1' : null,
    instruction: null,
    lang: null,
    intentNote: null,
    factIds: [],
    citeKeys: [],
    move: null,
    requestId: null,
    ...extra,
  };
}

/** A document session: text, units and version log, with helpers to apply edits like the server. */
class Session {
  text = '';
  units: SentenceUnit[] = [];
  versions: SentenceVersion[] = [];
  last: AssignResult | null = null;

  lastVersion = (id: string): SentenceVersion | undefined => this.versions.filter((v) => v.sentenceId === id).at(-1);
  lastAiVersion = (id: string): SentenceVersion | undefined =>
    this.versions.filter((v) => v.sentenceId === id && AI_ORIGINS.includes(v.origin)).at(-1);

  base(): Omit<AssignInput, 'text' | 'seg' | 'prev' | 'changeSource'> {
    return { file: 'main.tex', lastVersion: this.lastVersion, lastAiVersion: this.lastAiVersion, now: NOW, analyze };
  }

  absorb(r: AssignResult): AssignResult {
    this.units = r.units;
    this.versions.push(...r.versions);
    this.last = r;
    return r;
  }

  static open(text: string): Session {
    const s = new Session();
    s.text = text;
    s.absorb(assignUnits({ ...s.base(), text, seg: seg(text), prev: [], changeSource: 'external', annotation: ann('import', null) }));
    return s;
  }

  /** Apply one local change (CodeMirror-like), optionally annotated over the inserted range. */
  edit(from: number, to: number, insert: string, annotation?: ChangeAnnotation, extra: Partial<AssignInput> = {}): AssignResult {
    const cs = ChangeSet.of({ from, to, insert }, this.text.length, '\n');
    const text = cs.apply(Text.of(this.text.split('\n'))).toString();
    const prev = mapUnits(this.units, cs, text);
    this.text = text;
    return this.absorb(
      assignUnits({
        ...this.base(),
        text,
        seg: seg(text),
        prev,
        dirty: changedRanges(cs),
        changeSource: 'local',
        annotation: annotation ?? null,
        annotatedRange: annotation ? { from, to: from + insert.length } : null,
        ...extra,
      }),
    );
  }

  replace(oldStr: string, newStr: string, annotation?: ChangeAnnotation): AssignResult {
    const at = this.text.indexOf(oldStr);
    if (at < 0) throw new Error(`not found: ${oldStr}`);
    return this.edit(at, at + oldStr.length, newStr, annotation);
  }

  /** An external change (disk / pull): diff-based remapping in external mode. */
  external(newText: string): AssignResult {
    const r = reanchor(this.text, newText, seg(newText), { ...this.base(), prev: this.units });
    this.text = newText;
    return this.absorb(r);
  }

  unitWith(fragment: string): SentenceUnit {
    const u = this.units.find((x) => this.text.slice(x.start, x.end).includes(fragment));
    if (!u) throw new Error(`no unit with ${fragment}`);
    return u;
  }

  /** Give a unit an AI history (as if it was accepted from a ghost) without touching the text. */
  makeAi(fragment: string, state: SentenceState, origin: VersionOrigin = 'ai_ghost'): SentenceUnit {
    const u = this.unitWith(fragment);
    const t = this.text.slice(u.start, u.end);
    const next: SentenceUnit = { ...u, state, everAi: state !== 'human' && state !== 'external' ? true : u.everAi, model: 'claude-haiku-5-5', editDistance: 0 };
    this.units = this.units.map((x) => (x.id === u.id ? next : x));
    this.versions.push({ sentenceId: u.id, version: (this.lastVersion(u.id)?.version ?? -1) + 1, ts: NOW, text: t, origin, model: 'claude-haiku-5-5', promptHash: 'p0', instruction: null, lang: null, parentVersion: null, editDistance: null });
    return next;
  }

  setUnit(id: string, patch: Partial<SentenceUnit>): void {
    this.units = this.units.map((x) => (x.id === id ? { ...x, ...patch } : x));
  }

  textOf(u: SentenceUnit): string {
    return this.text.slice(u.start, u.end);
  }
}

const DOC = [
  'The tracker finds 96.94\\% of the targets. The baseline finds 94.62\\% of them. The fake rate is 0.55\\%.',
  '',
  'This lead holds for every particle species. We see no dependence on the displacement.',
  '',
  'The test set holds 8,710 targets.',
].join('\n');

/* ------------------------------------------------------------------------------------ */
/* mapUnits / changedRanges / diffChanges                                                */
/* ------------------------------------------------------------------------------------ */

describe('mapUnits', () => {
  const s = Session.open(DOC);
  const first = s.units[0]!;

  it('does not absorb text inserted exactly at a sentence start or end', () => {
    const atStart = mapUnits([first], ChangeSet.of({ from: first.start, insert: 'XX ' }, DOC.length));
    expect(atStart[0]).toMatchObject({ start: first.start + 3, end: first.end + 3 });
    const atEnd = mapUnits([first], ChangeSet.of({ from: first.end, insert: ' YY' }, DOC.length));
    expect(atEnd[0]).toMatchObject({ start: first.start, end: first.end });
  });

  it('grows with insertions inside and collapses on deletion', () => {
    const inside = mapUnits([first], ChangeSet.of({ from: first.start + 4, insert: 'new ' }, DOC.length));
    expect(inside[0]!.end - inside[0]!.start).toBe(first.end - first.start + 4);
    const del = mapUnits([first], ChangeSet.of({ from: first.start, to: first.end }, DOC.length));
    expect(del[0]!.start).toBe(del[0]!.end);
    const delWide = mapUnits([first], ChangeSet.of({ from: 0, to: first.end + 1 }, DOC.length));
    expect(delWide[0]!.start).toBe(delWide[0]!.end);
  });

  it('recomputes lines when the new text is given, keeps objects when nothing moved, clamps bad spans', () => {
    const cs = ChangeSet.of({ from: 0, insert: 'A\nB\n' }, DOC.length);
    const newText = cs.apply(Text.of(DOC.split('\n'))).toString();
    const mapped = mapUnits(s.units, cs, newText);
    expect(mapped.map((u) => u.line)).toEqual(s.units.map((u) => u.line + 2));
    const later = mapUnits(s.units, ChangeSet.of({ from: DOC.length, insert: '\nZ.' }, DOC.length));
    expect(later[0]).toBe(s.units[0]);
    const bad = mapUnits([{ ...first, start: DOC.length + 5, end: DOC.length + 9 }], ChangeSet.of({ from: 0, insert: 'x' }, DOC.length));
    expect(bad[0]).toMatchObject({ start: DOC.length + 1, end: DOC.length + 1 });
  });
});

describe('changedRanges', () => {
  it('returns merged, sorted ranges in new coordinates', () => {
    const cs = ChangeSet.of([{ from: 10, to: 12, insert: 'abc' }, { from: 2, insert: 'x' }, { from: 12, to: 14 }, { from: 30, to: 31 }], 40);
    expect(changedRanges(cs)).toEqual([{ from: 2, to: 3 }, { from: 11, to: 14 }, { from: 30, to: 30 }]);
    expect(changedRanges(ChangeSet.empty(5))).toEqual([]);
  });
});

describe('diffChanges', () => {
  const cases: Array<[string, string]> = [
    ['', ''],
    ['abc', 'abc'],
    ['', 'new text'],
    ['old text', ''],
    [DOC, DOC.replace('94.62%', '94.6%').replace('every particle', 'each particle')],
    ['line one\r\nline two\r\n', 'line one\r\nline 2\r\nline three\r\n'],
    ['a\n\nb. c.\n', 'c. b.\n\na\n'],
  ];
  it.each(cases)('turns old into new exactly (%#)', (a, b) => {
    const cs = diffChanges(a, b);
    expect(cs.length).toBe(a.length);
    expect(cs.newLength).toBe(b.length);
    expect(cs.apply(Text.of(a.split('\n'))).toString().replace(/\n/g, '\n')).toBe(b);
  });
  it('is deterministic and minimal for a word edit', () => {
    const a = 'We study a tracker trained only on events.';
    const b = 'We study a tracker trained only on generic events.';
    expect(diffChanges(a, b).toJSON()).toEqual(diffChanges(a, b).toJSON());
    expect(changedRanges(diffChanges(a, b))).toEqual([{ from: 35, to: 43 }]);
  });
});

/* ------------------------------------------------------------------------------------ */
/* assignUnits: import, local edits, splits, merges                                      */
/* ------------------------------------------------------------------------------------ */

describe('assignUnits: import and unit fields', () => {
  const s = Session.open(DOC);
  it('creates human, imported units with import versions', () => {
    expect(s.units).toHaveLength(6);
    for (const u of s.units) {
      expect(u).toMatchObject({ state: 'human', imported: true, everAi: false, orphaned: false, splitFrom: null, file: 'main.tex', createdAt: NOW });
      expect(u.hash).toMatch(/^[0-9a-f]{14}$/);
    }
    expect(s.versions.map((v) => v.origin)).toEqual(Array(6).fill('import'));
    expect(s.versions.every((v) => v.version === 0 && v.parentVersion === null)).toBe(true);
    expect(s.last!.report.created).toHaveLength(6);
  });
  it('fills paragraph ids, lines and context hashes from in-paragraph neighbours', () => {
    expect(s.units.map((u) => u.paragraphId)).toEqual(['sec:results/p0', 'sec:results/p0', 'sec:results/p0', 'sec:results/p1', 'sec:results/p1', 'sec:results/p2']);
    expect(s.units.map((u) => u.line)).toEqual([1, 1, 1, 3, 3, 5]);
    expect(s.units[5]!.ctxHash).toBe('');
    expect(s.units[0]!.ctxHash).not.toBe('');
    expect(new Set(s.units.slice(0, 5).map((u) => u.ctxHash)).size).toBe(5);
  });
  it('a whole-placeholder sentence is a placeholder unit; cites and placeholders come from analyze', () => {
    const t = Session.open('We follow \\cite{Wang2022LRT,Ju}. [claim: the tracker is better?]');
    expect(t.units[0]!.cites).toEqual(['Wang2022LRT', 'Ju']);
    expect(t.units[1]).toMatchObject({ state: 'placeholder', placeholders: ['[claim: the tracker is better?]'] });
  });
});

describe('assignUnits: local edits', () => {
  it('ids survive typing inside a sentence; only the edited unit changes', () => {
    const s = Session.open(DOC);
    const before = s.units.map((u) => u.id);
    const r = s.replace('of the targets', 'of all the targets');
    expect(s.units.map((u) => u.id)).toEqual(before);
    // The edited unit plus its in-paragraph neighbour, whose ctxHash depends on the edited hash.
    expect(r.upserts.map((u) => u.id)).toEqual([before[0], before[1]]);
    expect(r.report).toMatchObject({ unchanged: 5, edited: [before[0]], created: [], orphaned: [], split: [] });
    expect(r.versions).toEqual([expect.objectContaining({ sentenceId: before[0], origin: 'human_edit', version: 1, parentVersion: 0 })]);
    expect(r.versions[0]!.editDistance).toBeGreaterThan(0);
    expect(r.editPairs).toEqual([]);
    expect(s.units[0]!.state).toBe('human');
    // Units outside the dirty paragraph are the very same objects.
    expect(s.units[5]).toBe(s.last!.units[5]);
  });

  it('typing that changes only whitespace keeps state and makes no version', () => {
    const s = Session.open(DOC);
    const len = s.units[0]!.end - s.units[0]!.start;
    const r = s.replace('finds 96.94', 'finds  96.94');
    expect(r.versions).toEqual([]);
    expect(r.report.edited).toEqual([]);
    // The span shift was already applied by mapUnits (clients map the same change): no upsert.
    expect(r.upserts).toEqual([]);
    expect(s.units[0]!.end - s.units[0]!.start).toBe(len + 1);
  });

  it('a split (typing ". ") keeps the id on the larger part and links the smaller with splitFrom', () => {
    const s = Session.open('We train on generic events, and we test on particles generated after the design freeze.');
    const id = s.units[0]!.id;
    s.makeAi('We train', 'ai-drafted');
    const r = s.replace('events, and we', 'events. We');
    expect(s.units).toHaveLength(2);
    const [a, b] = s.units;
    expect(b!.id).toBe(id); // larger part
    expect(a!.splitFrom).toBe(id);
    expect(a!.id).not.toBe(id);
    expect(r.report.split).toEqual([{ from: id, into: a!.id }]);
    expect(r.report.created).toEqual([a!.id]);
    for (const u of [a!, b!]) expect(u).toMatchObject({ state: 'ai-edited', everAi: true });
    expect(r.editPairs.map((p) => p.sentenceId)).toEqual([id]);
    expect(r.versions.find((v) => v.sentenceId === a!.id)).toMatchObject({ version: 0, parentVersion: null, origin: 'human_edit' });
  });

  it('a merge (deleting the period) keeps the larger id, removes the smaller and keeps AI provenance', () => {
    const s = Session.open('The fake rate is low. It is 0.55\\% against 1.38\\% for the signal-trained baseline.');
    const [small, large] = s.units;
    s.makeAi('It is 0.55', 'ai-drafted');
    s.setUnit(small!.id, { facts: ['f.fake'] });
    const r = s.replace('low. It', 'low; it');
    expect(s.units).toHaveLength(1);
    expect(s.units[0]!.id).toBe(large!.id);
    expect(r.removed).toEqual([small!.id]);
    expect(s.units[0]).toMatchObject({ everAi: true, state: 'ai-edited' });
    expect(s.units[0]!.facts).toContain('f.fake');
  });

  it('a merge of an AI sentence into a larger human one still marks the result AI-edited', () => {
    const s = Session.open('Short AI line. The longer human sentence follows here with many more words.');
    s.makeAi('Short AI', 'ai-drafted');
    s.replace('line. The', 'line, the');
    expect(s.units).toHaveLength(1);
    expect(s.units[0]).toMatchObject({ state: 'ai-edited', everAi: true });
  });

  it('deleting a sentence removes its id (local mode)', () => {
    const s = Session.open(DOC);
    const victim = s.unitWith('The baseline finds');
    const r = s.replace('The baseline finds 94.62\\% of them. ', '');
    expect(r.removed).toEqual([victim.id]);
    expect(r.orphaned).toEqual([]);
    expect(s.units).toHaveLength(5);
  });

  it('pasting a paragraph creates human units with human_typed versions', () => {
    const s = Session.open(DOC);
    const ids = s.units.map((u) => u.id);
    const at = s.text.indexOf('The test set');
    const r = s.edit(at, at, 'We repeat the study with pileup. The result does not change.\n\n');
    expect(r.report.created).toHaveLength(2);
    expect(s.units.filter((u) => ids.includes(u.id))).toHaveLength(6);
    expect(r.versions.map((v) => v.origin)).toEqual(['human_typed', 'human_typed']);
    expect(r.upserts.filter((u) => ids.includes(u.id)).map((u) => u.paragraphId)).toEqual(['sec:results/p3']);
  });

  it('accepting a ghost sentence with an annotation makes an ai-drafted unit with facts and model', () => {
    const s = Session.open(DOC);
    const at = s.text.indexOf('The test set holds');
    const g = 'The fake-track rate is 0.55\\% against 1.38\\%. ';
    const r = s.edit(at, at, g, ann('ai_ghost', 'ai-drafted', { model: 'claude-haiku-5-5', factIds: ['f.fake'], move: 'result', requestId: 'r1' }));
    const u = s.unitWith('fake-track rate');
    expect(u).toMatchObject({ state: 'ai-drafted', everAi: true, model: 'claude-haiku-5-5', promptHash: 'ph1', facts: ['f.fake'], move: 'result', acceptedAt: NOW, editDistance: 0 });
    expect(r.versions).toEqual([expect.objectContaining({ sentenceId: u.id, origin: 'ai_ghost', model: 'claude-haiku-5-5' })]);
    // The neighbour the ghost was inserted before is untouched.
    expect(s.unitWith('The test set')).toMatchObject({ state: 'human', everAi: false });
  });

  it('a ghost completing a typed prefix turns that unit ai-drafted with the same id', () => {
    const s = Session.open('The test set holds 8,710 targets. We train');
    const id = s.unitWith('We train').id;
    s.edit(s.text.length, s.text.length, ' on generic events only.', ann('ai_ghost', 'ai-drafted'));
    expect(s.unitWith('We train')).toMatchObject({ id, state: 'ai-drafted', everAi: true });
  });

  it('a draft insert lands as proposed units; editing one makes it ai-edited with an edit pair', () => {
    const s = Session.open(DOC);
    const r1 = s.edit(s.text.length, s.text.length, '\n\nWe draft one claim. We draft a second claim.', ann('ai_draft', 'proposed', { model: 'claude-opus-5-5' }));
    const drafted = s.units.filter((u) => u.state === 'proposed');
    expect(drafted).toHaveLength(2);
    expect(drafted.every((u) => u.everAi && u.acceptedAt === null && u.model === 'claude-opus-5-5')).toBe(true);
    expect(r1.versions.map((v) => v.origin)).toEqual(['ai_draft', 'ai_draft']);
    const r2 = s.replace('a second claim', 'a better second claim');
    const e = s.unitWith('better second');
    expect(e).toMatchObject({ state: 'ai-edited', acceptedAt: NOW });
    expect(e.editDistance).toBeCloseTo(1 / 6, 5);
    expect(r2.editPairs).toEqual([expect.objectContaining({ sentenceId: e.id, aiText: 'We draft a second claim.', humanText: 'We draft a better second claim.', grammarOnly: false, sectionType: 'results' })]);
  });

  it('editDistance is measured against the last AI version, not the previous edit', () => {
    const s = Session.open('We train on generic events only and test on new particles.');
    s.makeAi('We train', 'ai-drafted');
    s.replace('generic events', 'inclusive events');
    s.replace('new particles', 'fresh particles');
    const u = s.units[0]!;
    expect(u.state).toBe('ai-edited');
    // Two of eleven words differ from the AI text; only one differs from the previous version.
    expect(u.editDistance).toBeCloseTo(2 / 11, 5);
    expect(s.versions.at(-1)!.editDistance).toBeCloseTo(1 / 11, 5);
    const lastPair = s.last!.editPairs[0]!;
    expect(lastPair.aiText).toBe('We train on generic events only and test on new particles.');
    expect(u.editDistance).toBe(lastPair.editDistance);
    expect(u.editDistance).toBeGreaterThan(s.versions.at(-1)!.editDistance!);
  });

  it('a grammar fix keeps the state, sets grammarFixed and never yields an edit pair', () => {
    const s = Session.open('The tracker find more targets than the baseline does.');
    const r = s.replace('tracker find', 'tracker finds', ann('grammar_fix', null, { sentenceIds: [] }));
    expect(s.units[0]).toMatchObject({ state: 'human', grammarFixed: true, everAi: true });
    expect(r.editPairs).toEqual([]);
    expect(r.versions[0]).toMatchObject({ origin: 'grammar_fix', model: 'claude-sonnet-5-5' });
  });

  it('a state-only annotation (accept) changes the state of the named unit without a version', () => {
    const s = Session.open(DOC);
    const u = s.makeAi('The fake rate', 'proposed', 'ai_draft');
    const r = s.edit(0, 0, '', ann('ai_draft', 'ai-drafted', { sentenceIds: [u.id] }), { dirty: [] });
    expect(s.unitWith('The fake rate')).toMatchObject({ id: u.id, state: 'ai-drafted', acceptedAt: NOW });
    expect(r.versions).toEqual([]);
    expect(r.upserts.map((x) => x.id)).toEqual([u.id]);
  });

  it('a placeholder becomes human once it is written out', () => {
    const s = Session.open('[claim: the lead holds for every species?]');
    expect(s.units[0]!.state).toBe('placeholder');
    s.replace('[claim: the lead holds for every species?]', '[claim: the lead holds?] The lead holds for every species.');
    expect(s.units.map((u) => u.state)).toEqual(['placeholder', 'human']);
    s.replace('[claim: the lead holds?] The', 'The');
    expect(s.units.map((u) => u.state)).toEqual(['human']);
  });

  it('collapsed spans never match and an empty document removes everything', () => {
    const s = Session.open(DOC);
    const ids = s.units.map((u) => u.id);
    const r = s.edit(0, s.text.length, '');
    expect(r.units).toEqual([]);
    expect(r.removed.sort()).toEqual([...ids].sort());
  });
});

/* ------------------------------------------------------------------------------------ */
/* State transitions: states x change sources x annotations                              */
/* ------------------------------------------------------------------------------------ */

type AnnCase = 'none' | 'ai_rewrite' | 'ai_intent' | 'grammar_fix' | 'rewrite_myself';
const STATES: SentenceState[] = ['human', 'ai-from-intent', 'ai-drafted', 'ai-edited', 'proposed', 'external', 'placeholder', 'unsupported'];
const ANNS: AnnCase[] = ['none', 'ai_rewrite', 'ai_intent', 'grammar_fix', 'rewrite_myself'];

interface Expect {
  state: SentenceState;
  origin: VersionOrigin;
  everAi: boolean | 'kept';
  editPair: boolean;
  grammarFixed?: boolean;
}

function expected(state: SentenceState, everAi: boolean, source: 'local' | 'external', a: AnnCase): Expect {
  if (source === 'external') return { state: 'external', origin: 'external_edit', everAi: 'kept', editPair: false };
  switch (a) {
    case 'ai_rewrite':
      return { state: 'ai-drafted', origin: 'ai_rewrite', everAi: true, editPair: false };
    case 'ai_intent':
      return { state: 'ai-from-intent', origin: 'ai_intent', everAi: true, editPair: false };
    case 'grammar_fix':
      // State unchanged, except that a written-out placeholder is not a placeholder any more.
      return { state: state === 'placeholder' ? 'human' : state, origin: 'grammar_fix', everAi: true, editPair: false, grammarFixed: true };
    case 'rewrite_myself':
      return { state: 'human', origin: 'human_edit', everAi: 'kept', editPair: false };
    case 'none': {
      const aiText = ['ai-from-intent', 'ai-drafted', 'ai-edited', 'proposed', 'unsupported'].includes(state);
      if (aiText) return { state: 'ai-edited', origin: 'human_edit', everAi: true, editPair: true };
      if (state === 'external') return { state: everAi ? 'ai-edited' : 'human', origin: 'human_edit', everAi: 'kept', editPair: false };
      return { state: 'human', origin: 'human_edit', everAi: 'kept', editPair: false };
    }
  }
}

describe('state transitions (table)', () => {
  const rows: Array<[SentenceState, boolean, 'local' | 'external', AnnCase]> = [];
  for (const st of STATES)
    for (const everAi of st === 'human' || st === 'external' || st === 'placeholder' ? [false, true] : [true])
      for (const src of ['local', 'external'] as const) for (const a of src === 'external' ? (['none'] as AnnCase[]) : ANNS) rows.push([st, everAi, src, a]);

  it.each(rows)('%s (everAi %s) + %s change + annotation %s', (state, everAi, source, a) => {
    const base = 'The baseline finds fewer targets. ';
    const target = state === 'placeholder' ? '[claim: the tracker finds more targets?]' : 'The tracker finds more targets than the baseline.';
    const s = Session.open(base + target);
    const u0 = s.unitWith(target.slice(0, 12));
    if (state !== 'human') s.makeAi(target.slice(0, 12), state, state === 'proposed' ? 'ai_draft' : 'ai_ghost');
    s.setUnit(u0.id, { state, everAi });
    const replacement = 'The tracker finds many more targets than the baseline.';
    const annotation =
      a === 'none' ? undefined
      : a === 'ai_rewrite' ? ann('ai_rewrite', 'ai-drafted', { sentenceIds: [u0.id], instruction: 'verb first', lang: 'zh' })
      : a === 'ai_intent' ? ann('ai_intent', 'ai-from-intent', { intentNote: '跟踪器找到更多', factIds: ['f.eff'] })
      : a === 'grammar_fix' ? ann('grammar_fix', null, { sentenceIds: [u0.id] })
      : ann('human_edit', 'human', { sentenceIds: [u0.id] });
    let r: AssignResult;
    if (source === 'external') r = s.external(base + replacement);
    else r = s.replace(target, replacement, annotation);
    const exp = expected(state, everAi, source, a);
    const u = s.units.find((x) => x.id === u0.id)!;
    expect(u, 'id survives').toBeDefined();
    expect(u.state).toBe(exp.state);
    expect(u.everAi).toBe(exp.everAi === 'kept' ? everAi : exp.everAi);
    if (everAi) expect(u.everAi).toBe(true); // never cleared
    const v = r.versions.find((x) => x.sentenceId === u0.id)!;
    expect(v.origin).toBe(exp.origin);
    expect(r.editPairs.length > 0).toBe(exp.editPair);
    if (exp.grammarFixed) expect(u.grammarFixed).toBe(true);
    if (a === 'ai_rewrite') expect(v).toMatchObject({ instruction: 'verb first', lang: 'zh', model: 'claude-sonnet-5-5' });
    if (a === 'ai_intent') expect(u).toMatchObject({ intentNote: '跟踪器找到更多', facts: ['f.eff'], acceptedAt: NOW, editDistance: 0 });
    if (exp.editPair) {
      expect(r.editPairs[0]).toMatchObject({ sentenceId: u0.id, humanText: replacement, grammarOnly: false });
      expect(u.editDistance).toBeGreaterThan(0);
    }
  });
});

/* ------------------------------------------------------------------------------------ */
/* External changes (disk / pull): never silently delete                                 */
/* ------------------------------------------------------------------------------------ */

const LONG = [
  'Alpha opens the first paragraph. Beta follows with a number. Gamma closes it.',
  '',
  'Delta starts the second paragraph. This lead holds for every particle species. Epsilon ends it.',
  '',
  'Zeta is alone here.',
  '',
  'Eta opens the fourth paragraph. This lead holds for every particle species. Theta ends it.',
].join('\n');

describe('external changes', () => {
  it('an edited sentence keeps its id, becomes external with an external_edit version; everAi is kept', () => {
    const s = Session.open(LONG);
    const beta = s.makeAi('Beta follows', 'ai-drafted');
    s.setUnit(beta.id, { facts: ['f.n'] });
    const ids = s.units.map((u) => u.id);
    const r = s.external(LONG.replace('Beta follows with a number.', 'Beta follows with a precise number.'));
    expect(s.units.map((u) => u.id)).toEqual(ids);
    expect(s.unitWith('Beta')).toMatchObject({ id: beta.id, state: 'external', everAi: true, facts: ['f.n'] });
    expect(r.versions).toEqual([expect.objectContaining({ sentenceId: beta.id, origin: 'external_edit', version: 2 })]);
    expect(r.editPairs).toEqual([]);
    expect(r.report).toMatchObject({ edited: [beta.id], orphaned: [], created: [] });
    // Editing it again locally: AI-derived text, so ai-edited (not human), and no edit pair (co-author text).
    const r2 = s.replace('precise number', 'precise count');
    expect(s.unitWith('Beta')).toMatchObject({ state: 'ai-edited', everAi: true });
    expect(r2.editPairs).toEqual([]);
  });

  it('a deleted sentence is orphaned with its metadata, never removed', () => {
    const s = Session.open(LONG);
    const g = s.unitWith('Gamma');
    s.setUnit(g.id, { facts: ['f.g'], claims: ['c.1'] });
    const r = s.external(LONG.replace(' Gamma closes it.', ''));
    expect(r.removed).toEqual([]);
    expect(r.orphaned).toEqual([expect.objectContaining({ id: g.id, orphaned: true, facts: ['f.g'], claims: ['c.1'] })]);
    expect(r.report.orphaned).toEqual([g.id]);
    expect(r.units.find((u) => u.id === g.id)).toBeUndefined();
  });

  it('an unchanged sentence moved within the line window re-anchors by hash; new lines become external', () => {
    const s = Session.open(LONG);
    const zeta = s.unitWith('Zeta');
    const moved = LONG.replace('\n\nZeta is alone here.', '').replace('Alpha opens', 'Zeta is alone here.\n\nAlpha opens');
    const r = s.external(moved + '\n\nA co-author adds this line.');
    expect(s.unitWith('Zeta').id).toBe(zeta.id);
    expect(s.unitWith('Zeta').state).toBe('human');
    expect(r.versions.filter((v) => v.sentenceId === zeta.id)).toEqual([]);
    const added = s.unitWith('co-author adds');
    expect(added).toMatchObject({ state: 'external', everAi: false });
    expect(r.report.created).toEqual([added.id]);
    expect(r.orphaned).toEqual([]);
  });

  it('two identical sentences in different paragraphs keep their own ids (ctxHash tie-break)', () => {
    const s = Session.open(LONG);
    const copies = s.units.filter((u) => s.textOf(u).startsWith('This lead'));
    expect(copies).toHaveLength(2);
    const [p2, p4] = copies;
    const paras = LONG.split('\n\n');
    // Swap the second and fourth paragraphs.
    const swapped = [paras[0], paras[3], paras[2], paras[1]].join('\n\n');
    s.external(swapped);
    const after = s.units.filter((u) => s.textOf(u).startsWith('This lead'));
    const nearEta = after.find((u) => s.units.some((x) => x.paragraphId === u.paragraphId && s.textOf(x).startsWith('Eta')))!;
    const nearDelta = after.find((u) => s.units.some((x) => x.paragraphId === u.paragraphId && s.textOf(x).startsWith('Delta')))!;
    expect(nearEta.id).toBe(p4!.id);
    expect(nearDelta.id).toBe(p2!.id);
    expect(s.last!.orphaned).toEqual([]);
  });

  it('a sentence moved and edited with an agreeing neighbour re-anchors by similarity as external', () => {
    const s = Session.open(LONG);
    const delta = s.unitWith('Delta');
    const eps = s.unitWith('Epsilon');
    const paras = LONG.split('\n\n');
    const p1 = paras[1]!.replace('Epsilon ends it.', 'Epsilon ends the paragraph.');
    const moved = [paras[0], paras[2], p1, paras[3]].join('\n\n');
    const r = s.external(moved);
    expect(s.unitWith('Delta').id).toBe(delta.id);
    expect(s.unitWith('Epsilon')).toMatchObject({ id: eps.id, state: 'external' });
    expect(r.orphaned).toEqual([]);
  });

  it('a sentence moved far away and edited is orphaned and its new text is a new external unit', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `Filler sentence number ${'abcdefghijklmnopqrstuvwxyz'[i % 26]} stays put.`);
    const base = ['The special claim is stated here with care.', '', ...lines.flatMap((l) => [l, ''])].join('\n');
    const s = Session.open(base);
    const special = s.unitWith('special claim');
    const r = s.external(base.replace('The special claim is stated here with care.\n\n', '') + '\n\nThe special claim is stated here with great care.');
    expect(r.orphaned.map((u) => u.id)).toEqual([special.id]);
    expect(s.unitWith('great care')).toMatchObject({ state: 'external' });
    expect(s.unitWith('great care').id).not.toBe(special.id);
  });

  it('a sentence rewritten beyond recognition in place is orphaned, not silently relabelled', () => {
    const s = Session.open(LONG);
    const beta = s.unitWith('Beta');
    const r = s.external(LONG.replace('Beta follows with a number.', 'Completely different words replace everything now.'));
    expect(r.orphaned.map((u) => u.id)).toEqual([beta.id]);
    expect(s.unitWith('Completely different')).toMatchObject({ state: 'external' });
  });

  it('a one-to-two split keeps the id on the best match and links the other with splitFrom', () => {
    const s = Session.open('We train on generic events only, and we test on particles generated after the design freeze.');
    const id = s.units[0]!.id;
    const r = s.external('We train on generic events only. We test on particles generated after the design freeze.');
    expect(s.units).toHaveLength(2);
    expect(s.units[1]!.id).toBe(id);
    expect(s.units[0]!.splitFrom).toBe(id);
    expect(s.units.map((u) => u.state)).toEqual(['external', 'external']);
    expect(r.report.split).toEqual([{ from: id, into: s.units[0]!.id }]);
  });

  it('a merge on disk keeps the larger id and orphans (does not delete) the smaller', () => {
    const s = Session.open('The fake rate is low. It is half of the rate seen for the signal-trained baseline.');
    const [small, large] = s.units;
    const r = s.external('The fake rate is low; it is half of the rate seen for the signal-trained baseline.');
    expect(s.units.map((u) => u.id)).toEqual([large!.id]);
    expect(r.removed).toEqual([]);
    expect(r.orphaned.map((u) => u.id)).toEqual([small!.id]);
  });

  it('a previously orphaned unit re-attaches when its exact text comes back', () => {
    const s = Session.open(LONG);
    const g = s.unitWith('Gamma');
    s.external(LONG.replace(' Gamma closes it.', ''));
    const orphan = s.last!.orphaned[0]!;
    // The server keeps orphans and passes them back with the live units.
    s.units = [...s.units, orphan];
    const r = s.external(LONG);
    expect(s.unitWith('Gamma')).toMatchObject({ id: g.id, orphaned: false });
    expect(r.orphaned).toEqual([]);
  });

  it('unchanged documents produce no versions, no upserts and keep every id', () => {
    const s = Session.open(LONG);
    const ids = s.units.map((u) => u.id);
    const r = s.external(LONG);
    expect(r.units.map((u) => u.id)).toEqual(ids);
    expect(r.versions).toEqual([]);
    expect(r.upserts).toEqual([]);
    expect(r.report.unchanged).toBe(ids.length);
  });
});

/* ------------------------------------------------------------------------------------ */
/* Performance                                                                           */
/* ------------------------------------------------------------------------------------ */

describe('performance', () => {
  it('assignUnits on 500 units with one dirty paragraph runs in under 10 ms', () => {
    const paras = Array.from({ length: 100 }, (_, p) =>
      Array.from({ length: 5 }, (_, k) => `Sentence ${k} of paragraph ${p} reports a value with \\cite{key${p}} and $x_${k}$ in it.`).join(' '),
    );
    const text0 = paras.join('\n\n');
    const s = Session.open(text0);
    expect(s.units).toHaveLength(500);
    const at = text0.indexOf('Sentence 2 of paragraph 50 ') + 'Sentence 2 of'.length;
    const cs = ChangeSet.of({ from: at, insert: ' the' }, text0.length, '\n');
    const text1 = cs.apply(Text.of(text0.split('\n'))).toString();
    const seg1 = seg(text1);
    const run = (): AssignResult => {
      const prev = mapUnits(s.units, cs, text1);
      return assignUnits({ ...s.base(), text: text1, seg: seg1, prev, dirty: changedRanges(cs), changeSource: 'local' });
    };
    run();
    run();
    // Wall-clock timing: other processes (parallel test suites, a build) can only ADD time, so the best of
    // several runs is the estimate of assignUnits' own cost (about 3-4 ms here; the budget is 10 ms).
    const times: number[] = [];
    let r: AssignResult = run();
    for (let i = 0; i < 15; i++) {
      const t0 = performance.now();
      r = run();
      times.push(performance.now() - t0);
    }
    expect(Math.min(...times)).toBeLessThan(10);
    expect(r.units).toHaveLength(500);
    expect(r.report.edited).toHaveLength(1);
    expect(r.upserts.length).toBeLessThanOrEqual(3);
  });
});
