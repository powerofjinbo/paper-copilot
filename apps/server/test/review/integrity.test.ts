/**
 * Research-integrity review (reviewer, integrity lens): provenance laundering and the push guard,
 * driven through the real DocService + SyncService with the exact wire messages the web client sends.
 *
 * The web editor (apps/web/src/editor/sync/docSync.ts) turns every CodeMirror transaction into one
 * doc.change whose annotation is `tr.annotation(changeAnnotation) ?? null`. CodeMirror's undo/redo
 * (historyKeymap, Mod-z / Mod-Shift-z) and cut/paste create transactions WITHOUT that annotation, so
 * the server receives them as plain typing (annotation: null). These tests replay those sequences.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChangeSet } from '@codemirror/state';
import { ClientMessage, computeDisclosureStats, type ChangeAnnotation } from '@paper-copilot/core';
import type { Ctx } from '../../src/contracts';
import { createDocService, type DocServiceExt } from '../../src/docs/docService';
import { createSyncService } from '../../src/services/sync/syncService';
import { createPaperDb, type PaperDbExt } from '../../src/store/db';
import { makeTempProject, makeTestCtx, type TempProject } from '../helpers/ctx';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.org', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function ann(p: Partial<ChangeAnnotation>): ChangeAnnotation {
  return { origin: 'ai_draft', sentenceIds: [], state: 'proposed', model: 'claude-opus-5-5', promptHash: 'p', instruction: null, lang: null, intentNote: null, factIds: [], citeKeys: [], move: null, requestId: null, ...p };
}

function change(file: string, baseVersion: number, len: number, specs: Array<{ from: number; to?: number; insert?: string }>, annotation: ChangeAnnotation | null = null) {
  return ClientMessage.parse({ type: 'doc.change', file, baseVersion, changes: ChangeSet.of(specs, len).toJSON(), annotation }) as Extract<ClientMessage, { type: 'doc.change' }>;
}

describe('integrity: provenance cannot be laundered and unreviewed AI text cannot be pushed', () => {
  let project: TempProject;
  let ctx: ReturnType<typeof makeTestCtx>;
  let db: PaperDbExt;
  let docs: DocServiceExt;
  let sync: ReturnType<typeof createSyncService>;

  beforeEach(async () => {
    project = await makeTempProject();
    const remote = join(project.root, 'remote.git');
    execFileSync('git', ['init', '--quiet', '--bare', '-b', 'master', remote], { env: GIT_ENV });
    const tex = project.paths.tex;
    git(tex, 'init', '--quiet', '-b', 'master');
    git(tex, 'config', 'user.name', 'Author');
    git(tex, 'config', 'user.email', 'author@example.org');
    git(tex, 'add', '-A');
    git(tex, 'commit', '--quiet', '-m', 'initial');
    git(tex, 'remote', 'add', 'origin', remote);
    git(tex, 'push', '--quiet', '-u', 'origin', 'master');

    db = createPaperDb(project.paths.db);
    ctx = makeTestCtx(project, {
      db,
      facts: { linkUnit: (u: { facts: string[] }) => ({ factIds: u.facts, unmatched: [], ambiguous: [] }) } as unknown as Ctx['facts'],
      lint: { lintUnits: async () => undefined, scheduleDocument: () => undefined } as unknown as Ctx['lint'],
      voice: { addEditPairs: async () => undefined } as unknown as Ctx['voice'],
      build: { scheduleCompile: () => undefined } as unknown as Ctx['build'],
      llm: { replanAfterEdit: async () => undefined } as unknown as Ctx['llm'],
      lit: { reloadBib: async () => undefined } as unknown as Ctx['lit'],
    });
    await ctx.saveConfig({ ...ctx.config, sync: { mode: 'git', remote, branch: 'master' } });
    docs = createDocService(ctx, { segmentDebounceMs: 10, writeDebounceMs: 20, replanDelayMs: 10_000 });
    ctx.docs = docs;
    sync = createSyncService(ctx, { networkTimeoutMs: 30_000 });
    ctx.sync = sync;
  });

  afterEach(async () => {
    await docs.close();
    db.close();
    project.cleanup();
  });

  const DRAFT = ' The drafted sentence claims a large gain over acorn.';

  /** Insert one drafted (proposed) sentence after "This lead holds ..." exactly as draftSentenceSpecs does. */
  const draft = async () => {
    const st = await docs.open('main.tex');
    const anchor = st.units.find((x) => st.text.slice(x.start, x.end).startsWith('This lead holds'))!;
    const at = anchor.end;
    expect(await docs.applyClientChange(change('main.tex', st.version, st.text.length, [{ from: at, insert: DRAFT }], ann({})))).toBe(true);
    await docs.flush('main.tex');
    const u = docs.get('main.tex')!.units.find((x) => docs.unitText(x.id) === DRAFT.trim())!;
    expect(u.state).toBe('proposed');
    expect(u.everAi).toBe(true);
    return { at };
  };

  const unitWithText = (t: string) => docs.get('main.tex')!.units.find((x) => docs.unitText(x.id) === t);

  it('undo then redo of a drafted (proposed) sentence keeps it proposed, AI-touched, and blocks the push', async () => {
    const { at } = await draft();
    expect((await sync.pushCheck()).blockers.map((b) => b.kind)).toContain('proposed');

    // Mod-z: CodeMirror's inverse transaction, no changeAnnotation
    let st = docs.get('main.tex')!;
    expect(await docs.applyClientChange(change('main.tex', st.version, st.text.length, [{ from: at, to: at + DRAFT.length }], null))).toBe(true);
    await docs.flush('main.tex');
    expect(unitWithText(DRAFT.trim())).toBeUndefined();

    // Mod-Shift-z: the redo transaction re-inserts the same AI text, again without the annotation
    st = docs.get('main.tex')!;
    expect(await docs.applyClientChange(change('main.tex', st.version, st.text.length, [{ from: at, insert: DRAFT }], null))).toBe(true);
    await docs.flush('main.tex');

    const back = unitWithText(DRAFT.trim())!;
    expect(back).toBeTruthy();
    const check = await sync.pushCheck();
    expect({ state: back.state, everAi: back.everAi, pushOk: check.ok }).toEqual({ state: 'proposed', everAi: true, pushOk: false });
  });

  it('cut and paste (moving an accepted AI sentence to another line) keeps everAi and its AI count in the disclosure', async () => {
    const { at } = await draft();
    const u = unitWithText(DRAFT.trim())!;
    docs.updateUnit(u.id, { state: 'ai-drafted', acceptedAt: new Date().toISOString(), everAi: true });
    const before = computeDisclosureStats(docs.get('main.tex')!.units, db.allVersions());

    // Mod-x: delete; Mod-v elsewhere: insert the same text (plain input.paste, no annotation)
    let st = docs.get('main.tex')!;
    expect(await docs.applyClientChange(change('main.tex', st.version, st.text.length, [{ from: at, to: at + DRAFT.length }], null))).toBe(true);
    await docs.flush('main.tex');
    st = docs.get('main.tex')!;
    const target = st.units.find((x) => st.text.slice(x.start, x.end).startsWith('The test set holds'))!;
    expect(await docs.applyClientChange(change('main.tex', st.version, st.text.length, [{ from: target.end, insert: DRAFT }], null))).toBe(true);
    await docs.flush('main.tex');

    const moved = unitWithText(DRAFT.trim())!;
    expect(moved).toBeTruthy();
    const after = computeDisclosureStats(docs.get('main.tex')!.units, db.allVersions());
    expect({ everAi: moved.everAi, state: moved.state, disclosedAi: after.everAi }).toEqual({ everAi: true, state: 'ai-drafted', disclosedAi: before.everAi });
  });

  it('a ghost sentence accepted right after a human sentence (cursor at its end) leaves the human sentence human', async () => {
    const st = await docs.open('main.tex');
    const human = st.units.find((x) => st.text.slice(x.start, x.end).startsWith('This lead holds'))!;
    const humanText = docs.unitText(human.id)!;
    // ghostInsertSpec: sentenceIds = [unitAtPos(cursor)] -> the human sentence the cursor touches
    const ghost = ' The tracker also finds most displaced particles in every sample that we have tested so far.';
    const a = ann({ origin: 'ai_ghost', state: 'ai-drafted', sentenceIds: [human.id], model: 'claude-haiku-5-5', requestId: 'g1' });
    expect(await docs.applyClientChange(change('main.tex', st.version, st.text.length, [{ from: human.end, insert: ghost }], a))).toBe(true);
    await docs.flush('main.tex');
    const units = docs.get('main.tex')!.units;
    const h = units.find((x) => docs.unitText(x.id) === humanText)!;
    const g = units.find((x) => docs.unitText(x.id) === ghost.trim())!;
    expect({ human: [h.state, h.everAi], ghost: [g.state, g.everAi] }).toEqual({ human: ['human', false], ghost: ['ai-drafted', true] });
  });

  it('regression (INT-1): undo + redo inside one debounce window (no pass in between) keeps the draft proposed', async () => {
    const { at } = await draft();
    const id = unitWithText(DRAFT.trim())!.id;
    let st = docs.get('main.tex')!;
    expect(await docs.applyClientChange(change('main.tex', st.version, st.text.length, [{ from: at, to: at + DRAFT.length }], null))).toBe(true);
    // no flush: the redo arrives before the segmentation pass of the undo
    const len = st.text.length - DRAFT.length;
    expect(await docs.applyClientChange(change('main.tex', st.version + 1, len, [{ from: at, insert: DRAFT }], null))).toBe(true);
    await docs.flush('main.tex');
    const back = unitWithText(DRAFT.trim())!;
    expect({ id: back.id, state: back.state, everAi: back.everAi }).toEqual({ id, state: 'proposed', everAi: true });
    expect((await sync.pushCheck()).ok).toBe(false);
    st = docs.get('main.tex')!;
    expect(st.units.filter((u) => u.id === id)).toHaveLength(1);
  });

  it('regression (INT-1): a copy (Mod-c, Mod-v) of a drafted sentence is a second unreviewed AI sentence, not human text', async () => {
    await draft();
    const st = docs.get('main.tex')!;
    const target = st.units.find((x) => st.text.slice(x.start, x.end).startsWith('The test set holds'))!;
    expect(await docs.applyClientChange(change('main.tex', st.version, st.text.length, [{ from: target.end, insert: DRAFT }], null))).toBe(true);
    await docs.flush('main.tex');
    const copies = docs.get('main.tex')!.units.filter((x) => docs.unitText(x.id) === DRAFT.trim());
    expect(copies).toHaveLength(2);
    expect(new Set(copies.map((c) => c.id)).size).toBe(2);
    for (const c of copies) expect({ state: c.state, everAi: c.everAi }).toEqual({ state: 'proposed', everAi: true });
    // the copy's version row records the AI origin of its text, not human typing
    const copy = copies.find((c) => c.id !== unitWithText(DRAFT.trim())!.id) ?? copies[1]!;
    expect(db.versions(copy.id).map((v) => v.origin)).not.toContain('human_typed');
  });

  it('regression (INT-1): a redo of a slightly edited AI sentence (near match) keeps everAi as edited AI text', async () => {
    const { at } = await draft();
    const id = unitWithText(DRAFT.trim())!.id;
    let st = docs.get('main.tex')!;
    expect(await docs.applyClientChange(change('main.tex', st.version, st.text.length, [{ from: at, to: at + DRAFT.length }], null))).toBe(true);
    await docs.flush('main.tex');
    st = docs.get('main.tex')!;
    const edited = DRAFT.replace('large', 'clear');
    expect(await docs.applyClientChange(change('main.tex', st.version, st.text.length, [{ from: at, insert: edited }], null))).toBe(true);
    await docs.flush('main.tex');
    const back = unitWithText(edited.trim())!;
    expect({ id: back.id, state: back.state, everAi: back.everAi }).toEqual({ id, state: 'ai-edited', everAi: true });
  });

  it('regression: a drafted sentence alone blocks the push', async () => {
    await draft();
    const check = await sync.pushCheck();
    expect(check.ok).toBe(false);
    expect(check.blockers.map((b) => b.kind)).toEqual(['proposed']);
  });

  it('regression: an AI sentence edited by typing becomes ai-edited (everAi kept)', async () => {
    await draft();
    const u = unitWithText(DRAFT.trim())!;
    const st = docs.get('main.tex')!;
    const i = st.text.indexOf('large', u.start);
    expect(await docs.applyClientChange(change('main.tex', st.version, st.text.length, [{ from: i, to: i + 5, insert: 'small' }], null))).toBe(true);
    await docs.flush('main.tex');
    const got = docs.unit(u.id)!;
    expect(got.state).toBe('ai-edited');
    expect(got.everAi).toBe(true);
  });
});
