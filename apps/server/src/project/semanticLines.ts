/**
 * Reversible semantic line breaks (one sentence per line in prose paragraphs; core toSemanticLines).
 *
 * Applying it is ONE change per file: the whitespace between sentences becomes a newline, nothing else
 * (sentence text, math, comments and environments are untouched, so every unit keeps its id and no
 * version row is written). The original text and the edits are recorded in
 * .paper/semantic-lines/<file>.json, so `undo` restores the co-authors' original layout. Undo works on
 * the exact normalized text, and after later edits it restores every break whose newline is still
 * where it was put (mapped through the edits since), leaving the rest.
 *
 * With an open document (`docs`), the mirror is flushed first and the result is loaded back through
 * docs.reloadFromDisk (the browser gets doc.replace).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffChanges, segment, toSemanticLines, type TextEdit } from '@paper-copilot/core';
import { z } from 'zod';
import type { DocService, PaperPaths } from '../contracts';
import { writeFileAtomic } from '../infra';
import { fromDisk, resolveInTex, toDisk } from '../docs/text';

export const SemanticUndoRecord = z.object({
  file: z.string(),
  ts: z.string(),
  /** Mirror-form (LF) text before the change. */
  before: z.string(),
  /** Mirror-form text right after the change. */
  after: z.string(),
  edits: z.array(z.object({ from: z.number().int(), to: z.number().int(), insert: z.string() })),
});
export type SemanticUndoRecord = z.infer<typeof SemanticUndoRecord>;

export function undoPath(paths: PaperPaths, file: string): string {
  return join(paths.paper, 'semantic-lines', `${file.replace(/[\\/]/g, '__')}.json`);
}

export interface SemanticResult {
  file: string;
  /** Sentence breaks inserted (apply) or restored (undo). */
  changed: number;
  skipped: number;
  undoFile: string | null;
}

async function currentText(paths: PaperPaths, rel: string, abs: string, docs?: DocService): Promise<{ text: string; form: ReturnType<typeof fromDisk>['form']; open: boolean }> {
  const raw = readFileSync(abs, 'utf8');
  const disk = fromDisk(raw);
  if (docs && docs.get(rel)) {
    await docs.flush(rel);
    return { text: docs.get(rel)!.text, form: disk.form, open: true };
  }
  void paths;
  return { ...disk, open: false };
}

export async function applySemanticLines(paths: PaperPaths, file: string, docs?: DocService): Promise<SemanticResult> {
  const { rel, abs } = resolveInTex(paths.tex, file);
  const { text, form, open } = await currentText(paths, rel, abs, docs);
  const seg = segment(text);
  const { text: next, edits } = toSemanticLines(text, seg);
  if (edits.length === 0) return { file: rel, changed: 0, skipped: 0, undoFile: existsSync(undoPath(paths, rel)) ? undoPath(paths, rel) : null };
  const up = undoPath(paths, rel);
  // keep the oldest original if applied twice (the second run only adds breaks to new text)
  let record: SemanticUndoRecord = { file: rel, ts: new Date().toISOString(), before: text, after: next, edits };
  if (existsSync(up)) {
    try {
      const prev = SemanticUndoRecord.parse(JSON.parse(readFileSync(up, 'utf8')));
      if (prev.after === text) record = { ...record, before: prev.before, edits: composeEdits(prev, next) ?? edits };
    } catch {
      /* unreadable: overwrite */
    }
  }
  await writeFileAtomic(up, JSON.stringify(record) + '\n');
  await writeFileAtomic(abs, toDisk(next, form));
  if (open && docs) await docs.reloadFromDisk(rel, 'external');
  return { file: rel, changed: edits.length, skipped: 0, undoFile: up };
}

/** Edits from prev.before to `next` when the second application only added breaks (else null). */
function composeEdits(prev: SemanticUndoRecord, next: string): TextEdit[] | null {
  const again = toSemanticLines(prev.before, segment(prev.before));
  return again.text === next ? again.edits : null;
}

export async function undoSemanticLines(paths: PaperPaths, file: string, docs?: DocService): Promise<SemanticResult> {
  const { rel, abs } = resolveInTex(paths.tex, file);
  const up = undoPath(paths, rel);
  if (!existsSync(up)) return { file: rel, changed: 0, skipped: 0, undoFile: null };
  const rec = SemanticUndoRecord.parse(JSON.parse(readFileSync(up, 'utf8')));
  const { text, form, open } = await currentText(paths, rel, abs, docs);
  let restored: string;
  let changed = 0;
  let skipped = 0;
  if (text === rec.after) {
    restored = rec.before;
    changed = rec.edits.length;
  } else {
    // positions of the inserted newlines in `after`, mapped through the edits made since
    const cs = diffChanges(rec.after, text);
    const repl: Array<{ from: number; to: number; insert: string }> = [];
    let shift = 0;
    for (const e of rec.edits) {
      const posAfter = e.from + shift;
      shift += e.insert.length - (e.to - e.from);
      const a = cs.mapPos(posAfter, 1);
      const b = cs.mapPos(posAfter + e.insert.length, -1);
      if (b - a === e.insert.length && text.slice(a, b) === e.insert) {
        repl.push({ from: a, to: b, insert: rec.before.slice(e.from, e.to) });
        changed++;
      } else skipped++;
    }
    repl.sort((x, y) => y.from - x.from);
    restored = text;
    for (const r of repl) restored = restored.slice(0, r.from) + r.insert + restored.slice(r.to);
  }
  await writeFileAtomic(abs, toDisk(restored, form));
  await writeFileAtomic(up + '.undone', readFileSync(up, 'utf8'));
  const { rm } = await import('node:fs/promises');
  await rm(up, { force: true });
  if (open && docs) await docs.reloadFromDisk(rel, 'external');
  return { file: rel, changed, skipped, undoFile: up };
}
