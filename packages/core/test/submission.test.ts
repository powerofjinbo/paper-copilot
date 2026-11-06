/**
 * Pre-submission checklist (meta/submission.ts) on the fixture papers: every item, its severity, the
 * sentences behind it, its order, and "ok only if no blocker".
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SubmissionItemId, SubmissionReport } from '../src/api';
import { submissionCheck, SUBMISSION_MAX_ENTRIES, type SubmissionInput } from '../src/meta/submission';
import type { ConsistencyUnit } from '../src/consistency/common';
import { segment } from '../src/latex/segment';
import { hashString } from '../src/text/hash';
import { emptyOutline, type Fact, type LintFlag, type LitRecord } from '../src/schemas';

const PERF_SLACK = process.env.CI ? 3 : 1;
const FX = (p: string): string => fileURLToPath(new URL(`../../../fixtures/${p}`, import.meta.url));

const STEMS: Record<string, string> = { addendum_g_g1_v1_claim: 'g1', addendum_g_g1_v1: 'g1csv', headline_claim: 'headline' };
const UNIT_SUFFIX: Array<[RegExp, string]> = [[/_ms$/, 'ms'], [/_mm$/, 'mm'], [/_gev$/i, 'GeV'], [/_tev$/i, 'TeV'], [/_mrad$/, 'mrad'], [/_points$/, 'points']];
const unitOf = (name: string): string => UNIT_SUFFIX.find(([re]) => re.test(name))?.[1] ?? '';

function mk(p: Partial<Fact> & Pick<Fact, 'id' | 'value' | 'artifact' | 'locator'>): Fact {
  return { kind: 'number', sigfigs: null, unit: '', uncertainties: {}, definition: '', definitionSource: 'test loader', artifactSha256: 'sha', fingerprint: hashString(`${p.locator}|${String(p.value)}`), stale: false, validationState: 'candidate', aliases: [], confirmed: true, excluded: false, proseOnly: false, tags: [], ...p };
}

function loadFacts(repo: string): Fact[] {
  const dir = join(repo, 'results');
  const names = readdirSync(dir).sort((a, b) => Number(!a.endsWith('_claim.json')) - Number(!b.endsWith('_claim.json')) || Number(a.endsWith('.csv')) - Number(b.endsWith('.csv')) || (a < b ? -1 : 1));
  const out: Fact[] = [];
  for (const name of names) {
    const rel = `results/${name}`;
    const src = readFileSync(join(dir, name), 'utf8');
    const base = name.replace(/\.(json|csv)$/, '');
    const stem = STEMS[base] ?? base.replace(/_claim$/, '');
    if (name.endsWith('.json')) {
      const walk = (v: unknown, path: string[], label: string): void => {
        if (typeof v === 'number') {
          out.push(mk({ id: `f.${stem}.${path.join('.')}`, value: v, unit: unitOf(label), definition: label, artifact: rel, locator: `#/${path.join('/')}`, tags: /^n_/.test(label) && Number.isInteger(v) ? ['count'] : [] }));
        } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, String(i)], `${label}[${i}]`));
        else if (v && typeof v === 'object') {
          const obj = v as Record<string, unknown>;
          for (const [k, x] of Object.entries(obj)) walk(x, [...path, k], path.length && /^\d+$/.test(path[path.length - 1]!) ? `${label}.${k}` : k);
          // uncertainties of a difference in points: sigma_points (total), sigma_<name>_points
          for (const k of Object.keys(obj).filter((k) => /^delta.*_points$/.test(k))) {
            const f = out.find((x) => x.id === `f.${stem}.${[...path, k].join('.')}`);
            if (!f) continue;
            for (const [s, x] of Object.entries(obj)) {
              const m = /^sigma(?:_([a-z]+))?_points$/.exec(s);
              if (m && typeof x === 'number') f.uncertainties[m[1] ?? 'total'] = x;
            }
          }
        }
      };
      walk(JSON.parse(src), [], '');
    } else {
      const [head, ...rows] = src.trim().split('\n').map((l) => l.split(','));
      const cols = head!;
      const numeric = (c: string): boolean => /^-?\d+(?:\.\d+)?(?:e-?\d+)?$/i.test(c);
      const metaCols = cols.map((_, j) => j).filter((j) => !numeric(rows[0]![j] ?? ''));
      rows.forEach((r, i) => {
        const key = metaCols.length ? metaCols.map((j) => r[j]).join('.') : `r${i + 1}`;
        const meta = metaCols.map((j) => `${cols[j]}=${r[j]}`).join('; ');
        cols.forEach((c, j) => {
          if (metaCols.includes(j) || !numeric(r[j] ?? '') || /_sigma$/.test(c)) return;
          const sig = cols.indexOf(`${c}_sigma`);
          out.push(mk({ id: `f.${stem}.${key}.${c}`, value: Number(r[j]), unit: unitOf(c), definition: `${c}${meta ? ` (${meta})` : ''}`, artifact: rel, locator: `csv:row=${i + 1};col=${c}`, tags: c === 'n' ? ['count'] : [], uncertainties: sig >= 0 ? { total: Number(r[sig]) } : {} }));
        });
      });
    }
  }
  return out;
}

function unitsOf(file: string, text: string): ConsistencyUnit[] {
  return segment(text).sentences.map((s, i) => ({ id: `${file}#${i}`, file, line: s.line, part: s.part, kind: s.kind, sectionId: s.sectionId, text: s.text, start: s.start, end: s.end, state: 'human', everAi: false, facts: [], cites: [], placeholders: [], intentNote: null }));
}
const bibKeys = (bib: string): string[] => [...bib.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)].map((m) => m[1]!);

/** The three selection cuts of docs/definitions.md the canto text states (as the extractor reads them). */
const CUTS: Fact[] = [
  mk({ id: 'f.definitions.pT_gt_1GeV', kind: 'cut', value: 1, unit: 'GeV', artifact: 'docs/definitions.md', locator: 'md:line=60', definition: 'pT > 1 GeV', tags: ['cut', 'cmp:>'] }),
  mk({ id: 'f.definitions.eta_lt_4', kind: 'cut', value: 4, artifact: 'docs/definitions.md', locator: 'md:line=60', definition: '|eta| < 4', tags: ['cut', 'cmp:<'] }),
  mk({ id: 'f.definitions.space_points_ge_5', kind: 'cut', value: 5, artifact: 'docs/definitions.md', locator: 'md:line=60', definition: '>= 5 space points', tags: ['cut', 'cmp:>=', 'count'] }),
];
const CANTO_MAIN = readFileSync(FX('canto-demo/tex/main.tex'), 'utf8');
const CANTO_FACTS = [...loadFacts(FX('canto-demo/repo')), ...CUTS];
const CANTO_BIB = bibKeys(readFileSync(FX('canto-demo/tex/refs.bib'), 'utf8'));
const OK_COMPILE = { state: 'ok' as const, errors: [] };

function canto(p: { text?: string; edit?: (u: ConsistencyUnit) => ConsistencyUnit; extra?: Partial<SubmissionInput> } = {}): SubmissionInput {
  const text = p.text ?? CANTO_MAIN;
  return { mainFile: 'main.tex', files: [{ file: 'main.tex', text }], units: unitsOf('main.tex', text).map(p.edit ?? ((u) => u)), facts: CANTO_FACTS, venue: 'aps', bibKeys: CANTO_BIB, compile: OK_COMPILE, outline: emptyOutline(), ...p.extra };
}
const item = (r: SubmissionReport, id: string) => r.items.find((i) => i.id === id)!;
const failing = (r: SubmissionReport): string[] => r.items.filter((i) => !i.ok).map((i) => i.id);

describe('submissionCheck on fixtures/canto-demo', () => {
  it('the human-written fixture, compiled, is ready; items come in the schema order', () => {
    const r = submissionCheck(canto());
    expect(() => SubmissionReport.parse(r)).not.toThrow();
    expect(r.items.map((i) => i.id)).toEqual(SubmissionItemId.options);
    expect(failing(r)).toEqual([]);
    expect(r).toMatchObject({ ok: true, blockers: 0, warnings: 0 });
    expect(item(r, 'disclosure').note).toMatch(/No AI-assisted sentence/);
    expect(r.items.filter((i) => i.severity === 'block').map((i) => i.id)).toEqual(['unreviewed', 'unsupported', 'placeholders', 'intent_lines', 'cjk', 'merge_conflicts', 'compile_errors', 'undefined_cites', 'ai_unmatched_numbers', 'stale_facts', 'disclosure']);
  });

  it('review state: proposed, unsupported and placeholder sentences block, with their sentence ids', () => {
    const r = submissionCheck(
      canto({
        edit: (u) => (u.text.startsWith('The test set holds') ? { ...u, state: 'proposed', everAi: true } : u.text.startsWith('This lead holds') ? { ...u, state: 'unsupported', everAi: true } : u),
        text: CANTO_MAIN.replace('The principal limitation is', 'The [fact?: limitation of the study] principal limitation is'),
      }),
    );
    expect(r.ok).toBe(false);
    expect(item(r, 'unreviewed').items).toEqual([expect.objectContaining({ file: 'main.tex', sentenceId: expect.stringMatching(/^main\.tex#/), text: expect.stringMatching(/^The test set holds 8,710/) })]);
    expect(item(r, 'unsupported').count).toBe(1);
    expect(item(r, 'placeholders').items[0]!.text).toMatch(/\[fact\?: limitation of the study\]/);
    expect(r.blockers).toBe(4); // + disclosure: AI was used and the fixture has no statement
    expect(failing(r)).toEqual(['unreviewed', 'unsupported', 'placeholders', 'disclosure']);
  });

  it('intent lines, Chinese outside comments and merge markers block; Chinese in a plain comment does not', () => {
    const text = CANTO_MAIN.replace('\\section{Method}', '这里说明选择条件\n\\section{Method}').replace('The test set holds', '测试集 The test set holds').replace('\\appendix', '% 中文注释\n\\appendix');
    const r = submissionCheck(canto({ text }));
    expect(item(r, 'intent_lines').items).toEqual([expect.objectContaining({ line: expect.any(Number), text: expect.stringContaining('这里说明选择条件') })]);
    expect(item(r, 'cjk').items.map((e) => e.text)).toEqual([expect.stringMatching(/^测试集 The test set holds/)]);
    const conflicted = submissionCheck(canto({ text: CANTO_MAIN.replace('\\section{Conclusions}', '<<<<<<< HEAD\n\\section{Conclusions}\n=======\n\\section{Summary}\n>>>>>>> origin') }));
    expect(item(conflicted, 'merge_conflicts').count).toBe(3);
  });

  it('compile: not compiled, running, errors', () => {
    expect(item(submissionCheck(canto({ extra: { compile: null } })), 'compile_errors')).toMatchObject({ ok: false, note: expect.stringMatching(/Not compiled yet/) });
    expect(item(submissionCheck(canto({ extra: { compile: { state: 'running', errors: [] } } })), 'compile_errors').ok).toBe(false);
    const err = submissionCheck(canto({ extra: { compile: { state: 'error', errors: [{ file: 'main.tex', line: 12, message: 'Undefined control sequence.' }] } } }));
    expect(item(err, 'compile_errors').items).toEqual([{ file: 'main.tex', sentenceId: null, line: 12, text: 'Undefined control sequence.' }]);
    expect(err.ok).toBe(false);
  });

  it('citations: a key missing from the .bib blocks; an unresolved key warns', () => {
    const text = CANTO_MAIN.replace('~\\cite{Ju2022Zenodo}', '~\\cite{Ju2022Zenodo,Nobody2020}');
    const lit: LitRecord[] = [{ key: 'Ju2022Zenodo', status: 'resolved', texkey: 'Ju:2022', recid: 1, arxiv: null, doi: null, title: '', authors: '', year: 2022, abstract: null, quotable: [], usableFor: [], source: 'inspire' }];
    const r = submissionCheck(canto({ text, extra: { lit } }));
    expect(item(r, 'undefined_cites').items).toEqual([expect.objectContaining({ text: 'Nobody2020', sentenceId: expect.stringMatching(/^main\.tex#/) })]);
    expect(item(r, 'unresolved_cites').items.map((e) => e.text)).toEqual(['Wang2022LRT']);
    expect(item(r, 'unresolved_cites').severity).toBe('warn');
    expect(failing(r)).toEqual(['undefined_cites', 'unresolved_cites']);
  });

  it('numbers: an unmatched number in an AI-touched sentence blocks, in the authors\' own sentence it warns', () => {
    const text = CANTO_MAIN.replace('The test set holds 8,710 targets.', 'The test set holds 8,711 targets.');
    const human = submissionCheck(canto({ text }));
    expect(item(human, 'unmatched_numbers').items[0]!.text).toMatch(/^"8,711": The test set holds/);
    expect(item(human, 'ai_unmatched_numbers').ok).toBe(true);
    expect(human.ok).toBe(true);
    const ai = submissionCheck(canto({ text, edit: (u) => (u.text.includes('8,711') ? { ...u, state: 'ai-edited', everAi: true } : u) }));
    expect(item(ai, 'ai_unmatched_numbers').count).toBe(1);
    expect(ai.ok).toBe(false);
  });

  it('derived relations ground an AI factor; an ambiguous numeral is reported for the record', () => {
    const text = CANTO_MAIN.replace('This lead holds for every particle species.', 'The baseline makes 2.5 times more fake tracks.').replace('The test set holds 8,710 targets.', 'It finds 97 out of 100 targets.');
    const edit = (u: ConsistencyUnit): ConsistencyUnit => (u.text.includes('2.5 times') ? { ...u, state: 'ai-drafted', everAi: true } : u);
    const r = submissionCheck(canto({ text, edit, extra: { venue: 'arxiv' } }));
    expect(item(r, 'ai_unmatched_numbers').ok).toBe(true);
    expect(item(r, 'ambiguous_numbers')).toMatchObject({ severity: 'info', ok: false, count: 1 });
    expect(item(r, 'disclosure')).toMatchObject({ severity: 'info', ok: true });
    expect(r.ok).toBe(true);
    expect(item(submissionCheck(canto({ text, edit, extra: { derived: [] } })), 'ai_unmatched_numbers').count).toBe(1);
  });

  it('stale facts stated in the text block', () => {
    const facts = CANTO_FACTS.map((f) => (f.id === 'f.g1.n_targets' ? { ...f, stale: true } : f));
    const r = submissionCheck(canto({ extra: { facts } }));
    expect(item(r, 'stale_facts').items).toEqual([expect.objectContaining({ text: expect.stringMatching(/^f\.g1\.n_targets: The test set holds 8,710/) })]);
    expect(r.ok).toBe(false);
  });

  it('disclosure: required when AI was used, found by the venue\'s phrase in the main file (not in a comment)', () => {
    const ai = (u: ConsistencyUnit): ConsistencyUnit => (u.text.startsWith('This lead holds') ? { ...u, state: 'ai-drafted', everAi: true } : u);
    expect(item(submissionCheck(canto({ edit: ai })), 'disclosure')).toMatchObject({ ok: false, severity: 'block', note: expect.stringMatching(/acknowledgments or Methods/) });
    const aps = CANTO_MAIN.replace('\\bibliography{refs}', '\\begin{acknowledgments}\nWe used paper-copilot, a writing tool that calls a large language model, to assist with the text.\n\\end{acknowledgments}\n\\bibliography{refs}');
    expect(item(submissionCheck(canto({ text: aps, edit: ai })), 'disclosure').ok).toBe(true);
    const commented = CANTO_MAIN.replace('\\bibliography{refs}', '% We used a writing tool that calls a large language model.\n\\bibliography{refs}');
    expect(item(submissionCheck(canto({ text: commented, edit: ai })), 'disclosure').ok).toBe(false);
    expect(item(submissionCheck(canto({ text: aps, edit: ai, extra: { venue: 'elsevier' } })), 'disclosure').ok).toBe(false);
    const els = CANTO_MAIN.replace('\\bibliography{refs}', '\\section*{Declaration of generative AI and AI-assisted\ntechnologies in the writing process}\nDuring the preparation of this work the authors used a tool.\n\\bibliography{refs}');
    expect(item(submissionCheck(canto({ text: els, edit: ai, extra: { venue: 'elsevier' } })), 'disclosure').ok).toBe(true);
  });

  it('warnings: echo drift, uncited floats, acronyms before definition, open lint warnings; ok stays true', () => {
    const text = CANTO_MAIN.replace('The fake-track rate is 0.55\\% against', 'The fake-track rate is 0.548\\% against')
      .replace('see Fig.~\\ref{fig:eff}', 'see the figure')
      .replace('Machine-learning pipelines such as Exa.TrkX', 'Machine-learning (ML) pipelines such as Exa.TrkX and a large-radius tracking (LRT)')
      .replace('Searches for long-lived particles look for tracks', 'Searches with LRT look for tracks');
    const lint: LintFlag[] = [
      { id: 'l1', sentenceId: 'main.tex#5', check: 'hype', source: 'style_check', msg: 'novel', word: 'novel', line: 20, excerpt: null, corpusRate: 1.6, userRate: 3, severity: 'warn', dismissed: false },
      { id: 'l2', sentenceId: 'main.tex#6', check: 'vague', source: 'style_check', msg: 'vague', word: null, line: 21, excerpt: null, corpusRate: 0.1, userRate: 1, severity: 'warn', dismissed: true },
      { id: 'l3', sentenceId: 'main.tex#7', check: 'excess_vocab', source: 'aiese', msg: 'delve', word: 'delve', line: 22, excerpt: null, corpusRate: null, userRate: null, severity: 'hint', dismissed: false },
    ];
    const r = submissionCheck(canto({ text, extra: { lintFlags: lint } }));
    expect(failing(r)).toEqual(['echo_drift', 'uncited_floats', 'acronyms_before_definition', 'lint_warnings']);
    expect(r).toMatchObject({ ok: true, blockers: 0, warnings: 4 });
    expect(item(r, 'echo_drift').items[0]!.text).toMatch(/f\.g1\.fake_rate_A is stated with different precision/);
    expect(item(r, 'uncited_floats').items[0]).toMatchObject({ line: expect.any(Number), text: expect.stringMatching(/fig:eff/) });
    expect(item(r, 'acronyms_before_definition').items[0]!.text).toMatch(/^LRT is used before its definition/);
    expect(item(r, 'lint_warnings').items).toEqual([expect.objectContaining({ sentenceId: 'main.tex#5', text: 'hype: novel' })]);
  });

  it('caps the entries per item and keeps the full count', () => {
    const many = Array.from({ length: SUBMISSION_MAX_ENTRIES + 25 }, (_, k) => `笔记第 ${k} 条`).join('\n');
    const r = submissionCheck(canto({ text: CANTO_MAIN.replace('\\section{Method}', `${many}\n\\section{Method}`) }));
    expect(item(r, 'intent_lines')).toMatchObject({ count: SUBMISSION_MAX_ENTRIES + 25 });
    expect(item(r, 'intent_lines').items).toHaveLength(SUBMISSION_MAX_ENTRIES);
  });
});

describe('submissionCheck on fixtures/large-multifile', () => {
  const FILES = ['main.tex', 'sections/intro.tex', 'sections/method.tex', 'sections/results.tex', 'sections/appendix.tex'];
  const texts = FILES.map((f) => ({ file: f, text: readFileSync(FX(`large-multifile/tex/${f}`), 'utf8') }));
  const input: SubmissionInput = {
    mainFile: 'main.tex',
    files: texts,
    units: texts.flatMap((t) => unitsOf(t.file, t.text)),
    facts: loadFacts(FX('large-multifile/repo')),
    venue: 'aps',
    bibKeys: bibKeys(readFileSync(FX('large-multifile/tex/refs.bib'), 'utf8')),
    compile: OK_COMPILE,
  };

  it('a human-written multi-file paper with every citation defined has no blocker, within budget', () => {
    submissionCheck(input);
    const t0 = performance.now();
    const r = submissionCheck(input);
    expect(performance.now() - t0).toBeLessThan(2500 * PERF_SLACK);
    expect(() => SubmissionReport.parse(r)).not.toThrow();
    expect(r.blockers).toBe(0);
    expect(r.ok).toBe(true);
    expect(item(r, 'undefined_cites').ok).toBe(true);
    expect(item(r, 'uncited_floats').ok).toBe(true);
  });

  it('an AI sentence in an \\input file with an invented number blocks, and points at that file', () => {
    const units = input.units.map((u) => (u.file === 'sections/results.tex' && /95\.52/.test(u.text) ? { ...u, text: u.text.replace('95.52', '95.25'), state: 'ai-edited' as const, everAi: true } : u));
    const r = submissionCheck({ ...input, units });
    const ai = item(r, 'ai_unmatched_numbers');
    expect(ai.count).toBeGreaterThan(0);
    expect(ai.items.every((e) => e.file === 'sections/results.tex')).toBe(true);
    expect(failing(r)).toEqual(expect.arrayContaining(['ai_unmatched_numbers', 'disclosure']));
    expect(r.ok).toBe(false);
  });
});
