import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LitService } from '../src/contracts';
import { normalizeArxiv, normalizeDoi, parseBibText } from '../src/services/lit/bib';
import { RateLimiter, createInspireClient, inspireName, lookupQuery, normalizeTitle, parseRetryAfter, recordMatches, type FetchLike, type FetchResponseLike } from '../src/services/lit/inspire';
import { cacheFileName, createLitService, type LitServiceImpl } from '../src/services/lit/litService';
import { FIXTURE, makeTempProject, makeTestCtx, type TempProject } from './helpers/ctx';

/* ------------------------------------------------------------------------------------ */
/* Stubs                                                                                 */
/* ------------------------------------------------------------------------------------ */

interface HitSpec {
  recid: number;
  texkey: string;
  title: string;
  arxiv?: string;
  doi?: string;
  authors?: string[];
  abstract?: string;
  year?: number;
}

function hit(h: HitSpec) {
  return {
    id: String(h.recid),
    metadata: {
      control_number: h.recid,
      texkeys: [h.texkey],
      titles: [{ title: h.title, source: 'arXiv' }],
      authors: (h.authors ?? ['Wang, Chun-Yi', 'Ju, Xiangyang']).map((full_name) => ({ full_name })),
      arxiv_eprints: h.arxiv ? [{ value: h.arxiv, categories: ['physics.ins-det'] }] : [],
      dois: h.doi ? [{ value: h.doi }] : [],
      abstracts: h.abstract ? [{ value: h.abstract, source: 'arXiv' }] : [],
      publication_info: h.year ? [{ year: h.year }] : [],
    },
  };
}

function response(body: unknown, status = 200, headers: Record<string, string> = {}): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  };
}

const WANG = hit({
  recid: 2061419,
  texkey: 'Wang:2022oer',
  title: 'Reconstruction of Large Radius Tracks with the Exa.TrkX pipeline',
  arxiv: '2203.08800',
  doi: '10.1088/1742-6596/2438/1/012117',
  abstract: 'Particle tracking is a challenging pattern recognition task at the LHC. We extend the Exa.TrkX pipeline to large-radius tracks.',
  year: 2023,
});

/** A fetch stub that answers INSPIRE queries from a table of hits and records every call. */
function inspireStub(hits: ReturnType<typeof hit>[], opts: { fail?: (url: URL, n: number) => FetchResponseLike | Error | null } = {}) {
  const calls: URL[] = [];
  const fetch: FetchLike = async (u) => {
    const url = new URL(u);
    calls.push(url);
    const injected = opts.fail?.(url, calls.length);
    if (injected instanceof Error) throw injected;
    if (injected) return injected;
    if (url.hostname === 'api.semanticscholar.org') return response({ error: 'not found' }, 404);
    const q = url.searchParams.get('q') ?? '';
    const terms = q.split(/\s+or\s+/);
    const matched = hits.filter((h) =>
      terms.some((t) => {
        const m = /^(arxiv|doi):"?([^"]+)"?$/.exec(t.trim());
        if (m) return m[1] === 'arxiv' ? h.metadata.arxiv_eprints.some((a) => a.value === m[2]) : h.metadata.dois.some((d) => d.value.toLowerCase() === m[2]!.toLowerCase());
        const tm = /^t "(.*)"$/.exec(t.trim());
        return !!tm && normalizeTitle(h.metadata.titles[0]!.title).includes(normalizeTitle(tm[1]!));
      }),
    );
    return response({ hits: { total: matched.length, hits: matched }, links: {} });
  };
  return { fetch, calls };
}

/** Fake clock: sleep advances time instantly and records the waits. */
function fakeClock(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}

/* ------------------------------------------------------------------------------------ */
/* .bib                                                                                  */
/* ------------------------------------------------------------------------------------ */

describe('bib parsing', () => {
  it('parses fixtures/canto-demo/tex/refs.bib with titles as written and identifiers', () => {
    const text = readFileSync(join(FIXTURE, 'tex', 'refs.bib'), 'utf8');
    const { entries, errors } = parseBibText(text, 'refs.bib');
    expect(errors).toEqual([]);
    expect(entries.map((e) => e.key)).toEqual(['Wang2022LRT', 'Ju2022Zenodo']);
    const w = entries[0]!;
    expect(w).toMatchObject({
      type: 'article',
      title: 'Reconstruction of Large Radius Tracks with the Exa.TrkX pipeline',
      year: 2023,
      arxiv: '2203.08800',
      doi: '10.1088/1742-6596/2438/1/012117',
      authors: 'Chun-Yi Wang, Xiangyang Ju, Shih-Chieh Hsu et al.',
      etAl: true,
    });
    const j = entries[1]!;
    expect(j).toMatchObject({ type: 'misc', arxiv: null, doi: '10.5281/zenodo.6812533', year: null, authors: 'Xiangyang Ju' });
    expect(j.title).toBe('Large Radius Tracking Events in pp collisions with a Generic detector');
  });

  it('converts LaTeX, keeps case, and survives broken entries', () => {
    const text = String.raw`@article{x, title = {Search for {$\tau$} Leptons in {ATLAS} with \textit{CMS}}, author = {M{\"u}ller, J{\"o}rg and {ATLAS Collaboration}}, year = 2021, eprint = {hep-ex/0601001v2}, archivePrefix = {arXiv}}
@article{y, title = {Unterminated`;
    const { entries, errors } = parseBibText(text, 'x.bib');
    const x = entries.find((e) => e.key === 'x')!;
    expect(x.title).toBe('Search for τ Leptons in ATLAS with CMS');
    expect(x.authorNames).toEqual(['Jörg Müller', 'ATLAS Collaboration']);
    expect(x.arxiv).toBe('hep-ex/0601001');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('normalises identifiers', () => {
    expect(normalizeArxiv('arXiv:2203.08800v3')).toBe('2203.08800');
    expect(normalizeArxiv('https://arxiv.org/abs/2203.08800')).toBe('2203.08800');
    expect(normalizeArxiv('hep-ph/0601001')).toBe('hep-ph/0601001');
    expect(normalizeArxiv('not an id')).toBeNull();
    expect(normalizeDoi('https://doi.org/10.1103/PhysRevD.1.1')).toBe('10.1103/PhysRevD.1.1');
    expect(normalizeDoi('doi:10.1/x')).toBeNull();
    expect(normalizeDoi('doi: 10.1000/xyz')).toBe('10.1000/xyz');
  });
});

/* ------------------------------------------------------------------------------------ */
/* INSPIRE client                                                                        */
/* ------------------------------------------------------------------------------------ */

describe('INSPIRE client (stubbed fetch)', () => {
  it('one hit: parses the record and sends the documented query and fields', async () => {
    const stub = inspireStub([WANG]);
    const clock = fakeClock();
    const c = createInspireClient({ fetch: stub.fetch, sleep: clock.sleep, now: clock.now });
    const r = await c.search(lookupQuery('arxiv', '2203.08800'), 5);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.total).toBe(1);
    expect(r.hits[0]).toMatchObject({ recid: 2061419, texkey: 'Wang:2022oer', arxiv: ['2203.08800'], dois: ['10.1088/1742-6596/2438/1/012117'], year: 2023, authors: ['Chun-Yi Wang', 'Xiangyang Ju'] });
    const url = stub.calls[0]!;
    expect(url.origin + url.pathname).toBe('https://inspirehep.net/api/literature');
    expect(url.searchParams.get('q')).toBe('arxiv:2203.08800');
    expect(url.searchParams.get('format')).toBe('json');
    expect(url.searchParams.get('fields')).toContain('authors.full_name');
    expect(url.searchParams.get('fields')).toContain('texkeys');
    expect(recordMatches('arxiv', '2203.08800', r.hits[0]!)).toBe(true);
  });

  it('zero hits and two hits', async () => {
    const twin = hit({ recid: 1, texkey: 'A:2020a', title: 'Same Title Here For Both', doi: '10.1/dup' });
    const twin2 = hit({ recid: 2, texkey: 'B:2021b', title: 'Same Title Here For Both', doi: '10.1/dup' });
    const stub = inspireStub([twin, twin2]);
    const c = createInspireClient({ fetch: stub.fetch, sleep: async () => undefined });
    const zero = await c.search('arxiv:9999.99999', 5);
    expect(zero.ok && zero.total).toBe(0);
    const two = await c.search(lookupQuery('doi', '10.1/dup'), 5);
    expect(two.ok && two.hits.length).toBe(2);
  });

  it('network error: fails soft and stays offline without more requests', async () => {
    const stub = inspireStub([WANG], { fail: () => new TypeError('fetch failed: getaddrinfo ENOTFOUND inspirehep.net') });
    const c = createInspireClient({ fetch: stub.fetch, sleep: async () => undefined });
    const r = await c.search('arxiv:2203.08800', 5);
    expect(r).toMatchObject({ ok: false, offline: true });
    const r2 = await c.search('arxiv:2203.08800', 5);
    expect(r2).toMatchObject({ ok: false, offline: true });
    expect(stub.calls.length).toBe(1);
    expect(c.offline()).toBe(true);
  });

  it('429 with Retry-After: waits the given time and retries', async () => {
    const clock = fakeClock();
    const stub = inspireStub([WANG], { fail: (_u, n) => (n === 1 ? response({ message: 'Too Many Requests' }, 429, { 'retry-after': '3' }) : null) });
    const c = createInspireClient({ fetch: stub.fetch, sleep: clock.sleep, now: clock.now });
    const r = await c.search('arxiv:2203.08800', 5);
    expect(r.ok && r.hits.length).toBe(1);
    expect(clock.sleeps).toContain(3000);
    expect(c.requests()).toBe(2);
  });

  it('gives up on a Retry-After beyond the cap, and on repeated 429s', async () => {
    const clock = fakeClock();
    const long = inspireStub([WANG], { fail: () => response({}, 429, { 'retry-after': '3600' }) });
    const c1 = createInspireClient({ fetch: long.fetch, sleep: clock.sleep, now: clock.now });
    expect(await c1.search('q', 5)).toMatchObject({ ok: false, offline: false, status: 429 });
    expect(long.calls.length).toBe(1);
    const always = inspireStub([WANG], { fail: () => response({}, 429) });
    const c2 = createInspireClient({ fetch: always.fetch, sleep: clock.sleep, now: clock.now, maxRetries: 2 });
    expect(await c2.search('q', 5)).toMatchObject({ ok: false, status: 429 });
    expect(always.calls.length).toBe(3);
    const bad = inspireStub([WANG], { fail: () => response({ message: 'bad query' }, 400) });
    const c3 = createInspireClient({ fetch: bad.fetch, sleep: clock.sleep, now: clock.now });
    expect(await c3.search('q', 5)).toMatchObject({ ok: false, status: 400 });
    expect(bad.calls.length).toBe(1);
  });

  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('5', 0)).toBe(5000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter('soon', 0)).toBeNull();
    expect(inspireName('Wang, Chun-Yi')).toBe('Chun-Yi Wang');
    expect(inspireName('ATLAS Collaboration')).toBe('ATLAS Collaboration');
  });

  it('never sends more than 15 requests in any 5 s window', async () => {
    const clock = fakeClock(0);
    const lim = new RateLimiter({ max: 15, windowMs: 5000, now: clock.now, sleep: clock.sleep });
    const stamps: number[] = [];
    for (let i = 0; i < 40; i++) {
      await lim.take();
      stamps.push(clock.now());
    }
    for (let i = 15; i < stamps.length; i++) expect(stamps[i]! - stamps[i - 15]!).toBeGreaterThanOrEqual(5000);
    expect(stamps[14]).toBe(0);
    expect(stamps[15]).toBe(5000);
  });

  it('matches titles exactly after normalisation (math, macros, case, punctuation)', () => {
    expect(normalizeTitle('Search for $\\tau$ leptons: a study')).toBe(normalizeTitle('Search for τ Leptons — A Study'));
    expect(lookupQuery('title', 'A "quoted" title: (with) [chars]')).toBe('t "A quoted title with chars"');
    expect(lookupQuery('doi', '10.1016/0550-3213(77)90384-4')).toBe('doi:"10.1016/0550-3213(77)90384-4"');
    expect(lookupQuery('doi', '10.1088/1742-6596/2438/1/012117')).toBe('doi:10.1088/1742-6596/2438/1/012117');
    expect(lookupQuery('arxiv', 'hep-ph/0601001')).toBe('arxiv:hep-ph/0601001');
  });
});

/* ------------------------------------------------------------------------------------ */
/* LitService                                                                            */
/* ------------------------------------------------------------------------------------ */

let project: TempProject;
let services: LitServiceImpl[] = [];
beforeEach(async () => {
  project = await makeTempProject();
  services = [];
});
afterEach(async () => {
  await Promise.all(services.map((s) => s.flush()));
  project.cleanup();
});

function litSetup(fetch: FetchLike, extra: Parameters<typeof createLitService>[1] = {}) {
  const ctx = makeTestCtx(project);
  const clock = fakeClock(Date.parse('2026-11-06T09:00:00Z'));
  const lit = createLitService(ctx, { fetch, sleep: clock.sleep, now: clock.now, ...extra });
  services.push(lit);
  (ctx as { lit: LitService }).lit = lit;
  return { ctx, lit, clock };
}

describe('LitService', () => {
  it('lists every .bib key as a record, unresolved until resolved', () => {
    const { lit } = litSetup(inspireStub([]).fetch);
    expect(lit.bibKeys()).toEqual(['Wang2022LRT', 'Ju2022Zenodo']);
    expect(lit.records().map((r) => [r.key, r.status, r.source])).toEqual([
      ['Wang2022LRT', 'unresolved', 'bib'],
      ['Ju2022Zenodo', 'unresolved', 'bib'],
    ]);
    expect(lit.allowedKeys()).toEqual([]);
    expect(lit.brief()).toMatch(/no \.bib key is resolved/);
  });

  it('resolves by arXiv in one batched query, caches the answer, and leaves zero-hit keys unresolved', async () => {
    const stub = inspireStub([WANG]);
    const { ctx, lit } = litSetup(stub.fetch);
    const recs = await lit.resolveAll();
    const w = recs.find((r) => r.key === 'Wang2022LRT')!;
    expect(w).toMatchObject({ status: 'resolved', source: 'inspire', texkey: 'Wang:2022oer', recid: 2061419, arxiv: '2203.08800', year: 2023 });
    expect(w.abstract).toMatch(/^Particle tracking/);
    const j = recs.find((r) => r.key === 'Ju2022Zenodo')!;
    expect(j.status).toBe('unresolved');
    // First request batches both identifiers.
    expect(stub.calls[0]!.searchParams.get('q')).toBe('arxiv:2203.08800 or doi:10.5281/zenodo.6812533');
    // Ju2022Zenodo then falls back to its title, then Semantic Scholar by DOI.
    expect(stub.calls.some((u) => u.searchParams.get('q')?.startsWith('t "Large Radius Tracking Events'))).toBe(true);
    expect(stub.calls.some((u) => u.hostname === 'api.semanticscholar.org')).toBe(true);
    // Cache files.
    const cachePath = join(ctx.paths.litDir, cacheFileName('Wang2022LRT'));
    expect(existsSync(cachePath)).toBe(true);
    expect(JSON.parse(readFileSync(cachePath, 'utf8'))).toMatchObject({ key: 'Wang2022LRT', outcome: 'one', lookup: { by: 'arxiv', value: '2203.08800' } });
    expect(JSON.parse(readFileSync(join(ctx.paths.litDir, cacheFileName('Ju2022Zenodo')), 'utf8')).outcome).toBe('none');
    expect(readFileSync(ctx.paths.litBrief, 'utf8')).toContain('Wang2022LRT');
    // A second run is served from the cache.
    const before = stub.calls.length;
    await lit.resolveAll();
    expect(stub.calls.length).toBe(before);
    // A new service instance reads the cache from disk.
    const again = createLitService(ctx, { fetch: inspireStub([]).fetch });
    services.push(again);
    expect(again.records().find((r) => r.key === 'Wang2022LRT')!.status).toBe('resolved');
    expect(again.allowedKeys()).toEqual([{ key: 'Wang2022LRT', title: 'Reconstruction of Large Radius Tracks with the Exa.TrkX pipeline' }]);
  });

  it('two matching records leave the key unresolved (ambiguous) and record the candidates', async () => {
    const a = hit({ recid: 11, texkey: 'Wang:2022oer', title: 'Reconstruction of Large Radius Tracks with the Exa.TrkX pipeline', arxiv: '2203.08800' });
    const b = hit({ recid: 12, texkey: 'Wang:2022xxx', title: 'Reconstruction of Large Radius Tracks with the Exa.TrkX pipeline', arxiv: '2203.08800' });
    const { ctx, lit } = litSetup(inspireStub([a, b]).fetch);
    const recs = await lit.resolveAll();
    expect(recs.find((r) => r.key === 'Wang2022LRT')!.status).toBe('unresolved');
    const cached = JSON.parse(readFileSync(join(ctx.paths.litDir, cacheFileName('Wang2022LRT')), 'utf8'));
    expect(cached.outcome).toBe('many');
    expect(cached.candidates.map((c: { recid: number }) => c.recid)).toEqual([11, 12]);
  });

  it('offline: nothing throws, nothing is cached, statuses stay; a later run resolves', async () => {
    let online = false;
    const stub = inspireStub([WANG], { fail: () => (online ? null : new TypeError('fetch failed')) });
    const { ctx, lit } = litSetup(stub.fetch);
    const recs = await lit.resolveAll();
    expect(recs.every((r) => r.status === 'unresolved')).toBe(true);
    expect(stub.calls.length).toBe(1);
    expect(existsSync(join(ctx.paths.litDir, cacheFileName('Wang2022LRT')))).toBe(false);
    online = true;
    const later = await lit.resolveAll();
    expect(later.find((r) => r.key === 'Wang2022LRT')!.status).toBe('resolved');
  });

  it('retries after a 429 with Retry-After during a run', async () => {
    const stub = inspireStub([WANG], { fail: (_u, n) => (n === 1 ? response({}, 429, { 'retry-after': '2' }) : null) });
    const { lit, clock } = litSetup(stub.fetch, { semanticScholar: false });
    const recs = await lit.resolveAll();
    expect(recs.find((r) => r.key === 'Wang2022LRT')!.status).toBe('resolved');
    expect(clock.sleeps).toContain(2000);
  });

  it('falls back to Semantic Scholar for an exact DOI that INSPIRE does not know', async () => {
    const stub = inspireStub([WANG], {
      fail: (u) =>
        u.hostname === 'api.semanticscholar.org' && u.pathname === '/graph/v1/paper/DOI:10.5281/zenodo.6812533'
          ? response({ paperId: 'abc', title: 'Large Radius Tracking Events in pp collisions with a Generic detector', year: 2022, authors: [{ name: 'Xiangyang Ju' }], externalIds: { DOI: '10.5281/zenodo.6812533' }, abstract: null })
          : null,
    });
    const { lit } = litSetup(stub.fetch);
    const recs = await lit.resolveAll();
    // The .bib has no year, so the year comes from the matched record.
    expect(recs.find((r) => r.key === 'Ju2022Zenodo')).toMatchObject({ status: 'resolved', source: 'semantic_scholar', texkey: null, year: 2022 });
  });

  it('confirm() makes a key user_confirmed and allowed; brief() is deterministic', async () => {
    const { ctx, lit } = litSetup(inspireStub([WANG]).fetch, { semanticScholar: false });
    await lit.resolveAll();
    const c = lit.confirm('Ju2022Zenodo');
    expect(c.status).toBe('user_confirmed');
    expect(lit.allowedKeys().map((k) => k.key).sort()).toEqual(['Ju2022Zenodo', 'Wang2022LRT']);
    const b1 = lit.brief();
    expect(b1).toBe(lit.brief());
    expect(b1.indexOf('Ju2022Zenodo')).toBeLessThan(b1.indexOf('Wang2022LRT'));
    expect(b1).toContain('confirmed by the author');
    expect(b1).toContain('arXiv:2203.08800');
    expect(() => lit.confirm('NoSuchKey')).toThrow(/unknown \.bib key/);
    await lit.flush();
    expect(JSON.parse(readFileSync(ctx.paths.litIndex, 'utf8')).confirmed.Ju2022Zenodo).toBeDefined();
    const again = createLitService(ctx, { fetch: inspireStub([]).fetch });
    services.push(again);
    expect(again.records().find((r) => r.key === 'Ju2022Zenodo')!.status).toBe('user_confirmed');
    // Confirmation can be withdrawn; a resolved key stays resolved.
    expect(lit.confirm('Ju2022Zenodo', false).status).toBe('unresolved');
    expect(lit.confirm('Wang2022LRT').status).toBe('resolved');
  });

  it('re-reads the .bib when it changes and re-resolves keys whose identifiers changed', async () => {
    const stub = inspireStub([WANG, hit({ recid: 5, texkey: 'New:2024a', title: 'A brand new paper on tracking', arxiv: '2401.00001' })]);
    const { ctx, lit } = litSetup(stub.fetch, { semanticScholar: false });
    await lit.resolveAll();
    const bibPath = join(ctx.paths.tex, 'refs.bib');
    writeFileSync(bibPath, readFileSync(bibPath, 'utf8') + '\n@article{New2024, title = {A brand new paper on tracking}, author = {Doe, Jane}, eprint = {2401.00001}, archivePrefix = {arXiv}, year = 2024}\n');
    expect(lit.bibKeys()).toContain('New2024');
    expect(lit.records().find((r) => r.key === 'New2024')!.status).toBe('unresolved');
    const n0 = stub.calls.length;
    const recs = await lit.resolveAll();
    expect(recs.find((r) => r.key === 'New2024')!.status).toBe('resolved');
    // Only the new key was looked up (the others are cached).
    expect(stub.calls.slice(n0).map((u) => u.searchParams.get('q'))).toEqual(['arxiv:2401.00001']);
    // Changing Wang2022LRT's eprint invalidates its cached answer.
    writeFileSync(bibPath, readFileSync(bibPath, 'utf8').replace('2203.08800', '2203.08801'));
    expect(lit.records().find((r) => r.key === 'Wang2022LRT')!.status).toBe('unresolved');
  });

  it('refuses .bib paths outside texRoot', () => {
    const ctx = makeTestCtx(project);
    void ctx.saveConfig({ ...ctx.config, bibFiles: ['../repo/README.md', 'refs.bib'] });
    const lit = createLitService(ctx, { fetch: inspireStub([]).fetch });
    services.push(lit);
    expect(lit.bibKeys()).toEqual(['Wang2022LRT', 'Ju2022Zenodo']);
  });
});
