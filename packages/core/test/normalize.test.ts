import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { segment } from '../src/latex/segment';
import { editDistanceWords, normalizeForHash, plainText, similarity, wordDiff, wordTokens } from '../src/text/normalize';

const canto = readFileSync(fileURLToPath(new URL('../../../fixtures/canto-demo/tex/main.tex', import.meta.url)), 'utf8');
const cantoUnits = segment(canto).sentences.map((s) => s.text);

describe('normalizeForHash', () => {
  it('1. removes comments but keeps \\% as a percent', () => {
    expect(normalizeForHash('It finds 96.94\\% of them. % a comment here')).toBe('It finds 96.94% of them.');
    expect(normalizeForHash('First part % comment.\nsecond part')).toBe('First part second part');
    expect(normalizeForHash('a \\\\% comment\nb')).toBe('a b');
  });

  it('2. inline and display math become ⟨M⟩', () => {
    expect(normalizeForHash('The value $p_T > 1$~GeV and \\(x\\) and \\[ y \\] and $$z$$.')).toBe(
      'The value ⟨M⟩ GeV and ⟨M⟩ and ⟨M⟩ and ⟨M⟩.',
    );
    expect(normalizeForHash('The efficiency is\n\\begin{equation}\n  \\epsilon = \\frac{a}{b},\n  \\label{eq:eff}\n\\end{equation}\nwhere it holds.')).toBe(
      'The efficiency is ⟨M⟩ where it holds.',
    );
    expect(normalizeForHash('Both \\begin{align*} a &= b \\end{align*} and \\begin{gather} c \\end{gather} and \\ensuremath{t\\bar{t}}.')).toBe(
      'Both ⟨M⟩ and ⟨M⟩ and ⟨M⟩.',
    );
  });

  it('3. citations become ⟨C:keys⟩ for every cite command', () => {
    expect(normalizeForHash('As in Refs.~\\cite[e.g.][p.~5]{a, b} and \\citep{c}.')).toBe('As in Refs. ⟨C:a,b⟩ and ⟨C:c⟩.');
    for (const cmd of ['cite', 'citep', 'citet', 'citealp', 'Cite', 'autocite', 'parencite', 'textcite']) {
      expect(normalizeForHash(`x \\${cmd}{k1,k2} y`)).toBe('x ⟨C:k1,k2⟩ y');
    }
    expect(normalizeForHash('long list~\\cite{a,%\n  b}.')).toBe('long list ⟨C:a,b⟩.');
  });

  it('4. references become ⟨R:label⟩; \\label is removed', () => {
    expect(normalizeForHash('See Fig.~\\ref{fig:eff}, \\eqref{eq:x}, \\cref{a,b}\\label{x} and \\Cref{sec:y}.')).toBe(
      'See Fig. ⟨R:fig:eff⟩, ⟨R:eq:x⟩, ⟨R:a,b⟩ and ⟨R:sec:y⟩.',
    );
    for (const cmd of ['ref', 'eqref', 'cref', 'Cref', 'autoref', 'pageref']) expect(normalizeForHash(`(\\${cmd}{l})`)).toBe('(⟨R:l⟩)');
  });

  it('5. ~ and \\, \\; \\: \\! \\ become a space; \\% becomes %', () => {
    expect(normalizeForHash('A\\,b\\;c\\:d\\!e\\ f~g 5\\%')).toBe('A b c d e f g 5%');
  });

  it('6. formatting wrappers keep their content', () => {
    expect(normalizeForHash('We use \\emph{only} \\textbf{the \\textit{generic}} \\mbox{sample} in \\textrm{x} and \\textsc{y}.')).toBe(
      'We use only the generic sample in x and y.',
    );
  });

  it('7. collapses whitespace, keeps case, keeps unknown macro names', () => {
    expect(normalizeForHash('  The \\ttbar{}   events\n and \\GNN  Trackers.  ')).toBe('The \\ttbar events and \\GNN Trackers.');
    // the empty group stays when a letter follows, or the macro name would run into the word
    expect(normalizeForHash('\\ttbar{}events and \\ttbar{}-trained')).toBe('\\ttbar{}events and \\ttbar-trained');
    expect(normalizeForHash(normalizeForHash('\\ttbar{}events'))).toBe('\\ttbar{}events');
    expect(normalizeForHash('')).toBe('');
  });

  it('is stable: normalizing a normalized text changes nothing', () => {
    for (const u of cantoUnits) expect(normalizeForHash(normalizeForHash(u))).toBe(normalizeForHash(u));
    const tricky = 'It costs \\$5 \\& 50~\\% \\url{http://x.y/z%20} and \\verb|a%b|.';
    expect(normalizeForHash(normalizeForHash(tricky))).toBe(normalizeForHash(tricky));
  });

  it('keeps verbatim arguments intact', () => {
    expect(normalizeForHash('See \\url{http://x.y/z%20} now.')).toBe('See \\url{http://x.y/z%20} now.');
  });

  it('gives the fixture sentences distinct hashes inputs', () => {
    const norms = cantoUnits.map(normalizeForHash);
    expect(new Set(norms).size).toBe(norms.length);
    expect(norms).toContain('The efficiency is ⟨M⟩ where both counts use the same population.');
    expect(norms).toContain('On the isolated gun particles, the tracker finds 2.32 ⟨M⟩ 0.28 points more than acorn (HNL) with the same track builder; see Fig. ⟨R:fig:eff⟩.');
  });
});

describe('plainText', () => {
  it('math: x, or the digits of a short number', () => {
    expect(plainText('The test set holds $8{,}710$ targets and $2.32$ points; $\\pm$ and $10^{-3}$ and $96.94\\%$.')).toBe(
      'The test set holds 8,710 targets and 2.32 points; x and x and 96.94%.',
    );
    expect(plainText('The efficiency is\n\\begin{equation}\n a = b\n\\end{equation}\nwhere it holds.')).toBe('The efficiency is x where it holds.');
  });

  it('citations are removed (with the space they leave), references become 1', () => {
    expect(plainText('line~\\cite{x}. (\\cite{y}) Fine.')).toBe('line. Fine.');
    expect(plainText('See Fig.~\\ref{fig:eff} and Eq.~(\\ref{eq:a}).')).toBe('See Fig. 1 and Eq. (1).');
    expect(plainText('As \\cref{fig:a} and \\Cref{tab:b} show.')).toBe('As Fig. 1 and Table 1 show.');
  });

  it('macros without arguments keep their name, invisible ones vanish, symbols are written out', () => {
    expect(plainText('The \\ttbar{} events and \\GNN trackers.')).toBe('The ttbar events and GNN trackers.');
    expect(plainText('\\noindent We \\medskip use it\\ldots{} e.g.\\ here.')).toBe('We use it… e.g. here.');
  });

  it('accents, quotes, dashes and escapes are converted', () => {
    expect(plainText("``Generic'' means Schr\\\"odinger's \\'{e}t\\'e -- and --- \\c{c}a, `x'.")).toBe(
      '"Generic" means Schrödinger\'s été – and — ça, \'x\'.',
    );
    expect(plainText('It costs \\$5 \\& 3\\% more \\#1.')).toBe('It costs $5 & 3% more #1.');
  });

  it('footnotes are removed (they are units of their own); siunitx is written out; wrappers keep text', () => {
    expect(plainText('Text\\footnote{A note.} more \\SI{30}{\\GeV} and \\si{\\giga\\electronvolt} and \\num{8710}.')).toBe(
      'Text more 30 GeV and GeV and 8710.',
    );
    expect(plainText('\\textcolor{red}{Red text}, \\href{http://a.b}{link}, \\emph{em}, \\url{http://x.y/z%20}.')).toBe(
      'Red text, link, em, http://x.y/z%20.',
    );
  });

  it('labels and comments disappear; whitespace is collapsed', () => {
    expect(plainText('A\n  b\\label{x} % c.\n d.')).toBe('A b d.');
    expect(plainText('')).toBe('');
  });
});

describe('wordTokens', () => {
  it('lower-cases and keeps apostrophes, hyphens and decimal points inside numbers', () => {
    expect(wordTokens("The particle's 2.32-point gain, graph-neural-network don't 8,710 e.g. Fig. 2.")).toEqual([
      'the', "particle's", '2.32', 'point', 'gain', 'graph-neural-network', "don't", '8', '710', 'e', 'g', 'fig', '2',
    ]);
    expect(wordTokens('Schrödinger ÉTÉ')).toEqual(['schrödinger', 'été']);
    expect(wordTokens('')).toEqual([]);
  });
});

describe('editDistanceWords', () => {
  it('is a normalized word-level Levenshtein distance', () => {
    expect(editDistanceWords('the cat sat down', 'the dog sat down')).toBe(0.25);
    expect(editDistanceWords('a b c', 'a b c')).toBe(0);
    expect(editDistanceWords('', '')).toBe(0);
    expect(editDistanceWords('a b', '')).toBe(1);
    expect(editDistanceWords('one two', 'three four five six')).toBe(1);
    expect(editDistanceWords('a b c d', 'a c d')).toBe(0.25);
  });

  it('ignores LaTeX that does not change the words', () => {
    expect(editDistanceWords('$x$ is \\emph{big}~\\cite{a}.', '$y$ is big.')).toBe(0);
    expect(editDistanceWords('We see it in Fig.~\\ref{a}.', 'We see it in Fig. \\ref{b}.')).toBe(0);
  });
});

describe('similarity', () => {
  it('scores whitespace/case-only differences 1', () => {
    expect(similarity('The  Result is GOOD.', 'the result is good.')).toBe(1);
    expect(similarity('The result\nis good.', 'The result is good.')).toBe(1);
  });

  it('is 1 - word edit distance otherwise, on raw or already normalized text', () => {
    expect(similarity('A b c d e', 'A b c d f')).toBeCloseTo(0.8);
    const a = 'It finds 96.94\\% of the targets, compared with 94.62\\% for the baseline.';
    const b = 'It finds 96.9\\% of the targets, compared with 94.6\\% for the baseline.';
    expect(similarity(a, b)).toBeCloseTo(similarity(normalizeForHash(a), normalizeForHash(b)));
    expect(similarity(a, b)).toBeGreaterThan(0.6);
    expect(similarity('Completely different words here', 'Nothing alike at all')).toBe(0);
  });
});

describe('wordDiff', () => {
  const rebuild = (ops: Array<[number, string]>, keep: number): string =>
    ops.filter(([op]) => op === 0 || op === keep).map(([, t]) => t).join('');

  it('reconstructs both texts exactly', () => {
    const pairs: Array<[string, string]> = [
      ['The result is good.', 'The result is great.'],
      ['a b', 'a b c'],
      ['  lead', 'lead  '],
      ['', 'new text'],
      ['old text', ''],
      ['same', 'same'],
      ['x\n y  z', 'x y\tz w'],
      ['see \\cite{a, b} here', 'see \\cite{a, c} there'],
      ['The efficiency is $\\epsilon = N/M$, as before.', 'The efficiency $\\epsilon = N/M$ is as before, we find.'],
    ];
    for (const [a, b] of pairs) {
      const ops = wordDiff(a, b);
      expect(rebuild(ops, -1)).toBe(a);
      expect(rebuild(ops, 1)).toBe(b);
    }
  });

  it('reconstructs random edits of the fixture sentences', () => {
    let seed = 7;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed % n;
    };
    for (const a of cantoUnits) {
      const words = a.split(' ');
      for (let r = 0; r < 4; r++) {
        const w = words.slice();
        const k = rnd(w.length);
        if (r % 2 === 0) w.splice(k, 1);
        else w.splice(k, 0, 'inserted');
        const b = w.join(r === 3 ? '  ' : ' ');
        const ops = wordDiff(a, b);
        expect(rebuild(ops, -1)).toBe(a);
        expect(rebuild(ops, 1)).toBe(b);
      }
    }
  });

  it('gives word-level operations and never splits a command', () => {
    expect(wordDiff('The result is good.', 'The result is great.')).toEqual([
      [0, 'The result is '],
      [-1, 'good.'],
      [1, 'great.'],
    ]);
    expect(wordDiff('a b', 'a b c')).toEqual([
      [0, 'a b'],
      [1, ' c'],
    ]);
    expect(wordDiff('same text', 'same text')).toEqual([[0, 'same text']]);
    expect(wordDiff('', '')).toEqual([]);
    const ops = wordDiff('see \\cite{a, b} here', 'see \\cite{a, c} here');
    expect(ops).toEqual([
      [0, 'see '],
      [-1, '\\cite{a, b} '],
      [1, '\\cite{a, c} '],
      [0, 'here'],
    ]);
  });
});
