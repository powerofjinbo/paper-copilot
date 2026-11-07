/**
 * Watches the analysis repository for re-run results: chokidar on `config.repoDir`, restricted to the
 * files `config.factGlobs` select (results/**\/*.json, *.csv, docs/definitions.md by default). A change,
 * a new file or a deleted file schedules ONE rescan of the fact store, debounced (2 s by default: an
 * analysis script writes several files in a row). The rescan itself emits `facts.updated` with every
 * stale fact id (factService.doScan); this watcher adds a `notice` in the author's notes language that
 * names the changed artifacts and how many facts became stale, so the sentences stating them can be
 * checked in the Consistency report.
 *
 * Read-only: nothing in the repository is ever written. No repoDir (or an unreadable one): a no-op
 * watcher. Hidden directories, node_modules and __pycache__ are never watched.
 */
import { existsSync, statSync, type Stats } from 'node:fs';
import { relative, sep } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type { Ctx } from '../../contracts';
import { compileGlob, matchAny, type CompiledGlob } from './glob';

export const REPO_RESCAN_DEBOUNCE_MS = 2000;

export interface RepoWatcherOptions {
  /** Debounce before the rescan (default 2000 ms). */
  debounceMs?: number;
  /** Use polling (network file systems, tests). */
  usePolling?: boolean;
  /** Polling interval (default 200 ms). */
  interval?: number;
}

export interface RepoWatcher {
  /** True when a directory is actually watched (repoDir set and readable). */
  readonly active: boolean;
  /** Resolves once the initial scan of the directory tree finished. */
  ready: Promise<void>;
  /** Relative paths changed since the last rescan started (diagnostics, tests). */
  pending(): string[];
  /** Resolves when the rescan the watcher started last (if any) finished. */
  idle(): Promise<void>;
  close(): Promise<void>;
}

export interface RepoWatcherDeps {
  rescan(): Promise<{ count: number; stale: string[] }>;
  staleIds(): string[];
}

const SKIP_SEGMENTS = new Set(['node_modules', '__pycache__']);

function noopWatcher(): RepoWatcher {
  return { active: false, ready: Promise.resolve(), pending: () => [], idle: () => Promise.resolve(), close: async () => undefined };
}

/** The notice text for a rescan triggered by changed artifacts. */
export function repoChangeNotice(lang: 'zh' | 'en', changed: readonly string[], count: number, newlyStale: readonly string[]): string {
  const shown = changed.slice(0, 3).join(', ') + (changed.length > 3 ? (lang === 'zh' ? ` 等 ${changed.length} 个文件` : ` and ${changed.length - 3} more`) : '');
  if (lang === 'zh') {
    return newlyStale.length
      ? `分析结果已更新（${shown}）：重新读取了 ${count} 个事实，其中 ${newlyStale.length} 个数值变了（已标为过期）。引用它们的句子列在“一致性”报告中，请逐句核对。`
      : `分析结果已更新（${shown}）：重新读取了 ${count} 个事实，引用的数值没有变化。`;
  }
  return newlyStale.length
    ? `Analysis results changed (${shown}): ${count} facts re-read, ${newlyStale.length} changed value and are marked stale. The sentences that state them are listed in the Consistency report.`
    : `Analysis results changed (${shown}): ${count} facts re-read; no stated value changed.`;
}

export function createRepoWatcher(ctx: Ctx, deps: RepoWatcherDeps, opts: RepoWatcherOptions = {}): RepoWatcher {
  const repoDir = ctx.config.repoDir;
  if (!repoDir) return noopWatcher();
  try {
    if (!existsSync(repoDir) || !statSync(repoDir).isDirectory()) {
      ctx.log.warn(`facts: the analysis repository ${repoDir} is not a directory; re-run results are not watched`);
      return noopWatcher();
    }
  } catch {
    return noopWatcher();
  }
  const debounceMs = Math.max(0, opts.debounceMs ?? REPO_RESCAN_DEBOUNCE_MS);
  let globs: CompiledGlob[] = [];
  try {
    globs = ctx.config.factGlobs.map((g) => compileGlob(g));
  } catch (e) {
    ctx.log.warn('facts: invalid fact glob; re-run results are not watched', String(e));
    return noopWatcher();
  }
  if (!globs.some((g) => !g.negated)) return noopWatcher();

  const relOf = (abs: string): string => relative(repoDir, abs).split(sep).join('/');
  const hiddenOrSkipped = (rel: string): boolean => rel.split('/').some((p) => (p.startsWith('.') && p !== '.' && p !== '..') || SKIP_SEGMENTS.has(p));
  const wanted = (rel: string): boolean => !!rel && !rel.startsWith('..') && !hiddenOrSkipped(rel) && matchAny(globs, rel);

  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  const changed = new Set<string>();
  let inflight: Promise<void> = Promise.resolve();

  const run = (): void => {
    timer = null;
    if (closed || changed.size === 0) return;
    const files = [...changed].sort();
    changed.clear();
    const before = new Set(deps.staleIds());
    inflight = inflight
      .then(async () => {
        if (closed) return;
        ctx.log.info(`facts: ${files.length} analysis artifact(s) changed (${files.slice(0, 5).join(', ')}); rescanning`);
        const r = await deps.rescan();
        const newly = r.stale.filter((id) => !before.has(id));
        ctx.bus.emit({ type: 'notice', level: newly.length ? 'warn' : 'info', message: repoChangeNotice(ctx.config.notesLanguage, files, r.count, newly) });
      })
      .catch((e) => {
        ctx.log.warn('facts: rescan after a repository change failed', e instanceof Error ? e.message : String(e));
        ctx.bus.emit({
          type: 'notice',
          level: 'error',
          message: ctx.config.notesLanguage === 'zh' ? '分析结果已改变，但重新读取事实失败；事实列表可能已过时。' : 'The analysis results changed but re-reading the facts failed; the fact list may be out of date.',
        });
      });
  };

  const schedule = (abs: string): void => {
    if (closed) return;
    const rel = relOf(abs);
    if (!wanted(rel)) return;
    changed.add(rel);
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, debounceMs);
  };

  const watcher: FSWatcher = watch(repoDir, {
    ignoreInitial: true,
    persistent: true,
    depth: 12,
    usePolling: opts.usePolling ?? false,
    interval: opts.interval ?? 200,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    ignored: (path: string, stats?: Stats) => {
      const rel = relOf(path);
      if (!rel || rel === '.') return false;
      if (rel.startsWith('..') || hiddenOrSkipped(rel)) return true;
      if (stats?.isFile()) return !matchAny(globs, rel);
      return false;
    },
  });
  watcher.on('add', schedule);
  watcher.on('change', schedule);
  watcher.on('unlink', schedule);
  watcher.on('error', (e) => ctx.log.warn('facts: repository watcher error', String(e)));
  const ready = new Promise<void>((resolve) => watcher.once('ready', () => resolve()));

  return {
    active: true,
    ready,
    pending: () => [...changed].sort(),
    idle: () => inflight,
    async close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      changed.clear();
      await watcher.close();
      await inflight.catch(() => undefined);
    },
  };
}
