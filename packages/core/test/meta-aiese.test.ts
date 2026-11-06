import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AI_PATTERNS, EXCESS_VOCAB, HEP_NEUTRAL, KOBAK_2024_STYLE, KOBAK_UNMEASURED_INFLECTIONS, aieseFlags, excessWord } from '../src/meta/index';

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

describe('EXCESS_VOCAB', () => {
  it('carries the ratios the paper prints (recomputed from its data, never invented)', () => {
    const r = (w: string): number | null | undefined => EXCESS_VOCAB.find((e) => e.word === w)?.ratio;
    // Values printed by scripts/03-figures.ipynb (cell "noteworthy_words", 2024) of berenslab/llm-excess-vocab.
    expect(r('delves')).toBe(28.0);
    expect(r('showcasing')).toBe(10.7);
    expect(r('underscores')).toBe(13.8);
    expect(r('potential')).toBe(1.3);
    expect(r('findings')).toBe(1.3);
    expect(r('crucial')).toBe(2.1);
    // Every inflection the paper measures separately.
    expect([r('delve'), r('delves'), r('delving'), r('delved')]).toEqual([7.9, 28.0, 6.9, 12.2]);
  });

  it('has a known ratio only for measured words; unmeasured inflections have null', () => {
    const measured = new Map(KOBAK_2024_STYLE.map(([w, ratio]) => [w, ratio]));
    expect(measured.size).toBe(KOBAK_2024_STYLE.length);
    for (const e of EXCESS_VOCAB) {
      if (e.ratio !== null) expect(measured.get(e.word)).toBe(e.ratio);
      else {
        expect(measured.has(e.word)).toBe(false);
        expect(e.inflectionOf).toBeTruthy();
      }
      expect(e.source).toMatch(/Kobak/);
    }
    expect(EXCESS_VOCAB.filter((e) => e.ratio === null).length).toBe(KOBAK_UNMEASURED_INFLECTIONS.length);
  });

  it('flags by the documented rule: r >= 3, or top-100 gap with r >= 1.5, minus HEP_NEUTRAL', () => {
    const measuredFlagged = EXCESS_VOCAB.filter((e) => e.flagged && e.ratio !== null);
    // 79 measured words; the generator (Python, same rule) found the same number.
    expect(measuredFlagged.length).toBe(79);
    for (const e of measuredFlagged) expect(e.ratio! >= 3 || e.ratio! >= 1.5).toBe(true);
    for (const w of HEP_NEUTRAL) expect(excessWord(w)).toBeNull();
    for (const e of EXCESS_VOCAB) if (e.ratio !== null && e.ratio >= 3 && !HEP_NEUTRAL.has(e.word)) expect(e.flagged).toBe(true);
    // Function words with a large gap but r ~ 1 are not flagged.
    for (const w of ['these', 'while', 'into', 'across', 'potential', 'findings']) expect(excessWord(w)).toBeNull();
  });
});

describe('aieseFlags', () => {
  it('flags all inflections of delve, case-insensitively, with their own ratios', () => {
    const text = 'We Delve into it. DELVES are rare; delving and delved too.';
    const flags = aieseFlags(text).filter((f) => f.kind === 'excess_vocab');
    expect(flags.map((f) => f.word)).toEqual(['Delve', 'DELVES', 'delving', 'delved']);
    expect(flags.map((f) => f.ratio)).toEqual([7.9, 28.0, 6.9, 12.2]);
    for (const f of flags) expect(text.slice(f.start, f.end)).toBe(f.word);
    expect(flags[1]!.label).toMatch(/r = 28\.0/);
  });

  it('flags an unmeasured inflection with ratio null and says so', () => {
    const [f] = aieseFlags('This bolsters the case.');
    expect(f).toMatchObject({ word: 'bolsters', kind: 'excess_vocab', ratio: null });
    expect(f!.label).toMatch(/bolstering/);
    expect(f!.label).toMatch(/no measured ratio/);
  });

  it('matches whole words only', () => {
    expect(aieseFlags('undelved delvesque')).toEqual([]);
    expect(aieseFlags('')).toEqual([]);
  });

  it('leaves ordinary physics prose alone', () => {
    for (const s of [
      'This lead holds for every particle species.',
      'We are aligning the tracker with cosmic rays.',
      'The distribution exhibits a peak at 125 GeV.',
      'The statistical, systematic, and theoretical uncertainties are added in quadrature.',
      'Not only the muons are affected.',
      'The potential energy is minimal at the origin.',
    ]) {
      expect(aieseFlags(s), s).toEqual([]);
    }
  });

  it('has a firing example for every pattern, each labelled a heuristic with no rate', () => {
    const examples: Record<string, string> = {
      not_only_but_also: 'The method is not only fast but also precise.',
      serves_as: 'This sample serves as a control region.',
      plays_role: 'Pileup plays a crucial role here.',
      in_todays: "In today's experiments the rates are high.",
      worth_noting: 'It is worth noting that the rate is low.',
      rule_of_three: 'We present a robust, scalable and interpretable tagger.',
      paves_the_way: 'This paves the way for searches.',
      testament: 'The result is a testament to the detector.',
      tapestry: 'A rich tapestry of signatures appears.',
      landscape_of: 'We study the evolving landscape of searches.',
      navigate_complexities: 'We navigate the complexities of pileup.',
      harness_power: 'We harness the power of graphs.',
      unlock_potential: 'This could unlock the full potential of the trigger.',
      shed_light: 'These data shed light on the mechanism.',
      ever_evolving: 'The ever-evolving trigger menu changes yearly.',
    };
    expect(new Set(AI_PATTERNS.map((p) => p.id))).toEqual(new Set(Object.keys(examples)));
    for (const p of AI_PATTERNS) {
      expect(p.label.startsWith('Heuristic:')).toBe(true);
      expect(p.pattern.flags).toContain('g');
      expect(p.pattern.flags).toContain('i');
      const hits = aieseFlags(examples[p.id]!).filter((f) => f.kind === 'pattern' && f.label === p.label);
      expect(hits.length, p.id).toBe(1);
      expect(hits[0]!.ratio).toBeNull();
    }
    // Patterns do not run across sentence punctuation.
    expect(aieseFlags('It is not only this. But also that.').filter((f) => f.kind === 'pattern')).toEqual([]);
  });

  it('returns flags sorted by position, deterministically', () => {
    const text = 'Moreover, it is worth noting that our approach plays a crucial role and underscores the intricate realm of tracking.';
    const a = aieseFlags(text);
    const b = aieseFlags(text);
    expect(a).toEqual(b);
    for (let i = 1; i < a.length; i++) expect(a[i - 1]!.start).toBeLessThanOrEqual(a[i]!.start);
    expect(a.map((f) => f.word.toLowerCase())).toEqual(expect.arrayContaining(['crucial', 'underscores', 'intricate', 'realm', 'plays a crucial role', 'it is worth noting that']));
    for (const f of a) expect(text.slice(f.start, f.end)).toBe(f.word);
  });

  it('finds nothing in the fixture manuscript', () => {
    const tex = readFileSync(here('../../../fixtures/canto-demo/tex/main.tex'), 'utf8');
    const body = tex.slice(tex.indexOf('\\begin{document}'));
    expect(aieseFlags(body.replace(/\\[a-zA-Z]+|[{}$~]/g, ' '))).toEqual([]);
  });
});

describe('THIRD_PARTY.md', () => {
  it('attributes the vendored excess-vocabulary data with its MIT licence', () => {
    const p = here('../THIRD_PARTY.md');
    expect(existsSync(p)).toBe(true);
    const t = readFileSync(p, 'utf8');
    expect(t).toMatch(/berenslab\/llm-excess-vocab/);
    expect(t).toMatch(/MIT License/);
    expect(t).toMatch(/Copyright \(c\) 2024 Dmitry Kobak, Rita González-Márquez/);
  });
});
