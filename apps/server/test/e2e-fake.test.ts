/**
 * End-to-end in fake-AI mode, in process: a temp project copied from fixtures/canto-demo (tex + repo),
 * `paper init`, the real Ctx (every service) and the real server on an ephemeral port. Exercises the
 * same path as the manual smoke: session token, project, document, facts (+ rescan), a real latexmk
 * compile and the PDF, the disclosure statement, the repository reader job, and a WebSocket session
 * that types a sentence with a number and asks for a ghost continuation.
 */
import { request as httpRequest } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ServerMessage, type SentenceUnit } from '@paper-copilot/core';
import { createCtx, type AppCtx } from '../src/ctx';
import { createServer, type PaperServer } from '../src/server';
import { initProject } from '../src/project/init';
import { makeTempProject, SKILL_DIR, type TempProject } from './helpers/ctx';

const hasLatexmk = (() => {
  try {
    execFileSync('latexmk', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  json: () => any;
}

function http(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const r = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) } : {}), ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buf, json: () => JSON.parse(buf.toString('utf8')) });
        });
      },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

class WsClient {
  msgs: ServerMessage[] = [];
  private waiters: Array<{ pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  constructor(public ws: WebSocket) {
    ws.on('message', (d) => {
      const m = ServerMessage.parse(JSON.parse(String(d)));
      this.msgs.push(m);
      for (const w of [...this.waiters])
        if (w.pred(m)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(m);
        }
    });
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  /** The first matching message (already received or future); several types may be given. */
  next(types: ServerMessage['type'][], pred: (m: ServerMessage) => boolean = () => true, timeoutMs = 8000): Promise<ServerMessage> {
    const match = (m: ServerMessage) => types.includes(m.type) && pred(m);
    const seen = this.msgs.find(match);
    if (seen) {
      this.msgs.splice(this.msgs.indexOf(seen), 1);
      return Promise.resolve(seen);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${types.join('|')}`)), timeoutMs);
      this.waiters.push({
        pred: match,
        resolve: (m) => {
          clearTimeout(t);
          const i = this.msgs.indexOf(m);
          if (i >= 0) this.msgs.splice(i, 1);
          resolve(m);
        },
      });
    });
  }
}

function connect(port: number, token: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`, { headers: { origin: `http://127.0.0.1:${port}` } });
    const c = new WsClient(ws);
    ws.once('open', () => resolve(c));
    ws.once('unexpected-response', (_rq, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

describe('end to end (fake AI, fixture project, real services)', () => {
  let project: TempProject;
  let ctx: AppCtx;
  let server: PaperServer;
  let port: number;
  let token: string;
  const auth = () => ({ 'x-paper-token': token });

  beforeAll(async () => {
    project = await makeTempProject();
    await initProject(project.root, { repo: project.repoDir, skill: SKILL_DIR });
    ctx = await createCtx({ root: project.root, fake: true, logLevel: 'error', watch: false, lintSidecar: false, docs: { segmentDebounceMs: 20, writeDebounceMs: 50 } });
    await ctx.start();
    server = await createServer({ ctx, port: 0, pingIntervalMs: 60_000 });
    port = server.port;
  }, 30_000);

  afterAll(async () => {
    await server?.close();
    await ctx?.close();
    project?.cleanup();
  });

  it('hands the token to the client and refuses requests without it', async () => {
    expect((await http(port, 'GET', '/api/project')).status).toBe(401);
    const s = await http(port, 'GET', '/api/session', { 'x-paper-client': '1' });
    expect(s.status).toBe(200);
    token = s.json().token;
    expect(token).toBe(ctx.token);
  });

  it('GET /api/project describes the fixture project in simulated mode', async () => {
    const r = await http(port, 'GET', '/api/project', auth());
    expect(r.status).toBe(200);
    const p = r.json();
    expect(p.fakeLlm).toBe(true);
    expect(p.files).toContain('main.tex');
    expect(p.config.repoDir).toBe(project.repoDir);
    expect(p.skill.found).toBe(true);
  });

  it('GET /api/doc segments main.tex and links its numbers to facts', async () => {
    const r = await http(port, 'GET', '/api/doc?file=main.tex', auth());
    expect(r.status).toBe(200);
    const d = r.json();
    expect(d.text).toBe(readFileSync(`${project.root}/tex/main.tex`, 'utf8'));
    expect(d.units.length).toBeGreaterThan(10);
    expect(d.sections.map((s: { id: string }) => s.id)).toContain('sec:results');
    const linked = (d.units as SentenceUnit[]).flatMap((u) => u.facts);
    expect(linked).toContain('f.g1.delta_points');
    expect((await http(port, 'GET', '/api/doc?file=../etc/passwd', auth())).status).toBeGreaterThanOrEqual(400);
  });

  it('GET /api/facts and POST /api/facts/rescan read the fixture artifacts', async () => {
    const r = await http(port, 'GET', '/api/facts', auth());
    expect(r.status).toBe(200);
    const facts = r.json().facts as Array<{ id: string; value: unknown; artifact: string }>;
    const delta = facts.find((f) => f.id === 'f.g1.delta_points');
    expect(delta?.artifact).toBe('results/addendum_g_g1_v1_claim.json');
    expect(typeof delta?.value).toBe('number');
    const s = await http(port, 'POST', '/api/facts/rescan', auth(), {});
    expect(s.status).toBe(200);
    expect(s.json().count).toBe(facts.length);
    expect(s.json().stale).toEqual([]);
  });

  it.skipIf(!hasLatexmk)(
    'POST /api/compile builds the PDF and GET /api/pdf serves it',
    async () => {
      const c = await http(port, 'POST', '/api/compile', auth(), {});
      expect(c.status).toBe(200);
      const st = c.json();
      expect(st.state).toBe('ok');
      expect(st.errors).toEqual([]);
      expect(st.pdfVersion).toBeGreaterThanOrEqual(1);
      const pdf = await http(port, 'GET', `/api/pdf?token=${encodeURIComponent(token)}`);
      expect(pdf.status).toBe(200);
      expect(String(pdf.headers['content-type'])).toMatch(/application\/pdf/);
      expect(pdf.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      const fwd = await http(port, 'GET', '/api/synctex/forward?file=main.tex&line=50', auth());
      expect(fwd.status).toBe(200);
    },
    120_000,
  );

  it('GET /api/disclosure?venue=aps returns the statement', async () => {
    const r = await http(port, 'GET', '/api/disclosure?venue=aps', auth());
    expect(r.status).toBe(200);
    const d = r.json();
    expect(d.venue).toBe('aps');
    expect(d.latex.length).toBeGreaterThan(20);
    expect(d.stats.totalSentences).toBeGreaterThan(10);
  });

  it('POST /api/agents/read-repo runs the simulated reader as a job', async () => {
    const r = await http(port, 'POST', '/api/agents/read-repo', auth(), {});
    expect(r.status).toBe(200);
    const { jobId } = r.json();
    expect(typeof jobId).toBe('string');
    let job: any;
    for (let i = 0; i < 100; i++) {
      job = (await http(port, 'GET', `/api/jobs/${encodeURIComponent(jobId)}`, auth())).json();
      if (job.state !== 'running' && job.state !== 'queued') break;
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(job.state).toBe('done');
    expect(job.result.simulated).toBe(true);
    expect(job.result.facts.rejected).toEqual([]);
    expect(new Set(job.result.facts.added).size).toBe(job.result.facts.added.length);
    expect(job.result.facts.added).toContain('f.g1.delta_points');
    expect(readFileSync(ctx.paths.repoBrief, 'utf8')).toContain('（模拟）');
  });

  it('WebSocket: hello, doc.open, a typed sentence with a number, and a ghost request', async () => {
    const c = await connect(port, token);
    try {
      c.send({ type: 'hello', clientId: 'e2e' });
      const welcome = await c.next(['welcome']);
      expect(welcome).toMatchObject({ type: 'welcome', fakeLlm: true });

      c.send({ type: 'doc.open', file: 'main.tex' });
      const snap = (await c.next(['doc.snapshot'])) as Extract<ServerMessage, { type: 'doc.snapshot' }>;
      let text = snap.text;
      const at = text.indexOf('\n', text.indexOf('\\label{sec:results}')) + 1;
      const typed = 'We find a gain of 2.32 points over the signal-trained baseline.\nThe fake-track rate of the new tracker is';
      c.send({ type: 'doc.change', file: 'main.tex', baseVersion: snap.version, changes: [at, [0, `${typed}\n`], text.length - at], annotation: null });
      const ack = (await c.next(['doc.ack'])) as Extract<ServerMessage, { type: 'doc.ack' }>;
      expect(ack.version).toBe(snap.version + 1);
      text = text.slice(0, at) + typed + '\n' + text.slice(at);

      const patch = (await c.next(['sentences.patch'], (m) => m.type === 'sentences.patch' && m.upserts.some((u) => text.slice(u.start, u.end).startsWith('We find a gain of 2.32 points')))) as Extract<
        ServerMessage,
        { type: 'sentences.patch' }
      >;
      const unit = patch.upserts.find((u) => text.slice(u.start, u.end).startsWith('We find a gain of 2.32 points'))!;
      expect(unit.state).toBe('human');
      expect(unit.facts).toContain('f.g1.delta_points');

      const prefix = 'The fake-track rate of the new tracker is';
      c.send({ type: 'ghost.request', requestId: 'g-e2e', file: 'main.tex', version: ack.version, cursor: at + typed.length, trigger: 'manual', prefix });
      const g = await c.next(['ghost.result', 'ghost.empty', 'ghost.error'], (m) => 'requestId' in m && m.requestId === 'g-e2e');
      expect(g.type).toBe('ghost.result');
      if (g.type === 'ghost.result') {
        // only the continuation after the typed prefix; grammatical, grounded (a label that exists)
        expect(g.text).toBe(' shown in Fig.~\\ref{fig:eff}.');
        expect(g.model).toMatch(/^fake-/);
        expect(g.issues.filter((i) => i.severity === 'block')).toEqual([]);
        // The continuation never invents a number: every digit in it comes from a linked fact.
        if (/\d/.test(g.text)) expect(g.factIds.length).toBeGreaterThan(0);
        c.send({ type: 'ghost.feedback', requestId: 'g-e2e', outcome: 'dismissed', acceptedText: null });
      }

      c.send({ type: 'doc.flush', file: 'main.tex', version: ack.version });
      await c.next(['doc.ack'], (m) => m.type === 'doc.ack' && m.version === ack.version);
      expect(readFileSync(`${project.root}/tex/main.tex`, 'utf8')).toContain('We find a gain of 2.32 points over the signal-trained baseline.');
    } finally {
      c.ws.close();
    }
  }, 30_000);

  it('an instruct proposal accepted as an annotated doc.change keeps the unit id (ai-drafted, everAi, ai_rewrite)', async () => {
    const c = await connect(port, token);
    try {
      c.send({ type: 'hello', clientId: 'e2e-rewrite' });
      c.send({ type: 'doc.open', file: 'main.tex' });
      const snap = (await c.next(['doc.snapshot'])) as Extract<ServerMessage, { type: 'doc.snapshot' }>;
      const unit = snap.units.find((u) => snap.text.slice(u.start, u.end).startsWith('Trackers tuned on prompt particles'))!;
      expect(unit.state).toBe('human');
      expect(unit.everAi).toBe(false);
      const r = await http(port, 'POST', `/api/sentences/${encodeURIComponent(unit.id)}/instruct`, auth(), { instruction: '把动词提前', lang: 'zh' });
      expect(r.status).toBe(200);
      const p = r.json();
      expect(p.sentenceId).toBe(unit.id);
      expect(p.origin).toBe('ai_rewrite');
      expect(p.notes).toMatch(/[\u4e00-\u9fff]/);
      // the web client's applyProposal: one transaction replacing the whole sentence, with provenance
      const text = `${p.text.replace(/\.$/, '')} in practice.`;
      const annotation = { origin: p.origin, sentenceIds: [unit.id], state: 'ai-drafted', model: p.model, promptHash: p.promptHash, instruction: '把动词提前', lang: 'zh', intentNote: null, factIds: p.factIds, citeKeys: p.citeKeys, move: null, requestId: null };
      const len = snap.text.length;
      c.send({ type: 'doc.change', file: 'main.tex', baseVersion: snap.version, changes: [unit.start, [unit.end - unit.start, text], len - unit.end], annotation });
      await c.next(['doc.ack'], (m) => m.type === 'doc.ack' && m.version === snap.version + 1);
      const patch = (await c.next(['sentences.patch'], (m) => m.type === 'sentences.patch' && m.upserts.some((u) => u.id === unit.id))) as Extract<ServerMessage, { type: 'sentences.patch' }>;
      const got = patch.upserts.find((u) => u.id === unit.id)!;
      expect(got.state).toBe('ai-drafted');
      expect(got.everAi).toBe(true);
      expect(got.model).toBe(p.model);
      const h = (await http(port, 'GET', `/api/sentences/${encodeURIComponent(unit.id)}/history`, auth())).json();
      expect(h.unit.id).toBe(unit.id);
      const last = h.versions.at(-1);
      expect(last).toMatchObject({ origin: 'ai_rewrite', text, instruction: '把动词提前', lang: 'zh', model: p.model });
      expect(h.versions.length).toBeGreaterThanOrEqual(2);
    } finally {
      c.ws.close();
    }
  }, 30_000);

  it('lint: lint.update carries the full list; POST /api/lint/:id/dismiss hides a flag and re-sends the list', async () => {
    const c = await connect(port, token);
    try {
      c.send({ type: 'hello', clientId: 'e2e-lint' });
      c.send({ type: 'doc.open', file: 'main.tex' });
      const snap = (await c.next(['doc.snapshot'])) as Extract<ServerMessage, { type: 'doc.snapshot' }>;
      const at = snap.text.indexOf('\\section{Conclusions}');
      const typed = 'We delve into a pivotal tapestry of tracks.\n\n';
      c.send({ type: 'doc.change', file: 'main.tex', baseVersion: snap.version, changes: [at, [0, typed], snap.text.length - at], annotation: null });
      await c.next(['doc.ack']);
      const upd = (await c.next(['lint.update'], (m) => m.type === 'lint.update' && m.flags.some((f) => f.word === 'delve'), 8000)) as Extract<ServerMessage, { type: 'lint.update' }>;
      const flag = upd.flags.find((f) => f.word === 'delve')!;
      expect(flag.dismissed).toBe(false);
      const others = upd.flags.filter((f) => f.sentenceId !== flag.sentenceId).length;
      const d = await http(port, 'POST', `/api/lint/${encodeURIComponent(flag.id)}/dismiss`, auth(), {});
      expect(d.status).toBe(200);
      expect(d.json()).toMatchObject({ ok: true, known: true });
      const after = (await c.next(['lint.update'], (m) => m.type === 'lint.update' && m.flags.some((f) => f.id === flag.id && f.dismissed))) as Extract<ServerMessage, { type: 'lint.update' }>;
      // the full list: flags of other sentences are still there
      expect(after.flags.filter((f) => f.sentenceId !== flag.sentenceId).length).toBe(others);
      expect((await http(port, 'POST', '/api/lint/..%2Fx/dismiss', auth(), {})).status).toBe(400);
      // a reloaded page gets the stored list on doc.open
      const c2 = await connect(port, token);
      try {
        c2.send({ type: 'doc.open', file: 'main.tex' });
        const first = (await c2.next(['lint.update'])) as Extract<ServerMessage, { type: 'lint.update' }>;
        expect(first.flags.find((f) => f.id === flag.id)?.dismissed).toBe(true);
      } finally {
        c2.ws.close();
      }
    } finally {
      c.ws.close();
    }
  }, 30_000);
});
