/**
 * Document routes (the live text travels over the WebSocket; these are for reads and maintenance):
 *   GET    /api/doc?file=                    { file, version, text, units, intentLines, sections, orphans }
 *   GET    /api/doc/orphans?file=            SentenceUnit[] (units that lost their anchor; metadata kept)
 *   DELETE /api/doc/orphans/:id              discard one orphan (history stays)
 *   POST   /api/doc/semantic-lines           { file, undo? } one sentence per line (reversible), or undo it
 */
import type { FastifyInstance } from 'fastify';
import { ROUTES } from '@paper-copilot/core';
import { z } from 'zod';
import { HttpError, type Ctx } from '../contracts';
import type { DocServiceExt } from '../docs/docService';
import { applySemanticLines, undoSemanticLines } from '../project/semanticLines';
import { parseWith } from './project';

const FileQuery = z.object({ file: z.string().min(1).max(1024) });

export function registerDocRoutes(app: FastifyInstance, ctx: Ctx): void {
  const ext = () => ctx.docs as DocServiceExt;

  app.get(ROUTES.doc, async (req) => {
    const { file } = parseWith(FileQuery, req.query, 'query');
    const st = await ctx.docs.open(file);
    const orphans = typeof ext().orphans === 'function' ? ext().orphans(st.file) : [];
    return { file: st.file, version: st.version, text: st.text, units: st.units, intentLines: st.intentLines, sections: st.seg.sections, orphans };
  });

  app.get(`${ROUTES.doc}/orphans`, async (req) => {
    const { file } = parseWith(FileQuery, req.query, 'query');
    if (typeof ext().orphans !== 'function') return [];
    return ext().orphans(file);
  });

  app.delete(`${ROUTES.doc}/orphans/:id`, async (req) => {
    const { id } = parseWith(z.object({ id: z.string().min(1).max(100) }), req.params, 'params');
    if (typeof ext().discardOrphan !== 'function') throw new HttpError(501, 'not supported');
    ext().discardOrphan(id);
    return { ok: true };
  });

  app.post(`${ROUTES.doc}/semantic-lines`, async (req) => {
    const body = parseWith(z.object({ file: z.string().min(1).max(1024), undo: z.boolean().optional() }), req.body);
    if (!ctx.docs.get(body.file)) await ctx.docs.open(body.file);
    const r = body.undo ? await undoSemanticLines(ctx.paths, body.file, ctx.docs) : await applySemanticLines(ctx.paths, body.file, ctx.docs);
    const d = ext();
    if (typeof d.logEvent === 'function') d.logEvent(body.undo ? 'semantic_lines_undo' : 'semantic_lines', null, r.file, { changed: r.changed, skipped: r.skipped });
    if (!body.undo && r.changed && !ctx.config.semanticLines) await ctx.saveConfig({ ...ctx.config, semanticLines: true });
    return r;
  });
}
