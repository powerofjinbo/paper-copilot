import { request as httpRequest } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ChangeSet } from '@codemirror/state';
import { ServerMessage, emptyOutline, findPlaceholders, type SentenceUnit } from '@paper-copilot/core';
import { createCtx, type AppCtx } from '../src/ctx';
import { createServer, injectToken, type PaperServer } from '../src/server';
import { initProject } from '../src/project/init';
import { claimPlaceholder } from '../src/routes/sentences';
import { makeTempProject, SKILL_DIR, type TempProject } from './helpers/ctx';

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: () => any;
}

function req(port: number, method: string, path: string, opts: { host?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const r = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: { host: opts.host ?? `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) } : {}), ...opts.headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) }));
      },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

class Client {
  msgs: ServerMessage[] = [];
  private waiters: Array<{ pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  constructor(public ws: WebSocket) {
    ws.on('message', (d) => {
      const m = ServerMessage.parse(JSON.parse(String(d)));
      this.msgs.push(m);
      for (const w of [...this.waiters]) if (w.pred(m)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(m);
      }
    });
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  next<T extends ServerMessage['type']>(type: T, pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true, timeoutMs = 5000): Promise<Extract<ServerMessage, { type: T }>> {
    const seen = this.msgs.find((m) => m.type === type && pred(m as Extract<ServerMessage, { type: T }>));
    if (seen) {
      this.msgs.splice(this.msgs.indexOf(seen), 1);
      return Promise.resolve(seen as Extract<ServerMessage, { type: T }>);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
      this.waiters.push({
        pred: (m) => m.type === type && pred(m as Extract<ServerMessage, { type: T }>),
        resolve: (m) => {
          clearTimeout(t);
          const i = this.msgs.indexOf(m);
          if (i >= 0) this.msgs.splice(i, 1);
          resolve(m as Extract<ServerMessage, { type: T }>);
        },
      });
    });
  }
}

function connect(port: number, token: string | null, headers: Record<string, string> = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}/ws${token === null ? '' : `?token=${encodeURIComponent(token)}`}`;
    const ws = new WebSocket(url, { headers });
    const c = new Client(ws);
    ws.once('open', () => resolve(c));
    ws.once('unexpected-response', (rq, res) => {
      rq.destroy();
      res.destroy();
      reject(new Error(`HTTP ${res.statusCode}`));
    });
    ws.once('error', reject);
  });
}

describe('server (fake AI, fixture project)', () => {
  let project: TempProject;
  let ctx: AppCtx;
  let server: PaperServer;
  let port: number;
  let dist: string;
  const auth = () => ({ 'x-paper-token': ctx.token });

  beforeAll(async () => {
    project = await makeTempProject();
    await initProject(project.root, { repo: project.repoDir, skill: SKILL_DIR });
    ctx = await createCtx({ root: project.root, fake: true, logLevel: 'error', watch: false, lintSidecar: false, docs: { segmentDebounceMs: 20, writeDebounceMs: 50 } });
    dist = mkdtempSync(join(tmpdir(), 'paper-dist-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><html><head><title>x</title></head><body><div id="root"></div></body></html>');
    writeFileSync(join(dist, 'app.js'), 'console.log(1)');
    server = await createServer({ ctx, port: 0, webDist: dist, pingIntervalMs: 60_000 });
    port = server.port;
  });

  afterAll(async () => {
    await server?.close();
    await ctx?.close();
    project?.cleanup();
    rmSync(dist, { recursive: true, force: true });
  });

  it('binds to 127.0.0.1 only', async () => {
    await expect(createServer({ ctx, port: 0, host: '0.0.0.0' })).rejects.toThrow(/127\.0\.0\.1/);
    expect(server.url).toBe(`http://127.0.0.1:${port}/`);
  });

  it('rejects other Host headers with 421 (DNS rebinding)', async () => {
    expect((await req(port, 'GET', '/api/project', { host: 'evil.example:80', headers: auth() })).status).toBe(421);
    expect((await req(port, 'GET', '/', { host: `attacker.test:${port}` })).status).toBe(421);
    expect((await req(port, 'GET', '/api/project', { host: `localhost:${port}`, headers: auth() })).status).toBe(200);
    // the Vite dev host is accepted only in dev mode
    expect((await req(port, 'GET', '/api/project', { host: '127.0.0.1:5173', headers: auth() })).status).toBe(421);
  });

  it('requires the token on /api and never sends CORS headers', async () => {
    const none = await req(port, 'GET', '/api/project');
    expect(none.status).toBe(401);
    expect((await req(port, 'GET', '/api/project', { headers: { 'x-paper-token': 'wrong' } })).status).toBe(401);
    expect((await req(port, 'GET', `/api/project?token=${encodeURIComponent(ctx.token)}`)).status).toBe(200);
    // ?token= only for GET
    expect((await req(port, 'POST', `/api/sync/pull?token=${encodeURIComponent(ctx.token)}`, { body: {} })).status).toBe(401);
    const pre = await req(port, 'OPTIONS', '/api/project', { headers: { origin: 'http://evil.example', 'access-control-request-method': 'GET' } });
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
    expect(none.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('GET /api/session needs x-paper-client: 1', async () => {
    expect((await req(port, 'GET', '/api/session')).status).toBe(403);
    const ok = await req(port, 'GET', '/api/session', { headers: { 'x-paper-client': '1' } });
    expect(ok.status).toBe(200);
    expect(ok.json().token).toBe(ctx.token);
    expect(ok.headers['cache-control']).toBe('no-store');
  });

  it('serves index.html with the token injected, static assets, and an SPA fallback', async () => {
    const index = await req(port, 'GET', '/');
    expect(index.status).toBe(200);
    expect(index.body).toContain(`<meta name="paper-token" content="${ctx.token}">`);
    expect(index.headers['cache-control']).toBe('no-store');
    expect(index.headers['x-frame-options']).toBe('DENY');
    expect((await req(port, 'GET', '/index.html')).body).toContain('paper-token');
    expect((await req(port, 'GET', '/app.js')).body).toBe('console.log(1)');
    expect((await req(port, 'GET', '/some/client/route')).body).toContain('paper-token');
    expect((await req(port, 'GET', '/api/nope', { headers: auth() })).status).toBe(404);
    expect(injectToken('<html><head></head></html>', 'a"b')).toContain('content="a&quot;b"');
  });

  it('GET /api/project returns ProjectInfo', async () => {
    const r = await req(port, 'GET', '/api/project', { headers: auth() });
    const info = r.json();
    expect(info.config.mainFile).toBe('main.tex');
    expect(info.config.bibFiles).toEqual(['refs.bib']);
    expect(info.files).toEqual(['main.tex']);
    expect(info.fakeLlm).toBe(true);
    expect(info.skill.found).toBe(true);
    expect(typeof info.stats.units).toBe('number');
  });

  it('outline: GET empty (with the document headings offered as sections), PUT validates and broadcasts plan.updated', async () => {
    const c = await connect(port, ctx.token);
    try {
      const g = await req(port, 'GET', '/api/outline', { headers: auth() });
      expect({ ...g.json(), sections: [] }).toEqual(emptyOutline());
      const secs = g.json().sections as Array<{ id: string; title: string; template: string; ghostMode: string; paragraphs: unknown[] }>;
      expect(secs.map((x) => x.id)).toEqual(['abstract', 'sec:intro', 'sec:method', 'sec:results', 'sec:concl', 'app:val']);
      expect(secs.find((x) => x.id === 'sec:results')).toMatchObject({ title: 'Results', template: 'results', ghostMode: 'auto-propose', paragraphs: [] });
      expect(secs.find((x) => x.id === 'sec:intro')).toMatchObject({ template: 'introduction', ghostMode: 'complete-my-sentence' });
      // offered, not saved: the file is untouched until the author saves
      expect(existsSync(ctx.paths.outline) ? JSON.parse(readFileSync(ctx.paths.outline, 'utf8')).sections : []).toEqual([]);
      expect((await req(port, 'PUT', '/api/outline', { headers: auth(), body: { story: 'nope' } })).status).toBe(400);
      const o = { ...emptyOutline(), story: { text: 'A tracker trained without signal.', keyPhrase: 'without signal', provenance: 'author' } };
      const p = await req(port, 'PUT', '/api/outline', { headers: auth(), body: o });
      expect(p.status).toBe(200);
      const ev = await c.next('plan.updated');
      expect(ev.outline.story.keyPhrase).toBe('without signal');
      expect(JSON.parse(readFileSync(ctx.paths.outline, 'utf8')).story.text).toBe('A tracker trained without signal.');
    } finally {
      c.ws.close();
    }
  });

  it('WebSocket: token and Origin checks', async () => {
    await expect(connect(port, null)).rejects.toThrow(/401/);
    await expect(connect(port, 'wrong')).rejects.toThrow(/401/);
    await expect(connect(port, ctx.token, { origin: 'http://evil.example' })).rejects.toThrow(/403/);
    const ok = await connect(port, ctx.token, { origin: `http://127.0.0.1:${port}` });
    ok.ws.close();
  });

  it('WebSocket round trip: hello/welcome, doc.open/snapshot, doc.change/ack/sentences.patch, stale change -> snapshot', async () => {
    const c = await connect(port, ctx.token);
    try {
      c.send({ type: 'hello', clientId: 'test' });
      const w = await c.next('welcome');
      expect(w.fakeLlm).toBe(true);
      expect(w.project.mainFile).toBe('main.tex');

      c.send({ type: 'doc.open', file: 'main.tex' });
      const snap = await c.next('doc.snapshot');
      expect(snap.file).toBe('main.tex');
      const u = snap.units.find((x: SentenceUnit) => snap.text.slice(x.start, x.end).startsWith('This lead holds'))!;
      expect(u).toBeTruthy();

      // typed change
      const at = snap.text.indexOf('every', u.start);
      const cs = ChangeSet.of([{ from: at, to: at + 5, insert: 'each' }], snap.text.length);
      c.send({ type: 'doc.change', file: 'main.tex', baseVersion: snap.version, changes: cs.toJSON(), annotation: null });
      const ack = await c.next('doc.ack');
      expect(ack.version).toBe(snap.version + 1);
      const patch = await c.next('sentences.patch', (m) => m.upserts.some((x) => x.id === u.id));
      expect(patch.version).toBe(snap.version + 1);

      // annotated AI rewrite keeps the id
      const cur = snap.text.slice(0, at) + 'each' + snap.text.slice(at + 5);
      const u2 = patch.upserts.find((x) => x.id === u.id)!;
      const rewrite = 'The lead holds for every species we simulated.';
      const cs2 = ChangeSet.of([{ from: u2.start, to: u2.end, insert: rewrite }], cur.length);
      c.send({
        type: 'doc.change',
        file: 'main.tex',
        baseVersion: ack.version,
        changes: cs2.toJSON(),
        annotation: { origin: 'ai_rewrite', sentenceIds: [u.id], state: 'ai-drafted', model: 'claude-sonnet-5-5', promptHash: 'x', instruction: 'shorter', lang: 'en', intentNote: null, factIds: [], citeKeys: [], move: null, requestId: null },
      });
      const ack2 = await c.next('doc.ack');
      expect(ack2.version).toBe(ack.version + 1);
      const p2 = await c.next('sentences.patch', (m) => m.version === ack2.version && m.upserts.some((x) => x.id === u.id));
      const ai = p2.upserts.find((x) => x.id === u.id)!;
      expect(ai.state).toBe('ai-drafted');
      expect(ai.everAi).toBe(true);

      // history route shows both versions after the AI change
      const h = (await req(port, 'GET', `/api/sentences/${u.id}/history`, { headers: auth() })).json();
      expect(h.versions.map((v: { origin: string }) => v.origin)).toEqual(['import', 'human_edit', 'ai_rewrite']);

      // stale base version -> fresh snapshot
      c.send({ type: 'doc.change', file: 'main.tex', baseVersion: 0, changes: ChangeSet.of([{ from: 0, insert: 'x' }], cur.length).toJSON(), annotation: null });
      const again = await c.next('doc.snapshot');
      expect(again.version).toBe(ack2.version);
      expect(again.text).toContain(rewrite);

      // invalid messages produce a notice, not a crash
      c.send({ type: 'doc.change', file: 'main.tex' });
      expect((await c.next('notice')).message).toMatch(/invalid doc.change/);
      c.ws.send('not json');
      expect((await c.next('notice')).message).toMatch(/not JSON/);
      c.send({ type: 'doc.open', file: '../repo/README.md' });
      expect((await c.next('notice')).message).toMatch(/doc.open failed/);

      // ghost requests are answered on the same socket (simulated AI)
      const afterRewrite = again.text;
      const cursor = afterRewrite.indexOf(rewrite) + rewrite.length;
      c.send({ type: 'ghost.request', requestId: 'g1', file: 'main.tex', version: again.version, cursor, trigger: 'manual', prefix: '' });
      const ghost = await Promise.race([c.next('ghost.result', (m) => m.requestId === 'g1', 10_000), c.next('ghost.empty', (m) => m.requestId === 'g1', 10_000), c.next('ghost.error', (m) => m.requestId === 'g1', 10_000)]);
      expect(ghost.requestId).toBe('g1');
      c.send({ type: 'ghost.cancel', requestId: 'g1' });
      c.send({ type: 'ghost.feedback', requestId: 'g1', outcome: 'dismissed', acceptedText: null });

      // GET /api/doc mirrors the same version and text
      const doc = (await req(port, 'GET', '/api/doc?file=main.tex', { headers: auth() })).json();
      expect(doc.version).toBe(again.version);
      expect(doc.text).toBe(again.text);
      expect(Array.isArray(doc.sections)).toBe(true);
      expect((await req(port, 'GET', '/api/doc?file=../repo/README.md', { headers: auth() })).status).toBe(400);

      // flush writes to disk and acks the current version
      c.send({ type: 'doc.flush', file: 'main.tex', version: ack2.version });
      const ack3 = await c.next('doc.ack');
      expect(ack3.version).toBe(ack2.version);
      expect(readFileSync(join(ctx.paths.tex, 'main.tex'), 'utf8')).toContain(rewrite);
    } finally {
      c.ws.close();
    }
  });

  it('accept and reject routes; disclosure counts the AI sentence', async () => {
    const st = ctx.docs.get('main.tex') ?? (await ctx.docs.open('main.tex'));
    const human = st.units.find((x) => x.state === 'human')!;
    expect((await req(port, 'POST', `/api/sentences/${human.id}/accept`, { headers: auth(), body: {} })).status).toBe(409);
    expect((await req(port, 'POST', '/api/sentences/NOPE/accept', { headers: auth(), body: {} })).status).toBe(404);
    // make one proposed (metadata), then accept it
    ctx.docs.updateUnit(human.id, { state: 'proposed', everAi: true });
    const acc = await req(port, 'POST', `/api/sentences/${human.id}/accept`, { headers: auth(), body: {} });
    expect(acc.status).toBe(200);
    expect(acc.json()).toMatchObject({ id: human.id, state: 'ai-drafted' });
    expect(acc.json().acceptedAt).toBeTruthy();
    const rej = await req(port, 'POST', `/api/sentences/${human.id}/reject`, { headers: auth(), body: {} });
    expect(rej.json().replacement).toMatch(/^\[claim: .+\?\]$/);
    await ctx.docs.drainHistory();
    const events = readFileSync(ctx.paths.history, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(events.some((e) => e.event === 'accept' && e.sentenceId === human.id)).toBe(true);
    expect(events.some((e) => e.event === 'reject' && e.sentenceId === human.id)).toBe(true);

    const d = await req(port, 'GET', '/api/disclosure?venue=aps', { headers: auth() });
    expect(d.status).toBe(200);
    const body = d.json();
    expect(body.venue).toBe('aps');
    expect(body.stats.everAi).toBeGreaterThanOrEqual(1);
    expect(body.latex.length).toBeGreaterThan(20);
    expect(existsSync(ctx.paths.aiUseRecord)).toBe(true);
    expect((await req(port, 'GET', '/api/disclosure?venue=nature', { headers: auth() })).status).toBe(400);
  });

  it('sync routes in mode none: 409 with a clear message; push check works without git', async () => {
    const pull = await req(port, 'POST', '/api/sync/pull', { headers: auth(), body: {} });
    expect(pull.status).toBe(409);
    expect(pull.json().error).toMatch(/Sync is off/);
    const check = await req(port, 'GET', '/api/sync/push-check', { headers: auth() });
    expect(check.status).toBe(200);
    expect(check.json()).toHaveProperty('blockers');
    expect((await req(port, 'POST', '/api/sync/push', { headers: auth(), body: {} })).status).toBe(400);
  });

  it('other agents\' routes are registered', async () => {
    const r = await req(port, 'GET', '/api/cost', { headers: auth() });
    expect(r.status).toBe(200);
    const q = await req(port, 'GET', '/api/questions', { headers: auth() });
    expect(q.status).toBe(200);
  });
});

describe('claimPlaceholder', () => {
  it('keeps the words, drops LaTeX and brackets', () => {
    expect(claimPlaceholder('The rate is $0.55\\%$ [see Ref.~\\cite{x}].')).toMatch(/^\[claim: The rate is .*\?\]$/);
    expect(claimPlaceholder('')).toBe('[claim: removed sentence?]');
    expect(claimPlaceholder('[claim: old text?]')).toBe('[claim: old text?]');
    // LaTeX specials survive (a bare % would comment out the rest of the line)
    expect(claimPlaceholder('The fake-track rate is 0.55\\% against 1.38\\%.')).toBe('[claim: The fake-track rate is 0.55\\% against 1.38\\%?]');
    // no number is invented for a \ref, keys and math stay
    expect(claimPlaceholder('See Fig.~\\ref{fig:eff} and $[0,1]$~\\cite[p.~2]{Ju2022}.')).toBe('[claim: See Fig. \\ref{fig:eff} and $\\lbrack{}0,1\\rbrack{}$ \\cite{Ju2022}?]');
    // long sentences are cut to fit the placeholder limit (core findPlaceholders: 160 chars)
    const long = claimPlaceholder('word '.repeat(80) + 'end.');
    expect(long.length).toBeLessThanOrEqual(162);
    expect(long.endsWith('...?]')).toBe(true);
    expect(findPlaceholders(long)).toHaveLength(1);
  });
});
