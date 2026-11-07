import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Bm25Index, ROUTES, hashString, normalizeForHash, segment, styleDistance, styleFeatures, type SentenceUnit } from '@paper-copilot/core';
import { HttpError, type Ctx, type DocService } from '../src/contracts';
import { registerVoiceRoutes } from '../src/routes/voice';
import {
  canonicalSectionType,
  cleanPdfText,
  entrySentences,
  importLatex,
  importMarkdown,
  importPlainText,
  pdfToText,
  pdftotextAvailable,
  splitPlainSentences,
} from '../src/services/voice/corpusText';
import { createVoiceService as createVoiceServiceRaw } from '../src/services/voice/voiceService';

/** Services made by the current test: their background stats.json writes are drained before cleanup. */
const made: Array<ReturnType<typeof createVoiceServiceRaw>> = [];
const createVoiceService = (c: Ctx): ReturnType<typeof createVoiceServiceRaw> => {
  const v = createVoiceServiceRaw(c);
  made.push(v);
  return v;
};
import { FIXTURE, makeTempProject, makeTestCtx, type TempProject } from './helpers/ctx';

function coreMetaReady(): boolean {
  try {
    styleFeatures(['We measure the efficiency of the tracker.']);
    styleDistance(styleFeatures(['a b c d.']), styleFeatures(['e f g h.']));
    new Bm25Index([{ id: 'a', text: 'tracker efficiency' }]).search('tracker', 1);
    return true;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('not implemented')) return false;
    throw e;
  }
}
const META = coreMetaReady();

const FIXTURE_TEX = readFileSync(join(FIXTURE, 'tex', 'main.tex'), 'utf8');

function unitsOf(file: string, text: string, prefix: string): SentenceUnit[] {
  return segment(text).sentences.map((s, i) => ({
    id: `${prefix}${i}`,
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

function fakeDocs(files: Record<string, { text: string; prefix: string }>): DocService {
  const texts = new Map<string, string>();
  const units: SentenceUnit[] = [];
  for (const [f, v] of Object.entries(files)) {
    texts.set(f, v.text);
    units.push(...unitsOf(f, v.text, v.prefix));
  }
  return {
    allUnits: () => units,
    unitText: (id: string) => {
      const u = units.find((x) => x.id === id);
      return u ? texts.get(u.file)!.slice(u.start, u.end) : null;
    },
  } as unknown as DocService;
}

let project: TempProject;
let ctx: Ctx;
beforeEach(async () => {
  project = await makeTempProject();
  ctx = makeTestCtx(project);
});
afterEach(async () => {
  await Promise.all(made.splice(0).map((v) => v.flush?.()));
  project.cleanup();
});

/* ------------------------------------------------------------------------------------ */
/* Text helpers                                                                          */
/* ------------------------------------------------------------------------------------ */

describe('corpus text helpers', () => {
  it('splits plain text like style_check: abbreviations, initials and lower-case continuations do not break', () => {
    expect(splitPlainSentences('We use the method of Ref. 12 and Fig. 3 shows it. The rate is 0.5 vs. 0.7 in data. A. Fixture wrote it. it continues.')).toEqual([
      'We use the method of Ref. 12 and Fig. 3 shows it.',
      'The rate is 0.5 vs. 0.7 in data.',
      'A. Fixture wrote it. it continues.',
    ]);
    expect(splitPlainSentences('The de-\ntector sees\nmany tracks! Is it "fake"? Yes.')).toEqual(['The detector sees many tracks!', 'Is it "fake"?', 'Yes.']);
  });

  it('canonicalizes section types', () => {
    expect(canonicalSectionType('Introduction')).toBe('intro');
    expect(canonicalSectionType('Summary and outlook')).toBe('concl');
    expect(canonicalSectionType('Results')).toBe('results');
    expect(canonicalSectionType('Event selection')).toBe('body');
    expect(canonicalSectionType('')).toBe('other');
    expect(canonicalSectionType('caption')).toBe('caption');
  });

  it('imports LaTeX by section with section types, skipping the preamble, comments and intent lines', () => {
    const rows = importLatex(FIXTURE_TEX, { source: 'canto.tex', unassisted: true });
    const types = rows.map((r) => r.sectionType);
    expect(types).toEqual(expect.arrayContaining(['abstract', 'intro', 'body', 'results', 'caption', 'concl']));
    expect(rows.every((r) => r.unassisted && r.source.startsWith('canto.tex'))).toBe(true);
    expect(rows.map((r) => r.text).join('\n')).not.toMatch(/documentclass|SYNTHETIC TEST FIXTURE/);
    const sents = rows.flatMap((r, i) => entrySentences({ ...r, id: `e${i}` }));
    const results = sents.filter((s) => s.sectionType === 'results').map((s) => s.text);
    expect(results).toContain('The test set holds 8,710 targets.');
    // An explicit section type overrides detection.
    expect(importLatex(FIXTURE_TEX, { source: 'x', unassisted: false, sectionType: 'body' }).every((r) => r.sectionType === 'body')).toBe(true);
  });

  it('imports Markdown per heading and plain text as one entry', () => {
    const md = '# Introduction\n\nWe study **displaced** tracks with [GNNs](http://x).\n\n```py\ncode()\n```\n\n## Results\n\n- The tracker finds `more` targets than the baseline.\n';
    const rows = importMarkdown(md, { source: 'notes.md', unassisted: true });
    expect(rows.map((r) => [r.sectionType, r.text])).toEqual([
      ['intro', 'We study displaced tracks with GNNs.'],
      ['results', 'The tracker finds more targets than the baseline.'],
    ]);
    expect(importPlainText('  a line\nwrapped.\n\n\nNext para.  ', { source: 't.txt', unassisted: false })).toEqual([
      { text: 'a line wrapped.\n\nNext para.', source: 't.txt', sectionType: 'other', unassisted: false },
    ]);
    expect(importPlainText('   ', { source: 't', unassisted: true })).toEqual([]);
  });

  it('cleans pdftotext debris: page numbers, equation fragments, the reference list', () => {
    const raw = 'We measure the efficiency of the tracker on isolated particles in the detector.\n\n12\n\nε = N / N\n\nThe fake-track rate is lower than the rate of the baseline tracker everywhere.\n\nReferences\n\n[1] A. Author, Phys. Rev. D 1 (2020).';
    expect(cleanPdfText(raw)).toBe('We measure the efficiency of the tracker on isolated particles in the detector.\n\nThe fake-track rate is lower than the rate of the baseline tracker everywhere.');
  });
});

const PDFLATEX = !spawnSync('pdflatex', ['--version'], { stdio: 'ignore' }).error;

describe.skipIf(!pdftotextAvailable() || !PDFLATEX)('PDF import via pdftotext', () => {
  it('extracts the prose of a compiled PDF', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdfimp-'));
    try {
      writeFileSync(join(dir, 'a.tex'), '\\documentclass{article}\\begin{document}\nWe measure the efficiency of the tracker on isolated displaced particles in the simulated detector.\n\nThe fake-track rate stays below one percent for every particle species we tested.\n\\end{document}\n');
      execFileSync('pdflatex', ['-interaction=nonstopmode', 'a.tex'], { cwd: dir, stdio: 'ignore' });
      const text = await pdfToText(readFileSync(join(dir, 'a.pdf')));
      expect(text).toContain('We measure the efficiency of the tracker on isolated displaced particles');
      expect(text).toContain('fake-track rate stays below one percent');
      await expect(pdfToText(Buffer.from('not a pdf'))).rejects.toThrow(/not a PDF/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------------------------ */
/* Service: corpus, memo, edit pairs                                                     */
/* ------------------------------------------------------------------------------------ */

describe('VoiceService storage', () => {
  it('adds corpus entries with ulid ids, persists them and toggles unassisted', async () => {
    const voice = createVoiceService(ctx);
    expect(voice.corpus()).toEqual([]);
    const added = await voice.addCorpus([
      { text: 'We study tracks.', source: 'thesis ch.2', sectionType: 'Introduction', unassisted: true },
      { text: '   ', source: 'x', sectionType: 'body', unassisted: true },
      { text: 'Written with help.', source: '', sectionType: 'weird', unassisted: false },
    ]);
    expect(added).toHaveLength(2);
    expect(added[0]!.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(added[0]!.sectionType).toBe('intro');
    expect(added[1]!.source).toBe('manual');
    expect(added[1]!.sectionType).toBe('other');
    const lines = readFileSync(ctx.paths.corpus, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    await voice.setUnassisted(added[1]!.id, true);
    // A new service instance reads the file back.
    const again = createVoiceService(ctx);
    expect(again.corpus().map((e) => e.unassisted)).toEqual([true, true]);
    await expect(again.setUnassisted('nope', true)).rejects.toBeInstanceOf(HttpError);
  });

  it('serializes concurrent appends and rewrites', async () => {
    const voice = createVoiceService(ctx);
    const first = await voice.addCorpus([{ text: 'One.', source: 's', sectionType: 'body', unassisted: false }]);
    await Promise.all([
      voice.addCorpus([{ text: 'Two.', source: 's', sectionType: 'body', unassisted: true }]),
      voice.setUnassisted(first[0]!.id, true),
      voice.addCorpus([{ text: 'Three.', source: 's', sectionType: 'body', unassisted: true }]),
    ]);
    const rows = createVoiceService(ctx).corpus();
    expect(rows.map((r) => r.text).sort()).toEqual(['One.', 'Three.', 'Two.']);
    expect(rows.every((r) => r.unassisted)).toBe(true);
  });

  it('stores the memo and edit pairs', async () => {
    const voice = createVoiceService(ctx);
    expect(voice.memo()).toBe('');
    await voice.setMemo('- verb first (12 pairs)\r\n- no "Moreover"\n');
    expect(voice.memo()).toBe('- verb first (12 pairs)\n- no "Moreover"\n');
    await expect(voice.setMemo('x'.repeat(100_001))).rejects.toBeInstanceOf(HttpError);
    await voice.addEditPairs([
      { sentenceId: 's1', ts: '2026-11-06T00:00:00Z', aiText: 'Moreover, it improves.', humanText: 'It improves by 2.3 points.', instruction: null, sectionType: 'results', grammarOnly: false, editDistance: 0.6 },
      { sentenceId: 's2', ts: '2026-11-06T00:00:00Z', aiText: 'Same.', humanText: 'Same.', instruction: null, sectionType: 'results', grammarOnly: false, editDistance: 0 },
      { sentenceId: 's3' } as never,
    ]);
    expect(voice.editPairs().map((p) => p.sentenceId)).toEqual(['s1']);
  });
});

/* ------------------------------------------------------------------------------------ */
/* Exemplars, norms, distance (need core meta)                                           */
/* ------------------------------------------------------------------------------------ */

const RESULTS_SENTENCES = Array.from({ length: 24 }, (_, i) =>
  i % 3 === 0
    ? `The fake-track rate in bin ${i + 1} is lower than the baseline rate for prompt tracks.`
    : `The efficiency in bin ${i + 1} rises with the transverse displacement of the particle.`,
);

describe.skipIf(!META)('VoiceService exemplars, norms and style distance (core meta)', () => {
  it('retrieves exemplars by BM25 from UNASSISTED text only, restricted to a section type with >= 20 sentences', async () => {
    const voice = createVoiceService(ctx);
    await voice.addCorpus([
      { text: RESULTS_SENTENCES.join(' '), source: 'ldmx note', sectionType: 'results', unassisted: true },
      { text: 'Long-lived particles leave tracks that start far from the beam line. Fake tracks are rare in the introduction text.', source: 'thesis', sectionType: 'intro', unassisted: true },
      { text: 'The fake-track rate of our novel approach is dramatically lower than every baseline in all bins.', source: 'ai draft', sectionType: 'results', unassisted: false },
    ]);
    const ex = voice.exemplars('results', 'fake-track rate baseline', 4);
    expect(ex).toHaveLength(4);
    for (const s of ex) expect(s).toMatch(/fake-track rate in bin \d+ is lower than the baseline/);
    expect(ex.join(' ')).not.toMatch(/novel|dramatically/);
    expect(ex.join(' ')).not.toMatch(/introduction text/); // restricted to results (24 sentences)
    // intro has only 2 sentences: not restricted, so results sentences can also come back.
    const intro = voice.exemplars('intro', 'fake tracks rate', 3);
    expect(intro.length).toBe(3);
    expect(intro.some((s) => /introduction text/.test(s))).toBe(true);
    expect(intro.some((s) => /bin \d+/.test(s))).toBe(true);
    // No lexical match: filled with same-type sentences; k = 0 -> none.
    expect(voice.exemplars('results', 'zzzz qqqq', 2)).toHaveLength(2);
    expect(voice.exemplars('results', 'fake', 0)).toEqual([]);
  });

  it('measures author norms over unassisted sentences, caches them in stats.json and invalidates on change', async () => {
    const voice = createVoiceService(ctx);
    expect(voice.authorNorms()).toBeNull();
    expect(voice.authorNormsTable()).toMatch(/No unassisted author corpus yet/);
    const rows = importLatex(FIXTURE_TEX, { source: 'fixture.tex', unassisted: true });
    await voice.addCorpus(rows);
    const norms = voice.authorNorms()!;
    expect(norms.n).toBeGreaterThan(15);
    expect(norms.medianLen).toBeGreaterThan(5);
    let stats = { sentences: -1, author: { medianLen: -1 } };
    for (let i = 0; i < 100 && stats.sentences !== norms.n; i++) {
      await new Promise((r) => setTimeout(r, 10));
      try {
        stats = JSON.parse(readFileSync(ctx.paths.voiceStats, 'utf8'));
      } catch {
        /* not written yet */
      }
    }
    expect(stats.sentences).toBe(norms.n);
    expect(stats.author.medianLen).toBe(norms.medianLen);
    const table = voice.authorNormsTable();
    expect(table).toMatch(/\| feature \| author \| corpus \|/);
    expect(table).toMatch(/median sentence length \(words\) \| \d+ \| 23 \|/);
    // A fresh instance uses the cache (same fingerprint).
    expect(createVoiceService(ctx).authorNorms()!.n).toBe(norms.n);
    // Assisted text never changes the norms; marking it unassisted does.
    const [extra] = await voice.addCorpus([{ text: RESULTS_SENTENCES.join(' '), source: 'x', sectionType: 'results', unassisted: false }]);
    expect(voice.authorNorms()!.n).toBe(norms.n);
    await voice.setUnassisted(extra!.id, true);
    expect(voice.authorNorms()!.n).toBe(norms.n + RESULTS_SENTENCES.length);
  });

  it('style distance: an AI-flavoured paragraph is further from the author than the author prose, and is named as furthest', async () => {
    const voice0 = createVoiceService(ctx);
    await voice0.addCorpus(importLatex(FIXTURE_TEX, { source: 'fixture.tex', unassisted: true }));
    const aiPara = [
      'Moreover, it is worth noting that our novel approach plays a crucial role in significantly enhancing the overall tracking performance across a wide range of challenging scenarios.',
      'Furthermore, by leveraging cutting-edge graph neural network architectures, we delve into the intricate landscape of displaced-particle reconstruction and showcase remarkable, robust and unprecedented improvements.',
      'Additionally, this comprehensive framework not only underscores the pivotal importance of signal-agnostic training but also paves the way for transformative advances in the realm of long-lived particle searches.',
    ].join('\n');
    const aiDoc = `\\begin{document}\n\\section{Results}\n${aiPara}\n\\end{document}\n`;
    (ctx as { docs: DocService }).docs = fakeDocs({ 'main.tex': { text: FIXTURE_TEX, prefix: 'h' }, 'ai.tex': { text: aiDoc, prefix: 'a' } });
    const voice = createVoiceService(ctx);
    const human = voice.styleDistance('section', 'sec:results');
    expect(human.scope).toBe('section:sec:results');
    // Both files have a sec:results section; select the files with the document scope instead.
    const fixtureDoc = voice.styleDistance('document', 'main.tex');
    const aiOnly = voice.styleDistance('document', 'ai.tex');
    expect(fixtureDoc.toAuthor).not.toBeNull();
    expect(aiOnly.toAuthor!).toBeGreaterThan(fixtureDoc.toAuthor!);
    expect(aiOnly.toCorpus).toBeGreaterThan(fixtureDoc.toCorpus);
    expect(aiOnly.corpusSize).toBeGreaterThan(15);
    expect(aiOnly.authorFeatures).not.toBeNull();
    expect(aiOnly.corpusFeatures.medianLen).toBe(23);
    // In the mixed document, the furthest sentences are the AI ones.
    const all = voice.styleDistance('document');
    expect(all.furthest.length).toBeGreaterThan(0);
    expect(all.furthest[0]!.sentenceId.startsWith('a')).toBe(true);
    expect(all.furthest[0]!.why.length).toBeGreaterThan(0);
    expect(() => voice.styleDistance('section')).toThrow(HttpError);
    expect(() => voice.styleDistance('paragraph', 'nope/p9')).toThrow(HttpError);
  });

  it('without an author corpus: toAuthor is null and the corpus norms are the target', () => {
    (ctx as { docs: DocService }).docs = fakeDocs({ 'main.tex': { text: FIXTURE_TEX, prefix: 'h' } });
    const r = createVoiceService(ctx).styleDistance('document');
    expect(r.toAuthor).toBeNull();
    expect(r.authorFeatures).toBeNull();
    expect(r.corpusSize).toBe(0);
    expect(r.toCorpus).toBeGreaterThanOrEqual(0);
  });
});

/* ------------------------------------------------------------------------------------ */
/* Routes                                                                                */
/* ------------------------------------------------------------------------------------ */

describe('voice routes', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  async function build(c: Ctx) {
    const a = Fastify();
    a.setErrorHandler((err, _req, reply) => {
      if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
      return reply.status(500).send({ error: String(err) });
    });
    registerVoiceRoutes(a, c);
    await a.ready();
    return a;
  }

  it('GET /api/voice, PUT memo, POST corpus (entries and imports), PATCH unassisted', async () => {
    const voice = createVoiceService(ctx);
    (ctx as { voice: typeof voice }).voice = voice;
    app = await build(ctx);
    const put = await app.inject({ method: 'PUT', url: ROUTES.voiceMemo, payload: { text: '- verb first' } });
    expect(put.json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'PUT', url: ROUTES.voiceMemo, payload: { text: 3 } })).statusCode).toBe(400);
    const post = await app.inject({ method: 'POST', url: ROUTES.voiceCorpus, payload: { entries: [{ text: 'We study tracks.', source: 'thesis', sectionType: 'intro', unassisted: true }] } });
    expect(post.statusCode).toBe(200);
    const [entry] = post.json().entries;
    expect(entry.id).toBeTruthy();
    const imp = await app.inject({ method: 'POST', url: ROUTES.voiceCorpus, payload: { import: { format: 'tex', text: FIXTURE_TEX, source: 'fixture.tex', unassisted: false } } });
    expect(imp.statusCode).toBe(200);
    expect(imp.json().entries.length).toBeGreaterThan(3);
    expect((await app.inject({ method: 'POST', url: ROUTES.voiceCorpus, payload: { import: { format: 'txt', text: '   ', source: 'x' } } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: ROUTES.voiceCorpus, payload: { import: { format: 'pdf', source: 'x' } } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: ROUTES.voiceCorpus, payload: { bogus: 1 } })).statusCode).toBe(400);
    const patch = await app.inject({ method: 'PATCH', url: `${ROUTES.voiceCorpus}/${entry.id}`, payload: { unassisted: false } });
    expect(patch.json()).toMatchObject({ id: entry.id, unassisted: false });
    expect((await app.inject({ method: 'PATCH', url: `${ROUTES.voiceCorpus}/nope`, payload: { unassisted: false } })).statusCode).toBe(404);
    const get = await app.inject({ method: 'GET', url: ROUTES.voice });
    const body = get.json();
    expect(body.memo).toBe('- verb first');
    expect(body.corpus.length).toBeGreaterThan(4);
    expect(body.editPairs).toEqual([]);
    expect(body.corpusNorms.medianLen).toBe(23);
    expect(typeof body.tools.pdftotext).toBe('boolean');
  });

  it.skipIf(!pdftotextAvailable() || !PDFLATEX)('imports a PDF uploaded as base64', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdfr-'));
    try {
      writeFileSync(join(dir, 'a.tex'), '\\documentclass{article}\\begin{document}\nWe measure the efficiency of the tracker on isolated displaced particles in the simulated detector.\n\\end{document}\n');
      execFileSync('pdflatex', ['-interaction=nonstopmode', 'a.tex'], { cwd: dir, stdio: 'ignore' });
      (ctx as { voice: ReturnType<typeof createVoiceService> }).voice = createVoiceService(ctx);
      app = await build(ctx);
      const r = await app.inject({ method: 'POST', url: ROUTES.voiceCorpus, payload: { import: { format: 'pdf', dataBase64: readFileSync(join(dir, 'a.pdf')).toString('base64'), source: 'thesis.pdf', sectionType: 'body', unassisted: true } } });
      expect(r.statusCode).toBe(200);
      expect(r.json().entries[0]).toMatchObject({ source: 'thesis.pdf', sectionType: 'body', unassisted: true });
      expect(r.json().entries[0].text).toContain('efficiency of the tracker');
      const bad = await app.inject({ method: 'POST', url: ROUTES.voiceCorpus, payload: { import: { format: 'pdf', dataBase64: Buffer.from('hello').toString('base64'), source: 'x' } } });
      expect(bad.statusCode).toBe(422);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!META)('GET /api/style/distance validates the scope', async () => {
    (ctx as { docs: DocService }).docs = fakeDocs({ 'main.tex': { text: FIXTURE_TEX, prefix: 'h' } });
    (ctx as { voice: ReturnType<typeof createVoiceService> }).voice = createVoiceService(ctx);
    app = await build(ctx);
    const r = await app.inject({ method: 'GET', url: `${ROUTES.styleDistance}?scope=document` });
    expect(r.statusCode).toBe(200);
    expect(r.json().scope).toBe('document');
    expect((await app.inject({ method: 'GET', url: `${ROUTES.styleDistance}?scope=chapter` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `${ROUTES.styleDistance}?scope=section` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `${ROUTES.styleDistance}?scope=section&id=sec:results` })).statusCode).toBe(200);
  });
});


