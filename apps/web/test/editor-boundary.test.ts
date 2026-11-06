import { describe, expect, it } from 'vitest';
import { endsSentence, englishWordCount, scanSentenceStart, sentencePrefix } from '../src/editor/ghost/boundary';
import { unit } from '../src/editor/testing/fixtures';

describe('endsSentence (the skill boundary rule, committed by the space)', () => {
  it('commits on . ? ! followed by whitespace', () => {
    expect(endsSentence('We train on generic events. ')).toBe(true);
    expect(endsSentence('Does it hold? ')).toBe(true);
    expect(endsSentence('It holds! ')).toBe(true);
    expect(endsSentence('It holds.\n')).toBe(true);
  });

  it('allows closing quotes and brackets after the punctuation', () => {
    expect(endsSentence('He called it “the gap.” ')).toBe(true);
    expect(endsSentence('(This is a note.) ')).toBe(true);
  });

  it('does not commit after abbreviations from DEFAULT_ABBREVIATIONS', () => {
    expect(endsSentence('as shown in Fig. ')).toBe(false);
    expect(endsSentence('trackers, e.g. ')).toBe(false);
    expect(endsSentence('see (Eq. ')).toBe(false);
    expect(endsSentence('Wang et al. ')).toBe(false);
    expect(endsSentence('results vs. ')).toBe(false);
  });

  it('needs real whitespace: ~ and no space never commit', () => {
    expect(endsSentence('see Fig.~')).toBe(false);
    expect(endsSentence('the end.')).toBe(false);
    expect(endsSentence('the end')).toBe(false);
  });

  it('ignores comment lines', () => {
    expect(endsSentence('% a note. ')).toBe(false);
    expect(endsSentence('Text.\n% comment. ')).toBe(false);
  });
});

describe('sentence prefix (what the ghost must continue)', () => {
  const doc = 'First sentence here. Second one starts';
  it('scans back to the previous boundary when the cursor is not in a unit', () => {
    expect(sentencePrefix(doc, [], doc.length)).toBe('Second one starts');
    expect(scanSentenceStart('See Fig. 2 for the', 18)).toBe(0);
  });

  it('uses the unit start when the cursor is inside a unit', () => {
    const units = [unit('a', 0, 20), unit('b', 21, doc.length)];
    expect(sentencePrefix(doc, units, doc.indexOf('starts'))).toBe('Second one ');
  });

  it('continues an unfinished sentence typed past its unit end (the unit end does not grow locally)', () => {
    const text = 'Done here. The tracker finds 2';
    const units = [unit('a', 0, 10), unit('b', 11, 28)];
    expect(sentencePrefix(text, units, text.length)).toBe('The tracker finds 2');
  });

  it('is empty right after a finished sentence and its space', () => {
    const text = 'Done here. ';
    expect(sentencePrefix(text, [unit('a', 0, 10)], text.length)).toBe('');
  });

  it('never crosses a blank line', () => {
    const text = 'Paragraph one ends\n\nNew par';
    expect(sentencePrefix(text, [], text.length)).toBe('New par');
  });
});

describe('englishWordCount', () => {
  it('counts English words, not commands, math, citations or numbers', () => {
    expect(englishWordCount('The tracker finds')).toBe(3);
    // the unit after the math counts as a word token; the math and the citation do not
    expect(englishWordCount('We use $p_T > 1$~GeV \\cite{Wang2022LRT} and')).toBe(4);
    expect(englishWordCount('\\emph{very} large-radius tracks')).toBe(3);
    expect(englishWordCount('2.32 points')).toBe(1);
    expect(englishWordCount('')).toBe(0);
  });
});
