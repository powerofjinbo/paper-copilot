/**
 * Anchoring on the fixture paper with the real segmenter.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ChangeSet, Text } from '@codemirror/state';
import { assignUnits, changedRanges, mapUnits, reanchor, type AssignResult } from '../src/anchor/units';
import { segment } from '../src/latex/segment';
import type { ChangeAnnotation } from '../src/api';
import { AI_ORIGINS, type SentenceState, type SentenceUnit, type SentenceVersion, type VersionOrigin } from '../src/schemas';

const FIXTURE = readFileSync(fileURLToPath(new URL('../../../fixtures/canto-demo/tex/main.tex', import.meta.url)), 'utf8');

const NOW = '2026-11-06T12:00:00.000Z';

function ann(origin: VersionOrigin, state: SentenceState | null, extra: Partial<ChangeAnnotation> = {}): ChangeAnnotation {
  return { origin, sentenceIds: [], state, model: 'claude-haiku-5-5', promptHash: 'ph', instruction: null, lang: null, intentNote: null, factIds: [], citeKeys: [], move: null, requestId: null, ...extra };
}

class Doc {
  units: SentenceUnit[] = [];
  versions: SentenceVersion[] = [];
  last!: AssignResult;
  constructor(public text: string) {
    this.absorb(assignUnits({ ...this.base(), text, seg: segment(text), prev: [], changeSource: 'external', annotation: ann('import', null, { model: null, promptHash: null }) }));
  }
  base() {
    return {
      file: 'main.tex',
      now: NOW,
      lastVersion: (id: string) => this.versions.filter((v) => v.sentenceId === id).at(-1),
      lastAiVersion: (id: string) => this.versions.filter((v) => v.sentenceId === id && AI_ORIGINS.includes(v.origin)).at(-1),
    };
  }
  absorb(r: AssignResult): AssignResult {
    this.units = r.units;
    this.versions.push(...r.versions);
    this.last = r;
    return r;
  }
  edit(from: number, to: number, insert: string, annotation?: ChangeAnnotation): AssignResult {
    const cs = ChangeSet.of({ from, to, insert }, this.text.length, '\n');
    const text = cs.apply(Text.of(this.text.split('\n'))).toString();
    const prev = mapUnits(this.units, cs, text);
    this.text = text;
    return this.absorb(
      assignUnits({
        ...this.base(),
        text,
        seg: segment(text),
        prev,
        dirty: changedRanges(cs),
        changeSource: 'local',
        annotation: annotation ?? null,
        annotatedRange: annotation ? { from, to: from + insert.length } : null,
      }),
    );
  }
  replace(a: string, b: string, annotation?: ChangeAnnotation): AssignResult {
    const at = this.text.indexOf(a);
    if (at < 0) throw new Error(`not found: ${a}`);
    return this.edit(at, at + a.length, b, annotation);
  }
  insertAfter(anchor: string, insert: string, annotation?: ChangeAnnotation): AssignResult {
    const at = this.text.indexOf(anchor);
    if (at < 0) throw new Error(`not found: ${anchor}`);
    return this.edit(at + anchor.length, at + anchor.length, insert, annotation);
  }
  external(newText: string): AssignResult {
    const r = reanchor(this.text, newText, segment(newText), { ...this.base(), prev: this.units });
    this.text = newText;
    return this.absorb(r);
  }
  textOf(u: SentenceUnit): string {
    return this.text.slice(u.start, u.end);
  }
  find(fragment: string): SentenceUnit | undefined {
    return this.units.find((u) => this.textOf(u).includes(fragment));
  }
  get(fragment: string): SentenceUnit {
    const u = this.find(fragment);
    if (!u) throw new Error(`no unit with: ${fragment}`);
    return u;
  }
}

describe('anchoring on the fixture paper (real segmenter)', () => {
  it('imports every sentence as a human, imported unit with consistent spans', () => {
    const d = new Doc(FIXTURE);
    expect(d.units.length).toBeGreaterThan(15);
    for (const u of d.units) {
      expect(u).toMatchObject({ state: 'human', imported: true, everAi: false, file: 'main.tex' });
      expect(u.end).toBeGreaterThan(u.start);
      expect(d.textOf(u)).toBe(d.textOf(u).trim());
    }
    expect(new Set(d.units.map((u) => u.id)).size).toBe(d.units.length);
    expect(d.find('A comment with a period')).toBeUndefined();
  });

  it('survives a realistic local editing session', () => {
    const d = new Doc(FIXTURE);
    const initial = new Map(d.units.map((u) => [u.id, u]));

    // 1. Type inside a sentence.
    const lose = d.get('Trackers tuned on prompt particles');
    d.replace('lose many of them', 'lose many of these particles');
    expect(d.get('lose many of these')).toMatchObject({ id: lose.id, state: 'human' });
    expect(d.last.versions.map((v) => v.origin)).toEqual(['human_edit']);

    // 2. Split a sentence by typing ". ".
    const paper = d.get('In this paper, we train');
    d.replace('generic events only and test', 'generic events only. We test');
    const left = d.get('In this paper, we train');
    const right = d.get('We test on particles generated');
    expect([left.id, right.id]).toContain(paper.id);
    const keeper = d.textOf(left).length >= d.textOf(right).length ? left : right;
    const other = keeper === left ? right : left;
    expect(keeper.id).toBe(paper.id);
    expect(other.splitFrom).toBe(paper.id);
    expect(d.last.report.split).toEqual([{ from: paper.id, into: other.id }]);

    // 3. Merge two sentences by deleting the period.
    const testSet = d.get('The test set holds');
    const fake = d.get('The fake-track rate is 0.55');
    d.replace('8,710 targets.\nThe fake-track', '8,710 targets, and the fake-track');
    const merged = d.get('The test set holds');
    expect(merged.id).toBe(fake.id); // the longer sentence keeps its id
    expect(d.last.removed).toEqual([testSet.id]);

    // 4. Delete a sentence.
    const lead = d.get('This lead holds for every particle species');
    d.replace('This lead holds for every particle species.', '');
    expect(d.find('This lead holds')).toBeUndefined();
    expect(d.last.removed).toEqual([lead.id]);

    // 5. Paste a paragraph.
    const pasted = 'Pileup was not simulated. Its effect on the fake-track rate is left for future work.';
    d.insertAfter('without pileup.', '\n\n' + pasted);
    expect(d.last.report.created).toHaveLength(2);
    expect(d.get('Pileup was not simulated')).toMatchObject({ state: 'human', imported: false });

    // 6. Accept a ghost sentence with an annotation.
    const ghost = '\nThe gain is largest at large transverse displacement.';
    d.insertAfter('see Fig.~\\ref{fig:eff}.', ghost, ann('ai_ghost', 'ai-drafted', { factIds: ['f.g1.delta_points'], move: 'result', requestId: 'g1' }));
    const g = d.get('The gain is largest');
    expect(g).toMatchObject({ state: 'ai-drafted', everAi: true, facts: ['f.g1.delta_points'], model: 'claude-haiku-5-5', acceptedAt: NOW });
    expect(d.last.versions).toEqual([expect.objectContaining({ sentenceId: g.id, origin: 'ai_ghost' })]);

    // 7. A draft insert lands as proposed.
    const draft = '\nThe tracker also keeps the fake-track rate low. The same holds for the validation sample.';
    d.insertAfter('limitation is that all results are within one simulated detector without pileup.', draft, ann('ai_draft', 'proposed', { model: 'claude-opus-5-5' }));
    const proposed = d.units.filter((u) => u.state === 'proposed');
    expect(proposed.map((u) => d.textOf(u))).toEqual(['The tracker also keeps the fake-track rate low.', 'The same holds for the validation sample.']);

    // Editing the ghost sentence by hand: ai-edited, edit pair against the AI text.
    d.replace('largest at large', 'largest at the largest');
    expect(d.get('The gain is largest')).toMatchObject({ id: g.id, state: 'ai-edited', everAi: true });
    expect(d.last.editPairs).toEqual([expect.objectContaining({ sentenceId: g.id, aiText: 'The gain is largest at large transverse displacement.' })]);

    // Every unit untouched by the session still has its original id and fields.
    const untouched = d.get('Searches for long-lived particles');
    expect(untouched.id).toBe([...initial.values()].find((u) => u.textNorm === untouched.textNorm)!.id);
    const survivors = d.units.filter((u) => initial.has(u.id)).length;
    expect(survivors).toBeGreaterThanOrEqual(initial.size - 2);
  });

  it('re-anchors a three-way external change: edit, move, delete, repeated sentences', () => {
    const repeated = 'The result holds for all three seeds.';
    const base = FIXTURE.replace('shows the result.', `shows the result.\n${repeated}`).replace('for the baseline.', `for the baseline.\n${repeated}`);
    const d = new Doc(base);
    const copies = d.units.filter((u) => d.textOf(u) === repeated);
    expect(copies).toHaveLength(2);
    const [introCopy, resultsCopy] = copies;
    const edited = d.get('Trackers tuned on prompt particles');
    const moved = d.get('The test set holds 8,710 targets.');
    const deleted = d.get('The principal limitation');
    const before = new Map(d.units.map((u) => [u.id, u]));

    let disk = base.replace('lose many of them.', 'lose most of them.');
    disk = disk.replace('The test set holds 8,710 targets.\n', '').replace('This lead holds for every particle species.', 'This lead holds for every particle species.\nThe test set holds 8,710 targets.');
    disk = disk.replace('\nThe principal limitation is that all results are within one simulated detector without pileup.', '');
    const r = d.external(disk);

    expect(d.get('lose most of them')).toMatchObject({ id: edited.id, state: 'external' });
    expect(r.versions.filter((v) => v.sentenceId === edited.id).map((v) => v.origin)).toEqual(['external_edit']);
    expect(d.get('The test set holds')).toMatchObject({ id: moved.id, state: 'human' });
    expect(r.orphaned.map((u) => u.id)).toEqual([deleted.id]);
    expect(r.orphaned[0]).toMatchObject({ orphaned: true, imported: true });
    expect(r.removed).toEqual([]);
    const nowCopies = d.units.filter((u) => d.textOf(u) === repeated);
    expect(nowCopies.map((u) => u.id)).toEqual([introCopy!.id, resultsCopy!.id]);
    expect(nowCopies[0]!.sectionId).toBe(introCopy!.sectionId);

    // >= 95% of ids preserved; everything else unchanged has no version row.
    const kept = d.units.filter((u) => before.has(u.id)).length;
    expect(kept / before.size).toBeGreaterThanOrEqual(0.95);
    const changedIds = new Set(r.versions.map((v) => v.sentenceId));
    expect([...changedIds]).toEqual([edited.id]);
    expect(r.report.created).toEqual([]);
  });
});
