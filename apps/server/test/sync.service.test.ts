import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChangeSet } from '@codemirror/state';
import { ClientMessage, type ChangeAnnotation, type ServerMessage } from '@paper-copilot/core';
import type { Ctx } from '../src/contracts';
import { createDocService, type DocServiceExt } from '../src/docs/docService';
import { createSyncService, isPushable, parsePorcelain } from '../src/services/sync/syncService';
import { cjkHits, mergeMarkerHits, stripComment, unifiedDiff } from '../src/services/sync/scan';
import { createPaperDb, type PaperDbExt } from '../src/store/db';
import { makeTempProject, makeTestCtx, type TempProject } from './helpers/ctx';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.org', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function ann(p: Partial<ChangeAnnotation>): ChangeAnnotation {
  return { origin: 'ai_draft', sentenceIds: [], state: 'proposed', model: 'claude-opus-5-5', promptHash: 'p', instruction: null, lang: null, intentNote: null, factIds: [], citeKeys: [], move: null, requestId: null, ...p };
}

function change(file: string, baseVersion: number, len: number, specs: Array<{ from: number; to?: number; insert?: string }>, annotation: ChangeAnnotation | null = null) {
  return ClientMessage.parse({ type: 'doc.change', file, baseVersion, changes: ChangeSet.of(specs, len).toJSON(), annotation }) as Extract<ClientMessage, { type: 'doc.change' }>;
}

describe('scan helpers', () => {
  it('strips comments but keeps \\%', () => {
    expect(stripComment('rate 0.55\\% here % 注释')).toBe('rate 0.55\\% here ');
    expect(stripComment('a \\\\% b')).toBe('a \\\\');
  });
  it('finds CJK outside comments and merge markers', () => {
    expect(cjkHits('English. % 中文注释\nMixed 中文 text\n')).toEqual([{ line: 2, text: 'Mixed 中文 text' }]);
    expect(mergeMarkerHits('a\n=======\nb')).toEqual([]);
    expect(mergeMarkerHits('<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x').map((h) => h.line)).toEqual([1, 3, 5]);
  });
  it('renders a unified diff', () => {
    const d = unifiedDiff('main.tex', 'a\nb\nc\nd\ne\nf\ng\nh\n', 'a\nb\nc\nD\ne\nf\ng\nh\n');
    expect(d).toContain('--- a/main.tex');
    expect(d).toContain('@@ -1,7 +1,7 @@');
    expect(d).toContain('-d\n+D');
    expect(unifiedDiff('x.tex', 'same', 'same')).toBe('');
    expect(unifiedDiff('new.tex', null, 'x\n')).toContain('--- /dev/null');
  });
  it('porcelain parsing and the pushable filter', () => {
    expect(parsePorcelain(' M main.tex\0?? fig/a.png\0R  new.tex\0old.tex\0')).toEqual([
      { xy: ' M', path: 'main.tex' },
      { xy: '??', path: 'fig/a.png' },
      { xy: 'R ', path: 'new.tex' },
    ]);
    expect(isPushable('main.tex')).toBe(true);
    expect(isPushable('figs/eff.pdf')).toBe(true);
    expect(isPushable('main.aux')).toBe(false);
    expect(isPushable('main.tex.tmp-123-4')).toBe(false);
    expect(isPushable('.paper/x.tex')).toBe(false);
    expect(isPushable('notes.docx')).toBe(false);
  });
});

describe('SyncService (git mode against a bare remote)', () => {
  let project: TempProject;
  let ctx: ReturnType<typeof makeTestCtx>;
  let db: PaperDbExt;
  let docs: DocServiceExt;
  let sync: ReturnType<typeof createSyncService>;
  let remote: string;
  let coauthor: string;

  beforeEach(async () => {
    project = await makeTempProject();
    remote = join(project.root, 'remote.git');
    coauthor = join(project.root, 'coauthor');
    execFileSync('git', ['init', '--quiet', '--bare', '-b', 'master', remote], { env: GIT_ENV });
    const tex = project.paths.tex;
    git(tex, 'init', '--quiet', '-b', 'master');
    git(tex, 'config', 'user.name', 'Author');
    git(tex, 'config', 'user.email', 'author@example.org');
    git(tex, 'add', '-A');
    git(tex, 'commit', '--quiet', '-m', 'initial');
    git(tex, 'remote', 'add', 'origin', remote);
    git(tex, 'push', '--quiet', '-u', 'origin', 'master');
    execFileSync('git', ['clone', '--quiet', remote, coauthor], { env: GIT_ENV });

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

  const editSentence = async (startsWith: string, from: string, to: string) => {
    const st = docs.get('main.tex') ?? (await docs.open('main.tex'));
    const u = st.units.find((x) => st.text.slice(x.start, x.end).startsWith(startsWith))!;
    const at = st.text.indexOf(from, u.start);
    expect(await docs.applyClientChange(change('main.tex', st.version, st.text.length, [{ from: at, to: at + from.length, insert: to }]))).toBe(true);
    await docs.flush('main.tex');
    return u;
  };

  it('status reports branch, remote and cleanliness', async () => {
    const s = await sync.status();
    expect(s).toMatchObject({ mode: 'git', remote, branch: 'master', ahead: 0, behind: 0, dirty: false });
  });

  it('refuses a push while a proposed sentence or an intent line exists, and pushes once they are gone', async () => {
    const st = await docs.open('main.tex');
    const anchor = st.units.find((x) => st.text.slice(x.start, x.end).startsWith('This lead holds'))!;
    const insert = ' A drafted sentence awaits review.';
    await docs.applyClientChange(change('main.tex', 0, st.text.length, [{ from: anchor.end, insert }], ann({})));
    await docs.flush('main.tex');
    const remoteHead = git(remote, 'rev-parse', 'master');

    let check = await sync.pushCheck();
    expect(check.ok).toBe(false);
    expect(check.blockers.map((b) => b.kind)).toEqual(['proposed']);
    expect(check.files).toEqual(['main.tex']);
    expect(check.diff).toContain('+');
    const refused = await sync.push('should not go out');
    expect(refused.ok).toBe(false);
    expect(refused.output).toMatch(/Push refused: 1 proposed/);
    expect(git(remote, 'rev-parse', 'master')).toBe(remoteHead);
    expect(git(project.paths.tex, 'log', '--oneline').split('\n')).toHaveLength(1); // nothing committed

    // accept it (metadata only) and add an intent line + a CJK comment (comments are fine)
    const proposed = docs.get('main.tex')!.units.find((u) => u.state === 'proposed')!;
    docs.updateUnit(proposed.id, { state: 'ai-drafted', acceptedAt: new Date().toISOString() });
    const st2 = docs.get('main.tex')!;
    const lineEnd = st2.text.indexOf('\n', st2.units.find((u) => u.id === anchor.id)!.end);
    await docs.applyClientChange(change('main.tex', st2.version, st2.text.length, [{ from: lineEnd, insert: '\n这里说明基线的选择和对比方法\n% 中文注释可以保留' }]));
    await docs.flush('main.tex');
    check = await sync.pushCheck();
    expect(check.blockers.map((b) => b.kind)).toEqual(['intent_line']);
    expect(check.blockers[0]!.text).toContain('这里说明基线');

    // remove the intent line
    const st3 = docs.get('main.tex')!;
    const i = st3.text.indexOf('\n这里说明基线的选择和对比方法');
    await docs.applyClientChange(change('main.tex', st3.version, st3.text.length, [{ from: i, to: i + '\n这里说明基线的选择和对比方法'.length }]));
    await docs.flush('main.tex');
    check = await sync.pushCheck();
    expect(check.ok).toBe(true);
    expect(check.diff).toContain('+This lead holds for every particle species. A drafted sentence awaits review.');

    const res = await sync.push('Polish results paragraph');
    expect(res.ok).toBe(true);
    expect(git(remote, 'log', '-1', '--format=%s', 'master')).toBe('Polish results paragraph');
    git(coauthor, 'pull', '--quiet');
    expect(readFileSync(join(coauthor, 'main.tex'), 'utf8')).toContain('A drafted sentence awaits review.');
    // sync base mirrors what co-authors have
    expect(sync.syncBaseText('main.tex')).toBe(readFileSync(join(coauthor, 'main.tex'), 'utf8'));
    const s = await sync.status();
    expect(s.ahead).toBe(0);
  });

  it('pull re-anchors a co-author edit: ids kept, edited sentence external, doc.replace sent', async () => {
    const st = await docs.open('main.tex');
    const target = st.units.find((x) => st.text.slice(x.start, x.end).startsWith('The fake-track rate'))!;
    const path = join(coauthor, 'main.tex');
    writeFileSync(path, readFileSync(path, 'utf8').replace('The fake-track rate is 0.55\\% against 1.38\\% for the baseline.', 'The fake-track rate is 0.55\\% against 1.38\\% for the signal-trained baseline.'));
    git(coauthor, 'commit', '--quiet', '-am', 'advisor edit');
    git(coauthor, 'push', '--quiet');

    // a local, unpushed edit elsewhere survives the pull (stashed and re-applied)
    await editSentence('This lead holds', 'every', 'each');

    const reports = await sync.pull();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.edited).toEqual([target.id]);
    const after = docs.get('main.tex')!;
    expect(after.units.map((u) => u.id)).toEqual(st.units.map((u) => u.id));
    expect(after.units.find((u) => u.id === target.id)!.state).toBe('external');
    expect(after.text).toContain('signal-trained baseline');
    expect(after.text).toContain('This lead holds for each particle species.');
    expect(ctx.events.some((e: ServerMessage) => e.type === 'doc.replace' && e.report.edited.includes(target.id))).toBe(true);
    expect(ctx.events.some((e: ServerMessage) => e.type === 'notice' && /Co-authors changed 1 sentence/.test(e.message))).toBe(true);
    expect(sync.syncBaseText('main.tex')).toBe(git(project.paths.tex, 'show', 'HEAD:main.tex') + '\n');
    expect(existsSync(join(project.paths.tex, '.git', 'rebase-merge'))).toBe(false);
    // nothing to pull now
    expect(await sync.pull()).toEqual([]);
  });

  it('a conflicting pull is aborted and the tree restored', async () => {
    await docs.open('main.tex');
    const path = join(coauthor, 'main.tex');
    writeFileSync(path, readFileSync(path, 'utf8').replace('The test set holds 8,710 targets.', 'The test set has 8,710 targets.'));
    git(coauthor, 'commit', '--quiet', '-am', 'conflicting edit');
    git(coauthor, 'push', '--quiet');
    // local committed change of the same line
    await editSentence('The test set holds', 'holds', 'contains');
    git(project.paths.tex, 'commit', '--quiet', '-am', 'local edit');
    const head = git(project.paths.tex, 'rev-parse', 'HEAD');
    await expect(sync.pull()).rejects.toMatchObject({ status: 409 });
    expect(git(project.paths.tex, 'rev-parse', 'HEAD')).toBe(head);
    expect(existsSync(join(project.paths.tex, '.git', 'rebase-merge'))).toBe(false);
    expect(existsSync(join(project.paths.tex, '.git', 'rebase-apply'))).toBe(false);
    expect(readFileSync(join(project.paths.tex, 'main.tex'), 'utf8')).toContain('The test set contains 8,710 targets.');
    expect(git(project.paths.tex, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  });

  it('none and ols modes', async () => {
    await ctx.saveConfig({ ...ctx.config, sync: { mode: 'none', remote: null, branch: 'master' } });
    await expect(sync.pull()).rejects.toMatchObject({ status: 409 });
    await expect(sync.push('x')).rejects.toMatchObject({ status: 409 });
    expect((await sync.status()).mode).toBe('none');
    const ols = createSyncService(ctx, { olsBin: 'ols-not-installed-here' });
    await ctx.saveConfig({ ...ctx.config, sync: { mode: 'ols', remote: null, branch: 'master' } });
    await expect(ols.pull()).rejects.toMatchObject({ status: 501 });
    // ols push check compares against the sync base copies (none yet: every file is new)
    const check = await ols.pushCheck();
    expect(check.files).toEqual(['main.tex', 'refs.bib']);
    expect(check.diff).toContain('--- /dev/null');
  });
});
