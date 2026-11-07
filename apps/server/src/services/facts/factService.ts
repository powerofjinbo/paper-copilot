/**
 * FactService (contracts.ts): the fact store behind every number, cut and definition the AI may use.
 *
 * Lifecycle of a fact:
 * - created by the deterministic extractor (./extractor.ts) on rescan(), by addCandidates() (the repo
 *   reader names a locator, this service reads the value), or by addManual() (the author types it);
 * - the author's edits (confirmed, excluded, definition, unit, sigfigs, tags) are stored as patches by
 *   id and survive every rescan; an empty `definition` reverts to the extracted one;
 * - staleness: on rescan the value at the locator is read again. If it differs from the stored value
 *   the fact becomes `stale` and loses its confirmation (the author confirmed the old number); it stays
 *   stale until the author confirms it again (patch confirmed: true). A fact whose locator no longer
 *   resolves (artifact deleted or unreadable, field gone) is kept as stale + excluded + tag `missing`
 *   while the author patched it or a sentence links it, and dropped otherwise. A changed artifact hash
 *   alone (same value) updates artifactSha256/fingerprint without marking the fact stale.
 * - validationState is `candidate` unless evidence.jsonl has a record for the fact whose sha256 matches
 *   the fact's artifact (same artifact) or that is newer than the last value change (other artifacts):
 *   then `reproduced`, or `independently_validated` when the record's note starts with "independent".
 */
import { existsSync, statSync } from 'node:fs';
import {
  Bm25Index,
  Claim,
  EvidenceRecord,
  FactPatch,
  FigureEntry,
  ManualFact,
  RepoBriefOutput,
  TermEntry,
  derivedRelationMatches,
  derivedRelations,
  extractNumeralDetails,
  extractNumerals,
  factAliases,
  linkSentenceFacts,
  nowIso,
  type DerivedRelation,
  type Fact,
  type FactsResponse,
  type SentenceUnit,
} from '@paper-copilot/core';
import { z } from 'zod';
import { HttpError, type Ctx, type FactService } from '../../contracts';
import {
  DEFAULT_MAX_FACTS_PER_ARTIFACT,
  DEFAULT_MAX_FACTS_TOTAL,
  artifactType,
  assignStems,
  extractRepo,
  fingerprintOf,
  idSegment,
  readArtifact,
  resolveLocatorInText,
  type RawFact,
} from './extractor';
import { resolveInsideRepo } from './glob';
import { createPersister, onceLogger } from './persist';
import { createRepoWatcher, type RepoWatcher, type RepoWatcherOptions } from './repoWatcher';
import { loadFactsFile, serializeFactsFile, type BaseFact, type FactsFileData, type StoredCandidate, type StoredPatch, type StoredStatus } from './store';

export interface FactServiceOptions {
  maxFactsPerArtifact?: number;
  maxFactsTotal?: number;
}

export interface FactServiceImpl extends FactService {
  /** Wait for pending writes of facts.json. */
  flush(): Promise<void>;
  /** Rescan once if the repository was never scanned (used by GET /api/facts). */
  ensureScanned(): Promise<void>;
  scannedAt(): string | null;
  /**
   * Numbers derived from two facts (core derivedRelations over the current facts; cached until a fact's
   * value, definition, unit, tags or exclusion changes). Every gate call and linkUnit use this list.
   */
  derived(): DerivedRelation[];
  /** Watch the analysis repository's fact globs and rescan (debounced) when an artifact changes. No-op without repoDir. */
  watchRepo(opts?: RepoWatcherOptions): RepoWatcher;
  /** Stop the repository watcher (and wait for a rescan it started). */
  close(): Promise<void>;
}

type LinkResult = ReturnType<FactService['linkUnit']>;

const DEFAULT_PROMPT_LIMIT = 40;
const ID_RE = /^f\.[A-Za-z0-9_.~+-]+$/;

/** Search aids for BM25 (never shown): common abbreviations in result files. */
const GLOSSARY: Record<string, string> = {
  eff: 'efficiency',
  effs: 'efficiencies',
  sigma: 'uncertainty sigma',
  err: 'error uncertainty',
  unc: 'uncertainty',
  delta: 'difference delta',
  diff: 'difference',
  frac: 'fraction',
  n: 'number count',
  pt: 'transverse momentum pT',
  eta: 'pseudorapidity eta',
  d0: 'impact parameter d0',
  fake: 'fake',
  dup: 'duplicate',
  boot: 'bootstrap',
  seeds: 'seeds',
  pct: 'percent',
  ttbar: 'ttbar top',
};

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function valuesEqual(a: number | string, b: number | string): boolean {
  return a === b || (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b));
}

function zodMessage(e: z.ZodError): string {
  return e.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ');
}

const CandidateSchema = RepoBriefOutput.shape.fact_candidates.element;

export function createFactService(ctx: Ctx, opts: FactServiceOptions = {}): FactServiceImpl {
  const log = ctx.log;
  const warnOnce = onceLogger(log);
  let data: FactsFileData | null = null;
  let base = new Map<string, BaseFact>();
  let views: Fact[] = [];
  let viewById = new Map<string, Fact>();
  let version = 0;
  /** Bumped only when indexed content changes (ids, definitions, values, tags, units, exclusion). */
  let indexVersion = 0;
  let evidence: EvidenceRecord[] = [];
  let evidenceById = new Map<string, EvidenceRecord[]>();
  const indexEvidence = (rec: EvidenceRecord) => {
    for (const id of new Set(rec.factIds)) {
      const list = evidenceById.get(id);
      if (list) list.push(rec);
      else evidenceById.set(id, [rec]);
    }
  };
  const linkCache = new Map<string, { key: string; result: LinkResult }>();
  let claimsCache: Claim[] | null = null;
  let figuresCache: FigureEntry[] | null = null;
  let termsCache: TermEntry[] | null = null;
  let derivedCache: { version: number; relations: DerivedRelation[] } | null = null;
  let repoWatcher: RepoWatcher | null = null;

  function derived(): DerivedRelation[] {
    load();
    if (derivedCache && derivedCache.version === indexVersion) return derivedCache.relations;
    let relations: DerivedRelation[];
    try {
      relations = derivedRelations(views);
    } catch (e) {
      warnOnce('derived', 'facts: core derivedRelations failed; no derived numbers are accepted', String(e));
      relations = [];
    }
    derivedCache = { version: indexVersion, relations };
    return relations;
  }

  const persister = createPersister(
    async () => {
      if (!data) return;
      const out: FactsFileData = { ...data, facts: [...base.values()] };
      await ctx.files.writeText(ctx.paths.facts, serializeFactsFile(out));
    },
    (e) => log.error('cannot write facts.json', String(e)),
  );

  /* ---------------------------------------------------------------------------------- */
  /* State                                                                                */
  /* ---------------------------------------------------------------------------------- */

  function load(): FactsFileData {
    if (data) return data;
    data = loadFactsFile(ctx.paths.facts, log);
    base = new Map(data.facts.map((f) => [f.id, f]));
    evidence = ctx.files.readJsonl(ctx.paths.evidence, EvidenceRecord);
    evidenceById = new Map();
    for (const rec of evidence) indexEvidence(rec);
    rebuildViews();
    return data;
  }

  function evidenceLevel(b: BaseFact, st: StoredStatus | undefined): Fact['validationState'] {
    let level: Fact['validationState'] = 'candidate';
    for (const rec of evidenceById.get(b.id) ?? []) {
      const applies = rec.artifact === b.artifact ? rec.sha256 === b.artifactSha256 : !st?.changedAt || rec.ts >= st.changedAt;
      if (!applies) continue;
      if (/^\s*independent/i.test(rec.note ?? '')) return 'independently_validated';
      level = 'reproduced';
    }
    return level;
  }

  function aliasesOf(f: Fact): string[] {
    if (typeof f.value !== 'number') return [];
    try {
      return factAliases(f);
    } catch (e) {
      warnOnce('aliases', 'facts: core factAliases is unavailable; facts have no aliases yet', String(e));
      return [];
    }
  }

  function viewOf(b: BaseFact): Fact {
    const p = data!.patches[b.id];
    const st = data!.status[b.id];
    const missing = st?.missing ?? false;
    const overridden = p?.definition !== undefined && p.definition !== '';
    let tags = p?.tags ?? b.tags;
    if (missing && !tags.includes('missing')) tags = [...tags, 'missing'];
    const f: Fact = {
      id: b.id,
      kind: b.kind,
      value: b.value,
      sigfigs: p?.sigfigs !== undefined ? p.sigfigs : null,
      unit: p?.unit ?? b.unit,
      uncertainties: b.uncertainties,
      definition: overridden ? p!.definition! : b.definition,
      definitionSource: overridden ? `author (extracted: ${b.definitionSource})` : b.definitionSource,
      artifact: b.artifact,
      locator: b.locator,
      artifactSha256: b.artifactSha256,
      fingerprint: b.fingerprint,
      stale: (st?.stale ?? false) || missing,
      validationState: evidenceLevel(b, st),
      aliases: [],
      confirmed: p?.confirmed ?? b.origin === 'manual',
      excluded: missing || (p?.excluded ?? false),
      proseOnly: b.proseOnly,
      tags,
    };
    f.aliases = aliasesOf(f);
    return f;
  }

  function rebuildViews(): void {
    views = [...base.values()].map(viewOf);
    viewById = new Map(views.map((f) => [f.id, f]));
    version++;
    indexVersion++;
    linkCache.clear();
  }

  const indexKey = (f: Fact) => `${String(f.value)}|${f.definition}|${f.tags.join(',')}|${f.unit}|${f.excluded}|${JSON.stringify(f.uncertainties)}`;

  function refreshView(id: string): Fact | undefined {
    const b = base.get(id);
    if (!b) return undefined;
    const v = viewOf(b);
    const prev = viewById.get(id);
    const idx = prev ? views.indexOf(prev) : -1;
    if (idx >= 0) views[idx] = v;
    else views.push(v);
    viewById.set(id, v);
    version++;
    if (!prev || indexKey(prev) !== indexKey(v)) indexVersion++;
    linkCache.clear();
    return v;
  }

  /* Numeric prefilter for linking: core matches a numeral to a fact only when the fact value (or one
   * of its uncertainties) rounds to it at scale 1 or 100, so a sorted value index and a binary search
   * per numeral give a small superset of the candidates (results are identical to passing all facts). */
  interface ValueIndex {
    version: number;
    usable: Fact[];
    vals: Float64Array;
    owner: Int32Array;
  }
  let valueIndex: ValueIndex | null = null;

  function valueIdx(): ValueIndex {
    if (valueIndex && valueIndex.version === version) return valueIndex;
    const usable = views.filter((f) => !f.excluded && typeof f.value === 'number');
    const pairs: Array<[number, number]> = [];
    usable.forEach((f, i) => {
      pairs.push([f.value as number, i]);
      for (const u of Object.values(f.uncertainties)) if (Number.isFinite(u)) pairs.push([u, i]);
    });
    pairs.sort((a, b) => a[0] - b[0]);
    valueIndex = { version, usable, vals: Float64Array.from(pairs, (p) => p[0]), owner: Int32Array.from(pairs, (p) => p[1]) };
    return valueIndex;
  }

  function lowerBound(a: Float64Array, x: number): number {
    let lo = 0;
    let hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (a[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function candidateFacts(text: string): Fact[] {
    const vi = valueIdx();
    let nums;
    try {
      nums = extractNumerals(text);
    } catch {
      return vi.usable;
    }
    const picked = new Set<number>();
    for (const n of nums) {
      if (!Number.isFinite(n.value)) continue;
      const mag = n.value === 0 ? 0 : Math.floor(Math.log10(Math.abs(n.value)));
      const tol = Math.max(0.5 * 10 ** -Math.max(0, n.decimals), 0.5 * 10 ** (mag - Math.max(1, n.sigfigs) + 1)) * 1.000001 + 1e-12;
      for (const sign of [1, -1]) {
        for (const scale of [1, 100]) {
          const c = (sign * n.value) / scale;
          const h = tol / scale;
          for (let k = lowerBound(vi.vals, c - h); k < vi.vals.length && vi.vals[k]! <= c + h; k++) picked.add(vi.owner[k]!);
        }
      }
    }
    return [...picked].sort((a, b) => a - b).map((i) => vi.usable[i]!);
  }

  function staleIds(): string[] {
    return views.filter((f) => f.stale).map((f) => f.id).sort();
  }

  function emitUpdated(): void {
    ctx.bus.emit({ type: 'facts.updated', count: views.length, stale: staleIds() });
  }

  function linkedFactIds(): Set<string> {
    const out = new Set<string>();
    try {
      for (const u of ctx.docs.allUnits()) for (const id of u.facts) out.add(id);
    } catch {
      /* no document service (tests) or no open document */
    }
    return out;
  }

  function newStatus(now: string): StoredStatus {
    return { stale: false, missing: false, firstSeen: now, changedAt: null, previousValue: null };
  }

  /* ---------------------------------------------------------------------------------- */
  /* Rescan                                                                               */
  /* ---------------------------------------------------------------------------------- */

  function rawToBase(f: RawFact, origin: BaseFact['origin']): BaseFact {
    return { ...f, origin };
  }

  function resolveCandidate(c: StoredCandidate, repoDir: string, cache: ReadCache): BaseFact | null {
    const read = readCached(c.artifact, repoDir, cache);
    if (!read.ok) return null;
    const wantString = c.kind === 'definition' || c.kind === 'sample' || c.kind === 'setting';
    const r = resolveLocatorInText(c.artifact, read.text, c.locator, wantString);
    if (!r.ok) return null;
    const md = artifactType(c.artifact) === 'md';
    return {
      id: c.id,
      kind: c.kind,
      value: r.r.value,
      unit: r.r.unit,
      uncertainties: r.r.uncertainties,
      definition: r.r.definition,
      definitionSource: `${r.r.definitionSource}; registered by the repo reader`,
      artifact: c.artifact,
      locator: r.r.locator,
      artifactSha256: read.sha,
      fingerprint: fingerprintOf(read.sha, r.r.locator, r.r.value),
      tags: [...new Set([...r.r.tags, 'candidate', ...(md && typeof r.r.value === 'number' ? ['prose-only'] : [])])],
      proseOnly: md && typeof r.r.value === 'number',
      origin: 'candidate',
    };
  }

  type ReadCache = Map<string, ReturnType<typeof readArtifact> | { ok: false; reason: 'escape'; error: string }>;

  function readCached(rel: string, repoDir: string, cache: ReadCache) {
    let read = cache.get(rel);
    if (!read) {
      try {
        read = readArtifact(resolveInsideRepo(repoDir, rel));
      } catch (e) {
        read = { ok: false, reason: 'escape', error: e instanceof Error ? e.message : String(e) };
      }
      cache.set(rel, read);
    }
    return read;
  }

  /** Re-read an extracted fact at its locator (its artifact is no longer in the scanned set). */
  function verifyAtLocator(old: BaseFact, repoDir: string, cache: ReadCache): BaseFact | null {
    const read = readCached(old.artifact, repoDir, cache);
    if (!read.ok) return null;
    const r = resolveLocatorInText(old.artifact, read.text, old.locator, typeof old.value === 'string');
    if (!r.ok) return null;
    return { ...old, value: r.r.value, uncertainties: r.r.uncertainties, artifactSha256: read.sha, fingerprint: fingerprintOf(read.sha, old.locator, r.r.value) };
  }

  const lineOf = (locator: string) => /^md:line=(\d+)/.exec(locator)?.[1] ?? null;

  async function doScan(): Promise<{ count: number; stale: string[] }> {
    const d = load();
    const repoDir = ctx.config.repoDir;
    const globs = ctx.config.factGlobs;
    const now = nowIso();
    if (!repoDir || !existsSync(repoDir) || !statSync(repoDir).isDirectory()) {
      log.warn(repoDir ? `facts: analysis repository ${repoDir} not found; facts kept as they are` : 'facts: no analysis repository configured (repoDir); only manual facts');
      emitUpdated();
      return { count: views.length, stale: staleIds() };
    }
    if (globs.length === 0) log.info('facts: config.factGlobs is empty; no artifacts are scanned');
    // Facts the author patched or a sentence links survive every cap.
    const linked = linkedFactIds();
    const keepIds = new Set([...Object.keys(d.patches), ...linked]);
    const keepArtifacts = new Set<string>();
    for (const id of keepIds) {
      const b = base.get(id);
      if (b && b.origin === 'extractor') keepArtifacts.add(b.artifact);
    }
    const reservedIds = new Set<string>();
    for (const b of base.values()) if (b.origin === 'manual') reservedIds.add(b.id);
    const res = await extractRepo(repoDir, globs, {
      stems: d.stems,
      keepIds,
      keepArtifacts,
      reservedIds,
      log,
      maxFactsPerArtifact: opts.maxFactsPerArtifact ?? DEFAULT_MAX_FACTS_PER_ARTIFACT,
      maxFactsTotal: opts.maxFactsTotal ?? DEFAULT_MAX_FACTS_TOTAL,
    });

    // A. What the scanner extracted.
    const next = new Map<string, BaseFact>();
    const byLocator = new Map<string, string>();
    const byMdValue = new Map<string, string>();
    const index = (f: BaseFact) => {
      byLocator.set(`${f.artifact}\u0000${f.locator}`, f.id);
      const line = lineOf(f.locator);
      if (line) byMdValue.set(`${f.artifact}\u0000${line}\u0000${String(f.value)}`, f.id);
    };
    for (const f of res.facts) {
      const b = rawToBase(f, 'extractor');
      next.set(b.id, b);
      index(b);
    }
    const moveTo = (from: string, to: string) => {
      const f = next.get(from)!;
      next.delete(from);
      const moved = { ...f, id: to };
      next.set(to, moved);
      index(moved);
    };

    // B. Repo-reader candidates: read again at their locators.
    const readCache: ReadCache = new Map();
    const keptCandidates: StoredCandidate[] = [];
    const unresolvedCandidates = new Set<string>();
    const aliasOf = new Map<string, string>(); // candidate id -> extracted id now covering it
    for (const c of d.candidates) {
      const b = resolveCandidate(c, repoDir, readCache);
      if (!b) {
        keptCandidates.push(c);
        unresolvedCandidates.add(c.id);
        continue;
      }
      const line = lineOf(b.locator);
      const dupId = line ? byMdValue.get(`${b.artifact}\u0000${line}\u0000${String(b.value)}`) : byLocator.get(`${b.artifact}\u0000${b.locator}`);
      if (dupId) {
        // The scanner now extracts this value itself; keep the candidate's id when the extracted fact is new.
        if (dupId !== b.id && !base.has(dupId) && !next.has(b.id)) moveTo(dupId, b.id);
        else if (dupId !== b.id) aliasOf.set(b.id, dupId);
        continue;
      }
      keptCandidates.push(c);
      if (next.has(b.id)) {
        // A newly extracted fact (other locator) took the candidate's id: it gets a suffix instead.
        let k = 2;
        while (next.has(`${b.id}~${k}`) || base.has(`${b.id}~${k}`)) k++;
        log.warn(`facts: ${b.id} is a repo-reader fact; the extracted fact with the same id becomes ${b.id}~${k}`);
        moveTo(b.id, `${b.id}~${k}`);
      }
      next.set(b.id, b);
      index(b);
    }
    d.candidates = keptCandidates;

    // C. Manual facts are the author's; always carried over.
    for (const b of base.values()) if (b.origin === 'manual') next.set(b.id, b);

    // D. Previous facts that were not produced again.
    const scanned = new Map(res.artifacts.map((a) => [a.artifact, a]));
    const capped = new Set(res.cappedArtifacts);
    let missingNow = 0;
    let droppedQuietly = 0;
    for (const [id, old] of base) {
      if (next.has(id)) continue;
      const alias = aliasOf.get(id);
      if (alias) {
        if (d.patches[id]) {
          if (!d.patches[alias]) d.patches[alias] = d.patches[id]!;
          delete d.patches[id];
        }
        delete d.status[id];
        log.info(`facts: repo-reader fact ${id} is now extracted as ${alias}`);
        continue;
      }
      const kept = keepIds.has(id);
      const a = scanned.get(old.artifact);
      if (old.origin === 'extractor' && a && a.status === 'ok' && capped.has(old.artifact) && !kept) {
        droppedQuietly++; // dropped by a cap, not gone from the artifact
        delete d.status[id];
        continue;
      }
      if (!kept) {
        droppedQuietly++;
        delete d.status[id];
        continue;
      }
      if (old.origin === 'extractor' && !a) {
        // The artifact left the scanned set (factGlobs changed): verify the fact where it is.
        const v = verifyAtLocator(old, repoDir, readCache);
        if (v) {
          next.set(id, v);
          continue;
        }
      }
      next.set(id, old);
      const st = d.status[id] ?? newStatus(now);
      if (!st.missing) missingNow++;
      d.status[id] = { ...st, missing: true };
    }

    // E. Value changes -> stale (sticky until the author confirms again).
    let changed = 0;
    for (const [id, n] of next) {
      const old = base.get(id);
      if (!old || old === n) continue; // new, or carried over unchanged (manual, or missing)
      const st = d.status[id] ?? newStatus(now);
      if (st.missing) d.status[id] = { ...st, missing: false }; // found again
      if (!valuesEqual(old.value, n.value)) {
        changed++;
        d.status[id] = { ...(d.status[id] ?? st), stale: true, changedAt: now, previousValue: old.value };
        const p = d.patches[id];
        if (p?.confirmed) d.patches[id] = { ...p, confirmed: false, ts: now };
        log.info(`facts: ${id} changed ${String(old.value)} -> ${String(n.value)} (${n.artifact} ${n.locator}); marked stale`);
      }
    }
    for (const id of unresolvedCandidates) if (next.has(id)) d.status[id] = { ...(d.status[id] ?? newStatus(now)), missing: true };
    // Only non-default status entries are stored.
    for (const [id, st] of Object.entries(d.status)) if (!next.has(id) || (!st.stale && !st.missing && st.changedAt === null)) delete d.status[id];

    base = next;
    d.stems = res.stems;
    d.scannedAt = now;
    d.repoDir = repoDir;
    d.globs = [...globs];
    rebuildViews();
    persister.schedule();
    const stale = staleIds();
    log.info(
      `facts: scanned ${res.artifacts.length} artifact(s) in ${res.ms} ms: ${views.length} facts, ${changed} changed, ${missingNow} newly missing, ${stale.length} stale` +
        (droppedQuietly ? `, ${droppedQuietly} no longer extracted` : ''),
    );
    ctx.bus.emit({ type: 'facts.updated', count: views.length, stale });
    return { count: views.length, stale };
  }

  let running: Promise<{ count: number; stale: string[] }> | null = null;
  let queued: Promise<{ count: number; stale: string[] }> | null = null;
  function rescan(): Promise<{ count: number; stale: string[] }> {
    if (!running) {
      running = doScan().finally(() => {
        running = null;
      });
      return running;
    }
    if (!queued) {
      queued = running
        .catch(() => undefined)
        .then(() => {
          queued = null;
          return rescan();
        });
    }
    return queued;
  }

  /* ---------------------------------------------------------------------------------- */
  /* Retrieval                                                                            */
  /* ---------------------------------------------------------------------------------- */

  function indexText(f: Fact): string {
    const raw = `${f.id} ${f.definition} ${typeof f.value === 'string' ? f.value : ''} ${f.tags.join(' ')} ${f.unit}`;
    const spaced = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.~/|=;()[\]{}]+/g, ' ');
    const extra: string[] = [];
    for (const w of spaced.toLowerCase().split(/\s+/)) if (GLOSSARY[w]) extra.push(GLOSSARY[w]!);
    return `${spaced} ${extra.join(' ')}`;
  }

  interface SearchState {
    version: number;
    index: Bm25Index | null;
    /** Fallback inverted index: token -> fact ids. */
    postings: Map<string, string[]> | null;
  }
  let search: SearchState | null = null;
  const tokenize = (text: string) => [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1))];

  function searchState(): SearchState {
    if (search && search.version === indexVersion) return search;
    const docs: Array<{ id: string; text: string }> = [];
    for (const f of views) if (!f.excluded) docs.push({ id: f.id, text: indexText(f) });
    let index: Bm25Index | null = null;
    let postings: Map<string, string[]> | null = null;
    try {
      index = new Bm25Index(docs);
      void index.size; // throws while core is a stub
    } catch (e) {
      warnOnce('bm25', 'facts: core Bm25Index is unavailable; using token overlap for fact retrieval', String(e));
      index = null;
      postings = new Map();
      for (const d of docs) {
        for (const t of tokenize(d.text)) {
          const list = postings.get(t);
          if (list) list.push(d.id);
          else postings.set(t, [d.id]);
        }
      }
    }
    search = { version: indexVersion, index, postings };
    return search;
  }

  function textSearch(query: string, k: number): string[] {
    const st = searchState();
    if (st.index) {
      try {
        return st.index.search(query, k).map((h) => h.id);
      } catch (e) {
        warnOnce('bm25-search', 'facts: Bm25Index.search failed; using token overlap', String(e));
        st.index = null;
      }
    }
    if (!st.postings) {
      // BM25 failed at search time: build the fallback index once.
      search = null;
      const fresh = searchState();
      if (fresh.index || !fresh.postings) return [];
    }
    const postings = search!.postings!;
    const score = new Map<string, number>();
    for (const t of tokenize(query)) {
      const list = postings.get(t);
      if (!list || list.length > 20000) continue; // too common to rank anything
      const w = 1 / Math.log(2 + list.length);
      for (const id of list) score.set(id, (score.get(id) ?? 0) + w);
    }
    return [...score].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id]) => id);
  }

  function priorityRank(f: Fact): number {
    if (f.confirmed) return 0;
    if (f.tags.includes('claim')) return 1;
    if (f.kind === 'cut' || f.kind === 'setting') return 2;
    if (f.kind === 'definition' || f.kind === 'sample') return 3;
    return 4;
  }

  /* ---------------------------------------------------------------------------------- */
  /* Linking                                                                              */
  /* ---------------------------------------------------------------------------------- */

  function computeLinks(unit: SentenceUnit, text: string, prefer: string[]): LinkResult | null {
    const preferIds = [...new Set([...prefer, ...unit.facts])];
    const key = `${version}|${text}|${preferIds.join(',')}`;
    const hit = linkCache.get(unit.id);
    if (hit && hit.key === key) return hit.result;
    let res;
    try {
      res = linkSentenceFacts(text, candidateFacts(text), preferIds);
    } catch (e) {
      warnOnce('link', 'facts: core linkSentenceFacts is unavailable; sentences are not linked yet', String(e));
      return null;
    }
    const linked = [...res.linked];
    const ambiguous: Array<{ raw: string; candidates: string[] }> = [];
    // A numeral no fact holds may be a derived number ("2.5 times", "2.3 points higher"): the gate accepts
    // it through the same relations and links both facts of the FIRST relation that matches (relations
    // come tiered, same result row first), so linkUnit does the same, unless the sentence's own facts
    // (prefer) name another matching relation.
    let unmatched = res.unmatched.map((t) => t.raw);
    if (res.unmatched.length) {
      const rels = derived();
      if (rels.length) {
        let details: ReturnType<typeof extractNumeralDetails> = [];
        try {
          details = extractNumeralDetails(text);
        } catch {
          details = [];
        }
        unmatched = [];
        for (const tok of res.unmatched) {
          const d = details.find((x) => x.start === tok.start && x.end === tok.end);
          const hits = d ? rels.filter((r) => derivedRelationMatches(d, r)) : [];
          if (hits.length === 0) {
            unmatched.push(tok.raw);
            continue;
          }
          const preferred = hits.find((h) => h.factIds.length > 0 && h.factIds.every((id) => preferIds.includes(id)));
          linked.push(...(preferred ?? hits[0]!).factIds);
        }
      }
    }
    for (const a of res.ambiguous) {
      // Second tier: a single confirmed candidate breaks the tie.
      const confirmed = a.candidates.filter((id) => viewById.get(id)?.confirmed);
      if (confirmed.length === 1) linked.push(confirmed[0]!);
      else ambiguous.push({ raw: a.token.raw, candidates: [...a.candidates] });
    }
    // Keep links the numerals cannot re-derive: definition-type facts, and facts now missing.
    const keep = unit.facts.filter((id) => {
      const f = viewById.get(id);
      return !!f && (typeof f.value === 'string' || f.tags.includes('missing'));
    });
    const result: LinkResult = { factIds: [...new Set([...linked, ...keep])], unmatched, ambiguous };
    linkCache.set(unit.id, { key, result });
    return result;
  }

  /* ---------------------------------------------------------------------------------- */
  /* JSON stores                                                                          */
  /* ---------------------------------------------------------------------------------- */

  function readList<T>(path: string, schema: z.ZodType<T>, what: string): T[] {
    const raw = ctx.files.readJson(path, z.array(z.unknown()), []);
    const out: T[] = [];
    let bad = 0;
    for (const x of raw) {
      const p = schema.safeParse(x);
      if (p.success) out.push(p.data);
      else bad++;
    }
    if (bad) log.warn(`${what}: ignored ${bad} invalid entr${bad === 1 ? 'y' : 'ies'} in ${path}`);
    return out;
  }

  function validateList<T>(items: unknown, schema: z.ZodType<T>, what: string, key: (x: T) => string): T[] {
    if (!Array.isArray(items)) throw new HttpError(400, `${what}: expected an array`);
    const out = new Map<string, T>();
    items.forEach((x, i) => {
      const p = schema.safeParse(x);
      if (!p.success) throw new HttpError(400, `${what}[${i}]: ${zodMessage(p.error)}`);
      const k = key(p.data);
      if (out.has(k)) log.warn(`${what}: duplicate ${k}; the last one wins`);
      out.set(k, p.data);
    });
    return [...out.values()];
  }

  /* ---------------------------------------------------------------------------------- */
  /* Service                                                                              */
  /* ---------------------------------------------------------------------------------- */

  /**
   * Old values the text must not state any more: the previous value of every numeric fact that changed
   * on a rescan (kept after the author confirms the new one), and the value of every fact now missing
   * from its artifact. Pseudo-facts with id OLD_PREFIX + fact id, never excluded, for core linking.
   */
  const OLD_PREFIX = '\u0000old:';
  function oldValueFacts(): Fact[] {
    const out: Fact[] = [];
    for (const f of views) {
      const st = data!.status[f.id];
      if (!st) continue;
      if (st.missing && typeof f.value === 'number') {
        out.push({ ...f, id: OLD_PREFIX + f.id, stale: false, excluded: false, confirmed: false });
      } else if (st.changedAt !== null && typeof st.previousValue === 'number' && Number.isFinite(st.previousValue) && !valuesEqual(st.previousValue, f.value)) {
        out.push({ ...f, id: OLD_PREFIX + f.id, value: st.previousValue, uncertainties: {}, stale: false, excluded: false, confirmed: false });
      }
    }
    return out;
  }

  function staleStatements(units: ReadonlyArray<{ id: string; text: string }>): Array<{ factId: string; sentenceIds: string[] }> {
    load();
    const olds = oldValueFacts();
    if (olds.length === 0) return [];
    const byFact = new Map<string, Set<string>>();
    const isOld = (id: string) => id.startsWith(OLD_PREFIX);
    for (const u of units) {
      if (!u || typeof u.text !== 'string' || !/\d/.test(u.text)) continue;
      let quick;
      try {
        quick = linkSentenceFacts(u.text, olds, []);
      } catch {
        continue;
      }
      const near = new Set([...quick.linked, ...quick.ambiguous.flatMap((a) => a.candidates)]);
      if (near.size === 0) continue;
      // The same numeral may be held by a current fact the author CONFIRMED (the value did not change at
      // the precision written and the author re-read it, or a renamed field confirmed under its new id):
      // then it is not a stale statement. An unconfirmed current fact does not clear it: that would hand
      // the sentence's provenance to a fact nobody checked.
      const pool = [...candidateFacts(u.text).filter((f) => f.confirmed), ...olds.filter((o) => near.has(o.id))];
      let r;
      try {
        r = linkSentenceFacts(u.text, pool, []);
      } catch {
        continue;
      }
      const hits = new Set(r.linked.filter(isOld));
      for (const a of r.ambiguous) if (a.candidates.length > 0 && a.candidates.every(isOld)) for (const c of a.candidates) hits.add(c);
      for (const h of hits) {
        const id = h.slice(OLD_PREFIX.length);
        let set = byFact.get(id);
        if (!set) byFact.set(id, (set = new Set()));
        set.add(u.id);
      }
    }
    return [...byFact].sort((a, b) => a[0].localeCompare(b[0])).map(([factId, ids]) => ({ factId, sentenceIds: [...ids] }));
  }

  const service: FactServiceImpl = {
    all() {
      load();
      return [...views];
    },

    get(id) {
      load();
      return viewById.get(id);
    },

    rescan,

    patch(id, patch) {
      load();
      const parsed = FactPatch.safeParse(patch);
      if (!parsed.success) throw new HttpError(400, `invalid fact patch: ${zodMessage(parsed.error)}`);
      const b = base.get(id);
      if (!b) throw new HttpError(404, `unknown fact: ${id}`);
      const p = parsed.data;
      const now = nowIso();
      const cur: StoredPatch = { ...(data!.patches[id] ?? {}), ts: now };
      if (p.confirmed !== undefined) cur.confirmed = p.confirmed;
      if (p.excluded !== undefined) cur.excluded = p.excluded;
      if (p.definition !== undefined) {
        if (p.definition.trim() === '') delete cur.definition;
        else cur.definition = p.definition.trim();
      }
      if (p.unit !== undefined) cur.unit = p.unit.trim();
      if (p.sigfigs !== undefined) {
        if (p.sigfigs !== null && (p.sigfigs < 1 || p.sigfigs > 15)) throw new HttpError(400, 'sigfigs must be between 1 and 15 (or null)');
        cur.sigfigs = p.sigfigs;
      }
      if (p.tags !== undefined) cur.tags = [...new Set(p.tags.map((t) => t.trim()).filter(Boolean))];
      data!.patches[id] = cur;
      if (p.confirmed === true) {
        const st = data!.status[id];
        if (st?.stale) data!.status[id] = { ...st, stale: false };
      }
      const v = refreshView(id)!;
      persister.schedule();
      emitUpdated();
      return v;
    },

    addManual(fact) {
      load();
      const parsed = ManualFact.safeParse(fact);
      if (!parsed.success) throw new HttpError(400, `invalid manual fact: ${zodMessage(parsed.error)}`);
      const m = parsed.data;
      let id = m.id.trim();
      if (!id.startsWith('f.')) id = `f.${id}`;
      if (!ID_RE.test(id) || id.length > 200) throw new HttpError(400, `invalid fact id "${m.id}": use letters, digits and . _ - ~ + (e.g. f.manual.lumi)`);
      const existing = base.get(id);
      if (existing && existing.origin !== 'manual') throw new HttpError(409, `fact id ${id} already exists (from ${existing.artifact} ${existing.locator})`);
      if (typeof m.value === 'number' && !Number.isFinite(m.value)) throw new HttpError(400, 'value must be a finite number');
      for (const [k, u] of Object.entries(m.uncertainties)) if (!Number.isFinite(u)) throw new HttpError(400, `uncertainty ${k} must be a finite number`);
      if (!m.definition.trim()) throw new HttpError(400, 'a manual fact needs a definition');
      const now = nowIso();
      const b: BaseFact = {
        id,
        kind: m.kind,
        value: typeof m.value === 'string' ? m.value.trim() : m.value,
        unit: m.unit.trim(),
        uncertainties: { ...m.uncertainties },
        definition: m.definition.trim(),
        definitionSource: 'author (manual entry)',
        artifact: '(manual)',
        locator: 'manual',
        artifactSha256: '',
        fingerprint: fingerprintOf('', 'manual', m.value),
        tags: ['manual'],
        proseOnly: false,
        origin: 'manual',
      };
      if (existing && !valuesEqual(existing.value, b.value)) {
        data!.status[id] = { ...(data!.status[id] ?? newStatus(now)), changedAt: now, previousValue: existing.value };
      }
      base.set(id, b);
      const v = refreshView(id)!;
      persister.schedule();
      emitUpdated();
      return v;
    },

    async addCandidates(candidates) {
      load();
      const added: Fact[] = [];
      const rejected: Array<{ candidate: unknown; reason: string }> = [];
      const repoDir = ctx.config.repoDir;
      if (!Array.isArray(candidates)) return { added, rejected: [{ candidate: candidates, reason: 'expected an array of candidates' }] };
      if (!repoDir || !existsSync(repoDir)) {
        for (const c of candidates) rejected.push({ candidate: c, reason: 'no analysis repository configured' });
        return { added, rejected };
      }
      const d = data!;
      const now = nowIso();
      const reads = new Map<string, ReturnType<typeof readArtifact>>();
      const locIndex = new Map<string, string>();
      const mdIndex = new Map<string, string>();
      const mdKey = (artifact: string, locator: string, value: number | string) => {
        const line = /^md:line=(\d+)/.exec(locator)?.[1];
        return line ? `${artifact}\u0000${line}\u0000${String(value)}` : null;
      };
      for (const b of base.values()) {
        locIndex.set(`${b.artifact}\u0000${b.locator}`, b.id);
        const k = mdKey(b.artifact, b.locator, b.value);
        if (k) mdIndex.set(k, b.id);
      }
      let changed = false;
      for (const raw of candidates) {
        const parsed = CandidateSchema.safeParse(raw);
        if (!parsed.success) {
          rejected.push({ candidate: raw, reason: `invalid candidate: ${zodMessage(parsed.error)}` });
          continue;
        }
        const c = parsed.data;
        const rel = c.artifact.replace(/\\/g, '/').replace(/^\.\//, '');
        let abs: string;
        try {
          abs = resolveInsideRepo(repoDir, rel);
        } catch (e) {
          rejected.push({ candidate: raw, reason: e instanceof Error ? e.message : String(e) });
          continue;
        }
        if (!artifactType(rel)) {
          rejected.push({ candidate: raw, reason: `unsupported artifact type (${rel}); use .json, .csv, .tsv or .md` });
          continue;
        }
        let read = reads.get(rel);
        if (!read) {
          read = readArtifact(abs);
          reads.set(rel, read);
        }
        if (!read.ok) {
          rejected.push({ candidate: raw, reason: `cannot read ${rel}: ${read.error}` });
          continue;
        }
        const wantString = c.kind === 'definition' || c.kind === 'sample' || c.kind === 'setting';
        const r = resolveLocatorInText(rel, read.text, c.locator, wantString);
        if (!r.ok) {
          rejected.push({ candidate: raw, reason: `locator does not resolve: ${r.reason}` });
          continue;
        }
        // Already known: same locator, the value this uncertainty belongs to, or the same number on
        // the same markdown line.
        const mk = mdKey(rel, r.r.locator, r.r.value);
        const dupId =
          locIndex.get(`${rel}\u0000${r.r.locator}`) ?? (r.r.coveredBy ? locIndex.get(`${rel}\u0000${r.r.coveredBy}`) : undefined) ?? (mk ? mdIndex.get(mk) : undefined);
        if (dupId) {
          added.push(viewById.get(dupId) ?? viewOf(base.get(dupId)!));
          continue;
        }
        if (!d.stems[rel]) d.stems = assignStems([rel], d.stems);
        const stem = d.stems[rel]!;
        let idPath = r.r.idPath;
        if (!idPath) {
          const proposed = c.proposed_id.replace(/^f\./, '').split('.').map((s) => idSegment(s)).filter((s) => s !== '_');
          if (proposed.length > 1 && proposed[0]!.toLowerCase() === stem.toLowerCase()) proposed.shift();
          idPath = proposed.join('.') || `line${/md:line=(\d+)/.exec(r.r.locator)?.[1] ?? '0'}`;
        }
        let id = `f.${stem}.${idPath}`;
        if (base.has(id)) {
          let k = 2;
          while (base.has(`${id}~${k}`)) k++;
          id = `${id}~${k}`;
        }
        const md = artifactType(rel) === 'md';
        const proseOnly = md && typeof r.r.value === 'number';
        const b: BaseFact = {
          id,
          kind: c.kind,
          value: r.r.value,
          unit: r.r.unit,
          uncertainties: r.r.uncertainties,
          definition: r.r.definition,
          definitionSource: `${r.r.definitionSource}; registered by the repo reader`,
          artifact: rel,
          locator: r.r.locator,
          artifactSha256: read.sha,
          fingerprint: fingerprintOf(read.sha, r.r.locator, r.r.value),
          tags: [...new Set([...r.r.tags, 'candidate', ...(proseOnly ? ['prose-only'] : [])])],
          proseOnly,
          origin: 'candidate',
        };
        base.set(id, b);
        locIndex.set(`${rel}\u0000${b.locator}`, id);
        if (mk) mdIndex.set(mk, id);
        d.candidates.push({ id, artifact: rel, locator: b.locator, kind: c.kind, proposedId: c.proposed_id, paraphrase: c.definition_paraphrase, condition: c.condition, addedAt: now });
        changed = true;
        added.push(viewOf(b));
      }
      if (changed) {
        rebuildViews();
        persister.schedule();
        emitUpdated();
      }
      return { added: added.map((f) => viewById.get(f.id) ?? f), rejected };
    },

    forPrompt({ factIds, query, limit }) {
      load();
      const max = Number.isFinite(limit) ? Math.max(1, Math.floor(limit!)) : DEFAULT_PROMPT_LIMIT;
      const out: Fact[] = [];
      const seen = new Set<string>();
      const push = (f: Fact | undefined) => {
        if (!f || f.excluded || seen.has(f.id) || out.length >= max) return;
        seen.add(f.id);
        out.push(f);
      };
      for (const id of factIds ?? []) push(viewById.get(id));
      if (out.length >= max) return out;
      const q = query?.trim();
      if (q) {
        for (const id of textSearch(q, max * 2)) push(viewById.get(id));
        return out;
      }
      const ranked = views
        .map((f, i) => ({ f, i, r: priorityRank(f) }))
        .filter((x) => !x.f.excluded)
        .sort((a, b) => a.r - b.r || a.i - b.i);
      for (const x of ranked) {
        if (out.length >= max) break;
        push(x.f);
      }
      return out;
    },

    linkUnit(unit, text, prefer) {
      load();
      const res = computeLinks(unit, text, prefer ?? []);
      if (!res) return { factIds: [...unit.facts], unmatched: [], ambiguous: [] };
      if (!sameStrings(res.factIds, unit.facts)) {
        try {
          ctx.docs.updateUnit(unit.id, { facts: res.factIds });
        } catch (e) {
          log.warn(`facts: cannot store linked facts on unit ${unit.id}`, String(e));
        }
      }
      return { factIds: [...res.factIds], unmatched: [...res.unmatched], ambiguous: res.ambiguous.map((a) => ({ raw: a.raw, candidates: [...a.candidates] })) };
    },

    unresolved() {
      load();
      let units: SentenceUnit[];
      try {
        units = ctx.docs.allUnits();
      } catch {
        return [];
      }
      const out: FactsResponse['unresolved'] = [];
      for (const u of units) {
        if (u.orphaned) continue;
        let text: string | null;
        try {
          text = ctx.docs.unitText(u.id);
        } catch {
          text = null;
        }
        if (!text) continue;
        const res = computeLinks(u, text, []);
        if (!res) return [];
        const where = { file: u.file, line: u.line, text: text.length > 400 ? `${text.slice(0, 399)}…` : text };
        for (const raw of res.unmatched) out.push({ sentenceId: u.id, raw, candidates: [], ...where });
        for (const a of res.ambiguous) out.push({ sentenceId: u.id, raw: a.raw, candidates: a.candidates, ...where });
      }
      return out;
    },

    claims() {
      claimsCache ??= readList(ctx.paths.claims, Claim, 'claims');
      return [...claimsCache];
    },

    figures() {
      figuresCache ??= readList(ctx.paths.figures, FigureEntry, 'figures');
      return [...figuresCache];
    },

    terminology() {
      termsCache ??= readList(ctx.paths.terminology, TermEntry, 'terminology');
      return [...termsCache];
    },

    async saveClaims(claims) {
      const list = validateList(claims, Claim, 'claims', (c) => c.claimId);
      await ctx.files.writeJson(ctx.paths.claims, list);
      claimsCache = list;
    },

    async saveFigures(figures) {
      const list = validateList(figures, FigureEntry, 'figures', (f) => f.figureId);
      await ctx.files.writeJson(ctx.paths.figures, list);
      figuresCache = list;
    },

    async saveTerminology(terms) {
      const list = validateList(terms, TermEntry, 'terminology', (t) => t.term.toLowerCase());
      await ctx.files.writeJson(ctx.paths.terminology, list);
      termsCache = list;
    },

    async addEvidence(rec) {
      load();
      const parsed = EvidenceRecord.safeParse(rec);
      if (!parsed.success) throw new HttpError(400, `invalid evidence record: ${zodMessage(parsed.error)}`);
      const unknown = parsed.data.factIds.filter((id) => !base.has(id));
      if (unknown.length) log.warn(`evidence names unknown fact(s): ${unknown.join(', ')}`);
      await ctx.files.appendJsonl(ctx.paths.evidence, parsed.data);
      evidence.push(parsed.data);
      indexEvidence(parsed.data);
      for (const id of parsed.data.factIds) refreshView(id);
      emitUpdated();
    },

    flush: () => persister.flush(),

    async ensureScanned() {
      load();
      if (running) {
        await running.catch(() => undefined);
        return;
      }
      if (!data!.scannedAt && ctx.config.repoDir) await rescan();
    },

    scannedAt() {
      return load().scannedAt;
    },

    derived,

    staleStatements,

    watchRepo(wopts) {
      if (repoWatcher) return repoWatcher;
      repoWatcher = createRepoWatcher(ctx, { rescan: () => rescan(), staleIds: () => (load(), staleIds()) }, wopts);
      return repoWatcher;
    },

    async close() {
      const w = repoWatcher;
      repoWatcher = null;
      if (w) await w.close();
    },
  };
  return service;
}
