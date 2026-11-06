import { it } from 'vitest';
import { terminologyReport } from '../src/consistency/terms';
import { figurePlan } from '../src/consistency/figures';
import { segment } from '../src/latex/segment';
import type { ConsistencyUnit } from '../src/consistency/common';
function unitsOf(file: string, text: string): ConsistencyUnit[] {
  return segment(text).sentences.map((s, i) => ({ id: `${file}#${i}`, file, line: s.line, part: s.part, kind: s.kind, sectionId: s.sectionId, text: s.text, start: s.start, end: s.end }));
}
const doc = String.raw`\documentclass{revtex4-2}
\begin{document}
\title{Tracking with GNNs}
\begin{abstract}
We train a graph neural network (GNN) on hits. The GNN finds tracks.
\end{abstract}
\section{Introduction}
Graph neural networks (GNNs) are used in many places. We study the GNNs on the LHC data at $\sqrt{s}=13$~TeV.
We use the Large Hadron Collider (LHC) data. The CMS and ATLAS detectors are general purpose. The $\mathrm{BDT}$ score is shown.
Figure~\ref{fig:b} shows the result, and Figs.~\ref{fig:a} and~\ref{fig:sub_left} show more. See also \cref{fig:a,fig:c}.
The ROC curve is in Fig.~\ref{fig:c}. A boosted decision tree (BDT) is the baseline.
\section{Method}
Pile-up is high. The pileup is simulated, and pile up varies.
\begin{figure}
\includegraphics{a}
\caption{Efficiency versus $p_T$ for the two trackers, for $\mu=200$. Solid: GNN; dashed: baseline. The GNN is better.}
\label{fig:a}
\end{figure}
\begin{figure*}
\subfloat[]{\includegraphics{b1}\label{fig:sub_left}}
\subfloat[]{\includegraphics{b2}\label{fig:sub_right}}
\caption{Fake rate (left) and duplicate rate (right) versus pile-up.}
\label{fig:b}
\end{figure*}
\begin{figure}
\includegraphics{c}
\caption{ROC curve.}\label{fig:c}
\end{figure}
\begin{table}
\caption{Samples.}
\label{tab:x}
\end{table}
\end{document}
`;
it('probe', () => {
  const u = unitsOf('main.tex', doc);
  const tr = terminologyReport(u, [{ term: 'pile-up', variants: [], definition: '', firstUseSentenceId: null } as never]);
  for (const f of tr.flags) console.log(`[T ${f.kind}/${f.severity}] ${f.message}`);
  console.log(JSON.stringify(tr.acronyms?.map?.((a: any) => [a.acronym, a.status]) ?? Object.keys(tr)));
  const fp = figurePlan([{ file: 'main.tex', text: doc }], u, null);
  for (const f of fp.flags) console.log(`[F ${f.kind}/${f.severity}] ${f.message}`);
  console.log(fp.floats.map((r: any) => `${r.kind} ${r.number} ${r.label} cites=${r.citeCount ?? r.citations?.length} firstRef=${JSON.stringify(r.firstRef ?? r.firstCite)?.slice(0, 60)}`).join('\n'));
});
