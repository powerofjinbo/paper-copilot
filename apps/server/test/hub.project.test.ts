import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { segment } from '@paper-copilot/core';
import { initProject, InitError, resolveLayout } from '../src/project/init';
import { importProject, sourceKind } from '../src/project/import';
import { detectBibFiles, detectMainFile } from '../src/project/detect';
import { IGNORE_MARKER } from '../src/project/hygiene';
import { applySemanticLines, undoSemanticLines } from '../src/project/semanticLines';
import { paperPaths } from '../src/infra';
import { resolveInTex, listFiles, isTexName } from '../src/docs/text';
import { main as cli, maskUrl } from '../src/cli';
import { createCtx } from '../src/ctx';
import { FIXTURE, SKILL_DIR } from './helpers/ctx';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' };

describe('project init / import / hygiene', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'paper-proj-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const fixtureTex = (dest: string) => cpSync(join(FIXTURE, 'tex'), dest, { recursive: true });

  it('detects the main file and bibliography', () => {
    const tex = join(tmp, 'tex');
    fixtureTex(tex);
    writeFileSync(join(tex, 'sec-intro.tex'), '\\section{Intro}\nText.\n');
    writeFileSync(join(tex, 'old.tex'), '% \\documentclass{article}\n');
    expect(detectMainFile(tex)).toBe('main.tex');
    expect(detectBibFiles(tex, 'main.tex')).toEqual(['refs.bib']);
    expect(detectMainFile(join(tmp, 'nope'))).toBeNull();
  });

  it('init <root> with tex/: writes project.json and leaves the tree untouched', async () => {
    fixtureTex(join(tmp, 'tex'));
    const before = readFileSync(join(tmp, 'tex', 'main.tex'), 'utf8');
    const r = await initProject(tmp, { repo: join(FIXTURE, 'repo'), skill: SKILL_DIR, venue: 'elsevier', notes: 'en' });
    expect(r.created).toBe(true);
    expect(r.config).toMatchObject({ mainFile: 'main.tex', bibFiles: ['refs.bib'], venue: 'elsevier', notesLanguage: 'en', texRoot: join(tmp, 'tex'), sync: { mode: 'none' } });
    expect(existsSync(join(tmp, '.paper', 'project.json'))).toBe(true);
    expect(existsSync(join(tmp, '.paper', 'sync', 'base'))).toBe(true);
    expect(readFileSync(join(tmp, 'tex', 'main.tex'), 'utf8')).toBe(before);
    expect(listFiles(join(tmp, 'tex'), () => true).sort()).toEqual(['main.tex', 'refs.bib']);
    // re-init changes only what is given
    const r2 = await initProject(tmp, { venue: 'aps' });
    expect(r2.created).toBe(false);
    expect(r2.config.venue).toBe('aps');
    expect(r2.config.notesLanguage).toBe('en');
    expect(r2.config.repoDir).toBe(join(FIXTURE, 'repo'));
  });

  it('init <the LaTeX tree itself>: the sidecar goes next to it, and a git tree gets local excludes', async () => {
    const tex = join(tmp, 'canto');
    fixtureTex(tex);
    execFileSync('git', ['init', '-q', '-b', 'master', tex], { env: GIT_ENV });
    execFileSync('git', ['-C', tex, 'remote', 'add', 'origin', 'https://git:secret@git.overleaf.com/abc123'], { env: GIT_ENV });
    expect(resolveLayout(tex)).toEqual({ root: tmp, texRoot: tex });
    const r = await initProject(tex, { skill: SKILL_DIR });
    expect(r.root).toBe(tmp);
    expect(r.config.sync).toEqual({ mode: 'git', remote: 'https://git:secret@git.overleaf.com/abc123', branch: 'master' });
    const ex = readFileSync(join(tex, '.git', 'info', 'exclude'), 'utf8');
    expect(ex).toContain(IGNORE_MARKER);
    expect(ex).toContain('*.tmp-*');
    await initProject(tex, {});
    expect(readFileSync(join(tex, '.git', 'info', 'exclude'), 'utf8').split(IGNORE_MARKER)).toHaveLength(2); // idempotent
    expect(existsSync(join(tex, '.gitignore'))).toBe(false); // nothing added to the shared tree
    expect(maskUrl('https://git:secret@git.overleaf.com/abc123')).toBe('https://git:***@git.overleaf.com/abc123');
  });

  it('refuses a sidecar inside the tree and a missing tree', async () => {
    fixtureTex(join(tmp, 'tex'));
    await expect(initProject(join(tmp, 'tex', 'sub'), { tex: join(tmp, 'tex') })).rejects.toBeInstanceOf(InitError);
    await expect(initProject(join(tmp, 'empty'))).rejects.toThrow(/no LaTeX tree/);
  });

  it('ols mode writes .olignore that ignores itself', async () => {
    fixtureTex(join(tmp, 'tex'));
    await initProject(tmp, { sync: 'ols' });
    const ol = readFileSync(join(tmp, 'tex', '.olignore'), 'utf8');
    expect(ol).toContain('.olignore');
    expect(ol).toContain('.paper/');
  });

  it('import from a folder, a zip (with a top folder and a zip-slip entry) and a git URL', async () => {
    const src = join(tmp, 'src');
    fixtureTex(src);
    const a = await importProject(src, join(tmp, 'a'), { skill: SKILL_DIR });
    expect(a.source).toBe('dir');
    expect(a.config.mainFile).toBe('main.tex');
    expect(existsSync(join(tmp, 'a', 'tex', 'main.tex'))).toBe(true);
    await expect(importProject(src, join(tmp, 'a'))).rejects.toThrow(/already/);
    await expect(importProject(src, join(src, 'inner'))).rejects.toThrow(/inside/);

    // zip: Overleaf-style with one top folder + an evil member
    const zdir = join(tmp, 'z');
    mkdirSync(join(zdir, 'Canto'), { recursive: true });
    fixtureTex(join(zdir, 'Canto'));
    const zip = join(tmp, 'canto.zip');
    execFileSync('python3', ['-c', `import zipfile,os,sys
z=zipfile.ZipFile(sys.argv[1],'w')
for root,_,files in os.walk(sys.argv[2]):
  for f in files:
    p=os.path.join(root,f); z.write(p, os.path.relpath(p, sys.argv[2]))
z.writestr('Canto/../../evil.txt','x')
z.close()`, zip, zdir]);
    const b = await importProject(zip, join(tmp, 'b'), { skill: SKILL_DIR });
    expect(b.source).toBe('zip');
    expect(existsSync(join(tmp, 'b', 'tex', 'main.tex'))).toBe(true);
    expect(existsSync(join(tmp, 'evil.txt'))).toBe(false);
    expect(existsSync(join(tmp, 'b', 'evil.txt'))).toBe(false);

    // git: a local bare repo stands in for the Overleaf git bridge
    const bare = join(tmp, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'master', bare], { env: GIT_ENV });
    writeFileSync(join(src, 'main.tex'), readFileSync(join(src, 'main.tex'), 'utf8').replace('The test set holds 8,710 targets.\n', 'The test set holds 8,710 targets. '));
    execFileSync('git', ['-C', src, 'init', '-q', '-b', 'master'], { env: GIT_ENV });
    execFileSync('git', ['-C', src, 'add', '-A'], { env: GIT_ENV });
    execFileSync('git', ['-C', src, 'commit', '-qm', 'init'], { env: GIT_ENV });
    execFileSync('git', ['-C', src, 'push', '-q', bare, 'master'], { env: GIT_ENV, stdio: 'ignore' });
    const url = `file://${bare}`;
    expect(sourceKind(url)).toBe('git');
    const c = await importProject(url, join(tmp, 'c'), { skill: SKILL_DIR, semanticLines: true });
    expect(c.source).toBe('git');
    expect(c.config.sync).toMatchObject({ mode: 'git', remote: url, branch: 'master' });
    expect(c.config.semanticLines).toBe(true);
    expect(c.semantic.find((s) => s.file === 'main.tex')!.changed).toBeGreaterThan(0);
  });

  it('semantic lines: one sentence per line, ids preserved on reopen, undo restores the original', async () => {
    fixtureTex(join(tmp, 'tex'));
    const r = await initProject(tmp, { skill: SKILL_DIR });
    const paths = paperPaths(tmp, r.config.texRoot);
    const path = join(paths.tex, 'main.tex');
    // make a paragraph with two sentences on one line
    writeFileSync(path, readFileSync(path, 'utf8').replace('The test set holds 8,710 targets.\n', 'The test set holds 8,710 targets. '));
    const original = readFileSync(path, 'utf8');
    const ctx = await createCtx({ root: tmp, fake: true, logLevel: 'error', watch: false, lintSidecar: false });
    try {
      const st = await ctx.docs.open('main.tex');
      const ids = st.units.map((u) => u.id);
      const res = await applySemanticLines(paths, 'main.tex', ctx.docs);
      expect(res.changed).toBeGreaterThan(0);
      const after = readFileSync(path, 'utf8');
      expect(after).toContain('The test set holds 8,710 targets.\nThe fake-track rate');
      const st2 = ctx.docs.get('main.tex')!;
      expect(st2.text).toBe(after);
      expect(st2.units.map((u) => u.id)).toEqual(ids);
      expect(st2.units.every((u) => u.state === 'human')).toBe(true);
      // every multi-sentence prose paragraph now has its sentences on separate lines
      const seg = segment(after);
      for (const p of seg.paragraphs.filter((p) => p.kind === 'prose'))
        for (let k = 1; k < p.sentenceIndices.length; k++) expect(seg.sentences[p.sentenceIndices[k]!]!.line).toBeGreaterThan(seg.sentences[p.sentenceIndices[k - 1]!]!.line);
      const u = await undoSemanticLines(paths, 'main.tex', ctx.docs);
      expect(u.changed).toBe(res.changed);
      expect(readFileSync(path, 'utf8')).toBe(original);
      expect(ctx.docs.get('main.tex')!.units.map((x) => x.id)).toEqual(ids);
    } finally {
      await ctx.close();
    }
  });

  it('semantic-lines undo after later edits restores the untouched breaks only', async () => {
    fixtureTex(join(tmp, 'tex'));
    const r = await initProject(tmp, { skill: SKILL_DIR });
    const paths = paperPaths(tmp, r.config.texRoot);
    const path = join(paths.tex, 'main.tex');
    writeFileSync(path, readFileSync(path, 'utf8').replace('The test set holds 8,710 targets.\n', 'The test set holds 8,710 targets. '));
    const res = await applySemanticLines(paths, 'main.tex');
    expect(res.changed).toBeGreaterThan(0);
    // an edit elsewhere after normalizing
    writeFileSync(path, readFileSync(path, 'utf8').replace('This lead holds', 'Indeed, this lead holds'));
    const u = await undoSemanticLines(paths, 'main.tex');
    expect(u.changed + u.skipped).toBe(res.changed);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('Indeed, this lead holds');
    expect(text).toContain('The test set holds 8,710 targets. The fake-track rate');
  });

  it('client paths are confined to the tree (no .., absolute or symlink escape)', () => {
    fixtureTex(join(tmp, 'tex'));
    writeFileSync(join(tmp, 'secret.tex'), 'x');
    symlinkSync(join(tmp, 'secret.tex'), join(tmp, 'tex', 'link.tex'));
    symlinkSync(tmp, join(tmp, 'tex', 'up'));
    expect(resolveInTex(join(tmp, 'tex'), './main.tex').rel).toBe('main.tex');
    expect(() => resolveInTex(join(tmp, 'tex'), '../secret.tex')).toThrow();
    expect(() => resolveInTex(join(tmp, 'tex'), '/etc/passwd')).toThrow();
    expect(() => resolveInTex(join(tmp, 'tex'), 'link.tex')).toThrow(/escapes/);
    expect(() => resolveInTex(join(tmp, 'tex'), 'up/secret.tex')).toThrow(/escapes/);
    expect(listFiles(join(tmp, 'tex'), isTexName)).toEqual(['main.tex']);
  });
});

describe('paper CLI', () => {
  let tmp: string;
  let outBuf: string;
  let errBuf: string;
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'paper-cli-'));
    outBuf = '';
    errBuf = '';
    process.stdout.write = ((s: string) => ((outBuf += s), true)) as typeof process.stdout.write;
    process.stderr.write = ((s: string) => ((errBuf += s), true)) as typeof process.stderr.write;
  });
  afterEach(() => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('init, doctor (never prints the key), usage errors, push refusal', async () => {
    cpSync(join(FIXTURE, 'tex'), join(tmp, 'tex'), { recursive: true });
    expect(await cli(['init', tmp, '--skill', SKILL_DIR, '--notes', 'zh'])).toBe(0);
    expect(outBuf).toContain('main file main.tex');
    expect(await cli(['init', tmp, '--venue', 'nature'])).toBe(64);
    expect(errBuf).toContain('--venue must be one of');
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-verysecretvalue0123456789';
    try {
      outBuf = '';
      const code = await cli(['doctor', tmp]);
      expect(outBuf).toContain('Anthropic API key: found (ANTHROPIC_API_KEY)');
      expect(outBuf).not.toContain('verysecret');
      expect(outBuf).toContain('LaTeX tree');
      expect([0, 1]).toContain(code);
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
    expect(await cli(['push', tmp])).toBe(64);
    errBuf = '';
    expect(await cli(['push', tmp, '-m', 'x'])).toBe(1); // sync mode none -> 409
    expect(errBuf).toMatch(/Sync is off/);
    expect(await cli(['frobnicate'])).toBe(64);
    expect(await cli(['help'])).toBe(0);
  });
});
