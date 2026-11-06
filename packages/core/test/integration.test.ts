/**
 * Core integration on the fixture paper (fixtures/canto-demo): segment -> import -> gate every
 * sentence -> apply an annotated AI ghost insert -> semantic line breaks -> re-segment and check ids
 * survive -> build the system prompt with the user's real skill.
 *
 * Every module runs for real; nothing is mocked. Facts are built by hand from the fixture's claim JSON
 * and CSV (plus the three selection cuts of docs/definitions.md), the way the fact extractor would.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ChangeSet, Text } from '@codemirror/state';
import { assignUnits, changedRanges, mapUnits, type AssignInput, type AssignResult } from '../src/anchor/units';
import { segment } from '../src/latex/segment';
import { toSemanticLines } from '../src/latex/lines';
import { gateSentence, type GateContext } from '../src/gate/gate';
import { buildSystemBlocks, promptHash, ghostTail, type SkillBundle, type SystemInput } from '../src/prompts/index';
import { hashString } from '../src/text/hash';
import { normalizeForHash } from '../src/text/normalize';
import type { ChangeAnnotation } from '../src/api';
import { emptyOutline, type Fact, type SentenceState, type SentenceUnit, type SentenceVersion, type VersionOrigin } from '../src/schemas';

/* ------------------------------------------------------------------------------------ */
/* Fixture                                                                               */
/* ------------------------------------------------------------------------------------ */

const fx = (p: string): string => fileURLToPath(new URL(`../../../fixtures/canto-demo/${p}`, import.meta.url));
const MAIN = readFileSync(fx('tex/main.tex'), 'utf8');
const BIB = readFileSync(fx('tex/refs.bib'), 'utf8');
const CLAIM_PATH = 'results/addendum_g_g1_v1_claim.json';
const CSV_PATH = 'results/addendum_g_g1_v1.csv';
const CLAIM_SRC = readFileSync(fx(`repo/${CLAIM_PATH}`), 'utf8');
const CSV_SRC = readFileSync(fx(`repo/${CSV_PATH}`), 'utf8');
const CLAIM = JSON.parse(CLAIM_SRC) as Record<string, unknown>;

const SKILL_DIR = fileURLToPath(new URL('../../../.skill/', import.meta.url));

const NOW = '2026-11-06T12:00:00.000Z';
const FILE = 'main.tex';

/** Cite keys of refs.bib, in file order. */
const CITE_KEYS = [...BIB.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)].map((m) => m[1]!);

/* ------------------------------------------------------------------------------------ */
/* Facts, built by hand from the artifacts                                               */
/* ------------------------------------------------------------------------------------ */

function fact(p: Partial<Fact> & Pick<Fact, 'id' | 'value' | 'artifact' | 'locator'>, sha: string): Fact {
  return {
    kind: 'number',
    sigfigs: null,
    unit: '',
    uncertainties: {},
    definition: '',
    definitionSource: 'test: hand-built from the artifact',
    artifactSha256: sha,
    fingerprint: hashString(`${sha}|${p.locator}|${String(p.value)}`),
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

/** Claim JSON: every numeric top-level key (seed arrays and strings are not single facts). */
function claimFacts(): Fact[] {
  const sha = hashString(CLAIM_SRC);
  const out: Fact[] = [];
  const pts = (k: string): number => CLAIM[k] as number;
  for (const [k, v] of Object.entries(CLAIM)) {
    if (typeof v !== 'number') continue;
    const base = { id: `f.g1.${k}`, value: v, artifact: CLAIM_PATH, locator: `#/${k}` };
    if (k === 'n_targets') out.push(fact({ ...base, tags: ['count', 'claim'], definition: `Number of target particles in population ${String(CLAIM.population)}` }, sha));
    else if (k === 'delta_points')
      out.push(
        fact(
          {
            ...base,
            unit: 'points',
            uncertainties: { total: pts('sigma_points'), boot: pts('sigma_boot_points'), seeds: pts('sigma_seeds_points') },
            definition: `Efficiency of ${String(CLAIM.A)} minus ${String(CLAIM.B)}, in percentage points`,
            tags: ['claim', 'headline'],
          },
          sha,
        ),
      );
    else if (k.endsWith('_points') || k.endsWith('2sigma')) out.push(fact({ ...base, unit: 'points', tags: ['claim'] }, sha));
    else if (k.startsWith('eff_') || k.startsWith('fake_rate_'))
      out.push(fact({ ...base, tags: ['fraction', 'claim'], definition: `${k} of ${k.endsWith('A') ? String(CLAIM.A) : String(CLAIM.B)}` }, sha));
    else out.push(fact({ ...base, tags: ['claim'] }, sha));
  }
  return out;
}

/** CSV: per row, the efficiency columns (fractions, mean carries its uncertainties) and the counts. */
function csvFacts(): Fact[] {
  const sha = hashString(CSV_SRC);
  const [head, ...rows] = CSV_SRC.trim().split(/\r?\n/);
  const cols = head!.split(',');
  const out: Fact[] = [];
  rows.forEach((line, r) => {
    const cells = line.split(',');
    const get = (c: string): string => cells[cols.indexOf(c)] ?? '';
    const num = (c: string): number | null => (get(c) === '' ? null : Number(get(c)));
    const what = `${get('label')} on ${get('population')}`;
    for (const c of ['eff_s0', 'eff_s1', 'eff_s2', 'mean', 'ceiling']) {
      const v = num(c);
      if (v === null) continue;
      const unc: Record<string, number> = {};
      if (c === 'mean') {
        unc.total = num('sigma')!;
        unc.boot = num('sigma_boot')!;
        unc.seeds = num('s_seeds')!;
      }
      out.push(fact({ id: `f.csv.r${r}.${c}`, value: v, uncertainties: unc, artifact: CSV_PATH, locator: `csv:row=${r};col=${c}`, tags: ['fraction'], definition: `${c} efficiency of ${what}` }, sha));
    }
    for (const c of ['n', 'n_seeds']) {
      out.push(fact({ id: `f.csv.r${r}.${c}`, value: num(c)!, artifact: CSV_PATH, locator: `csv:row=${r};col=${c}`, tags: ['count'], definition: `${c} for ${what}` }, sha));
    }
  });
  return out;
}

/** The target selection of docs/definitions.md (the cuts the Method section states). */
function cutFacts(): Fact[] {
  const sha = 'definitions.md';
  const base = { kind: 'cut' as const, artifact: 'docs/definitions.md' };
  return [
    fact({ ...base, id: 'f.definitions.pt_gt_1gev', value: 1, unit: 'GeV', locator: 'md:line=1', tags: ['cut', 'cmp:gt'], definition: 'Target particles have pT > 1 GeV' }, sha),
    fact({ ...base, id: 'f.definitions.abs_eta_lt_4', value: 4, locator: 'md:line=2', tags: ['cut', 'cmp:lt'], definition: 'Target particles have |eta| < 4' }, sha),
    fact({ ...base, id: 'f.definitions.ge_5_space_points', value: 5, locator: 'md:line=3', tags: ['cut', 'cmp:ge'], definition: 'Target particles have at least five space points' }, sha),
  ];
}

const FACTS: Fact[] = [...claimFacts(), ...csvFacts(), ...cutFacts()];

/* ------------------------------------------------------------------------------------ */
/* Anchoring harness                                                                     */
/* ------------------------------------------------------------------------------------ */

function ann(origin: VersionOrigin, state: SentenceState | null, extra: Partial<ChangeAnnotation> = {}): ChangeAnnotation {
  return { origin, sentenceIds: [], state, model: null, promptHash: null, instruction: null, lang: null, intentNote: null, factIds: [], citeKeys: [], move: null, requestId: null, ...extra };
}

/** A minimal stand-in for the server's document store: units + version log of one file. */
class Doc {
  units: SentenceUnit[] = [];
  versions: SentenceVersion[] = [];
  last!: AssignResult;

  constructor(public text: string) {
    this.absorb(assignUnits({ ...this.base(), text, seg: segment(text), prev: [], changeSource: 'external', annotation: ann('import', null) }));
  }

  base(): Pick<AssignInput, 'file' | 'lastVersion' | 'lastAiVersion' | 'now'> {
    const latest = (id: string, pred: (v: SentenceVersion) => boolean) => {
      for (let i = this.versions.length - 1; i >= 0; i--) {
        const v = this.versions[i]!;
        if (v.sentenceId === id && pred(v)) return v;
      }
      return undefined;
    };
    return {
      file: FILE,
      now: NOW,
      lastVersion: (id) => latest(id, () => true),
      lastAiVersion: (id) => latest(id, (v) => v.origin.startsWith('ai_') || v.origin === 'replan' || v.origin === 'grammar_fix'),
    };
  }

  absorb(r: AssignResult): AssignResult {
    this.units = r.units;
    this.versions.push(...r.versions);
    this.last = r;
    return r;
  }

  /** Apply a local transaction exactly as the client and server do: map, re-segment, assign. */
  apply(cs: ChangeSet, annotation: ChangeAnnotation | null = null, annotatedRange: { from: number; to: number } | null = null): AssignResult {
    const text = cs.apply(Text.of(this.text.split('\n'))).toString();
    const prev = mapUnits(this.units, cs, text);
    this.text = text;
    return this.absorb(
      assignUnits({ ...this.base(), text, seg: segment(text), prev, dirty: changedRanges(cs), changeSource: 'local', annotation, annotatedRange }),
    );
  }

  src(u: SentenceUnit): string {
    return this.text.slice(u.start, u.end);
  }
}

/* ------------------------------------------------------------------------------------ */
/* Tests                                                                                 */
/* ------------------------------------------------------------------------------------ */

describe('fixture inputs', () => {
  it('builds facts from the artifacts and reads the bib keys', () => {
    expect(CITE_KEYS.sort()).toEqual(['Ju2022Zenodo', 'Wang2022LRT']);
    const ids = FACTS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['f.g1.delta_points', 'f.g1.n_targets', 'f.g1.eff_A', 'f.g1.fake_rate_B', 'f.csv.r0.mean', 'f.csv.r11.n']));
    // 12 CSV rows: 4 with 3 seeds (5 efficiency columns), 2 with 1 seed (3 columns) per population, plus 2 counts each
    expect(FACTS.filter((f) => f.artifact === CSV_PATH)).toHaveLength(2 * (4 * 5 + 2 * 3) + 12 * 2);
  });
});

describe('segment + import on the fixture', () => {
  const seg = segment(MAIN);
  const doc = new Doc(MAIN);

  it('segments the fixture into its 26 units with exact source slices', () => {
    expect(seg.fragment).toBe(false);
    expect(seg.sentences).toHaveLength(26);
    for (const s of seg.sentences) {
      expect(MAIN.slice(s.start, s.end)).toBe(s.text);
      expect(s.text).toBe(s.text.trim());
    }
    expect(seg.labels).toEqual(['sec:intro', 'sec:method', 'eq:eff', 'sec:results', 'fig:eff', 'tab:eff', 'sec:concl', 'app:val']);
    expect([...new Set(seg.cites)].sort()).toEqual([...CITE_KEYS].sort());
    // the comment with a period in the appendix makes no sentence
    expect(seg.sentences.some((s) => s.text.includes('must not create'))).toBe(false);
  });

  it('imports every sentence as human, imported, with one import version each', () => {
    const r = doc.last;
    expect(r.units).toHaveLength(seg.sentences.length);
    expect(r.removed).toEqual([]);
    expect(r.orphaned).toEqual([]);
    expect(r.editPairs).toEqual([]);
    expect(new Set(r.units.map((u) => u.id)).size).toBe(r.units.length);
    for (const u of r.units) {
      expect(u).toMatchObject({ file: FILE, state: 'human', imported: true, everAi: false, orphaned: false });
      expect(u.hash).toBe(hashString(normalizeForHash(doc.src(u))));
    }
    expect(r.versions).toHaveLength(r.units.length);
    expect(r.versions.every((v) => v.origin === 'import' && v.version === 0 && v.model === null)).toBe(true);
    // units are in document order, non-overlapping within a kind
    const prose = r.units.filter((u) => u.kind !== 'footnote');
    for (let i = 1; i < prose.length; i++) expect(prose[i]!.start).toBeGreaterThanOrEqual(prose[i - 1]!.end);
    // cites come from the real token scanner
    const intro = r.units.find((u) => doc.src(u).includes('Wang et al.'))!;
    expect(intro.cites).toEqual(['Wang2022LRT']);
    expect(intro.sectionId).toBe('sec:intro');
  });
});

describe('gate on every fixture sentence', () => {
  const seg = segment(MAIN);
  const ctx = (extra: Partial<GateContext> = {}): GateContext => ({
    mode: 'draft',
    facts: FACTS,
    allowedCiteKeys: CITE_KEYS,
    knownLabels: seg.labels,
    fictionalNumbers: [],
    ...extra,
  });

  it('finds no blocking issue and repairs nothing in the author\'s own sentences', () => {
    for (const s of seg.sentences) {
      const r = gateSentence(s.text, ctx());
      expect(r.issues.filter((i) => i.severity === 'block'), s.text).toEqual([]);
      expect(r.ok, s.text).toBe(true);
      expect(r.repaired).toBe(s.text);
    }
  });

  it('links the headline numbers to their facts', () => {
    const headline = seg.sentences.find((s) => s.text.includes('2.32'))!;
    const r = gateSentence(headline.text, ctx());
    expect(r.factIds).toContain('f.g1.delta_points');
    const abs = seg.sentences.find((s) => s.text.includes('96.94'))!;
    const ra = gateSentence(abs.text, ctx());
    expect(ra.factIds).toEqual(expect.arrayContaining(['f.g1.fake_rate_A', 'f.g1.fake_rate_B']));
    const method = seg.sentences.find((s) => s.text.includes('p_T > 1'))!;
    expect(gateSentence(method.text, ctx()).factIds).toEqual(expect.arrayContaining(['f.definitions.pt_gt_1gev', 'f.definitions.abs_eta_lt_4']));
  });

  it('blocks an invented number and an unknown citation in the same context', () => {
    // 63.5% is no rendering of any fact (97.3% would pass: it is row 6's eff_s0 in the CSV).
    expect(FACTS.some((f) => typeof f.value === 'number' && Math.abs(f.value * 100 - 63.5) < 0.05)).toBe(false);
    const r = gateSentence('The tracker finds 63.5\\% of the targets~\\cite{Nobody2030}.', ctx({ mode: 'ghost' }));
    expect(r.ok).toBe(false);
    const codes = r.issues.filter((i) => i.severity === 'block').map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['unmatched_number', 'unknown_cite']));
    expect(r.repaired).not.toContain('63.5');
    expect(r.repaired).not.toContain('Nobody2030');
  });
});

describe('AI ghost insert, semantic lines, re-segmentation', () => {
  // Accepted ghost text, appended to the Results paragraph on the same line as the last sentence.
  const ANCHOR = 'This lead holds for every particle species.';
  const GHOST = ' The test set of displaced-source targets holds 10,396 particles.';

  it('carries provenance through the insert and keeps every id through the reflow', () => {
    const doc = new Doc(MAIN);
    const before = new Map(doc.units.map((u) => [u.id, { ...u, text: doc.src(u) }]));

    // The ghost passes the gate as a ghost sentence (its prefix is empty: the whole sentence is AI text).
    // 10,396 is the count of six CSV rows: without a hint it is ambiguous (not blocked, not linked);
    // the fact id the model claims resolves it.
    const gctx: GateContext = { mode: 'ghost', facts: FACTS, allowedCiteKeys: CITE_KEYS, knownLabels: segment(MAIN).labels, fictionalNumbers: [] };
    const amb = gateSentence(GHOST.trim(), gctx);
    expect(amb.issues.filter((i) => i.severity === 'block')).toEqual([]);
    expect(amb.factIds).toEqual([]);
    const g = gateSentence(GHOST.trim(), { ...gctx, claimedFactIds: ['f.csv.r6.n'] });
    expect(g.issues.filter((i) => i.severity === 'block')).toEqual([]);
    expect(g.factIds).toEqual(['f.csv.r6.n']);

    // 1. Apply the accepted ghost as one annotated transaction.
    const at = MAIN.indexOf(ANCHOR) + ANCHOR.length;
    expect(at).toBeGreaterThan(ANCHOR.length);
    const cs = ChangeSet.of([{ from: at, insert: GHOST }], MAIN.length);
    const a = ann('ai_ghost', 'ai-drafted', { model: 'claude-haiku-5-5', promptHash: 'ph-ghost', factIds: g.factIds, requestId: 'g1' });
    const r1 = doc.apply(cs, a, { from: at, to: at + GHOST.length });

    expect(r1.units).toHaveLength(before.size + 1);
    expect(r1.removed).toEqual([]);
    const fresh = r1.units.filter((u) => !before.has(u.id));
    expect(fresh).toHaveLength(1);
    const ghost = fresh[0]!;
    expect(doc.src(ghost)).toBe(GHOST.trim());
    expect(ghost).toMatchObject({ state: 'ai-drafted', everAi: true, imported: false, model: 'claude-haiku-5-5', promptHash: 'ph-ghost', acceptedAt: NOW, editDistance: 0, sectionId: 'sec:results' });
    expect(ghost.facts).toEqual(g.factIds);
    const gv = r1.versions.filter((v) => v.sentenceId === ghost.id);
    expect(gv).toEqual([expect.objectContaining({ version: 0, origin: 'ai_ghost', text: GHOST.trim(), model: 'claude-haiku-5-5', promptHash: 'ph-ghost' })]);
    // nothing else changed state or got a version row; the ghost's neighbour got a new ctxHash
    expect(r1.versions).toHaveLength(1);
    for (const u of r1.units) {
      if (u.id === ghost.id) continue;
      const old = before.get(u.id)!;
      expect(doc.src(u)).toBe(old.text);
      expect(u.state).toBe('human');
      expect(u.hash).toBe(old.hash);
    }
    expect(r1.upserts.map((u) => u.id)).toContain(ghost.id);

    // 2. Semantic line breaks: the ghost moves to its own line.
    const seg1 = segment(doc.text);
    const { text: reflowed, edits } = toSemanticLines(doc.text, seg1);
    expect(edits.length).toBeGreaterThanOrEqual(1);
    expect(edits.some((e) => e.from === at && e.insert === '\n')).toBe(true);
    const cs2 = ChangeSet.of(edits.map((e) => ({ from: e.from, to: e.to, insert: e.insert })), doc.text.length);
    expect(cs2.apply(Text.of(doc.text.split('\n'))).toString()).toBe(reflowed);
    expect(reflowed).toContain(`${ANCHOR}\n${GHOST.trim()}\n`);
    // idempotent on its own output
    expect(toSemanticLines(reflowed, segment(reflowed)).edits).toEqual([]);

    const idsBefore = r1.units.map((u) => u.id);
    const stateBefore = new Map(r1.units.map((u) => [u.id, u.state]));
    const r2 = doc.apply(cs2);
    expect(doc.text).toBe(reflowed);

    // 3. Every id survives the whitespace reflow, with state, provenance and hash unchanged.
    expect(r2.units.map((u) => u.id)).toEqual(idsBefore);
    expect(r2.removed).toEqual([]);
    expect(r2.orphaned).toEqual([]);
    expect(r2.versions).toEqual([]);
    expect(r2.editPairs).toEqual([]);
    for (const u of r2.units) expect(u.state).toBe(stateBefore.get(u.id));
    const g2 = r2.units.find((u) => u.id === ghost.id)!;
    expect(doc.src(g2)).toBe(GHOST.trim());
    expect(g2).toMatchObject({ state: 'ai-drafted', everAi: true, model: 'claude-haiku-5-5', hash: ghost.hash, facts: ghost.facts });
    expect(g2.line).toBe(ghost.line + 1);

    // 4. A fresh segmentation of the reflowed text lines up 1:1 with the units.
    const seg2 = segment(reflowed);
    const live = r2.units.filter((u) => u.kind !== 'footnote');
    const segProse = seg2.sentences.filter((s) => s.kind !== 'footnote');
    expect(segProse.map((s) => [s.start, s.end])).toEqual(live.map((u) => [u.start, u.end]));

    // 5. The author then edits the ghost by hand: it becomes ai-edited with an EditPair, same id.
    const word = 'displaced-source';
    const wAt = doc.text.indexOf(word, g2.start);
    const r3 = doc.apply(ChangeSet.of([{ from: wAt, to: wAt + word.length, insert: 'displaced' }], doc.text.length));
    const g3 = r3.units.find((u) => u.id === ghost.id)!;
    expect(g3.state).toBe('ai-edited');
    expect(g3.everAi).toBe(true);
    expect(g3.editDistance).toBeGreaterThan(0);
    expect(r3.editPairs).toEqual([expect.objectContaining({ sentenceId: ghost.id, aiText: GHOST.trim(), humanText: doc.src(g3) })]);
    expect(r3.units.map((u) => u.id)).toEqual(idsBefore);
  });
});

describe('system prompt with the real skill', () => {
  function readSkill(): SkillBundle {
    const skillMd = readFileSync(`${SKILL_DIR}SKILL.md`, 'utf8');
    const references: Record<string, string> = {};
    for (const f of readdirSync(`${SKILL_DIR}references`).sort()) {
      if (f.endsWith('.md')) references[f] = readFileSync(`${SKILL_DIR}references/${f}`, 'utf8');
    }
    const version = hashString(skillMd + Object.entries(references).map(([k, v]) => `${k}\n${v}`).join('\n'));
    return { dir: SKILL_DIR, skillMd, references, version };
  }

  function input(skill: SkillBundle, facts: Fact[], citeKeys: Array<{ key: string; title: string }>): SystemInput {
    const outline = emptyOutline();
    outline.story = { text: 'A tracker trained without the signal finds more displaced particles.', keyPhrase: 'trained without the signal', provenance: 'author' };
    return {
      task: 'ghost',
      skill,
      memo: '',
      authorNorms: '',
      notesLanguage: 'zh',
      repoBrief: 'One claim file and one CSV of efficiencies.',
      litBrief: '',
      outline,
      terminology: [],
      citeKeys,
      facts,
      exemplars: [],
      sectionType: 'results',
    };
  }

  const CITES = [
    { key: 'Wang2022LRT', title: 'Large-radius tracking with Exa.TrkX' },
    { key: 'Ju2022Zenodo', title: 'Simulated data' },
  ];

  it('carries SKILL.md verbatim and is byte-stable', () => {
    const skill = readSkill();
    expect(skill.skillMd.length).toBeGreaterThan(1000);
    const blocks = buildSystemBlocks(input(skill, FACTS, CITES));
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    const a = blocks[0]!;
    expect(a.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(a.text).toContain(skill.skillMd.trim());
    expect(a.text).toContain(skill.version);
    expect(a.text).toMatch(/<reference fictional_examples="true" name="[^"]+\.md">/);

    // the fact table and cite keys are in a later block
    const rest = blocks.slice(1).map((b) => b.text).join('\n');
    expect(rest).toContain('f.g1.delta_points');
    expect(rest).toContain('Wang2022LRT');

    // byte-stable: same input -> identical blocks and hash; input order of facts / cite keys does not matter
    const again = buildSystemBlocks(input(readSkill(), FACTS, CITES));
    expect(JSON.stringify(again)).toBe(JSON.stringify(blocks));
    const shuffled = buildSystemBlocks(input(skill, [...FACTS].reverse(), [...CITES].reverse()));
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(blocks));

    const tail = ghostTail({
      mode: 'complete-my-sentence',
      sectionTitle: 'Results',
      sectionType: 'results',
      paragraphJob: 'State the headline gain.',
      plan: null,
      previousParagraphs: [],
      paragraphBefore: '',
      prefix: 'On the isolated gun particles, the tracker ',
      intentNote: null,
      moveExemplars: ['The test set holds 8,710 targets.'],
      allowedFactIds: ['f.g1.delta_points'],
      maxWords: 35,
    });
    expect(tail).toContain('On the isolated gun particles, the tracker ');
    expect(promptHash(again, tail)).toBe(promptHash(blocks, tail));
    expect(promptHash(blocks, tail)).not.toBe(promptHash(blocks, `${tail} `));
  });
});
