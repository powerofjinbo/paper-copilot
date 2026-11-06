import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeDisclosureStats, modelDisplayName, renderDisclosure, texEscapeDisclosure, type DisclosureStats } from '../src/meta/index';
import type { SentenceUnit, SentenceVersion, Venue } from '../src/schemas';

function unit(id: string, p: Partial<SentenceUnit> = {}): SentenceUnit {
  return {
    id, file: 'main.tex', start: 0, end: 1, line: 1, hash: 'h', ctxHash: '', textNorm: 't', sectionId: 'sec:results', paragraphId: 'p1',
    part: 'body', kind: 'prose', move: null, state: 'human', everAi: false, grammarFixed: false, imported: false, model: null,
    promptHash: null, createdAt: '2026-01-01T00:00:00Z', acceptedAt: null, editDistance: null, intentNote: null, facts: [], cites: [],
    claims: [], placeholders: [], orphaned: false, splitFrom: null, ...p,
  };
}

const AI = new Set(['ai_ghost', 'ai_intent', 'ai_draft', 'ai_rewrite', 'grammar_fix', 'replan']);
function ver(sentenceId: string, version: number, origin: SentenceVersion['origin'], p: Partial<SentenceVersion> = {}): SentenceVersion {
  return {
    sentenceId, version, ts: '2026-03-01T10:00:00Z', text: 'x', origin, model: AI.has(origin) ? 'claude-sonnet-5-5' : null, promptHash: null,
    instruction: null, lang: null, parentVersion: version > 0 ? version - 1 : null, editDistance: null, ...p,
  };
}

const OPTS = { toolName: 'paper-copilot', toolVersion: '0.1.0', recordPath: '.paper/history.jsonl' };
const VENUES: Venue[] = ['aps', 'elsevier', 'springer', 'arxiv'];

/** A realistic log: every category once or more. */
function sampleLog(): { units: SentenceUnit[]; versions: SentenceVersion[] } {
  const units = [
    unit('d1', { state: 'ai-drafted', everAi: true, model: 'claude-opus-5-5', facts: ['f.g1.delta_points'], acceptedAt: '2026-03-02T00:00:00Z' }),
    unit('d2', { state: 'ai-drafted', everAi: true, model: 'claude-opus-5-5', cites: ['Ju2022Zenodo'], acceptedAt: '2026-03-02T00:00:00Z' }),
    unit('e1', { state: 'ai-edited', everAi: true, editDistance: 0.2, facts: ['f.g1.eff_new'] }),
    unit('e2', { state: 'ai-edited', everAi: true, editDistance: 0.4 }),
    unit('i1', { state: 'ai-from-intent', everAi: true, intentNote: '把基线放在前面' }),
    unit('g1', { state: 'human', everAi: true, grammarFixed: true, imported: true }),
    unit('r1', { state: 'human', everAi: true }),
    unit('x1', { state: 'external', everAi: true }),
    unit('h1', { state: 'human' }),
    unit('h2', { state: 'human' }),
    unit('m1', { state: 'human', imported: true }),
    unit('m2', { state: 'human', imported: true }),
    unit('m3', { state: 'human', imported: true }),
    unit('c1', { state: 'external' }),
    unit('o1', { state: 'ai-drafted', everAi: true, orphaned: true }),
  ];
  const versions = [
    ver('d1', 0, 'ai_draft', { model: 'claude-opus-5-5', ts: '2026-02-10T09:00:00Z' }),
    ver('d2', 0, 'ai_draft', { model: 'claude-opus-5-5' }),
    ver('e1', 0, 'ai_ghost', { model: 'claude-haiku-5-5' }),
    ver('e1', 1, 'human_edit'),
    ver('e2', 0, 'ai_ghost', { model: 'claude-haiku-5-5' }),
    ver('e2', 1, 'human_edit'),
    ver('i1', 0, 'ai_intent', { lang: 'zh', instruction: '把基线放在前面' }),
    ver('g1', 0, 'import'),
    ver('g1', 1, 'grammar_fix'),
    ver('r1', 0, 'ai_ghost', { model: 'claude-haiku-5-5' }),
    ver('r1', 1, 'human_typed'),
    ver('x1', 0, 'ai_draft', { model: 'claude-opus-5-5' }),
    ver('x1', 1, 'external_edit'),
    ver('h1', 0, 'human_typed'),
    ver('m1', 0, 'import'),
    ver('o1', 0, 'ai_draft', { model: 'claude-fable-5-1', ts: '2026-04-20T18:30:00Z' }),
    ver('zz', 0, 'ai_ghost', { model: 'claude-haiku-5-5', ts: 'not a date' }),
  ];
  return { units, versions };
}

describe('computeDisclosureStats', () => {
  it('counts every category from the log', () => {
    const { units, versions } = sampleLog();
    const s = computeDisclosureStats(units, versions);
    expect(s.totalSentences).toBe(14); // o1 is orphaned
    expect(s.byState).toEqual({ human: 7, 'ai-from-intent': 1, 'ai-drafted': 2, 'ai-edited': 2, proposed: 0, external: 2, placeholder: 0, unsupported: 0 });
    expect(s.everAi).toBe(8);
    expect(s.aiDrafted).toBe(2);
    expect(s.aiEdited).toBe(2);
    expect(s.meanEditDistance).toBeCloseTo(0.3, 12);
    expect(s.aiFromIntent).toBe(1);
    expect(s.grammarFixed).toBe(1);
    expect(s.grammarOnly).toBe(1);
    expect(s.aiRewrittenByAuthors).toBe(1);
    expect(s.aiChangedExternally).toBe(1);
    expect(s.imported).toBe(3);
    expect(s.humanWritten).toBe(2);
    expect(s.external).toBe(1);
    expect(s.aiPendingReview).toBe(0);
    expect(s.aiWithFacts).toBe(2);
    expect(s.aiWithCites).toBe(1);
    expect(s.aiOpenPlaceholders).toBe(0);
    expect(s.intentLanguages).toEqual(['zh']);
    // Models of all AI versions, including the orphaned sentence's (the tool was used), sorted and distinct.
    expect(s.models).toEqual(['claude-fable-5-1', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
    // Span of the AI versions with valid timestamps.
    expect(s.firstTs).toBe('2026-02-10T09:00:00Z');
    expect(s.lastTs).toBe('2026-04-20T18:30:00Z');
    expect(s.aiVersions).toBe(10);
  });

  it('partitions the AI-touched sentences and the rest', () => {
    const { units, versions } = sampleLog();
    const s = computeDisclosureStats(units, versions);
    const aiParts = s.aiDrafted + s.aiEdited + s.aiFromIntent + s.grammarOnly! + s.aiRewrittenByAuthors! + s.aiChangedExternally! + s.aiPendingReview! + s.aiPlaceholders!;
    expect(aiParts).toBe(s.everAi);
    expect(s.everAi + s.imported + s.humanWritten + s.external).toBe(s.totalSentences);
  });

  it('treats ever-AI as permanent: a flag, any AI version, or an AI-only state is enough', () => {
    const s = computeDisclosureStats(
      [unit('a', { state: 'human' }), unit('b', { state: 'proposed' }), unit('c', { state: 'human', everAi: true })],
      [ver('a', 0, 'ai_ghost'), ver('a', 1, 'human_typed')],
    );
    expect(s.everAi).toBe(3);
    expect(s.aiRewrittenByAuthors).toBe(2);
    expect(s.aiPendingReview).toBe(1);
    expect(s.humanWritten).toBe(0);
  });

  it('separates grammar-only sentences from AI drafts that were also polished', () => {
    const s = computeDisclosureStats(
      [unit('a', { state: 'ai-drafted', everAi: true, grammarFixed: true }), unit('b', { state: 'human', everAi: true, grammarFixed: true }), unit('c', { state: 'human', everAi: true, grammarFixed: true })],
      [ver('a', 0, 'ai_draft'), ver('a', 1, 'grammar_fix'), ver('b', 0, 'human_typed'), ver('b', 1, 'grammar_fix')],
    );
    expect(s.grammarFixed).toBe(3);
    expect(s.grammarOnly).toBe(1); // b; c has the flag but no versions, so "only" is not shown by the log
    expect(s.aiRewrittenByAuthors).toBe(1);
  });

  it('counts pending review, placeholders and open placeholders', () => {
    const s = computeDisclosureStats(
      [
        unit('p', { state: 'proposed', everAi: true }),
        unit('u', { state: 'unsupported', everAi: true }),
        unit('x', { state: 'placeholder', everAi: true, placeholders: ['[claim: lead holds?]'] }),
        unit('f', { state: 'ai-edited', everAi: true, facts: ['f.1'], placeholders: ['[fact?: fake rate]'] }),
        unit('h', { state: 'human', placeholders: ['[ref]'] }),
      ],
      [],
    );
    expect(s.aiPendingReview).toBe(2);
    expect(s.aiPlaceholders).toBe(1);
    expect(s.aiOpenPlaceholders).toBe(1);
    expect(s.openPlaceholders).toBe(3);
    expect(s.meanEditDistance).toBeNull();
  });

  it('handles an empty log', () => {
    const s = computeDisclosureStats([], []);
    expect(s.totalSentences).toBe(0);
    expect(s.everAi).toBe(0);
    expect(s.models).toEqual([]);
    expect(s.firstTs).toBeNull();
    expect(s.lastTs).toBeNull();
    expect(Object.values(s.byState).every((n) => n === 0)).toBe(true);
  });
});

describe('renderDisclosure', () => {
  const { units, versions } = sampleLog();
  const stats = computeDisclosureStats(units, versions);

  it('takes every count from the stats (APS)', () => {
    const d = renderDisclosure('aps', stats, OPTS);
    expect(d.plain).toContain('We used paper-copilot 0.1.0');
    expect(d.plain).toContain('Claude Fable 5.1, Claude Haiku 5.5, Claude Opus 5.5, and Claude Sonnet 5.5 (Anthropic)');
    expect(d.plain).toContain('Of the 14 sentences in the text, 8 were produced or changed with the tool');
    expect(d.plain).toContain("2 sentences were drafted by the tool from the authors' outline and result files and accepted without change");
    expect(d.plain).toContain('2 sentences were drafted by the tool and then edited by the authors (mean word-level edit distance 30%)');
    expect(d.plain).toContain("1 sentence was rendered into English from the authors' own notes in Chinese");
    expect(d.plain).toContain('1 sentence drafted with the tool was then rewritten by the authors');
    expect(d.plain).toContain('1 sentence drafted with the tool was later revised by co-authors outside the tool');
    expect(d.plain).toContain('1 sentence received grammar and language corrections only');
    expect(d.plain).toContain('The authors reviewed each AI-drafted sentence individually');
    expect(d.plain).toContain('2 state numbers linked to entries in the analysis result files and 1 cites references from the bibliography');
    expect(d.plain).toContain('none contains an unresolved placeholder');
    expect(d.plain).toContain('2 were written by the authors without AI assistance');
    expect(d.plain).toContain("3 predate the tool's record");
    expect(d.plain).toContain('1 was contributed by co-authors outside the tool');
    expect(d.plain).toContain('is kept at .paper/history.jsonl.');
    expect(d.latex).toContain('\\texttt{.paper/history.jsonl}');
    expect(d.latex).toContain('30\\%');
    expect(d.placement).toMatch(/Acknowledgments or Methods/);
  });

  it('never claims more checking than the log shows', () => {
    for (const v of VENUES) {
      const d = renderDisclosure(v, stats, OPTS);
      expect(d.plain).not.toMatch(/verif|every number|checked|re-?read|re-?derived|all numbers/i);
    }
  });

  it('withholds review claims while AI sentences are unreviewed', () => {
    const s = computeDisclosureStats([...units, unit('p1', { state: 'proposed', everAi: true }), unit('p2', { state: 'unsupported', everAi: true })], versions);
    const aps = renderDisclosure('aps', s, OPTS).plain;
    expect(aps).not.toContain('reviewed each');
    expect(aps).toContain('2 AI-proposed sentences still await review');
    expect(aps).toContain('must be regenerated after the review');
    const els = renderDisclosure('elsevier', s, OPTS).plain;
    expect(els).not.toContain('reviewed and edited the content as needed');
    expect(els).toContain('take full responsibility');
    const arx = renderDisclosure('arxiv', s, OPTS).plain;
    expect(arx).not.toContain('reviewed by');
    expect(arx).toContain('2 awaiting review');
    expect(arx).not.toContain('rewritten by the authors, 2');
  });

  it('makes no review or linking claim from hand-built stats that lack the review counts', () => {
    const bare: DisclosureStats = {
      totalSentences: 10, byState: { human: 7, 'ai-from-intent': 0, 'ai-drafted': 3, 'ai-edited': 0, proposed: 0, external: 0, placeholder: 0, unsupported: 0 },
      everAi: 3, aiDrafted: 3, aiEdited: 0, meanEditDistance: null, aiFromIntent: 0, grammarFixed: 0, imported: 7, humanWritten: 0, external: 0,
      models: ['claude-sonnet-5-5'], firstTs: null, lastTs: null,
    };
    for (const v of VENUES) {
      const d = renderDisclosure(v, bare, OPTS);
      expect(d.plain).not.toMatch(/reviewed|linked to entries/);
    }
    expect(renderDisclosure('aps', bare, OPTS).plain).toContain('3 sentences were drafted by the tool');
  });

  it('mentions placeholders that remain', () => {
    const s = computeDisclosureStats([unit('a', { state: 'ai-edited', everAi: true, facts: ['f.1'], placeholders: ['[fact?: rate]'] }), unit('b', { state: 'human', placeholders: ['[ref]'] })], []);
    const d = renderDisclosure('aps', s, OPTS).plain;
    expect(d).toContain('1 still contains a placeholder for a missing number or reference');
    expect(d).toContain('In the whole text, 2 sentences still contain a placeholder.');
    expect(d).not.toContain('none contains');
  });

  it('writes the Elsevier declaration as a titled section with the required responsibility statement', () => {
    const d = renderDisclosure('elsevier', stats, OPTS);
    expect(d.latex.startsWith('\\section*{Declaration of generative AI and AI-assisted technologies in the writing process}\n')).toBe(true);
    expect(d.plain.startsWith('Declaration of generative AI and AI-assisted technologies in the writing process\n\n')).toBe(true);
    expect(d.plain).toContain('During the preparation of this work the authors used paper-copilot 0.1.0');
    expect(d.plain).toContain("in order to draft sentences from the authors' outline and analysis results, render the authors' notes into English, and correct grammar and language");
    expect(d.plain).toContain('After using this tool, the authors reviewed and edited the content as needed and take full responsibility for the content of the publication.');
    expect(d.placement).toMatch(/before the references/);
  });

  it('writes a Springer/JHEP Methods paragraph, optional for copy editing alone', () => {
    expect(renderDisclosure('springer', stats, OPTS).placement).toMatch(/Methods section/);
    const g = computeDisclosureStats([unit('a', { state: 'human', everAi: true, grammarFixed: true }), unit('b')], [ver('a', 0, 'human_typed'), ver('a', 1, 'grammar_fix')]);
    const d = renderDisclosure('springer', g, OPTS);
    expect(d.placement).toMatch(/needs no declaration/);
    expect(d.plain).toContain('Language editing of 1 sentence was assisted by paper-copilot 0.1.0');
    // Grammar-only use: no claim of an individual review of AI drafts.
    expect(renderDisclosure('aps', g, OPTS).plain).not.toContain('reviewed each');
  });

  it('writes one arXiv comment line, or none for copy editing alone', () => {
    const d = renderDisclosure('arxiv', stats, OPTS);
    expect(d.plain).not.toContain('\n');
    expect(d.plain).toBe(
      "Text written with AI assistance (paper-copilot 0.1.0, Claude Fable 5.1, Claude Haiku 5.5, Claude Opus 5.5, and Claude Sonnet 5.5): of 14 sentences, 4 drafted with AI, 1 rendered from the authors' notes, 1 drafted with AI and rewritten by the authors, 1 drafted with AI and revised by co-authors, 1 language-polished only, each reviewed by the authors.",
    );
    expect(d.placement).toMatch(/Comments field/);
    const g = computeDisclosureStats([unit('a', { state: 'human', everAi: true })], [ver('a', 0, 'human_typed'), ver('a', 1, 'grammar_fix')]);
    const n = renderDisclosure('arxiv', g, OPTS);
    expect(n.plain).toMatch(/^No significant AI use to report/);
    expect(n.latex.startsWith('%')).toBe(true);
  });

  it('says only what the record shows when there was no AI use', () => {
    const s = computeDisclosureStats([unit('a', { imported: true }), unit('b')], []);
    for (const v of VENUES) {
      const d = renderDisclosure(v, s, OPTS);
      expect(d.plain).not.toMatch(/We used|drafted by/);
    }
    expect(renderDisclosure('aps', s, OPTS).plain).toBe(
      'The record kept by paper-copilot 0.1.0 shows no AI-generated or AI-edited text in this manuscript (2 sentences); of these, 1 predates the record, which therefore does not cover how it was written. The record is kept at .paper/history.jsonl.',
    );
  });

  it('never opens a sentence with a numeral', () => {
    const s = computeDisclosureStats([...units, unit('p', { state: 'proposed', everAi: true }), unit('q', { state: 'human', placeholders: ['[ref]'] })], versions);
    for (const v of VENUES) {
      for (const sentence of renderDisclosure(v, s, OPTS).plain.split(/(?<=\.)\s+/)) expect(sentence, `${v}: ${sentence}`).not.toMatch(/^\d/);
    }
  });

  it('escapes LaTeX specials in names and paths and keeps the plain text free of LaTeX', () => {
    const odd = { toolName: 'paper_copilot & co', toolVersion: '0.1.0-rc#1 100%', recordPath: '~/.paper/history_{v1}.jsonl' };
    const d = renderDisclosure('aps', computeDisclosureStats([unit('a', { state: 'ai-drafted', everAi: true })], [ver('a', 0, 'ai_draft', { model: 'my_model$x' })]), odd);
    expect(d.latex).toContain('paper\\_copilot \\& co 0.1.0-rc\\#1 100\\%');
    expect(d.latex).toContain('\\texttt{\\textasciitilde{}/.paper/history\\_\\{v1\\}.jsonl}');
    expect(d.latex).toContain('my\\_model\\$x');
    expect(d.plain).toContain('paper_copilot & co 0.1.0-rc#1 100%');
    expect(d.plain).not.toContain('(Anthropic)');
    for (const v of VENUES) expect(renderDisclosure(v, stats, OPTS).plain).not.toMatch(/\\[a-zA-Z]/);
    expect(texEscapeDisclosure('a--b')).toBe('a-{}-b');
  });

  it('names models with their versions', () => {
    expect(modelDisplayName('claude-sonnet-5-5')).toBe('Claude Sonnet 5.5');
    expect(modelDisplayName('claude-haiku-5-5-20261001')).toBe('Claude Haiku 5.5');
    expect(modelDisplayName('claude-fable-5-1')).toBe('Claude Fable 5.1');
    expect(modelDisplayName('some-other-model')).toBe('some-other-model');
  });

  it('is deterministic', () => {
    for (const v of VENUES) expect(renderDisclosure(v, stats, OPTS)).toEqual(renderDisclosure(v, computeDisclosureStats(units, versions), OPTS));
  });
});

/* ------------------------------------------------------------------------------------ */
/* The LaTeX compiles in revtex4-2                                                       */
/* ------------------------------------------------------------------------------------ */

const hasLatexmk = ((): boolean => {
  try {
    return spawnSync('latexmk', ['-v'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

describe('disclosure LaTeX', () => {
  it.skipIf(!hasLatexmk)(
    'compiles in a minimal revtex4-2 document (APS acknowledgments and the Elsevier section)',
    () => {
      const { units, versions } = sampleLog();
      const s = computeDisclosureStats([...units, unit('p', { state: 'proposed', everAi: true }), unit('q', { state: 'human', placeholders: ['[ref]'] })], versions);
      const odd = { toolName: 'paper_copilot & co', toolVersion: '0.1.0-rc#1 (100%)', recordPath: '~/.paper/history_{v1}.jsonl' };
      const aps = renderDisclosure('aps', s, OPTS).latex;
      const apsOdd = renderDisclosure('aps', s, odd).latex;
      const els = renderDisclosure('elsevier', s, OPTS).latex;
      const springer = renderDisclosure('springer', s, OPTS).latex;
      const arxiv = renderDisclosure('arxiv', s, OPTS).latex;
      const doc = [
        '\\documentclass[aps,prd,twocolumn,superscriptaddress,nofootinbib]{revtex4-2}',
        '\\begin{document}',
        '\\title{Disclosure test}',
        '\\author{A. Fixture}',
        '\\affiliation{Nowhere Institute}',
        '\\maketitle',
        '\\section{Methods}',
        springer,
        '',
        arxiv,
        '',
        '\\begin{acknowledgments}',
        aps,
        '',
        apsOdd,
        '\\end{acknowledgments}',
        els,
        '\\end{document}',
        '',
      ].join('\n');
      const dir = mkdtempSync(join(tmpdir(), 'disclosure-'));
      try {
        writeFileSync(join(dir, 'disclosure.tex'), doc);
        const r = spawnSync('latexmk', ['-pdf', '-interaction=nonstopmode', '-halt-on-error', 'disclosure.tex'], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
        const log = existsSync(join(dir, 'disclosure.log')) ? readFileSync(join(dir, 'disclosure.log'), 'utf8') : '';
        expect(r.status, `${r.stdout}\n${r.stderr}\n${log.slice(-3000)}`).toBe(0);
        expect(existsSync(join(dir, 'disclosure.pdf'))).toBe(true);
        expect(log).not.toMatch(/^! /m);
        expect(log).not.toMatch(/Missing character/);
        try {
          const text = execFileSync('pdftotext', ['-layout', join(dir, 'disclosure.pdf'), '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
          expect(text.toLowerCase()).toContain('declaration of generative ai');
          expect(text).toContain('{v1}.jsonl');
          expect(text).toContain('co 0.1.0-rc#1 (100%)');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    150_000,
  );
});

describe('disclosure: rewrites on the authors\' instructions', () => {
  it('counts an accepted rewrite of an author sentence apart from drafted sentences, in every venue text', () => {
    const units = [
      unit('w1', { state: 'ai-drafted', everAi: true, imported: true, cites: ['Wang2022LRT'] }),
      unit('d1', { state: 'ai-drafted', everAi: true }),
      unit('h1', { state: 'human', imported: true }),
    ];
    const versions = [ver('w1', 0, 'import'), ver('w1', 1, 'ai_rewrite', { instruction: '动词提前', lang: 'zh' }), ver('d1', 0, 'ai_ghost', { model: 'claude-haiku-5-5' })];
    const s = computeDisclosureStats(units, versions);
    expect(s.aiRewrittenOnRequest).toBe(1);
    expect(s.aiDrafted).toBe(1);
    expect(s.everAi).toBe(2);
    const aps = renderDisclosure('aps', s, OPTS).plain;
    expect(aps).toMatch(/1 of the authors' sentence was rewritten by the tool on the authors' instructions/);
    expect(aps).toMatch(/1 sentence was drafted by the tool/);
    expect(renderDisclosure('arxiv', s, OPTS).plain).toMatch(/1 rewritten with AI on the authors' instructions/);
    expect(renderDisclosure('elsevier', s, OPTS).plain).toMatch(/rewrite the authors' sentences on their instructions/);
  });
});
