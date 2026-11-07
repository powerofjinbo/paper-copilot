/**
 * Review round 2 (data safety): an edit made to the .tex file OUTSIDE the app (a `git pull` in a terminal,
 * overleaf-sync, another editor; design.md "External change ... file watcher") must never be overwritten by
 * the app's own debounced disk write.
 *
 * DocService.writeNow writes the mirror to disk 1 s after the last change without checking that the file
 * still holds `st.diskText` (the text the mirror last read or wrote). When the external write lands inside
 * that second, before the watcher (250 ms debounce + 120 ms write-finish stability) has reloaded it, the
 * app's write replaces it; the watcher then reads the app's own text back (isKnownDiskText) and ignores it.
 * The external edit is gone from disk, from the mirror and from every tab, with no conflict copy and no notice.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChangeSet } from '@codemirror/state';
import { createCtx, type AppCtx } from '../../src/ctx';
import { initProject } from '../../src/project/init';
import { makeTempProject, SKILL_DIR, type TempProject } from '../helpers/ctx';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('review2 data: the app never overwrites an external edit on disk', () => {
  let project: TempProject | null = null;
  let ctx: AppCtx | null = null;

  afterEach(async () => {
    await ctx?.close();
    project?.cleanup();
    ctx = null;
    project = null;
  });

  async function setup(watch: boolean, writeDebounceMs: number): Promise<AppCtx> {
    project = await makeTempProject();
    await initProject(project.root, { repo: project.repoDir, skill: SKILL_DIR });
    ctx = await createCtx({ root: project.root, fake: true, logLevel: 'error', watch, lintSidecar: false, docs: { segmentDebounceMs: 20, writeDebounceMs } });
    await ctx.start();
    return ctx;
  }

  /** The author types "Indeed, " before a sentence (a doc.change from a tab). */
  async function authorTypes(c: AppCtx): Promise<void> {
    const st = await c.docs.open('main.tex');
    const at = st.text.indexOf('This lead holds');
    expect(at).toBeGreaterThan(0);
    const ok = await c.docs.applyClientChange(
      { type: 'doc.change', file: 'main.tex', baseVersion: st.version, changes: ChangeSet.of([{ from: at, insert: 'Indeed, ' }], st.text.length).toJSON(), annotation: null },
      { clientId: 'tab-a:socket-1' },
    );
    expect(ok).toBe(true);
  }

  /** A co-author's edit lands on disk (another sentence: "every particle species" -> "each particle species"). */
  function externalEdit(c: AppCtx): void {
    const disk = join(c.paths.tex, 'main.tex');
    const raw = readFileSync(disk, 'utf8');
    expect(raw).toContain('every particle species');
    writeFileSync(disk, raw.replace('every particle species', 'each particle species'));
  }

  const conflictCopies = (c: AppCtx): string[] => {
    const dir = join(c.paths.paper, 'conflicts');
    return existsSync(dir) ? readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')) : [];
  };

  function expectBothKept(c: AppCtx): void {
    const disk = readFileSync(join(c.paths.tex, 'main.tex'), 'utf8');
    const mirror = c.docs.get('main.tex')!.text;
    const copies = conflictCopies(c);
    const externalKept = disk.includes('each particle species') || mirror.includes('each particle species') || copies.some((t) => t.includes('each particle species'));
    expect({ authorOnDisk: disk.includes('Indeed, This lead holds'), externalKept }).toEqual({ authorOnDisk: true, externalKept: true });
  }

  it('real watcher, production write debounce (1 s): an external edit 850 ms after a keystroke survives', async () => {
    const c = await setup(true, 1000);
    await authorTypes(c);
    await sleep(850);
    externalEdit(c);
    // the app's write (t = 1 s) and the watcher's reload (t >= 0.85 + 0.37 s) both have run by now
    await sleep(3000);
    expectBothKept(c);
  }, 20_000);

  it('the write that runs before the watcher noticed the change does not replace it (deterministic order)', async () => {
    const c = await setup(false, 50);
    await authorTypes(c);
    externalEdit(c);
    await sleep(400); // the debounced write fires first
    await c.docs.reloadFromDisk('main.tex', 'external'); // then the watcher's reload
    expectBothKept(c);
  }, 20_000);
});
