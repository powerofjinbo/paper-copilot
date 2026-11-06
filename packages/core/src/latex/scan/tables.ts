/**
 * Command and environment tables for the LaTeX scanner and the text normalizers.
 *
 * The lists follow the hep-paper-writing skill's scripts/style_check.py (CITE_CMDS, REF_CMDS,
 * KEEP_ARG, KEEP_LAST, DROP_ARGS, DROP0, MATH_ENVS, FLOAT_ENVS, BLANK_ENVS, LIST_ENVS, ...), so that
 * the platform reads a .tex file the way the skill's linter does, plus a few packages common in HEP
 * manuscripts (changes, soul, siunitx, cleveref, biblatex multicites).
 */

/** Sectioning commands and their level (0 part/chapter, 1 section, ..., 4 paragraph/subparagraph). */
export const SECTION_LEVELS: ReadonlyMap<string, number> = new Map([
  ['part', 0],
  ['chapter', 0],
  ['section', 1],
  ['subsection', 2],
  ['subsubsection', 3],
  ['paragraph', 4],
  ['subparagraph', 4],
]);

export const CITE_CMDS: ReadonlySet<string> = new Set([
  'cite', 'citep', 'citet', 'citealp', 'citealt', 'citeauthor', 'citeyear', 'citeyearpar', 'citenum',
  'Cite', 'Citep', 'Citet', 'Citealp', 'Citealt', 'Citeauthor', 'parencite', 'Parencite', 'textcite',
  'Textcite', 'autocite', 'Autocite', 'footcite', 'footcitetext', 'supercite', 'fullcite', 'smartcite',
  'Smartcite', 'citetalias', 'citepalias', 'citealias',
]);

/** biblatex multi-citation commands: (pre)(post){keys} groups may repeat. */
export const MULTICITE_CMDS: ReadonlySet<string> = new Set([
  'cites', 'Cites', 'parencites', 'Parencites', 'textcites', 'Textcites', 'autocites', 'Autocites',
  'footcites', 'smartcites', 'Smartcites', 'supercites',
]);

export const REF_CMDS: ReadonlySet<string> = new Set([
  'ref', 'eqref', 'autoref', 'Autoref', 'cref', 'Cref', 'vref', 'Vref', 'pageref', 'nameref', 'subref',
  'labelcref', 'cpageref', 'Cpageref', 'fref', 'Fref', 'figref', 'Figref', 'tabref', 'secref', 'eqnref',
  'appref', 'autopageref', 'zref', 'vpageref',
]);

/** Ref commands with two mandatory key arguments. */
export const REF_RANGE_CMDS: ReadonlySet<string> = new Set([
  'crefrange', 'Crefrange', 'cpagerefrange', 'Cpagerefrange', 'vrefrange', 'Vrefrange',
]);

/** Named references print a word before the number (\cref{fig:a} -> "Fig. 1"). */
export const NAMED_REF_CMDS: ReadonlySet<string> = new Set([
  'autoref', 'Autoref', 'cref', 'Cref', 'vref', 'Vref', 'fref', 'Fref', 'figref', 'Figref', 'tabref',
  'secref', 'eqnref', 'appref', 'labelcref', 'crefrange', 'Crefrange',
]);

/** Label prefix -> the word a named reference prints. */
export const REF_PREFIX_WORD: ReadonlyMap<string, string> = new Map([
  ['fig', 'Fig.'], ['figure', 'Fig.'], ['tab', 'Table'], ['table', 'Table'], ['tbl', 'Table'],
  ['eq', 'Eq.'], ['eqn', 'Eq.'], ['equation', 'Eq.'], ['sec', 'Sec.'], ['section', 'Sec.'],
  ['ssec', 'Sec.'], ['subsec', 'Sec.'], ['chap', 'Sec.'], ['ch', 'Sec.'], ['app', 'App.'],
  ['appx', 'App.'], ['apx', 'App.'], ['appendix', 'App.'],
]);

/** Text-formatting wrappers whose (last) argument is prose: \emph{x} -> x. */
export const WRAP_CMDS: ReadonlySet<string> = new Set([
  'textbf', 'textit', 'emph', 'textsl', 'textsc', 'texttt', 'textrm', 'textsf', 'textup', 'textmd',
  'textnormal', 'underline', 'uline', 'mbox', 'hbox', 'fbox', 'text', 'textsuperscript', 'textsubscript',
  'enquote', 'hl', 'ul', 'MakeUppercase', 'MakeLowercase', 'uppercase', 'lowercase', 'NoCaseChange',
  'textls', 'strong', 'centerline', 'leftline', 'rightline', 'emphasize', 'makebox', 'framebox', 'added',
  'highlight', 'textweight', 'textlf', 'oldstylenums', 'mathrm', 'mathbf', 'mathit', 'boldsymbol', 'bm',
]);

/** The formatting wrappers that normalizeForHash unwraps (a subset: changes of emphasis keep identity). */
export const HASH_UNWRAP_CMDS: ReadonlySet<string> = new Set([
  'emph', 'textit', 'textbf', 'textrm', 'textsc', 'mbox', 'textsl', 'textsf', 'texttt', 'textup', 'textmd',
  'textnormal', 'underline', 'uline', 'hbox', 'text', 'enquote', 'hl', 'ul', 'strong',
]);

/** Commands whose LAST of n mandatory arguments is prose (the earlier ones are options). */
export const KEEP_LAST_CMDS: ReadonlyMap<string, number> = new Map([
  ['textcolor', 2], ['colorbox', 2], ['foreignlanguage', 2], ['raisebox', 2], ['scalebox', 2],
  ['resizebox', 3], ['rotatebox', 2], ['parbox', 2], ['fcolorbox', 3], ['hyperlink', 2], ['hypertarget', 2],
]);

/** Commands whose FIRST argument is prose and the second is dropped. */
export const KEEP_FIRST_CMDS: ReadonlySet<string> = new Set(['replaced', 'texorpdfstring']);

/**
 * Commands that print nothing in the running text, with the number of mandatory arguments they take
 * (each argument may be preceded by optional [..] arguments). Title material lives here.
 */
export const DROP_ARGS: ReadonlyMap<string, number> = new Map([
  ['vspace', 1], ['includegraphics', 1], ['bibliographystyle', 1], ['setlength', 2], ['addtolength', 2],
  ['setcounter', 2], ['addtocounter', 2], ['stepcounter', 1], ['refstepcounter', 1], ['usepackage', 1],
  ['RequirePackage', 1], ['documentclass', 1], ['pagestyle', 1], ['thispagestyle', 1], ['pagenumbering', 1],
  ['color', 1], ['fontsize', 2], ['linespread', 1], ['graphicspath', 1], ['hypersetup', 1], ['affiliation', 1],
  ['altaffiliation', 1], ['author', 1], ['email', 1], ['date', 1], ['title', 1], ['keywords', 1], ['pacs', 1],
  ['preprint', 1], ['thanks', 1], ['collaboration', 1], ['institute', 1], ['received', 1], ['accepted', 1],
  ['published', 1], ['address', 1], ['phantom', 1], ['hphantom', 1], ['vphantom', 1], ['rule', 2],
  ['todo', 1], ['marginpar', 1], ['sout', 1], ['xout', 1], ['st', 1], ['deleted', 1], ['comment', 1],
  ['addbibresource', 1], ['nocite', 1], ['newcounter', 1], ['definecolor', 3], ['colorlet', 2],
  ['captionsetup', 1], ['setstretch', 1], ['tikzset', 1], ['pgfplotsset', 1], ['urlstyle', 1],
  ['hyphenation', 1], ['theoremstyle', 1], ['newtheorem', 2], ['numberwithin', 2], ['bibitem', 1],
  ['titlerunning', 1], ['authorrunning', 1], ['newlength', 1], ['settowidth', 2], ['arxiv', 1], ['doi', 1],
  ['tnotetext', 1], ['fntext', 1], ['cortext', 1], ['ead', 1], ['orcid', 1], ['subjclass', 1],
  ['shorttitle', 1], ['shortauthors', 1], ['enlargethispage', 1], ['affil', 1], ['externaldocument', 1],
  ['pdfbookmark', 2], ['bookmark', 1], ['pgfmathsetmacro', 2], ['selectlanguage', 1], ['setboolean', 2],
  ['addtocontents', 2], ['addcontentsline', 3], ['crefname', 3], ['Crefname', 3], ['crefformat', 2],
  ['Crefformat', 2], ['newacronym', 3], ['acrodef', 2], ['DeclareSIUnit', 2], ['sisetup', 1],
  ['floatsetup', 1], ['restylefloat', 1], ['lstset', 1], ['setlist', 1], ['newcolumntype', 2], ['index', 1],
  ['glossary', 1], ['tnote', 1], ['footnotemark', 0], ['affiliationmark', 1],
  ['correspondingauthor', 1], ['noaffiliation', 0], ['modulolinenumbers', 0],
  ['linenumbers', 0], ['resetlinenumber', 0],
]);

/** Commands that print nothing and also end the paragraph. */
export const DROP_BREAK_ARGS: ReadonlyMap<string, number> = new Map([
  ['input', 1], ['include', 1], ['subfile', 1], ['bibliography', 1], ['printbibliography', 0],
  ['nobibliography', 1], ['includeonly', 1],
]);

/** Commands without arguments that print nothing (font switches and layout). */
export const INVISIBLE_CMDS: ReadonlySet<string> = new Set(
  `centering raggedright raggedleft indent noindent maketitle clearpage cleardoublepage newpage
pagebreak nopagebreak linebreak nolinebreak allowbreak smallskip medskip bigskip vfill vfil
protect relax xspace nonumber notag leavevmode null ignorespaces displaystyle textstyle scriptstyle bf it
em rm sf tt sc sl up md bfseries itshape mdseries rmfamily sffamily ttfamily scshape slshape upshape
normalfont small footnotesize scriptsize tiny large Large LARGE huge Huge normalsize boldmath unboldmath
FloatBarrier tableofcontents listoffigures listoftables frontmatter mainmatter
backmatter onecolumngrid twocolumngrid balance sloppy fussy selectfont strut hline toprule midrule
bottomrule nolinenumbers makeatletter makeatother endinput
appendixpage addappheadtotoc phantomsection nobreak samepage raggedbottom flushbottom
balancecolsandclearpage onecolumn twocolumn ignorespacesafterend unskip hss vss hfil
expandafter noexpand global long protected else fi printindex printglossary printglossaries
nointerlineskip offinterlineskip normalcolor`.split(/\s+/).filter((w) => w.length > 0),
);

/** Spacing commands that never end a sentence (treated like `~`). */
export const TIE_CMDS: ReadonlySet<string> = new Set([
  'quad', 'qquad', 'enspace', 'thinspace', 'negthinspace', 'hfill', 'enskip', 'hspace', 'hspace*',
  'kern', 'hskip', 'mskip',
]);

/** Commands followed by a TeX dimension (\kern 2pt, \vskip 1ex plus 1fil). */
export const DIMEN_CMDS: ReadonlySet<string> = new Set(['kern', 'hskip', 'vskip', 'mskip']);

/** Line breaks: whitespace for sentence splitting. */
export const LINEBREAK_CMDS: ReadonlySet<string> = new Set(['newline', 'break', 'cr', 'crcr']);

/** siunitx-style commands (atomic, numbers inside them are not sentence ends) and their argument count. */
export const SIUNITX_CMDS: ReadonlyMap<string, number> = new Map([
  ['SI', 2], ['qty', 2], ['si', 1], ['unit', 1], ['num', 1], ['SIrange', 3], ['qtyrange', 3],
  ['numrange', 2], ['ang', 1], ['SIlist', 2], ['numlist', 1], ['qtylist', 2], ['qtyproduct', 2],
  ['numproduct', 1], ['complexnum', 1], ['complexqty', 2],
]);

export const MACRO_DEF_CMDS: ReadonlySet<string> = new Set([
  'newcommand', 'renewcommand', 'providecommand', 'DeclareRobustCommand', 'def', 'gdef', 'edef', 'xdef',
  'let', 'newenvironment', 'renewenvironment', 'DeclareMathOperator', 'newif', 'NewDocumentCommand',
  'RenewDocumentCommand', 'DeclareDocumentCommand', 'ProvideDocumentCommand', 'newrobustcmd',
  'renewrobustcmd', 'NewDocumentEnvironment', 'RenewDocumentEnvironment', 'NewExpandableDocumentCommand',
]);

/** Accent control symbols / words: \'e, \"o, \v{s}, \c{c}. */
export const ACCENT_SYMBOLS = '\'`^"~=.';
export const ACCENT_LETTERS: ReadonlySet<string> = new Set(['u', 'v', 'H', 'c', 'k', 'r', 'b', 'd', 't']);

/** Combining marks for plainText accent conversion. */
export const ACCENT_COMBINING: ReadonlyMap<string, string> = new Map([
  ["'", '́'], ['`', '̀'], ['^', '̂'], ['"', '̈'], ['~', '̃'], ['=', '̄'],
  ['.', '̇'], ['u', '̆'], ['v', '̌'], ['H', '̋'], ['c', '̧'], ['k', '̨'],
  ['r', '̊'], ['b', '̱'], ['d', '̣'], ['t', '͡'],
]);

/** What argument-less text macros print (plainText); also used to decide that a macro prints words. */
export const TEXT_SYMBOLS: ReadonlyMap<string, string> = new Map([
  ['ldots', '…'], ['dots', '…'], ['textellipsis', '…'], ['textbackslash', '\\'], ['LaTeX', 'LaTeX'],
  ['TeX', 'TeX'], ['LaTeXe', 'LaTeX2e'], ['textendash', '–'], ['textemdash', '—'], ['textdegree', '°'],
  ['degree', '°'], ['textmu', 'µ'], ['textpm', '±'], ['texttimes', '×'], ['ie', 'i.e.'], ['eg', 'e.g.'],
  ['etal', 'et al.'], ['cf', 'cf.'], ['vs', 'vs.'], ['wrt', 'w.r.t.'], ['ss', 'ß'], ['o', 'ø'], ['O', 'Ø'],
  ['ae', 'æ'], ['AE', 'Æ'], ['oe', 'œ'], ['OE', 'Œ'], ['aa', 'å'], ['AA', 'Å'], ['l', 'ł'], ['L', 'Ł'],
  ['i', 'ı'], ['j', 'ȷ'], ['S', '§'], ['P', '¶'], ['dag', '†'], ['ddag', '‡'], ['copyright', '©'],
  ['textregistered', '®'], ['texttrademark', '™'], ['checkmark', '✓'], ['textquotedblleft', '“'],
  ['textquotedblright', '”'], ['textquoteleft', '‘'], ['textquoteright', '’'], ['slash', '/'],
  ['textless', '<'], ['textgreater', '>'], ['textbar', '|'], ['today', 'today'], ['percent', '%'],
  ['textpercent', '%'], ['GeV', 'GeV'], ['TeV', 'TeV'], ['MeV', 'MeV'], ['keV', 'keV'], ['eV', 'eV'],
  ['PeV', 'PeV'], ['fb', 'fb'], ['pb', 'pb'], ['nb', 'nb'], ['ifb', 'fb−1'], ['ipb', 'pb−1'],
  ['invfb', 'fb−1'], ['invpb', 'pb−1'], ['fbinv', 'fb−1'], ['pbinv', 'pb−1'], ['iab', 'ab−1'], ['mm', 'mm'],
  ['cm', 'cm'], ['ns', 'ns'], ['ps', 'ps'], ['GeVc', 'GeV/c'], ['TeVc', 'TeV/c'], ['ttbar', 'tt̄'],
  ['textasciitilde', '~'], ['textunderscore', '_'], ['textasciicircum', '^'], ['textsection', '§'],
  ['euro', '€'], ['pounds', '£'], ['textdollar', '$'], ['textbullet', '•'], ['textperiodcentered', '·'],
]);

/** Unit macros (siunitx / hepunits) written out by plainText inside \SI{..}{..}. */
export const UNIT_WORDS: ReadonlyMap<string, string> = new Map([
  ['giga', 'G'], ['tera', 'T'], ['mega', 'M'], ['kilo', 'k'], ['milli', 'm'], ['micro', 'µ'], ['nano', 'n'],
  ['pico', 'p'], ['femto', 'f'], ['atto', 'a'], ['centi', 'c'], ['peta', 'P'], ['exa', 'E'],
  ['electronvolt', 'eV'], ['eV', 'eV'], ['GeV', 'GeV'], ['TeV', 'TeV'], ['MeV', 'MeV'], ['keV', 'keV'],
  ['barn', 'b'], ['metre', 'm'], ['meter', 'm'], ['second', 's'], ['percent', '%'], ['radian', 'rad'],
  ['tesla', 'T'], ['kelvin', 'K'], ['hertz', 'Hz'], ['gram', 'g'], ['kilogram', 'kg'], ['joule', 'J'],
  ['watt', 'W'], ['volt', 'V'], ['ampere', 'A'], ['degree', '°'], ['minute', 'min'], ['hour', 'h'],
  ['day', 'd'], ['year', 'yr'], ['fb', 'fb'], ['pb', 'pb'], ['per', '/'], ['inverse', ''], ['squared', '^2'],
  ['cubic', '^3'], ['square', ''], ['clight', 'c'], ['speedoflight', 'c'], ['mm', 'mm'], ['cm', 'cm'],
  ['ns', 'ns'],
]);

/* ------------------------------------------------------------------------------------ */
/* Environments                                                                          */
/* ------------------------------------------------------------------------------------ */

export const ENV_MATH_DISPLAY = 1;
export const ENV_MATH_INLINE = 2;
export const ENV_VERBATIM = 3;
export const ENV_FLOAT = 4;
export const ENV_SKIP = 5;
export const ENV_LIST = 6;
export const ENV_INLINE_LIST = 7;
export const ENV_ABSTRACT = 8;
export const ENV_ACK = 9;
export const ENV_APPENDIX = 10;
export const ENV_TRANSPARENT = 11;
export const ENV_DOCUMENT = 12;
export const ENV_OTHER = 0;

const ENV_CATEGORY = new Map<string, number>();
const put = (cat: number, names: string): void => {
  for (const n of names.split(/\s+/)) if (n) ENV_CATEGORY.set(n, cat);
};
put(ENV_MATH_DISPLAY, `equation align alignat eqnarray gather multline flalign displaymath dmath dgroup dseries
darray IEEEeqnarray IEEEeqnarraybox empheq subequations xalignat xxalignat split gathered aligned multlined
dmath math* numcases subnumcases`);
put(ENV_MATH_INLINE, 'math');
put(ENV_VERBATIM, `verbatim Verbatim BVerbatim LVerbatim SaveVerbatim VerbatimOut lstlisting minted comment
filecontents alltt pycode pyblock sagesilent sageblock Sinput Soutput Scode lstinputlisting`);
put(ENV_FLOAT, `figure table wrapfigure wraptable sidewaysfigure sidewaystable SCfigure SCtable figwindow
tabwindow longtable algorithm listing subfigure subtable marginfigure margintable widefigure floatrow
sidewaysfloat`);
put(ENV_SKIP, `tabular tabularx tabulary tabu tblr longtblr talltblr supertabular xtabular mpsupertabular
mpxtabular array thebibliography tikzpicture pgfpicture picture axis semilogxaxis semilogyaxis loglogaxis
polaraxis groupplot tikzcd feynman fmffile fmfgraph fmfgraph* circuitikz algorithmic algorithm2e
titlepage keyword keywords IEEEkeywords CCSXML references bibliography quantikz forest tabbing
threeparttable tablenotes NiceTabular NiceArray pspicture`);
put(ENV_LIST, `itemize enumerate description compactitem compactenum compactdesc asparaenum asparaitem
asparadesc list outline enumerate* itemize* description* basedescript dinglist checklist`);
put(ENV_INLINE_LIST, 'inparaenum inparaitem inparadesc');
put(ENV_ABSTRACT, 'abstract');
put(ENV_ACK, 'acknowledgments acknowledgements acknowledgment acknowledgement acks funding');
put(ENV_APPENDIX, 'appendices appendix subappendices');
put(ENV_TRANSPARENT, 'otherlanguage otherlanguage* samepage linenomath linenomath* NoHyper');
put(ENV_DOCUMENT, 'document');

/** Category of an environment name (inline lists from enumitem are `enumerate*`/`itemize*`). */
export function envCategory(name: string): number {
  const c = ENV_CATEGORY.get(name);
  if (c !== undefined) return c;
  const base = name.endsWith('*') ? name.slice(0, -1) : name;
  return ENV_CATEGORY.get(base) ?? ENV_OTHER;
}

/** Mandatory arguments after \begin{name} (optional [..] arguments are always skipped). */
export const ENV_ARGS: ReadonlyMap<string, number> = new Map([
  ['minipage', 1], ['multicols', 1], ['multicols*', 1], ['wrapfigure', 2], ['wraptable', 2], ['subfigure', 1],
  ['subtable', 1], ['adjustbox', 1], ['list', 2], ['alignat', 1], ['alignat*', 1], ['tabularx', 2], ['tabular', 1],
  ['tabular*', 2], ['array', 1], ['longtable', 1], ['figwindow', 1], ['minted', 1], ['spacing', 1],
  ['thebibliography', 1], ['otherlanguage', 1], ['otherlanguage*', 1], ['tabulary', 2], ['xtabular', 1],
  ['supertabular', 1], ['xalignat', 1], ['xxalignat', 1], ['IEEEeqnarray', 1], ['empheq', 1],
  ['tcolorbox', 0], ['mdframed', 0], ['dinglist', 1],
]);

/* ------------------------------------------------------------------------------------ */
/* Headings -> part of the paper (style_check part_for_heading)                           */
/* ------------------------------------------------------------------------------------ */

const DROP_HEAD_RE =
  /^(?:acknowledge?ments?|references|bibliography|author contributions?|data availability(?: statement)?|code availability|funding|conflicts? of interest|competing interests|declaration of competing interests?|contents|table of contents)$/;
const INTRO_HEAD_RE = /^(?:introduction|motivation|introduction and motivation)$/;
const CONCL_HEAD_RE =
  /^(?:conclusions?|summary|outlook|concluding remarks|final remarks|summary and (?:conclusions?|outlook|discussion)|conclusions? and (?:outlook|discussion|future work|perspectives)|discussion and (?:conclusions?|outlook)|summary and future work)$/;

/** style_check norm_title: lower-case, leading numbering ("2.", "IV.", "A.") and trailing punctuation removed. */
export function normTitle(title: string): string {
  let t = title.trim().toLowerCase();
  t = t.replace(/^(?:[a-z]|[ivx]+|\d+(?:\.\d+)*)(?:[.:)]\s*|\s+)/, '');
  return t.replace(/[\s.:;]+$/, '');
}

export type HeadingKind = 'appendix' | 'drop' | 'abstract' | 'intro' | 'concl' | 'other';

/** Classify a heading title the way style_check does, with two widenings: any title that starts with
 * "introduct" is the introduction, any that starts with "conclu" or ends with "and conclusion(s)" is
 * the conclusions. */
export function classifyHeading(plainTitle: string): HeadingKind {
  const raw = plainTitle.trim().toLowerCase();
  const t = normTitle(plainTitle);
  if (/^(?:appendix|appendices|app\.\s)/.test(raw) || /^supplementa(?:l|ry)/.test(t)) return 'appendix';
  if (DROP_HEAD_RE.test(t)) return 'drop';
  if (t === 'abstract') return 'abstract';
  if (INTRO_HEAD_RE.test(t) || /^introduct/.test(t)) return 'intro';
  if (CONCL_HEAD_RE.test(t) || /^conclu/.test(t) || /\band conclusions?$/.test(t)) return 'concl';
  return 'other';
}
