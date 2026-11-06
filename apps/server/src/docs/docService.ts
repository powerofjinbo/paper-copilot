/**
 * DocService: the server-side mirror of every open .tex file and the owner of sentence units.
 *
 * Text ownership (packages/core/src/api.ts): while a file is open the browser is the only writer. Each
 * `doc.change` is a CodeMirror ChangeSet against `baseVersion`; the mirror applies it to a
 * @codemirror/state Text, maps unit spans (core mapUnits) and remembers the dirty ranges. A debounced
 * pass (300 ms; immediately for annotated AI changes, so provenance lands on exactly the text the AI
 * produced) re-segments the file (core segment), matches segments to units (core assignUnits), persists
 * units and versions (paper.db + history.jsonl), emits `sentences.patch`, feeds edit pairs to the voice
 * service, links numerals to facts, asks lint for the changed units and schedules the document lint
 * pass. The file is written to disk 1 s after the last change (atomic temp + rename, in the file's own
 * line-ending convention); the written text is remembered, so the watcher ignores our own writes, and
 * the units and a copy of the written text ("last-saved snapshot", kv `doc.snapshot:<file>`) are saved
 * together so the next open can re-anchor against edits made while the app was closed.
 *
 * Unit identity through AI rewrites: a rewrite replaces the whole sentence, which collapses the unit's
 * mapped span to a point. Before assignUnits, every unit named in the annotation's `sentenceIds` whose
 * mapped span touches the annotated range is widened to cover it, so the segment(s) the AI produced
 * keep the id (the largest one when a rewrite became two sentences; the other gets `splitFrom`).
 *
 * Annotated changes: applyClientChange applies the text and returns; the re-segmentation runs on the
 * next macrotask (after the caller sent doc.ack), and any later change first runs a pending annotated
 * pass synchronously, so each annotation is attached to its own change only.
 *
 * External changes (pull, edits on disk): reloadFromDisk diffs the mirror against the disk text and
 * re-anchors (core reanchor: hash, then fuzzy matching; unmatched units become orphans and keep their
 * metadata), persists, and emits `doc.replace`. If the mirror holds unsaved local edits, the disk change
 * is merged into them (diff-match-patch); when the merge fails, the disk text wins and the local text is
 * saved under .paper/conflicts/ so nothing is lost.
 */
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ChangeSet, Text } from '@codemirror/state';
import DiffMatchPatch from 'diff-match-patch';
import {
  assignUnits,
  changedRanges,
  diffChanges,
  findIntentLines,
  hashString,
  mapUnits,
  normalizeForHash,
  nowIso,
  reanchor,
  segment,
  similarity,
  editDistanceWords,
  type AssignResult,
  type ChangeAnnotation,
  type ClientMessage,
  type IntentLineInfo,
  type ReanchorReport,
  type Segmentation,
  type SentenceUnit,
  type SentenceVersion,
  type ServerMessage,
  type VersionOrigin,
} from '@paper-copilot/core';
import { HttpError, type Ctx, type DocService, type DocState } from '../contracts';
import { writeFileAtomic } from '../infra';
import { flattenTex } from '../services/build/flatten';
import type { PaperDbExt } from '../store/db';
import { createHistoryLog, type HistoryLog } from './history';
import { fromDisk, isTexName, listFiles, resolveInTex, sortTexFiles, toDisk, type DiskForm } from './text';

type Range = { from: number; to: number };
type DocChangeMsg = Extract<ClientMessage, { type: 'doc.change' }>;
type UnitsListener = (file: string, upserts: SentenceUnit[], removed: string[]) => void;

export interface DocServiceOptions {
  /** Debounce of the re-segmentation after typing. Default 300 ms. */
  segmentDebounceMs?: number;
  /** Debounce of the disk write. Default 1000 ms. */
  writeDebounceMs?: number;
  /** Delay before re-planning downstream proposed sentences after an edit. Default 1000 ms. */
  replanDelayMs?: number;
  /** Clock (tests). */
  now?: () => string;
}

export interface DocServiceExt extends DocService {
  /** Files currently mirrored. */
  openFiles(): string[];
  /** True when `diskText` (raw, as read from disk) is what the mirror last wrote or loaded. */
  isKnownDiskText(file: string, diskText: string): boolean;
  /** Orphans of a file (units that lost their anchor after an external change). */
  orphans(file: string): SentenceUnit[];
  /** Forget an orphan (the author discarded it). */
  discardOrphan(id: string): void;
  /** Flush every open file (pending segmentation and disk writes). */
  flushAll(): Promise<void>;
  /** Flush and stop timers. */
  close(): Promise<void>;
  /** Record a review event in history.jsonl (accept/reject...). */
  logEvent(event: 'accept' | 'reject' | 'state' | 'semantic_lines' | 'semantic_lines_undo', sentenceId: string | null, file: string | null, data?: Record<string, unknown>): void;
  /** Resolves when every queued history line is written. */
  drainHistory(): Promise<void>;
  /** True if a disk write or re-segmentation is pending for the file. */
  hasPending(file: string): boolean;
  /** Defer every disk write until the returned release is called (a sync pull rewrites the files). */
  holdWrites(): () => void;
}

/** Import annotation: every sentence of an imported document is the author's (provenance unknown). */
export const IMPORT_ANNOTATION: ChangeAnnotation = {
  origin: 'import',
  sentenceIds: [],
  state: 'human',
  model: null,
  promptHash: null,
  instruction: null,
  lang: null,
  intentNote: null,
  factIds: [],
  citeKeys: [],
  move: null,
  requestId: null,
};

/** Origins of a change that may make downstream proposed sentences of the same paragraph stale. */
const REPLAN_TRIGGERS: ReadonlySet<VersionOrigin> = new Set(['human_edit', 'human_typed', 'ai_rewrite', 'ai_ghost', 'ai_intent']);

export const snapshotKey = (file: string): string => `doc.snapshot:${file}`;
/**
 * The text the units stored in paper.db refer to (their spans and textNorm). Written in the same
 * transaction as every units upsert, so a crash between a segmentation pass and the debounced disk
 * write cannot leave units whose spans belong to text that is not on disk (load re-anchors from it).
 */
export const unitsTextKey = (file: string): string => `doc.unitsText:${file}`;

/** States holding AI text (mirrors core assign.ts). */
const AI_TEXT_STATES: ReadonlySet<SentenceUnit['state']> = new Set(['ai-drafted', 'ai-from-intent', 'proposed', 'unsupported', 'ai-edited']);
const AI_VERSION_ORIGINS: ReadonlySet<VersionOrigin> = new Set(['ai_ghost', 'ai_intent', 'ai_draft', 'ai_rewrite', 'grammar_fix', 'replan']);
const aiTouched = (u: SentenceUnit): boolean => u.everAi || AI_TEXT_STATES.has(u.state);
/** Shortest normalized text that is revived by exact hash / by near match. */
const REVIVE_MIN_EXACT = 8;
const REVIVE_MIN_NEAR = 24;
const REVIVE_NEAR_SIMILARITY = 0.85;
/** Removed AI-touched units remembered for revival (undo/redo, cut/paste). */
const MAX_TOMBSTONES = 4000;

interface FileState {
  file: string;
  abs: string;
  form: DiskForm;
  version: number;
  doc: Text;
  /** Cached doc.toString() (null after a change). */
  textCache: string | null;
  units: SentenceUnit[];
  seg: Segmentation;
  intentLines: IntentLineInfo[];
  /** Ranges changed since the last segmentation, in current coordinates. */
  dirty: Range[];
  /** An annotated change waiting for its (immediate) segmentation pass. */
  pendingAnn: { annotation: ChangeAnnotation; range: Range | null } | null;
  segTimer: NodeJS.Timeout | null;
  annImmediate: NodeJS.Immediate | null;
  writeTimer: NodeJS.Timeout | null;
  /** The mirror changed since the last disk write. */
  unsaved: boolean;
  /** Mirror-form text last written to or read from disk. */
  diskText: string;
  /** Mirror-form text of the write in progress (the watcher may see it before the write resolves). */
  writingText: string | null;
  writing: Promise<void> | null;
  /** An external reload in progress (disk writes wait for it). */
  reloading: Promise<unknown> | null;
}

function textOf(st: FileState): string {
  st.textCache ??= st.doc.toString();
  return st.textCache;
}

function toText(s: string): Text {
  return Text.of(s.split('\n'));
}

function intentInfo(seg: Segmentation, text: string): IntentLineInfo[] {
  const lines = seg.intentLines.length > 0 ? seg.intentLines : findIntentLines(text);
  return lines.map((l) => ({ start: l.start, end: l.end, line: l.line, text: l.text }));
}

function emptySeg(): Segmentation {
  return { sentences: [], sections: [], paragraphs: [], intentLines: [], labels: [], refs: [], cites: [], fragment: true };
}

/** A span touches a range: overlap, or adjacency / containment of an empty side. */
function touches(r: Range, start: number, end: number): boolean {
  return start <= r.to && r.from <= end;
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export function createDocService(ctx: Ctx, opts: DocServiceOptions = {}): DocServiceExt {
  const log = ctx.log;
  const segMs = opts.segmentDebounceMs ?? 300;
  const writeMs = opts.writeDebounceMs ?? 1000;
  const replanMs = opts.replanDelayMs ?? 1000;
  const now = opts.now ?? nowIso;
  const db = ctx.db as PaperDbExt;
  const history: HistoryLog = createHistoryLog(ctx.paths.history, ctx.files, log);

  const states = new Map<string, FileState>();
  const opening = new Map<string, Promise<{ state: FileState; report: ReanchorReport | null }>>();
  const listeners = new Set<UnitsListener>();
  const replanTimers = new Map<string, NodeJS.Timeout>();
  let closed = false;
  let writeHolds = 0;

  /** While set, updateUnit collects instead of emitting (facts.linkUnit calls back into updateUnit). */
  let batch: { file: string; units: Map<string, SentenceUnit> } | null = null;
  /** Re-entrancy guard: get()/snapshot during a segmentation pass return the current state as is. */
  let segmenting = false;

  const warned = new Set<string>();
  const soft = <T>(what: string, fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!warned.has(what)) {
        warned.add(what);
        log.warn(`docs: ${what} failed`, msg);
      } else log.debug(`docs: ${what} failed`, msg);
      return fallback;
    }
  };
  const softAsync = (what: string, fn: () => Promise<unknown> | unknown): void => {
    try {
      const r = fn();
      if (r && typeof (r as Promise<unknown>).then === 'function') {
        (r as Promise<unknown>).catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          if (!warned.has(what)) {
            warned.add(what);
            log.warn(`docs: ${what} failed`, msg);
          } else log.debug(`docs: ${what} failed`, msg);
        });
      }
    } catch (e) {
      soft(what, () => {
        throw e;
      }, undefined);
    }
  };

  const notify = (file: string, upserts: SentenceUnit[], removed: string[]): void => {
    if (upserts.length === 0 && removed.length === 0) return;
    for (const l of [...listeners]) {
      try {
        l(file, upserts, removed);
      } catch (e) {
        log.warn('docs: onUnitsChanged listener failed', String(e));
      }
    }
  };

  const lastVersion = (id: string): SentenceVersion | undefined => db.lastVersion(id);
  const lastAiVersion = (id: string): SentenceVersion | undefined => db.lastAiVersion(id);

  /** Version rows -> db + history (with the parent text for the before-hash). */
  const persistVersions = (file: string, rows: SentenceVersion[]): void => {
    if (rows.length === 0) return;
    const parents = new Map<string, string | null>();
    for (const v of rows) {
      if (v.parentVersion === null) continue;
      const p = db.versions(v.sentenceId).find((x) => x.version === v.parentVersion);
      parents.set(`${v.sentenceId}#${v.version}`, p ? p.text : null);
    }
    db.appendVersions(rows);
    history.versions(file, rows, (v) => parents.get(`${v.sentenceId}#${v.version}`) ?? null);
  };

  /* ------------------------------------------------------------------------------------ */
  /* Provenance of re-inserted AI text (undo/redo, cut/paste, copies)                      */
  /* ------------------------------------------------------------------------------------ */

  /**
   * Removed AI-touched units, by hash. CodeMirror's undo/redo and paste transactions carry no
   * ChangeAnnotation, so without this an undo followed by a redo (or a cut and paste) of AI text would
   * create fresh 'human' units: unreviewed drafts would become pushable and everAi would be laundered.
   * Global across files (a sentence can be cut from one file and pasted into another).
   */
  const tombs = new Map<string, SentenceUnit[]>();
  let tombCount = 0;
  const tombOrder: SentenceUnit[] = [];
  const addTomb = (u: SentenceUnit): void => {
    if (!aiTouched(u) || u.textNorm.length < REVIVE_MIN_EXACT) return;
    const list = tombs.get(u.hash) ?? [];
    const i = list.findIndex((x) => x.id === u.id);
    if (i >= 0) list[i] = u;
    else {
      list.push(u);
      tombOrder.push(u);
      tombCount++;
    }
    tombs.set(u.hash, list);
    while (tombCount > MAX_TOMBSTONES && tombOrder.length) {
      const old = tombOrder.shift()!;
      dropTomb(old.id, old.hash);
    }
  };
  const dropTomb = (id: string, hash: string): void => {
    const list = tombs.get(hash);
    if (!list) return;
    const next = list.filter((x) => x.id !== id);
    if (next.length !== list.length) tombCount--;
    if (next.length) tombs.set(hash, next);
    else tombs.delete(hash);
  };
  const seededTombs = new Set<string>();
  /** Removed AI-touched units of a file from paper.db (a cut before a restart, a paste after). */
  const seedTombs = (file: string): void => {
    if (seededTombs.has(file)) return;
    seededTombs.add(file);
    const all = soft('db.allUnitsOf', () => db.allUnitsOf(file), [] as Array<{ unit: SentenceUnit; removed: boolean }>);
    for (const { unit, removed } of all) if (removed && !unit.orphaned) addTomb(unit);
  };

  const liveIds = (): Set<string> => {
    const ids = new Set<string>();
    for (const st of states.values()) for (const u of st.units) ids.add(u.id);
    return ids;
  };

  /**
   * After a local pass: a new unit whose text is (or nearly is) known AI text gets that provenance back.
   * Exact text of a removed unit or an orphan revives that unit (same id, state, everAi, versions);
   * a near match revives it as edited AI text; exact text of a live AI unit (a copy) gets a new id but
   * keeps everAi and the review state. Never applied to text an AI annotation already marked.
   */
  const reviveKnownText = (st: FileState, res: AssignResult, before: SentenceUnit[]): void => {
    const beforeById = new Map(before.map((u) => [u.id, u]));
    for (const id of res.removed) {
      const u = beforeById.get(id);
      if (u) addTomb(u);
    }
    const created = res.units.filter((u) => !beforeById.has(u.id) && !u.everAi && u.textNorm.length >= REVIVE_MIN_EXACT);
    if (created.length === 0) return;
    const orphans = soft('db.orphans', () => db.orphans(st.file), [] as SentenceUnit[]);
    const live = liveIds();
    for (const u of res.units) live.add(u.id);
    const removedNow = new Set(res.removed);
    const isFree = (id: string): boolean => removedNow.has(id) || !live.has(id);
    const used = new Set<string>();
    const liveAi = (hash: string): SentenceUnit | undefined => {
      for (const u of res.units) if (u.hash === hash && aiTouched(u) && !created.includes(u)) return u;
      for (const other of states.values()) {
        if (other === st) continue;
        const f = other.units.find((u) => u.hash === hash && aiTouched(u));
        if (f) return f;
      }
      return undefined;
    };

    const replaceUnit = (n: SentenceUnit, r: SentenceUnit, versions: SentenceVersion[]): void => {
      res.units = res.units.map((u) => (u === n ? r : u));
      res.upserts = [...res.upserts.filter((u) => u.id !== n.id && u.id !== r.id), r];
      res.versions = [...res.versions.filter((v) => v.sentenceId !== n.id), ...versions];
      res.removed = res.removed.filter((id) => id !== r.id);
      res.report.created = res.report.created.filter((id) => id !== n.id);
      res.report.split = res.report.split.filter((x) => x.into !== n.id);
      used.add(r.id);
      live.add(r.id);
    };
    const positional = (n: SentenceUnit) => ({
      file: n.file,
      start: n.start,
      end: n.end,
      line: n.line,
      ctxHash: n.ctxHash,
      sectionId: n.sectionId,
      paragraphId: n.paragraphId,
      part: n.part,
      kind: n.kind,
      hash: n.hash,
      textNorm: n.textNorm,
      cites: n.cites,
      placeholders: n.placeholders,
      orphaned: false,
    });

    for (const n of created) {
      const exact = [...(tombs.get(n.hash) ?? []), ...orphans.filter((o) => o.hash === n.hash)].find(
        (t) => t.kind === n.kind && !used.has(t.id) && isFree(t.id),
      );
      if (exact) {
        // Same text as a removed / orphaned unit: it is that unit again (undo + redo, cut + paste).
        const r: SentenceUnit = { ...exact, ...positional(n), splitFrom: exact.splitFrom };
        replaceUnit(n, r, []);
        dropTomb(exact.id, exact.hash);
        continue;
      }
      const copy = liveAi(n.hash);
      if (copy) {
        // A copy of live AI text: a new sentence that carries the source's provenance and review state.
        const srcAi = lastAiVersion(copy.id) ?? lastVersion(copy.id);
        const r: SentenceUnit = {
          ...n,
          state: copy.state,
          everAi: true,
          grammarFixed: copy.grammarFixed,
          model: copy.model,
          promptHash: copy.promptHash,
          intentNote: copy.intentNote,
          move: copy.move,
          facts: [...copy.facts],
          claims: [...copy.claims],
          editDistance: copy.editDistance,
          acceptedAt: copy.acceptedAt,
        };
        const versions = res.versions
          .filter((v) => v.sentenceId === n.id)
          .map((v) =>
            srcAi && AI_VERSION_ORIGINS.has(srcAi.origin)
              ? { ...v, origin: srcAi.origin, model: srcAi.model, promptHash: srcAi.promptHash, instruction: srcAi.instruction, lang: srcAi.lang }
              : v,
          );
        replaceUnit(n, r, versions);
        continue;
      }
      if (n.textNorm.length < REVIVE_MIN_NEAR) continue;
      // Near match: the removed AI sentence came back slightly changed (a redo after a small edit, a
      // paste that lost a word). It is that unit, edited by the author: AI provenance is kept.
      let best: { t: SentenceUnit; sim: number } | null = null;
      const pool: SentenceUnit[] = [...orphans.filter(aiTouched)];
      for (const list of tombs.values()) pool.push(...list);
      for (const t of pool) {
        if (t.kind !== n.kind || used.has(t.id) || !isFree(t.id)) continue;
        if (Math.abs(t.textNorm.length - n.textNorm.length) > Math.max(t.textNorm.length, n.textNorm.length) * 0.3) continue;
        const sim = similarity(t.textNorm, n.textNorm);
        if (sim >= REVIVE_NEAR_SIMILARITY && (!best || sim > best.sim)) best = { t, sim };
      }
      if (!best) continue;
      const t = best.t;
      const last = lastVersion(t.id);
      const srcAi = lastAiVersion(t.id) ?? last;
      const text = textOf(st).slice(n.start, n.end);
      const dist = srcAi ? editDistanceWords(srcAi.text, text) : t.editDistance;
      const r: SentenceUnit = {
        ...t,
        ...positional(n),
        everAi: true,
        state: AI_TEXT_STATES.has(t.state) ? 'ai-edited' : t.state,
        acceptedAt: t.acceptedAt ?? (AI_TEXT_STATES.has(t.state) ? now() : null),
        editDistance: dist,
      };
      const versions = res.versions
        .filter((v) => v.sentenceId === n.id)
        .map((v) => ({
          ...v,
          sentenceId: t.id,
          origin: 'human_edit' as VersionOrigin,
          version: last ? last.version + 1 : 0,
          parentVersion: last ? last.version : null,
          editDistance: last ? editDistanceWords(last.text, v.text) : null,
        }))
        .slice(0, 1);
      replaceUnit(n, r, versions);
      dropTomb(t.id, t.hash);
    }
  };

  /* ------------------------------------------------------------------------------------ */
  /* Segmentation pass                                                                     */
  /* ------------------------------------------------------------------------------------ */

  const clearSegTimers = (st: FileState): void => {
    if (st.segTimer) clearTimeout(st.segTimer);
    st.segTimer = null;
    if (st.annImmediate) clearImmediate(st.annImmediate);
    st.annImmediate = null;
  };

  const needsSegment = (st: FileState): boolean => st.dirty.length > 0 || st.pendingAnn !== null || st.segTimer !== null || st.annImmediate !== null;

  /** Link facts for units whose text changed; updateUnit calls made by the fact service are batched. */
  const linkFacts = (st: FileState, units: SentenceUnit[], prefer: (u: SentenceUnit) => string[]): Map<string, SentenceUnit> => {
    const prevBatch = batch;
    batch = { file: st.file, units: new Map() };
    try {
      const text = textOf(st);
      for (const u of units) {
        const live = st.units.find((x) => x.id === u.id) ?? u;
        soft('facts.linkUnit', () => ctx.facts.linkUnit(live, text.slice(live.start, live.end), prefer(live)), null);
      }
      return batch.units;
    } finally {
      batch = prevBatch;
    }
  };

  /**
   * Apply an assign result to the state, persist it and emit sentences.patch (or doc.replace via the
   * caller). Returns the units changed (after fact linking) and the removed ids.
   */
  const commit = (
    st: FileState,
    res: AssignResult,
    seg: Segmentation,
    o: { annotation: ChangeAnnotation | null; range: Range | null; external: boolean; emitPatch: boolean; linkAll?: boolean },
  ): { upserts: SentenceUnit[]; removed: string[] } => {
    const text = textOf(st);
    st.units = res.units;
    st.seg = seg;
    st.intentLines = intentInfo(seg, text);

    soft(
      'db.persist',
      () =>
        db.transaction(() => {
          db.upsertUnits(res.upserts);
          db.kvSet(unitsTextKey(st.file), text);
          if (res.removed.length) db.markRemoved(res.removed);
          if (o.external) db.replaceOrphans(st.file, res.orphaned);
          persistVersions(st.file, res.versions);
        }),
      undefined,
    );

    // Facts: units with new text (or every unit on import / re-anchor), preferring the annotation's facts.
    const changedIds = new Set(res.versions.map((v) => v.sentenceId));
    const toLink = o.linkAll ? res.units : res.units.filter((u) => changedIds.has(u.id));
    const annFacts = o.annotation?.factIds ?? [];
    const range = o.range;
    const linked = toLink.length
      ? linkFacts(st, toLink, (u) => (annFacts.length && range && touches(range, u.start, u.end) ? uniq([...annFacts, ...u.facts]) : u.facts))
      : new Map<string, SentenceUnit>();
    if (linked.size) {
      st.units = st.units.map((u) => linked.get(u.id) ?? u);
      soft('db.upsert linked', () => db.upsertUnits([...linked.values()]), undefined);
    }
    const byId = new Map<string, SentenceUnit>();
    for (const u of res.upserts) byId.set(u.id, linked.get(u.id) ?? u);
    for (const u of linked.values()) byId.set(u.id, u);
    const upserts = st.units.filter((u) => byId.has(u.id));

    if (o.emitPatch) {
      ctx.bus.emit({ type: 'sentences.patch', file: st.file, version: st.version, upserts, removed: res.removed, intentLines: st.intentLines });
    }
    notify(st.file, upserts, res.removed);

    if (res.editPairs.length) softAsync('voice.addEditPairs', () => ctx.voice.addEditPairs(res.editPairs));
    // lint the units whose content or context changed (pure span shifts are not upserts)
    const lintTargets = o.linkAll ? st.units : upserts;
    if (lintTargets.length) softAsync('lint.lintUnits', () => ctx.lint.lintUnits(st.file, lintTargets));
    if (lintTargets.length || res.removed.length) softAsync('lint.scheduleDocument', () => ctx.lint.scheduleDocument(st.file));

    if (!o.external) scheduleReplans(st, res);
    return { upserts, removed: res.removed };
  };

  /** Run the pending segmentation pass of a file now (synchronous). */
  const runSegment = (st: FileState): void => {
    clearSegTimers(st);
    if (st.dirty.length === 0 && st.pendingAnn === null) return;
    const pend = st.pendingAnn;
    const dirty = st.dirty;
    st.pendingAnn = null;
    st.dirty = [];
    const text = textOf(st);
    segmenting = true;
    try {
      const seg = soft('segment', () => segment(text), null);
      if (!seg) {
        // Keep the mapped units; report the intent lines at least.
        st.intentLines = soft('findIntentLines', () => findIntentLines(text), st.intentLines).map((l) => ({ start: l.start, end: l.end, line: l.line, text: l.text }));
        ctx.bus.emit({ type: 'sentences.patch', file: st.file, version: st.version, upserts: [], removed: [], intentLines: st.intentLines });
        return;
      }
      const before = st.units;
      let prev = st.units;
      let annotation = pend?.annotation ?? null;
      if (pend && annotation && pend.range && annotation.sentenceIds.length) {
        // Widen named units over the annotated range so a full-sentence replacement keeps the id. Only a
        // unit whose own text the change replaced (its mapped span collapsed, or the change lies inside
        // it) is widened and stays named: a sentence the AI text was only inserted next to (a ghost
        // accepted with the cursor at a sentence's end) keeps its text, its state and its everAi.
        const named = new Set(annotation.sentenceIds);
        const r = pend.range;
        const keep = new Set<string>();
        const known = new Set<string>();
        prev = prev.map((u) => {
          if (!named.has(u.id)) return u;
          known.add(u.id);
          const collapsed = u.start >= u.end;
          const hit = collapsed
            ? touches(r, u.start, u.end)
            : r.from === r.to
              ? u.start < r.from && r.from < u.end
              : r.from < u.end && u.start < r.to;
          if (!hit) return u;
          keep.add(u.id);
          return { ...u, start: Math.min(u.start, r.from), end: Math.max(u.end, r.to) };
        });
        if (keep.size !== known.size) annotation = { ...annotation, sentenceIds: annotation.sentenceIds.filter((id) => keep.has(id) || !known.has(id)) };
      }
      const res = soft(
        'assignUnits',
        () =>
          assignUnits({
            file: st.file,
            text,
            seg,
            prev,
            lastVersion,
            lastAiVersion,
            dirty,
            changeSource: 'local',
            annotation,
            annotatedRange: pend?.range ?? null,
            now: now(),
          }),
        null,
      );
      if (!res) {
        st.seg = seg;
        st.intentLines = intentInfo(seg, text);
        ctx.bus.emit({ type: 'sentences.patch', file: st.file, version: st.version, upserts: [], removed: [], intentLines: st.intentLines });
        return;
      }
      soft('revive known text', () => reviveKnownText(st, res, before), undefined);
      commit(st, res, seg, { annotation, range: pend?.range ?? null, external: false, emitPatch: true });
    } finally {
      segmenting = false;
    }
  };

  /* ------------------------------------------------------------------------------------ */
  /* Re-planning                                                                           */
  /* ------------------------------------------------------------------------------------ */

  function scheduleReplans(st: FileState, res: AssignResult): void {
    const byId = new Map(st.units.map((u) => [u.id, u]));
    for (const v of res.versions) {
      if (!REPLAN_TRIGGERS.has(v.origin)) continue;
      const u = byId.get(v.sentenceId);
      if (!u) continue;
      const downstream = st.units.some((x) => x.paragraphId === u.paragraphId && x.start > u.start && x.state === 'proposed');
      if (!downstream) continue;
      const key = `${st.file}\u0000${u.paragraphId}`;
      const t = replanTimers.get(key);
      if (t) clearTimeout(t);
      const file = st.file;
      const id = u.id;
      replanTimers.set(
        key,
        setTimeout(() => {
          replanTimers.delete(key);
          if (closed) return;
          softAsync('llm.replanAfterEdit', () => ctx.llm.replanAfterEdit(file, id));
        }, replanMs),
      );
    }
  }

  /* ------------------------------------------------------------------------------------ */
  /* Disk writes                                                                           */
  /* ------------------------------------------------------------------------------------ */

  const scheduleWrite = (st: FileState): void => {
    st.unsaved = true;
    if (st.writeTimer) clearTimeout(st.writeTimer);
    st.writeTimer = setTimeout(() => {
      st.writeTimer = null;
      void writeNow(st).catch((e) => log.error(`docs: cannot write ${st.file}`, String(e)));
    }, writeMs);
  };

  /** Save units + snapshot, then write the file atomically (serialized per file). */
  const writeNow = async (st: FileState): Promise<void> => {
    if (st.writeTimer) clearTimeout(st.writeTimer);
    st.writeTimer = null;
    // an external reload owns the mirror until it has replaced it (its conflict copy is in flight)
    while (st.reloading || st.writing) {
      if (st.reloading) await st.reloading.catch(() => undefined);
      if (st.writing) await st.writing;
    }
    if (!st.unsaved) return;
    if (writeHolds > 0 && !closed) {
      // a sync operation owns the files right now; try again after it
      scheduleWrite(st);
      return;
    }
    if (needsSegment(st)) runSegment(st);
    const text = textOf(st);
    st.unsaved = false;
    const p = (async () => {
      soft(
        'db.save snapshot',
        () =>
          db.transaction(() => {
            db.upsertUnits(st.units);
            db.kvSet(snapshotKey(st.file), text);
            db.kvSet(unitsTextKey(st.file), text);
          }),
        undefined,
      );
      st.writingText = text;
      try {
        await writeFileAtomic(st.abs, toDisk(text, st.form));
        st.diskText = text;
      } catch (e) {
        st.unsaved = true;
        throw e;
      } finally {
        st.writingText = null;
      }
      softAsync('build.scheduleCompile', () => ctx.build.scheduleCompile());
    })();
    st.writing = p;
    try {
      await p;
    } finally {
      st.writing = null;
    }
  };

  /* ------------------------------------------------------------------------------------ */
  /* Open / load                                                                           */
  /* ------------------------------------------------------------------------------------ */

  const newState = (rel: string, abs: string, text: string, form: DiskForm): FileState => ({
    file: rel,
    abs,
    form,
    version: 0,
    doc: toText(text),
    textCache: text,
    units: [],
    seg: emptySeg(),
    intentLines: [],
    dirty: [],
    pendingAnn: null,
    segTimer: null,
    annImmediate: null,
    writeTimer: null,
    unsaved: false,
    diskText: text,
    writingText: null,
    writing: null,
    reloading: null,
  });

  /**
   * Stored units checked against the text their spans should hold. A unit whose slice does not
   * normalize to its textNorm gets a zero-width span: overlap matching then ignores it (no merge can
   * hand its metadata to the sentence that now sits there) and only its text can re-anchor it.
   */
  const checkSpans = (units: SentenceUnit[], text: string): { units: SentenceUnit[]; bad: number } => {
    let bad = 0;
    const out = units.map((u) => {
      const inRange = u.start >= 0 && u.end <= text.length && u.start <= u.end;
      if (inRange && normalizeForHash(text.slice(u.start, u.end)) === u.textNorm) return u;
      bad++;
      return { ...u, start: 0, end: 0 };
    });
    return { units: out, bad };
  };

  const clampUnits = (units: SentenceUnit[], len: number): SentenceUnit[] =>
    units.map((u) => (u.start <= len && u.end <= len && u.start <= u.end ? u : { ...u, start: Math.min(u.start, len), end: Math.min(Math.max(u.end, u.start), len) }));

  const load = async (file: string): Promise<{ state: FileState; report: ReanchorReport | null }> => {
    const { rel, abs } = resolveInTex(ctx.paths.tex, file);
    if (!isTexName(rel)) throw new HttpError(400, `only .tex files can be opened (${rel})`);
    let raw: string;
    try {
      raw = await readFile(abs, 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new HttpError(404, `no such file in the LaTeX tree: ${rel}`);
      throw e;
    }
    const existing = states.get(rel);
    if (existing) return { state: existing, report: null };
    const { text, form } = fromDisk(raw);
    const st = newState(rel, abs, text, form);
    const seg = soft('segment', () => segment(text), null) ?? emptySeg();
    const stored = soft('db.units', () => db.units(rel), [] as SentenceUnit[]);
    const orphans = soft('db.orphans', () => db.orphans(rel), [] as SentenceUnit[]);
    const snapshot = soft('db.kvGet', () => db.kvGet(snapshotKey(rel)), undefined);
    // The text the stored units' spans refer to: the last segmented mirror (it differs from the
    // snapshot when the process died between a pass and the debounced disk write).
    const unitsText = soft('db.kvGet units text', () => db.kvGet(unitsTextKey(rel)), undefined) ?? snapshot;
    let report: ReanchorReport | null = null;
    let res: AssignResult | null = null;
    let external = false;
    let annotation: ChangeAnnotation | null = null;
    // Retro-grounding: every open links every sentence's numerals (facts may have changed since).
    const linkAll = true;
    const t = now();
    if (stored.length === 0 && orphans.length === 0) {
      // First open: import. Every sentence is the author's; provenance before the log is unknown.
      annotation = IMPORT_ANNOTATION;
      external = true;
      res = soft(
        'assignUnits (import)',
        () =>
          assignUnits({
            file: rel,
            text,
            seg,
            prev: [],
            lastVersion: () => undefined,
            lastAiVersion: () => undefined,
            changeSource: 'external',
            annotation: IMPORT_ANNOTATION,
            annotatedRange: { from: 0, to: text.length },
            now: t,
          }),
        null,
      );
    } else if (unitsText !== undefined && unitsText === text) {
      // Unchanged since the units were stored: refresh positional fields only. A stored unit whose span
      // does not hold its own text (it should not happen) is never trusted by position: it can only be
      // re-anchored by its text, so no other sentence inherits its metadata.
      const checked = checkSpans(stored, text);
      res = soft(
        'assignUnits (reopen)',
        () =>
          checked.bad === 0
            ? assignUnits({ file: rel, text, seg, prev: checked.units, lastVersion, lastAiVersion, dirty: [], changeSource: 'local', annotation: null, annotatedRange: null, now: t })
            : reanchor(text, text, seg, { file: rel, prev: [...checked.units, ...orphans], lastVersion, lastAiVersion, now: t }),
        null,
      );
      if (res && checked.bad > 0) {
        external = true;
        report = res.report;
      }
    } else {
      // Changed on disk while the app was closed: re-anchor against the last-saved snapshot.
      external = true;
      const prev = [...stored, ...orphans];
      res = soft(
        'reanchor (open)',
        () =>
          unitsText !== undefined
            ? reanchor(unitsText, text, seg, { file: rel, prev: [...checkSpans(stored, unitsText).units, ...orphans], lastVersion, lastAiVersion, now: t })
            : assignUnits({ file: rel, text, seg, prev: clampUnits(prev, text.length), lastVersion, lastAiVersion, changeSource: 'external', annotation: null, annotatedRange: null, now: t }),
        null,
      );
      if (res) report = res.report;
    }
    if (states.has(rel)) return { state: states.get(rel)!, report: null };
    states.set(rel, st);
    if (res) {
      commit(st, res, seg, { annotation, range: annotation ? { from: 0, to: text.length } : null, external, emitPatch: false, linkAll });
    } else {
      st.seg = seg;
      st.units = stored;
      st.intentLines = intentInfo(seg, text);
    }
    soft(
      'db.kvSet snapshot',
      () =>
        db.transaction(() => {
          db.upsertUnits(st.units);
          db.kvSet(snapshotKey(rel), text);
          db.kvSet(unitsTextKey(rel), text);
        }),
      undefined,
    );
    seedTombs(rel);
    if (report && (report.edited.length || report.created.length || report.orphaned.length)) {
      const unsavedLost = snapshot !== undefined && snapshot === text && unitsText !== text;
      ctx.bus.emit({
        type: 'notice',
        level: 'info',
        message: unsavedLost
          ? `${rel}: the last session ended before its latest edits were written to disk. ${report.orphaned.length} sentence(s) not on disk are kept in the sidecar and re-attach when the editor sends the text again.`
          : `${rel} changed outside the app while it was closed: ${report.edited.length} sentence(s) edited, ${report.created.length} new, ${report.orphaned.length} could not be re-anchored (kept in the sidecar).`,
      });
      history.event({ event: 'reanchor', ts: t, sentenceId: null, file: rel, source: 'open', report });
    }
    return { state: st, report };
  };

  const ensureOpen = (file: string): Promise<{ state: FileState; report: ReanchorReport | null }> => {
    if (closed) return Promise.reject(new Error('document service closed'));
    const rel = resolveInTex(ctx.paths.tex, file).rel;
    const st = states.get(rel);
    if (st) return Promise.resolve({ state: st, report: null });
    let p = opening.get(rel);
    if (!p) {
      p = load(rel).finally(() => opening.delete(rel));
      opening.set(rel, p);
    }
    return p;
  };

  const stateOf = (st: FileState): DocState => ({ file: st.file, version: st.version, text: textOf(st), units: st.units, seg: st.seg, intentLines: st.intentLines });

  const flushSegment = (st: FileState): void => {
    if (!segmenting && needsSegment(st)) runSegment(st);
  };

  const findUnit = (id: string): { st: FileState; index: number } | null => {
    for (const st of states.values()) {
      const index = st.units.findIndex((u) => u.id === id);
      if (index >= 0) return { st, index };
    }
    return null;
  };

  /* ------------------------------------------------------------------------------------ */
  /* External reload                                                                       */
  /* ------------------------------------------------------------------------------------ */

  let conflictSeq = 0;
  const saveConflictCopy = async (st: FileState, text: string): Promise<string> => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const seq = (conflictSeq++).toString(36);
    const path = join(ctx.paths.paper, 'conflicts', `${st.file.replace(/[\\/]/g, '__')}.${stamp}-${seq}.tex`);
    await writeFileAtomic(path, toDisk(text, st.form));
    return path;
  };

  /** External reloads of one file run one at a time; disk writes wait for them (see writeNow). */
  const reloadFromDisk = async (file: string, source: 'pull' | 'external'): Promise<ReanchorReport> => {
    const rel = resolveInTex(ctx.paths.tex, file).rel;
    const st0 = states.get(rel);
    if (!st0) {
      // Not mirrored: opening re-anchors against the last-saved snapshot.
      const { state, report } = await ensureOpen(rel);
      return report ?? { unchanged: state.units.length, edited: [], created: [], orphaned: [], split: [] };
    }
    const st = st0;
    const prior = st.reloading;
    const p = (async () => {
      if (prior) await prior.catch(() => undefined);
      return reloadNow(st, rel, source);
    })();
    st.reloading = p;
    try {
      return await p;
    } finally {
      if (st.reloading === p) st.reloading = null;
    }
  };

  const reloadNow = async (st: FileState, rel: string, source: 'pull' | 'external'): Promise<ReanchorReport> => {
    while (st.writing) await st.writing;
    let raw: string;
    try {
      raw = await readFile(st.abs, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        ctx.bus.emit({ type: 'notice', level: 'warn', message: `${rel} was deleted on disk; the open copy is kept and will be written back on the next edit.` });
        return { unchanged: st.units.length, edited: [], created: [], orphaned: [], split: [] };
      }
      throw e;
    }
    const disk = fromDisk(raw);
    // From here on, everything up to the mirror replacement must see the mirror the editor will lose:
    // client changes can arrive during any await (the conflict-copy write), so the plan is recomputed
    // after each await until the copy holds exactly the text that is replaced.
    let mirror = '';
    let target = disk.text;
    let keepUnsaved = false;
    let conflict = false;
    const plan = (): 'unchanged' | 'touch' | 'go' => {
      flushSegment(st);
      mirror = textOf(st);
      target = disk.text;
      keepUnsaved = false;
      conflict = false;
      if (disk.text === st.diskText && !st.unsaved) return 'unchanged';
      if (st.unsaved && mirror !== st.diskText && disk.text !== st.diskText) {
        // Local edits not yet written AND a change on disk: merge the disk change into the mirror.
        const dmp = new DiffMatchPatch();
        dmp.Diff_Timeout = 0;
        const patches = dmp.patch_make(st.diskText, disk.text);
        const [merged, applied] = dmp.patch_apply(patches, mirror);
        if (applied.every(Boolean)) {
          target = merged;
          keepUnsaved = merged !== disk.text;
        } else conflict = true;
      } else if (st.unsaved && disk.text === st.diskText) {
        // Disk did not really change (e.g. a touch); keep the local edits.
        return 'touch';
      }
      return 'go';
    };
    let step = plan();
    const copies: string[] = [];
    while (step === 'go' && conflict) {
      const saved = mirror;
      copies.push(await saveConflictCopy(st, saved));
      if (textOf(st) === saved && !needsSegment(st)) break;
      step = plan(); // the author typed during the write: copy (or merge) the newer text too
    }
    if (step !== 'go') return { unchanged: st.units.length, edited: [], created: [], orphaned: [], split: [] };
    if (conflict) {
      const copy = copies[copies.length - 1]!;
      ctx.bus.emit({ type: 'notice', level: 'warn', message: `${rel} changed on disk while you had unsaved edits that could not be merged. The disk version is now open; your text was saved to ${copy}.` });
    }
    st.form = disk.form;
    if (target === mirror) {
      st.diskText = disk.text;
      st.unsaved = keepUnsaved;
      soft('db.kvSet snapshot', () => db.kvSet(snapshotKey(rel), disk.text), undefined);
      return { unchanged: st.units.length, edited: [], created: [], orphaned: [], split: [] };
    }
    const seg = soft('segment', () => segment(target), null) ?? emptySeg();
    const orphans = soft('db.orphans', () => db.orphans(rel), [] as SentenceUnit[]);
    const t = now();
    const res = soft('reanchor', () => reanchor(mirror, target, seg, { file: rel, prev: [...st.units, ...orphans], lastVersion, lastAiVersion, now: t }), null);
    clearSegTimers(st);
    st.dirty = [];
    st.pendingAnn = null;
    st.doc = toText(target);
    st.textCache = target;
    st.version += 1;
    st.diskText = disk.text;
    let report: ReanchorReport = { unchanged: 0, edited: [], created: [], orphaned: [], split: [] };
    if (res) {
      commit(st, res, seg, { annotation: null, range: null, external: true, emitPatch: false, linkAll: false });
      report = res.report;
      // re-link facts for edited/created units (commit links only units with versions)
    } else {
      // Fall back: keep the units mapped through the diff so spans stay valid.
      const cs = soft('diffChanges', () => diffChanges(mirror, target), null);
      if (cs) st.units = mapUnits(st.units, cs, target);
      st.seg = seg;
      st.intentLines = intentInfo(seg, target);
    }
    soft('db.kvSet snapshot', () => db.transaction(() => {
      db.upsertUnits(st.units);
      db.kvSet(snapshotKey(rel), disk.text);
      db.kvSet(unitsTextKey(rel), target);
    }), undefined);
    if (keepUnsaved) scheduleWrite(st);
    else st.unsaved = false;
    ctx.bus.emit({ type: 'doc.replace', file: rel, version: st.version, text: target, units: st.units, intentLines: st.intentLines, report });
    history.event({ event: 'reanchor', ts: t, sentenceId: null, file: rel, source, report });
    const changed = report.edited.length + report.created.length;
    // A pull answers its caller with the reports (the UI shows them in its language); an edit on disk
    // has no caller, so every client gets a notice.
    if (source !== 'pull' && (changed || report.orphaned.length)) {
      const who = 'Changed on disk:';
      ctx.bus.emit({
        type: 'notice',
        level: report.orphaned.length ? 'warn' : 'info',
        message: `${who} ${changed} sentence(s) in ${rel} (${report.edited.length} edited, ${report.created.length} new)${report.orphaned.length ? `; ${report.orphaned.length} could not be re-anchored and are listed as orphans` : ''}.`,
      });
    }
    softAsync('build.scheduleCompile', () => ctx.build.scheduleCompile());
    return report;
  };

  /* ------------------------------------------------------------------------------------ */
  /* Labels of files that are not open (multi-file projects)                               */
  /* ------------------------------------------------------------------------------------ */

  /**
   * A `\ref` in sections/results.tex usually points at a label in another file of the \input tree
   * (sec:intro, a figure in main.tex). The gate blocks a \ref to an unknown label, so labels() must cover
   * the whole document, not only the files the editor has open: the main file's \input tree (current
   * mirror text for open files, disk otherwise) is walked and every file that is not open is segmented
   * from disk (cached by its text). The disk part is cached for LABELS_DISK_TTL_MS per set of open file
   * versions, so a ghost request or a lint pass does not re-read the tree on every keystroke.
   */
  const LABELS_DISK_TTL_MS = 1000;
  const diskSegLabels = new Map<string, { raw: string; labels: string[] }>();
  let unopenedCache: { key: string; at: number; labels: string[] } | null = null;
  const unopenedLabels = (): string[] => {
    const key = [...states.values()].map((st) => `${st.file}@${st.version}`).join('|');
    const t = Date.now();
    if (unopenedCache && unopenedCache.key === key && t - unopenedCache.at < LABELS_DISK_TTL_MS) return unopenedCache.labels;
    const raws = new Map<string, string | null>();
    const read = (rel: string): string | null => {
      const st = states.get(rel);
      if (st) return textOf(st);
      if (!raws.has(rel)) {
        let raw: string | null = null;
        try {
          const abs = resolveInTex(ctx.paths.tex, rel).abs;
          if (existsSync(abs) && isTexName(rel)) raw = readFileSync(abs, 'utf8');
        } catch {
          raw = null;
        }
        raws.set(rel, raw);
      }
      return raws.get(rel) ?? null;
    };
    const main = ctx.config.mainFile || 'main.tex';
    const tree = soft('flatten (labels)', () => flattenTex(main, { texRoot: ctx.paths.tex, read }).files, [] as string[]);
    const out: string[] = [];
    for (const rel of tree) {
      if (states.has(rel)) continue;
      const raw = read(rel);
      if (raw === null) continue;
      let c = diskSegLabels.get(rel);
      if (!c || c.raw !== raw) {
        c = { raw, labels: soft('segment (labels)', () => segment(fromDisk(raw).text).labels, [] as string[]) };
        diskSegLabels.set(rel, c);
      }
      out.push(...c.labels);
    }
    unopenedCache = { key, at: t, labels: out };
    return out;
  };

  /* ------------------------------------------------------------------------------------ */
  /* Service                                                                               */
  /* ------------------------------------------------------------------------------------ */

  const svc: DocServiceExt = {
    async files() {
      const main = ctx.config.mainFile;
      return sortTexFiles(listFiles(ctx.paths.tex, isTexName), main);
    },

    async open(file) {
      const { state } = await ensureOpen(file);
      flushSegment(state);
      return stateOf(state);
    },

    get(file) {
      let rel: string;
      try {
        rel = resolveInTex(ctx.paths.tex, file).rel;
      } catch {
        return undefined;
      }
      const st = states.get(rel);
      if (!st) return undefined;
      flushSegment(st);
      return stateOf(st);
    },

    async applyClientChange(msg: DocChangeMsg) {
      const rel = resolveInTex(ctx.paths.tex, msg.file).rel;
      const { state: st } = await ensureOpen(rel);
      // An annotated change waiting for its pass is segmented first, with its own annotation only.
      if (st.pendingAnn) runSegment(st);
      if (msg.baseVersion !== st.version) return false;
      let cs: ChangeSet;
      try {
        cs = ChangeSet.fromJSON(msg.changes);
      } catch (e) {
        log.warn(`docs: unreadable change for ${rel}`, e instanceof Error ? e.message : String(e));
        return false;
      }
      if (cs.length !== st.doc.length) {
        log.warn(`docs: change length ${cs.length} does not match ${rel} (${st.doc.length}); sending a snapshot`);
        return false;
      }
      if (msg.annotation && st.dirty.length) runSegment(st); // typing before an AI change gets its own pass
      if (cs.empty && !msg.annotation) {
        st.version += 1;
        return true;
      }
      const doc = cs.apply(st.doc);
      st.doc = doc;
      st.textCache = null;
      st.version += 1;
      const newText = textOf(st);
      st.units = mapUnits(st.units, cs, newText);
      const touched = changedRanges(cs);
      st.dirty = st.dirty.map((r) => ({ from: cs.mapPos(r.from, -1), to: cs.mapPos(r.to, 1) }));
      st.dirty.push(...touched);
      if (msg.annotation) {
        const range = touched.length ? { from: Math.min(...touched.map((r) => r.from)), to: Math.max(...touched.map((r) => r.to)) } : null;
        st.pendingAnn = { annotation: msg.annotation, range };
        if (st.segTimer) clearTimeout(st.segTimer);
        st.segTimer = null;
        st.annImmediate = setImmediate(() => {
          st.annImmediate = null;
          if (!closed) runSegment(st);
        });
      } else {
        if (st.segTimer) clearTimeout(st.segTimer);
        st.segTimer = setTimeout(() => {
          st.segTimer = null;
          if (!closed) runSegment(st);
        }, segMs);
      }
      if (!cs.empty) scheduleWrite(st);
      return true;
    },

    async flush(file) {
      const rel = resolveInTex(ctx.paths.tex, file).rel;
      const st = states.get(rel);
      if (!st) return;
      if (needsSegment(st)) runSegment(st);
      if (st.unsaved || st.writeTimer) {
        st.unsaved = true;
        await writeNow(st);
      } else if (st.writing) await st.writing;
    },

    reloadFromDisk,

    unit(id) {
      const f = findUnit(id);
      if (f) return f.st.units[f.index];
      return soft('db.unit', () => db.unit(id), undefined);
    },

    updateUnit(id, patch, version) {
      const f = findUnit(id);
      let current: SentenceUnit | undefined;
      let st: FileState | null = null;
      if (f) {
        st = f.st;
        current = f.st.units[f.index];
      } else {
        current = db.unit(id);
      }
      if (!current) throw new HttpError(404, `no such sentence: ${id}`);
      const { id: _i, file: _f, start: _s, end: _e, line: _l, hash: _h, textNorm: _t, ctxHash: _c, ...rest } = patch;
      void _i, _f, _s, _e, _l, _h, _t, _c;
      const next: SentenceUnit = { ...current, ...rest };
      // everAi can never be cleared; AI versions set it.
      next.everAi = current.everAi || Boolean(rest.everAi) || Boolean(version && ['ai_ghost', 'ai_intent', 'ai_draft', 'ai_rewrite', 'grammar_fix', 'replan'].includes(version.origin));
      if (st && f) {
        st.units = st.units.slice();
        st.units[f.index] = next;
      }
      const persistIt = (): void => {
        db.upsertUnits([next]);
        if (version) {
          const last = db.lastVersion(id);
          const row: SentenceVersion = { ...version, sentenceId: id, version: last ? last.version + 1 : 0, ts: now(), parentVersion: last ? last.version : null };
          persistVersions(next.file, [row]);
        }
      };
      if (batch && st && batch.file === st.file) {
        batch.units.set(id, next);
        if (version) soft('db.updateUnit', () => db.transaction(persistIt), undefined);
        return next;
      }
      soft('db.updateUnit', () => db.transaction(persistIt), undefined);
      if (st) {
        ctx.bus.emit({ type: 'sentences.patch', file: st.file, version: st.version, upserts: [next], removed: [], intentLines: st.intentLines });
      }
      notify(next.file, [next], []);
      return next;
    },

    allUnits() {
      const out: SentenceUnit[] = [];
      const main = ctx.config.mainFile;
      const files = sortTexFiles([...states.keys()], main);
      for (const f of files) {
        const st = states.get(f)!;
        flushSegment(st);
        out.push(...st.units);
      }
      return out;
    },

    unitText(id) {
      const f = findUnit(id);
      if (!f) return null;
      const u = f.st.units[f.index]!;
      const text = textOf(f.st);
      if (u.start < 0 || u.end > text.length || u.end < u.start) return null;
      return text.slice(u.start, u.end);
    },

    context(id) {
      const f0 = findUnit(id);
      if (!f0) return null;
      flushSegment(f0.st);
      const f = findUnit(id);
      if (!f) return null;
      const st = f.st;
      const u = st.units[f.index]!;
      const text = textOf(st);
      const seg = st.seg;
      const m = /\/p(\d+)$/.exec(u.paragraphId);
      const pIndex = m ? Number(m[1]) : -1;
      const para = seg.paragraphs.find((p) => p.index === pIndex) ?? seg.paragraphs.find((p) => p.start <= u.start && u.end <= p.end && p.kind === u.kind);
      const paraText = (p: (typeof seg.paragraphs)[number] | undefined): string => (p ? text.slice(p.start, p.end) : '');
      const sameSection = seg.paragraphs.filter((p) => p.sectionId === u.sectionId && p.kind === 'prose');
      const pos = para ? sameSection.findIndex((p) => p.index === para.index) : -1;
      const before = para ? text.slice(para.start, u.start) : '';
      const after = para ? text.slice(u.end, Math.max(u.end, para.end)) : '';
      const prevParas = pos > 0 ? sameSection.slice(Math.max(0, pos - 3), pos).map(paraText) : [];
      const section = seg.sections.find((s) => s.id === u.sectionId);
      return {
        before,
        after,
        paragraphBefore: pos > 0 ? paraText(sameSection[pos - 1]) : '',
        paragraphAfter: pos >= 0 && pos + 1 < sameSection.length ? paraText(sameSection[pos + 1]) : '',
        previousParagraphs: prevParas,
        sectionId: u.sectionId,
        sectionTitle: section?.title ?? '',
        part: u.part,
      };
    },

    labels() {
      const out: string[] = [];
      for (const st of states.values()) {
        flushSegment(st);
        out.push(...st.seg.labels);
      }
      out.push(...unopenedLabels());
      return uniq(out);
    },

    onUnitsChanged(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    snapshotMessage(file) {
      const rel = resolveInTex(ctx.paths.tex, file).rel;
      const st = states.get(rel);
      if (!st) throw new HttpError(404, `file not open: ${rel}`);
      flushSegment(st);
      const msg: Extract<ServerMessage, { type: 'doc.snapshot' }> = { type: 'doc.snapshot', file: rel, version: st.version, text: textOf(st), units: st.units, intentLines: st.intentLines };
      return msg;
    },

    openFiles() {
      return [...states.keys()];
    },

    isKnownDiskText(file, diskText) {
      let rel: string;
      try {
        rel = resolveInTex(ctx.paths.tex, file).rel;
      } catch {
        return false;
      }
      const st = states.get(rel);
      if (!st) return false;
      const t = fromDisk(diskText).text;
      return t === st.diskText || t === st.writingText || (t === textOf(st) && !st.unsaved);
    },

    orphans(file) {
      const rel = resolveInTex(ctx.paths.tex, file).rel;
      return soft('db.orphans', () => db.orphans(rel), []);
    },

    discardOrphan(id) {
      const u = db.unit(id);
      if (!u || !u.orphaned) throw new HttpError(404, `no such orphan: ${id}`);
      db.discardOrphan(id);
      history.event({ event: 'orphan_discarded', ts: now(), sentenceId: id, file: u.file });
    },

    async flushAll() {
      for (const st of [...states.values()]) await svc.flush(st.file);
    },

    async close() {
      if (closed) return;
      try {
        await svc.flushAll();
      } finally {
        closed = true;
        for (const t of replanTimers.values()) clearTimeout(t);
        replanTimers.clear();
        for (const st of states.values()) {
          clearSegTimers(st);
          if (st.writeTimer) clearTimeout(st.writeTimer);
          st.writeTimer = null;
        }
        await history.drain();
      }
    },

    logEvent(event, sentenceId, file, data = {}) {
      history.event({ ...data, event, ts: now(), sentenceId, file });
    },

    drainHistory() {
      return history.drain();
    },

    holdWrites() {
      writeHolds++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        writeHolds = Math.max(0, writeHolds - 1);
      };
    },

    hasPending(file) {
      const st = states.get(file);
      return !!st && (needsSegment(st) || st.unsaved || st.writeTimer !== null || st.writing !== null);
    },
  };
  return svc;
}

/** Synchronous read of a file's last-saved snapshot (tests, sync). */
export function readSnapshot(ctx: Ctx, file: string): string | undefined {
  return ctx.db.kvGet(snapshotKey(file));
}

/** Hash of mirror-form text (used to recognise our own writes). */
export function contentHash(raw: string): string {
  return hashString(fromDisk(raw).text);
}

/** True when a path exists and is readable as text. */
export function readTextIfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}
