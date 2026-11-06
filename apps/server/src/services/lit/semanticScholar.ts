/**
 * Semantic Scholar fallback (api.semanticscholar.org graph API), exact identifiers only: an arXiv id or
 * a DOI that INSPIRE does not know (machine-learning papers cited by ML-for-HEP work). A record counts
 * only when its externalIds repeat the identifier. One request per second; offline-safe like the
 * INSPIRE client. No API key is needed for this volume.
 */
import { RateLimiter, parseRetryAfter, type FetchLike, type InspireRecord } from './inspire';

export type S2Result = { ok: true; record: InspireRecord | null } | { ok: false; error: string; offline: boolean };

export interface S2Client {
  lookup(by: 'arxiv' | 'doi', value: string): Promise<S2Result>;
  requests(): number;
}

export interface S2Options {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryWaitMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

export function createS2Client(opts: S2Options = {}): S2Client {
  const fetchFn: FetchLike | undefined = opts.fetch ?? (typeof globalThis.fetch === 'function' ? (globalThis.fetch.bind(globalThis) as unknown as FetchLike) : undefined);
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? (() => Date.now());
  const base = (opts.baseUrl ?? 'https://api.semanticscholar.org').replace(/\/+$/, '');
  const limiter = new RateLimiter({ max: 1, windowMs: 1000, now, sleep });
  const maxRetries = opts.maxRetries ?? 2;
  const maxRetryWaitMs = opts.maxRetryWaitMs ?? 30000;
  const timeoutMs = opts.timeoutMs ?? 15000;
  let sent = 0;
  let offline = false;
  return {
    requests: () => sent,
    async lookup(by, value) {
      if (!fetchFn) return { ok: false, error: 'no fetch implementation available', offline: true };
      if (offline) return { ok: false, error: 'offline (an earlier request failed)', offline: true };
      const id = by === 'arxiv' ? `ARXIV:${value}` : `DOI:${value}`;
      // DOIs keep their slashes in the path (as in the API documentation); other unsafe characters are escaped.
      const path = encodeURIComponent(id).replace(/%2F/gi, '/').replace(/%3A/gi, ':');
      const url = `${base}/graph/v1/paper/${path}?fields=title,authors,year,externalIds,abstract`;
      for (let attempt = 0; ; attempt++) {
        await limiter.take();
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        timer.unref?.();
        let res;
        try {
          sent++;
          res = await fetchFn(url, { headers: { accept: 'application/json' }, signal: ac.signal });
        } catch (e) {
          offline = true;
          return { ok: false, error: e instanceof Error ? e.message : String(e), offline: true };
        } finally {
          clearTimeout(timer);
        }
        if (res.status === 404) return { ok: true, record: null };
        if (res.status === 429 || res.status >= 500) {
          const wait = parseRetryAfter(res.headers.get('retry-after'), now()) ?? 2000 * 2 ** attempt;
          if (attempt >= maxRetries || wait > maxRetryWaitMs) return { ok: false, error: `Semantic Scholar HTTP ${res.status}`, offline: false };
          await sleep(wait);
          continue;
        }
        if (!res.ok) return { ok: false, error: `Semantic Scholar HTTP ${res.status}`, offline: false };
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          return { ok: false, error: 'Semantic Scholar returned invalid JSON', offline: false };
        }
        const b = (body ?? {}) as Record<string, unknown>;
        const ext = (b.externalIds ?? {}) as Record<string, unknown>;
        const arxiv = typeof ext.ArXiv === 'string' ? ext.ArXiv : null;
        const doi = typeof ext.DOI === 'string' ? ext.DOI : null;
        const same = by === 'arxiv' ? arxiv?.toLowerCase() === value.toLowerCase() : doi?.toLowerCase() === value.toLowerCase();
        if (!same || typeof b.title !== 'string') return { ok: true, record: null };
        const authors = Array.isArray(b.authors) ? b.authors.map((a) => (a && typeof a === 'object' && typeof (a as { name?: unknown }).name === 'string' ? (a as { name: string }).name : '')).filter(Boolean) : [];
        return {
          ok: true,
          record: {
            recid: null,
            texkey: null,
            title: b.title,
            authors,
            collaborations: [],
            arxiv: arxiv ? [arxiv] : [],
            dois: doi ? [doi] : [],
            abstract: typeof b.abstract === 'string' ? b.abstract : null,
            year: typeof b.year === 'number' ? b.year : null,
          },
        };
      }
    },
  };
}
