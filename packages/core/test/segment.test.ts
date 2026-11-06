import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ABBREVIATIONS } from '../src/latex/abbreviations';
import { shadowForCompile } from '../src/latex/lines';
import { compareWithStyleCheck, parseStyleCheckDump } from '../src/latex/scan/compare';
import { lineOf, segment, type SegSentence, type Segmentation } from '../src/latex/segment';

/** Shared CI runners are slower and noisier than a laptop: timing budgets get 3x slack there. */
const PERF_SLACK = process.env.CI ? 3 : 1;

const fixturePath = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const CANTO = fixturePath('../../../fixtures/canto-demo/tex/main.tex');
const HARD = fixturePath('./fixtures/segment/prd-hard.tex');
const canto = readFileSync(CANTO, 'utf8');
const hard = readFileSync(HARD, 'utf8');

const texts = (seg: Segmentation): string[] => seg.sentences.map((s) => s.text);
const sents = (src: string): string[] => texts(segment(src));

/** Invariants every segmentation must satisfy. */
function checkInvariants(src: string, seg: Segmentation): void {
  let prevStart = -1;
  seg.sentences.forEach((s, k) => {
    expect(s.text).toBe(src.slice(s.start, s.end));
    expect(s.text).toBe(s.text.trim());
    expect(s.text.length).toBeGreaterThan(0);
    expect(s.start).toBeGreaterThanOrEqual(prevStart);
    prevStart = s.start;
    expect(s.line).toBe(lineOf(src, s.start));
    const p = seg.paragraphs[s.paragraphIndex]!;
    expect(p.sentenceIndices[s.indexInParagraph]).toBe(k);
    expect(p.kind).toBe(s.kind);
    expect(seg.sections.some((x) => x.id === s.sectionId)).toBe(true);
  });
  seg.paragraphs.forEach((p, k) => {
    expect(p.index).toBe(k);
    expect(p.sentenceIndices.length).toBeGreaterThan(0);
    if (k > 0) expect(p.start).toBeGreaterThanOrEqual(seg.paragraphs[k - 1]!.start);
  });
  expect(new Set(seg.sections.map((s) => s.id)).size).toBe(seg.sections.length);
  // prose sentences of one paragraph never overlap
  for (const p of seg.paragraphs) {
    for (let k = 1; k < p.sentenceIndices.length; k++) {
      expect(seg.sentences[p.sentenceIndices[k]!]!.start).toBeGreaterThanOrEqual(seg.sentences[p.sentenceIndices[k - 1]!]!.end);
    }
  }
}

describe('segment: fixtures/canto-demo/tex/main.tex', () => {
  const seg = segment(canto);
  const bySection = (id: string, kind?: SegSentence['kind']): SegSentence[] =>
    seg.sentences.filter((s) => s.sectionId === id && (kind === undefined || s.kind === kind));

  it('produces 26 units with exact source slices', () => {
    expect(seg.sentences).toHaveLength(26);
    expect(seg.fragment).toBe(false);
    checkInvariants(canto, seg);
  });

  it('every unit ends with its terminal punctuation (or the footnote attached to it)', () => {
    for (const s of seg.sentences) {
      expect(s.text).toMatch(/[.?!]$|[.?!]\\footnote\{[^]*\}$/);
    }
  });

  it('abstract: 5 prose sentences', () => {
    const a = bySection('abstract');
    expect(a).toHaveLength(5);
    for (const s of a) {
      expect(s.part).toBe('abstract');
      expect(s.kind).toBe('prose');
      expect(s.sectionTitle).toBe('Abstract');
    }
    expect(a[0]!.text).toBe('Charged particles from the decay of a long-lived particle start far from the collision point.');
    expect(a[0]!.line).toBe(18);
    expect(a[3]!.text).toBe('We study a tracker trained only on \\ttbar{} events.');
    expect(a[4]!.text).toMatch(/^On isolated displaced particles .* 0\.55\\% against 1\.38\\%\.$/);
  });

  it('introduction: 5 sentences; Exa.TrkX and "Wang et al.~\\cite" do not split', () => {
    const intro = bySection('sec:intro');
    expect(intro).toHaveLength(5);
    expect(intro.every((s) => s.part === 'intro' && s.sectionTitle === 'Introduction')).toBe(true);
    expect(intro[0]!.text).toBe(
      'Searches for long-lived particles look for tracks that do not point back to the beam line~\\cite{Ju2022Zenodo}.',
    );
    expect(intro[1]!.text).toBe(
      'Machine-learning pipelines such as Exa.TrkX were built for prompt tracks, and their large-radius extension was studied by Wang et al.~\\cite{Wang2022LRT}.',
    );
    expect(intro[4]!.text).toBe('Section~\\ref{sec:method} describes the selection, and Sec.~\\ref{sec:results} shows the result.');
  });

  it('method: 4 prose sentences (one spans the display equation) and 1 footnote unit', () => {
    const prose = bySection('sec:method', 'prose');
    expect(prose).toHaveLength(4);
    expect(prose[1]!.text).toMatch(/on the track, i\.e\., double majority\.$/);
    const eff = prose[2]!;
    expect(eff.text.startsWith('The efficiency is\n\\begin{equation}')).toBe(true);
    expect(eff.text.endsWith('\\end{equation}\nwhere both counts use the same population.')).toBe(true);
    expect(eff.line).toBe(39);
    const host = prose[3]!;
    expect(host.text).toBe(
      'The uncertainty in Eq.~(\\ref{eq:eff}) combines the event bootstrap and the spread of three training seeds.\\footnote{The bootstrap uses one fixed list of resampled events per test set.}',
    );
    const fn = bySection('sec:method', 'footnote');
    expect(fn).toHaveLength(1);
    expect(fn[0]!.text).toBe('The bootstrap uses one fixed list of resampled events per test set.');
    expect(fn[0]!.part).toBe('footnote');
    // the footnote unit lies inside its host sentence and directly follows it in document order
    expect(fn[0]!.start).toBeGreaterThan(host.start);
    expect(fn[0]!.end).toBeLessThan(host.end);
    expect(seg.sentences.indexOf(fn[0]!)).toBe(seg.sentences.indexOf(host) + 1);
    expect(fn[0]!.paragraphIndex).not.toBe(host.paragraphIndex);
  });

  it('results: 4 prose sentences, 3 figure-caption and 1 table-caption units', () => {
    const prose = bySection('sec:results', 'prose');
    expect(prose.map((s) => s.text)).toEqual([
      'On the isolated gun particles, the tracker finds 2.32~$\\pm$~0.28 points more than acorn (HNL) with the same track builder; see Fig.~\\ref{fig:eff}.',
      'The test set holds 8,710 targets.',
      'The fake-track rate is 0.55\\% against 1.38\\% for the baseline.',
      'This lead holds for every particle species.',
    ]);
    const caps = bySection('sec:results', 'caption');
    expect(caps.map((s) => s.text)).toEqual([
      'Efficiency versus transverse displacement for the isolated gun particles.',
      'Solid: the \\ttbar-trained tracker; dashed: acorn (HNL).',
      'A ratio above one means the new tracker finds more targets.',
      'Efficiency on the isolated gun particles, in percent.',
    ]);
    expect(caps.every((s) => s.part === 'caption')).toBe(true);
    expect(caps[0]!.paragraphIndex).toBe(caps[2]!.paragraphIndex);
    expect(caps[3]!.paragraphIndex).not.toBe(caps[0]!.paragraphIndex);
  });

  it('conclusions: 2 sentences; appendix: 1 sentence in part app, the comment line gives nothing', () => {
    const concl = bySection('sec:concl');
    expect(concl).toHaveLength(2);
    expect(concl.every((s) => s.part === 'concl')).toBe(true);
    const app = bySection('app:val');
    expect(app).toHaveLength(1);
    expect(app[0]!.part).toBe('app');
    expect(app[0]!.text).toBe('On validation, the same comparison gave a smaller difference (see Table~\\ref{tab:eff}).');
    expect(app[0]!.line).toBe(80);
  });

  it('title, author, affiliation, \\maketitle, tabular rows, \\bibliography and comments produce no units', () => {
    const all = texts(seg).join('\n');
    for (const junk of ['Fixture: tracking', 'A. Fixture', 'Nowhere Institute', 'maketitle', 'Model & Efficiency', 'acorn (HNL) & 94.62', 'bibliography', 'comment with a period', 'placeholder artwork', 'documentclass']) {
      expect(all).not.toContain(junk);
    }
  });

  it('reports sections, labels, refs and cites in document order', () => {
    expect(seg.sections.map((s) => s.id)).toEqual(['abstract', 'sec:intro', 'sec:method', 'sec:results', 'sec:concl', 'app:val']);
    expect(seg.sections.map((s) => s.part)).toEqual(['abstract', 'intro', 'body', 'body', 'concl', 'app']);
    expect(seg.sections.find((s) => s.id === 'sec:method')).toMatchObject({ title: 'Method', level: 1, line: 35, label: 'sec:method' });
    expect(seg.labels).toEqual(['sec:intro', 'sec:method', 'eq:eff', 'sec:results', 'fig:eff', 'tab:eff', 'sec:concl', 'app:val']);
    expect(seg.refs).toEqual(['sec:method', 'sec:results', 'eq:eff', 'fig:eff', 'tab:eff']);
    expect(seg.cites).toEqual(['Ju2022Zenodo', 'Wang2022LRT']);
    expect(seg.intentLines).toEqual([]);
    expect(seg.paragraphs).toHaveLength(9);
    expect(seg.paragraphs.map((p) => p.kind)).toEqual(['prose', 'prose', 'prose', 'footnote', 'prose', 'caption', 'caption', 'prose', 'prose']);
  });

  it('is deterministic', () => {
    expect(segment(canto)).toEqual(seg);
  });
});

describe('segment: sentence boundaries (the skill style_check rule)', () => {
  it('fragment mode: no \\begin{document} means the whole source is body text', () => {
    const seg = segment('First sentence here. Second one follows.');
    expect(seg.fragment).toBe(true);
    expect(texts(seg)).toEqual(['First sentence here.', 'Second one follows.']);
    expect(seg.sentences.every((s) => s.part === 'body' && s.sectionId === 'body')).toBe(true);
    expect(seg.sections.map((s) => s.id)).toEqual(['body']);
  });

  it('display math \\[..\\] and $$..$$ stay inside the sentence and end it when they end with "."', () => {
    expect(sents('The sum is \\[ a + b = c. \\] Then we stop. And $$x = y.$$ Next one here.')).toEqual([
      'The sum is \\[ a + b = c. \\]',
      'Then we stop.',
      'And $$x = y.$$',
      'Next one here.',
    ]);
    expect(sents('We have\n\\[ a = b, \\]\nwhere $a$ is the mass. Done.')).toEqual(['We have\n\\[ a = b, \\]\nwhere $a$ is the mass.', 'Done.']);
  });

  it('align* and equation do not end the paragraph; a trailing \\label is ignored for the period test', () => {
    const src = 'We have\n\\begin{align*}\n a &= b \\\\\n c &= d.\n\\end{align*}\nThis ends it, so that\n\\begin{equation}\n x = 1 . \\label{eq:x}\n\\end{equation}\nNext.';
    const seg = segment(src);
    expect(texts(seg)).toEqual([
      'We have\n\\begin{align*}\n a &= b \\\\\n c &= d.\n\\end{align*}',
      'This ends it, so that\n\\begin{equation}\n x = 1 . \\label{eq:x}\n\\end{equation}',
      'Next.',
    ]);
    expect(seg.paragraphs).toHaveLength(1);
    expect(seg.labels).toEqual(['eq:x']);
    // a period before a display is a boundary (the display starts a masked region); a display alone is no unit
    expect(sents('This ends it.\n\\begin{equation}\n x = 1.\n\\end{equation}\nNext.')).toEqual(['This ends it.', 'Next.']);
  });

  it('nested braces: wrappers stay balanced inside the sentence', () => {
    expect(sents('\\textbf{Bold {inner} text.} The \\emph{next {one}} is here. After it.')).toEqual([
      '\\textbf{Bold {inner} text.}',
      'The \\emph{next {one}} is here.',
      'After it.',
    ]);
  });

  it('\\% is a literal percent, not a comment; \\$ is not math', () => {
    expect(sents('It finds 96.94\\% of them. The rest is 3.06\\%. Done here.')).toEqual([
      'It finds 96.94\\% of them.',
      'The rest is 3.06\\%.',
      'Done here.',
    ]);
    expect(sents('It costs \\$5. That is cheap. A \\$ sign alone.')).toEqual(['It costs \\$5.', 'That is cheap.', 'A \\$ sign alone.']);
  });

  it('a \\cite (or ~\\cite) or \\footnote right after the period belongs to the sentence it ends', () => {
    expect(sents('This was seen.\\cite{a,b} Next sentence here. Also seen.~\\cite{c} Then this.')).toEqual([
      'This was seen.\\cite{a,b}',
      'Next sentence here.',
      'Also seen.~\\cite{c}',
      'Then this.',
    ]);
    const seg = segment('Known.\\footnote{A note. Two.} After it.');
    expect(texts(seg)).toEqual(['Known.\\footnote{A note. Two.}', 'A note.', 'Two.', 'After it.']);
    expect(seg.sentences.map((s) => s.kind)).toEqual(['prose', 'footnote', 'footnote', 'prose']);
  });

  it('Fig.~\\ref, Eq.~(\\ref{..}), Sec.~\\ref never split', () => {
    expect(sents('As shown in Fig.~\\ref{f}, it works. See Eq.~(\\ref{e}) and Fig. \\ref{g}. Done now.')).toEqual([
      'As shown in Fig.~\\ref{f}, it works.',
      'See Eq.~(\\ref{e}) and Fig. \\ref{g}.',
      'Done now.',
    ]);
    expect(sents('See Sec.~\\ref{s} and Refs.~\\cite{a,b}. Then more.')).toEqual(['See Sec.~\\ref{s} and Refs.~\\cite{a,b}.', 'Then more.']);
  });

  it('et al., e.g., i.e. and the other abbreviations of the skill list do not end a sentence', () => {
    expect(sents('Wang et al. Showed it first. Use e.g. The cut. It holds, i.e., always. Done.')).toEqual([
      'Wang et al. Showed it first.',
      'Use e.g. The cut.',
      'It holds, i.e., always.',
      'Done.',
    ]);
    expect(sents('He wrote et~al. \\cite{x} nothing. Next.')).toEqual(['He wrote et~al. \\cite{x} nothing.', 'Next.']);
    // every entry of the list, capitalized and lower-case, before an upper-case word and a digit
    for (const abbr of DEFAULT_ABBREVIATIONS) {
      const cap = abbr[0]!.toUpperCase() + abbr.slice(1);
      for (const form of [abbr, cap]) {
        for (const next of ['Next', '2', '(see']) {
          const src = `Text with ${form} ${next} words follow. Last.`;
          expect(sents(src), src).toEqual([`Text with ${form} ${next} words follow.`, 'Last.']);
        }
      }
    }
  });

  it('a custom abbreviation list replaces the default', () => {
    const src = 'Supported by the U.S. Department of Energy. Done.';
    expect(sents(src)).toEqual(['Supported by the U.S.', 'Department of Energy.', 'Done.']);
    expect(texts(segment(src, { abbreviations: [...DEFAULT_ABBREVIATIONS, 'U.S.'] }))).toEqual([
      'Supported by the U.S. Department of Energy.',
      'Done.',
    ]);
  });

  it('lists: each \\item starts a paragraph; the optional [label] is not part of the unit', () => {
    const seg = segment('Before.\n\\begin{enumerate}\n\\item First item. Second sentence.\n\\item[(b)] Labelled item.\n\\end{enumerate}\nAfter the list.');
    expect(texts(seg)).toEqual(['Before.', 'First item.', 'Second sentence.', 'Labelled item.', 'After the list.']);
    expect(seg.sentences.map((s) => s.paragraphIndex)).toEqual([0, 1, 1, 2, 3]);
    const desc = segment('\\begin{description}\n\\item[Efficiency:] the fraction of targets with a match.\n\\end{description}');
    expect(texts(desc)).toEqual(['the fraction of targets with a match.']);
  });

  it('inline lists keep \\begin..\\end inside the sentence', () => {
    expect(sents('We use \\begin{inparaenum}\\item one, \\item two.\\end{inparaenum} Next.')).toEqual([
      'We use \\begin{inparaenum}\\item one, \\item two.\\end{inparaenum}',
      'Next.',
    ]);
  });

  it('\\paragraph{} is a heading (level 4), not a sentence', () => {
    const seg = segment('\\section{Method}\nText.\n\\paragraph{Setup.} We use this. It works.');
    expect(texts(seg)).toEqual(['Text.', 'We use this.', 'It works.']);
    expect(seg.sections.map((s) => [s.id, s.level])).toEqual([
      ['sec:method', 1],
      ['sec:setup', 4],
    ]);
    expect(seg.sentences[1]!.sectionId).toBe('sec:setup');
  });

  it('LaTeX quotes ``..\'\' and `..\' close the sentence they end', () => {
    expect(sents("He said ``it works.'' Then he left. She said `fine.' Later on. ``Quoted start.'' Ends.")).toEqual([
      "He said ``it works.''",
      'Then he left.',
      "She said `fine.'",
      'Later on.',
      "``Quoted start.''",
      'Ends.',
    ]);
  });

  it('a sentence may start with $N$, a digit, a \\ref-like command, a bracket or a parenthesis', () => {
    expect(sents('We count events. $N$ is large. 1000 are kept. \\Cref{f} shows it. [fact?: n] is open. (An aside.) After.')).toEqual([
      'We count events.',
      '$N$ is large.',
      '1000 are kept.',
      '\\Cref{f} shows it.',
      '[fact?: n] is open.',
      '(An aside.)',
      'After.',
    ]);
  });

  it('question and exclamation marks end sentences', () => {
    expect(sents('Does it work? Yes. Really! Sure.')).toEqual(['Does it work?', 'Yes.', 'Really!', 'Sure.']);
  });

  it('a lower-case next word does not split (style_check next-char rule)', () => {
    expect(sents('This is it. and this continues. Next One.')).toEqual(['This is it. and this continues.', 'Next One.']);
  });

  it('a CJK intent line between sentences is excluded and reported, and does not end the paragraph', () => {
    const src = 'First sentence.\n这里写中文的意图说明\nSecond sentence.';
    const seg = segment(src);
    expect(texts(seg)).toEqual(['First sentence.', 'Second sentence.']);
    expect(seg.paragraphs).toHaveLength(1);
    expect(seg.intentLines).toEqual([{ start: 16, end: 26, line: 2, text: '这里写中文的意图说明' }]);
  });

  it('an intent line with LaTeX specials ($, {, %) cannot break the surrounding text', () => {
    const src = 'First $x$ sentence.\n中文说明 $p_T 的 { 截断\nSecond one. Third one.';
    expect(sents(src)).toEqual(['First $x$ sentence.', 'Second one.', 'Third one.']);
  });

  it('comment lines and trailing comments containing periods produce nothing', () => {
    const src = 'First. % a comment. With periods.\n% Full comment line. Another.\nSecond sentence here.%\n\nThird.';
    const seg = segment(src);
    expect(texts(seg)).toEqual(['First.', 'Second sentence here.', 'Third.']);
    expect(seg.paragraphs).toHaveLength(2);
  });

  it('\\section* headings work and a \\label right after a heading names it', () => {
    const seg = segment('\\section*{Acknowledgments}\nWe thank all.\n\\section*{Results and discussion}\\label{sec:rd}\nIt works.\n\\section{Results and discussion}\nAgain.');
    expect(seg.sections.map((s) => s.id)).toEqual(['sec:acknowledgments', 'sec:rd', 'sec:results-and-discussion']);
    expect(seg.sentences.map((s) => s.sectionId)).toEqual(['sec:acknowledgments', 'sec:rd', 'sec:results-and-discussion']);
  });

  it('section ids are de-duplicated with -2, -3', () => {
    const seg = segment('\\section{Results}\nA.\n\\section{Results}\nB.\n\\section{Results}\nC.');
    expect(seg.sections.map((s) => s.id)).toEqual(['sec:results', 'sec:results-2', 'sec:results-3']);
  });

  it('a label inside the title, or after a float, names the heading; a label after prose does not', () => {
    expect(segment('\\section{Intro\\label{sec:i}}\nText.').sections[0]!.id).toBe('sec:i');
    expect(segment('\\section{Res}\n\\begin{figure}\\caption{C.}\\label{fig:a}\\end{figure}\n\\label{sec:r}\nText.').sections[0]!.id).toBe('sec:r');
    expect(segment('\\section{Res}\nText first.\n\\label{sec:late}').sections[0]!.id).toBe('sec:res');
  });

  it('\\begin{abstract} in a fragment', () => {
    const seg = segment('\\begin{abstract}\nShort abstract. Two sentences.\n\\end{abstract}\nThen body text.');
    expect(texts(seg)).toEqual(['Short abstract.', 'Two sentences.', 'Then body text.']);
    expect(seg.sentences.map((s) => [s.part, s.sectionId])).toEqual([
      ['abstract', 'abstract'],
      ['abstract', 'abstract'],
      ['body', 'body'],
    ]);
  });

  it('captions: [short] is skipped, the long argument is segmented; \\label inside is ignored', () => {
    const seg = segment('\\begin{figure}[t]\\includegraphics{a.pdf}\\caption[Short title.]{Long caption here. Second part.}\\label{f}\\end{figure}');
    expect(texts(seg)).toEqual(['Long caption here.', 'Second part.']);
    expect(seg.sentences.every((s) => s.kind === 'caption' && s.part === 'caption')).toBe(true);
    expect(seg.labels).toEqual(['f']);
    const t = segment('\\begin{table}\\caption{Cuts.\\label{tab:c}}\\begin{tabular}{c} A. & B. \\\\ \\end{tabular}\\end{table}');
    expect(texts(t)).toEqual(['Cuts.']);
  });

  it('subfloat and \\captionof captions are caption units', () => {
    const seg = segment('\\begin{figure*}\\subfloat[Left panel.]{\\includegraphics{a}}\\subfloat[Right.]{x}\\caption{Both. Done.}\\end{figure*}\n\\begin{minipage}{3cm}\\captionof{figure}{Outside float.}\\end{minipage}');
    expect(texts(seg)).toEqual(['Left panel.', 'Right.', 'Both.', 'Done.', 'Outside float.']);
    expect(seg.sentences.every((s) => s.kind === 'caption')).toBe(true);
  });

  it('a footnote in the middle of a sentence', () => {
    const seg = segment('The cut\\footnote{Chosen by hand. See below.} removes 3\\% of events. Next.');
    expect(texts(seg)).toEqual(['The cut\\footnote{Chosen by hand. See below.} removes 3\\% of events.', 'Chosen by hand.', 'See below.', 'Next.']);
  });

  it('skips tables, pictures, verbatim, \\iffalse blocks and everything after \\end{document}', () => {
    const src = [
      '\\documentclass{article}',
      '\\begin{document}',
      'Kept one.',
      '\\begin{tabular}{c} Cell. Text. \\\\ \\end{tabular}',
      '\\begin{tikzpicture}\\node {Label. Text.};\\end{tikzpicture}',
      '\\begin{verbatim}',
      'Verbatim. Text. \\end{itemize}',
      '\\end{verbatim}',
      '\\iffalse',
      'Commented out. Text.',
      '\\fi',
      'Kept two.',
      '\\end{document}',
      'After the end. Text.',
    ].join('\n');
    expect(sents(src)).toEqual(['Kept one.', 'Kept two.']);
  });

  it('title material and \\thanks are skipped', () => {
    const src = '\\begin{document}\n\\title{A title. With period.}\n\\author{A. Author}\n\\thanks{Thanks. A lot.}\n\\email{a@b.c}\n\\affiliation{Inst. of Physics}\n\\date{\\today}\n\\maketitle\nBody text.\n\\end{document}';
    expect(sents(src)).toEqual(['Body text.']);
  });

  it('\\be..\\ee and plain-text macros from \\newcommand behave like their expansion', () => {
    const src = [
      '\\newcommand{\\be}{\\begin{equation}}',
      '\\newcommand{\\ee}{\\end{equation}}',
      '\\newcommand{\\etc}{etc.}',
      '\\newcommand{\\etal}{et al.}',
      '\\begin{document}',
      'The energy is',
      '\\be',
      'E = mc^2.',
      '\\ee',
      'Next sentence. We use apples, pears \\etc{} The fruit is good. Smith \\etal{} \\cite{s} found it.',
      '\\end{document}',
    ].join('\n');
    expect(sents(src)).toEqual([
      'The energy is\n\\be\nE = mc^2.\n\\ee',
      'Next sentence.',
      'We use apples, pears \\etc{}',
      'The fruit is good.',
      'Smith \\etal{} \\cite{s} found it.',
    ]);
  });

  it('parts follow the headings: intro, concl, inherited subsections, appendix, acknowledgments', () => {
    const src = [
      '\\begin{document}',
      '\\begin{abstract}Abs.\\end{abstract}',
      'Front text.',
      '\\section{Introduction}\\label{sec:intro}',
      'Intro text.',
      '\\subsection{Background}',
      'Background text.',
      '\\section{Results}',
      'Results text.',
      '\\subsection{Summary}',
      'Summary text.',
      '\\section{Summary and outlook}',
      'Outlook text.',
      '\\begin{acknowledgments}',
      'We thank them.',
      '\\end{acknowledgments}',
      '\\appendix',
      '\\section{Extra}',
      'Appendix text.',
      '\\subsection{Details}',
      'Detail text.',
      '\\end{document}',
    ].join('\n');
    const seg = segment(src);
    expect(seg.sentences.map((s) => [s.text, s.part, s.sectionId])).toEqual([
      ['Abs.', 'abstract', 'abstract'],
      ['Front text.', 'intro', 'front'],
      ['Intro text.', 'intro', 'sec:intro'],
      ['Background text.', 'intro', 'sec:background'],
      ['Results text.', 'body', 'sec:results'],
      ['Summary text.', 'concl', 'sec:summary'],
      ['Outlook text.', 'concl', 'sec:summary-and-outlook'],
      ['We thank them.', 'body', 'acknowledgments'],
      ['Appendix text.', 'app', 'sec:extra'],
      ['Detail text.', 'app', 'sec:details'],
    ]);
  });

  it('revtex widetext around a display stays inside the sentence and balanced', () => {
    const src = [
      'The amplitude is',
      '\\begin{widetext}',
      '\\begin{equation}',
      ' A = \\sum_i a_i b_i ,',
      '\\end{equation}',
      '\\end{widetext}',
      'where $a_i$ are the couplings. The cross section is',
      '\\begin{widetext}',
      '\\begin{eqnarray}',
      ' \\sigma &=& 5~\\mathrm{pb}.',
      '\\end{eqnarray}',
      '\\end{widetext}',
      'It is large.',
    ].join('\n');
    const seg = segment(src);
    expect(texts(seg)).toEqual([
      'The amplitude is\n\\begin{widetext}\n\\begin{equation}\n A = \\sum_i a_i b_i ,\n\\end{equation}\n\\end{widetext}\nwhere $a_i$ are the couplings.',
      'The cross section is\n\\begin{widetext}\n\\begin{eqnarray}\n \\sigma &=& 5~\\mathrm{pb}.\n\\end{eqnarray}\n\\end{widetext}',
      'It is large.',
    ]);
    expect(seg.paragraphs).toHaveLength(1);
  });

  it('a macro holding a whole display is one math region', () => {
    const src = '\\newcommand{\\emc}{\\begin{equation}E=mc^2.\\end{equation}}\n\\begin{document}\nWe write \\emc The next sentence. Later \\begin{equation} x \\end{equation} too.\n\\end{document}';
    expect(sents(src)).toEqual(['We write \\emc', 'The next sentence.', 'Later \\begin{equation} x \\end{equation} too.']);
  });

  it('a JHEP-style \\abstract{..} in the preamble is the abstract', () => {
    const src = '\\documentclass{article}\n\\abstract{We study it. It works.}\n\\begin{document}\n\\section{Introduction}\nText.\n\\end{document}';
    const seg = segment(src);
    expect(seg.sentences.map((s) => [s.text, s.part])).toEqual([
      ['We study it.', 'abstract'],
      ['It works.', 'abstract'],
      ['Text.', 'intro'],
    ]);
  });

  it('a lone fragment without letters (a math-only "sentence") gives no unit', () => {
    expect(sents('First one. $N$. Second one.')).toEqual(['First one.', 'Second one.']);
  });

  it('keeps going on unbalanced input (while the author types)', () => {
    expect(sents('Text \\emph{unclosed here. More text.\n\nNew paragraph. Ends.')).toEqual([
      'Text \\emph{unclosed here.',
      'More text.',
      'New paragraph.',
      'Ends.',
    ]);
    expect(sents('The value $x is here. Next sentence.\n\nOther paragraph. Done.')).toEqual([
      'The value $x is here.',
      'Next sentence.',
      'Other paragraph.',
      'Done.',
    ]);
    // an unclosed float or caption argument stays running text until it is closed (no unit disappears)
    const typing = 'Before.\n\\begin{figure}\\caption{Typing';
    expect(sents(typing)[0]).toBe('Before.');
    checkInvariants(typing, segment(typing));
    expect(sents('Text \\footnote{never closed. Still text. More.')).toEqual(['Text \\footnote{never closed.', 'Still text.', 'More.']);
  });

  it('\\url, \\verb and siunitx are atomic', () => {
    expect(sents('See \\url{http://a.b/c.d%20e}. Use \\verb|a. B| here. The cut is \\SI{1.5}{\\GeV}. Then \\num{3.2} events.')).toEqual([
      'See \\url{http://a.b/c.d%20e}.',
      'Use \\verb|a. B| here.',
      'The cut is \\SI{1.5}{\\GeV}.',
      'Then \\num{3.2} events.',
    ]);
  });

  it('CRLF sources keep exact offsets', () => {
    const src = 'First line one.\r\nStill one. Two.\r\n\r\nNew para.\r\n';
    const seg = segment(src);
    expect(texts(seg)).toEqual(['First line one.', 'Still one.', 'Two.', 'New para.']);
    expect(seg.paragraphs).toHaveLength(2);
    checkInvariants(src, seg);
  });
});

describe('segment: a harder PRD-style manuscript', () => {
  const seg = segment(hard);

  it('keeps the invariants', () => {
    checkInvariants(hard, seg);
    expect(seg.sentences).toHaveLength(57);
  });

  it('reads the hard constructs', () => {
    const t = texts(seg);
    expect(t).toContain('Their tracks are hard to find, e.g.\\ for $d_0 > 10$~mm.');
    expect(t).toContain('However, every study so far trained on the signal it evaluates (cf.\\ Refs.~\\cite{Lee2019,Wang2022LRT}).');
    expect(t).toContain('We show that it does.\\footnote{A preliminary version appeared in a workshop note. It used fewer events.}');
    expect(t).toContain('The efficiency is defined as\n\\be\n  \\epsilon = \\frac{N_{\\text{matched}}}{N_{\\text{targets}}}.\n\\ee');
    expect(t).toContain('The fake rate is\n\\begin{align*}\n  f &= \\frac{N_{\\text{fake}}}{N_{\\text{tracks}}},\n\\end{align*}\nwhere a fake track matches no particle.');
    expect(t).toContain('We quote 50\\% and 95\\% intervals; the price is \\$0 per event (vs.\\ \\$5 for the full simulation).');
    expect(t).toContain('``Generic\'\' here means \\emph{no signal at all}.');
    expect(t).toContain('Selection cuts.');
    expect(t.join('\n')).not.toMatch(/must not appear|Corresponding author|Geneva|Value\. With/);
    expect(seg.intentLines.map((l) => l.line)).toEqual([39]);
    expect(seg.sections.map((s) => s.id)).toEqual([
      'abstract',
      'sec:intro',
      'sec:method',
      'sec:selection',
      'sec:training',
      'sec:results',
      'sec:concl',
      'acknowledgments',
      'app:sim',
    ]);
    expect(seg.cites).toContain('Geant4');
    expect(seg.labels).toContain('fig:sub-a');
    expect(seg.refs).toEqual(expect.arrayContaining(['eq:a', 'eq:b', 'tab:cuts', 'app:sim']));
  });
});

describe('segment: robustness', () => {
  it('never throws and keeps the invariants on random LaTeX-ish input', () => {
    const pieces = [
      'Word', 'word', '.', '. ', '? ', '! ', ' ', '\n', '\n\n', '$', '$x$', '$$', '\\[', '\\]', '{', '}', '%', '\\%', '~',
      '\\cite{a}', '\\ref{b}', '\\footnote{', '\\caption{', '\\begin{figure}', '\\end{figure}', '\\begin{itemize}', '\\item',
      '\\end{itemize}', '\\section{T}', '\\label{l}', '\\emph{', 'e.g.', 'Fig.~', 'et al.', '``', "''", '中文中文中文', '\\\\',
      '\\begin{equation}', '\\end{equation}', '\\verb|x|', '\\url{a.b}', '\\iffalse', '\\fi', '\\begin{abstract}', '\\end{abstract}',
      'A', '1', '(', ')', '\\appendix', '\\be', '\\ee',
    ];
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed % n;
    };
    for (let round = 0; round < 300; round++) {
      let src = round % 3 === 0 ? '\\begin{document}\n' : '';
      const len = 5 + rnd(80);
      for (let k = 0; k < len; k++) src += pieces[rnd(pieces.length)]!;
      const seg = segment(src);
      checkInvariants(src, seg);
      expect(segment(src)).toEqual(seg);
    }
  });

  it('stays linear on pathological unclosed input', () => {
    const cases = [
      'Start. ' + '\\begin{equation} x. '.repeat(3000) + 'End.',
      'Start. ' + '\\footnote{Deep. '.repeat(3000) + 'End.',
      'Start. ' + '\\cite{a '.repeat(3000) + 'End.',
      'Start. ' + '\\begin{itemize}\\item Deep. '.repeat(3000) + 'End.',
      'Start. ' + '\\emph{X. '.repeat(3000) + '}'.repeat(3000) + ' End.',
    ];
    for (const src of cases) {
      const t0 = performance.now();
      const seg = segment(src);
      expect(performance.now() - t0).toBeLessThan(500);
      expect(seg.sentences[0]!.text).toBe('Start.');
    }
  });

  it('handles empty and whitespace-only input', () => {
    expect(segment('').sentences).toEqual([]);
    expect(segment('   \n\n  ').sentences).toEqual([]);
    expect(segment('\\begin{document}\\end{document}').sentences).toEqual([]);
  });

  it('lineOf matches a direct newline count', () => {
    const src = 'a\nb\n\nc';
    for (let o = 0; o <= src.length + 2; o++) {
      let line = 1;
      for (let i = 0; i < o && i < src.length; i++) if (src[i] === '\n') line++;
      expect(lineOf(src, o)).toBe(line);
    }
  });
});

describe('segment: performance', () => {
  it('segments a 10,000-word document in under 30 ms (median of 5 runs after warm-up)', () => {
    const para = [
      'On isolated particles the tracker finds $96.94\\%$ of the targets, compared with $94.62\\%$ for the baseline~\\cite{Ju2021}, see Fig.~\\ref{fig:eff}.',
      'Wang et al.\\ extended the method to large radii, e.g.\\ for $d_0 > 10$~mm, and the result holds (cf.\\ Eq.~(\\ref{eq:eff})).',
      'The efficiency is',
      '\\begin{equation}',
      '  \\epsilon = \\frac{N_{\\text{matched}}}{N_{\\text{targets}}},',
      '\\end{equation}',
      'where both counts use the same population.\\footnote{The bootstrap uses one fixed list of resampled events.}',
      'We use three seeds; the spread among them is small, i.e., below 0.1 points. % a comment. Ignore it.',
      '``Generic\'\' means \\emph{no signal at all}. Is this enough? It is.',
    ].join('\n');
    const fig = '\\begin{figure}\n\\includegraphics{x.pdf}\n\\caption{Efficiency versus displacement. Solid: the new tracker.}\n\\label{fig:x}\n\\end{figure}';
    let body = '';
    let words = 0;
    let k = 0;
    while (words < 10_000) {
      if (k % 8 === 0) body += `\\section{Section ${k / 8}}\\label{sec:s${k}}\n`;
      body += para + '\n\n';
      if (k % 5 === 4) body += fig + '\n\n';
      words += (para.match(/\S+/g) ?? []).length;
      k++;
    }
    const src = `\\documentclass{revtex4-2}\n\\begin{document}\n\\begin{abstract}\nShort abstract.\n\\end{abstract}\n${body}\\end{document}\n`;
    for (let w = 0; w < 3; w++) segment(src);
    const times: number[] = [];
    let seg: Segmentation | null = null;
    for (let r = 0; r < 5; r++) {
      const t0 = performance.now();
      seg = segment(src);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[2]!;
    expect(seg!.sentences.length).toBeGreaterThan(800);
    expect(median).toBeLessThan(30 * PERF_SLACK);
  });
});

/* -------------------------------------------------------------------------------------- */
/* Agreement with the skill's style_check.py (skipped when python3 or the skill is absent)  */
/* -------------------------------------------------------------------------------------- */

const skillDir = process.env.PAPER_SKILL_DIR || fixturePath('../../../.skill');
const styleCheck = `${skillDir}/scripts/style_check.py`;
const pythonOk = ((): boolean => {
  if (!existsSync(styleCheck)) return false;
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function dump(text: string): string {
  return execFileSync('python3', ['-I', styleCheck, '-', '--format', 'tex', '--dump'], { input: text, encoding: 'utf8' });
}

describe.skipIf(!pythonOk)('segment vs style_check.py --dump', () => {
  it('agrees on every sentence of the Canto fixture', () => {
    const rep = compareWithStyleCheck(segment(canto), parseStyleCheckDump(dump(shadowForCompile(canto))), canto);
    expect(rep.theirs).toBe(26);
    expect(rep.ours).toBe(26);
    expect(rep.exact).toBe(26);
    expect(rep.agreement).toBe(1);
    expect(rep.differences).toEqual([]);
  });

  it('agrees on the hard manuscript except for the documented, intentional differences', () => {
    const seg = segment(hard);
    const rep = compareWithStyleCheck(seg, parseStyleCheckDump(dump(shadowForCompile(hard))), hard);
    expect(rep.agreementExplained).toBeGreaterThanOrEqual(0.98);
    expect(rep.differences.every((d) => d.intentional)).toBe(true);
    // style_check drops acknowledgments; the platform keeps them as units
    expect(rep.differences.map((d) => d.ours?.sectionId)).toEqual(['acknowledgments', 'acknowledgments', 'acknowledgments']);
  });

  it('keeps revtex widetext displays inside their sentence (an intentional difference)', () => {
    const src = [
      '\\begin{document}',
      'The amplitude is',
      '\\begin{widetext}',
      '\\begin{equation}',
      ' A = \\sum_i a_i b_i ,',
      '\\end{equation}',
      '\\end{widetext}',
      'where $a_i$ are the couplings. The cross section is',
      '\\begin{widetext}',
      '\\begin{eqnarray}',
      ' \\sigma &=& 5~\\mathrm{pb}.',
      '\\end{eqnarray}',
      '\\end{widetext}',
      'It is large.',
      '\\end{document}',
      '',
    ].join('\n');
    const rep = compareWithStyleCheck(segment(src), parseStyleCheckDump(dump(src)), src);
    // style_check reads the widetext line as a paragraph break and drops the display from the sentence
    expect(rep.exact).toBe(2);
    expect(rep.differences.map((d) => [d.how, d.intentional])).toEqual([['merge', true]]);
    expect(rep.agreementExplained).toBe(1);
  });

  it('a \\cite right after the period is the one intentional boundary difference', () => {
    const src = '\\begin{document}\nWe saw it.\\cite{a} Then more text follows. Second sentence.\n\\end{document}\n';
    const rep = compareWithStyleCheck(segment(src), parseStyleCheckDump(dump(src)), src);
    expect(rep.differences).toHaveLength(1);
    expect(rep.differences[0]!.how).toBe('split');
    expect(rep.differences[0]!.intentional).toBe(true);
    expect(rep.agreementExplained).toBe(1);
  });
});
