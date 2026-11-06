/**
 * Tokens after which a period does NOT end a sentence. Copied verbatim from the ABBR set in the
 * hep-paper-writing skill's scripts/style_check.py (line ~1860), so that the platform's sentence
 * units and the skill's lint flags use the same boundaries. Compare case-insensitively against the
 * last whitespace-separated token before the period, after stripping leading ( [ " “.
 */
export const DEFAULT_ABBREVIATIONS: readonly string[] = [
  'fig.', 'figs.', 'eq.', 'eqs.', 'ref.', 'refs.', 'sec.', 'secs.', 'app.', 'apps.', 'tab.', 'tabs.',
  'e.g.', 'i.e.', 'al.', 'vs.', 'cf.', 'approx.', 'no.', 'nos.', 'eqn.', 'eqns.', 'resp.', 'ch.', 'chap.',
  'sect.', 'viz.', 'w.r.t.', 'a.u.', 'dr.', 'prof.', 'mr.', 'ms.', 'st.', 'jr.', 'phys.', 'rev.', 'lett.',
  'nucl.', 'proc.', 'mod.', 'int.', 'eur.', 'ibid.', 'op.', 'cit.', 'vol.', 'pp.', 'p.', 'ex.',
];
