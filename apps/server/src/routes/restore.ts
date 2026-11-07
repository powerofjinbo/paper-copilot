/**
 * POST /api/sentences/:id/restore  RestoreRequest { version } -> RestoreResponse
 *
 * Restoring an earlier version of a sentence is an EDIT the client applies, as one annotated change
 * (replace the unit's current span with the version's text), so the server records it exactly like every
 * other edit: a new version row, the state change and the history line come from the doc.change. The
 * server only decides the provenance:
 * - the author's (or a co-author's) version (origin import / human_typed / human_edit / external_edit):
 *   origin 'human_edit'; state 'human', or 'ai-edited' when that text descends from an AI version (the
 *   author edited AI text: restoring it does not make it the author's own);
 * - an AI version: its own origin, model, prompt hash, instruction and language. ai_ghost / ai_rewrite
 *   -> 'ai-drafted', ai_intent -> 'ai-from-intent', ai_draft / replan -> 'proposed' (a draft needs a review
 *   again), grammar_fix -> the state of the text it fixed (the fix of an AI draft is still an AI draft).
 *   The text is re-checked by the faithfulness gate against the CURRENT facts, bibliography and labels:
 *   a number or citation that no longer holds makes it 'unsupported' (red, never pushed) instead of
 *   silently reappearing as grounded.
 * everAi is never cleared (the doc service keeps it, whatever the annotation says).
 */
import type { FastifyInstance } from 'fastify';
import {
  AI_ORIGINS,
  FEATURE_ROUTES,
  RestoreRequest,
  gateSentence,
  type ChangeAnnotation,
  type GateIssueWire,
  type RestoreResponse,
  type SentenceState,
  type SentenceUnit,
  type SentenceVersion,
  type VersionOrigin,
} from '@paper-copilot/core';
import { z } from 'zod';
import { HttpError, type Ctx } from '../contracts';
import type { DocServiceExt } from '../docs/docService';
import { parseWith } from './project';
import { derivedOf } from './reports';

const Params = z.object({ id: z.string().min(1).max(100) });

const isAi = (o: VersionOrigin): boolean => AI_ORIGINS.includes(o) && o !== 'grammar_fix';

/** State an AI origin's text gets back when restored. */
function aiState(origin: VersionOrigin): SentenceState {
  switch (origin) {
    case 'ai_intent':
      return 'ai-from-intent';
    case 'ai_draft':
    case 'replan':
      return 'proposed';
    default:
      return 'ai-drafted';
  }
}

/**
 * Where the text of version `v` comes from: walk the parent chain through edits (human_edit,
 * external_edit, grammar_fix) to the version that wrote the text (an AI origin, or import / human_typed).
 * Returns that version, or null when the chain ends in an edit (a split-off sentence: its source is
 * another unit), with `aiInChain` set when any AI version is on the way.
 */
export function textSource(v: SentenceVersion, versions: readonly SentenceVersion[]): { source: SentenceVersion | null; aiInChain: boolean } {
  const byVersion = new Map(versions.map((x) => [x.version, x]));
  let cur: SentenceVersion | undefined = v;
  let aiInChain = false;
  const seen = new Set<number>();
  while (cur && !seen.has(cur.version)) {
    seen.add(cur.version);
    if (isAi(cur.origin)) return { source: cur, aiInChain: true };
    if (cur.origin === 'import' || cur.origin === 'human_typed') return { source: cur, aiInChain };
    const parent: number | null = cur.parentVersion ?? (cur.version > 0 ? cur.version - 1 : null);
    cur = parent === null ? undefined : byVersion.get(parent);
  }
  return { source: null, aiInChain };
}

export interface RestorePlan {
  origin: VersionOrigin;
  state: SentenceState;
  /** True when the restored text is (derived from) AI text: it is re-checked by the gate. */
  aiText: boolean;
  model: string | null;
  promptHash: string | null;
  instruction: string | null;
  lang: string | null;
}

/** Origin and state for restoring `v` of `unit` (see the module comment). */
export function restorePlan(unit: SentenceUnit, v: SentenceVersion, versions: readonly SentenceVersion[]): RestorePlan {
  if (isAi(v.origin)) {
    return { origin: v.origin, state: aiState(v.origin), aiText: true, model: v.model ?? unit.model, promptHash: v.promptHash ?? unit.promptHash, instruction: v.instruction, lang: v.lang };
  }
  const { source, aiInChain } = textSource(v, versions);
  // A split-off sentence whose chain starts with an edit: its source is unknown here; trust everAi.
  const fromAi = source ? aiInChain : aiInChain || unit.everAi;
  if (v.origin === 'grammar_fix') {
    if (source && isAi(source.origin)) {
      // the grammar fix of AI text: restored as that AI text (its origin and state), with the fix's model
      return { origin: source.origin, state: aiState(source.origin), aiText: true, model: v.model ?? source.model, promptHash: v.promptHash ?? source.promptHash, instruction: source.instruction, lang: source.lang };
    }
    return { origin: 'human_edit', state: fromAi ? 'ai-edited' : 'human', aiText: fromAi, model: null, promptHash: null, instruction: null, lang: null };
  }
  return { origin: 'human_edit', state: fromAi ? 'ai-edited' : 'human', aiText: false, model: null, promptHash: null, instruction: null, lang: null };
}

export function registerRestoreRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.post(FEATURE_ROUTES.sentenceRestore, async (req) => {
    const { id } = parseWith(Params, req.params, 'params');
    const { version } = parseWith(RestoreRequest, req.body, 'body');
    const known = ctx.docs.unit(id) ?? ctx.db.unit(id);
    if (!known) throw new HttpError(404, `no such sentence: ${id}`);
    if (!ctx.docs.get(known.file)) await ctx.docs.open(known.file);
    await ctx.docs.flush(known.file);
    const unit = ctx.docs.unit(id);
    if (!unit || unit.orphaned) throw new HttpError(409, 'this sentence is no longer in the text (deleted or orphaned after a co-author edit); copy the version from the history instead');
    const versions = ctx.db.versions(id);
    const v = versions.find((x) => x.version === version);
    if (!v) throw new HttpError(404, `sentence ${id} has no version ${version}`);
    if (!v.text.trim()) throw new HttpError(409, `version ${version} is empty; delete the sentence instead`);
    const st = ctx.docs.get(unit.file);
    if (!st) throw new HttpError(409, 'open the file before restoring one of its sentences');
    const current = st.text.slice(unit.start, unit.end);
    const plan = restorePlan(unit, v, versions);

    let state = plan.state;
    let issues: GateIssueWire[] = [];
    let factIds: string[] = [];
    let citeKeys: string[] = [];
    if (plan.aiText) {
      const facts = ctx.facts.all().filter((f) => !f.excluded);
      const gate = gateSentence(v.text, {
        mode: 'draft',
        facts,
        allowedCiteKeys: ctx.lit.allowedKeys().map((k) => k.key),
        knownLabels: ctx.docs.labels(),
        fictionalNumbers: [],
        derived: derivedOf(ctx, facts),
        intentText: unit.intentNote,
        claimedFactIds: unit.facts,
      });
      issues = gate.issues.map((i) => ({ code: i.code, severity: i.severity, message: i.message, ...(i.start !== undefined ? { start: i.start } : {}), ...(i.end !== undefined ? { end: i.end } : {}), ...(i.raw !== undefined ? { raw: i.raw } : {}) }));
      factIds = gate.factIds;
      citeKeys = gate.citeKeys;
      if (!gate.ok && isAi(plan.origin)) state = 'unsupported';
    }
    const annotation: ChangeAnnotation = {
      origin: plan.origin,
      sentenceIds: [id],
      state,
      model: plan.model,
      promptHash: plan.promptHash,
      instruction: plan.instruction,
      lang: plan.lang,
      intentNote: unit.intentNote,
      factIds,
      citeKeys,
      move: unit.move,
      requestId: null,
    };
    const res: RestoreResponse = {
      sentenceId: id,
      file: unit.file,
      version,
      docVersion: st.version,
      start: unit.start,
      end: unit.end,
      current,
      text: v.text,
      origin: plan.origin,
      state,
      annotation,
      issues,
      noop: current === v.text,
    };
    const d = ctx.docs as Partial<DocServiceExt>;
    if (typeof d.logEvent === 'function') d.logEvent('state', id, unit.file, { action: 'restore_offered', version, origin: plan.origin, to: state, noop: res.noop });
    return res;
  });
}
