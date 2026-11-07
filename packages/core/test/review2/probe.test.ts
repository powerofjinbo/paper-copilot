import { it } from 'vitest';
import { segment } from '../../src/latex/segment';
import { submissionCheck } from '../../src/meta/submission';
const T = String.raw`\documentclass{article}
\begin{document}
\section{Results at [fact?: beam energy]}
The tracker works well.
\begin{table}
  \caption{Efficiency in percent.}
  \begin{tabular}{lc}
    Model & Efficiency \\
    tracker & [fact?: efficiency of the tracker] \\
    baseline & [ref] \\
  \end{tabular}
\end{table}
\begin{equation}
  \epsilon = [fact?: eff]
\end{equation}
Text with a footnote.\footnote{The bootstrap uses [fact?: n bootstrap] samples.}
\end{document}
`;
it('probe', () => {
  const seg = segment(T);
  console.log(seg.sentences.map(s => s.kind + ' | ' + s.text));
  const units = seg.sentences.map((s, i) => ({ id: 'u' + i, file: 'main.tex', line: s.line, part: s.part, kind: s.kind, sectionId: s.sectionId, text: s.text, start: s.start, end: s.end, state: 'human' as const, everAi: false }));
  const rep = submissionCheck({ mainFile: 'main.tex', files: [{ file: 'main.tex', text: T }], units, facts: [], venue: 'arxiv', bibKeys: [], compile: { state: 'ok', errors: [] } });
  console.log(JSON.stringify(rep.items.find(i => i.id === 'placeholders')));
});
