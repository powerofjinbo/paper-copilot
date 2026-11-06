/**
 * Integration tests for the LintSidecar client (apps/server/src/services/lint/sidecar.ts) against the real
 * sidecar/lintd.py and the user's skill. Skipped when python3 or the hep-paper-writing skill is missing.
 * The failure-handling tests (timeout, crash, restart, give-up) use small fake sidecars written to a temp dir
 * and need only python3.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultScriptPath, LintSidecar } from '../src/services/lint/sidecar';

const ROOT = resolve(__dirname, '../../..');
const PYTHON = process.env.PAPER_PYTHON ?? 'python3';
const FIXTURE = join(ROOT, 'fixtures/canto-demo/tex/main.tex');

const hasPython = (() => {
  try {
    return spawnSync(PYTHON, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'], { timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
})();

function findSkill(): string | null {
  const cands = [process.env.PAPER_SKILL_DIR, join(process.env.HOME ?? '', '.claude/skills/hep-paper-writing'), join(ROOT, '.skill')];
  for (const c of cands) if (c && existsSync(join(c, 'scripts/style_check.py'))) return c;
  return null;
}
const SKILL = findSkill();

describe('defaultScriptPath', () => {
  it('resolves sidecar/lintd.py at the repository root', () => {
    expect(defaultScriptPath()).toBe(join(ROOT, 'sidecar/lintd.py'));
    expect(existsSync(defaultScriptPath())).toBe(true);
  });
});

describe.skipIf(!hasPython || !SKILL)('LintSidecar with the real lintd.py', () => {
  let sc: LintSidecar;

  beforeAll(async () => {
    sc = await LintSidecar.start({ python: PYTHON, skillDir: SKILL!, timeoutMs: 20_000 });
  });
  afterAll(async () => {
    await sc?.close();
  });

  it('reports ready info', async () => {
    expect(sc.ready.styleCheckPath).toBe(resolve(SKILL!, 'scripts/style_check.py'));
    expect(sc.version).toMatch(/^[0-9a-f]{12}$/);
    expect(sc.ready.version).toBe(sc.version);
    expect(await sc.ping()).toBe(true);
  });

  it('flags bad sentences and leaves clean ones alone', async () => {
    const long = Array.from({ length: 10 }, () => 'the tracker finds the particle').join(' ') + '.';
    const flags = await sc.lintSentences(
      [
        { sid: 'u', text: 'We utilize a novel method.', part: 'body' },
        { sid: 'm', text: 'Moreover, the tracker finds more particles in order to beat the baseline.', part: 'intro' },
        { sid: 'l', text: long, part: 'body' },
        { sid: 'ok', text: 'The test set holds 8,710 targets.', part: 'body' },
      ],
      { known: [] },
    );
    const by = (sid: string) => flags.filter((f) => f.sid === sid).map((f) => `${f.key}:${f.word ?? ''}`);
    expect(by('u')).toEqual(['vocab:utilize', 'hype:novel']);
    expect(by('m')).toEqual(['connectors:Moreover', 'connectors:in order to']);
    expect(by('l')).toEqual(['long:']);
    expect(by('ok')).toEqual([]);
    const u = flags.find((f) => f.sid === 'u')!;
    expect(u).toEqual({ sid: 'u', check: 4, key: 'vocab', msg: '*utilize*: write *use*.', word: 'utilize', excerpt: 'We utilize a novel method.' });
    // maxWords is honoured (both spellings)
    expect((await sc.lintSentences([{ sid: 'l', text: long, part: 'body' }], { maxWords: 60 })).length).toBe(0);
    expect((await sc.lintSentences([{ sid: 'l', text: long, part: 'body' }], { max_words: 60 })).length).toBe(0);
    expect(await sc.lintSentences([])).toEqual([]);
  });

  it('expands preamble macros in sentences', async () => {
    const flags = await sc.lintSentences([{ sid: 'p', text: 'We \\use the sample.', part: 'body' }], { preamble: '\\newcommand{\\use}{utilize}' });
    expect(flags.map((f) => f.key)).toEqual(['vocab']);
  });

  it('lints the fixture document', async () => {
    const tex = readFileSync(FIXTURE, 'utf8');
    const r = await sc.lintDocument(tex, { known: [] });
    expect(r.words).toBe(366);
    expect(r.sentences).toBe(26);
    expect(Object.keys(r.rates).sort()).toEqual(['acronyms', 'connectors', 'figures', 'hype', 'long', 'passive', 'terms', 'vague', 'verb', 'vocab']);
    expect(r.referenceRates.long).toBe(3.3);
    const acr = r.flags.filter((f) => f.key === 'acronyms');
    expect(acr).toHaveLength(1);
    expect(acr[0]).toMatchObject({ check: 7, line: 49, part: 'body', word: 'HNL' });
    expect(typeof acr[0]!.sent_index).toBe('number');
    const known = await sc.lintDocument(tex, { known: ['HNL'] });
    expect(known.flags.filter((f) => f.key === 'acronyms')).toHaveLength(0);
  });

  it('computes corpus statistics', async () => {
    const r = await sc.corpusStats(['We measure the rate. The rate is shown in Fig. 1. We find 12 events.', 'The detector was built in 2010. We use it.'], 'txt');
    expect(r.sentences).toBe(5);
    expect(r.passive_share).toBeCloseTo(0.4);
    expect(r).toHaveProperty('median_length');
    expect(r).toHaveProperty('we_per_1k');
    expect(r).toHaveProperty('median_verb_position');
    expect(r).not.toHaveProperty('id');
  });

  it('is safe under concurrent calls', async () => {
    const calls = Array.from({ length: 30 }, (_, k) =>
      k % 3 === 0
        ? sc.lintSentences([{ sid: `s${k}`, text: 'We utilize a novel method.', part: 'body' }]).then((f) => f.map((x) => x.sid))
        : k % 3 === 1
          ? sc.ping().then((p) => [String(p)])
          : sc.lintSentences([{ sid: `t${k}`, text: 'The rate is low.', part: 'body' }]).then((f) => f.map((x) => x.sid)),
    );
    const res = await Promise.all(calls);
    res.forEach((r, k) => {
      if (k % 3 === 0) expect(r).toEqual([`s${k}`, `s${k}`]);
      else if (k % 3 === 1) expect(r).toEqual(['true']);
      else expect(r).toEqual([]);
    });
  });

  it('lints 1,000 sentences in under 2 s', async () => {
    const lines = readFileSync(FIXTURE, 'utf8')
      .split('\n')
      .filter((l) => l && !/^[\\% ]/.test(l));
    const items = Array.from({ length: 1000 }, (_, k) => ({ sid: String(k), text: lines[k % lines.length]!, part: ['body', 'intro', 'abstract', 'caption'][k % 4]! }));
    const t0 = performance.now();
    await sc.lintSentences(items, { known: [] });
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('rejects a bad request without killing the process', async () => {
    const pid = sc.pid;
    await expect(sc.lintSentences([{ sid: 'x', text: 'We go.', part: 'body' }], { maxWords: 2 })).rejects.toThrow(/max_words/);
    expect(await sc.ping()).toBe(true);
    expect(sc.pid).toBe(pid);
  });

  it('restarts once after the process is killed', async () => {
    const pid = sc.pid!;
    process.kill(pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 200));
    expect(await sc.ping()).toBe(true);
    expect(sc.pid).not.toBe(pid);
    const flags = await sc.lintSentences([{ sid: 'a', text: 'We utilize it.', part: 'body' }]);
    expect(flags.map((f) => f.word)).toEqual(['utilize']);
  });
});

describe.skipIf(!hasPython || !SKILL)('LintSidecar start and close', () => {
  it('fails to start with a bad skill dir, with the reason', async () => {
    await expect(LintSidecar.start({ python: PYTHON, skillDir: '/nonexistent/skill' })).rejects.toThrow(/nonexistent\/skill/);
  });

  it('close() shuts the process down and later calls reject', async () => {
    const sc = await LintSidecar.start({ python: PYTHON, skillDir: SKILL! });
    const pid = sc.pid!;
    const inFlight = sc.ping();
    await new Promise((r) => setImmediate(r)); // let it be written to the process
    const queued = sc.ping();
    await sc.close();
    await expect(inFlight).resolves.toBe(true);
    await expect(queued).rejects.toThrow(/closed/);
    await expect(sc.ping()).rejects.toThrow(/closed/);
    await sc.close();
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe.skipIf(!hasPython)('LintSidecar failure handling (fake sidecars)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lintd-fake-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A fake lintd: answers ping; `hang` never answers; `crash` exits; `crash_once` exits only in the first process. */
  function fake(name: string, opts: { noise?: boolean; notReady?: boolean; crashAll?: boolean } = {}): string {
    const p = join(dir, `${name}.py`);
    writeFileSync(
      p,
      [
        'import json, os, sys',
        `MARK = ${JSON.stringify(join(dir, `${name}.mark`))}`,
        `CRASH_ALL = ${opts.crashAll ? 'True' : 'False'}`,
        opts.notReady ? 'print(json.dumps({"ready": False, "error": "skill missing"}), flush=True); sys.exit(2)' : '',
        'print("ignored banner", file=sys.stderr, flush=True)',
        opts.noise ? 'print("stray stdout noise", flush=True)' : '',
        'print(json.dumps({"ready": True, "style_check": "/fake/style_check.py", "version": "abc123", "protocol": 1}), flush=True)',
        'for line in sys.stdin:',
        '    r = json.loads(line)',
        '    c = r.get("cmd")',
        '    if c == "hang":',
        '        continue',
        '    if c == "crash" or (CRASH_ALL and c != "shutdown"):',
        '        print("boom", file=sys.stderr, flush=True); os._exit(3)',
        '    if c == "crash_once" and not os.path.exists(MARK):',
        '        open(MARK, "w").close(); os._exit(4)',
        '    if c == "shutdown":',
        '        print(json.dumps({"id": r["id"], "ok": True}), flush=True); sys.exit(0)',
        '    if c == "lint.sentences":',
        opts.noise ? '        print("noise", flush=True)' : '',
        '        print(json.dumps({"id": r["id"], "ok": True, "flags": [{"sid": i["sid"], "check": 4, "key": "vocab", "msg": "*x*", "word": "x", "excerpt": i["text"]} for i in r["items"]]}), flush=True)',
        '        continue',
        '    print(json.dumps({"id": r["id"], "ok": True, "pong": True, "cmd": c}), flush=True)',
      ].join('\n'),
    );
    return p;
  }

  type Raw = { request(cmd: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> };
  const raw = (s: LintSidecar) => s as unknown as Raw;

  it('reads ready info and captures stderr', async () => {
    const sc = await LintSidecar.start({ python: PYTHON, scriptPath: fake('basic') });
    expect(sc.ready).toEqual({ styleCheckPath: '/fake/style_check.py', version: 'abc123', protocol: 1 });
    expect(sc.stderrTail()).toContain('ignored banner');
    await sc.close();
  });

  it('ignores stray stdout lines', async () => {
    const sc = await LintSidecar.start({ python: PYTHON, scriptPath: fake('noisy', { noise: true }) });
    const flags = await sc.lintSentences([{ sid: 'a', text: 'T', part: 'body' }]);
    expect(flags).toEqual([{ sid: 'a', check: 4, key: 'vocab', msg: '*x*', word: 'x', excerpt: 'T' }]);
    expect(await sc.ping()).toBe(true);
    await sc.close();
  });

  it('rejects start when the sidecar is not ready', async () => {
    await expect(LintSidecar.start({ python: PYTHON, scriptPath: fake('notready', { notReady: true }) })).rejects.toThrow(/skill missing/);
  });

  it('rejects start when python is missing', async () => {
    await expect(LintSidecar.start({ python: '/nonexistent/python3', scriptPath: fake('nopy') })).rejects.toThrow(/cannot run/);
  });

  it('times out a stuck request, then serves the next one on a fresh process', async () => {
    const sc = await LintSidecar.start({ python: PYTHON, scriptPath: fake('hang'), timeoutMs: 300 });
    const pid = sc.pid;
    const queued = sc.ping();
    await expect(raw(sc).request('hang', {})).rejects.toThrow(/timed out after 300 ms/);
    await expect(queued).resolves.toBe(true);
    expect(sc.pid).not.toBe(pid);
    await sc.close();
  });

  it('retries a request once when the process dies under it', async () => {
    const sc = await LintSidecar.start({ python: PYTHON, scriptPath: fake('once') });
    const r = await raw(sc).request('crash_once', {});
    expect(r.pong).toBe(true);
    expect(await sc.ping()).toBe(true);
    await sc.close();
  });

  it('rejects a request that kills a fresh process too, and keeps serving', async () => {
    const sc = await LintSidecar.start({ python: PYTHON, scriptPath: fake('crash') });
    await expect(raw(sc).request('crash', {})).rejects.toThrow(/exited \(code 3\) twice/);
    expect(sc.stderrTail()).toContain('boom');
    expect(await sc.ping()).toBe(true);
    await sc.close();
  });

  it('gives up after repeated deaths', async () => {
    const sc = await LintSidecar.start({ python: PYTHON, scriptPath: fake('crashall', { crashAll: true }) });
    await expect(sc.ping()).rejects.toThrow(/twice/);
    await expect(sc.ping()).rejects.toThrow(/giving up/);
    await expect(sc.ping()).rejects.toThrow(/giving up/);
    await sc.close();
  });
});
