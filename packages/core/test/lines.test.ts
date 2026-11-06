import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findIntentLines, isIntentLine, shadowForCompile, toSemanticLines, type TextEdit } from '../src/latex/lines';
import { segment } from '../src/latex/segment';

const canto = readFileSync(fileURLToPath(new URL('../../../fixtures/canto-demo/tex/main.tex', import.meta.url)), 'utf8');

const apply = (src: string, edits: TextEdit[]): string => {
  let out = src;
  for (const e of [...edits].sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return out;
};

describe('isIntentLine', () => {
  it('recognizes lines that are mostly CJK', () => {
    expect(isIntentLine('这里写一下为什么只用ttbar训练很重要')).toBe(true);
    expect(isIntentLine('   把基线放在前面，再给出效率的差别。')).toBe(true);
    expect(isIntentLine('ここで基準線を説明する')).toBe(true);
    expect(isIntentLine('여기에 기준선을 설명한다')).toBe(true);
    expect(isIntentLine('ＦＵＬＬＷＩＤＴＨ　ＴＥＸＴ')).toBe(true);
  });

  it('uses both thresholds: 30% of non-space characters, or >= 4 CJK and more CJK than Latin letters', () => {
    // 3 CJK out of 9 non-space characters: 33%
    expect(isIntentLine('abc def 中文字')).toBe(true);
    // 4 CJK, 3 Latin letters, but many digits and symbols: below 30%, more CJK than Latin
    expect(isIntentLine('中文中文 abc 1234567890 ++++')).toBe(true);
    // a few CJK characters inside an English sentence are not an intent line
    expect(isIntentLine('The detector of the 清华 group measures the tracks in the barrel.')).toBe(false);
    expect(isIntentLine('\\author{Jinbo Wang (王金波)}')).toBe(false);
  });

  it('ignores comments, English and empty lines', () => {
    expect(isIntentLine('% 这是一行注释，不算意图行')).toBe(false);
    expect(isIntentLine('   %这是注释')).toBe(false);
    expect(isIntentLine('Text before a comment. % 这里是中文注释，很长很长')).toBe(false);
    expect(isIntentLine('A plain English sentence.')).toBe(false);
    expect(isIntentLine('')).toBe(false);
    expect(isIntentLine('   ')).toBe(false);
  });

  it('an escaped \\% does not start a comment', () => {
    expect(isIntentLine('效率是 96\\% 中文说明这里')).toBe(true);
  });
});

describe('findIntentLines', () => {
  it('reports offsets of the line content and 1-based line numbers', () => {
    const src = 'First sentence.\n这里写中文的意图说明\nSecond sentence.\n  再写一句中文笔记\n% 注释中的中文\nLast.';
    const lines = findIntentLines(src);
    expect(lines).toEqual([
      { start: 16, end: 26, line: 2, text: '这里写中文的意图说明' },
      { start: 44, end: 54, line: 4, text: '  再写一句中文笔记' },
    ]);
    for (const l of lines) expect(src.slice(l.start, l.end)).toBe(l.text);
  });

  it('handles CRLF, a last line without newline, and sources without CJK', () => {
    const src = 'A.\r\n中文笔记在这里\r\nB.\r\n最后一行中文';
    const lines = findIntentLines(src);
    expect(lines.map((l) => [l.line, l.text])).toEqual([
      [2, '中文笔记在这里'],
      [4, '最后一行中文'],
    ]);
    expect(src.slice(lines[0]!.end, lines[0]!.end + 2)).toBe('\r\n');
    expect(findIntentLines(canto)).toEqual([]);
    expect(findIntentLines('')).toEqual([]);
  });

  it('agrees with isIntentLine on every line', () => {
    const src = ['中文中文', 'english', '% 中文', 'x 中文中文中文 y', '中文 % english english english', 'abc 中文字'].join('\n');
    const found = new Set(findIntentLines(src).map((l) => l.line));
    src.split('\n').forEach((line, k) => expect(found.has(k + 1)).toBe(isIntentLine(line)));
  });
});

describe('shadowForCompile', () => {
  it('replaces the content of intent lines by % and keeps every line', () => {
    const src = 'First sentence.\n这里写中文的意图说明\nSecond sentence.\n% 注释中的中文保留\n  再写一句中文笔记\n';
    const shadow = shadowForCompile(src);
    expect(shadow).toBe('First sentence.\n%\nSecond sentence.\n% 注释中的中文保留\n%\n');
    expect(shadow.split('\n')).toHaveLength(src.split('\n').length);
  });

  it('returns the source unchanged when there is no intent line', () => {
    expect(shadowForCompile(canto)).toBe(canto);
    const withComment = 'Text. % 中文注释，很长很长很长\nMore.';
    expect(shadowForCompile(withComment)).toBe(withComment);
  });

  it('keeps CRLF line ends', () => {
    expect(shadowForCompile('A.\r\n中文笔记在这里\r\nB.')).toBe('A.\r\n%\r\nB.');
  });

  const pdflatexOk = ((): boolean => {
    try {
      execFileSync('pdflatex', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!pdflatexOk)('the shadow compiles where the raw source with a CJK note does not, and keeps the paragraph whole', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-shadow-'));
    try {
      const src = '\\documentclass{article}\n\\begin{document}\nFirst sentence.\n这里写中文笔记\nSecond sentence.\n\\end{document}\n';
      const run = (name: string, text: string): boolean => {
        writeFileSync(join(dir, `${name}.tex`), text);
        try {
          execFileSync('pdflatex', ['-interaction=nonstopmode', '-halt-on-error', '-draftmode', `${name}.tex`], { cwd: dir, stdio: 'ignore' });
          return true;
        } catch {
          return false;
        }
      };
      expect(run('raw', src)).toBe(false);
      expect(run('shadow', shadowForCompile(src))).toBe(true);
      // the shadow and the same text without the note produce the same paragraphs
      expect(segment(shadowForCompile(src)).paragraphs).toHaveLength(segment(src).paragraphs.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('toSemanticLines', () => {
  it('is a no-op on a source that already has one sentence per line', () => {
    const seg = segment(canto);
    const { text, edits } = toSemanticLines(canto, seg);
    expect(edits).toEqual([]);
    expect(text).toBe(canto);
  });

  it('puts each prose sentence on its own line and is idempotent', () => {
    const src = [
      '\\begin{document}',
      'First sentence. Second sentence.   Third one~\\cite{a}. Fourth',
      '  sentence spans lines. Fifth.',
      '',
      'New paragraph. With two.',
      '\\end{document}',
    ].join('\n');
    const seg = segment(src);
    const { text, edits } = toSemanticLines(src, seg);
    expect(text).toBe(
      [
        '\\begin{document}',
        'First sentence.',
        'Second sentence.',
        'Third one~\\cite{a}.',
        'Fourth',
        '  sentence spans lines.',
        'Fifth.',
        '',
        'New paragraph.',
        'With two.',
        '\\end{document}',
      ].join('\n'),
    );
    expect(apply(src, edits)).toBe(text);
    for (let k = 1; k < edits.length; k++) expect(edits[k]!.from).toBeGreaterThanOrEqual(edits[k - 1]!.to);
    // same sentences afterwards, and nothing left to do
    const seg2 = segment(text);
    expect(seg2.sentences.map((s) => s.text)).toEqual(seg.sentences.map((s) => s.text));
    expect(toSemanticLines(text, seg2).edits).toEqual([]);
  });

  it('never touches captions, footnotes, math, comments or the inside of a sentence', () => {
    const src = [
      '\\begin{document}',
      'One \\footnote{Note one. Note two.} here. Two $a. B$ math. Three. % comment. Four.',
      'Five.',
      '\\begin{figure}\\caption{Cap one. Cap two.}\\end{figure}',
      '\\end{document}',
    ].join('\n');
    const seg = segment(src);
    const { text, edits } = toSemanticLines(src, seg);
    expect(text).toBe(
      [
        '\\begin{document}',
        'One \\footnote{Note one. Note two.} here.',
        'Two $a. B$ math.',
        'Three. % comment. Four.',
        'Five.',
        '\\begin{figure}\\caption{Cap one. Cap two.}\\end{figure}',
        '\\end{document}',
      ].join('\n'),
    );
    expect(edits).toHaveLength(2);
  });

  it('keeps the line-ending convention of a CRLF file', () => {
    const src = 'One. Two.\r\nThree.\r\n';
    const { text } = toSemanticLines(src, segment(src));
    expect(text).toBe('One.\r\nTwo.\r\nThree.\r\n');
    expect(toSemanticLines(text, segment(text)).edits).toEqual([]);
  });

  it('works on the hard manuscript and preserves every unit text', () => {
    const hard = readFileSync(fileURLToPath(new URL('./fixtures/segment/prd-hard.tex', import.meta.url)), 'utf8');
    const seg = segment(hard);
    const { text, edits } = toSemanticLines(hard, seg);
    expect(edits.length).toBeGreaterThan(5);
    const seg2 = segment(text);
    expect(seg2.sentences.map((s) => s.text)).toEqual(seg.sentences.map((s) => s.text));
    expect(seg2.paragraphs.length).toBe(seg.paragraphs.length);
    expect(text.split('\n').length).toBe(hard.split('\n').length + edits.length - edits.filter((e) => hard.slice(e.from, e.to).includes('\n')).length);
    expect(toSemanticLines(text, seg2).edits).toEqual([]);
  });
});
