/**
 * Watches the LaTeX tree (*.tex, *.bib) for changes made outside the app (another editor, a
 * `git pull` in a terminal, overleaf-sync). Our own writes are recognised by content (the mirror
 * remembers what it wrote) and ignored. An external change to an open .tex file runs
 * docs.reloadFromDisk(file, 'external'); a .bib change reloads the bibliography and recompiles.
 * Events are debounced per file (editors write in several steps) and serialized per file.
 * While a sync pull runs, the sync service reloads files itself: `pause()` suppresses the watcher.
 */
import { readFile } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type { Ctx } from '../contracts';
import type { DocServiceExt } from './docService';
import { isBibName, isTexName } from './text';

export interface TexWatcher {
  /** Suppress reloads (sync pull in progress); returns the function that resumes. */
  pause(): () => void;
  close(): Promise<void>;
  /** Resolves once the initial scan finished. */
  ready: Promise<void>;
}

export interface WatcherOptions {
  debounceMs?: number;
  /** Use polling (network file systems, tests). */
  usePolling?: boolean;
}

export function createTexWatcher(ctx: Ctx, docs: DocServiceExt, opts: WatcherOptions = {}): TexWatcher {
  const debounceMs = opts.debounceMs ?? 250;
  const root = ctx.paths.tex;
  let paused = 0;
  const timers = new Map<string, NodeJS.Timeout>();
  const running = new Map<string, Promise<void>>();

  const watcher: FSWatcher = watch(root, {
    ignoreInitial: true,
    persistent: true,
    depth: 12,
    usePolling: opts.usePolling ?? false,
    interval: 200,
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
    ignored: (path: string, stats?: import('node:fs').Stats) => {
      const rel = relative(root, path);
      if (!rel || rel === '.') return false;
      const parts = rel.split(sep);
      if (parts.some((p) => p.startsWith('.') || p === 'node_modules')) return true;
      if (stats?.isFile()) return !(isTexName(path) || isBibName(path));
      return false;
    },
  });

  const handle = async (abs: string): Promise<void> => {
    const rel = relative(root, abs).split(sep).join('/');
    if (isBibName(rel)) {
      try {
        await ctx.lit.reloadBib();
      } catch (e) {
        ctx.log.debug('watcher: lit.reloadBib failed', String(e));
      }
      try {
        ctx.build.scheduleCompile();
      } catch {
        /* build service optional */
      }
      return;
    }
    if (!isTexName(rel)) return;
    if (!docs.openFiles().includes(rel)) {
      // The next open re-anchors against the snapshot; the PDF must still follow the file (a co-author's
      // edit in an \input file nobody has open, R2-I-8).
      try {
        ctx.build.scheduleCompile();
      } catch {
        /* build service optional */
      }
      return;
    }
    let raw: string;
    try {
      raw = await readFile(abs, 'utf8');
    } catch {
      return; // deleted or unreadable: reloadFromDisk would only warn; keep the mirror
    }
    if (docs.isKnownDiskText(rel, raw)) return; // our own write
    ctx.log.info(`watcher: ${rel} changed outside the app; re-anchoring`);
    await docs.reloadFromDisk(rel, 'external');
  };

  const schedule = (abs: string): void => {
    if (paused > 0) return;
    const t = timers.get(abs);
    if (t) clearTimeout(t);
    timers.set(
      abs,
      setTimeout(() => {
        timers.delete(abs);
        if (paused > 0) return;
        const prev = running.get(abs) ?? Promise.resolve();
        const next = prev
          .then(() => handle(abs))
          .catch((e) => ctx.log.warn('watcher: reload failed', e instanceof Error ? e.message : String(e)))
          .finally(() => {
            if (running.get(abs) === next) running.delete(abs);
          });
        running.set(abs, next);
      }, debounceMs),
    );
  };

  watcher.on('change', schedule);
  watcher.on('add', schedule);
  watcher.on('error', (e) => ctx.log.warn('watcher error', String(e)));
  const ready = new Promise<void>((resolve) => watcher.once('ready', () => resolve()));

  return {
    pause() {
      paused++;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        paused = Math.max(0, paused - 1);
      };
    },
    async close() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      await watcher.close();
      await Promise.allSettled([...running.values()]);
    },
    ready,
  };
}
