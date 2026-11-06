import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LintFlag, SentenceUnit, SentenceVersion } from '@paper-copilot/core';
import { createPaperDb, type PaperDbExt } from '../src/store/db';

function unit(id: string, file = 'main.tex', start = 0, extra: Partial<SentenceUnit> = {}): SentenceUnit {
  return {
    id,
    file,
    start,
    end: start + 10,
    line: 1,
    hash: 'h' + id,
    ctxHash: '',
    textNorm: 'text ' + id,
    sectionId: 'sec:intro',
    paragraphId: 'sec:intro/p0',
    part: 'intro',
    kind: 'prose',
    move: null,
    state: 'human',
    everAi: false,
    grammarFixed: false,
    imported: true,
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
    ...extra,
  };
}

function version(id: string, v: number, origin: SentenceVersion['origin'], ts = `2026-11-06T00:00:0${v}.000Z`): SentenceVersion {
  return { sentenceId: id, version: v, ts, text: `text ${id} v${v}`, origin, model: origin.startsWith('ai') ? 'claude-sonnet-5-5' : null, promptHash: null, instruction: null, lang: null, parentVersion: v > 0 ? v - 1 : null, editDistance: v > 0 ? 0.2 : null };
}

function flag(id: string, sentenceId: string | null, extra: Partial<LintFlag> = {}): LintFlag {
  return { id, sentenceId, check: 'long', source: 'style_check', msg: 'long sentence', word: null, line: 3, excerpt: null, corpusRate: 3.3, userRate: null, severity: 'hint', dismissed: false, ...extra };
}

describe('PaperDb (node:sqlite)', () => {
  let dir: string;
  let db: PaperDbExt;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'paper-db-'));
    db = createPaperDb(join(dir, '.paper', 'paper.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips units in document order and hides removed ones', () => {
    db.upsertUnits([unit('B', 'main.tex', 50), unit('A', 'main.tex', 0), unit('C', 'intro.tex', 0)]);
    expect(db.units('main.tex').map((u) => u.id)).toEqual(['A', 'B']);
    expect(db.unit('C')?.file).toBe('intro.tex');
    db.upsertUnits([unit('A', 'main.tex', 0, { state: 'ai-drafted', everAi: true })]);
    expect(db.unit('A')?.state).toBe('ai-drafted');
    db.markRemoved(['B']);
    expect(db.units('main.tex').map((u) => u.id)).toEqual(['A']);
    // removed units stay queryable
    expect(db.unit('B')?.id).toBe('B');
    expect(db.liveUnits().map((u) => u.id).sort()).toEqual(['A', 'C']);
    expect(db.filesWithUnits()).toEqual(['intro.tex', 'main.tex']);
    // re-upserting a removed unit revives it
    db.upsertUnits([unit('B', 'main.tex', 50)]);
    expect(db.units('main.tex').map((u) => u.id)).toEqual(['A', 'B']);
  });

  it('stores versions, last version and last AI version', () => {
    db.appendVersions([version('A', 0, 'import'), version('A', 1, 'ai_rewrite'), version('A', 2, 'human_edit'), version('B', 0, 'human_typed')]);
    expect(db.versions('A').map((v) => v.version)).toEqual([0, 1, 2]);
    expect(db.lastVersion('A')?.origin).toBe('human_edit');
    expect(db.lastAiVersion('A')?.origin).toBe('ai_rewrite');
    expect(db.lastAiVersion('B')).toBeUndefined();
    expect(db.allVersions()).toHaveLength(4);
    expect(db.versions('nope')).toEqual([]);
  });

  it('keeps orphans with their metadata and re-attaches them on upsert', () => {
    db.upsertUnits([unit('A'), unit('B', 'main.tex', 20, { facts: ['f.x'] })]);
    db.saveOrphans([unit('B', 'main.tex', 20, { facts: ['f.x'] })]);
    expect(db.units('main.tex').map((u) => u.id)).toEqual(['A']);
    const o = db.orphans('main.tex');
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ id: 'B', orphaned: true, facts: ['f.x'] });
    expect(db.unit('B')?.orphaned).toBe(true);
    db.upsertUnits([{ ...o[0]!, orphaned: false }]);
    expect(db.orphans('main.tex')).toEqual([]);
    expect(db.units('main.tex').map((u) => u.id)).toEqual(['A', 'B']);
    db.saveOrphans([unit('C')]);
    db.replaceOrphans('main.tex', []);
    expect(db.orphans('main.tex')).toEqual([]);
  });

  it('replaces lint flags per scope and keeps dismissals across re-lints', () => {
    db.setLint('main.tex', [flag('f1', 'A'), flag('f2', 'B')], 'sentences', ['A', 'B']);
    db.setLint('main.tex', [flag('d1', 'A', { check: 'terms' })], 'document', ['A', 'B']);
    expect(db.lint('main.tex').map((f) => f.id).sort()).toEqual(['d1', 'f1', 'f2']);
    db.dismissLint('f1');
    // re-lint of A only: f2 stays, f1 comes back with the same id and stays dismissed
    db.setLint('main.tex', [flag('f1', 'A')], 'sentences', ['A']);
    const byId = new Map(db.lint('main.tex').map((f) => [f.id, f]));
    expect(byId.get('f1')?.dismissed).toBe(true);
    expect(byId.get('f2')?.dismissed).toBe(false);
    expect(byId.has('d1')).toBe(true);
    // a new document pass replaces the old one
    db.setLint('main.tex', [], 'document', ['A', 'B']);
    expect(db.lint('main.tex').map((f) => f.id).sort()).toEqual(['f1', 'f2']);
    expect(db.lint('other.tex')).toEqual([]);
  });

  it('kv and nested transactions roll back on error', () => {
    db.kvSet('k', 'v1');
    db.kvSet('k', 'v2');
    expect(db.kvGet('k')).toBe('v2');
    expect(db.kvGet('missing')).toBeUndefined();
    expect(() =>
      db.transaction(() => {
        db.kvSet('a', '1');
        db.transaction(() => db.kvSet('b', '2'));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.kvGet('a')).toBeUndefined();
    expect(db.kvGet('b')).toBeUndefined();
    const r = db.transaction(() => {
      db.kvSet('c', '3');
      try {
        db.transaction(() => {
          db.kvSet('d', '4');
          throw new Error('inner');
        });
      } catch {
        /* inner rolled back only */
      }
      return 7;
    });
    expect(r).toBe(7);
    expect(db.kvGet('c')).toBe('3');
    expect(db.kvGet('d')).toBeUndefined();
  });

  it('persists across reopen (WAL file)', () => {
    db.upsertUnits([unit('A')]);
    db.appendVersions([version('A', 0, 'import')]);
    db.kvSet('doc.snapshot:main.tex', 'hello');
    db.close();
    db = createPaperDb(join(dir, '.paper', 'paper.db'));
    expect(db.units('main.tex').map((u) => u.id)).toEqual(['A']);
    expect(db.versions('A')).toHaveLength(1);
    expect(db.kvGet('doc.snapshot:main.tex')).toBe('hello');
  });

  it('skips corrupt rows instead of throwing', () => {
    db.upsertUnits([unit('A')]);
    // write a broken row through a second connection
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
    const raw = new DatabaseSync(db.path);
    raw.prepare("INSERT INTO units(id, file, json, removed) VALUES ('X', 'main.tex', '{not json', 0)").run();
    raw.close();
    expect(db.units('main.tex').map((u) => u.id)).toEqual(['A']);
  });
});
