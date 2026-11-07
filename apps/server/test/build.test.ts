/**
 * BuildService against the real TeX Live toolchain (latexmk, pdflatex, bibtex, synctex) on the fixture.
 * Skipped when latexmk or synctex is not installed.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@paper-copilot/core';
import type { BuildService, Ctx } from '../src/contracts';
import { createBuildService } from '../src/services/build/buildService';
import { makeTempProject, makeTestCtx, type TempProject } from './helpers/ctx';

const has = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { stdio: 'ignore' });
  return !r.error && r.status !== null;
};
const TEX = has('latexmk', ['-v']) && has('synctex', ['help']);
const POPPLER = has('pdfinfo', ['-v']) && has('pdftotext', ['-v']);

function lineOfText(text: string, needle: string): number {
  const i = text.split('\n').findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`not found: ${needle}`);
  return i + 1;
}

function pageSize(pdf: string): { w: number; h: number } {
  const out = execFileSync('pdfinfo', [pdf], { encoding: 'utf8' });
  const m = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(out)!;
  return { w: Number(m[1]), h: Number(m[2]) };
}

/** Word boxes (top-left origin, points) from pdftotext -bbox. */
function wordBoxes(pdf: string): Array<{ word: string; page: number; x0: number; y0: number; x1: number; y1: number }> {
  const html = execFileSync('pdftotext', ['-bbox', pdf, '-'], { encoding: 'utf8' });
  const out: Array<{ word: string; page: number; x0: number; y0: number; x1: number; y1: number }> = [];
  let page = 0;
  for (const line of html.split('\n')) {
    if (line.includes('<page ')) page++;
    const m = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/.exec(line);
    if (m) out.push({ word: m[5]!, page, x0: Number(m[1]), y0: Number(m[2]), x1: Number(m[3]), y1: Number(m[4]) });
  }
  return out;
}

describe.skipIf(!TEX)('BuildService with latexmk + synctex (fixture)', () => {
  let project: TempProject;
  let ctx: Ctx & { events: ServerMessage[] };
  let build: BuildService;
  let mainPath: string;
  let original: string;
  const RESULTS = 'On the isolated gun particles, the tracker finds';

  beforeAll(async () => {
    project = await makeTempProject();
    ctx = makeTestCtx(project);
    build = createBuildService(ctx);
    (ctx as { build: BuildService }).build = build;
    mainPath = join(project.paths.tex, 'main.tex');
    original = readFileSync(mainPath, 'utf8');
  });
  afterAll(() => project?.cleanup());

  it('probes the tools once', () => {
    expect(build.available()).toEqual({ latexmk: true, synctex: true });
  });

  let firstBox: { page: number; x: number; y: number; w: number; h: number } | null = null;

  it('compiles the fixture, publishes the PDF and emits compile.status', async () => {
    const st = await build.compile('manual');
    expect(st.errors).toEqual([]);
    expect(st.state).toBe('ok');
    expect(st.pdfVersion).toBe(1);
    expect(st.logTail.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(st.logTail)).toBeLessThanOrEqual(4096);
    const pdf = build.pdfPath();
    expect(pdf).not.toBeNull();
    expect(readFileSync(pdf!).subarray(0, 5).toString()).toBe('%PDF-');
    const states = ctx.events.filter((e) => e.type === 'compile.status').map((e) => (e as { state: string }).state);
    expect(states).toEqual(['running', 'ok']);
    // The bibliography resolved from the shadow's working directory (refs.bib relative path).
    expect(readFileSync(join(project.paths.build, 'out', 'main.bbl'), 'utf8')).toContain('Wang');
  }, 180_000);

  it('forward SyncTeX puts the Results sentence inside the page, on its words', async () => {
    const line = lineOfText(original, RESULTS);
    const box = await build.forward('main.tex', line);
    expect(box).not.toBeNull();
    firstBox = box;
    expect([1, 2]).toContain(box!.page);
    const pdf = build.pdfPath()!;
    if (POPPLER) {
      const size = pageSize(pdf);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.w).toBeLessThanOrEqual(size.w);
      expect(box!.y + box!.h).toBeLessThanOrEqual(size.h);
      expect(box!.w).toBeGreaterThan(50);
      expect(box!.h).toBeGreaterThan(5);
      // The words "acorn" and "builder;" of this sentence lie inside the box (1 pt tolerance).
      const words = wordBoxes(pdf).filter((w) => w.page === box!.page);
      for (const target of ['acorn', 'builder;']) {
        const inside = words.filter((w) => w.word === target).some((w) => w.x0 >= box!.x - 1 && w.x1 <= box!.x + box!.w + 1 && w.y0 >= box!.y - 1 && w.y1 <= box!.y + box!.h + 1);
        expect(inside, target).toBe(true);
      }
    }
  });

  it('inverse SyncTeX maps a point of that box back to main.tex and the same line', async () => {
    const line = lineOfText(original, RESULTS);
    const b = firstBox!;
    const hit = await build.inverse(b.page, b.x + Math.min(20, b.w / 2), b.y + b.h / 2);
    expect(hit).toEqual({ file: 'main.tex', line });
  });

  it('rejects paths outside the tree and lines that do not exist', async () => {
    expect(await build.forward('../etc/passwd', 3)).toBeNull();
    expect(await build.forward('/etc/passwd', 3)).toBeNull();
    expect(await build.forward('main.tex', 0)).toBeNull();
    expect(await build.inverse(0, 10, 10)).toBeNull();
  });

  it('a Chinese intent line does not break the compile and keeps every line number', async () => {
    const lines = original.split('\n');
    const at = lineOfText(original, RESULTS) - 1;
    lines.splice(at, 0, '这里写结果：先给出效率差，再给出假径迹率。');
    writeFileSync(mainPath, lines.join('\n'));
    const st = await build.compile('save');
    expect(st.errors).toEqual([]);
    expect(st.state).toBe('ok');
    expect(st.pdfVersion).toBe(2);
    // The shadow copy has the intent line blanked and the same number of lines.
    const shadow = readFileSync(join(project.paths.build, 'src', 'main.tex'), 'utf8').split('\n');
    expect(shadow.length).toBe(lines.length);
    expect(shadow[at]).toMatch(/^%?$/);
    expect(/[\u4e00-\u9fff]/.test(shadow.join('\n'))).toBe(false);
    expect(shadow[at + 1]).toContain(RESULTS);
    // SyncTeX of the line after the intent line lands on the same box as before.
    const line = lineOfText(lines.join('\n'), RESULTS);
    expect(line).toBe(at + 2);
    const box = await build.forward('main.tex', line);
    expect(box).toEqual(firstBox);
    const hit = await build.inverse(box!.page, box!.x + 10, box!.y + box!.h / 2);
    expect(hit).toEqual({ file: 'main.tex', line });
  }, 180_000);

  it('reports an undefined control sequence at its real file and line and still shows the PDF pdflatex wrote (UX2-1)', async () => {
    const lines = original.split('\n');
    const at = lineOfText(original, 'The test set holds') - 1;
    lines[at] = 'The test set holds \\undefinedfixturemacro{} 8,710 targets.';
    // An intent line above it must not shift the reported line.
    lines.splice(5, 0, '中文意图行：这一行不应该被编译。');
    writeFileSync(mainPath, lines.join('\n'));
    const before = build.status().pdfVersion;
    const st = await build.compile('manual');
    expect(st.state).toBe('error');
    // pdflatex recovered and wrote a complete PDF: it is published, as Overleaf shows it (UX2-1).
    expect(st.pdfVersion).toBe((before ?? 0) + 1);
    // latexmk -f kept going: bibtex and the reruns ran, so the PDF has no unresolved "??" references
    if (POPPLER) expect(execFileSync('pdftotext', [build.pdfPath()!, '-'], { encoding: 'utf8' })).not.toContain('??');
    const err = st.errors.find((e) => /Undefined control sequence/.test(e.message));
    expect(err).toBeDefined();
    expect(err!.file).toBe('main.tex');
    expect(err!.line).toBe(at + 2);
    expect(err!.message).toContain('\\undefinedfixturemacro');
    expect(build.pdfPath()).not.toBeNull();
    const last = ctx.events.filter((e) => e.type === 'compile.status').at(-1) as Extract<ServerMessage, { type: 'compile.status' }>;
    expect(last.state).toBe('error');
    expect(last.errors.length).toBeGreaterThan(0);
  }, 180_000);

  it('a run that writes no PDF (error before \\begin{document}) keeps the last PDF and its version', async () => {
    const lines = original.split('\n');
    const at = lines.findIndex((l) => l.startsWith('\\begin{document}'));
    lines.splice(at, 0, '\\usepackage{nosuchpackage-paper-copilot}');
    writeFileSync(mainPath, lines.join('\n'));
    const before = build.status().pdfVersion;
    const pdfBefore = readFileSync(build.pdfPath()!);
    const st = await build.compile('manual');
    expect(st.state).toBe('error');
    expect(st.pdfVersion).toBe(before);
    expect(readFileSync(build.pdfPath()!).equals(pdfBefore)).toBe(true);
  }, 180_000);

  it('coalesces concurrent compiles into at most one follow-up run', async () => {
    writeFileSync(mainPath, original);
    const n0 = ctx.events.filter((e) => e.type === 'compile.status' && (e as { state: string }).state === 'running').length;
    const a = build.compile('save');
    const b = build.compile('save');
    const c = build.compile('manual');
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra.state).toBe('ok');
    expect(rb).toBe(rc); // b and c share the follow-up run
    const runs = ctx.events.filter((e) => e.type === 'compile.status' && (e as { state: string }).state === 'running').length - n0;
    expect(runs).toBe(2);
  }, 240_000);
});

describe.skipIf(!TEX)('BuildService: \\input/\\include in sub-directories', () => {
  let project: TempProject;
  let build: BuildService;
  beforeAll(async () => {
    project = await makeTempProject();
    const tex = project.paths.tex;
    mkdirSync(join(tex, 'sections'), { recursive: true });
    mkdirSync(join(tex, 'chapters'), { recursive: true });
    writeFileSync(
      join(tex, 'main.tex'),
      [
        '\\documentclass{article}',
        '\\begin{document}',
        'Main text before the inputs.',
        '',
        '\\input{sections/results}',
        '',
        '\\include{chapters/appendix}',
        '\\end{document}',
        '',
      ].join('\n'),
    );
    writeFileSync(join(tex, 'sections', 'results.tex'), ['% results', '意图：先写主要结果。', 'The tracker finds more displaced particles than the baseline in every bin.', ''].join('\n'));
    writeFileSync(join(tex, 'chapters', 'appendix.tex'), ['\\section{Appendix}', 'The appendix sentence lives in an included chapter.', ''].join('\n'));
    build = createBuildService(makeTestCtx(project));
  });
  afterAll(() => project?.cleanup());

  it('compiles (include aux directory exists) and maps SyncTeX to the sub-files', async () => {
    const st = await build.compile('manual');
    expect(st.errors).toEqual([]);
    expect(st.state).toBe('ok');
    const box = await build.forward('sections/results.tex', 3);
    expect(box).not.toBeNull();
    const hit = await build.inverse(box!.page, box!.x + 5, box!.y + box!.h / 2);
    expect(hit).toEqual({ file: 'sections/results.tex', line: 3 });
    const abox = await build.forward('chapters/appendix.tex', 2);
    expect(abox).not.toBeNull();
    expect(await build.inverse(abox!.page, abox!.x + abox!.w / 2, abox!.y + abox!.h / 2)).toEqual({ file: 'chapters/appendix.tex', line: 2 });
    expect(existsSync(join(project.paths.build, 'out', 'chapters', 'appendix.aux'))).toBe(true);
  }, 180_000);

  it('mirrors only changed files and removes deleted ones from the shadow', async () => {
    const tex = project.paths.tex;
    writeFileSync(join(tex, 'notes.txt'), 'x');
    await build.compile('manual');
    expect(existsSync(join(project.paths.build, 'src', 'notes.txt'))).toBe(true);
    const { rmSync } = await import('node:fs');
    rmSync(join(tex, 'notes.txt'));
    await build.compile('manual');
    expect(existsSync(join(project.paths.build, 'src', 'notes.txt'))).toBe(false);
  }, 180_000);
});

describe.skipIf(!TEX)('BuildService when latexmk remembers an earlier failure (latexmk 4.87 on macOS)', () => {
  // latexmk >= 4.87 refuses to rerun while the sources are unchanged after a failed pdflatex run
  // ("Nothing to do ... gave an error in previous invocation", exit 12). Seen on the author's Mac after
  // TeX was installed while the app was already open: every later compile repeated the stale failure.
  // The fake latexmk below answers like 4.87 unless it is forced with -g, then runs the real latexmk.
  function fakeLatexmk(dir: string): { bin: string; calls: () => string[][] } {
    const bin = join(dir, 'fake-latexmk');
    const log = join(dir, 'calls.log');
    writeFileSync(
      bin,
      `#!/bin/sh
echo "$*" >> '${log}'
for a in "$@"; do
  if [ "$a" = "-g" ]; then exec latexmk "$@"; fi
done
echo "Latexmk: Nothing to do for 'main.tex'."
echo "Collected error summary (may duplicate other messages):"
echo "  pdflatex: gave an error in previous invocation of latexmk."
exit 12
`,
      { mode: 0o755 },
    );
    // compile runs only (the availability probe 'latexmk -v' is not a compile)
    return { bin, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ')).filter((a) => !(a.length === 1 && a[0] === '-v')) : []) };
  }

  it('a manual compile forces a run (-g) and succeeds', async () => {
    const project = await makeTempProject();
    try {
      const fake = fakeLatexmk(project.root);
      const build = createBuildService(makeTestCtx(project), { latexmk: fake.bin });
      const st = await build.compile('manual');
      expect(st.state).toBe('ok');
      expect(fake.calls()[0]).toContain('-g');
      await build.close?.();
    } finally {
      project.cleanup();
    }
  });

  it('a compile on save that hits the remembered failure retries once with -g', async () => {
    const project = await makeTempProject();
    try {
      const fake = fakeLatexmk(project.root);
      const build = createBuildService(makeTestCtx(project), { latexmk: fake.bin });
      const st = await build.compile('save');
      expect(st.state).toBe('ok');
      const calls = fake.calls();
      expect(calls).toHaveLength(2);
      expect(calls[0]).not.toContain('-g');
      expect(calls[1]).toContain('-g');
      await build.close?.();
    } finally {
      project.cleanup();
    }
  });
});

describe('BuildService without the toolchain', () => {
  it('reports a missing latexmk clearly instead of throwing', async () => {
    const project = await makeTempProject();
    try {
      const ctx = makeTestCtx(project);
      const build = createBuildService(ctx, { latexmk: '/nonexistent/latexmk', synctex: '/nonexistent/synctex' });
      expect(build.available()).toEqual({ latexmk: false, synctex: false });
      const st = await build.compile('manual');
      expect(st.state).toBe('error');
      expect(st.errors[0]!.message).toMatch(/latexmk was not found/);
      expect(build.pdfPath()).toBeNull();
      expect(await build.forward('main.tex', 10)).toBeNull();
    } finally {
      project.cleanup();
    }
  });

  it('debounces scheduleCompile', async () => {
    const project = await makeTempProject();
    try {
      const ctx = makeTestCtx(project);
      const build = createBuildService(ctx, { latexmk: '/nonexistent/latexmk', debounceMs: 30 });
      build.scheduleCompile();
      build.scheduleCompile();
      build.scheduleCompile();
      await new Promise((r) => setTimeout(r, 200));
      const runs = ctx.events.filter((e) => e.type === 'compile.status' && (e as { state: string }).state === 'running');
      expect(runs.length).toBe(1);
    } finally {
      project.cleanup();
    }
  });
});

describe('BuildService shutdown', () => {
  it('close() cancels a scheduled compile and refuses new ones', async () => {
    const project = await makeTempProject();
    try {
      const ctx = makeTestCtx(project);
      const build = createBuildService(ctx, { latexmk: '/nonexistent/latexmk', debounceMs: 30 });
      build.scheduleCompile();
      await build.close!();
      build.scheduleCompile();
      await build.compile('manual');
      await new Promise((r) => setTimeout(r, 150));
      expect(ctx.events.filter((e) => e.type === 'compile.status')).toEqual([]);
    } finally {
      project.cleanup();
    }
  });

  it('close() stops a running latexmk (whole process group) and waits for it', async () => {
    const project = await makeTempProject();
    try {
      const ctx = makeTestCtx(project);
      // A stand-in latexmk that answers the probe and then hangs, as pdflatex can on a big paper.
      const fake = join(project.root, 'fake-latexmk.sh');
      const marker = join(project.root, 'after-close');
      writeFileSync(fake, `#!/bin/sh\ncase "$1" in -v) echo fake; exit 0;; esac\nsleep 20\ntouch "${marker}"\n`, { mode: 0o755 });
      const build = createBuildService(ctx, { latexmk: fake, timeoutMs: 60_000 });
      const pending = build.compile('manual');
      await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'compile.status' && (e as { state: string }).state === 'running')).toBe(true), { timeout: 5000 });
      await new Promise((r) => setTimeout(r, 300));
      const t0 = Date.now();
      await build.close!();
      expect(Date.now() - t0).toBeLessThan(5000);
      const st = await pending;
      expect(st.state).toBe('error');
      expect(st.errors[0]!.message).toMatch(/shutting down/);
      expect(existsSync(marker)).toBe(false);
    } finally {
      project.cleanup();
    }
  }, 30_000);
});
