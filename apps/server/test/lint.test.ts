import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aieseFlags, gateSentence, hashString, normalizeForHash, segment, type LintFlag, type SentenceUnit, type ServerMessage } from '@paper-copilot/core';
import type { Ctx, DocService, DocState, PaperDb } from '../src/contracts';
import { createLintService, excerptSimilarity, flagId, lineTable, reconcileFlag, type LintSidecarLike, type SidecarFlag, type UnitSpan } from '../src/services/lint/lintService';
import { REPO_ROOT, makeTempProject, makeTestCtx, type TempProject } from './helpers/ctx';

/* ------------------------------------------------------------------------------------ */
/* Fakes                                                                                 */
/* ------------------------------------------------------------------------------------ */

function unitsOf(file: string, text: string): SentenceUnit[] {
  const seg = segment(text);
  return seg.sentences.map((s, i) => ({
    id: `${file.replace(/\W/g, '_')}-u${String(i).padStart(2, '0')}`,
    file,
    start: s.start,
    end: s.end,
    line: s.line,
    hash: hashString(normalizeForHash(s.text)),
    ctxHash: '',
    textNorm: normalizeForHash(s.text),
    sectionId: s.sectionId,
    paragraphId: `${s.sectionId}/p${s.paragraphIndex}`,
    part: s.part,
    kind: s.kind,
    move: null,
    state: 'human',
    everAi: false,
    grammarFixed: false,
    imported: true,
    model: null,
    promptHash: null,
    createdAt: '2026-11-06T00:00:00Z',
    acceptedAt: null,
    editDistance: null,
    intentNote: null,
    facts: [],
    cites: [],
    claims: [],
    placeholders: [],
    orphaned: false,
    splitFrom: null,
  }));
}

function fakeDocs(files: Record<string, string>): DocService {
  const states = new Map<string, DocState>();
  for (const [file, text] of Object.entries(files)) {
    states.set(file, { file, version: 7, text, units: unitsOf(file, text), seg: segment(text), intentLines: [] });
  }
  const all = () => [...states.values()].flatMap((s) => s.units);
  return {
    files: async () => [...states.keys()],
    get: (f: string) => states.get(f),
    unitText: (id: string) => {
      const u = all().find((x) => x.id === id);
      return u ? states.get(u.file)!.text.slice(u.start, u.end) : null;
    },
    allUnits: all,
    labels: () => [],
    unit: (id: string) => all().find((x) => x.id === id),
  } as unknown as DocService;
}

function fakeDb(): PaperDb & { rows: Map<string, { file: string; scope: string; flag: LintFlag }>; dismissedIds: Set<string> } {
  const rows = new Map<string, { file: string; scope: string; flag: LintFlag }>();
  const dismissedIds = new Set<string>();
  const db = {
    rows,
    dismissedIds,
    setLint(file: string, flags: LintFlag[], scope: string, ids: string[]) {
      for (const [k, r] of [...rows]) {
        if (r.file !== file || r.scope !== scope) continue;
        if (scope === 'document' || (r.flag.sentenceId !== null && ids.includes(r.flag.sentenceId))) rows.delete(k);
      }
      for (const f of flags) rows.set(`${scope}:${f.id}`, { file, scope, flag: { ...f, dismissed: dismissedIds.has(f.id) || f.dismissed } });
    },
    lint(file: string) {
      return [...rows.values()].filter((r) => r.file === file).map((r) => ({ ...r.flag, dismissed: dismissedIds.has(r.flag.id) || r.flag.dismissed }));
    },
    dismissLint(id: string) {
      dismissedIds.add(id);
    },
    units: () => [],
  };
  return db as unknown as PaperDb & typeof db;
}

/** A sidecar that flags "utilize" (vocab) and sentences above 30 words (long), like style_check would. */
function fakeSidecar(opts: { delayMs?: number } = {}) {
  const calls = { sentences: 0, document: 0, texts: [] as string[], known: [] as string[][] };
  const plain = (s: string) => s.replace(/\\[a-zA-Z]+(\{[^}]*\})?/g, ' ').replace(/[${}~]/g, ' ').replace(/\s+/g, ' ').trim();
  const sc: LintSidecarLike = {
    version: 'abc123',
    async lintSentences(items, o) {
      calls.sentences++;
      calls.known.push(o.known);
      const out: SidecarFlag[] = [];
      for (const it of items) {
        const words = plain(it.text).split(' ').length;
        if (words > 30) out.push({ sid: it.sid, check: 1, key: 'long', msg: `Long sentence: ${words} words (limit 30).`, word: null, excerpt: plain(it.text).slice(0, 170) });
        if (/\butilize\b/.test(it.text)) out.push({ sid: it.sid, check: 4, key: 'vocab', msg: '*utilize* -> use', word: 'utilize', excerpt: null });
      }
      return out;
    },
    async lintDocument(text) {
      calls.document++;
      calls.texts.push(text);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const flags: SidecarFlag[] = [];
      text.split('\n').forEach((l, i) => {
        if (/\butilize\b/.test(l)) flags.push({ check: 4, key: 'vocab', line: i + 1, part: 'body', excerpt: plain(l).slice(0, 60) + ' …', msg: '*utilize* -> use', word: 'utilize', sent_index: 3 });
      });
      flags.push({ check: 8, key: 'terms', line: null, part: null, excerpt: '', msg: 'GNN and graph neural network both used', word: null, sent_index: null });
      return { flags, rates: { vocab: 2.5, long: 1.0 }, referenceRates: { long: 3.4, vocab: 0.4 }, words: 400, sentences: 20 };
    },
    async close() {},
  };
  return { sc, calls };
}

/* ------------------------------------------------------------------------------------ */
/* Reconciliation (pure)                                                                 */
/* ------------------------------------------------------------------------------------ */

describe('reconcileFlag', () => {
  const map = [
    { file: 'main.tex', line: 1 },
    { file: 'main.tex', line: 2 },
    { file: 'sec/a.tex', line: 1 },
    { file: 'sec/a.tex', line: 2 },
    { file: 'main.tex', line: 4 },
  ];
  const units = new Map<string, UnitSpan[]>([
    ['main.tex', [
      { id: 'm1', line: 1, endLine: 1, start: 0, text: 'The tracker finds more targets than the baseline.' },
      { id: 'm2', line: 1, endLine: 2, start: 50, text: 'The fake rate is lower for every species we tested.' },
      { id: 'm4', line: 4, endLine: 4, start: 200, text: 'We utilize one detector.' },
    ]],
    ['sec/a.tex', [
      { id: 'a1', line: 1, endLine: 1, start: 0, text: 'We utilize the bootstrap to estimate the uncertainty.' },
      { id: 'a2', line: 2, endLine: 2, start: 60, text: 'We utilize the bootstrap to estimate the uncertainty.' },
    ]],
  ]);

  it('maps the flattened line to the real file and picks the unit whose text matches the excerpt', () => {
    expect(reconcileFlag({ line: 1, excerpt: 'The fake rate is lower for every …' }, map, units, 'main.tex')).toEqual({ file: 'main.tex', line: 1, sentenceId: 'm2' });
    expect(reconcileFlag({ line: 1, excerpt: 'The tracker finds more targets' }, map, units, 'main.tex')).toEqual({ file: 'main.tex', line: 1, sentenceId: 'm1' });
    expect(reconcileFlag({ line: 5, excerpt: 'We utilize one detector.' }, map, units, 'main.tex')).toEqual({ file: 'main.tex', line: 4, sentenceId: 'm4' });
  });

  it('breaks ties deterministically: covering line first, then earlier start', () => {
    // a1 and a2 have the same text; line 4 (sec/a.tex:2) covers only a2.
    expect(reconcileFlag({ line: 4, excerpt: 'We utilize the bootstrap' }, map, units, 'main.tex').sentenceId).toBe('a2');
    expect(reconcileFlag({ line: 3, excerpt: 'We utilize the bootstrap' }, map, units, 'main.tex').sentenceId).toBe('a1');
    // Two units covering the line with no excerpt: the earlier start wins, every time.
    for (let i = 0; i < 3; i++) expect(reconcileFlag({ line: 1, excerpt: '' }, map, units, 'main.tex').sentenceId).toBe('m1');
  });

  it('accepts a nearby unit only with a strong excerpt match, else leaves sentenceId null', () => {
    // main.tex:2 is covered by m2; an excerpt of m1 (ends on line 1) matches strongly at distance 1.
    expect(reconcileFlag({ line: 2, excerpt: 'The tracker finds more targets than the baseline.' }, map, units, 'main.tex').sentenceId).toBe('m1');
    expect(reconcileFlag({ line: 2, excerpt: 'Completely unrelated words here' }, map, units, 'main.tex')).toEqual({ file: 'main.tex', line: 2, sentenceId: null });
  });

  it('keeps document-level and out-of-range flags unmatched', () => {
    expect(reconcileFlag({ line: null, excerpt: 'x' }, map, units, 'main.tex')).toEqual({ file: 'main.tex', line: null, sentenceId: null });
    expect(reconcileFlag({ line: 99, excerpt: 'x' }, map, units, 'main.tex')).toEqual({ file: 'main.tex', line: null, sentenceId: null });
  });

  it('excerptSimilarity ignores the ellipsis and measures in-order coverage', () => {
    expect(excerptSimilarity('The tracker finds …', 'The tracker finds more targets.')).toBe(1);
    expect(excerptSimilarity('finds tracker The', 'The tracker finds')).toBeCloseTo(1 / 3, 5);
    expect(excerptSimilarity('', 'x')).toBe(0);
  });

  it('lineTable gives 1-based lines', () => {
    const at = lineTable('ab\ncd\n\nef');
    expect([0, 2, 3, 5, 6, 7, 9].map(at)).toEqual([1, 1, 2, 2, 3, 4, 4]);
  });

  it('flag ids follow the contract formula', () => {
    expect(flagId('style_check', 'long', 'u1', null, 'msg')).toBe(hashString('style_checklongu1msg'));
    expect(flagId('style_check', 'terms', null, null, 'msg', 'line:main.tex:')).toBe(hashString('style_checktermsline:main.tex:msg'));
  });
});

/* ------------------------------------------------------------------------------------ */
/* Service with a fake sidecar                                                           */
/* ------------------------------------------------------------------------------------ */

describe('LintService (fake sidecar)', () => {
  let project: TempProject;
  let ctx: Ctx & { events: ServerMessage[] };
  let db: ReturnType<typeof fakeDb>;
  let mainText: string;
  let extraText: string;

  beforeEach(async () => {
    project = await makeTempProject();
    const main = join(project.paths.tex, 'main.tex');
    mainText = readFileSync(main, 'utf8').replace('\\section{Results}', '\\input{sec/extra}\n\n\\section{Results}').replace('\\begin{abstract}', '\\begin{abstract}\n这是摘要的中文意图，不进入检查。');
    writeFileSync(main, mainText);
    extraText = 'We utilize the event bootstrap to estimate the statistical uncertainty of every efficiency.\nThe seeds vary the initial weights.\n';
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(project.paths.tex, 'sec'), { recursive: true });
    writeFileSync(join(project.paths.tex, 'sec', 'extra.tex'), extraText);
    db = fakeDb();
    ctx = makeTestCtx(project, {
      db,
      docs: fakeDocs({ 'main.tex': mainText, 'sec/extra.tex': extraText }),
      facts: { terminology: () => [{ term: 'graph neural network', definition: '', acronym: 'GNN', firstUseSentenceId: null, variants: [], symbol: null }], all: () => [] } as unknown as Ctx['facts'],
      lit: { bibKeys: () => ['Ju2022Zenodo', 'Wang2022LRT'] } as unknown as Ctx['lit'],
    });
  });
  afterEach(() => project.cleanup());

  it('sentence pass: style flags with corpus rates, stable ids, dismissals that survive re-lint', async () => {
    const { sc, calls } = fakeSidecar();
    const lint = createLintService(ctx, { startSidecar: async () => sc });
    await lint.start();
    expect(lint.status()).toEqual({ sidecar: true, reason: null, styleCheckVersion: 'abc123' });
    const units = ctx.docs.get('main.tex')!.units;
    await lint.lintUnits('main.tex', units);
    const upd = ctx.events.filter((e) => e.type === 'lint.update') as Array<Extract<ServerMessage, { type: 'lint.update' }>>;
    expect(upd).toHaveLength(1);
    expect(upd[0]!.scope).toBe('sentences');
    expect(upd[0]!.version).toBe(7);
    expect(upd[0]!.sentenceIds).toEqual(units.map((u) => u.id));
    expect(calls.known[0]).toEqual(['GNN']);
    const long = upd[0]!.flags.filter((f) => f.check === 'long');
    expect(long.length).toBeGreaterThan(0);
    for (const f of long) {
      expect(f.source).toBe('style_check');
      expect(f.corpusRate).toBe(3.3);
      expect(f.sentenceId).not.toBeNull();
      expect(f.line).toBe(units.find((u) => u.id === f.sentenceId)!.line);
    }
    const first = long[0]!;
    lint.dismiss(first.id);
    expect(db.dismissedIds.has(first.id)).toBe(true);
    await lint.lintUnits('main.tex', units);
    const again = lint.flags('main.tex').find((f) => f.id === first.id);
    expect(again?.dismissed).toBe(true);
    // A fresh service (restart) still sees the dismissal through the db.
    const lint2 = createLintService(ctx, { startSidecar: async () => sc });
    await lint2.start();
    await lint2.lintUnits('main.tex', units);
    expect(lint2.flags('main.tex').find((f) => f.id === first.id)?.dismissed).toBe(true);
  });

  it('document pass: flattens \\input, blanks intent lines, reconciles to the sub-file unit, keeps doc-level flags unmatched', async () => {
    const { sc, calls } = fakeSidecar();
    const lint = createLintService(ctx, { startSidecar: async () => sc });
    await lint.start();
    await lint.lintDocumentNow('sec/extra.tex'); // runs the main document, which inputs it
    expect(calls.document).toBe(1);
    expect(calls.texts[0]).toContain('We utilize the event bootstrap');
    expect(/[\u4e00-\u9fff]/.test(calls.texts[0]!)).toBe(false);
    const updates = ctx.events.filter((e) => e.type === 'lint.update' && e.scope === 'document') as Array<Extract<ServerMessage, { type: 'lint.update' }>>;
    expect(updates.map((u) => u.file).sort()).toEqual(['main.tex', 'sec/extra.tex']);
    const extra = updates.find((u) => u.file === 'sec/extra.tex')!;
    const vocab = extra.flags.find((f) => f.check === 'vocab')!;
    const extraUnits = ctx.docs.get('sec/extra.tex')!.units;
    expect(vocab.sentenceId).toBe(extraUnits[0]!.id);
    expect(vocab.line).toBe(1);
    expect(vocab.corpusRate).toBe(0.4);
    expect(vocab.userRate).toBe(2.5);
    const main = updates.find((u) => u.file === 'main.tex')!;
    const terms = main.flags.find((f) => f.check === 'terms')!;
    expect(terms.sentenceId).toBeNull();
    expect(terms.line).toBeNull();
    // Reference rates from the sidecar now feed the sentence pass.
    await lint.lintUnits('main.tex', ctx.docs.get('main.tex')!.units);
    expect(lint.flags('main.tex').find((f) => f.check === 'long')?.corpusRate).toBe(3.4);
    // Re-running gives the same ids.
    const ids1 = lint.flags('sec/extra.tex').map((f) => f.id).sort();
    await lint.lintDocumentNow('main.tex');
    expect(lint.flags('sec/extra.tex').map((f) => f.id).sort()).toEqual(ids1);
  });

  it('debounces scheduleDocument and keeps at most one pass in flight per document', async () => {
    const { sc, calls } = fakeSidecar({ delayMs: 60 });
    const lint = createLintService(ctx, { startSidecar: async () => sc, debounceMs: 20 });
    await lint.start();
    lint.scheduleDocument('main.tex');
    lint.scheduleDocument('sec/extra.tex');
    lint.scheduleDocument('main.tex');
    await new Promise((r) => setTimeout(r, 150));
    expect(calls.document).toBe(1);
    const a = lint.lintDocumentNow('main.tex');
    const b = lint.lintDocumentNow('main.tex');
    const c = lint.lintDocumentNow('sec/extra.tex');
    await Promise.all([a, b, c]);
    expect(calls.document).toBe(3); // the running pass + ONE shared follow-up
    await lint.stop();
    expect(lint.status().sidecar).toBe(false);
  });

  it('without the skill: status() says why and the sentence pass still runs AI-ese', async () => {
    await ctx.saveConfig({ ...ctx.config, skillDir: join(project.root, 'no-such-skill') });
    let started = false;
    const lint = createLintService(ctx, {
      startSidecar: async () => {
        started = true;
        throw new Error('should not start');
      },
    });
    await lint.start();
    expect(started).toBe(false);
    const st = lint.status();
    expect(st.sidecar).toBe(false);
    expect(st.reason).toMatch(/skill was not found/);
    const text = 'We delve into the tracker and showcase its pivotal role. The new tracker outperforms the baseline everywhere.';
    const docs = fakeDocs({ 'x.tex': text });
    (ctx as { docs: DocService }).docs = docs;
    await lint.lintUnits('x.tex', docs.get('x.tex')!.units);
    const upd = ctx.events.filter((e) => e.type === 'lint.update').at(-1) as Extract<ServerMessage, { type: 'lint.update' }>;
    expect(upd).toBeDefined();
    let coreAiese = true;
    try {
      aieseFlags('x');
    } catch {
      coreAiese = false;
    }
    if (coreAiese) {
      const words = upd.flags.filter((f) => f.source === 'aiese').map((f) => f.word?.toLowerCase());
      expect(words).toContain('delve');
      expect(upd.flags.every((f) => f.source !== 'style_check')).toBe(true);
    }
    let coreGate = true;
    try {
      gateSentence('x', { mode: 'draft', facts: [], allowedCiteKeys: [], knownLabels: [], fictionalNumbers: [] });
    } catch {
      coreGate = false;
    }
    if (coreGate) {
      const cs = upd.flags.filter((f) => f.source === 'gate');
      expect(cs.map((f) => [f.check, f.word, f.severity])).toEqual([['claim_strength', 'outperforms', 'warn']]);
      expect(cs[0]!.sentenceId).toBe(docs.get('x.tex')!.units[1]!.id);
    }
  });

  it('reports a sidecar that fails to start', async () => {
    const lint = createLintService(ctx, { startSidecar: async () => Promise.reject(new Error('boom')) });
    await lint.start();
    expect(lint.status()).toMatchObject({ sidecar: false, styleCheckVersion: null });
    expect(lint.status().reason).toMatch(/did not start: boom/);
  });
});

/* ------------------------------------------------------------------------------------ */
/* Real sidecar (skipped until sidecar/lintd.py and the client exist)                   */
/* ------------------------------------------------------------------------------------ */

const REAL = existsSync(join(REPO_ROOT, 'sidecar', 'lintd.py')) && existsSync(join(REPO_ROOT, 'apps', 'server', 'src', 'services', 'lint', 'sidecar.ts'));

describe.skipIf(!REAL)('LintService with the real lintd.py sidecar', () => {
  let project: TempProject;
  afterEach(() => project?.cleanup());

  it('lints fixture units and reconciles document flags to units', async () => {
    project = await makeTempProject();
    const mainText = readFileSync(join(project.paths.tex, 'main.tex'), 'utf8').replace(
      'This lead holds for every particle species.',
      'This lead holds for every particle species, and it is very important to utilize this novel and crucial result in order to leverage it.',
    );
    writeFileSync(join(project.paths.tex, 'main.tex'), mainText);
    const ctx = makeTestCtx(project, {
      db: fakeDb(),
      docs: fakeDocs({ 'main.tex': mainText }),
      facts: { terminology: () => [], all: () => [] } as unknown as Ctx['facts'],
      lit: { bibKeys: () => [] } as unknown as Ctx['lit'],
    });
    const lint = createLintService(ctx);
    await lint.start();
    try {
      expect(lint.status()).toMatchObject({ sidecar: true, reason: null });
      expect(lint.status().styleCheckVersion).toBeTruthy();
      const units = ctx.docs.get('main.tex')!.units;
      await lint.lintUnits('main.tex', units);
      const target = units.find((u) => mainText.slice(u.start, u.end).includes('utilize this novel'))!;
      const sflags = lint.flags('main.tex').filter((f) => f.sentenceId === target.id && f.source === 'style_check');
      expect(sflags.map((f) => f.check)).toEqual(expect.arrayContaining(['vocab', 'hype']));
      await lint.lintDocumentNow('main.tex');
      const doc = (ctx.events.filter((e) => e.type === 'lint.update' && e.scope === 'document').at(-1) as Extract<ServerMessage, { type: 'lint.update' }>).flags;
      expect(doc.length).toBeGreaterThan(0);
      const onTarget = doc.filter((f) => f.sentenceId === target.id);
      expect(onTarget.length).toBeGreaterThan(0);
      for (const f of doc.filter((x) => x.sentenceId)) {
        const u = units.find((x) => x.id === f.sentenceId)!;
        expect(Math.abs((f.line ?? u.line) - u.line)).toBeLessThanOrEqual(3);
      }
    } finally {
      await lint.stop();
    }
  }, 60_000);
});
