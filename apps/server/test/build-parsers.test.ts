import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scrubbedEnv } from '../src/services/build/buildService';
import { flattenTex } from '../src/services/build/flatten';
import { parseLatexLog, tailBytes } from '../src/services/build/latexLog';
import { fallbackShadow, shadowText } from '../src/services/build/shadow';
import { boxFromRecords, parseSynctexEdit, parseSynctexEditAll, parseSynctexView } from '../src/services/build/synctex';

const SHADOW = '/p/.paper/build/src';
const mapFile = (raw: string) => {
  const p = raw.startsWith(SHADOW + '/') ? raw.slice(SHADOW.length + 1) : raw;
  return p.replace(/^(\.\/)+/, '').replace(/^\.\//, '');
};

describe('parseLatexLog', () => {
  it('parses file:line errors, maps shadow paths and names the undefined command', () => {
    const log = [
      'This is pdfTeX, Version 3.141592653',
      '(./main.tex',
      './main.tex:51: Undefined control sequence.',
      'l.51 The test set holds \\undefinedfixturemacro',
      '                                              {} 8,710 targets.',
      '/p/.paper/build/src/./sec/intro.tex:7: LaTeX Error: File `missing.sty\' not found.',
      '',
      '/usr/share/texlive/texmf-dist/tex/latex/base/article.cls:12: Something odd.',
      '! Emergency stop.',
      '<*> main.tex',
      './main.tex:51: Undefined control sequence.',
      'l.51 The test set holds \\undefinedfixturemacro',
    ].join('\n');
    const errs = parseLatexLog(log, { mapFile, mainFile: 'main.tex' });
    expect(errs[0]).toEqual({ file: 'main.tex', line: 51, message: 'Undefined control sequence \\undefinedfixturemacro' });
    expect(errs[1]).toEqual({ file: 'sec/intro.tex', line: 7, message: "LaTeX Error: File `missing.sty' not found." });
    expect(errs[2]!.file).toBe('/usr/share/texlive/texmf-dist/tex/latex/base/article.cls');
    expect(errs[3]).toEqual({ file: 'main.tex', line: null, message: 'Emergency stop.' });
    expect(errs).toHaveLength(4); // the duplicate is dropped
  });

  it('takes the line from the context when a ! error has no file prefix', () => {
    const errs = parseLatexLog('! Missing $ inserted.\n<inserted text>\n                $\nl.12 a_b\n', { mapFile, mainFile: 'main.tex' });
    expect(errs).toEqual([{ file: 'main.tex', line: 12, message: 'Missing $ inserted.' }]);
  });

  it('ignores ordinary log lines and l. lines', () => {
    expect(parseLatexLog('Overfull \\hbox (1.0pt too wide) in paragraph at lines 3--4\nl.3 x: 4: y\n', { mapFile, mainFile: 'm.tex' })).toEqual([]);
  });

  it('tailBytes keeps at most n bytes and starts at a line', () => {
    const text = Array.from({ length: 2000 }, (_, i) => `line ${i} 中文`).join('\n');
    const t = tailBytes(text, 4096);
    expect(Buffer.byteLength(t)).toBeLessThanOrEqual(4096);
    expect(t.startsWith('line ')).toBe(true);
    expect(t.endsWith('line 1999 中文')).toBe(true);
    expect(tailBytes('short', 4096)).toBe('short');
  });
});

describe('SyncTeX output parsing', () => {
  const view = `This is SyncTeX command line utility, version 1.5
SyncTeX result begin
Output:/x/main.pdf
Page:1
x:334.7
y:226.9
h:317.0
v:229.4
W:245.1
H:9.96
before:
offset:-1
middle:
after:
Output:/x/main.pdf
Page:1
x:340.2
y:215.4
h:317.0
v:217.4
W:245.1
H:8.86
before:
Output:/x/main.pdf
Page:1
x:60
y:700
h:50.0
v:702.0
W:245.1
H:8.86
Output:/x/main.pdf
Page:2
h:50
v:100
W:10
H:10
SyncTeX result end
`;

  it('parses every record and converts to a top-left box: top = v - H, height = H', () => {
    const recs = parseSynctexView(view);
    expect(recs).toHaveLength(4);
    expect(recs[0]).toMatchObject({ page: 1, h: 317, v: 229.4, W: 245.1, H: 9.96 });
    const box = boxFromRecords(recs)!;
    // Union of the two right-column records on page 1; the left-column record and page 2 are excluded.
    expect(box.page).toBe(1);
    expect(box.x).toBeCloseTo(317, 5);
    expect(box.y).toBeCloseTo(217.4 - 8.86, 5);
    expect(box.w).toBeCloseTo(245.1, 5);
    expect(box.h).toBeCloseTo(229.4 - (217.4 - 8.86), 5);
  });

  it('returns null for no result', () => {
    expect(boxFromRecords(parseSynctexView('SyncTeX result begin\nSyncTeX result end\n'))).toBeNull();
    expect(boxFromRecords(parseSynctexView('garbage'))).toBeNull();
  });

  it('parses edit records and prefers the innermost (last)', () => {
    const out = `SyncTeX result begin
Output:/x/main.pdf
Input:/x/src/./main.tex
Line:2
Column:-1
Offset:0
Context:
Output:/x/main.pdf
Input:/x/src/./chapters/a.tex
Line:7
Column:3
SyncTeX result end`;
    expect(parseSynctexEditAll(out)).toEqual([
      { input: '/x/src/./main.tex', line: 2, column: null },
      { input: '/x/src/./chapters/a.tex', line: 7, column: 3 },
    ]);
    expect(parseSynctexEdit(out)).toEqual({ input: '/x/src/./chapters/a.tex', line: 7, column: 3 });
    expect(parseSynctexEdit('SyncTeX result begin\nInput:/x\nLine:0\nSyncTeX result end')).toBeNull();
  });
});

describe('shadow text', () => {
  it('blanks intent lines to % and keeps the line count (core or fallback)', () => {
    const src = 'A sentence.\n这里是作者的中文意图，不能进入编译。\nNext sentence. % 中文注释保留\n\\section{结果}\n';
    for (const out of [shadowText(src), fallbackShadow(src)]) {
      const lines = out.split('\n');
      expect(lines).toHaveLength(src.split('\n').length);
      expect(lines[0]).toBe('A sentence.');
      expect(lines[1]).toBe('%');
      expect(lines[2]).toBe('Next sentence. % 中文注释保留');
    }
  });
});

describe('flattenTex', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'flat-'));
    mkdirSync(join(root, 'sec'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('inlines \\input and \\include relative to texRoot with a line map, skipping comments, cycles and escapes', () => {
    writeFileSync(join(root, 'main.tex'), ['Intro line.', '\\input{sec/a}', '% \\input{sec/b}', 'Before \\include{sec/b} after.', '\\input{../outside}', '\\input{sec/missing}', 'End.'].join('\n'));
    writeFileSync(join(root, 'sec', 'a.tex'), 'A one.\nA two \\input{main}\n');
    writeFileSync(join(root, 'sec', 'b.tex'), 'B one.\n');
    const r = flattenTex('main.tex', { texRoot: root });
    expect(r.text.split('\n')).toEqual(['Intro line.', 'A one.', 'A two \\input{main}', '% \\input{sec/b}', 'Before ', 'B one.', ' after.', '\\input{../outside}', '\\input{sec/missing}', 'End.']);
    expect(r.lines).toEqual([
      { file: 'main.tex', line: 1 },
      { file: 'sec/a.tex', line: 1 },
      { file: 'sec/a.tex', line: 2 },
      { file: 'main.tex', line: 3 },
      { file: 'main.tex', line: 4 },
      { file: 'sec/b.tex', line: 1 },
      { file: 'main.tex', line: 4 },
      { file: 'main.tex', line: 5 },
      { file: 'main.tex', line: 6 },
      { file: 'main.tex', line: 7 },
    ]);
    expect(r.files).toEqual(['main.tex', 'sec/a.tex', 'sec/b.tex']);
    expect(r.skipped.map((s) => s.reason).sort()).toEqual(['file not found', 'include cycle', 'outside the LaTeX tree']);
  });

  it('is depth limited, uses the reader and the transform', () => {
    for (let i = 0; i < 12; i++) writeFileSync(join(root, `f${i}.tex`), `L${i}\n\\input f${i + 1}\n`);
    const r = flattenTex('f0.tex', { texRoot: root, maxDepth: 3 });
    expect(r.files).toEqual(['f0.tex', 'f1.tex', 'f2.tex', 'f3.tex']);
    expect(r.skipped[0]!.reason).toMatch(/deeper/);
    const live = flattenTex('main.tex', {
      texRoot: root,
      read: (rel) => (rel === 'main.tex' ? '中文意图行在这里写。\nText.' : null),
      transform: (t) => shadowText(t),
    });
    expect(live.text).toBe('%\nText.');
  });
});

describe('scrubbedEnv', () => {
  it('drops secrets from the environment latexmk (and a project latexmkrc) sees', () => {
    const env = scrubbedEnv({ PATH: '/usr/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk-ant-x', GITHUB_TOKEN: 't', PAPER_TOKEN: 'p', DB_PASSWORD: 'x', TEXINPUTS: '.:' });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/h', TEXINPUTS: '.:' });
  });
});

describe('missingFileHint', () => {
  it('names the TeX package to install for a missing class or package', async () => {
    const { missingFileHint } = await import('../src/services/build/latexLog');
    expect(missingFileHint("LaTeX Error: File `revtex4-2.cls' not found.", '')).toMatch(/tlmgr install revtex\b/);
    expect(missingFileHint("LaTeX Error: File `textcase.sty' not found.", '')).toMatch(/tlmgr install textcase/);
    expect(missingFileHint('Undefined control sequence.', '')).toBeNull();
  });
  it('says when the compile used TinyTeX', async () => {
    const { missingFileHint } = await import('../src/services/build/latexLog');
    const log = '(/Users/me/Library/TinyTeX/texmf-dist/tex/latex/revtex/revtex4-2.cls';
    const h = missingFileHint("LaTeX Error: File `textcase.sty' not found.", log)!;
    expect(h).toMatch(/TinyTeX/);
    expect(h).toMatch(/\/Library\/TeX\/texbin/);
  });
});
