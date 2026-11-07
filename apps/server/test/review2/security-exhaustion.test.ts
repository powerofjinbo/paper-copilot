/**
 * Security review, round 2: resource exhaustion from pathological LaTeX that arrives with a pull (a
 * co-author's commit, an Overleaf sync). The server is one Node process: a synchronous check that runs
 * for seconds freezes every request and the WebSocket (typing, ghost text, saving) for that long.
 *
 * The input is one prose paragraph of numerals with no sentence end (24 KB: 3000 times "1\% and ").
 * The faithfulness gate (gateSentence) does work over the whole sentence for every numeral it holds, so
 * its cost grows with the square of the sentence length; it runs on file open (the lint sentence pass:
 * claim-strength warnings) and on every report request (GET /api/submission-check).
 *
 * Tests marked "BUG:" fail on the current code and demonstrate a finding.
 */
import { request as httpRequest } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCtx, type AppCtx } from '../../src/ctx';
import { createServer, type PaperServer } from '../../src/server';
import { initProject } from '../../src/project/init';
import { makeTempProject, SKILL_DIR, type TempProject } from '../helpers/ctx';

function get(port: number, path: string, token: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: '127.0.0.1', port, method: 'GET', path, headers: { host: `127.0.0.1:${port}`, 'x-paper-token': token } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

/** Longest single stall of the event loop (ms) while `fn` runs: the largest gap between 10 ms ticks. */
async function maxStall(fn: () => Promise<unknown>): Promise<{ stallMs: number; ms: number }> {
  let last = performance.now();
  let worst = 0;
  const tick = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 10);
  const t0 = performance.now();
  try {
    await fn();
  } finally {
    clearInterval(tick);
  }
  worst = Math.max(worst, performance.now() - last);
  return { stallMs: Math.round(worst), ms: Math.round(performance.now() - t0) };
}

/** A server stall the author notices (typing stops echoing); generous for a slow CI box. */
const STALL_BUDGET_MS = 1500;
const PARAGRAPH = '1\\% and '.repeat(3000);
/** One long letter run in prose (a pasted base64 blob, a hash): 60 KB. */
const LONG_TOKEN = `See x${'a'.repeat(60_000)} for the data.`;

describe('security round 2: pathological LaTeX from a co-author does not freeze the server', () => {
  let project: TempProject;
  let ctx: AppCtx;
  let server: PaperServer;
  let port: number;

  beforeAll(async () => {
    project = await makeTempProject();
    const main = join(project.paths.tex, 'main.tex');
    writeFileSync(main, readFileSync(main, 'utf8').replace('\\end{document}', `${PARAGRAPH}\n\n${LONG_TOKEN}\n\n\\end{document}`));
    await initProject(project.root, { repo: project.repoDir, skill: SKILL_DIR });
    ctx = await createCtx({ root: project.root, fake: true, logLevel: 'error', watch: false, lintSidecar: false, docs: { segmentDebounceMs: 20, writeDebounceMs: 50 } });
    server = await createServer({ ctx, port: 0, pingIntervalMs: 60_000 });
    port = server.port;
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await ctx?.close();
    project?.cleanup();
  }, 60_000);

  it('BUG: opening the pulled file (lint sentence pass runs the gate on every unit) stalls the event loop for seconds', async () => {
    const r = await maxStall(async () => {
      expect((await get(port, '/api/doc?file=main.tex', ctx.token)).status).toBe(200);
      // the lint pass runs right after the open; give it time to run (and stall)
      const until = Date.now() + 15_000;
      while (Date.now() < until && ctx.lint.flags('main.tex').length === 0) await new Promise((res) => setTimeout(res, 100));
      await new Promise((res) => setTimeout(res, 500));
    });
    console.log(`open + lint: longest stall ${r.stallMs} ms (total ${r.ms} ms)`);
    expect(r.stallMs).toBeLessThan(STALL_BUDGET_MS);
  }, 120_000);

  it('BUG: GET /api/submission-check on that paragraph stalls the event loop for seconds (every request and the WebSocket wait)', async () => {
    await get(port, '/api/doc?file=main.tex', ctx.token);
    await new Promise((res) => setTimeout(res, 300));
    let res: { status: number; body: string } | null = null;
    const r = await maxStall(async () => {
      res = await get(port, '/api/submission-check?venue=aps', ctx.token);
    });
    console.log(`submission-check: longest stall ${r.stallMs} ms (total ${r.ms} ms)`);
    expect(res!.status).toBe(200);
    expect(r.stallMs).toBeLessThan(STALL_BUDGET_MS);
  }, 120_000);

  it('BUG: GET /api/terminology-report on one 60 KB letter run stalls the event loop for seconds (DEF_PAREN_RE has no word-start anchor: quadratic)', async () => {
    await get(port, '/api/doc?file=main.tex', ctx.token);
    await new Promise((res) => setTimeout(res, 300));
    let res: { status: number; body: string } | null = null;
    const r = await maxStall(async () => {
      res = await get(port, '/api/terminology-report', ctx.token);
    });
    console.log(`terminology-report: longest stall ${r.stallMs} ms (total ${r.ms} ms)`);
    expect(res!.status).toBe(200);
    expect(r.stallMs).toBeLessThan(STALL_BUDGET_MS);
  }, 120_000);
});
