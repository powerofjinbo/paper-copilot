import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeSet } from '@codemirror/state';
import { ClientMessage, ServerMessage, type ChangeAnnotation, type EditPair, type SentenceUnit } from '@paper-copilot/core';
import type { Ctx } from '../src/contracts';
import { createDocService, snapshotKey, type DocServiceExt } from '../src/docs/docService';
import { createTexWatcher } from '../src/docs/watcher';
import { createPaperDb, type PaperDbExt } from '../src/store/db';
import { makeTempProject, makeTestCtx, type TempProject } from './helpers/ctx';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Fakes {
  editPairs: EditPair[];
  linted: string[][];
  docLints: string[];
  compiles: number;
  replans: Array<{ file: string; id: string }>;
  links: string[];
}

function fakeServices(f: Fakes): Partial<Ctx> {
  return {
    facts: {
      linkUnit: (u: SentenceUnit, _t: string, prefer?: string[]) => {
        f.links.push(u.id);
        return { factIds: prefer?.length ? prefer : u.facts, unmatched: [], ambiguous: [] };
      },
    } as unknown as Ctx['facts'],
    lint: {
      lintUnits: async (_file: string, units: SentenceUnit[]) => void f.linted.push(units.map((u) => u.id)),
      scheduleDocument: (file: string) => void f.docLints.push(file),
    } as unknown as Ctx['lint'],
    voice: { addEditPairs: async (p: EditPair[]) => void f.editPairs.push(...p) } as unknown as Ctx['voice'],
    build: { scheduleCompile: () => void f.compiles++ } as unknown as Ctx['build'],
    llm: { replanAfterEdit: async (file: string, id: string) => void f.replans.push({ file, id }) } as unknown as Ctx['llm'],
  };
}

function ann(p: Partial<ChangeAnnotation>): ChangeAnnotation {
  return { origin: 'ai_rewrite', sentenceIds: [], state: null, model: 'claude-sonnet-5-5', promptHash: 'ph1', instruction: null, lang: null, intentNote: null, factIds: [], citeKeys: [], move: null, requestId: null, ...p };
}

/** A real doc.change wire message (validated with the core schema, as ws.ts does). */
function change(file: string, baseVersion: number, len: number, specs: Array<{ from: number; to?: number; insert?: string }>, annotation: ChangeAnnotation | null = null) {
  const cs = ChangeSet.of(specs, len);
  const msg = ClientMessage.parse(JSON.parse(JSON.stringify({ type: 'doc.change', file, baseVersion, changes: cs.toJSON(), annotation })));
  return msg as Extract<ClientMessage, { type: 'doc.change' }>;
}

describe('DocService', () => {
  let project: TempProject;
  let ctx: ReturnType<typeof makeTestCtx>;
  let db: PaperDbExt;
  let docs: DocServiceExt;
  let f: Fakes;

  const make = () => {
    f = { editPairs: [], linted: [], docLints: [], compiles: 0, replans: [], links: [] };
    db = createPaperDb(project.paths.db);
    ctx = makeTestCtx(project, { db, ...fakeServices(f) });
    docs = createDocService(ctx, { segmentDebounceMs: 30, writeDebounceMs: 60, replanDelayMs: 40 });
    ctx.docs = docs;
  };

  beforeEach(async () => {
    project = await makeTempProject();
    make();
  });
  afterEach(async () => {
    await docs.close();
    db.close();
    project.cleanup();
  });

  const patches = () => ctx.events.filter((e): e is Extract<ServerMessage, { type: 'sentences.patch' }> => e.type === 'sentences.patch');

  it('imports the fixture: every unit human + imported, one import version each, history.jsonl', async () => {
    expect(await docs.files()).toEqual(['main.tex']);
    const st = await docs.open('main.tex');
    expect(st.version).toBe(0);
    expect(st.units.length).toBeGreaterThan(15);
    expect(st.units.every((u) => u.state === 'human' && u.imported && !u.everAi)).toBe(true);
    for (const u of st.units) {
      const vs = db.versions(u.id);
      expect(vs).toHaveLength(1);
      expect(vs[0]!.origin).toBe('import');
    }
    expect(db.units('main.tex')).toHaveLength(st.units.length);
    expect(db.kvGet(snapshotKey('main.tex'))).toBe(st.text);
    // retro-grounding and lint ran for the whole document
    expect(f.links.length).toBe(st.units.length);
    expect(f.linted[0]).toHaveLength(st.units.length);
    await docs.drainHistory();
    const lines = readFileSync(project.paths.history, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.filter((l) => l.event === 'version' && l.origin === 'import')).toHaveLength(st.units.length);
    expect(lines[0]).toHaveProperty('hash');
    // idempotent
    const again = await docs.open('main.tex');
    expect(again.units.map((u) => u.id)).toEqual(st.units.map((u) => u.id));
    const snap = docs.snapshotMessage('main.tex');
    expect(ServerMessage.safeParse(snap).success).toBe(true);
    expect(docs.labels()).toContain('sec:intro');
  });

  it('refuses paths outside the LaTeX tree and non-.tex files', async () => {
    await expect(docs.open('../repo/README.md')).rejects.toThrow(/inside the LaTeX tree|relative/);
    await expect(docs.open('/etc/passwd')).rejects.toThrow(/relative/);
    await expect(docs.open('refs.bib')).rejects.toThrow(/only .tex/);
    await expect(docs.open('missing.tex')).rejects.toMatchObject({ status: 404 });
  });

  it('applies typed changes, debounces re-segmentation, keeps ids and records human_edit versions', async () => {
    const st = await docs.open('main.tex');
    const target = st.units.find((u) => st.text.slice(u.start, u.end).startsWith('The test set holds'))!;
    expect(target).toBeTruthy();
    const at = st.text.indexOf('8,710 targets', target.start);
    // stale base version -> rejected
    expect(await docs.applyClientChange(change('main.tex', 5, st.text.length, [{ from: at, insert: 'x' }]))).toBe(false);
    // two keystrokes inside the debounce window
    expect(await docs.applyClientChange(change('main.tex', 0, st.text.length, [{ from: at, insert: 'about ' }]))).toBe(true);
    const len1 = st.text.length + 'about '.length;
    expect(await docs.applyClientChange(change('main.tex', 1, len1, [{ from: at + 6, insert: '' }, ]))).toBe(true);
    expect(patches()).toHaveLength(0); // debounced
    await sleep(80);
    const p = patches();
    expect(p).toHaveLength(1);
    expect(p[0]!.version).toBe(2);
    const edited = p[0]!.upserts.find((u) => u.id === target.id)!;
    expect(edited).toBeTruthy();
    expect(edited.state).toBe('human');
    expect(docs.unitText(target.id)).toBe('The test set holds about 8,710 targets.');
    const vs = db.versions(target.id);
    expect(vs.map((v) => v.origin)).toEqual(['import', 'human_edit']);
    expect(f.linted.at(-1)).toEqual([target.id]);
    // disk write is debounced and atomic; the snapshot follows the disk text
    await sleep(120);
    const disk = readFileSync(join(project.paths.tex, 'main.tex'), 'utf8');
    expect(disk).toContain('The test set holds about 8,710 targets.');
    expect(db.kvGet(snapshotKey('main.tex'))).toBe(disk);
    expect(f.compiles).toBeGreaterThan(0);
    expect(docs.isKnownDiskText('main.tex', disk)).toBe(true);
  });

  it('a malformed change (wrong length) is refused', async () => {
    const st = await docs.open('main.tex');
    expect(await docs.applyClientChange(change('main.tex', 0, st.text.length + 3, [{ from: 0, insert: 'x' }]))).toBe(false);
    expect(docs.get('main.tex')!.version).toBe(0);
  });

  it('an annotated AI rewrite keeps the unit id, takes AI provenance, and a later human edit yields an edit pair', async () => {
    const st = await docs.open('main.tex');
    const u = st.units.find((x) => st.text.slice(x.start, x.end).startsWith('This lead holds'))!;
    const newText = 'The lead holds for each particle species we tested.';
    const ok = await docs.applyClientChange(change('main.tex', 0, st.text.length, [{ from: u.start, to: u.end, insert: newText }], ann({ sentenceIds: [u.id], state: 'ai-drafted', instruction: '动词提前', lang: 'zh', factIds: ['f.g1.delta_points'] })));
    expect(ok).toBe(true);
    await sleep(5); // immediate pass (next macrotask), no debounce
    const p = patches().at(-1)!;
    const got = p.upserts.find((x) => x.id === u.id)!;
    expect(got).toBeTruthy();
    expect(got.state).toBe('ai-drafted');
    expect(got.everAi).toBe(true);
    expect(got.model).toBe('claude-sonnet-5-5');
    expect(got.facts).toContain('f.g1.delta_points');
    expect(docs.unitText(u.id)).toBe(newText);
    const v = db.lastVersion(u.id)!;
    expect(v).toMatchObject({ origin: 'ai_rewrite', model: 'claude-sonnet-5-5', instruction: '动词提前', lang: 'zh', promptHash: 'ph1' });

    // the author edits the AI sentence by hand -> ai-edited + edit pair to voice
    const st2 = docs.get('main.tex')!;
    const u2 = st2.units.find((x) => x.id === u.id)!;
    const at = st2.text.indexOf('each', u2.start);
    await docs.applyClientChange(change('main.tex', st2.version, st2.text.length, [{ from: at, to: at + 4, insert: 'every' }]));
    await docs.flush('main.tex');
    const u3 = docs.unit(u.id)!;
    expect(u3.state).toBe('ai-edited');
    expect(u3.editDistance).toBeGreaterThan(0);
    expect(f.editPairs).toHaveLength(1);
    expect(f.editPairs[0]).toMatchObject({ sentenceId: u.id, aiText: newText });
  });

  it('a rewrite that becomes two sentences keeps the id on one and splits the other', async () => {
    const st = await docs.open('main.tex');
    const u = st.units.find((x) => st.text.slice(x.start, x.end).startsWith('This lead holds'))!;
    await docs.applyClientChange(change('main.tex', 0, st.text.length, [{ from: u.start, to: u.end, insert: 'The lead holds for every species. It is largest for pions.' }], ann({ sentenceIds: [u.id], state: 'ai-drafted' })));
    await sleep(5);
    const units = docs.get('main.tex')!.units;
    const keeper = units.find((x) => x.id === u.id)!;
    expect(keeper).toBeTruthy();
    const other = units.find((x) => x.splitFrom === u.id);
    expect(other).toBeTruthy();
    expect(other!.everAi).toBe(true);
  });

  it('drafted sentences arrive as proposed; a human edit before them schedules a same-paragraph re-plan', async () => {
    const st = await docs.open('main.tex');
    const anchor = st.units.find((x) => st.text.slice(x.start, x.end).startsWith('This lead holds'))!;
    let text = st.text;
    let version = 0;
    // two draft sentences inserted as separate annotated transactions (as the web client does)
    for (const s of [' A first drafted sentence follows here.', ' A second drafted sentence ends it.']) {
      const at = docs.get('main.tex')!.units.filter((x) => x.paragraphId === anchor.paragraphId).at(-1)!.end;
      const msg = change('main.tex', version, text.length, [{ from: at, insert: s }], ann({ origin: 'ai_draft', state: 'proposed', sentenceIds: [], model: 'claude-opus-5-5' }));
      expect(await docs.applyClientChange(msg)).toBe(true);
      text = text.slice(0, at) + s + text.slice(at);
      version++;
    }
    await sleep(5);
    const units = docs.get('main.tex')!.units.filter((x) => x.paragraphId === anchor.paragraphId);
    const proposed = units.filter((x) => x.state === 'proposed');
    expect(proposed).toHaveLength(2);
    expect(proposed.every((x) => x.everAi && x.model === 'claude-opus-5-5')).toBe(true);
    expect(db.lastVersion(proposed[0]!.id)!.origin).toBe('ai_draft');

    // human edit of the sentence before the proposed ones
    const cur = docs.get('main.tex')!;
    const a = cur.units.find((x) => x.id === anchor.id)!;
    const at = cur.text.indexOf('every', a.start);
    await docs.applyClientChange(change('main.tex', cur.version, cur.text.length, [{ from: at, to: at + 5, insert: 'each' }]));
    await docs.flush('main.tex');
    await sleep(80);
    expect(f.replans).toEqual([{ file: 'main.tex', id: anchor.id }]);
  });

  it('updateUnit changes metadata, never clears everAi, emits a patch and can add a version row', async () => {
    const st = await docs.open('main.tex');
    const u = st.units[3]!;
    const n = patches().length;
    const next = docs.updateUnit(u.id, { state: 'ai-drafted', everAi: true, acceptedAt: '2026-11-06T01:00:00.000Z' });
    expect(next.state).toBe('ai-drafted');
    expect(patches()).toHaveLength(n + 1);
    const cleared = docs.updateUnit(u.id, { everAi: false, start: 0 } as Partial<SentenceUnit>);
    expect(cleared.everAi).toBe(true);
    expect(cleared.start).toBe(u.start);
    docs.updateUnit(u.id, { grammarFixed: true }, { text: docs.unitText(u.id)!, origin: 'grammar_fix', model: 'm', promptHash: null, instruction: null, lang: null, editDistance: 0 });
    expect(db.versions(u.id).map((v) => [v.version, v.origin])).toEqual([
      [0, 'import'],
      [1, 'grammar_fix'],
    ]);
    expect(() => docs.updateUnit('nope', {})).toThrow(/no such sentence/);
  });

  it('context() gives the paragraph around a unit', async () => {
    const st = await docs.open('main.tex');
    const u = st.units.find((x) => st.text.slice(x.start, x.end).startsWith('The test set holds'))!;
    const c = docs.context(u.id)!;
    expect(c.before).toContain('2.32');
    expect(c.after).toContain('fake-track rate');
    expect(c.sectionId).toBe('sec:results');
    expect(c.sectionTitle).toBe('Results');
    expect(docs.context('missing')).toBeNull();
  });

  it('the watcher ignores self-writes and re-anchors an external edit (doc.replace, external state)', async () => {
    const st = await docs.open('main.tex');
    const watcher = createTexWatcher(ctx, docs, { debounceMs: 30 });
    await watcher.ready;
    const reload = vi.spyOn(docs, 'reloadFromDisk');
    try {
      // a local edit written by the app itself
      const u = st.units.find((x) => st.text.slice(x.start, x.end).startsWith('The test set holds'))!;
      const at = st.text.indexOf('holds', u.start);
      await docs.applyClientChange(change('main.tex', 0, st.text.length, [{ from: at, to: at + 5, insert: 'contains' }]));
      await docs.flush('main.tex');
      await sleep(400);
      expect(reload).not.toHaveBeenCalled();

      // a co-author edits the file on disk
      const path = join(project.paths.tex, 'main.tex');
      const disk = readFileSync(path, 'utf8');
      const fake = st.units.find((x) => st.text.slice(x.start, x.end).startsWith('The fake-track rate'))!;
      const oldFake = st.text.slice(fake.start, fake.end);
      writeFileSync(path, disk.replace(oldFake, 'The fake-track rate is 0.55\\% against 1.38\\% for the signal-trained baseline.'));
      for (let i = 0; i < 60 && !ctx.events.some((e) => e.type === 'doc.replace'); i++) await sleep(50);
      expect(reload).toHaveBeenCalledWith('main.tex', 'external');
      const rep = ctx.events.find((e): e is Extract<ServerMessage, { type: 'doc.replace' }> => e.type === 'doc.replace')!;
      expect(rep.version).toBe(2);
      expect(rep.report.edited).toEqual([fake.id]);
      expect(rep.units.find((x) => x.id === fake.id)!.state).toBe('external');
      expect(db.lastVersion(fake.id)!.origin).toBe('external_edit');
      // other ids preserved
      expect(rep.units.length).toBe(st.units.length);
      expect(new Set(rep.units.map((x) => x.id))).toEqual(new Set(st.units.map((x) => x.id)));
    } finally {
      await watcher.close();
    }
  });

  it('reopens after a restart; edits made while closed are re-anchored against the last-saved snapshot', async () => {
    const st = await docs.open('main.tex');
    const ids = st.units.map((u) => u.id);
    await docs.close();
    db.close();
    // edit while the app is closed
    const path = join(project.paths.tex, 'main.tex');
    const disk = readFileSync(path, 'utf8');
    writeFileSync(path, disk.replace('This lead holds for every particle species.', 'This lead holds for every particle species we simulated.'));
    make();
    const st2 = await docs.open('main.tex');
    expect(st2.units.map((u) => u.id)).toEqual(ids);
    const edited = st2.units.find((u) => st2.text.slice(u.start, u.end).includes('we simulated'))!;
    expect(edited.state).toBe('external');
    expect(ctx.events.some((e) => e.type === 'notice' && /changed outside the app/.test(e.message))).toBe(true);

    // a clean restart keeps everything as is
    await docs.close();
    db.close();
    make();
    const st3 = await docs.open('main.tex');
    expect(st3.units.map((u) => u.id)).toEqual(ids);
    expect(st3.units.find((u) => u.id === edited.id)!.state).toBe('external');
  });

  it('keeps CRLF files CRLF on disk while the mirror is LF', async () => {
    const path = join(project.paths.tex, 'main.tex');
    writeFileSync(path, readFileSync(path, 'utf8').replace(/\n/g, '\r\n'));
    const st = await docs.open('main.tex');
    expect(st.text.includes('\r')).toBe(false);
    await docs.applyClientChange(change('main.tex', 0, st.text.length, [{ from: st.text.indexOf('This lead'), insert: 'Indeed, t' }, { from: st.text.indexOf('This lead'), to: st.text.indexOf('This lead') + 1 }]));
    await docs.flush('main.tex');
    const disk = readFileSync(path, 'utf8');
    expect(disk).toContain('Indeed, this lead holds');
    expect(disk.split('\n').every((l, i, a) => i === a.length - 1 || l.endsWith('\r'))).toBe(true);
  });
});
