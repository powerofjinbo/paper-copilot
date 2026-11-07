/**
 * Security review, round 2 (reviewer, security lens): the routes added since the first review.
 *
 * Routes: /api/consistency, /api/terminology-report, /api/figure-plan, /api/submission-check (and their
 * /api/reports/* aliases), /api/facts/derived, /api/files, POST /api/sentences/:id/restore,
 * POST /api/lint/:id/dismiss, POST /api/lit/:key/confirm.
 *
 * Tests marked "BUG:" fail on the current code and demonstrate a finding; the rest are regression tests
 * for properties that hold today.
 */
import { request as httpRequest } from 'node:http';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCtx, type AppCtx } from '../../src/ctx';
import { createServer, type PaperServer } from '../../src/server';
import { initProject } from '../../src/project/init';
import { makeTempProject, SKILL_DIR, type TempProject } from '../helpers/ctx';

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function req(port: number, method: string, path: string, opts: { host?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: { host: opts.host ?? `127.0.0.1:${port}`, ...(opts.body !== undefined ? { 'content-length': String(Buffer.byteLength(opts.body)) } : {}), ...opts.headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    r.on('error', reject);
    if (opts.body !== undefined) r.write(opts.body);
    r.end();
  });
}

const CROSS_SITE = { origin: 'http://evil.example', 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' };

/** Keys that are also names on Object.prototype. A co-author may add them to the .bib (they are valid BibTeX keys). */
const PROTO_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty'];

describe('security round 2: routes added since the first review', () => {
  let project: TempProject;
  let ctx: AppCtx;
  let server: PaperServer;
  let port: number;
  let dist: string;
  const auth = () => ({ 'x-paper-token': ctx.token });

  beforeAll(async () => {
    project = await makeTempProject();
    // a co-author's bibliography entries (arrive with a git pull / Overleaf sync); nobody confirmed them
    appendFileSync(
      join(project.paths.tex, 'refs.bib'),
      PROTO_KEYS.map((k) => `\n@article{${k},\n  author = "Nobody, A.",\n  title = "{An entry nobody resolved or confirmed (${k})}",\n  year = "2020"\n}\n`).join(''),
    );
    const main = join(project.paths.tex, 'main.tex');
    writeFileSync(main, readFileSync(main, 'utf8').replace('\\end{document}', 'A co-author cites an unchecked entry~\\cite{constructor}.\n\n\\end{document}'));
    await initProject(project.root, { repo: project.repoDir, skill: SKILL_DIR });
    ctx = await createCtx({ root: project.root, fake: true, logLevel: 'error', watch: false, lintSidecar: false, docs: { segmentDebounceMs: 20, writeDebounceMs: 50 } });
    dist = mkdtempSync(join(tmpdir(), 'paper-dist2-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><html><head><title>x</title></head><body></body></html>');
    server = await createServer({ ctx, port: 0, webDist: dist, pingIntervalMs: 60_000 });
    port = server.port;
  });

  afterAll(async () => {
    await server?.close();
    await ctx?.close();
    project?.cleanup();
    if (dist) rmSync(dist, { recursive: true, force: true });
  });

  const NEW_GET = [
    '/api/consistency',
    '/api/reports/consistency',
    '/api/terminology-report',
    '/api/reports/terminology',
    '/api/figure-plan',
    '/api/reports/figure-plan',
    '/api/submission-check?venue=aps',
    '/api/reports/submission',
    '/api/facts/derived',
    '/api/files',
    '/api/lint?file=main.tex',
    '/api/lit/Wang2022LRT',
  ];
  const NEW_POST = ['/api/sentences/x/restore', '/api/lint/abc/dismiss', '/api/lit/Wang2022LRT/confirm'];

  it('regression: every new route refuses a request without the token, with a wrong token, and with a foreign Host (421)', async () => {
    for (const p of NEW_GET) {
      expect.soft((await req(port, 'GET', p)).status, `GET ${p}`).toBe(401);
      expect.soft((await req(port, 'GET', p, { headers: { 'x-paper-token': 'wrong' } })).status, `GET ${p} wrong`).toBe(401);
      expect.soft((await req(port, 'GET', `${p}${p.includes('?') ? '&' : '?'}token=wrong`)).status, `GET ${p} ?token=wrong`).toBe(401);
      expect.soft((await req(port, 'GET', p, { host: `evil.example:${port}`, headers: auth() })).status, `GET ${p} host`).toBe(421);
      expect.soft((await req(port, 'GET', p.replace('/api/', '/%61pi/'))).status, `GET ${p} encoded`).toBe(401);
    }
    for (const p of NEW_POST) {
      const r = await req(port, 'POST', p, { headers: { 'content-type': 'application/json' }, body: '{"version":0}' });
      expect.soft(r.status, `POST ${p}`).toBe(401);
      expect.soft(r.headers['access-control-allow-origin'], `POST ${p}`).toBeUndefined();
      // POST never takes ?token= (only GETs do: the PDF URL and the WebSocket)
      expect.soft((await req(port, 'POST', `${p}?token=${encodeURIComponent(ctx.token)}`, { headers: { 'content-type': 'application/json' }, body: '{}' })).status, `POST ${p} ?token`).toBe(401);
      expect.soft((await req(port, 'POST', p, { host: `localhost.:${port}`, headers: { ...auth(), 'content-type': 'application/json' }, body: '{}' })).status, `POST ${p} host`).toBe(421);
    }
  });

  it('regression: a cross-site no-cors POST cannot confirm a .bib key or dismiss a lint flag (CSRF)', async () => {
    const before = (JSON.parse((await req(port, 'GET', '/api/lit/Wang2022LRT', { headers: auth() })).body) as { status: string }).status;
    const r1 = await req(port, 'POST', '/api/lit/Wang2022LRT/confirm', { headers: CROSS_SITE, body: '{}' });
    expect(r1.status).toBe(401);
    const after = (JSON.parse((await req(port, 'GET', '/api/lit/Wang2022LRT', { headers: auth() })).body) as { status: string }).status;
    expect(after).toBe(before);
    const r2 = await req(port, 'POST', '/api/lint/abc/dismiss', { headers: CROSS_SITE, body: '{}' });
    expect(r2.status).toBe(401);
  });

  it('regression: report queries are validated (unknown venue / lang, repeated params are 400, not 500)', async () => {
    for (const p of ['/api/submission-check?venue=evil', '/api/submission-check?venue=aps&venue=arxiv', '/api/consistency?lang=xx', '/api/figure-plan?lang=zh&lang=en', '/api/terminology-report?lang=%00']) {
      const r = await req(port, 'GET', p, { headers: auth() });
      expect.soft(r.status, p).toBe(400);
    }
  });

  it('regression: path-like ids are refused or not found; nothing outside the tex root is read', async () => {
    for (const p of ['/api/lint?file=../../../etc/passwd', '/api/lint?file=%2Fetc%2Fpasswd', '/api/lit/..%2F..%2Fetc%2Fpasswd']) {
      const r = await req(port, 'GET', p, { headers: auth() });
      expect.soft(r.status, p).toBe(404);
      expect.soft(r.body, p).not.toMatch(/root:x:0:0/);
    }
    for (const id of ['..%2F..%2Fx', 'a'.repeat(300), '%00']) {
      const r = await req(port, 'POST', `/api/lint/${id}/dismiss`, { headers: { ...auth(), 'content-type': 'application/json' }, body: '{}' });
      expect.soft([400, 414], id).toContain(r.status);
    }
    const big = await req(port, 'POST', `/api/sentences/${'a'.repeat(200)}/restore`, { headers: { ...auth(), 'content-type': 'application/json' }, body: '{"version":0}' });
    expect([400, 414]).toContain(big.status);
    const neg = await req(port, 'POST', '/api/sentences/x/restore', { headers: { ...auth(), 'content-type': 'application/json' }, body: '{"version":-1}' });
    expect(neg.status).toBe(400);
  });

  it('regression: the body limit holds on the new POST routes (9 MB body is 413, the server stays up)', async () => {
    const body = JSON.stringify({ version: 0, pad: 'x'.repeat(9 * 1024 * 1024) });
    const r = await req(port, 'POST', '/api/sentences/x/restore', { headers: { ...auth(), 'content-type': 'application/json' }, body }).catch(() => ({ status: 413, headers: {}, body: '' }));
    expect(r.status).toBe(413);
    expect((await req(port, 'GET', '/api/project', { headers: auth() })).status).toBe(200);
  });

  it('BUG: a .bib key named like an Object.prototype member (constructor, toString, ...) is "user_confirmed" although nobody confirmed it, so the AI may cite it and the submission check does not list it as unresolved', async () => {
    const all = JSON.parse((await req(port, 'GET', '/api/lit', { headers: auth() })).body) as Array<{ key: string; status: string }>;
    const statusOf = Object.fromEntries(all.map((r) => [r.key, r.status]));
    for (const k of PROTO_KEYS) {
      expect.soft(statusOf[k], `.bib key ${k} must exist`).toBeDefined();
      // never resolved (no network in this test) and never confirmed by the author
      expect.soft(statusOf[k], `.bib key ${k}`).toBe('unresolved');
    }
    const allowed = ctx.lit.allowedKeys().map((k) => k.key);
    for (const k of PROTO_KEYS) expect.soft(allowed, `allowedKeys must not hold ${k}`).not.toContain(k);
    // the prompt brief tells the model the author confirmed it
    expect.soft(ctx.lit.brief()).not.toMatch(/- constructor:/);
    // the pre-submission checklist does not list the cited, never-resolved key
    const sub = JSON.parse((await req(port, 'GET', '/api/submission-check?venue=arxiv', { headers: auth() })).body) as { items: Array<{ id: string; items: Array<{ text: string }> }> };
    const unresolved = sub.items.find((i) => i.id === 'unresolved_cites')!;
    expect.soft(unresolved.items.map((e) => e.text)).toContain('constructor');
  });
});
