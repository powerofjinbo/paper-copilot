/**
 * Voice routes.
 *
 *   GET   /api/voice                     -> { memo, corpus, editPairs, authorNorms, corpusNorms, normsTable, tools }
 *   PUT   /api/voice/memo   { text }     -> { ok: true }
 *   POST  /api/voice/corpus              -> { entries: CorpusEntry[] }
 *         body { entries: [{ text, source, sectionType, unassisted }] }
 *           or { import: { format: 'txt'|'md'|'tex'|'pdf', text?, dataBase64?, source, sectionType?, unassisted } }
 *         (a PDF is uploaded as base64 and converted with pdftotext; no server-side path is ever read)
 *   PATCH /api/voice/corpus/:id { unassisted } -> CorpusEntry
 *   GET   /api/style/distance?scope=document|section|paragraph&id= -> StyleDistanceResponse
 */
import type { FastifyInstance } from 'fastify';
import { ROUTES, SKILL_CORPUS_NORMS } from '@paper-copilot/core';
import { z } from 'zod';
import { HttpError, type Ctx } from '../contracts';
import { importLatex, importMarkdown, importPlainText, pdfToText, pdftotextAvailable } from '../services/voice/corpusText';

const MAX_TEXT = 5_000_000;
/** Base64 of a 40 MB PDF. */
const MAX_B64 = 56_000_000;

const EntryIn = z.object({
  text: z.string().max(MAX_TEXT),
  source: z.string().max(500).default('manual'),
  sectionType: z.string().max(40).default('other'),
  unassisted: z.boolean().default(false),
});

const ImportIn = z.object({
  format: z.enum(['txt', 'md', 'tex', 'pdf']),
  text: z.string().max(MAX_TEXT).optional(),
  dataBase64: z.string().max(MAX_B64).optional(),
  source: z.string().max(500).default('import'),
  sectionType: z.string().max(40).nullable().optional(),
  unassisted: z.boolean().default(false),
});

const CorpusBody = z.union([z.object({ entries: z.array(EntryIn).max(10_000) }), z.object({ import: ImportIn })]);
const MemoBody = z.object({ text: z.string().max(100_000) });
const PatchBody = z.object({ unassisted: z.boolean() });
const DistanceQuery = z.object({ scope: z.enum(['document', 'section', 'paragraph']).default('document'), id: z.string().max(500).optional() });

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw new HttpError(400, `invalid ${what}: ${r.error.issues.map((i) => `${i.path.join('.') || what}: ${i.message}`).join('; ')}`);
  return r.data;
}

export function registerVoiceRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get(ROUTES.voice, async () => ({
    memo: ctx.voice.memo(),
    corpus: ctx.voice.corpus(),
    editPairs: ctx.voice.editPairs(),
    authorNorms: ctx.voice.authorNorms(),
    corpusNorms: SKILL_CORPUS_NORMS,
    normsTable: ctx.voice.authorNormsTable(),
    tools: { pdftotext: pdftotextAvailable() },
  }));

  app.put(ROUTES.voiceMemo, async (req) => {
    const { text } = parse(MemoBody, req.body, 'request body');
    await ctx.voice.setMemo(text);
    return { ok: true };
  });

  app.post(ROUTES.voiceCorpus, { bodyLimit: 64 * 1024 * 1024 }, async (req) => {
    const body = parse(CorpusBody, req.body, 'request body');
    if ('entries' in body) return { entries: await ctx.voice.addCorpus(body.entries) };
    const imp = body.import;
    const opts = { source: imp.source, sectionType: imp.sectionType ?? null, unassisted: imp.unassisted };
    let rows;
    if (imp.format === 'pdf') {
      if (!imp.dataBase64) throw new HttpError(400, 'a PDF import needs dataBase64');
      if (!pdftotextAvailable()) throw new HttpError(501, 'pdftotext (poppler-utils) is not installed on this machine; import the .tex or .txt source instead');
      let text: string;
      try {
        text = await pdfToText(Buffer.from(imp.dataBase64, 'base64'));
      } catch (e) {
        throw new HttpError(422, e instanceof Error ? e.message : String(e));
      }
      rows = importPlainText(text, opts);
    } else {
      if (typeof imp.text !== 'string') throw new HttpError(400, `a ${imp.format} import needs text`);
      rows = imp.format === 'tex' ? importLatex(imp.text, opts) : imp.format === 'md' ? importMarkdown(imp.text, opts) : importPlainText(imp.text, opts);
    }
    if (rows.length === 0) throw new HttpError(422, 'no usable text found in the import');
    return { entries: await ctx.voice.addCorpus(rows) };
  });

  app.patch(`${ROUTES.voiceCorpus}/:id`, async (req) => {
    const id = String((req.params as { id?: unknown }).id ?? '');
    const { unassisted } = parse(PatchBody, req.body, 'request body');
    await ctx.voice.setUnassisted(id, unassisted);
    const row = ctx.voice.corpus().find((e) => e.id === id);
    if (!row) throw new HttpError(404, `no corpus entry ${id}`);
    return row;
  });

  app.get(ROUTES.styleDistance, async (req) => {
    const q = parse(DistanceQuery, req.query, 'query');
    return ctx.voice.styleDistance(q.scope, q.id && q.id.length > 0 ? q.id : undefined);
  });
}
