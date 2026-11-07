/**
 * LitService (contracts.ts): .bib keys, their INSPIRE resolution, and the citation allowlist.
 *
 * - The .bib files (config.bibFiles, relative to texRoot) are parsed lazily and re-parsed whenever a
 *   file's mtime or size changes, so records()/allowedKeys() always follow the bibliography on disk.
 * - resolveAll() looks every key up on INSPIRE: by arXiv eprint, else DOI, else exact title (a weaker
 *   identifier is tried only when the stronger one found nothing). First lookups by arXiv/DOI are
 *   batched (`arxiv:A or doi:"B" ...`, 10 per request). A key is `resolved` only when INSPIRE returned
 *   exactly one record matching its identifier (eprint or DOI equal, or the normalised title equal);
 *   two or more matches leave it `unresolved` (ambiguous; the candidates are kept in the cache).
 *   When INSPIRE knows none of a key's identifiers, Semantic Scholar is asked for the exact arXiv id /
 *   DOI (optional; same rule: the returned record must repeat the identifier).
 * - Results are cached per key in .paper/lit/<key>.json (definite answers only; a network failure is
 *   never cached). Positive results are reused until the key's identifiers change in the .bib;
 *   "none"/"many" answers are retried after `negativeTtlMs` (7 days) or with force.
 * - Offline: the first network error switches the run to offline; remaining keys keep their cached
 *   status and nothing throws.
 * - `user_confirmed` (confirm()) is stored in .paper/lit/index.json; a resolved key stays `resolved`.
 * - allowedKeys() = resolved + user_confirmed keys with titles; brief() is deterministic (sorted).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hashString, nowIso, type LitRecord } from '@paper-copilot/core';
import { z } from 'zod';
import { HttpError, type Ctx, type LitService } from '../../contracts';
import { safeJoin } from '../../infra';
import { createPersister } from '../facts/persist';
import { parseBibText, renderAuthors, type BibEntry } from './bib';
import {
  RateLimiter,
  createInspireClient,
  lookupQuery,
  normalizeTitle,
  recordMatches,
  stripArxivVersion,
  type FetchLike,
  type InspireRecord,
  type LookupBy,
} from './inspire';
import { createS2Client } from './semanticScholar';

export interface LitServiceOptions {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  inspireBaseUrl?: string;
  s2BaseUrl?: string;
  /** Ask Semantic Scholar for arXiv ids / DOIs INSPIRE does not know (default true). */
  semanticScholar?: boolean;
  /** Re-ask "not found" / "ambiguous" answers after this long (default 7 days). */
  negativeTtlMs?: number;
  batchSize?: number;
}

export interface ResolveOptions {
  /** Ignore the cache. */
  force?: boolean;
  /** Only these keys. */
  keys?: string[];
  progress?: (message: string) => void;
}

export interface LitServiceImpl extends LitService {
  resolveAll(opts?: ResolveOptions): Promise<LitRecord[]>;
  confirm(key: string, confirmed?: boolean): LitRecord;
  record(key: string): LitRecord | undefined;
  flush(): Promise<void>;
  /** HTTP requests sent to INSPIRE and Semantic Scholar by this service. */
  requestCount(): number;
  bibErrors(): string[];
}

const CachedRecord = z.object({
  recid: z.number().int().nullable(),
  texkey: z.string().nullable(),
  title: z.string(),
  authors: z.array(z.string()),
  collaborations: z.array(z.string()),
  arxiv: z.array(z.string()),
  dois: z.array(z.string()),
  abstract: z.string().nullable(),
  year: z.number().int().nullable(),
});

const Quotable = z.object({ claim: z.string(), quote: z.string(), locator: z.string() });

export const LitCacheEntry = z.object({
  schemaVersion: z.literal(1),
  key: z.string(),
  /** The .bib identifiers this answer is for. */
  ids: z.object({ arxiv: z.string().nullable(), doi: z.string().nullable(), title: z.string() }),
  lookup: z.object({ by: z.enum(['arxiv', 'doi', 'title']), value: z.string(), query: z.string() }).nullable(),
  fetchedAt: z.string(),
  outcome: z.enum(['one', 'none', 'many']),
  source: z.enum(['inspire', 'semantic_scholar']),
  total: z.number().int(),
  record: CachedRecord.nullable(),
  candidates: z.array(z.object({ recid: z.number().int().nullable(), texkey: z.string().nullable(), title: z.string() })),
  quotable: z.array(Quotable).default([]),
  usableFor: z.array(z.string()).default([]),
});
export type LitCacheEntry = z.infer<typeof LitCacheEntry>;

const IndexFile = z.object({
  schemaVersion: z.literal(1),
  confirmed: z.record(z.string(), z.object({ ts: z.string() })),
  lastResolveAt: z.string().nullable(),
});
type IndexFile = z.infer<typeof IndexFile>;

/** File name of a key's cache entry: the key if it is filename-safe, else a sanitised key + hash. */
export function cacheFileName(key: string): string {
  let s = key.replace(/[^A-Za-z0-9._-]/g, '_');
  if (s !== key || /^index$/i.test(s) || s.startsWith('.') || s.length > 100) s = `${s.slice(0, 80)}-${hashString(key).slice(0, 8)}`;
  return `${s}.json`;
}

function firstSentence(text: string, max = 240): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const re = /[.!?](?=\s+[A-Z(])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    if (m.index >= 40) return t.slice(0, m.index + 1).slice(0, max);
  }
  return t.length > max ? t.slice(0, max - 3) + '...' : t;
}

function lookupSteps(e: BibEntry): Array<{ by: LookupBy; value: string }> {
  const out: Array<{ by: LookupBy; value: string }> = [];
  if (e.arxiv) out.push({ by: 'arxiv', value: e.arxiv });
  if (e.doi) out.push({ by: 'doi', value: e.doi });
  if (normalizeTitle(e.title).split(' ').filter(Boolean).length >= 3) out.push({ by: 'title', value: e.title });
  return out;
}

function sameIds(c: LitCacheEntry, e: BibEntry): boolean {
  return (c.ids.arxiv ?? null) === (e.arxiv ?? null) && (c.ids.doi ?? '').toLowerCase() === (e.doi ?? '').toLowerCase() && normalizeTitle(c.ids.title) === normalizeTitle(e.title);
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export function createLitService(ctx: Ctx, opts: LitServiceOptions = {}): LitServiceImpl {
  const log = ctx.log;
  const now = opts.now ?? (() => Date.now());
  const negativeTtlMs = opts.negativeTtlMs ?? 7 * 24 * 3600 * 1000;
  const batchSize = Math.max(1, opts.batchSize ?? 10);
  const useS2 = opts.semanticScholar ?? true;
  // One limiter per service, shared by every run, so two runs never exceed INSPIRE's limit together.
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
  const inspireLimiter = new RateLimiter({ max: 15, windowMs: 5000, now, sleep });
  let requests = 0;

  let bib: { stamp: string; entries: BibEntry[]; byKey: Map<string, BibEntry>; errors: string[] } | null = null;
  const cache = new Map<string, LitCacheEntry>();
  let index: IndexFile | null = null;
  const dirtyKeys = new Set<string>();

  const persister = createPersister(
    async () => {
      for (const k of [...dirtyKeys]) {
        const c = cache.get(k);
        if (c) await ctx.files.writeJson(join(ctx.paths.litDir, cacheFileName(k)), c);
        // Clean only once on disk, and only if not settled again meanwhile.
        if (cache.get(k) === c) dirtyKeys.delete(k);
      }
      if (index) await ctx.files.writeJson(ctx.paths.litIndex, index);
      await ctx.files.writeText(ctx.paths.litBrief, service.brief() + '\n');
    },
    (e) => log.error('cannot write literature files', String(e)),
  );

  function texRoot(): string {
    return ctx.config.texRoot || ctx.paths.tex;
  }

  function bibPaths(): Array<{ rel: string; abs: string | null }> {
    return ctx.config.bibFiles.map((rel) => {
      try {
        return { rel, abs: safeJoin(texRoot(), rel) };
      } catch (e) {
        log.warn(`lit: ignoring bib file ${rel}: ${e instanceof Error ? e.message : String(e)}`);
        return { rel, abs: null };
      }
    });
  }

  function stampOf(files: Array<{ rel: string; abs: string | null }>): string {
    return files
      .map(({ rel, abs }) => {
        if (!abs) return `${rel}:invalid`;
        try {
          const st = statSync(abs);
          return `${rel}:${st.mtimeMs}:${st.size}`;
        } catch {
          return `${rel}:missing`;
        }
      })
      .join('|');
  }

  function loadCacheFor(keys: Iterable<string>): void {
    for (const key of keys) {
      if (dirtyKeys.has(key)) continue; // newer in memory than on disk (write pending)
      const p = join(ctx.paths.litDir, cacheFileName(key));
      if (!existsSync(p)) {
        cache.delete(key);
        continue;
      }
      try {
        const parsed = LitCacheEntry.safeParse(JSON.parse(readFileSync(p, 'utf8')));
        if (parsed.success && parsed.data.key === key) cache.set(key, parsed.data);
        else log.warn(`lit: ignoring invalid cache file ${p}`);
      } catch (e) {
        log.warn(`lit: cannot read cache file ${p}`, String(e));
      }
    }
  }

  function loadIndex(): IndexFile {
    if (index) return index;
    const fallback: IndexFile = { schemaVersion: 1, confirmed: {}, lastResolveAt: null };
    const read = ctx.files.readJson(ctx.paths.litIndex, IndexFile, fallback);
    // .bib keys are user data: a key named "constructor" or "toString" must not find Object.prototype's
    // member and pass as confirmed, and "__proto__" must stay a plain key (SEC2-3).
    const confirmed: IndexFile['confirmed'] = Object.create(null);
    for (const [k, v] of Object.entries(read.confirmed ?? {})) Object.defineProperty(confirmed, k, { value: v, enumerable: true, writable: true, configurable: true });
    index = { ...read, confirmed };
    return index;
  }

  function ensureBib(force = false): NonNullable<typeof bib> {
    loadIndex();
    const files = bibPaths();
    const stamp = stampOf(files);
    if (bib && !force && bib.stamp === stamp) return bib;
    const entries: BibEntry[] = [];
    const byKey = new Map<string, BibEntry>();
    const errors: string[] = [];
    for (const { rel, abs } of files) {
      if (!abs) continue;
      let text: string;
      try {
        text = readFileSync(abs, 'utf8');
      } catch {
        errors.push(`${rel}: file not found`);
        continue;
      }
      const res = parseBibText(text, rel);
      errors.push(...res.errors);
      for (const e of res.entries) {
        if (byKey.has(e.key)) {
          errors.push(`${rel}: duplicate key ${e.key} (the first definition, in ${byKey.get(e.key)!.file}, is used)`);
          continue;
        }
        byKey.set(e.key, e);
        entries.push(e);
      }
    }
    if (errors.length) log.warn(`lit: ${errors.length} problem(s) reading the bibliography`, errors.slice(0, 10));
    bib = { stamp, entries, byKey, errors };
    loadCacheFor(byKey.keys());
    return bib;
  }

  function authorsOf(r: InspireRecord): string {
    if (r.collaborations.length && r.authors.length > 10) return r.collaborations.map((c) => (/collaboration/i.test(c) ? c : `${c} Collaboration`)).join(', ');
    return renderAuthors(r.authors, false);
  }

  function toRecord(e: BibEntry): LitRecord {
    const c = cache.get(e.key);
    const applies = !!c && sameIds(c, e);
    const r = applies && c.outcome === 'one' ? c.record : null;
    const confirmed = Object.hasOwn(loadIndex().confirmed, e.key);
    return {
      key: e.key,
      status: r ? 'resolved' : confirmed ? 'user_confirmed' : 'unresolved',
      texkey: r?.texkey ?? null,
      recid: r?.recid ?? null,
      arxiv: e.arxiv ?? (r?.arxiv[0] ? stripArxivVersion(r.arxiv[0]) : null),
      doi: e.doi ?? r?.dois[0] ?? null,
      title: e.title || r?.title || '',
      authors: e.authors || (r ? authorsOf(r) : ''),
      year: e.year ?? r?.year ?? null,
      abstract: r?.abstract ?? e.abstract ?? null,
      quotable: c?.quotable ?? [],
      usableFor: c?.usableFor ?? [],
      source: r && c ? c.source : 'bib',
    };
  }

  function settle(e: BibEntry, outcome: LitCacheEntry['outcome'], source: LitCacheEntry['source'], step: { by: LookupBy; value: string } | null, record: InspireRecord | null, matches: InspireRecord[], total: number): void {
    const prev = cache.get(e.key);
    cache.set(e.key, {
      schemaVersion: 1,
      key: e.key,
      ids: { arxiv: e.arxiv, doi: e.doi, title: e.title },
      lookup: step ? { by: step.by, value: step.value, query: lookupQuery(step.by, step.value) } : null,
      fetchedAt: new Date(now()).toISOString(),
      outcome,
      source,
      total,
      record,
      candidates: matches.slice(0, 10).map((m) => ({ recid: m.recid, texkey: m.texkey, title: m.title })),
      quotable: prev?.quotable ?? [],
      usableFor: prev?.usableFor ?? [],
    });
    dirtyKeys.add(e.key);
  }

  async function doResolve(o: ResolveOptions): Promise<LitRecord[]> {
    const b = ensureBib();
    const progress = o.progress ?? (() => undefined);
    const inspire = createInspireClient({ fetch: opts.fetch, sleep, now, baseUrl: opts.inspireBaseUrl, limiter: inspireLimiter, log });
    const s2 = useS2 ? createS2Client({ fetch: opts.fetch, sleep, now, baseUrl: opts.s2BaseUrl }) : null;
    const wanted = o.keys ? new Set(o.keys) : null;
    const entries = b.entries.filter((e) => !wanted || wanted.has(e.key));
    const t = now();
    const todo = entries.filter((e) => {
      const c = cache.get(e.key);
      if (!c || o.force || !sameIds(c, e)) return true;
      return c.outcome !== 'one' && t - Date.parse(c.fetchedAt) >= negativeTtlMs;
    });
    progress(`${entries.length - todo.length} of ${entries.length} keys cached; looking up ${todo.length} on INSPIRE`);
    const settled = new Set<string>();
    const failed = new Set<string>();
    const nextStep = new Map<string, number>();
    const done = (e: BibEntry) => settled.add(e.key);

    // 1. Batched first lookups (arXiv / DOI).
    const batchable = todo.filter((e) => {
      const s = lookupSteps(e)[0];
      return s && s.by !== 'title';
    });
    for (const group of chunks(batchable, batchSize)) {
      if (inspire.offline()) break;
      const firsts = group.map((e) => ({ e, s: lookupSteps(e)[0]! }));
      const r = await inspire.search(firsts.map(({ s }) => lookupQuery(s.by, s.value)).join(' or '), Math.min(250, group.length * 5));
      if (!r.ok) {
        if (r.offline) break;
        continue; // e.g. the combined query was refused: look these keys up one by one below
      }
      const truncated = r.total > r.hits.length;
      for (const { e, s } of firsts) {
        const m = r.hits.filter((h) => recordMatches(s.by, s.value, h));
        if (m.length > 1) {
          settle(e, 'many', 'inspire', s, null, m, m.length);
          done(e);
        } else if (truncated) {
          continue; // cannot tell "one" or "none" from a truncated page: ask individually
        } else if (m.length === 1) {
          settle(e, 'one', 'inspire', s, m[0]!, m, 1);
          done(e);
        } else {
          nextStep.set(e.key, 1);
        }
      }
      progress(`INSPIRE: ${settled.size} of ${todo.length} keys answered`);
    }

    // 2. Individual lookups: titles, fallbacks after an empty answer, keys of failed batches.
    for (const e of todo) {
      if (settled.has(e.key)) continue;
      if (inspire.offline()) break;
      const steps = lookupSteps(e);
      if (steps.length === 0) {
        settle(e, 'none', 'inspire', null, null, [], 0);
        done(e);
        continue;
      }
      let answered = false;
      for (let i = nextStep.get(e.key) ?? 0; i < steps.length; i++) {
        const s = steps[i]!;
        const r = await inspire.search(lookupQuery(s.by, s.value), s.by === 'title' ? 10 : 5);
        if (!r.ok) {
          failed.add(e.key);
          answered = true;
          break;
        }
        const m = r.hits.filter((h) => recordMatches(s.by, s.value, h));
        if (m.length === 1) {
          settle(e, 'one', 'inspire', s, m[0]!, m, 1);
          answered = true;
          break;
        }
        if (m.length > 1) {
          settle(e, 'many', 'inspire', s, null, m, m.length);
          answered = true;
          break;
        }
      }
      if (!answered) {
        // INSPIRE knows none of the identifiers.
        const exact = e.arxiv ? ({ by: 'arxiv', value: e.arxiv } as const) : e.doi ? ({ by: 'doi', value: e.doi } as const) : null;
        if (s2 && exact) {
          const r2 = await s2.lookup(exact.by, exact.value);
          if (r2.ok && r2.record) settle(e, 'one', 'semantic_scholar', exact, r2.record, [r2.record], 1);
          else if (r2.ok) settle(e, 'none', 'inspire', exact, null, [], 0);
          else failed.add(e.key);
        } else {
          settle(e, 'none', 'inspire', steps[steps.length - 1]!, null, [], 0);
        }
      }
      if (!failed.has(e.key)) done(e);
      progress(`INSPIRE: ${settled.size} of ${todo.length} keys answered`);
    }
    requests += inspire.requests() + (s2?.requests() ?? 0);
    const offline = inspire.offline();
    const left = todo.filter((e) => !settled.has(e.key)).length;
    const idx = loadIndex();
    idx.lastResolveAt = nowIso();
    persister.schedule();
    await persister.flush();
    const records = entries.map(toRecord);
    const resolved = records.filter((r) => r.status === 'resolved').length;
    const msg = `literature: ${resolved} of ${records.length} keys resolved` + (left ? `; ${left} not looked up (${offline ? 'offline' : 'lookup failed'}; status unchanged)` : '');
    if (left) log.warn(msg);
    else log.info(msg);
    progress(msg);
    return service.records();
  }

  let running: Promise<LitRecord[]> | null = null;

  const service: LitServiceImpl = {
    records() {
      return ensureBib().entries.map(toRecord);
    },

    record(key) {
      const e = ensureBib().byKey.get(key);
      return e ? toRecord(e) : undefined;
    },

    allowedKeys() {
      return service
        .records()
        .filter((r) => r.status === 'resolved' || r.status === 'user_confirmed')
        .map((r) => ({ key: r.key, title: r.title }));
    },

    bibKeys() {
      return ensureBib().entries.map((e) => e.key);
    },

    bibErrors() {
      return [...ensureBib().errors];
    },

    async reloadBib() {
      ensureBib(true);
    },

    resolveAll(o: ResolveOptions = {}) {
      if (running) return running;
      running = doResolve(o).finally(() => {
        running = null;
      });
      return running;
    },

    confirm(key, confirmed = true) {
      const e = ensureBib().byKey.get(key);
      if (!e) throw new HttpError(404, `unknown .bib key: ${key}`);
      const idx = loadIndex();
      if (confirmed) idx.confirmed[key] = { ts: nowIso() };
      else delete idx.confirmed[key];
      persister.schedule();
      return toRecord(e);
    },

    brief() {
      const recs = service.records().filter((r) => r.status === 'resolved' || r.status === 'user_confirmed');
      recs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      if (recs.length === 0) return 'Literature: no .bib key is resolved or confirmed yet. Write [ref] instead of any \\cite.';
      const lines = ['Literature: the only .bib keys that may be cited (resolved on INSPIRE / Semantic Scholar, or confirmed by the author).'];
      for (const r of recs) {
        const bits = [r.authors || null, r.year ? String(r.year) : null, r.arxiv ? `arXiv:${r.arxiv}` : null, r.texkey && r.texkey !== r.key ? `INSPIRE ${r.texkey}` : null].filter(Boolean);
        const note = r.status === 'user_confirmed' ? ' [confirmed by the author; not found on INSPIRE]' : '';
        const what = r.abstract ? ` ${firstSentence(r.abstract)}` : '';
        lines.push(`- ${r.key}: "${r.title || '(no title)'}"${bits.length ? ` (${bits.join('; ')})` : ''}${note}.${what}`);
      }
      return lines.join('\n');
    },

    flush: () => persister.flush(),

    requestCount: () => requests,
  };
  return service;
}
