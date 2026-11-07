/**
 * BuildService: latexmk on the intent-line shadow, SyncTeX both ways, the last good PDF.
 *
 * Directory layout under `.paper/build`:
 *   src/                  shadow mirror of texRoot (intent lines blanked, line count kept); latexmk's cwd,
 *                         so relative \input, \includegraphics and \bibliography paths resolve exactly as
 *                         they do in texRoot
 *   out/                  latexmk -outdir (aux, log, bbl, the fresh PDF and .synctex.gz)
 *   last/<job>.pdf        the last successful PDF and its <job>.synctex.gz (served, used by SyncTeX), so
 *                         a failed run never replaces a good PDF with a broken one
 *   state.json            { pdfVersion } (survives restarts so ?v= stays monotonic)
 *
 * SyncTeX records the shadow paths (build/src/./main.tex); forward() hands synctex the shadow path of a
 * texRoot-relative file and inverse() maps the shadow path back, so callers only ever see texRoot-
 * relative paths and real line numbers (the shadow keeps every line).
 */
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import type { CompileError } from '@paper-copilot/core';
import type { BuildService, CompileStatus, Ctx } from '../../contracts';
import { safeJoin } from '../../infra';
import { parseLatexLog, tailBytes } from './latexLog';
import { probeExecutable, runProcess } from './proc';
import { ShadowTree } from './shadow';
import { boxFromRecords, parseSynctexEditAll, parseSynctexView, type PdfBox } from './synctex';

export interface BuildServiceOptions {
  latexmk?: string;
  synctex?: string;
  /** Hard limit for one latexmk run. Default 120 s. */
  timeoutMs?: number;
  /** Debounce of scheduleCompile(). Default 2 s. */
  debounceMs?: number;
}

const LOG_TAIL_BYTES = 4096;

/**
 * latexmk runs a project's latexmkrc (Perl) and a co-author can push one through Overleaf, so the
 * TeX processes never see the server's secrets (API keys, tokens, passwords).
 */
export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (/KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE|SESSION|ANTHROPIC|^AWS_|^GH_|^GITHUB_/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}
/** Files inverse search may point at (never an .aux or .bbl in the output tree). */
const SOURCE_EXT = /\.(tex|ltx|bib|sty|cls|tikz|pgf|inc|txt)$/i;

export function createBuildService(ctx: Ctx, opts: BuildServiceOptions = {}): BuildService {
  const latexmkBin = opts.latexmk ?? process.env.PAPER_LATEXMK ?? 'latexmk';
  const synctexBin = opts.synctex ?? process.env.PAPER_SYNCTEX ?? 'synctex';
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const debounceMs = opts.debounceMs ?? 2000;

  const buildDir = ctx.paths.build;
  const srcDir = join(buildDir, 'src');
  const outDir = join(buildDir, 'out');
  const lastDir = join(buildDir, 'last');
  const statePath = join(buildDir, 'state.json');

  const texRoot = () => resolve(ctx.config.texRoot || ctx.paths.tex);
  const mainRel = () => (ctx.config.mainFile || 'main.tex').replace(/\\/g, '/').replace(/^\.\//, '');
  const jobName = () => basename(mainRel()).replace(/\.(tex|ltx)$/i, '');
  const lastPdf = () => join(lastDir, `${jobName()}.pdf`);
  const lastSynctex = () => join(lastDir, `${jobName()}.synctex.gz`);

  let tree: ShadowTree | null = null;
  let treeKey = '';
  const shadow = (): ShadowTree => {
    const key = `${texRoot()}|${jobName()}`;
    if (!tree || key !== treeKey) {
      const exclude = [ctx.paths.paper];
      tree = new ShadowTree(texRoot(), srcDir, { jobName: jobName(), log: ctx.log, exclude });
      treeKey = key;
    }
    return tree;
  };

  let pdfVersion: number | null = null;
  try {
    if (existsSync(statePath) && existsSync(lastPdf())) {
      const v = (JSON.parse(readFileSync(statePath, 'utf8')) as { pdfVersion?: unknown }).pdfVersion;
      if (typeof v === 'number' && Number.isInteger(v) && v > 0) pdfVersion = v;
    }
  } catch {
    pdfVersion = null;
  }

  let status: CompileStatus = { state: 'idle', pdfVersion, errors: [], logTail: '', durationMs: null };
  const emit = () =>
    ctx.bus.emit({ type: 'compile.status', state: status.state, pdfVersion: status.pdfVersion, errors: status.errors, logTail: status.logTail });

  let avail: { latexmk: boolean; synctex: boolean } | null = null;
  const available = () => {
    if (!avail) avail = { latexmk: probeExecutable(latexmkBin, ['-v']), synctex: probeExecutable(synctexBin, ['help']) };
    return avail;
  };

  /** Map a path as written by TeX/SyncTeX (shadow path, ./rel, rel) to texRoot-relative, or null if outside. */
  const toRel = (raw: string): string | null => {
    const p = raw.trim();
    if (!p) return null;
    const abs = isAbsolute(p) ? normalize(p) : resolve(srcDir, p);
    const rel = relative(srcDir, abs);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    return rel.split(sep).join('/');
  };

  /** Write the current editor text of open files to disk first, so "compile" means "what I see". */
  const flushDocs = async () => {
    try {
      const files = await ctx.docs.files();
      for (const f of files) if (ctx.docs.get(f)) await ctx.docs.flush(f);
    } catch (e) {
      ctx.log.debug('compile: docs flush skipped', String(e));
    }
  };

  const fail = (message: string, file: string | null = null): CompileError[] => [{ file: file ?? mainRel(), line: null, message }];

  const publish = async (): Promise<boolean> => {
    const pdf = join(outDir, `${jobName()}.pdf`);
    const syn = join(outDir, `${jobName()}.synctex.gz`);
    if (!existsSync(pdf)) return false;
    await mkdir(lastDir, { recursive: true });
    const tag = `.tmp-${process.pid}-${Date.now()}`;
    await copyFile(pdf, lastPdf() + tag);
    if (existsSync(syn)) await copyFile(syn, lastSynctex() + tag);
    await rename(lastPdf() + tag, lastPdf());
    if (existsSync(syn)) await rename(lastSynctex() + tag, lastSynctex());
    pdfVersion = (pdfVersion ?? 0) + 1;
    await writeFile(statePath, JSON.stringify({ pdfVersion }) + '\n', 'utf8');
    return true;
  };

  // Aborted by close(): stops latexmk, and no compile starts afterwards.
  const stopping = new AbortController();
  const runOnce = async (reason: 'save' | 'manual'): Promise<CompileStatus> => {
    if (stopping.signal.aborted) return status;
    const t0 = Date.now();
    status = { ...status, state: 'running', errors: [], durationMs: null };
    emit();
    const done = (state: 'ok' | 'error', errors: CompileError[], logTail: string): CompileStatus => {
      status = { state, pdfVersion, errors, logTail, durationMs: Date.now() - t0 };
      emit();
      return status;
    };
    try {
      if (!available().latexmk) {
        return done('error', fail('latexmk was not found on PATH; install TeX Live (latexmk, pdflatex) to compile.'), '');
      }
      let mainAbs: string;
      try {
        mainAbs = safeJoin(texRoot(), mainRel());
      } catch {
        return done('error', fail(`main file "${mainRel()}" is outside the LaTeX tree`), '');
      }
      if (!existsSync(mainAbs)) return done('error', fail(`main file "${mainRel()}" does not exist in ${texRoot()}`), '');
      await flushDocs();
      const sync = await shadow().sync();
      // \include{dir/file} writes dir/file.aux into the output directory, which must exist.
      await mkdir(outDir, { recursive: true });
      for (const d of sync.dirs) await mkdir(join(outDir, d), { recursive: true });
      ctx.log.debug(`compile (${reason}): shadow ${sync.written.length} written, ${sync.removed.length} removed`);
      const env: NodeJS.ProcessEnv = {
        ...scrubbedEnv(),
        // One log line per message, so file:line: errors are never wrapped.
        max_print_line: '10000',
        error_line: '254',
        half_error_line: '238',
      };
      // A file name starting with "-" would be parsed by latexmk as an option (-pdflatex=<cmd> runs a
      // command): such a name is passed as "./<name>", which no option parser takes for an option.
      const mainArg = mainRel().startsWith('-') ? `./${mainRel()}` : mainRel();
      const args = ['-pdf', '-synctex=1', '-interaction=nonstopmode', '-file-line-error', `-outdir=${outDir}`, mainArg];
      // latexmk remembers a failed pdflatex run in its .fdb_latexmk: while the sources are unchanged it
      // refuses to run again ("Nothing to do ... gave an error in previous invocation", exit 12), so an
      // error caused by the environment (TeX installed after the first try, a missing package now
      // installed) would stick forever and hide the real message. A manual compile always forces a run
      // (-g); any compile that hits the remembered-error case is retried once with -g.
      const runLatexmk = (force: boolean) =>
        runProcess(latexmkBin, force ? ['-g', ...args] : args, { cwd: srcDir, env, timeoutMs, maxOutput: 2_000_000, signal: stopping.signal });
      let r = await runLatexmk(reason === 'manual');
      if (!stopping.signal.aborted && r.code !== 0 && reason !== 'manual' && /error in previous invocation|Nothing to do for/.test(`${r.stdout}\n${r.stderr}`)) {
        r = await runLatexmk(true);
      }
      if (stopping.signal.aborted) return done('error', fail('compile stopped: the server is shutting down'), tailBytes(`${r.stdout}${r.stderr ? '\n' + r.stderr : ''}`, LOG_TAIL_BYTES));
      const output = `${r.stdout}${r.stderr ? '\n' + r.stderr : ''}`;
      const tail = tailBytes(output, LOG_TAIL_BYTES);
      if (r.missing) {
        avail = { ...(avail ?? { synctex: false }), latexmk: false };
        return done('error', fail('latexmk was not found on PATH'), tail);
      }
      if (r.timedOut) return done('error', fail(`compile timed out after ${Math.round(timeoutMs / 1000)} s (latexmk was stopped)`), tail);
      // Trust the .log only if this run wrote it (latexmk can fail before pdflatex runs).
      let log = output;
      try {
        const logPath = join(outDir, `${jobName()}.log`);
        if ((await stat(logPath)).mtimeMs >= t0 - 2000) log = await readFile(logPath, 'utf8');
      } catch {
        log = output;
      }
      const mapFile = (raw: string) => toRel(raw) ?? raw;
      let errors = parseLatexLog(log, { mapFile, mainFile: mainRel() });
      if (r.code === 0) {
        if (!(await publish())) return done('error', fail('latexmk finished but produced no PDF'), tail);
        // A clean exit is authoritative (the final log may still quote recovered "! ..." lines).
        return done('ok', [], tail);
      }
      if (errors.length === 0) {
        const lm = output.split(/\r?\n/).filter((l) => /^Latexmk: .*(error|Error|failed|not found|could not)/.test(l));
        const bib = output.split(/\r?\n/).filter((l) => /^I couldn't open|^I found no|database file/.test(l));
        errors = fail([...bib, ...lm].slice(-3).join(' | ') || `latexmk exited with code ${r.code ?? r.signal}`);
      }
      return done('error', errors, tail);
    } catch (e) {
      ctx.log.error('compile failed', String(e));
      return done('error', fail(`compile failed: ${e instanceof Error ? e.message : String(e)}`), status.logTail);
    }
  };

  let running: Promise<CompileStatus> | null = null;
  let queued: Promise<CompileStatus> | null = null;
  const compile = (reason: 'save' | 'manual'): Promise<CompileStatus> => {
    if (!running) {
      running = runOnce(reason).finally(() => {
        running = null;
      });
      return running;
    }
    // A run is in flight: everyone who asks now shares ONE follow-up run, which starts after it and sees
    // the newest files.
    if (!queued) {
      const after = running;
      queued = after
        .catch(() => undefined)
        .then(() => {
          queued = null;
          return compile(reason);
        });
    }
    return queued;
  };

  let timer: NodeJS.Timeout | null = null;
  const scheduleCompile = () => {
    if (stopping.signal.aborted) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      compile('save').catch((e) => ctx.log.warn('scheduled compile failed', String(e)));
    }, debounceMs);
    timer.unref?.();
  };

  const pdfPath = (): string | null => (existsSync(lastPdf()) ? lastPdf() : null);

  const forward = async (file: string, line: number): Promise<PdfBox | null> => {
    if (!Number.isInteger(line) || line < 1) return null;
    let abs: string;
    try {
      abs = safeJoin(texRoot(), file);
    } catch {
      return null;
    }
    const rel = relative(texRoot(), abs).split(sep).join('/');
    const pdf = pdfPath();
    if (!pdf || !existsSync(lastSynctex()) || !available().synctex) return null;
    // SyncTeX matches the input name it recorded (".../build/src/./main.tex"); try the forms it accepts.
    const candidates = [join(srcDir, rel), `${srcDir}/./${rel}`, `./${rel}`, rel];
    for (const input of candidates) {
      const r = await runProcess(synctexBin, ['view', '-i', `${line}:0:${input}`, '-o', pdf], { cwd: srcDir, env: scrubbedEnv(), timeoutMs: 15_000 });
      if (r.missing) return null;
      const box = boxFromRecords(parseSynctexView(r.stdout));
      if (box) return box;
    }
    return null;
  };

  const inverse = async (page: number, x: number, y: number): Promise<{ file: string; line: number } | null> => {
    if (!Number.isInteger(page) || page < 1 || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    const pdf = pdfPath();
    if (!pdf || !existsSync(lastSynctex()) || !available().synctex) return null;
    const r = await runProcess(synctexBin, ['edit', '-o', `${page}:${x}:${y}:${pdf}`], { cwd: srcDir, env: scrubbedEnv(), timeoutMs: 15_000 });
    if (r.missing) return null;
    // Innermost record first; skip records in class/package files outside the project.
    for (const hit of parseSynctexEditAll(r.stdout).reverse()) {
      const rel = toRel(hit.input);
      if (rel && SOURCE_EXT.test(rel)) return { file: rel, line: hit.line };
    }
    return null;
  };

  const close = async (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = null;
    stopping.abort();
    // Wait for the run in flight and the follow-up one (which returns at once now), so nothing writes
    // into .paper/build after shutdown.
    while (running || queued) await (queued ?? running)!.catch(() => undefined);
  };

  return {
    available,
    compile,
    scheduleCompile,
    close,
    status: () => status,
    pdfPath,
    forward,
    inverse,
  };
}
