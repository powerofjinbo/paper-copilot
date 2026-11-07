/**
 * Review round 2 (data safety): a co-author's edit on disk and the author's unsaved paragraph, far apart in
 * the file, cannot be merged: the disk text replaces the editor text.
 *
 * DocService.reloadNow merges a disk change into a mirror with unsaved edits by diff-match-patch
 * (patch_make(diskText, disk) + patch_apply(mirror)) with the library defaults. patch_apply finds each hunk
 * by fuzzy match near its expected position, and an exact match counts only when it lies within
 * Match_Distance * Match_Threshold = 1000 * 0.5 = 500 characters of the position the hunk had on disk. A
 * paragraph of more than ~500 characters typed or pasted ABOVE the co-author's edit (an accepted AI draft,
 * a paste, an \input section rewritten) and not yet written (1 s debounce, or a pull holding writes)
 * shifts the hunk out of range: the merge "fails", the disk version becomes the editor text in every tab,
 * and the author's paragraph is only in .paper/conflicts/<file>.<stamp>.tex (with a warning notice).
 * The two edits touch different paragraphs; a merge of them must keep both in the editor.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChangeSet } from '@codemirror/state';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createCtx, type AppCtx } from '../../src/ctx';
import { initProject } from '../../src/project/init';
import { makeTempProject, SKILL_DIR, type TempProject } from '../helpers/ctx';

let project: TempProject;
let ctx: AppCtx;

beforeAll(async () => {
  project = await makeTempProject();
  await initProject(project.root, { repo: project.repoDir, skill: SKILL_DIR });
  ctx = await createCtx({ root: project.root, fake: true, logLevel: 'error', watch: false, lintSidecar: false, docs: { segmentDebounceMs: 20, writeDebounceMs: 60_000 } });
  await ctx.start();
});

afterAll(async () => {
  await ctx?.close();
  project?.cleanup();
});

const PARAGRAPH =
  'We repeat the comparison with half of the training events, so that both trackers see fewer examples than in the main study. ' +
  'The generic-trained tracker keeps its lead at every displacement, and the gap to the signal-trained baseline shrinks only slightly. ' +
  'The fake-track rate rises for both trackers, by a similar relative amount, which shows that the smaller sample affects them alike. ' +
  'We also train three times with different random seeds and find the same ordering each time, so the result is not an accident of one training run. ' +
  'The appendix lists the numbers for each seed.\n\n';

it('keeps a 600-character unsaved paragraph AND a co-author edit 23 lines (1.4 KB) below it (a 250-character paragraph merges fine)', async () => {
  const st = await ctx.docs.open('main.tex');
  // the author pastes a paragraph after the first section heading (an unsaved edit: the write is debounced)
  const at = st.text.indexOf('\n', st.text.indexOf('\\section{')) + 1;
  expect(PARAGRAPH.length).toBeGreaterThan(550);
  const ok = await ctx.docs.applyClientChange(
    { type: 'doc.change', file: 'main.tex', baseVersion: st.version, changes: ChangeSet.of([{ from: at, insert: PARAGRAPH }], st.text.length).toJSON(), annotation: null },
    { clientId: 'tab-a:socket-1' },
  );
  expect(ok).toBe(true);

  // a co-author's one-word fix lands on disk further down (Overleaf sync, git pull in a terminal)
  const disk = join(ctx.paths.tex, 'main.tex');
  const raw = readFileSync(disk, 'utf8');
  const target = 'The fake-track rate is 0.55';
  expect(raw.indexOf(target)).toBeGreaterThan(raw.indexOf('\\section{') + 200);
  writeFileSync(disk, raw.replace(target, 'The fake-track rate is only 0.55'));
  await ctx.docs.reloadFromDisk('main.tex', 'external');

  const mirror = ctx.docs.get('main.tex')!.text;
  const dir = join(ctx.paths.paper, 'conflicts');
  const copies = existsSync(dir) ? readdirSync(dir) : [];
  // today: { paragraphInEditor: false, coauthorEdit: true, conflictCopies: 1 }
  expect({ paragraphInEditor: mirror.includes(PARAGRAPH.trim()), coauthorEdit: mirror.includes('rate is only 0.55'), conflictCopies: copies.length }).toEqual({
    paragraphInEditor: true,
    coauthorEdit: true,
    conflictCopies: 0,
  });
}, 30_000);
