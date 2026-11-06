/**
 * Scale: the real-size, multi-file paper of fixtures/large-multifile (main.tex + four \input section
 * files, about 400 prose sentences, 12 figures, 4 tables, 40 references, a repo/ whose numbers the prose
 * states) through the REAL services (createCtx: docs, facts, lit, lint with the real sidecar when python3
 * and the skill are present, build with latexmk/synctex when installed, sync guard) and the real server
 * (WebSocket typing).
 *
 * What it pins:
 * - every .tex file under texRoot opens (docs.files main first, sections/*.tex too) within budget;
 * - labels() covers the whole \input tree even when only sections/results.tex is open (a \ref to
 *   sec:intro or fig:detector must not be an unknown label for the gate);
 * - the gate passes every sentence with its own linked facts (no blocking issue: every prose number of
 *   the fixture is grounded in repo/);
 * - typing in sections/results.tex over the WebSocket: doc.ack per keystroke and the sentences.patch
 *   after the debounce, within budget, ids of untouched sentences kept;
 * - the push guard sees units and intent lines of every file of the tree, open or not;
 * - the document lint pass flattens the \input tree, maps flags back to the section files, finishes
 *   within budget and does not block the event loop;
 * - latexmk compiles the multi-file paper and SyncTeX forward/inverse land in sections/results.tex (the
 *   INPUT file), not in main.tex.
 *
 * Timing budgets use PERF_SLACK (3x on CI). Temp projects live under mkdtemp and are removed.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ChangeSet } from '@codemirror/state';
import { gateSentence, ServerMessage, type SentenceUnit } from '@paper-copilot/core';
import { createCtx, type AppCtx } from '../src/ctx';
import { createServer, type PaperServer } from '../src/server';
import { initProject } from '../src/project/init';
import { REPO_ROOT, SKILL_DIR } from './helpers/ctx';

const PERF_SLACK = process.env.CI ? 3 : 1;
const FX = join(REPO_ROOT, 'fixtures', 'large-multifile');
const RESULTS = 'sections/results.tex';
const FILES = ['main.tex', 'sections/appendix.tex', 'sections/intro.tex', 'sections/method.tex', 'sections/results.tex'];

const has = (cmd: string, args: string[]): boolean => {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
};
const hasLatexmk = has('latexmk', ['-v']) && has('synctex', ['help']);
const hasPython = spawnSync('python3', ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'], { timeout: 10_000 }).status === 0;
const hasSkill = existsSync(join(SKILL_DIR, 'scripts', 'style_check.py'));

interface Project {
  root: string;
  cleanup(): void;
}

async function makeLargeProject(): Promise<Project> {
  const root = mkdtempSync(join(tmpdir(), 'paper-scale-'));
  cpSync(join(FX, 'tex'), join(root, 'tex'), { recursive: true });
  cpSync(join(FX, 'repo'), join(root, 'repo'), { recursive: true });
  await initProject(root, { repo: join(root, 'repo'), skill: SKILL_DIR });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

/* ------------------------------------------------------------------------------------ */
/* Services                                                                              */
/* ------------------------------------------------------------------------------------ */

describe('large multi-file paper through the real services', () => {
  let project: Project;
  let ctx: AppCtx;

  beforeAll(async () => {
    project = await makeLargeProject();
    ctx = await createCtx({ root: project.root, fake: true, logLevel: 'error', watch: false, lintSidecar: hasPython && hasSkill, docs: { segmentDebounceMs: 20, writeDebounceMs: 50 } });
    await ctx.start();
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
    project?.cleanup();
  });

  it('lists every .tex file of the tree, main file first', async () => {
    expect(await ctx.docs.files()).toEqual(FILES);
    expect(ctx.config.mainFile).toBe('main.tex');
  });

  it('with only sections/results.tex open, labels() covers the whole \\input tree', async () => {
    const st = await ctx.docs.open(RESULTS);
    expect(ctx.docs.openFiles()).toEqual([RESULTS]);
    // refs of results.tex point into other files
    expect(st.seg.refs).toEqual(expect.arrayContaining(['app:seeds', 'fig:pileup']));
    const labels = ctx.docs.labels();
    for (const l of ['sec:intro', 'sec:method', 'sec:summary', 'app:stat', 'app:seeds', 'fig:detector', 'fig:bootstrap', 'tab:samples', 'tab:hyper', 'eq:eff', 'sec:results', 'fig:pileup']) expect(labels).toContain(l);
    // every \ref of the paper resolves
    for (const f of FILES) {
      const text = readFileSync(join(project.root, 'tex', f), 'utf8');
      for (const m of text.matchAll(/\\ref\{([^}]+)\}/g)) expect(labels).toContain(m[1]);
    }
    // cached: a second call within the TTL does not re-read the tree and returns the same set
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) ctx.docs.labels();
    expect((performance.now() - t0) / 50).toBeLessThan(2 * PERF_SLACK);
    expect(new Set(ctx.docs.labels())).toEqual(new Set(labels));
  });

  it('opens every file within budget and segments about 400 prose sentences', async () => {
    const times: Record<string, number> = {};
    for (const f of FILES) {
      const t0 = performance.now();
      await ctx.docs.open(f);
      times[f] = performance.now() - t0;
    }
    const units = ctx.docs.allUnits();
    const kinds = (k: string) => units.filter((u) => u.kind === k).length;
    expect(kinds('prose')).toBeGreaterThanOrEqual(390);
    expect(kinds('caption')).toBeGreaterThanOrEqual(24);
    expect(kinds('footnote')).toBe(8);
    expect(new Set(units.map((u) => u.file))).toEqual(new Set(FILES));
    expect(new Set(units.map((u) => u.id)).size).toBe(units.length);
    // every open is an import of the file (segment + assignUnits + fact linking of every sentence)
    for (const f of FILES) expect(times[f]!).toBeLessThan(400 * PERF_SLACK);
    console.log(`[scale] open (ms): ${Object.entries(times).map(([f, t]) => `${f} ${t.toFixed(0)}`).join(', ')}`);
  });

  it('the gate passes every sentence of the paper with its linked facts (no blocking issue)', () => {
    const facts = ctx.facts.all();
    expect(facts.length).toBeGreaterThan(150);
    const keys = ctx.lit.bibKeys();
    expect(keys).toHaveLength(40);
    const labels = ctx.docs.labels();
    const blocked: string[] = [];
    let numeric = 0;
    const t0 = performance.now();
    for (const u of ctx.docs.allUnits()) {
      const text = ctx.docs.unitText(u.id)!;
      const r = gateSentence(text, { mode: 'draft', facts, allowedCiteKeys: keys, knownLabels: labels, fictionalNumbers: [], claimedFactIds: u.facts });
      const b = r.issues.filter((i) => i.severity === 'block');
      if (b.length) blocked.push(`${u.file}:${u.line} ${b.map((i) => `${i.code}(${i.raw ?? ''})`).join(' ')}: ${text.slice(0, 120)}`);
      if (u.facts.length) numeric++;
    }
    const ms = performance.now() - t0;
    expect(blocked).toEqual([]);
    // the numbers are linked to facts on open (retro-grounding), not just accepted by the gate
    expect(numeric).toBeGreaterThan(60);
    expect(ms).toBeLessThan(3000 * PERF_SLACK);
    console.log(`[scale] gate on ${ctx.docs.allUnits().length} sentences: ${ms.toFixed(0)} ms, ${numeric} with linked facts`);
  });

  it('every number of the paper has a fact (ambiguous ones are left to the author, none is unmatched)', () => {
    const st = ctx.docs.get(RESULTS)!;
    const headline = st.units.find((u) => st.text.slice(u.start, u.end).startsWith('The difference is '))!;
    expect(headline.facts).toContain('f.headline.delta_points');
    const t0 = performance.now();
    const unresolved = ctx.facts.unresolved();
    const ms = performance.now() - t0;
    // bin edges, sample sizes and repeated headline numbers match several facts: the Facts panel lists them
    expect(unresolved.filter((x) => x.candidates.length === 0)).toEqual([]);
    expect(unresolved.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(1000 * PERF_SLACK);
  });

  it('the push guard sees units and intent lines of every file in the tree', async () => {
    const method = ctx.docs.get('sections/method.tex')!;
    const target = method.units.find((u) => u.kind === 'prose')!;
    ctx.docs.updateUnit(target.id, { state: 'proposed', everAi: true });
    // an intent line written on disk in a file that is then closed in the editor: read from disk
    const appendixPath = join(project.root, 'tex', 'sections', 'appendix.tex');
    const before = readFileSync(appendixPath, 'utf8');
    try {
      await ctx.docs.flushAll();
      writeFileSync(appendixPath, before.replace('\\label{app:checks}\n', '\\label{app:checks}\n这里再写一句关于重复性的话\n'));
      await ctx.docs.reloadFromDisk('sections/appendix.tex', 'external'); // what the watcher does
      const check = await ctx.sync.pushCheck();
      expect(check.ok).toBe(false);
      const proposed = check.blockers.find((b) => b.kind === 'proposed' && b.sentenceId === target.id);
      expect(proposed?.text.startsWith('sections/method.tex:')).toBe(true);
      expect(check.blockers.some((b) => (b.kind === 'intent_line' || b.kind === 'cjk') && b.text.startsWith('sections/appendix.tex:'))).toBe(true);
    } finally {
      ctx.docs.updateUnit(target.id, { state: 'human' });
      writeFileSync(appendixPath, before);
      await ctx.docs.reloadFromDisk('sections/appendix.tex', 'external');
    }
  });

  it.skipIf(!hasPython || !hasSkill)(
    'lint document pass: flattens the \\input tree, maps flags to the section files, stays within budget',
    async () => {
      expect(ctx.lint.status().sidecar).toBe(true);
      await ctx.lint.lintDocumentNow('main.tex'); // warm the sidecar
      const h = monitorEventLoopDelay({ resolution: 5 });
      const events: ServerMessage[] = [];
      const off = ctx.bus.subscribe((m) => events.push(m));
      h.enable();
      const t0 = performance.now();
      await ctx.lint.lintDocumentNow(RESULTS);
      const ms = performance.now() - t0;
      h.disable();
      off();
      const updates = events.filter((e): e is Extract<ServerMessage, { type: 'lint.update' }> => e.type === 'lint.update' && e.scope === 'document');
      // one update per file of the tree (the pass runs on the main document)
      expect(new Set(updates.map((u) => u.file))).toEqual(new Set(FILES));
      const res = updates.find((u) => u.file === RESULTS)!;
      const docFlags = res.flags.filter((f) => f.source === 'style_check' && f.sentenceId !== null && ctx.docs.unit(f.sentenceId!)?.file === RESULTS);
      expect(docFlags.length).toBeGreaterThan(0);
      expect(ms).toBeLessThan(3000 * PERF_SLACK);
      // the sidecar runs in its own process: the server's event loop stays responsive meanwhile
      const maxLagMs = h.max / 1e6;
      expect(maxLagMs).toBeLessThan(150 * PERF_SLACK);
      console.log(`[scale] lint document pass: ${ms.toFixed(0)} ms, ${updates.reduce((a, u) => a + u.flags.length, 0)} flags over ${updates.length} files, max event-loop lag ${maxLagMs.toFixed(0)} ms`);
    },
    60_000,
  );

  it.skipIf(!hasLatexmk)(
    'latexmk compiles the multi-file paper; SyncTeX forward/inverse land in sections/results.tex',
    async () => {
      const t0 = performance.now();
      const st = await ctx.build.compile('manual');
      const ms = performance.now() - t0;
      expect(st.errors).toEqual([]);
      expect(st.state).toBe('ok');
      expect(existsSync(ctx.build.pdfPath()!)).toBe(true);
      const log = readFileSync(join(ctx.paths.build, 'out', 'main.log'), 'latin1');
      const pages = Number(/Output written on \S+ \((\d+) pages?/.exec(log)?.[1] ?? 0);
      expect(pages).toBeGreaterThanOrEqual(20);
      expect(ms).toBeLessThan(60_000 * PERF_SLACK);

      const text = ctx.docs.get(RESULTS)!.text.split('\n');
      const line = text.findIndex((l) => l.includes('Graph construction takes')) + 1;
      expect(line).toBeGreaterThan(100);
      const fwd = await ctx.build.forward(RESULTS, line);
      expect(fwd).not.toBeNull();
      expect(fwd!.page).toBeGreaterThan(1);
      const inv = await ctx.build.inverse(fwd!.page, fwd!.x + 2, fwd!.y + Math.max(1, fwd!.h / 2));
      expect(inv?.file).toBe(RESULTS);
      expect(Math.abs(inv!.line - line)).toBeLessThanOrEqual(2);
      // a line of main.tex (the summary) maps back to main.tex, and an intro line to intro.tex
      const main = ctx.docs.get('main.tex')!.text.split('\n');
      const mline = main.findIndex((l) => l.startsWith('Three findings stand out.')) + 1;
      const mf = await ctx.build.forward('main.tex', mline);
      const mi = await ctx.build.inverse(mf!.page, mf!.x + 2, mf!.y + Math.max(1, mf!.h / 2));
      expect(mi?.file).toBe('main.tex');
      const intro = ctx.docs.get('sections/intro.tex')!.text.split('\n');
      const iline = intro.findIndex((l) => l.startsWith('We ask whether a tracker')) + 1;
      const fi = await ctx.build.forward('sections/intro.tex', iline);
      const ii = await ctx.build.inverse(fi!.page, fi!.x + 2, fi!.y + Math.max(1, fi!.h / 2));
      expect(ii?.file).toBe('sections/intro.tex');
      expect(fi!.page).toBeLessThan(fwd!.page);
      console.log(`[scale] compile ${ms.toFixed(0)} ms, ${pages} pages; results.tex:${line} -> page ${fwd!.page} -> ${inv!.file}:${inv!.line}`);
    },
    180_000,
  );
});

/* ------------------------------------------------------------------------------------ */
/* WebSocket typing                                                                      */
/* ------------------------------------------------------------------------------------ */

class WsClient {
  msgs: ServerMessage[] = [];
  private waiters: Array<{ pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  constructor(public ws: WebSocket) {
    ws.on('message', (d) => {
      const m = ServerMessage.parse(JSON.parse(String(d)));
      const w = this.waiters.find((x) => x.pred(m));
      if (w) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(m);
      } else this.msgs.push(m);
    });
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  next<T extends ServerMessage['type']>(type: T, pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true, timeoutMs = 10_000): Promise<Extract<ServerMessage, { type: T }>> {
    const match = (m: ServerMessage): boolean => m.type === type && pred(m as Extract<ServerMessage, { type: T }>);
    const i = this.msgs.findIndex(match);
    if (i >= 0) return Promise.resolve(this.msgs.splice(i, 1)[0] as Extract<ServerMessage, { type: T }>);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
      this.waiters.push({
        pred: match,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m as Extract<ServerMessage, { type: T }>);
        },
      });
    });
  }
}

describe('typing in sections/results.tex over the WebSocket', () => {
  let project: Project;
  let ctx: AppCtx;
  let server: PaperServer;
  const DEBOUNCE = 50;

  beforeAll(async () => {
    project = await makeLargeProject();
    ctx = await createCtx({ root: project.root, fake: true, logLevel: 'error', watch: false, lintSidecar: false, docs: { segmentDebounceMs: DEBOUNCE, writeDebounceMs: 200 } });
    await ctx.start();
    server = await createServer({ ctx, port: 0, pingIntervalMs: 60_000 });
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await ctx?.close();
    project?.cleanup();
  });

  it('acks every keystroke fast and patches the sentences after the debounce', async () => {
    const port = server.port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(ctx.token)}`, { headers: { origin: `http://127.0.0.1:${port}` } });
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });
    const c = new WsClient(ws);
    try {
      c.send({ type: 'hello', clientId: 'scale' });
      await c.next('welcome');
      const t0 = performance.now();
      c.send({ type: 'doc.open', file: RESULTS });
      const snap = await c.next('doc.snapshot', (m) => m.file === RESULTS);
      const openMs = performance.now() - t0;
      expect(snap.units.filter((u) => u.kind === 'prose').length).toBeGreaterThan(150);
      let text = snap.text;
      let version = snap.version;
      const before = new Map(snap.units.map((u) => [u.id, u] as const));

      // Type a new sentence, one character per message, at the end of a paragraph in the middle of the file.
      const anchor = text.indexOf('The two trackers take the same time, because they share the architecture.');
      expect(anchor).toBeGreaterThan(0);
      let at = anchor + 'The two trackers take the same time, because they share the architecture.'.length;
      const typed = ' We have not tuned the batch size for speed.';
      const ackMs: number[] = [];
      for (const ch of typed) {
        const cs = ChangeSet.of({ from: at, insert: ch }, text.length);
        const s = performance.now();
        c.send({ type: 'doc.change', file: RESULTS, baseVersion: version, changes: cs.toJSON(), annotation: null });
        const ack = await c.next('doc.ack', (m) => m.file === RESULTS && m.version === version + 1);
        ackMs.push(performance.now() - s);
        version = ack.version;
        text = text.slice(0, at) + ch + text.slice(at);
        at++;
      }
      const s = performance.now();
      const patch = await c.next('sentences.patch', (m) => m.file === RESULTS && m.version === version && m.upserts.some((u) => text.slice(u.start, u.end) === typed.trim()));
      const patchMs = performance.now() - s;
      const created = patch.upserts.find((u) => text.slice(u.start, u.end) === typed.trim())!;
      expect(created.state).toBe('human');
      // only the new sentence (and at most its neighbour's paragraph context) changed; no id was lost
      expect(patch.removed).toEqual([]);
      expect(patch.upserts.length).toBeLessThanOrEqual(3);
      const now = ctx.docs.get(RESULTS)!;
      for (const id of before.keys()) expect(now.units.some((u) => u.id === id)).toBe(true);
      const p95 = pct(ackMs, 95);
      expect(p95).toBeLessThan(15 * PERF_SLACK);
      // patch arrives within debounce + a pass over the whole file (segment + assign + facts + lint units)
      expect(patchMs).toBeLessThan(DEBOUNCE + 250 * PERF_SLACK);
      expect(openMs).toBeLessThan(1000 * PERF_SLACK);
      console.log(`[scale] ws: open ${openMs.toFixed(0)} ms; ack p50 ${pct(ackMs, 50).toFixed(2)} p95 ${p95.toFixed(2)} ms; patch ${(patchMs - DEBOUNCE).toFixed(0)} ms after the ${DEBOUNCE} ms debounce`);

      // the server mirror equals what the client typed, and the disk gets it after the write debounce
      expect(now.text).toBe(text);
      c.send({ type: 'doc.flush', file: RESULTS, version });
      await c.next('doc.ack', (m) => m.file === RESULTS && m.version === version);
      expect(readFileSync(join(project.root, 'tex', RESULTS), 'utf8')).toBe(text);
      expect(now.units.find((u) => u.id === created.id)?.file).toBe(RESULTS);
    } finally {
      ws.close();
    }
  }, 60_000);

  it('REST GET /api/doc serves a section file', async () => {
    const r = await fetch(`http://127.0.0.1:${server.port}/api/doc?file=${encodeURIComponent('sections/method.tex')}`, { headers: { 'x-paper-token': ctx.token } });
    expect(r.status).toBe(200);
    const d = (await r.json()) as { text: string; units: SentenceUnit[] };
    expect(d.text).toBe(readFileSync(join(project.root, 'tex', 'sections', 'method.tex'), 'utf8'));
    expect(d.units.length).toBeGreaterThan(80);
    const bad = await fetch(`http://127.0.0.1:${server.port}/api/doc?file=${encodeURIComponent('sections/../../repo/results/timing.json')}`, { headers: { 'x-paper-token': ctx.token } });
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });
});

describe('scale: multi-file paths when only a section file is open', () => {
  let root: string;
  let ctx: AppCtx;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'paper-scale-one-'));
    cpSync(join(FX, 'tex'), join(root, 'tex'), { recursive: true });
    cpSync(join(FX, 'repo'), join(root, 'repo'), { recursive: true });
    // an abstract kept in its own file, as many papers do
    const mainPath = join(root, 'tex', 'main.tex');
    const main = readFileSync(mainPath, 'utf8');
    const abs = /\\begin\{abstract\}\n([\s\S]*?)\\end\{abstract\}/.exec(main)!;
    writeFileSync(join(root, 'tex', 'sections', 'abstract.tex'), abs[1]!);
    writeFileSync(mainPath, main.replace(abs[0], '\\begin{abstract}\n\\input{sections/abstract}\n\\end{abstract}'));
    await initProject(root, { repo: join(root, 'repo'), skill: SKILL_DIR });
    ctx = await createCtx({ root, fake: true, logLevel: 'error', watch: false, lintSidecar: false, docs: { segmentDebounceMs: 20, writeDebounceMs: 50 } });
    await ctx.start();
    await ctx.docs.open('sections/results.tex');
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('knows the labels of files that are not open, so a \\ref to another file never reads as unknown', () => {
    expect(ctx.docs.openFiles()).toEqual(['sections/results.tex']);
    const labels = ctx.docs.labels();
    for (const l of ['sec:results', 'sec:summary', 'app:stat', 'app:seeds', 'sec:method', 'eq:eff', 'fig:bootstrap']) expect(labels).toContain(l);
    // the gate on a sentence of results.tex that refers to the appendix and to main.tex
    const res = ctx.docs.get('sections/results.tex')!;
    const u = res.units.find((x) => /\\ref\{app:seeds\}/.test(res.text.slice(x.start, x.end)))!;
    const r = gateSentence(res.text.slice(u.start, u.end), { mode: 'rewrite', original: res.text.slice(u.start, u.end), facts: ctx.facts.all(), allowedCiteKeys: ctx.lit.bibKeys(), knownLabels: labels, fictionalNumbers: [], claimedFactIds: u.facts, intentText: null });
    expect(r.issues.filter((i) => i.code === 'unknown_ref')).toEqual([]);
  });

  it('a label added in another file on disk is known without a restart', async () => {
    const p = join(root, 'tex', 'sections', 'appendix.tex');
    writeFileSync(p, readFileSync(p, 'utf8') + '\n\\section{Extra}\n\\label{app:extra}\nMore text follows here.\n');
    // the disk part of labels() is cached for one second (a ghost request must not re-read the tree)
    await new Promise((r) => setTimeout(r, 1100));
    expect(ctx.docs.labels()).toContain('app:extra');
  });

  it('gives units of an \\input file the part of the place it is included: abstract, appendix', async () => {
    const abs = await ctx.docs.open('sections/abstract.tex');
    expect(abs.units.length).toBeGreaterThanOrEqual(5);
    expect(abs.units.every((u) => u.part === 'abstract')).toBe(true);
    const app = await ctx.docs.open('sections/appendix.tex');
    const prose = app.units.filter((u) => u.kind === 'prose');
    expect(prose.length).toBeGreaterThan(20);
    expect(prose.every((u) => u.part === 'app')).toBe(true);
    expect(app.units.filter((u) => u.kind === 'caption').every((u) => u.part === 'caption')).toBe(true);
    const intro = await ctx.docs.open('sections/intro.tex');
    expect(intro.units.filter((u) => u.kind === 'prose').every((u) => u.part === 'intro')).toBe(true);
    const results = ctx.docs.get('sections/results.tex')!;
    expect(results.units.filter((u) => u.kind === 'prose').every((u) => u.part === 'body')).toBe(true);
    // parts survive typing (the re-segmentation pass applies the same context)
    const st = ctx.docs.get('sections/appendix.tex')!;
    const at = st.text.indexOf('The bootstrap resamples events');
    const cs = ChangeSet.of({ from: at, insert: 'Note that ' }, st.text.length, '\n');
    expect(await ctx.docs.applyClientChange({ type: 'doc.change', file: 'sections/appendix.tex', baseVersion: st.version, changes: cs.toJSON(), annotation: null })).toBe(true);
    const after = ctx.docs.get('sections/appendix.tex')!;
    expect(after.units.filter((u) => u.kind === 'prose').every((u) => u.part === 'app')).toBe(true);
  });
});
