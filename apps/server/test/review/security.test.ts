/**
 * Security review (reviewer, security lens): the local server must not be an attack surface.
 *
 * Every `it` here states the property it checks. Tests marked "BUG:" fail on the current code and
 * demonstrate a finding; the rest are regression tests for properties that hold today.
 */
import { request as httpRequest } from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createCtx, type AppCtx } from '../../src/ctx';
import { createServer, type PaperServer } from '../../src/server';
import { initProject } from '../../src/project/init';
import { buildQueryOptions } from '../../src/services/agents/options';
import { ReadOnlyPolicy } from '../../src/services/agents/guard';
import { createBuildService } from '../../src/services/build/buildService';
import { makeTempProject, makeTestCtx, SKILL_DIR, type TempProject } from '../helpers/ctx';

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

function wsStatus(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    ws.once('open', () => {
      ws.close();
      resolve(101);
    });
    ws.once('unexpected-response', (rq, res) => {
      rq.destroy();
      res.destroy();
      resolve(res.statusCode ?? 0);
    });
    ws.once('error', () => resolve(-1));
  });
}

/** What a browser sends for `fetch(url, { method: 'POST', mode: 'no-cors' })` from another site. */
const CROSS_SITE = { origin: 'http://evil.example', 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'cross-site', 'content-length': '0' };

describe('security: local server (fake AI, fixture project)', () => {
  let project: TempProject;
  let ctx: AppCtx;
  let server: PaperServer;
  let port: number;
  let dist: string;
  let outside: string;
  const auth = () => ({ 'x-paper-token': ctx.token });

  beforeAll(async () => {
    project = await makeTempProject();
    outside = mkdtempSync(join(tmpdir(), 'paper-outside-'));
    writeFileSync(join(outside, 'secret.tex'), '\\documentclass{article}\\begin{document}OUTSIDE-SECRET\\end{document}\n');
    mkdirSync(join(outside, 'dir'));
    writeFileSync(join(outside, 'dir', 'x.tex'), 'OUTSIDE-DIR-SECRET\n');
    symlinkSync(join(outside, 'secret.tex'), join(project.paths.tex, 'link.tex'));
    symlinkSync(join(outside, 'dir'), join(project.paths.tex, 'linkdir'));
    await initProject(project.root, { repo: project.repoDir, skill: SKILL_DIR });
    ctx = await createCtx({ root: project.root, fake: true, logLevel: 'error', watch: false, lintSidecar: false, docs: { segmentDebounceMs: 20, writeDebounceMs: 50 } });
    dist = mkdtempSync(join(tmpdir(), 'paper-dist-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><html><head><title>x</title></head><body></body></html>');
    writeFileSync(join(dist, 'app.js'), 'console.log(1)');
    server = await createServer({ ctx, port: 0, webDist: dist, pingIntervalMs: 60_000 });
    port = server.port;
  });

  afterAll(async () => {
    await server?.close();
    await ctx?.close();
    project?.cleanup();
    rmSync(dist, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  /* ------------------------------ token on every /api route ------------------------------ */

  it('regression (SEC-1): a percent-encoded /api path (/%61pi/...) does not reach the API routes without the token', async () => {
    // find-my-way decodes %61 -> "a" when routing, but the auth hook tests the raw URL for "/api/".
    const r = await req(port, 'GET', '/%61pi/doc?file=main.tex');
    expect(r.body).not.toContain('SYNTHETIC TEST FIXTURE');
    expect(r.status).toBe(401);
  });

  it('regression (SEC-1): a cross-site no-cors POST to /%61pi/agents/read-repo does not start an agent job (CSRF, no token)', async () => {
    const before = ctx.jobs.list().length;
    const r = await req(port, 'POST', '/%61pi/agents/read-repo', { headers: CROSS_SITE });
    expect(ctx.jobs.list().length).toBe(before);
    expect(r.status).toBe(401);
  });

  it('regression (SEC-1): other encodings of API paths (/%61pi/project, /%2561pi, //api, /API) do not bypass the token', async () => {
    for (const p of ['/%61pi/project', '/%61pi/sync/status', '/%61pi/outline', '/%61pi/facts', '/%61pi/jobs', '/%2561pi/project', '//api/project', '/%2Fapi/project', '/API/project', '/%61pi/nonexistent', '/a%70i/doc?file=main.tex']) {
      const r = await req(port, 'GET', p);
      expect.soft(r.status, p).not.toBe(200);
    }
  });

  it('every plain /api route refuses requests without the token (header or GET ?token=)', async () => {
    const routes: Array<[string, string]> = [
      ['GET', '/api/project'],
      ['GET', '/api/doc?file=main.tex'],
      ['GET', '/api/pdf'],
      ['GET', '/api/facts'],
      ['GET', '/api/outline'],
      ['GET', '/api/sync/status'],
      ['GET', '/api/sync/push-check'],
      ['POST', '/api/sync/pull'],
      ['POST', '/api/sync/push'],
      ['POST', '/api/compile'],
      ['POST', '/api/agents/read-repo'],
      ['POST', '/api/agents/draft'],
      ['GET', '/api/synctex/forward?file=main.tex&line=1'],
      ['GET', '/api/jobs'],
      ['PUT', '/api/outline'],
      ['DELETE', '/api/doc/orphans/x'],
      ['GET', '/api/nonexistent'],
      ['GET', '/api'],
      ['GET', '/api/project/'],
    ];
    for (const [m, p] of routes) {
      const r = await req(port, m, p, m === 'GET' || m === 'DELETE' ? {} : { headers: { 'content-type': 'application/json' }, body: '{}' });
      expect.soft(r.status, `${m} ${p}`).toBe(401);
      expect.soft(r.headers['access-control-allow-origin'], `${m} ${p}`).toBeUndefined();
    }
    expect((await req(port, 'GET', `/api/pdf?token=${encodeURIComponent(ctx.token)}`)).status).not.toBe(401);
    expect((await req(port, 'POST', `/api/compile?token=${encodeURIComponent(ctx.token)}`, { headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
  });

  it('Host header: anything but 127.0.0.1:<port> / localhost:<port> is 421 (DNS rebinding), also for /, /ws and /api/session', async () => {
    for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1.nip.io:${port}`, `localhost.:${port}`, `127.0.0.1:${port + 1}`, `[::1]:${port}`]) {
      for (const p of ['/', '/api/session', '/api/project', '/app.js']) {
        const r = await req(port, 'GET', p, { host, headers: { 'x-paper-client': '1', ...auth() } });
        expect.soft(r.status, `${host} ${p}`).toBe(421);
        expect.soft(r.body, `${host} ${p}`).not.toContain(ctx.token);
      }
    }
    expect(await wsStatus(port, `/ws?token=${encodeURIComponent(ctx.token)}`, { host: `evil.example:${port}` })).toBe(421);
  });

  it('/api/session hands out the token only with x-paper-client: 1; no CORS headers, preflight never approved', async () => {
    const noHdr = await req(port, 'GET', '/api/session', { headers: { origin: 'http://evil.example' } });
    expect(noHdr.status).toBe(403);
    expect(noHdr.body).not.toContain(ctx.token);
    const pre = await req(port, 'OPTIONS', '/api/session', { headers: { origin: 'http://evil.example', 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-paper-client' } });
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
    expect(pre.headers['access-control-allow-headers']).toBeUndefined();
    const ok = await req(port, 'GET', '/api/session', { headers: { 'x-paper-client': '1' } });
    expect(ok.status).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('WebSocket: token required, foreign Origin refused (403), own origin accepted', async () => {
    const t = encodeURIComponent(ctx.token);
    expect(await wsStatus(port, '/ws')).toBe(401);
    expect(await wsStatus(port, '/ws?token=wrong')).toBe(401);
    expect(await wsStatus(port, `/ws?token=${t}`, { origin: 'http://evil.example' })).toBe(403);
    expect(await wsStatus(port, `/ws?token=${t}`, { origin: 'null' })).toBe(403);
    expect(await wsStatus(port, `/ws?token=${t}`, { origin: `http://127.0.0.1:${port + 1}` })).toBe(403);
    expect(await wsStatus(port, `/ws?token=${t}`, { origin: `http://127.0.0.1:${port}` })).toBe(101);
  });

  it('regression (SEC-1): a cross-site page cannot open ws://127.0.0.1:<port>/%77s without the token and read the manuscript', async () => {
    // WebSockets are not subject to CORS: any web page may open one; only the Origin + token checks protect it.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/%77s`, { headers: { origin: 'http://evil.example' } });
    const got = await new Promise<string>((resolve) => {
      let text = '';
      ws.on('message', (d) => {
        const m = JSON.parse(String(d));
        if (m.type === 'doc.snapshot') {
          text = m.text;
          ws.close();
        }
      });
      ws.once('open', () => ws.send(JSON.stringify({ type: 'doc.open', file: 'main.tex' })));
      ws.once('unexpected-response', (rq, res) => {
        rq.destroy();
        res.destroy();
        resolve(`HTTP ${res.statusCode}`);
      });
      ws.once('close', () => resolve(text));
      ws.once('error', () => resolve('error'));
      setTimeout(() => resolve(text || 'timeout'), 5000);
    });
    expect(got).not.toContain('SYNTHETIC TEST FIXTURE');
  });

  it('a request without any Host header is refused (421)', async () => {
    const { createConnection } = await import('node:net');
    const raw = await new Promise<string>((resolve) => {
      const s = createConnection(port, '127.0.0.1', () => s.write('GET /api/session HTTP/1.0\r\nx-paper-client: 1\r\n\r\n'));
      let buf = '';
      s.on('data', (d) => (buf += d));
      s.on('end', () => resolve(buf));
      s.on('error', () => resolve(buf));
    });
    expect(raw).toMatch(/^HTTP\/1\.[01] 421/);
    expect(raw).not.toContain(ctx.token);
  });

  /* ------------------------------------- path safety ------------------------------------- */

  it('GET /api/doc refuses traversal, absolute, NUL, encoded and symlink-escaping paths', async () => {
    const bad = [
      '../repo/README.md',
      '../../etc/passwd',
      '/etc/passwd',
      encodeURIComponent(join(outside, 'secret.tex')),
      '%2e%2e%2frepo%2fx.tex',
      '..%5c..%5cx.tex',
      'main.tex%00.tex',
      'link.tex',
      'linkdir/x.tex',
      'sub/../../x.tex',
      'C:%5cx.tex',
    ];
    for (const f of bad) {
      const r = await req(port, 'GET', `/api/doc?file=${f}`, { headers: auth() });
      expect.soft(r.status, f).toBeGreaterThanOrEqual(400);
      expect.soft(r.status, f).toBeLessThan(500);
      expect.soft(r.body, f).not.toContain('OUTSIDE');
    }
  });

  it('semantic-lines and synctex refuse escaping paths; the file list never shows symlinks out of the tree', async () => {
    for (const file of ['link.tex', '../x.tex', '/etc/passwd', 'linkdir/x.tex', 'a\u0000.tex']) {
      const r = await req(port, 'POST', '/api/doc/semantic-lines', { headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify({ file }) });
      expect.soft(r.status, file).toBeGreaterThanOrEqual(400);
      expect.soft(r.status, file).toBeLessThan(500);
    }
    expect(spawnSync('cat', [join(outside, 'secret.tex')], { encoding: 'utf8' }).stdout).toContain('OUTSIDE-SECRET'); // untouched
    for (const file of ['../x.tex', '/etc/passwd', '..%2Fx.tex']) {
      const r = await req(port, 'GET', `/api/synctex/forward?file=${file}&line=1`, { headers: auth() });
      expect.soft(r.status, file).toBe(400);
    }
    const info = JSON.parse((await req(port, 'GET', '/api/project', { headers: auth() })).body);
    expect(info.files).not.toContain('link.tex');
    expect(info.files).not.toContain('linkdir/x.tex');
  });

  it('static files cannot be read outside the web dist (encoded traversal)', async () => {
    for (const p of ['/..%2f..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd', '/..\\..\\etc\\passwd', '/.%2e/.%2e/etc/passwd']) {
      const r = await req(port, 'GET', p);
      expect.soft(r.body, p).not.toMatch(/root:.*:0:0:/);
    }
  });

  it('regression (SEC-3): the Overleaf git token in the remote URL is not sent to the browser (ProjectInfo, WS welcome, sync status)', async () => {
    // `paper import https://git:<token>@git.overleaf.com/<id>` stores that URL as config.sync.remote (import.ts:
    // extra.remote = opts.remote ?? src); the CLI masks it (cli.ts maskUrl) but the server does not.
    const prev = ctx.config;
    await ctx.saveConfig({ ...prev, sync: { ...prev.sync, mode: 'git', remote: 'https://git:olp_SECRET0verleafT0ken@git.overleaf.com/0123456789abcdef' } });
    try {
      const r = await req(port, 'GET', '/api/project', { headers: auth() });
      expect.soft(r.body).not.toContain('olp_SECRET0verleafT0ken');
      const welcome = await new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(ctx.token)}`);
        ws.once('open', () => ws.send(JSON.stringify({ type: 'hello', clientId: 'sec-test' })));
        ws.on('message', (d) => {
          if (JSON.parse(String(d)).type === 'welcome') {
            ws.close();
            resolve(String(d));
          }
        });
        setTimeout(() => resolve('timeout'), 4000);
      });
      expect.soft(welcome).not.toContain('olp_SECRET0verleafT0ken');
      const st = await req(port, 'GET', '/api/sync/status', { headers: auth() });
      expect.soft(st.body).not.toContain('olp_SECRET0verleafT0ken');
      // the stored config keeps the credential (git needs it); only what leaves the server is masked
      expect(ctx.config.sync.remote).toContain('olp_SECRET0verleafT0ken');
      const { maskRemoteUrl } = await import('../../src/config');
      expect(maskRemoteUrl('https://git:olp_x@git.overleaf.com/abc')).toBe('https://git:***@git.overleaf.com/abc');
      expect(maskRemoteUrl('https://ghp_token@github.com/o/r.git')).toBe('https://***@github.com/o/r.git');
      expect(maskRemoteUrl('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
    } finally {
      await ctx.saveConfig(prev);
    }
  });

  it('the token never appears in a response to an unauthenticated /api request, and the server logs no token', async () => {
    const r = await req(port, 'GET', '/api/project');
    expect(r.body).not.toContain(ctx.token);
  });
});

/* --------------------------------- Agent SDK configuration --------------------------------- */

describe('security: Agent SDK options and guard', () => {
  const base = {
    role: 'repo-reader' as const,
    model: 'claude-sonnet-5-5',
    claudeCwd: '/p/.paper/claude',
    repoDir: '/p/repo',
    texRoot: '/p/tex',
    skillDir: '/p/skill',
    systemPrompt: 'sys',
    outputSchema: { type: 'object' },
    maxBudgetUsd: 1,
    maxTurns: 5,
    guard: async () => ({}),
    persistSession: false,
    abortController: new AbortController(),
  };

  it('regression (SEC-2): the Claude Code process does not inherit ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN from the environment', () => {
    // service.ts passes `baseEnv: process.env`; the direct SDK client deliberately ignores these variables
    // (apiKey.ts: "the app never inherits ANTHROPIC_BASE_URL silently"), but the agents (which read the
    // unpublished analysis repo) would send everything to whatever ANTHROPIC_BASE_URL names.
    const env = { PATH: '/usr/bin', HOME: '/home/u', ANTHROPIC_BASE_URL: 'https://proxy.other-tool.example', ANTHROPIC_AUTH_TOKEN: 'other-tools-token' };
    const o = buildQueryOptions({ ...base, baseEnv: env });
    expect(o.env?.ANTHROPIC_BASE_URL).not.toBe('https://proxy.other-tool.example');
    expect(o.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('agents are read-only: no Bash/Write/Edit/WebFetch, dontAsk, guard blocks on failure, no bypassPermissions', () => {
    const o = buildQueryOptions({ ...base, baseEnv: { PATH: '/usr/bin' } });
    expect(o.tools).toEqual(['Read', 'Glob', 'Grep', 'Skill']);
    for (const t of ['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'NotebookEdit']) expect(o.disallowedTools).toContain(t);
    expect(o.permissionMode).toBe('dontAsk');
    expect(o.allowDangerouslySkipPermissions).toBeUndefined();
    expect(o.hooks?.PreToolUse?.[0]).toMatchObject({ onFailure: 'block' });
    expect(o.hooks?.PreToolUse?.[0]?.matcher).toBeUndefined();
  });

  describe('guard', () => {
    let root: string;
    let policy: ReadOnlyPolicy;
    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'paper-guard-'));
      for (const d of ['repo/results', 'repo/private', 'tex', 'claude', 'skill', 'outside']) mkdirSync(join(root, d), { recursive: true });
      writeFileSync(join(root, 'repo', 'results', 'a.json'), '{}');
      writeFileSync(join(root, 'repo', '.env'), 'ANTHROPIC_API_KEY=sk-ant-secret\n');
      writeFileSync(join(root, 'repo', 'private', 'referee_notes'), 'unpublished, out of scope\n');
      writeFileSync(join(root, 'outside', 'x.txt'), 'x');
      symlinkSync(join(root, 'outside'), join(root, 'repo', 'results', 'escape'));
      policy = new ReadOnlyPolicy({
        roots: [
          { dir: join(root, 'repo'), kind: 'repo' },
          { dir: join(root, 'tex'), kind: 'tex' },
          { dir: join(root, 'claude'), kind: 'claude' },
          { dir: join(root, 'skill'), kind: 'skill' },
        ],
        repoGlobs: ['results/**'],
        mcpTools: [],
        skills: ['hep-paper-writing'],
        cwd: join(root, 'claude'),
      });
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('denies writes, shell, network and unknown tools; denies reads outside roots, via symlinks, of secrets, NUL', () => {
      for (const t of ['Write', 'Edit', 'MultiEdit', 'Bash', 'WebFetch', 'NotebookEdit', 'Agent', 'Task', 'SomethingNew', 'mcp__evil__x']) expect.soft(policy.check(t, { file_path: join(root, 'repo', 'x') }).allow, t).toBe(false);
      expect(policy.check('Read', { file_path: join(root, 'repo', 'results', 'a.json') }).allow).toBe(true);
      expect(policy.check('Read', { file_path: '/etc/passwd' }).allow).toBe(false);
      expect(policy.check('Read', { file_path: join(root, 'repo', 'results', 'escape', 'x.txt') }).allow).toBe(false);
      expect(policy.check('Read', { file_path: join(root, 'repo', 'results', '..', '..', 'outside', 'x.txt') }).allow).toBe(false);
      expect(policy.check('Read', { file_path: join(root, 'repo', '.env') }).allow).toBe(false);
      expect(policy.check('Read', { file_path: join(root, 'repo', 'results', 'a.json\u0000') }).allow).toBe(false);
      expect(policy.check('Read', { file_path: join(root, 'repo', 'private', 'referee_notes') }).allow).toBe(false); // out of scope
      expect(policy.check('Glob', { pattern: '../**' }).allow).toBe(false);
      expect(policy.check('Glob', { pattern: '/etc/*' }).allow).toBe(false);
      expect(policy.check('Grep', { pattern: 'x', path: '/etc' }).allow).toBe(false);
    });

    it('regression (SEC-4): Grep on an extension-less file is denied like Read of the same file (out of the confirmed scope)', () => {
      const f = join(root, 'repo', 'private', 'referee_notes');
      expect(policy.check('Read', { file_path: f }).allow).toBe(false);
      expect(policy.check('Grep', { pattern: '.', path: f, output_mode: 'content' }).allow).toBe(false);
    });

    it('regression (SEC-4): Grep over a repo folder is limited to the confirmed globs and kept away from secret files', () => {
      // A folder search returns file contents (output_mode: content) from every file below it.
      expect(policy.check('Grep', { pattern: '.', path: join(root, 'repo', 'private'), output_mode: 'content' }).allow).toBe(false);
      expect(policy.check('Grep', { pattern: 'KEY', path: join(root, 'repo'), glob: '.env', output_mode: 'content' }).allow).toBe(false);
      expect(policy.check('Grep', { pattern: 'KEY', path: join(root, 'repo'), glob: '{*.json,.e*}', output_mode: 'content' }).allow).toBe(false);
      expect(policy.check('Grep', { pattern: 'KEY', path: join(root, 'repo'), glob: '*.pem' }).allow).toBe(false);
      // the repo root holds .env and private/: a folder search there is refused as a whole
      expect(policy.check('Grep', { pattern: '.', path: join(root, 'repo'), output_mode: 'content' }).allow).toBe(false);
    });

    it('Grep inside the confirmed scope still works (a file in it; a folder whose files are all in it)', () => {
      mkdirSync(join(root, 'repo', 'results', 'fits'), { recursive: true });
      writeFileSync(join(root, 'repo', 'results', 'fits', 'b.json'), '{}');
      expect(policy.check('Grep', { pattern: 'eff', path: join(root, 'repo', 'results', 'a.json') }).allow).toBe(true);
      expect(policy.check('Grep', { pattern: 'eff', path: join(root, 'repo', 'results', 'fits'), glob: '*.json' }).allow).toBe(true);
      expect(policy.check('Grep', { pattern: 'x', path: join(root, 'tex') }).allow).toBe(true);
    });
  });
});

/* ------------------------------------ latexmk arguments ------------------------------------ */

const HAS_LATEXMK = (() => {
  const r = spawnSync('latexmk', ['-v'], { stdio: 'ignore' });
  return !r.error && r.status !== null;
})();

describe.skipIf(!HAS_LATEXMK)('security: latexmk arguments', () => {
  let project: TempProject;
  afterAll(() => project?.cleanup());

  it('regression (SEC-5): a main file name starting with "-" is not parsed by latexmk as an option (-pdflatex=<cmd> would run a command)', async () => {
    project = await makeTempProject();
    const main = '-pdflatex=sh pwn.tex';
    writeFileSync(join(project.paths.tex, main), '\\documentclass{article}\\begin{document}x\\end{document}\n');
    // the "command" latexmk runs instead of pdflatex: sh pwn.tex <args>; cwd is .paper/build/src
    writeFileSync(join(project.paths.tex, 'pwn.tex'), 'echo pwned > ../../../PWNED\nexit 1\n');
    const ctx = makeTestCtx(project);
    await ctx.saveConfig({ ...ctx.config, mainFile: main });
    const build = createBuildService(ctx, { timeoutMs: 60_000 });
    const st = await build.compile('manual');
    expect(existsSync(join(project.root, 'PWNED'))).toBe(false);
    expect(st.logTail).not.toContain("Running 'sh pwn.tex");
  });

  it('a main file name with spaces and quotes compiles as one argument (no shell)', async () => {
    const p = await makeTempProject();
    try {
      const main = `my "paper" it's.tex`;
      writeFileSync(join(p.paths.tex, main), '\\documentclass{article}\\begin{document}x\\end{document}\n');
      const ctx = makeTestCtx(p);
      await ctx.saveConfig({ ...ctx.config, mainFile: main });
      const st = await createBuildService(ctx, { timeoutMs: 60_000 }).compile('manual');
      // whatever TeX thinks of the name, nothing outside the build dir is created
      expect(existsSync(join(p.root, 'PWNED'))).toBe(false);
      expect(['ok', 'error']).toContain(st.state);
    } finally {
      p.cleanup();
    }
  });
});

/* ----------------------------------------- zip-slip ----------------------------------------- */

describe('security: paper import of a hostile .zip', () => {
  it('extractZip keeps ../, absolute and symlink members inside the destination', async () => {
    const { extractZip } = await import('../../src/project/import');
    const base = mkdtempSync(join(tmpdir(), 'paper-zip-'));
    try {
      const zip = join(base, 'evil.zip');
      const py = [
        'import sys, zipfile, stat',
        'z = zipfile.ZipFile(sys.argv[1], "w")',
        'z.writestr("proj/main.tex", "\\\\documentclass{article}\\\\begin{document}x\\\\end{document}\\n")',
        'z.writestr("proj/../../ESCAPED_DOTDOT.txt", "x")',
        'z.writestr("/tmp/ESCAPED_ABS_' + 'paper.txt", "x")',
        'i = zipfile.ZipInfo("proj/link.tex"); i.external_attr = (stat.S_IFLNK | 0o777) << 16',
        'z.writestr(i, "/etc/passwd")',
        'z.close()',
      ].join('\n');
      const r = spawnSync('python3', ['-I', '-c', py, zip], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      const project = join(base, 'p');
      mkdirSync(project);
      await extractZip(zip, join(project, 'tex'));
      expect(existsSync(join(base, 'ESCAPED_DOTDOT.txt'))).toBe(false);
      expect(existsSync(join(project, 'ESCAPED_DOTDOT.txt'))).toBe(false);
      expect(existsSync(join(tmpdir(), '..', 'ESCAPED_DOTDOT.txt'))).toBe(false);
      expect(existsSync('/tmp/ESCAPED_ABS_paper.txt')).toBe(false);
      const { lstatSync, readFileSync } = await import('node:fs');
      const link = join(project, 'tex', 'link.tex');
      if (existsSync(link)) {
        expect(lstatSync(link).isSymbolicLink()).toBe(false);
        expect(readFileSync(link, 'utf8')).not.toMatch(/root:/);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
