import { describe, expect, it } from 'vitest';
import { compareLatexInvariance, findPlaceholders, latexTokensOf } from '../src/latex/tokens';

describe('latexTokensOf', () => {
  it('collects cites, refs, labels, math and macros of a fixture sentence', () => {
    const s =
      'Machine-learning pipelines were studied by Wang et al.~\\cite{Wang2022LRT, Ju2022Zenodo}; see Sec.~\\ref{sec:method}, Eq.~(\\eqref{eq:eff}) and \\cref{fig:a,fig:b}.\\label{s:1}';
    const t = latexTokensOf(s);
    expect(t.cites).toEqual(['Wang2022LRT', 'Ju2022Zenodo']);
    expect(t.refs).toEqual(['sec:method', 'eq:eff', 'fig:a', 'fig:b']);
    expect(t.labels).toEqual(['s:1']);
    expect(t.math).toEqual([]);
    expect(t.macros).toEqual([]);
  });

  it('handles the cite family, optional arguments and multi-cites', () => {
    const t = latexTokensOf('As in \\citep[p.~3]{a} and \\onlinecite{b,c}, \\cites{d}{e}, \\citeauthor*{f} and \\textcite[see][12]{g}.');
    expect(t.cites).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  it('normalizes math spans to $...$ and whitespace', () => {
    const t = latexTokensOf('A target has $p_T >  1$~GeV, \\(|\\eta| < 4\\), and \\[ x = y \\] and $$a+b$$.');
    expect(t.math).toEqual(['$p_T>1$', '$|\\eta|<4$', '$x=y$', '$a+b$']);
    // a space between a control word and a letter is significant and kept
    expect(latexTokensOf('$\\alpha x$').math).toEqual(['$\\alpha x$']);
    expect(latexTokensOf('$p_T > 1$').math).toEqual(latexTokensOf('$p_T>1$').math);
  });

  it('treats math environments as one math token and keeps their labels', () => {
    const t = latexTokensOf('The efficiency is \\begin{equation} \\epsilon = \\frac{N_{\\text{matched}}}{N_{\\text{targets}}}, \\label{eq:eff} \\end{equation} where both counts agree.');
    expect(t.math).toEqual(['$\\epsilon=\\frac{N_{\\text{matched}}}{N_{\\text{targets}}},$']);
    expect(t.labels).toEqual(['eq:eff']);
    expect(t.macros).toEqual([]);
  });

  it('lists notation macros but not formatting or spacing', () => {
    const t = latexTokensOf('We study a tracker trained only on \\ttbar{} events\\,\\emph{only}~\\textbf{here}\\footnote{Note \\cite{x}.} with 96.94\\%\\\\[2pt] and \\begin{itemize}\\item[a] x\\end{itemize}');
    expect(t.macros).toEqual(['\\ttbar', '\\footnote', '\\%', '\\begin{itemize}', '\\item', '\\end{itemize}']);
    expect(t.cites).toEqual(['x']);
  });

  it('ignores comments and escaped percent', () => {
    const t = latexTokensOf('Text 5\\% here % a comment \\cite{hidden} $x$\nmore \\ref{r}');
    expect(t.cites).toEqual([]);
    expect(t.math).toEqual([]);
    expect(t.refs).toEqual(['r']);
    expect(t.macros).toEqual(['\\%']);
  });

  it('never throws on odd input', () => {
    for (const s of ['', '\\', '$', '$$x', '\\cite', '\\cite{', '{{{', '}}}', '\\begin{equation} x', '\\verb|a', '%', '\\(', '\\[', '\\end{x}']) {
      expect(() => latexTokensOf(s)).not.toThrow();
    }
    expect(latexTokensOf(undefined as unknown as string).cites).toEqual([]);
    expect(latexTokensOf('An unclosed $x + y').math).toEqual(['$x+y$']);
  });
});

describe('compareLatexInvariance', () => {
  const before = 'On the isolated gun particles, the tracker finds 2.32~$\\pm$~0.28 points more than acorn (HNL)~\\cite{Wang2022LRT}; see Fig.~\\ref{fig:eff}.';

  it('accepts a rewrite that keeps every token (order and whitespace may change)', () => {
    const after = 'The tracker finds 2.32~$ \\pm $~0.28 points more than acorn (HNL)~\\cite{Wang2022LRT} on the isolated gun particles (Fig.~\\ref{fig:eff}).';
    expect(compareLatexInvariance(before, after)).toEqual({ ok: true, missing: [], added: [] });
  });

  it('rejects a rewrite that drops a \\cite', () => {
    const after = 'The tracker finds 2.32~$\\pm$~0.28 points more than acorn (HNL); see Fig.~\\ref{fig:eff}.';
    const r = compareLatexInvariance(before, after);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['cite:Wang2022LRT']);
    expect(r.added).toEqual([]);
  });

  it('rejects changed math and added refs or macros', () => {
    const r = compareLatexInvariance('A target has $p_T > 1$~GeV.', 'A target has $p_{T} > 1$~GeV, see Sec.~\\ref{sec:x} and \\ttbar.');
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['math:$p_T>1$']);
    expect(r.added).toEqual(['ref:sec:x', 'math:$p_{T}>1$', 'macro:\\ttbar']);
  });

  it('counts repeats as a multiset', () => {
    const r = compareLatexInvariance('\\cite{a} and \\cite{a}.', 'Only \\cite{a}.');
    expect(r).toEqual({ ok: false, missing: ['cite:a'], added: [] });
    expect(compareLatexInvariance('\\cite{a,b}', '\\cite{b,a}').ok).toBe(true);
    expect(compareLatexInvariance('\\cite{a,b}', '\\cite{a}~\\cite{b}').ok).toBe(true);
  });

  it('ignores formatting macros', () => {
    expect(compareLatexInvariance('We \\emph{train} on generic events.', 'We train on \\textbf{generic} events.').ok).toBe(true);
    expect(compareLatexInvariance('A~b\\,c.', 'A b c.').ok).toBe(true);
  });
});

describe('findPlaceholders', () => {
  it('finds the skill placeholders with their kinds and offsets', () => {
    const s = 'It improves the limit by [factor?] over $c\\tau$ = [range: cτ?] with [fact?: efficiency of the new tracker] and [claim: the lead holds?] [ref] [cite?] [baseline: without the timing cut?].';
    const ph = findPlaceholders(s);
    expect(ph.map((p) => [p.text, p.kind])).toEqual([
      ['[factor?]', 'generic'],
      ['[range: cτ?]', 'generic'],
      ['[fact?: efficiency of the new tracker]', 'fact'],
      ['[claim: the lead holds?]', 'claim'],
      ['[ref]', 'ref'],
      ['[cite?]', 'ref'],
      ['[baseline: without the timing cut?]', 'generic'],
    ]);
    for (const p of ph) expect(s.slice(p.start, p.end)).toBe(p.text);
  });

  it('does not treat LaTeX optional arguments as placeholders', () => {
    expect(findPlaceholders('As shown~\\cite[p.~3]{x} and \\cite[ref]{y}.')).toEqual([]);
    expect(findPlaceholders('First line\\\\[2pt] next?] line')).toEqual([]);
    expect(findPlaceholders('\\begin{figure}[t] \\centering')).toEqual([]);
    expect(findPlaceholders('\\begin{figure*}[h?]')).toEqual([]);
    expect(findPlaceholders('\\begin{itemize}\\item[a] one \\item[b?] two')).toEqual([]);
    expect(findPlaceholders('\\caption[short?]{Long.}')).toEqual([]);
    expect(findPlaceholders('\\includegraphics[width=0.8\\linewidth]{fig.pdf}')).toEqual([]);
    expect(findPlaceholders('\\cite[a][b?]{k}')).toEqual([]);
  });

  it('ignores ordinary brackets, display math and over-long or multi-line groups', () => {
    expect(findPlaceholders('Bins [0, 0.1) and [1, 3] and $[0,1]$ and Ref.~[12].')).toEqual([]);
    expect(findPlaceholders('\\[ x = y? \\]')).toEqual([]);
    expect(findPlaceholders('[fact?: ' + 'x'.repeat(170) + ']')).toEqual([]);
    expect(findPlaceholders('[fact?: two\nlines]')).toEqual([]);
  });

  it('accepts adjacent placeholders and placeholders inside plain brackets', () => {
    expect(findPlaceholders('see [ref][fact?: size]').map((p) => p.text)).toEqual(['[ref]', '[fact?: size]']);
    expect(findPlaceholders('(see [ref])').map((p) => p.kind)).toEqual(['ref']);
    expect(findPlaceholders('[fact?: efficiency in [0,1]]').map((p) => p.text)).toEqual(['[fact?: efficiency in [0,1]]']);
  });

  it('never throws', () => {
    for (const s of ['', '[', ']', '[[', '\\[', '[?]', '}[x?]', ']]][fact?:']) expect(() => findPlaceholders(s)).not.toThrow();
    expect(findPlaceholders(null as unknown as string)).toEqual([]);
  });
});
