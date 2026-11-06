import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  alternativesTail,
  buildSystemBlocks,
  cleanModelSentence,
  draftTask,
  extractFictionalNumbers,
  factTable,
  framingsTask,
  frozenOutline,
  ghostTail,
  grammarTail,
  instructTail,
  intentTail,
  learnablePairs,
  litReaderTask,
  memoTask,
  OUTPUT_SCHEMAS,
  outputJsonSchema,
  pairId,
  promptHash,
  referencesFor,
  refereeTask,
  replanTail,
  repoReaderTask,
  ROUTING,
  TASK_KINDS,
  type GhostTailInput,
  type PromptBlock,
  type SkillBundle,
  type SystemInput,
  type TaskKind,
} from '../src/prompts/index';
import { emptyOutline, type EditPair, type Fact, type Outline } from '../src/schemas';

/* ------------------------------------------------------------------------------------ */
/* Fixtures                                                                              */
/* ------------------------------------------------------------------------------------ */

const skillDir = fileURLToPath(new URL('../../../.skill/', import.meta.url));
const REAL_SKILL_MD = readFileSync(`${skillDir}SKILL.md`, 'utf8');
const REAL_REFS: Record<string, string> = Object.fromEntries(
  readdirSync(`${skillDir}references`)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => [f, readFileSync(`${skillDir}references/${f}`, 'utf8')]),
);

function fact(p: Partial<Fact> & Pick<Fact, 'id' | 'value'>): Fact {
  return {
    kind: 'number',
    sigfigs: 3,
    unit: 'points',
    uncertainties: {},
    definition: `definition of ${p.id}`,
    definitionSource: 'test',
    artifact: 'results/addendum_g_g1_v1_claim.json',
    locator: `#/${p.id.split('.').pop()}`,
    artifactSha256: 'sha',
    fingerprint: 'fp',
    stale: false,
    validationState: 'candidate',
    aliases: [],
    confirmed: true,
    excluded: false,
    proseOnly: false,
    tags: [],
    ...p,
  };
}

function outline(): Outline {
  const o = emptyOutline();
  o.story = { text: 'We show that the Canto-L tagger keeps more HNL signal than acorn.', keyPhrase: 'Canto-L', provenance: 'author' };
  o.gap = { text: 'No study compares the taggers on displaced HNL decays.', provenance: 'author' };
  o.enabler = { text: 'The new population P_G makes the comparison possible.', provenance: 'ai-proposed' };
  o.contrast = { text: 'The standard approach assumes prompt tracks.', provenance: 'author' };
  o.ladder = [
    { id: 'l1', text: 'Prompt decays', factIds: ['f.g1.eff_a'], provenance: 'author' },
    { id: 'l2', text: 'Displaced decays', factIds: [], provenance: 'author' },
  ];
  o.claimFigures = [{ claimId: 'c1', figureId: 'fig:eff' }];
  o.headline = { factId: 'f.g1.delta_points', baselineFactId: 'f.g1.eff_b', condition: 'population P_G', text: 'Canto-L gains 2.3 points over acorn.', provenance: 'author' };
  o.sections = [
    {
      id: 'sec:results',
      title: 'Results',
      question: 'How much does Canto-L gain?',
      template: 'results',
      ghostMode: 'auto-propose',
      provenance: 'author',
      paragraphs: [
        {
          pid: 'p1',
          job: 'State the headline gain.',
          moves: ['result'],
          claimIds: ['c1'],
          intentNotes: ['写出效率差'],
          provenance: 'author',
          plan: {
            job: 'State the headline gain.',
            claimIds: ['c1'],
            said: {},
            remaining: [{ id: 'st1', intent: 'Give the efficiency difference with its baseline.', factIds: ['f.g1.delta_points'], citeKeys: [], move: 'result' }],
          },
        },
      ],
    },
  ];
  o.authorFilled = true;
  return o;
}

function skill(over: Partial<SkillBundle> = {}): SkillBundle {
  return {
    dir: '/skill',
    skillMd: '# Skill\nUse plain verbs.',
    references: {
      'sentences-and-words.md': '# Sentences\n- Before: *The trigger keeps 31% of decays.*',
      'layering-and-flow.md': '# Flow\nOverview first.',
      'story-and-structure.md': '# Story\nOne story.',
      'figures-and-evidence.md': '# Figures\nCaption anatomy.',
    },
    version: 'v1',
    ...over,
  };
}

function sysInput(over: Partial<SystemInput> = {}): SystemInput {
  return {
    task: 'ghost',
    skill: skill(),
    memo: '- Prefers "we find" (3 pairs: e000001, e000002, e000003)',
    authorNorms: '| median length | 21 | 23 |',
    notesLanguage: 'zh',
    repoBrief: 'Canto compares two taggers.',
    litBrief: 'Closest work: [Smith2024].',
    outline: outline(),
    terminology: [
      { term: 'population P_G', definition: 'generic isolated tracks', acronym: null, firstUseSentenceId: null, variants: ['P_G sample'], symbol: 'P_G' },
      { term: 'acorn', definition: 'the baseline tagger', acronym: null, firstUseSentenceId: null, variants: [], symbol: null },
    ],
    citeKeys: [
      { key: 'Smith:2024abc', title: 'A tagger' },
      { key: 'Adams:2020xyz', title: 'Track fitting' },
    ],
    facts: [
      fact({ id: 'f.g1.delta_points', value: 2.319, uncertainties: { total: 0.279 } }),
      fact({ id: 'f.g1.eff_a', value: 0.9694, unit: '', sigfigs: 4 }),
      fact({ id: 'f.g1.hidden', value: 7.77, excluded: true }),
    ],
    exemplars: ['We find that the gain holds for all three samples.', 'The efficiency rises with the track momentum.'],
    sectionType: 'results',
    ...over,
  };
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const textOf = (blocks: PromptBlock[]): string => blocks.map((b) => b.text).join('\n');

/* ------------------------------------------------------------------------------------ */
/* Routing                                                                               */
/* ------------------------------------------------------------------------------------ */

describe('referencesFor', () => {
  it('follows the skill routing table and never returns more than two files', () => {
    const templates = [undefined, null, 'abstract', 'introduction', 'intro', 'section', 'results', 'conclusions', 'concl', 'caption', 'weird'];
    for (const t of TASK_KINDS) {
      for (const tpl of templates) {
        const r = referencesFor(t, tpl);
        expect(r.length).toBeLessThanOrEqual(2);
        expect(new Set(r).size).toBe(r.length);
      }
      const actions = ['intent', 'instruct', 'alternatives', 'grammar', 'replan'];
      // the actions route shares one reference set (one cached block A per template)
      expect(referencesFor(t)).toEqual(actions.includes(t) ? ['sentences-and-words.md', 'layering-and-flow.md'] : t === 'draft' ? ROUTING.draft : ROUTING[t]);
    }
  });

  it('specialises drafting by section template', () => {
    expect(referencesFor('draft', 'abstract')).toEqual(['story-and-structure.md', 'sentences-and-words.md']);
    expect(referencesFor('draft', 'introduction')).toEqual(['story-and-structure.md', 'layering-and-flow.md']);
    expect(referencesFor('draft', 'intro')).toEqual(['story-and-structure.md', 'layering-and-flow.md']);
    expect(referencesFor('draft', 'results')).toEqual(['figures-and-evidence.md', 'layering-and-flow.md']);
    expect(referencesFor('draft', 'conclusions')).toEqual(['story-and-structure.md', 'figures-and-evidence.md']);
    expect(referencesFor('draft', 'caption')).toEqual(['figures-and-evidence.md']);
    expect(referencesFor('draft', 'section')).toEqual(['layering-and-flow.md']);
    expect(referencesFor('draft', null)).toEqual(['layering-and-flow.md']);
  });

  it('adds the figures reference for sentence work in captions (and results, except ghost)', () => {
    expect(referencesFor('ghost', 'caption')).toEqual(['sentences-and-words.md', 'figures-and-evidence.md']);
    expect(referencesFor('instruct', 'results')).toEqual(['sentences-and-words.md', 'figures-and-evidence.md']);
    expect(referencesFor('ghost', 'introduction')).toEqual(['sentences-and-words.md']);
    expect(referencesFor('ghost', 'results')).toEqual(['sentences-and-words.md']);
    expect(referencesFor('grammar', 'caption')).toEqual(referencesFor('instruct', 'caption'));
    expect(referencesFor('replan', 'results')).toEqual(referencesFor('instruct', 'results'));
    expect(referencesFor('memo', 'results')).toEqual([]);
    expect(referencesFor('referee', 'introduction')).toEqual(['figures-and-evidence.md', 'story-and-structure.md']);
    expect(referencesFor('repo_reader')).toEqual(['story-and-structure.md']);
  });

  it('returns a copy that callers cannot use to change the routing table', () => {
    referencesFor('ghost').push('x.md');
    expect(ROUTING.ghost).toEqual(['sentences-and-words.md']);
  });
});

/* ------------------------------------------------------------------------------------ */
/* System blocks                                                                         */
/* ------------------------------------------------------------------------------------ */

describe('buildSystemBlocks', () => {
  it('is byte-identical for identical inputs', () => {
    const a = buildSystemBlocks(sysInput());
    const b = buildSystemBlocks(clone(sysInput()));
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('places cache_control: A 1h, B 5m, C 5m', () => {
    const blocks = buildSystemBlocks(sysInput());
    expect(blocks).toHaveLength(4); // A, B, C, then the small uncached task rules
    expect(blocks.map((b) => b.type)).toEqual(['text', 'text', 'text', 'text']);
    expect(blocks[3]!.cache_control).toBeUndefined();
    expect(blocks[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(blocks[1]!.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
    expect(blocks[2]!.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
    expect(blocks[2]!.text).toContain('<author_exemplars section_type="results">');
    expect(blocks[2]!.text).toContain('<exemplar>We find that the gain holds for all three samples.</exemplar>');
  });

  it('omits block C when there are no exemplars (or only blank ones)', () => {
    expect(buildSystemBlocks(sysInput({ exemplars: [] }))).toHaveLength(3);
    expect(buildSystemBlocks(sysInput({ exemplars: ['  ', '\n'] }))).toHaveLength(3);
    const two = buildSystemBlocks(sysInput({ exemplars: [] }));
    expect(two[1]!.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
    expect(textOf(two)).not.toContain('<author_exemplars');
  });

  it('keeps blocks A and B identical when only the exemplars change', () => {
    const a = buildSystemBlocks(sysInput());
    const b = buildSystemBlocks(sysInput({ exemplars: ['Another sentence of the author.'] }));
    expect(b[0]!.text).toBe(a[0]!.text);
    expect(b[1]!.text).toBe(a[1]!.text);
    expect(b[2]!.text).not.toBe(a[2]!.text);
  });

  it('changes block B when the five outline items change', () => {
    const base = buildSystemBlocks(sysInput())[1]!.text;
    const edits: Array<(o: Outline) => void> = [
      (o) => (o.story.text = 'We show something else.'),
      (o) => (o.story.keyPhrase = 'Canto-X'),
      (o) => (o.gap.text = 'A different gap.'),
      (o) => (o.enabler.text = 'A different enabler.'),
      (o) => (o.contrast.text = 'A different contrast.'),
      (o) => o.ladder.push({ id: 'l3', text: 'Pileup', factIds: [], provenance: 'author' }),
      (o) => (o.claimFigures[0]!.figureId = 'fig:other'),
      (o) => (o.headline.condition = 'population P_X'),
      (o) => (o.headline.baselineFactId = null),
      (o) => (o.sections[0]!.paragraphs[0]!.job = 'A new job.'),
      (o) => (o.sections[0]!.question = 'A new question?'),
    ];
    for (const edit of edits) {
      const o = outline();
      edit(o);
      expect(buildSystemBlocks(sysInput({ outline: o }))[1]!.text).not.toBe(base);
    }
  });

  it('keeps block B identical when only a paragraph plan (said/remaining), intent notes or ghost mode change', () => {
    const base = buildSystemBlocks(sysInput());
    const o = outline();
    const p = o.sections[0]!.paragraphs[0]!;
    p.plan.said = { st1: '01J0000000000000000000000' };
    p.plan.remaining = [{ id: 'st2', intent: 'Explain the mechanism.', factIds: ['f.g1.eff_a'], citeKeys: ['Smith:2024abc'], move: 'mechanism' }];
    p.intentNotes = ['新的笔记'];
    o.sections[0]!.ghostMode = 'questions-only';
    o.framings = [{ id: 'fr1', text: 'An AI framing.', provenance: 'ai-proposed', adopted: false }];
    const next = buildSystemBlocks(sysInput({ outline: o }));
    expect(next[0]!.text).toBe(base[0]!.text);
    expect(next[1]!.text).toBe(base[1]!.text);
  });

  it('does not depend on the order of facts, terms or cite keys', () => {
    const i = sysInput();
    const a = buildSystemBlocks(i)[1]!.text;
    const b = buildSystemBlocks({ ...i, facts: [...i.facts].reverse(), terminology: [...i.terminology].reverse(), citeKeys: [...i.citeKeys].reverse() })[1]!.text;
    expect(b).toBe(a);
    expect(a.indexOf('Adams:2020xyz')).toBeLessThan(a.indexOf('Smith:2024abc'));
  });

  it('puts the frozen outline, terminology, cite keys and fact table in block B, without excluded facts', () => {
    const [a, b] = buildSystemBlocks(sysInput());
    for (const tag of ['<repo_brief>', '<literature_brief>', '<outline>', '<terminology>', '<allowed_cite_keys>', '<fact_table>']) expect(b!.text).toContain(tag);
    expect(b!.text).toContain('f.g1.delta_points');
    expect(b!.text).not.toContain('f.g1.hidden');
    expect(b!.text).toContain('Variants to replace with this name: P_G sample');
    expect(b!.text).not.toContain('Give the efficiency difference'); // live plan stays out of B
    expect(a!.text).not.toContain('Canto compares'); // the repo brief is not in A
  });

  it('states the role rules: English paper text, notes language, placeholders, LaTeX, fictional examples', () => {
    const zh = buildSystemBlocks(sysInput())[0]!.text;
    expect(zh).toContain('Write paper text in English');
    expect(zh).toContain('Chinese (简体中文)');
    expect(zh).toContain('[fact?: what the number is]');
    expect(zh).toContain('[ref]');
    expect(zh).toContain('\\cite');
    expect(zh).toContain('\\label');
    expect(zh).toContain('main verb by about word 5');
    expect(zh).toContain('delve');
    expect(zh).toContain('<reference_examples>');
    expect(zh).not.toMatch(/\bCRITICAL\b|!!/);
    const en = buildSystemBlocks(sysInput({ notesLanguage: 'en' }))[0]!.text;
    expect(en).toContain('in English, because the author reads those quickly');
    expect(en).not.toContain('简体中文');
  });

  it('includes the memo and author norms when given, and leaves them out when empty', () => {
    const a = buildSystemBlocks(sysInput())[0]!.text;
    expect(a).toContain('<voice_memo>');
    expect(a).toContain('Prefers "we find"');
    expect(a).toContain('<author_norms>');
    const empty = buildSystemBlocks(sysInput({ memo: '', authorNorms: '  ' }))[0]!.text;
    expect(empty).not.toContain('<voice_memo>');
    expect(empty).not.toContain('<author_norms>');
  });

  it('wraps every reference as fictional examples, at most two, routed by task and section type', () => {
    const count = (s: string): number => (s.match(/<reference [^>]*name="/g) ?? []).length;
    for (const task of TASK_KINDS) {
      for (const sectionType of ['abstract', 'intro', 'body', 'results', 'concl', 'caption', 'other']) {
        const a = buildSystemBlocks(sysInput({ task, sectionType, skill: { dir: skillDir, skillMd: REAL_SKILL_MD, references: REAL_REFS, version: 'real' } }))[0]!.text;
        const want = referencesFor(task, sectionType);
        expect(count(a)).toBe(want.length);
        expect(count(a)).toBeLessThanOrEqual(2);
        for (const name of want) {
          expect(a).toContain(`<reference fictional_examples="true" name="${name}">\n${REAL_REFS[name]!.trim()}\n</reference>`);
        }
        // every reference tag carries the fictional flag
        expect((a.match(/<reference[\s>][^>]*>?/g) ?? []).every((t) => t.includes('fictional_examples="true"'))).toBe(true);
        expect(a).toContain('<skill name="hep-paper-writing" version="real">');
      }
    }
  });

  it('honours referenceKeys, still at most two, skipping unknown files and matching by basename', () => {
    const a = buildSystemBlocks(sysInput({ referenceKeys: ['nope.md', 'references/story-and-structure.md', 'figures-and-evidence.md', 'layering-and-flow.md'] }))[0]!.text;
    expect(a).toContain('<reference fictional_examples="true" name="story-and-structure.md">');
    expect(a).toContain('<reference fictional_examples="true" name="figures-and-evidence.md">');
    expect(a).not.toContain('name="layering-and-flow.md"');
    expect(a).not.toContain('name="nope.md"');
    const none = buildSystemBlocks(sysInput({ referenceKeys: [] }))[0]!.text;
    expect(none).not.toMatch(/<reference [^>]*name="/);
  });

  it('puts the task rules for the requested task into the last, uncached block', () => {
    const rules: Record<TaskKind, string> = {
      ghost: '<task name="ghost">',
      intent: '<task name="intent">',
      instruct: 'drift checklist',
      alternatives: '<task name="alternatives">',
      grammar: 'and nothing else',
      replan: 'stay exactly as they are',
      draft: 'caption anatomy',
      repo_reader: 'locators only',
      lit_reader: '<task name="lit_reader">',
      framings: '<task name="framings">',
      referee: 'at most four questions',
      memo: '400 words',
    };
    for (const task of TASK_KINDS) {
      const blocks = buildSystemBlocks(sysInput({ task }));
      expect(blocks[blocks.length - 1]!.text).toContain(rules[task]);
      expect(blocks[blocks.length - 1]!.cache_control).toBeUndefined();
      expect(blocks[0]!.text).not.toContain(rules[task]);
    }
  });

  it('survives an empty skill bundle and empty project state', () => {
    const blocks = buildSystemBlocks(
      sysInput({ skill: { dir: '', skillMd: '', references: {}, version: '' }, memo: '', authorNorms: '', repoBrief: '', litBrief: '', outline: emptyOutline(), terminology: [], citeKeys: [], facts: [], exemplars: [] }),
    );
    expect(blocks).toHaveLength(3);
    expect(blocks[1]!.text).toContain('(no resolved keys yet: write [ref] wherever a citation is needed)');
    expect(blocks[1]!.text).toContain('id | rendering | kind | definition | validation');
    expect(blocks[1]!.text).toContain('(not written yet)');
  });
});

/* ------------------------------------------------------------------------------------ */
/* Fact table, outline, hash                                                             */
/* ------------------------------------------------------------------------------------ */

describe('factTable', () => {
  it('is sorted by id, omits excluded facts and escapes table separators', () => {
    const t = factTable([
      fact({ id: 'f.z', value: 1.5 }),
      fact({ id: 'f.a', value: 'pT > 1 GeV | |eta| < 4', kind: 'definition', unit: '', sigfigs: null }),
      fact({ id: 'f.m', value: 3.25, excluded: true }),
      fact({ id: 'f.c', value: 0.5, stale: true, proseOnly: true, confirmed: false }),
    ]);
    const lines = t.split('\n');
    expect(lines[0]).toBe('id | rendering | kind | definition | validation');
    expect(lines.slice(1).map((l) => l.split(' | ')[0])).toEqual(['f.a', 'f.c', 'f.z']);
    expect(t).not.toContain('f.m');
    expect(lines[1]!.split(' | ')).toHaveLength(5);
    expect(lines[2]).toContain('STALE');
    expect(lines[2]).toContain('prose-only');
    expect(t).toBe(factTable([...[fact({ id: 'f.c', value: 0.5, stale: true, proseOnly: true, confirmed: false }), fact({ id: 'f.z', value: 1.5 })], fact({ id: 'f.a', value: 'pT > 1 GeV | |eta| < 4', kind: 'definition', unit: '', sigfigs: null })]));
  });

  it('keeps one row per id and handles an empty list', () => {
    expect(factTable([fact({ id: 'f.a', value: 1.25 }), fact({ id: 'f.a', value: 1.25 })]).split('\n')).toHaveLength(2);
    expect(factTable([])).toBe('id | rendering | kind | definition | validation');
  });
});

describe('frozenOutline', () => {
  it('lists the five items and section jobs, marks AI-proposed items, and leaves live state out', () => {
    const t = frozenOutline(outline());
    expect(t).toContain('1. One-sentence story: We show that the Canto-L tagger');
    expect(t).toContain('Key phrase');
    expect(t).toContain('2. Gap:');
    expect(t).toContain('Enabler (why it can be done now): The new population P_G makes the comparison possible. [proposed by the AI; not yet approved by the author]');
    expect(t).toContain('3. Ladder of cases, easy to hard:');
    expect(t).toContain('claim c1 -> figure fig:eff');
    expect(t).toContain('5. Headline result:');
    expect(t).toContain('paragraph p1: State the headline gain. (moves: result; claims: c1)');
    expect(t).not.toContain('写出效率差');
    expect(t).not.toContain('Give the efficiency difference');
  });

  it('shows placeholders for an empty outline', () => {
    const t = frozenOutline(emptyOutline());
    expect(t).toContain('[baseline?]');
    expect(t).toContain('(none yet)');
  });
});

describe('promptHash', () => {
  const sys = (): PromptBlock[] => buildSystemBlocks(sysInput());
  it('is stable for identical inputs and sensitive to the tail', () => {
    expect(promptHash(sys(), 'tail')).toBe(promptHash(clone(sys()), 'tail'));
    expect(promptHash(sys(), 'tail')).not.toBe(promptHash(sys(), 'tail '));
    expect(promptHash(sys(), 'tail')).not.toBe(promptHash(sys(), 'Tail'));
    expect(promptHash(sys(), 'tail')).toMatch(/^[0-9a-f]{14}$/);
  });
  it('is sensitive to block text and cache settings', () => {
    const a = sys();
    const b = clone(a);
    b[1]!.text += ' ';
    expect(promptHash(b, 't')).not.toBe(promptHash(a, 't'));
    const c = clone(a);
    c[0]!.cache_control = { type: 'ephemeral', ttl: '5m' };
    expect(promptHash(c, 't')).not.toBe(promptHash(a, 't'));
  });
});

/* ------------------------------------------------------------------------------------ */
/* Fictional numbers, sentence cleanup                                                   */
/* ------------------------------------------------------------------------------------ */

describe('extractFictionalNumbers', () => {
  const nums = extractFictionalNumbers(REAL_REFS);

  it('finds the invented numbers of the real reference files', () => {
    expect(nums.length).toBeGreaterThan(10);
    for (const n of ['31', '40', '2.5', '5.0', '2.0', '300', '0.4']) expect(nums).toContain(n);
    expect(extractFictionalNumbers(clone(REAL_REFS))).toEqual(nums);
  });

  it('leaves out numbers that only appear in the measured norms of SKILL.md', () => {
    const table = REAL_SKILL_MD.slice(REAL_SKILL_MD.indexOf('| Measure | Corpus value |'));
    const tableText = table.slice(0, table.indexOf('\n\n'));
    const tableNums = [...tableText.matchAll(/\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, '')).filter((n) => n.includes('.') || n.length >= 2);
    expect(tableNums).toEqual(expect.arrayContaining(['23', '13.6', '462', '2.2', '0.3', '1000']));
    const fictionalText = Object.values(REAL_REFS)
      .flatMap((t) => t.split('\n'))
      .filter((l) => /^- (Before|After):/.test(l))
      .join('\n');
    for (const n of tableNums) {
      const inFiction = new RegExp(`(?<![\\d.,])${n.replace('.', '\\.')}(?![\\d])`).test(fictionalText.replace(/(\d),(\d{3})/g, '$1$2'));
      if (!inFiction) expect(nums, `norms-only number ${n}`).not.toContain(n);
    }
    for (const n of ['985', '13.6', '462', '2.2', '0.3']) expect(nums).not.toContain(n);
  });

  it('leaves out the real corpus numbers quoted as exemplars, conventions and boundaries', () => {
    for (const n of ['2.08', '0.268', '87.8', '0.0036', '1.84', '25027', '223', '207', '96.2', '85.6', '84', '67']) expect(nums).not.toContain(n);
  });

  it('reads draft sections up to Boundaries and Before/After lines anywhere', () => {
    const refs = {
      'b.md': '**Exemplars.**\n- "real 77.7 value" [X]\n\n**Draft violation and fix.**\n- Before: *we got 12 events in 3 runs*\n  continued with 4.5 m and 1,250 events\n- After: *the cut at 0.75 keeps it (Fig. 14)*\n\n**Boundaries.** real 66 again\n',
      'a.md': 'Before: invented 88% here\n*After:* also 1.5e\nAfter the number, 99 is prose\n- After: *Table 22 lists 3.0 TeV, q0 = 15, 2nd and 3D*',
    };
    // 1.5e is glued to a letter; Table 22 is structural; q0 is an identifier but "= 15" is a number.
    expect(extractFictionalNumbers(refs)).toEqual(['0.75', '3.0', '4.5', '12', '15', '88', '1250']);
  });

  it('returns [] for no references', () => {
    expect(extractFictionalNumbers({})).toEqual([]);
  });
});

describe('cleanModelSentence', () => {
  const cases: Array<[string, string]> = [
    ['"The tagger keeps 97\\% of tracks."', 'The tagger keeps 97\\% of tracks.'],
    ['“The tagger keeps more tracks.”', 'The tagger keeps more tracks.'],
    ['`We find a gain.`', 'We find a gain.'],
    ['```latex\nWe find a gain \\cite{a}.\n```', 'We find a gain \\cite{a}.'],
    ['Sentence: We find a gain.', 'We find a gain.'],
    ['Revised sentence: We find a gain.', 'We find a gain.'],
    ['Here is the rewritten sentence: "We find a gain."', 'We find a gain.'],
    ['- We find a gain.', 'We find a gain.'],
    ['1. We find a gain.', 'We find a gain.'],
    ['**We find a gain.**', 'We find a gain.'],
    ['  We find a gain.  \n\nNote: I changed the verb.', 'We find a gain.'],
    ['We find a gain.\nNote: I changed the verb.', 'We find a gain.'],
    ['改写：We find a gain.', 'We find a gain.'],
    ['We find a gain.', 'We find a gain.'],
    ["``Prompt'' tracks pass the cut.", "``Prompt'' tracks pass the cut."],
    ['The "tight" and "loose" working points differ.', 'The "tight" and "loose" working points differ.'],
    ['"tight" is the default', '"tight" is the default'],
    ['$p_T > 1$~GeV tracks are kept.', '$p_T > 1$~GeV tracks are kept.'],
    ['', ''],
  ];
  it.each(cases)('cleans %j', (input, want) => {
    expect(cleanModelSentence(input)).toBe(want);
  });
  it('never throws on non-strings', () => {
    expect(cleanModelSentence(undefined as unknown as string)).toBe('');
  });
});

/* ------------------------------------------------------------------------------------ */
/* Tails                                                                                 */
/* ------------------------------------------------------------------------------------ */

function ghostIn(over: Partial<GhostTailInput> = {}): GhostTailInput {
  return {
    mode: 'complete-my-sentence',
    sectionTitle: 'Results',
    sectionType: 'results',
    paragraphJob: 'State the headline gain.',
    plan: {
      job: 'State the headline gain.',
      claimIds: ['c1'],
      said: { st0: 's01' },
      remaining: [{ id: 'st1', intent: 'Give the efficiency difference with its baseline.', factIds: ['f.g1.delta_points'], citeKeys: [], move: 'result' }],
    },
    previousParagraphs: ['First paragraph.', 'Second paragraph.', 'Third paragraph.'],
    paragraphBefore: 'The two taggers are compared on population $P_G$.',
    prefix: 'Canto-L keeps ',
    intentNote: null,
    moveExemplars: ['We find that the gain holds.', 'The efficiency rises with momentum.'],
    allowedFactIds: ['f.g1.delta_points', 'f.g1.eff_a', 'f.g1.delta_points'],
    maxWords: 35,
    ...over,
  };
}

describe('ghostTail', () => {
  it('contains the prefix verbatim, the allowed fact ids and the word limit', () => {
    const t = ghostTail(ghostIn());
    expect(t).toContain('<prefix>Canto-L keeps </prefix>');
    expect(t).toContain('ends with a space');
    expect(t).toContain('f.g1.delta_points, f.g1.eff_a');
    expect(t).toContain('at most 35 words');
    expect(t).toContain('<ghost_request mode="complete-my-sentence">');
    expect(t).not.toContain('First paragraph.'); // only the last two
    expect(t).toContain('Third paragraph.');
    expect(t).toContain('st0 (sentence s01)');
    expect(ghostTail(ghostIn())).toBe(t);
  });

  it('keeps LaTeX in the prefix untouched and respects other word limits', () => {
    const t = ghostTail(ghostIn({ prefix: 'For $p_T < 1$~GeV \\cite{a}, the', maxWords: 20 }));
    expect(t).toContain('<prefix>For $p_T < 1$~GeV \\cite{a}, the</prefix>');
    expect(t).toContain('at most 20 words');
    expect(t).not.toContain('ends with a space');
    expect(ghostTail(ghostIn({ maxWords: Number.NaN }))).toContain('at most 35 words');
  });

  it('handles an empty prefix, no facts, an intent note and questions-only mode', () => {
    const t = ghostTail(ghostIn({ prefix: '', allowedFactIds: [], intentNote: '效率差是 2.3 个百分点', mode: 'auto-propose' }));
    expect(t).toContain('<prefix></prefix>');
    expect(t).toContain('The prefix is empty');
    expect(ghostTail(ghostIn({ prefix: '' }))).toContain('The author has not started this sentence');
    expect(ghostTail(ghostIn({ prefix: 'Canto-L ke' }))).toContain('finish that word');
    expect(t).toContain('(none: write [fact?: ...] for any number)');
    expect(t).toContain('效率差是 2.3 个百分点');
    const q = ghostTail(ghostIn({ mode: 'questions-only' }));
    expect(q).toContain('questions-only');
    expect(q).toContain('return "text" equal to the prefix exactly');
  });

  it('caps the author sentences at six', () => {
    const t = ghostTail(ghostIn({ moveExemplars: Array.from({ length: 9 }, (_, k) => `Sentence ${k}.`) }));
    expect((t.match(/<sentence>/g) ?? []).length).toBe(6);
  });

  it('golden', () => {
    expect(ghostTail(ghostIn())).toMatchInlineSnapshot(`
      "<ghost_request mode="complete-my-sentence">
      <section>
      Title: Results
      Type: results
      Paragraph job: State the headline gain.
      </section>

      <paragraph_plan>
      Job: State the headline gain.
      Claims this paragraph carries: c1
      Already said: st0 (sentence s01)
      Still to say, in order:
      - [st1] Give the efficiency difference with its baseline. (move: result; facts: f.g1.delta_points)
      </paragraph_plan>

      <previous_paragraphs>
      <paragraph>
      Second paragraph.
      </paragraph>
      <paragraph>
      Third paragraph.
      </paragraph>
      </previous_paragraphs>

      <paragraph_so_far>
      The two taggers are compared on population $P_G$.
      </paragraph_so_far>

      <author_sentences>
      <sentence>We find that the gain holds.</sentence>
      <sentence>The efficiency rises with momentum.</sentence>
      </author_sentences>

      <allowed_fact_ids>f.g1.delta_points, f.g1.eff_a</allowed_fact_ids>

      <prefix>Canto-L keeps </prefix>
      </ghost_request>

      The author owns the subject and the verb in this section: continue the sentence they started and finish their thought.
      - "text" is the whole sentence: the exact characters inside <prefix> (it ends with a space, which stays), then your continuation. Keep the prefix as typed.
      - One sentence of at most 35 words, counting the prefix, ending with its final punctuation.
      - Numbers and definitions only from these facts: f.g1.delta_points, f.g1.eff_a, written as the fact table renders them. Anything else becomes [fact?: ...].
      - Follow the paragraph plan's next step.
      - Prefer the wording of <author_sentences> to your own phrasing.
      - Cite only allowed keys; add no new notation.
      - "fulfilled_move_ids": the ids of the plan steps this sentence completes, or []."
    `);
  });
});

describe('other tails', () => {
  it('intentTail asks for n proposals in the notes language and adds nothing to the note', () => {
    const t = intentTail({ intentNote: '把效率差和基线写在一起', sectionTitle: 'Results', paragraphBefore: 'A.', paragraphAfter: '', n: 7, moveExemplars: [], notesLanguage: 'zh' });
    expect(t).toContain('Return exactly three proposals');
    expect(t).toContain('把效率差和基线写在一起');
    expect(t).toContain('Chinese (简体中文)');
    expect(t).toContain('adds no claim');
    expect(intentTail({ intentNote: 'x', sectionTitle: '', paragraphBefore: '', paragraphAfter: '', n: 0, moveExemplars: [], notesLanguage: 'en' })).toContain('one English sentence');
  });

  it('instructTail keeps the sentence, instruction and its language', () => {
    const t = instructTail({ sentence: 'The gain is 2.3 points \\cite{a}.', instruction: '把基线放在前面', lang: 'zh', before: '', after: 'Next.', notesLanguage: 'zh' });
    expect(t).toContain('<sentence>The gain is 2.3 points \\cite{a}.</sentence>');
    expect(t).toContain('<instruction lang="zh">');
    expect(t).toContain('change only what the instruction asks');
    expect(t).toContain('"drift"');
  });

  it('grammarTail asks for a minimal diff without rephrasing', () => {
    const t = grammarTail({ sentence: 'The tagger keep tracks.', notesLanguage: 'en' });
    expect(t).toContain('smallest possible edit');
    expect(t).toContain('do not rephrase');
    expect(t).toContain('<sentence>The tagger keep tracks.</sentence>');
  });

  it('replanTail limits items to downstream proposed sentence ids', () => {
    const t = replanTail({
      paragraphJob: 'State the gain.',
      sentencesSoFar: [
        { id: 's1', text: 'Accepted.', state: 'human' },
        { id: 's2', text: 'Edited.', state: 'ai-edited' },
      ],
      remaining: [],
      downstreamProposed: [{ id: 's3', text: 'Proposed.' }],
      edited: { id: 's2', before: 'Old.', after: 'Edited.' },
    });
    expect(t).toContain('using only these sentence ids: s3');
    expect(t).toContain('<sentence id="s1" state="human">Accepted.</sentence>');
    const none = replanTail({ paragraphJob: '', sentencesSoFar: [], remaining: [], downstreamProposed: [], edited: null });
    expect(none).toContain('"items" is []');
  });

  it('draftTask lists the paragraphs in order and the tools', () => {
    const o = outline();
    const t = draftTask({ section: o.sections[0]!, paragraphs: o.sections[0]!.paragraphs, fromNotes: true, notesLanguage: 'zh', existing: '' });
    expect(t).toContain('propose_paragraph once per paragraph, in this order: p1');
    expect(t).toContain('get_outline');
    expect(t).toContain('写出效率差');
    expect(t).toContain("Draft from the author's notes");
    expect(t).toContain('Results paragraph template');
  });

  it('repoReaderTask asks for locators only and states the globs', () => {
    const t = repoReaderTask({ globs: ['results/**', 'docs/*.md'], notesLanguage: 'zh' });
    expect(t).toContain('- results/**');
    expect(t).toContain('csv:row=3;col=eff');
    expect(t).toContain('Leave every value out');
    expect(t).toContain('"unknowns"');
  });

  it('refereeTask asks for at most four questions with estimates in notes only', () => {
    const t = refereeTask({ sectionTitle: 'Results', sectionText: 'The gain is 2.3 points.', notesLanguage: 'zh' });
    expect(t).toContain('at most four questions, the most important first');
    expect(t).toContain('never in the paper');
  });

  it('memoTask never learns from grammar-only or unchanged pairs, and cites pair ids', () => {
    const pairs: EditPair[] = [
      { sentenceId: 's1', ts: '2026-11-02T10:00:00Z', aiText: 'We observe a gain.', humanText: 'We find a gain.', instruction: null, sectionType: 'results', grammarOnly: false, editDistance: 0.25 },
      { sentenceId: 's2', ts: '2026-11-01T10:00:00Z', aiText: 'The tagger keep tracks.', humanText: 'The tagger keeps tracks.', instruction: null, sectionType: 'results', grammarOnly: true, editDistance: 0.05 },
      { sentenceId: 's3', ts: '2026-11-03T10:00:00Z', aiText: 'Same.', humanText: 'Same.', instruction: null, sectionType: 'intro', grammarOnly: false, editDistance: 0 },
    ];
    expect(learnablePairs(pairs).map((p) => p.sentenceId)).toEqual(['s1']);
    const t = memoTask({ currentMemo: '', pairs });
    expect(t).toContain(`id="${pairId(pairs[0]!)}"`);
    expect(t).not.toContain('The tagger keep tracks.');
    expect(t).toContain('2 grammar-only or unchanged pairs were left out');
    expect(t).toContain('400 words');
    expect(pairId(pairs[0]!)).toMatch(/^e[0-9a-f]{6}$/);
    expect(memoTask({ currentMemo: '- x', pairs: [pairs[1]!] })).toContain('return the current memo unchanged');
  });
});

describe('golden tails', () => {
  it('intentTail', () => {
    expect(
      intentTail({ intentNote: '说明 Canto-L 比 acorn 多保留信号', sectionTitle: 'Results', paragraphBefore: 'We compare the two taggers.', paragraphAfter: '', n: 2, moveExemplars: ['We find that the gain holds.'], notesLanguage: 'zh' }),
    ).toMatchInlineSnapshot(`
      "<intent_request>
      <section>
      Title: Results
      </section>

      <paragraph_before>
      We compare the two taggers.
      </paragraph_before>

      <intent_note>
      说明 Canto-L 比 acorn 多保留信号
      </intent_note>

      <paragraph_after>
      (nothing follows yet)
      </paragraph_after>

      <author_sentences>
      <sentence>We find that the gain holds.</sentence>
      </author_sentences>
      </intent_request>

      Render <intent_note> into two alternative English sentences that fit between <paragraph_before> and <paragraph_after>. Return exactly two proposals.
      - Each proposal is one sentence that says what the note says, at its scope and certainty, and adds no claim, number, comparison or reason of its own.
      - A missing number, baseline or condition becomes a descriptive placeholder; a number the note states stays exactly as written.
      - Write it the way <author_sentences> are written.
      - "note": in Chinese (简体中文), at most two short lines, or "" when there is nothing to say."
    `);
  });
  it('instructTail', () => {
    expect(
      instructTail({ sentence: 'The gain is 2.3 points on $P_G$ \\cite{a}.', instruction: '把基线放在前面', lang: 'zh', before: 'We compare the taggers.', after: '', notesLanguage: 'zh' }),
    ).toMatchInlineSnapshot(`
      "<instruct_request>
      <before>
      We compare the taggers.
      </before>

      <sentence>The gain is 2.3 points on $P_G$ \\cite{a}.</sentence>

      <after>
      (end of paragraph)
      </after>

      <instruction lang="zh">
      把基线放在前面
      </instruction>
      </instruct_request>

      Rewrite <sentence> following <instruction>, and change only what the instruction asks.
      - Keep every claim, number, unit, condition, \\cite, \\ref, \\label and math span of the original.
      - Fill "drift" by rereading your sentence against the original: actor, scope, direction, condition; true means it changed, and set it when unsure.
      - "notes": in Chinese (简体中文), one or two short lines on what changed and what to check."
    `);
  });
  it('alternativesTail', () => {
    expect(alternativesTail({ sentence: 'The gain is 2.3 points.', n: 3, before: '', after: '', notesLanguage: 'en' })).toMatchInlineSnapshot(`
      "<alternatives_request>
      <before>
      (start of paragraph)
      </before>

      <sentence>The gain is 2.3 points.</sentence>

      <after>
      (end of paragraph)
      </after>
      </alternatives_request>

      Write exactly three alternatives to <sentence>, each fitting between <before> and <after>.
      - Same claims, numbers, units, conditions, citations and LaTeX as the original; different structure.
      - "note": in English, one short line on how this version differs."
    `);
  });
  it('grammarTail', () => {
    expect(grammarTail({ sentence: 'The tagger keep the tracks.', notesLanguage: 'zh' })).toMatchInlineSnapshot(`
      "<grammar_request>
      <sentence>The tagger keep the tracks.</sentence>
      </grammar_request>

      Correct the grammar of <sentence> with the smallest possible edit: articles, agreement, tense, prepositions, spelling and punctuation only.
      - Keep every other word, the word order and the LaTeX exactly as written; do not rephrase or improve the style.
      - If nothing needs fixing, return the sentence unchanged and "changes": [].
      - "changes": one short item per fix, in Chinese (简体中文)."
    `);
  });
  it('replanTail', () => {
    expect(
      replanTail({
        paragraphJob: 'State the headline gain.',
        sentencesSoFar: [{ id: 's1', text: 'Canto-L keeps more signal than acorn.', state: 'ai-edited' }],
        remaining: [{ id: 'st2', intent: 'Give the mechanism.', factIds: [], citeKeys: ['Smith:2024abc'], move: 'mechanism' }],
        downstreamProposed: [{ id: 's2', text: 'The gain is 2.3 points.' }],
        edited: { id: 's1', before: 'Canto-L is better.', after: 'Canto-L keeps more signal than acorn.' },
      }),
    ).toMatchInlineSnapshot(`
      "<replan_request>
      <paragraph_job>
      State the headline gain.
      </paragraph_job>

      <sentences_so_far>
      <sentence id="s1" state="ai-edited">Canto-L keeps more signal than acorn.</sentence>
      </sentences_so_far>

      <latest_edit sentence_id="s1">
      <before>Canto-L is better.</before>
      <after>Canto-L keeps more signal than acorn.</after>
      </latest_edit>

      <remaining_plan>
      - [st2] Give the mechanism. (move: mechanism; cite: Smith:2024abc)
      </remaining_plan>

      <downstream_proposed>
      <sentence id="s2">The gain is 2.3 points.</sentence>
      </downstream_proposed>
      </replan_request>

      Return one item for each downstream proposed sentence, using only these sentence ids: s2. Every other sentence stays exactly as it is.
      - "keep" unless the latest edit made the sentence wrong, repetitive or out of order; "text" is null for keep and drop.
      - "remaining": 0 to 4 plain-word steps the paragraph still owes after these sentences, with fact ids.
      - "paragraph_complete": true when the job is done, with "next_opener" saying what the next paragraph opens with; otherwise "next_opener" is null."
    `);
  });
  it('draftTask', () => {
    const o = outline();
    expect(draftTask({ section: o.sections[0]!, paragraphs: o.sections[0]!.paragraphs, fromNotes: false, notesLanguage: 'zh', existing: '\\section{Results}' })).toMatchInlineSnapshot(`
      "<draft_request>
      <section>
      Id: sec:results
      Title: Results
      Question it answers: How much does Canto-L gain?
      Template: results
      </section>

      <paragraph pid="p1">
      Job: State the headline gain.
      Moves: result
      Claims: c1
      Plan steps:
      - [st1] Give the efficiency difference with its baseline. (move: result; facts: f.g1.delta_points)
      Author's notes, in order:
      - 写出效率差
      </paragraph>

      <existing_text>
      \\section{Results}
      </existing_text>
      </draft_request>

      How to work:
      1. Read what you need with the editor tools: get_outline for the story and the neighbouring sections, get_plan for each paragraph, get_facts for the facts and their renderings, get_sentences for the text around the section, get_lit and lookup_cite for citable keys.
      2. Call propose_paragraph once per paragraph, in this order: p1. Use each pid exactly as given; propose each paragraph whole, one sentence per item.
      3. If propose_paragraph reports a gate failure, fix only the sentences it names and propose the same paragraph again.
      4. When every paragraph is proposed, end with one short line.

      Draft from the outline. Each paragraph's job and plan steps give its content; add no claim beyond them.
      Follow the skill's Results paragraph template: the claim with number and baseline, then the figure pointer, regime by regime, then the mechanism.
      - Open each paragraph with its job; keep cases in ladder order; state each result as number, baseline and condition.
      - Fit the existing text: reuse its terms and do not repeat what it already says.
      - Numbers only from get_facts, citations only from allowed keys; a missing piece becomes a descriptive placeholder, listed in "placeholders".
      - note_zh: in Chinese (简体中文), only when the author needs to know something (an assumption, a suggested mechanism to confirm), else null."
    `);
  });
  it('repoReaderTask', () => {
    expect(repoReaderTask({ globs: ['README.md', 'results/**'], notesLanguage: 'zh' })).toMatchInlineSnapshot(`
      "<read_scope>
      Read only files that match these globs, relative to the repository root:
      - README.md
      - results/**
      </read_scope>

      Read the repository (README, docs, result files, configs, figure producers, decision logs) and return:
      - "brief_markdown": the repository brief, in English, at most about 6,000 tokens, with these sections: project summary; pipeline stages, in the repository's own names; samples and definitions; results, as tables whose cells name the artifact and locator (or proposed fact id) behind each value instead of the value; claims register (from docs/preregistration.md if present); figure inventory with exists or needs run; terminology; unknowns.
      - "fact_candidates": every number, cut, definition, sample, setting, figure or table the paper may state, each as {proposed_id, definition_paraphrase, artifact, locator, kind, condition}. "proposed_id" looks like f.<artifact stem>.<key>. "artifact" is the path relative to the repository root. "locator" is a JSON pointer ("#/delta_points"), a CSV cell ("csv:row=3;col=eff"), a YAML key ("yaml:cuts.pt_min") or "md:line=12". "definition_paraphrase" says what the number is, from the artifact's own metadata (sample, population, model, label, n, split). "condition" holds the selection, sample or working point the value depends on; for a number that appears only in README or docs prose, start it with "prose-only".
      - Leave every value out of fact_candidates and out of the brief's tables: the backend reads values from the artifacts at your locators.
      - "figures": each figure file or producer with its job in the story and whether it exists or needs a run.
      - "terminology": the analysis's own terms with one-line definitions.
      - "unknowns": in Chinese (简体中文), what you could not determine, one short item each (which file is authoritative, a missing baseline, an unclear selection)."
    `);
  });
  it('litReaderTask', () => {
    expect(litReaderTask({ keys: [{ key: 'Smith:2024abc', title: 'A tagger' }], notesLanguage: 'zh' })).toMatchInlineSnapshot(`
      "<bibliography>
      - Smith:2024abc: A tagger
      </bibliography>

      Resolve each key with the literature tools and return one record per key you could resolve: its INSPIRE texkey, recid and arXiv id when the tools give them, the title and abstract as returned, and "quotable": verbatim quotes that could support a sentence of this paper, each with the claim it supports and its locator.
      - Put every key you could not match with confidence in "unresolved".
      - "usable_for": in Chinese (简体中文), what this paper could cite the record for, one short item each."
    `);
  });
  it('framingsTask', () => {
    expect(framingsTask({ outline: outline(), notesLanguage: 'zh' })).toMatchInlineSnapshot(`
      "<author_items>
      1. One-sentence story: We show that the Canto-L tagger keeps more HNL signal than acorn.
         Key phrase (repeat it exactly in title, abstract, contribution and conclusions): Canto-L
      2. Gap: No study compares the taggers on displaced HNL decays.
         Enabler (why it can be done now): The new population P_G makes the comparison possible. [proposed by the AI; not yet approved by the author]
         Contrast (the one assumption of the standard approach this paper changes): The standard approach assumes prompt tracks.
      3. Ladder of cases, easy to hard:
         1. [l1] Prompt decays (facts: f.g1.eff_a)
         2. [l2] Displaced decays
      4. Figure that carries each claim:
         - claim c1 -> figure fig:eff
      5. Headline result: Canto-L gains 2.3 points over acorn.
         Number: f.g1.delta_points; baseline: f.g1.eff_b; condition: population P_G

      Sections, in paper order:
      - [sec:results] Results (template: results)
        Question it answers: How much does Canto-L gain?
        - paragraph p1: State the headline gain. (moves: result; claims: c1)
      </author_items>

      Propose exactly three framings of this paper's one-sentence story, each built from the author's items above.
      - Each framing leads with something different: the method, the physics reach, or the contrast with the standard approach.
      - Use the author's key phrase, facts and baseline; write a placeholder for any missing piece.
      - "why": in Chinese (简体中文), what the framing emphasizes and which reader it serves."
    `);
  });
  it('refereeTask', () => {
    expect(refereeTask({ sectionTitle: 'Results', sectionText: 'The gain is 2.3 points.', notesLanguage: 'zh' })).toMatchInlineSnapshot(`
      "<section>
      <title>Results</title>
      <text>
      The gain is 2.3 points.
      </text>
      </section>

      Read this section as a referee and return at most four questions, the most important first.
      - Write questions and estimates in Chinese (简体中文); keep each question to one or two sentences.
      - "sentence_hint": a few words copied verbatim from the sentence the question is about, or null.
      - "estimate": a quick estimate that settles the point, with its assumption, or null. Estimates stay in the notes, never in the paper."
    `);
  });
  it('memoTask', () => {
    const pairs: EditPair[] = [
      { sentenceId: 's1', ts: '2026-11-02T10:00:00Z', aiText: 'We observe a gain.', humanText: 'We find a gain.', instruction: '用 find', sectionType: 'results', grammarOnly: false, editDistance: 0.25 },
    ];
    expect(memoTask({ currentMemo: '- Prefers short openers (2 pairs: e111111, e222222)', pairs })).toMatchInlineSnapshot(`
      "<current_memo>
      - Prefers short openers (2 pairs: e111111, e222222)
      </current_memo>

      <edit_pairs>
      <pair id="edf9731" section_type="results" edit_distance="0.25">
      <ai_text>We observe a gain.</ai_text>
      <author_text>We find a gain.</author_text>
      <instruction>用 find</instruction>
      </pair>
      </edit_pairs>

      Update the memo from this edit pair: each shows a sentence the AI wrote and the author's version of it.
      - Return the whole memo as markdown bullets of plain preferences, at most 400 words.
      - End every bullet with its evidence count and up to three pair ids, e.g. "(3 pairs: e1a2b3c, e4d5e6f, e7a8b9c)".
      - A preference needs at least two supporting pairs to enter the memo; a single pair is noise.
      - Keep the current memo's bullets and wording unless the new pairs contradict them."
    `);
  });
});

/* ------------------------------------------------------------------------------------ */
/* Structured outputs                                                                    */
/* ------------------------------------------------------------------------------------ */

const FORBIDDEN = ['minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems', 'pattern', 'format', '$ref', '$defs', 'definitions', '$schema', 'multipleOf', 'oneOf'];

/** Recursive check of the structured-output dialect; returns a list of violations. */
function strictViolations(node: unknown, path = '#'): string[] {
  const out: string[] = [];
  if (Array.isArray(node)) {
    node.forEach((n, i) => out.push(...strictViolations(n, `${path}/${i}`)));
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  const s = node as Record<string, unknown>;
  for (const k of FORBIDDEN) if (k in s) out.push(`${path}: forbidden keyword ${k}`);
  if (Array.isArray(s.type)) out.push(`${path}: type array (nullable must be anyOf)`);
  if (s.type === 'object') {
    const props = s.properties as Record<string, unknown> | undefined;
    if (!props || typeof props !== 'object') out.push(`${path}: object without properties`);
    if (s.additionalProperties !== false) out.push(`${path}: additionalProperties is not false`);
    const keys = Object.keys(props ?? {}).sort();
    const req = Array.isArray(s.required) ? [...(s.required as string[])].sort() : null;
    if (!req || JSON.stringify(req) !== JSON.stringify(keys)) out.push(`${path}: required != property keys`);
    for (const [k, v] of Object.entries(props ?? {})) out.push(...strictViolations(v, `${path}/properties/${k}`));
  }
  if (s.type === 'array') {
    if (!s.items || typeof s.items !== 'object' || Array.isArray(s.items)) out.push(`${path}: array without a single items schema`);
    out.push(...strictViolations(s.items, `${path}/items`));
  }
  if ('enum' in s && !(Array.isArray(s.enum) && s.enum.every((v) => typeof v === 'string'))) out.push(`${path}: enum of non-strings`);
  if ('anyOf' in s) {
    const alts = s.anyOf as unknown[];
    if (!Array.isArray(alts) || alts.length === 0) out.push(`${path}: empty anyOf`);
    else out.push(...strictViolations(alts, `${path}/anyOf`));
  }
  if (!('type' in s) && !('anyOf' in s) && !('enum' in s) && !('const' in s)) out.push(`${path}: schema without type`);
  return out;
}

const SAMPLES: Record<TaskKind, unknown> = {
  ghost: { text: 'Canto-L keeps 2.3 points more signal.', fact_ids: ['f.g1.delta_points'], cite_keys: [], fulfilled_move_ids: ['st1'] },
  intent: { proposals: [{ text: 'Canto-L keeps more signal.', fact_ids: [], cite_keys: [], note: '' }] },
  instruct: { text: 'x', notes: '把基线放在前面', drift: { actor: false, scope: false, direction: false, condition: true }, fact_ids: [], cite_keys: ['a'] },
  alternatives: { alternatives: [{ text: 'x', note: 'y' }] },
  grammar: { text: 'The tagger keeps tracks.', changes: ['keep -> keeps'] },
  replan: { items: [{ sentence_id: 's3', action: 'revise', text: 'New.', reason: 'repeats' }, { sentence_id: 's4', action: 'keep', text: null, reason: '' }], remaining: [{ intent: 'x', fact_ids: [], move: null }], paragraph_complete: false, next_opener: null },
  draft: { pid: 'p1', sentences: [{ text: 'x', move: 'result', fact_ids: [], cite_keys: [], placeholders: ['[baseline?]'], note_zh: null, referee_question: null }] },
  repo_reader: {
    brief_markdown: '# Brief',
    fact_candidates: [{ proposed_id: 'f.g1.delta_points', definition_paraphrase: 'difference', artifact: 'results/a.json', locator: '#/delta_points', kind: 'number', condition: 'P_G' }],
    figures: [{ path: 'fig/a.pdf', job: 'headline', status: 'needs_run' }],
    terminology: [{ term: 'P_G', definition: 'population' }],
    unknowns: ['哪个文件是权威的？'],
  },
  lit_reader: { records: [{ key: 'a', texkey: 'Smith:2024abc', recid: 123, arxiv: null, title: 't', abstract: null, quotable: [{ claim: 'c', quote: 'q', locator: 'abstract s1' }], usable_for: [] }], unresolved: ['b'] },
  framings: { framings: [{ text: 'x', why: 'y' }] },
  referee: { questions: [{ question: 'q', sentence_hint: null, estimate: '约 10%' }] },
  memo: { memo_markdown: '- Prefers "we find" (2 pairs: e1a2b3, e4c5d6)' },
};

describe('outputJsonSchema', () => {
  it.each(TASK_KINDS.map((t) => [t]))('%s satisfies the structured-output dialect and its sample parses', (task) => {
    const s = outputJsonSchema(task);
    expect(strictViolations(s)).toEqual([]);
    expect(s.type).toBe('object');
    expect(OUTPUT_SCHEMAS[task].safeParse(SAMPLES[task]).success).toBe(true);
    expect(JSON.stringify(outputJsonSchema(task))).toBe(JSON.stringify(s));
  });

  it('writes nullable fields as anyOf with null and keeps text first for ghost', () => {
    const r = outputJsonSchema('replan') as { properties: Record<string, { anyOf?: unknown[] }> };
    expect(r.properties.next_opener!.anyOf).toEqual([{ type: 'string' }, { type: 'null' }]);
    const g = outputJsonSchema('ghost') as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(g.properties)[0]).toBe('text');
    expect(g.required[0]).toBe('text');
    const l = outputJsonSchema('lit_reader') as { properties: { records: { items: { properties: Record<string, { anyOf?: unknown[] }> } } } };
    expect(l.properties.records.items.properties.recid!.anyOf).toEqual([{ type: 'integer' }, { type: 'null' }]);
  });

  it('returns a fresh copy each call', () => {
    const a = outputJsonSchema('ghost');
    (a as Record<string, unknown>).type = 'string';
    expect(outputJsonSchema('ghost').type).toBe('object');
  });

  it('the validator rejects what the API rejects', () => {
    expect(strictViolations({ type: 'object', properties: { a: { type: 'string' } }, required: [] })).not.toEqual([]);
    expect(strictViolations({ type: 'object', properties: { a: { type: ['string', 'null'] } }, required: ['a'], additionalProperties: false })).not.toEqual([]);
    expect(strictViolations({ type: 'object', properties: { a: { type: 'string', minLength: 1 } }, required: ['a'], additionalProperties: false })).not.toEqual([]);
    expect(strictViolations({ type: 'object', properties: { a: { $ref: '#/x' } }, required: ['a'], additionalProperties: false })).not.toEqual([]);
    expect(strictViolations({ type: 'object', properties: { a: { type: 'number', enum: [1, 2] } }, required: ['a'], additionalProperties: false })).not.toEqual([]);
  });
});
