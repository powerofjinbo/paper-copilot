/**
 * INSPIRE-HEP literature client (https://inspirehep.net/api/literature), offline-safe.
 *
 * - Rate limit: at most 15 requests in any 5-second window (INSPIRE's published per-IP limit), as a
 *   sliding-window bucket shared by every call of one client.
 * - Retries: 429/503 wait for Retry-After (seconds or HTTP date; capped at maxRetryWaitMs, default
 *   60 s, else give up) or back off 2/4/8 s, at most 3 retries; other 5xx retry twice; other 4xx fail.
 * - A network error (or two timeouts in a row) puts the client in offline mode: every later call
 *   fails at once with `offline: true`, so a resolve run without network finishes immediately.
 * - `fetch`, `sleep` and `now` are injectable for tests.
 */
import { z } from 'zod';

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}
export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<FetchResponseLike>;

export interface InspireRecord {
  recid: number | null;
  texkey: string | null;
  title: string;
  /** "First Last" names, in INSPIRE order. */
  authors: string[];
  collaborations: string[];
  arxiv: string[];
  dois: string[];
  abstract: string | null;
  year: number | null;
}

export type SearchResult = { ok: true; total: number; hits: InspireRecord[] } | { ok: false; error: string; offline: boolean; status: number | null };

export const INSPIRE_FIELDS = [
  'titles',
  'authors.full_name',
  'texkeys',
  'control_number',
  'arxiv_eprints',
  'dois',
  'abstracts',
  'publication_info.year',
  'earliest_date',
  'collaborations',
];

export interface RateLimiterOptions {
  max: number;
  windowMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** Sliding-window bucket: at most `max` takes in any `windowMs`. Calls are served in order. */
export class RateLimiter {
  private stamps: number[] = [];
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly o: RateLimiterOptions) {}
  take(): Promise<void> {
    const p = this.chain.then(async () => {
      for (;;) {
        const t = this.o.now();
        while (this.stamps.length && t - this.stamps[0]! >= this.o.windowMs) this.stamps.shift();
        if (this.stamps.length < this.o.max) {
          this.stamps.push(t);
          return;
        }
        await this.o.sleep(Math.max(1, this.stamps[0]! + this.o.windowMs - t));
      }
    });
    this.chain = p.catch(() => undefined);
    return p;
  }
}

export interface InspireClientOptions {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  baseUrl?: string;
  maxRequests?: number;
  windowMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryWaitMs?: number;
  /** Share a limiter between clients (e.g. one per service, many runs). */
  limiter?: RateLimiter;
  log?: { debug(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };
}

export interface InspireClient {
  search(query: string, size: number): Promise<SearchResult>;
  /** HTTP requests sent so far (retries included). */
  requests(): number;
  offline(): boolean;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

/** Parse Retry-After: delta-seconds or an HTTP date. Null when absent or unparsable. */
export function parseRetryAfter(v: string | null, now: number): number | null {
  if (!v) return null;
  const s = v.trim();
  if (/^\d+(?:\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

const Hit = z.object({ id: z.union([z.string(), z.number()]).optional(), metadata: z.record(z.string(), z.unknown()).optional() }).passthrough();
const Response = z.object({
  hits: z.object({
    total: z.union([z.number(), z.object({ value: z.number() }).passthrough()]).optional(),
    hits: z.array(Hit),
  }).passthrough(),
}).passthrough();

function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]) : [];
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** "Wang, Chun-Yi" -> "Chun-Yi Wang". */
export function inspireName(fullName: string): string {
  const i = fullName.indexOf(',');
  if (i === -1) return fullName.trim();
  const last = fullName.slice(0, i).trim();
  const first = fullName.slice(i + 1).trim();
  return first ? `${first} ${last}` : last;
}

export function toInspireRecord(h: z.infer<typeof Hit>): InspireRecord {
  const m = (h.metadata ?? {}) as Record<string, unknown>;
  const titles = arr(m.titles).map((t) => str(t.title)).filter((t): t is string => !!t);
  const abstracts = arr(m.abstracts);
  const abs = abstracts.find((a) => str(a.source)?.toLowerCase() === 'arxiv') ?? abstracts[0];
  const pubYear = arr(m.publication_info).map((p) => p.year).find((y) => typeof y === 'number');
  const early = str(m.earliest_date);
  const recid = typeof m.control_number === 'number' ? m.control_number : typeof h.id === 'number' ? h.id : typeof h.id === 'string' && /^\d+$/.test(h.id) ? Number(h.id) : null;
  return {
    recid,
    texkey: Array.isArray(m.texkeys) ? (m.texkeys.find((k) => typeof k === 'string') as string | undefined) ?? null : null,
    title: titles[0] ?? '',
    authors: arr(m.authors).map((a) => str(a.full_name)).filter((n): n is string => !!n).map(inspireName),
    collaborations: arr(m.collaborations).map((c) => str(c.value)).filter((c): c is string => !!c),
    arxiv: arr(m.arxiv_eprints).map((a) => str(a.value)).filter((a): a is string => !!a),
    dois: arr(m.dois).map((d) => str(d.value)).filter((d): d is string => !!d),
    abstract: abs ? str(abs.value) : null,
    year: typeof pubYear === 'number' ? pubYear : early && /^\d{4}/.test(early) ? Number(early.slice(0, 4)) : null,
  };
}

export function createInspireClient(opts: InspireClientOptions = {}): InspireClient {
  const fetchFn: FetchLike | undefined = opts.fetch ?? (typeof globalThis.fetch === 'function' ? (globalThis.fetch.bind(globalThis) as unknown as FetchLike) : undefined);
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? (() => Date.now());
  const base = (opts.baseUrl ?? 'https://inspirehep.net').replace(/\/+$/, '');
  const limiter = opts.limiter ?? new RateLimiter({ max: opts.maxRequests ?? 15, windowMs: opts.windowMs ?? 5000, now, sleep });
  const timeoutMs = opts.timeoutMs ?? 20000;
  const maxRetries = opts.maxRetries ?? 3;
  const maxRetryWaitMs = opts.maxRetryWaitMs ?? 60000;
  let sent = 0;
  let offline = false;
  let timeoutsInARow = 0;

  async function once(url: string): Promise<{ res: FetchResponseLike } | { error: string; timeout: boolean }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    timer.unref?.();
    try {
      sent++;
      const res = await fetchFn!(url, { headers: { accept: 'application/json', 'user-agent': 'paper-copilot (local literature check)' }, signal: ac.signal });
      return { res };
    } catch (e) {
      const timeout = ac.signal.aborted;
      return { error: timeout ? `timeout after ${timeoutMs} ms` : e instanceof Error ? e.message : String(e), timeout };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    requests: () => sent,
    offline: () => offline,
    async search(query, size) {
      if (!fetchFn) return { ok: false, error: 'no fetch implementation available', offline: true, status: null };
      if (offline) return { ok: false, error: 'offline (an earlier request failed)', offline: true, status: null };
      const params = new URLSearchParams({ q: query, size: String(Math.max(1, Math.min(250, Math.floor(size)))), sort: 'mostrecent', format: 'json', fields: INSPIRE_FIELDS.join(',') });
      const url = `${base}/api/literature?${params.toString()}`;
      for (let attempt = 0; ; attempt++) {
        await limiter.take();
        const r = await once(url);
        if ('error' in r) {
          if (r.timeout) {
            timeoutsInARow++;
            if (timeoutsInARow >= 2) offline = true;
          } else {
            offline = true;
          }
          opts.log?.warn(`INSPIRE request failed (${r.error})${offline ? '; continuing offline' : ''}`);
          return { ok: false, error: r.error, offline, status: null };
        }
        timeoutsInARow = 0;
        const { res } = r;
        if (res.status === 429 || res.status === 503) {
          const wait = parseRetryAfter(res.headers.get('retry-after'), now()) ?? 2000 * 2 ** attempt;
          if (attempt >= maxRetries || wait > maxRetryWaitMs) {
            return { ok: false, error: `INSPIRE rate limit (HTTP ${res.status}); retry after ${Math.round(wait / 1000)} s`, offline: false, status: res.status };
          }
          opts.log?.debug(`INSPIRE HTTP ${res.status}; waiting ${wait} ms`);
          await sleep(wait);
          continue;
        }
        if (res.status >= 500) {
          if (attempt >= Math.min(2, maxRetries)) return { ok: false, error: `INSPIRE HTTP ${res.status}`, offline: false, status: res.status };
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        if (!res.ok) return { ok: false, error: `INSPIRE HTTP ${res.status}`, offline: false, status: res.status };
        let body: unknown;
        try {
          body = await res.json();
        } catch (e) {
          return { ok: false, error: `INSPIRE returned invalid JSON: ${e instanceof Error ? e.message : String(e)}`, offline: false, status: res.status };
        }
        const parsed = Response.safeParse(body);
        if (!parsed.success) return { ok: false, error: 'INSPIRE response has no hits list', offline: false, status: res.status };
        const t = parsed.data.hits.total;
        const hits = parsed.data.hits.hits.map(toInspireRecord);
        const total = typeof t === 'number' ? t : t && typeof t === 'object' ? t.value : hits.length;
        return { ok: true, total, hits };
      }
    },
  };
}

/* ------------------------------------------------------------------------------------ */
/* Queries and matching                                                                  */
/* ------------------------------------------------------------------------------------ */

export type LookupBy = 'arxiv' | 'doi' | 'title';

/** `arxiv:2203.08800`, `doi:10.1088/...`; identifiers with characters outside [A-Za-z0-9./_-] are quoted. */
export function lookupQuery(by: LookupBy, value: string): string {
  const id = value.replace(/"/g, '').trim();
  const q = /^[A-Za-z0-9./_-]+$/.test(id) ? id : `"${id}"`;
  if (by === 'arxiv') return `arxiv:${q}`;
  if (by === 'doi') return `doi:${q}`;
  return `t "${value.replace(/["\\{}[\]()^~*?:!]/g, ' ').replace(/\s+/g, ' ').trim()}"`;
}

/** Title normalisation for exact comparison: no math, macros, accents, punctuation or case. */
export function normalizeTitle(t: string): string {
  return t
    .replace(/\$[^$]*\$/g, ' ')
    .replace(/\\[a-zA-Z]+/g, ' ')
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function stripArxivVersion(a: string): string {
  return a.trim().replace(/^arxiv:/i, '').replace(/v\d+$/i, '').toLowerCase();
}

export function recordMatches(by: LookupBy, value: string, r: InspireRecord): boolean {
  if (by === 'arxiv') return r.arxiv.some((a) => stripArxivVersion(a) === stripArxivVersion(value));
  if (by === 'doi') return r.dois.some((d) => d.trim().toLowerCase() === value.trim().toLowerCase());
  const want = normalizeTitle(value);
  return want.length > 0 && normalizeTitle(r.title) === want;
}
