/**
 * SyncService: Overleaf sync of the LaTeX tree (never anything in .paper).
 *
 * git mode (Overleaf git bridge; texRoot is a git clone): every command is `git -C <texRoot>`, never
 * interactive, never forced.
 *   pull: flush the editor, fetch, then `pull --rebase` with local uncommitted edits stashed around it.
 *         Any failure (conflict, untracked file in the way, stash that does not re-apply) restores the
 *         exact pre-pull state (rebase --abort / reset to the old HEAD + stash pop) and reports the
 *         conflicting files; the tree is never left mid-rebase. Changed .tex files are re-anchored
 *         (docs.reloadFromDisk(file, 'pull')), .bib files reload the bibliography, and the sync base
 *         copies (.paper/sync/base) are refreshed from HEAD.
 *   pushCheck: blockers (units in UNREVIEWED_STATES or with placeholders, intent lines, CJK outside
 *         comments in .tex, merge markers) + the unified diff co-authors will see (vs the upstream) +
 *         the files that would be committed.
 *   push: refuses unless pushCheck().ok; commits only changed or new .tex/.bib/style/figure files in
 *         texRoot with the author's message (deletions and renames are never staged), `pull --rebase`
 *         (undoing our commit on conflict), then `git push` without force.
 * ols mode: overleaf-sync (`ols`, file-level): pull = `ols -r` (remote to local), push = `ols -l`;
 *   a clear error when it is not installed. none mode: pull/push unavailable (409).
 * One sync operation at a time.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { UNREVIEWED_STATES, type PushCheck, type ReanchorReport, type SentenceUnit } from '@paper-copilot/core';
import { HttpError, type Ctx, type SyncService } from '../../contracts';
import { maskRemoteUrl } from '../../config';
import { writeFileAtomic } from '../../infra';
import { isBibName, isTexName, listFiles } from '../../docs/text';
import { createGit, describeProc, runProc, type Git, type ProcResult } from './proc';
import { merge3 } from './merge';
import { cjkHits, intentLineHits, mergeMarkerHits, unifiedDiff } from './scan';

type Blocker = PushCheck['blockers'][number];

export interface SyncServiceOptions {
  /** Pause the file watcher while a pull rewrites files (returns resume). */
  pauseWatcher?: () => () => void;
  /** Executables (tests). */
  gitBin?: string;
  olsBin?: string;
  /** Network operations (fetch/pull/push) time limit. Default 120 s. */
  networkTimeoutMs?: number;
}

/** Files a push may stage (texRoot-relative); everything else in the tree is left alone. */
const PUSHABLE = /\.(tex|bib|bst|cls|sty|bbx|cbx|png|jpe?g|pdf|eps|ps|svg|tikz|pgf|pdf_tex|txt|csv|dat)$/i;
/** Temp/aux files that never go out even if they match the list above. */
const NEVER_PUSH = /(\.tmp-\d+-\d+$|(^|\/)\.paper(\/|$)|\.(aux|log|out|toc|fls|fdb_latexmk|synctex\.gz|bbl|blg|run\.xml|bcf)$)/i;

export function isPushable(rel: string): boolean {
  return PUSHABLE.test(rel) && !NEVER_PUSH.test(rel) && !rel.split('/').some((p) => p.startsWith('.'));
}

interface StatusEntry {
  /** XY status code from porcelain v1. */
  xy: string;
  path: string;
}

/** `git status --porcelain=v1 -z` entries (renames report the new path). */
export function parsePorcelain(z: string): StatusEntry[] {
  const out: StatusEntry[] = [];
  const parts = z.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.length < 4) continue;
    const xy = p.slice(0, 2);
    out.push({ xy, path: p.slice(3) });
    if (xy[0] === 'R' || xy[0] === 'C') i++; // the next entry is the original path
  }
  return out;
}

function mutex() {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => undefined);
    return p;
  };
}

export function createSyncService(ctx: Ctx, opts: SyncServiceOptions = {}): SyncService & { syncBaseText(file: string): string | null } {
  const log = ctx.log;
  const exclusive = mutex();
  const netMs = opts.networkTimeoutMs ?? 120_000;
  const git = (): Git => createGit(ctx.paths.tex, opts.gitBin ?? 'git');
  const mode = () => ctx.config.sync.mode;
  const baseOf = (file: string) => join(ctx.paths.syncBase, ...file.split('/'));

  const SYNC_OFF = 'Sync is off for this project (sync mode "none"). Set "sync" in .paper/project.json, or re-run `paper init` with --sync git --remote <Overleaf git URL>.';
  const unavailable = (): never => {
    throw new HttpError(409, SYNC_OFF);
  };

  /** Pause the watcher and defer editor disk writes while git/ols rewrite the tree. */
  const holdTree = (): (() => void) => {
    const resumeWatcher = opts.pauseWatcher?.() ?? (() => undefined);
    const d = ctx.docs as typeof ctx.docs & { holdWrites?: () => () => void };
    const releaseWrites = typeof d.holdWrites === 'function' ? d.holdWrites() : () => undefined;
    return () => {
      releaseWrites();
      resumeWatcher();
    };
  };

  const flushDocs = async (): Promise<void> => {
    const d = ctx.docs as typeof ctx.docs & { flushAll?: () => Promise<void> };
    if (typeof d.flushAll === 'function') await d.flushAll();
    else for (const f of await ctx.docs.files()) if (ctx.docs.get(f)) await ctx.docs.flush(f);
  };

  /* ---------------------------------- git basics ---------------------------------- */

  const ensureRepo = async (g: Git): Promise<void> => {
    if (!existsSync(ctx.paths.tex)) throw new HttpError(409, `the LaTeX tree ${ctx.paths.tex} does not exist`);
    const r = await g.run(['rev-parse', '--is-inside-work-tree']);
    if (r.notFound) throw new HttpError(501, 'git is not installed');
    if (r.code !== 0 || r.stdout.trim() !== 'true') throw new HttpError(409, `${ctx.paths.tex} is not a git repository; clone the Overleaf project with \`paper import <git-url> --to <dir>\`.`);
  };

  const remoteName = async (g: Git): Promise<string> => {
    const remotes = (await g.run(['remote'])).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    const want = ctx.config.sync.remote;
    if (want) {
      for (const r of remotes) {
        const url = (await g.run(['remote', 'get-url', r])).stdout.trim();
        if (url === want) return r;
      }
    }
    if (remotes.includes('origin')) return 'origin';
    if (remotes.length > 0) return remotes[0]!;
    throw new HttpError(409, 'the LaTeX tree has no git remote; add the Overleaf git URL with `git remote add origin <url>`');
  };

  const branchOf = async (g: Git): Promise<string> => {
    const b = (await g.run(['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim();
    if (!b) throw new HttpError(409, 'the LaTeX tree is on a detached HEAD; check out the Overleaf branch first');
    return b;
  };

  /** Upstream ref name (e.g. origin/master) or null. */
  const upstreamOf = async (g: Git, remote: string, branch: string): Promise<string | null> => {
    const r = await g.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
    const ref = `${remote}/${branch}`;
    return (await g.ok(['rev-parse', '--verify', '-q', `refs/remotes/${ref}`])) ? ref : null;
  };

  const rebaseInProgress = (): boolean => {
    const gd = join(ctx.paths.tex, '.git');
    return existsSync(join(gd, 'rebase-merge')) || existsSync(join(gd, 'rebase-apply'));
  };

  const conflictedFiles = async (g: Git): Promise<string[]> =>
    (await g.run(['diff', '--name-only', '--diff-filter=U', '-z'])).stdout.split('\0').filter(Boolean);

  const trackedTexAndBib = async (g: Git): Promise<string[]> =>
    (await g.run(['ls-files', '-z'])).stdout.split('\0').filter((f) => f && (isTexName(f) || isBibName(f)));

  /** Refresh sync/base copies from HEAD for every tracked .tex/.bib file. */
  const refreshBaseFromHead = async (g: Git): Promise<void> => {
    for (const f of await trackedTexAndBib(g)) {
      const r = await g.run(['show', `HEAD:${f}`]);
      if (r.code !== 0) continue;
      await mkdir(dirname(baseOf(f)), { recursive: true });
      await writeFileAtomic(baseOf(f), r.stdout);
    }
  };

  /** Refresh sync/base copies from the working tree (ols mode: the synced state is the files). */
  const refreshBaseFromTree = async (): Promise<void> => {
    for (const f of listFiles(ctx.paths.tex, (n) => isTexName(n) || isBibName(n))) {
      try {
        await writeFileAtomic(baseOf(f), readFileSync(join(ctx.paths.tex, f), 'utf8'));
      } catch (e) {
        log.warn(`sync: cannot copy ${f} to the sync base`, String(e));
      }
    }
  };

  const reloadChanged = async (files: string[], source: 'pull'): Promise<ReanchorReport[]> => {
    const reports: ReanchorReport[] = [];
    let bib = false;
    for (const f of [...new Set(files)]) {
      if (isBibName(f)) bib = true;
      if (!isTexName(f) || !existsSync(join(ctx.paths.tex, f))) continue;
      try {
        reports.push(await ctx.docs.reloadFromDisk(f, source));
      } catch (e) {
        log.warn(`sync: cannot re-anchor ${f}`, e instanceof Error ? e.message : String(e));
      }
    }
    if (bib) {
      try {
        await ctx.lit.reloadBib();
      } catch (e) {
        log.debug('sync: lit.reloadBib failed', String(e));
      }
    }
    return reports;
  };

  const show = async (g: Git, spec: string): Promise<string | null> => {
    const r = await g.run(['show', spec]);
    return r.code === 0 ? r.stdout : null;
  };

  /** Resolve the conflicted files of a stopped rebase step with the sentence-level merge (text files only). */
  const mergeStages = async (g: Git, files: string[]): Promise<{ ok: boolean; failed: string[] }> => {
    const out = new Map<string, string>();
    const failed: string[] = [];
    for (const f of files) {
      if (!isTexName(f) && !isBibName(f)) {
        failed.push(f);
        continue;
      }
      const base = (await show(g, `:1:${f}`)) ?? '';
      const ours = await show(g, `:2:${f}`);
      const theirs = await show(g, `:3:${f}`);
      if (ours === null || theirs === null) {
        failed.push(f);
        continue;
      }
      const m = merge3(base, ours, theirs);
      if (!m.ok) failed.push(f);
      else out.set(f, m.text);
    }
    if (failed.length) return { ok: false, failed };
    for (const [f, text] of out) {
      await writeFileAtomic(join(ctx.paths.tex, f), text);
      const add = await g.run(['add', '--', f]);
      if (add.code !== 0) return { ok: false, failed: [f] };
    }
    return { ok: true, failed: [] };
  };

  /**
   * `git stash pop` conflicted: rebuild every stashed file as merge3(old HEAD, stash, new HEAD); on
   * success the tree is clean at the new HEAD plus the merged local edits, and the stash is dropped.
   */
  const mergeStash = async (g: Git, oldHead: string): Promise<{ ok: boolean; failed: string[] }> => {
    const files = (await g.run(['stash', 'show', '--name-only', '-z', 'stash@{0}'])).stdout.split('\0').filter(Boolean);
    const out = new Map<string, string | null>();
    const failed: string[] = [];
    for (const f of files) {
      const base = await show(g, `${oldHead}:${f}`);
      const ours = await show(g, `stash@{0}:${f}`);
      const theirs = await show(g, `HEAD:${f}`);
      if (ours === null) {
        // deleted locally: fine only if the pull did not change it
        if (theirs === base) out.set(f, null);
        else failed.push(f);
        continue;
      }
      if (!isTexName(f) && !isBibName(f) && ours !== theirs && ours !== base && theirs !== base) {
        failed.push(f);
        continue;
      }
      const m = merge3(base ?? '', ours, theirs ?? '');
      if (!m.ok) failed.push(f);
      else out.set(f, m.text);
    }
    if (failed.length) return { ok: false, failed };
    await g.run(['reset', '--hard', '--quiet', 'HEAD']);
    for (const [f, text] of out) {
      const abs = join(ctx.paths.tex, f);
      if (text === null) {
        await rm(abs, { force: true });
        continue;
      }
      await writeFileAtomic(abs, text);
    }
    await g.run(['stash', 'drop', '--quiet', 'stash@{0}']);
    return { ok: true, failed: [] };
  };

  /**
   * fetch + pull --rebase with local edits stashed; restores the pre-pull state on any failure.
   * Returns the files changed by the pull.
   */
  const gitPullRebase = async (g: Git, remote: string, branch: string): Promise<{ changed: string[]; output: string }> => {
    if (rebaseInProgress()) throw new HttpError(409, 'a rebase is already in progress in the LaTeX tree; finish or abort it in a terminal (git rebase --abort) first');
    const fetched = await g.run(['fetch', '--quiet', remote, branch], { timeoutMs: netMs });
    if (fetched.code !== 0) throw new HttpError(502, `git fetch failed: ${describeProc(fetched)}`);
    const oldHead = await g.out(['rev-parse', 'HEAD']);
    const remoteRef = `refs/remotes/${remote}/${branch}`;
    const hasRemoteRef = await g.ok(['rev-parse', '--verify', '-q', remoteRef]);
    const target = hasRemoteRef ? remoteRef : 'FETCH_HEAD';
    const behind = Number((await g.run(['rev-list', '--count', `HEAD..${target}`])).stdout.trim() || '0');
    if (behind === 0) return { changed: [], output: 'Already up to date.' };

    const dirty = (await g.run(['status', '--porcelain=v1', '-z', '--untracked-files=no'])).stdout.length > 0;
    let stashed = false;
    if (dirty) {
      const s = await g.run(['stash', 'push', '--quiet', '-m', 'paper-copilot: local edits during pull']);
      if (s.code !== 0) throw new HttpError(409, `cannot set local edits aside for the pull: ${describeProc(s)}`);
      stashed = true;
    }
    const restore = async (why: string, conflicts: string[]): Promise<never> => {
      if (rebaseInProgress()) await g.run(['rebase', '--abort']);
      await g.run(['reset', '--hard', '--quiet', oldHead]);
      if (stashed) {
        const pop = await g.run(['stash', 'pop', '--quiet']);
        if (pop.code !== 0) log.error('sync: could not re-apply the stashed local edits; they are kept in `git stash list`', describeProc(pop));
      }
      throw new HttpError(409, `${why}${conflicts.length ? ` Conflicting files: ${conflicts.join(', ')}.` : ''} The LaTeX tree was restored to its state before the pull; nothing was lost. Resolve it in a terminal (git -C "${ctx.paths.tex}" pull --rebase) or ask the co-author who changed the same sentences.`);
    };
    let pulled: ProcResult = await g.run(['pull', '--rebase', '--no-autostash', '--quiet', remote, branch], { timeoutMs: netMs });
    let resolved: string[] = [];
    // A rebase step that stopped on a conflict: resolve sentence-level (non-overlapping) conflicts
    // ourselves; git treats edits of adjacent lines as conflicting, which is the common case here.
    for (let step = 0; rebaseInProgress() && step < 200; step++) {
      const conflicts = await conflictedFiles(g);
      if (conflicts.length === 0) {
        pulled = await g.run(['-c', 'core.editor=true', 'rebase', '--continue']);
        if (pulled.code !== 0 && rebaseInProgress() && (await conflictedFiles(g)).length === 0) {
          // an empty commit after resolution: skip it
          pulled = await g.run(['rebase', '--skip']);
        }
        continue;
      }
      const merged = await mergeStages(g, conflicts);
      if (!merged.ok) return restore('Co-authors changed the same sentences as your unpushed commits.', merged.failed);
      resolved = resolved.concat(conflicts);
      pulled = await g.run(['-c', 'core.editor=true', 'rebase', '--continue']);
    }
    if (pulled.code !== 0 || rebaseInProgress()) {
      const conflicts = await conflictedFiles(g);
      return restore(`git pull --rebase failed: ${describeProc(pulled)}.`, conflicts);
    }
    if (stashed) {
      const pop = await g.run(['stash', 'pop', '--quiet']);
      if (pop.code !== 0) {
        const conflicts = await conflictedFiles(g);
        const fixed = await mergeStash(g, oldHead);
        if (!fixed.ok) {
          // the stash is kept by git when pop conflicts; drop the half-applied state, go back, re-apply
          await g.run(['reset', '--hard', '--quiet', 'HEAD']);
          return restore('Your unsaved local edits change the same sentences as the pulled changes.', fixed.failed.length ? fixed.failed : conflicts);
        }
        resolved = resolved.concat(conflicts);
      }
    }
    if (resolved.length) log.info(`sync: merged sentence-level edits in ${[...new Set(resolved)].join(', ')}`);
    const newHead = await g.out(['rev-parse', 'HEAD']);
    const changed = (await g.run(['diff', '--name-only', '-z', oldHead, newHead])).stdout.split('\0').filter(Boolean);
    return { changed, output: (pulled.stdout + pulled.stderr).trim() || `Updated ${oldHead.slice(0, 7)}..${newHead.slice(0, 7)}` };
  };

  /* ---------------------------------- ols ---------------------------------- */

  const ols = async (args: string[]): Promise<ProcResult> => {
    const r = await runProc(opts.olsBin ?? 'ols', args, { cwd: ctx.paths.tex, timeoutMs: netMs });
    if (r.notFound) throw new HttpError(501, 'overleaf-sync (`ols`) is not installed. Install it with `pip install overleaf-sync`, run `ols login` once, or switch the project to git sync (Overleaf git bridge).');
    if (r.code !== 0) throw new HttpError(502, `ols ${args.join(' ')} failed: ${describeProc(r)}`);
    return r;
  };

  const changedVsBase = (): string[] => {
    const out: string[] = [];
    for (const f of listFiles(ctx.paths.tex, (n) => isTexName(n) || isBibName(n))) {
      let cur: string | null = null;
      try {
        cur = readFileSync(join(ctx.paths.tex, f), 'utf8');
      } catch {
        continue;
      }
      const base = existsSync(baseOf(f)) ? readFileSync(baseOf(f), 'utf8') : null;
      if (cur !== base) out.push(f);
    }
    return out;
  };

  /* ---------------------------------- push check ---------------------------------- */

  const unitsOfAllFiles = async (texFiles: string[]): Promise<SentenceUnit[]> => {
    const out: SentenceUnit[] = [];
    for (const f of texFiles) {
      const open = ctx.docs.get(f);
      if (open) out.push(...open.units);
      else {
        try {
          out.push(...ctx.db.units(f));
        } catch {
          /* no units yet */
        }
      }
    }
    return out;
  };

  const textOf = (f: string): string | null => {
    const open = ctx.docs.get(f);
    if (open) return open.text;
    try {
      return readFileSync(join(ctx.paths.tex, f), 'utf8');
    } catch {
      return null;
    }
  };

  const blockersFor = async (): Promise<Blocker[]> => {
    const tex = listFiles(ctx.paths.tex, isTexName);
    const bib = listFiles(ctx.paths.tex, isBibName);
    const blockers: Blocker[] = [];
    const short = (s: string) => (s.length > 200 ? s.slice(0, 197) + '...' : s);
    for (const u of await unitsOfAllFiles(tex)) {
      if (u.orphaned) continue;
      const text = ctx.docs.unitText(u.id) ?? u.textNorm;
      const where = `${u.file}:${u.line}: `;
      if (UNREVIEWED_STATES.includes(u.state)) {
        blockers.push({ kind: u.state as 'proposed' | 'unsupported' | 'placeholder', sentenceId: u.id, line: u.line, text: short(where + text) });
      } else if (u.placeholders.length > 0) {
        blockers.push({ kind: 'placeholder', sentenceId: u.id, line: u.line, text: short(where + text) });
      }
    }
    for (const f of tex) {
      const text = textOf(f);
      if (text === null) continue;
      const intents = intentLineHits(text);
      const intentLines = new Set(intents.map((h) => h.line));
      for (const h of intents) blockers.push({ kind: 'intent_line', sentenceId: null, line: h.line, text: short(`${f}:${h.line}: ${h.text}`) });
      for (const h of cjkHits(text)) if (!intentLines.has(h.line)) blockers.push({ kind: 'cjk', sentenceId: null, line: h.line, text: short(`${f}:${h.line}: ${h.text}`) });
      for (const h of mergeMarkerHits(text)) blockers.push({ kind: 'conflict', sentenceId: null, line: h.line, text: short(`${f}:${h.line}: ${h.text}`) });
    }
    for (const f of bib) {
      const text = textOf(f);
      if (text === null) continue;
      for (const h of mergeMarkerHits(text)) blockers.push({ kind: 'conflict', sentenceId: null, line: h.line, text: short(`${f}:${h.line}: ${h.text}`) });
    }
    return blockers;
  };

  /** Files a push would send, and the diff co-authors will see. */
  const gitChanges = async (g: Git): Promise<{ files: string[]; diff: string; upstream: string | null }> => {
    const remote = await remoteName(g).catch(() => null);
    const branch = await branchOf(g).catch(() => null);
    const upstream = remote && branch ? await upstreamOf(g, remote, branch) : null;
    const entries = parsePorcelain((await g.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout);
    const files = new Set<string>();
    for (const e of entries) {
      if (e.xy.includes('D')) continue; // deletions are never staged by the platform
      if (isPushable(e.path)) files.add(e.path);
    }
    // committed but not yet pushed
    const committed = upstream ? (await g.run(['diff', '--name-only', '-z', `${upstream}...HEAD`])).stdout.split('\0').filter(Boolean) : [];
    for (const f of committed) files.add(f);
    const list = [...files].sort();
    let diff = '';
    if (list.length) {
      const tracked = new Set((await g.run(['ls-files', '-z', '--', ...list])).stdout.split('\0').filter(Boolean));
      const base = upstream ?? ((await g.ok(['rev-parse', '--verify', '-q', 'HEAD'])) ? 'HEAD' : null);
      const trackedList = list.filter((f) => tracked.has(f) || committed.includes(f));
      if (trackedList.length && base) diff += (await g.run(['diff', '--no-color', '--no-ext-diff', base, '--', ...trackedList])).stdout;
      for (const f of list.filter((x) => !trackedList.includes(x))) {
        if (!/\.(tex|bib|bst|cls|sty|txt|csv|dat|tikz|pgf)$/i.test(f)) {
          diff += `diff --git a/${f} b/${f}\nnew file (binary)\n`;
          continue;
        }
        diff += unifiedDiff(f, null, textOf(f) ?? '');
      }
    }
    return { files: list, diff, upstream };
  };

  const baseChanges = (): { files: string[]; diff: string } => {
    const files = changedVsBase();
    let diff = '';
    for (const f of files) {
      const base = existsSync(baseOf(f)) ? readFileSync(baseOf(f), 'utf8') : null;
      diff += unifiedDiff(f, base, textOf(f));
    }
    return { files, diff };
  };

  const pushCheck = async (): Promise<PushCheck> => {
    await flushDocs();
    const blockers = await blockersFor();
    let files: string[] = [];
    let diff = '';
    if (mode() === 'git') {
      const g = git();
      await ensureRepo(g);
      ({ files, diff } = await gitChanges(g));
    } else {
      ({ files, diff } = baseChanges());
    }
    // Sync mode "none": the guard still lists blockers and the diff since the last sync, but a push is
    // impossible, so the check never reports ok.
    if (mode() === 'none') return { ok: false, blockers, diff, files, unavailable: SYNC_OFF };
    return { ok: blockers.length === 0, blockers, diff, files, unavailable: null };
  };

  const summarizeRefusal = (check: PushCheck): string => {
    const counts = new Map<string, number>();
    for (const b of check.blockers) counts.set(b.kind, (counts.get(b.kind) ?? 0) + 1);
    const label: Record<string, string> = { proposed: 'proposed sentence(s) awaiting review', unsupported: 'unsupported sentence(s)', placeholder: 'placeholder(s)', intent_line: 'intent line(s)', cjk: 'line(s) with Chinese/Japanese/Korean text outside comments', conflict: 'unresolved merge marker(s)' };
    return `Push refused: ${[...counts].map(([k, n]) => `${n} ${label[k] ?? k}`).join(', ')}. Review them first; nothing was sent to co-authors.`;
  };

  return {
    async status() {
      const m = mode();
      if (m === 'none') return { mode: 'none', remote: null, branch: '', ahead: 0, behind: 0, dirty: false };
      if (m === 'ols') return { mode: 'ols', remote: maskRemoteUrl(ctx.config.sync.remote), branch: '', ahead: 0, behind: 0, dirty: changedVsBase().length > 0 };
      const g = git();
      await ensureRepo(g);
      const branch = (await g.run(['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim() || 'HEAD';
      const remote = await remoteName(g).catch(() => null);
      const remoteUrl = ctx.config.sync.remote ?? (remote ? (await g.run(['remote', 'get-url', remote])).stdout.trim() || null : null);
      const upstream = remote ? await upstreamOf(g, remote, branch) : null;
      let ahead = 0;
      let behind = 0;
      if (upstream) {
        const r = (await g.run(['rev-list', '--left-right', '--count', `HEAD...${upstream}`])).stdout.trim().split(/\s+/);
        ahead = Number(r[0] ?? 0) || 0;
        behind = Number(r[1] ?? 0) || 0;
      }
      const dirty = (await g.run(['status', '--porcelain=v1', '--untracked-files=no'])).stdout.trim().length > 0;
      return { mode: 'git', remote: maskRemoteUrl(remoteUrl), branch, ahead, behind, dirty };
    },

    pull() {
      return exclusive(async () => {
        const m = mode();
        if (m === 'none') unavailable();
        await flushDocs();
        const resume = holdTree();
        try {
          if (m === 'ols') {
            const before = new Map<string, string>();
            for (const f of listFiles(ctx.paths.tex, (n) => isTexName(n) || isBibName(n))) before.set(f, readFileSync(join(ctx.paths.tex, f), 'utf8'));
            await ols(['-r']);
            const changed: string[] = [];
            for (const f of listFiles(ctx.paths.tex, (n) => isTexName(n) || isBibName(n))) {
              const now = readFileSync(join(ctx.paths.tex, f), 'utf8');
              if (before.get(f) !== now) changed.push(f);
            }
            const reports = await reloadChanged(changed, 'pull');
            await refreshBaseFromTree();
            return reports;
          }
          const g = git();
          await ensureRepo(g);
          const remote = await remoteName(g);
          const branch = await branchOf(g);
          const { changed } = await gitPullRebase(g, remote, branch);
          const reports = await reloadChanged(changed, 'pull');
          await refreshBaseFromHead(g);
          return reports;
        } finally {
          resume();
        }
      });
    },

    pushCheck: () => exclusive(pushCheck),

    push(message: string) {
      return exclusive(async () => {
        const msg = (message ?? '').trim();
        if (!msg) throw new HttpError(400, 'a commit message is required');
        if (msg.length > 5000) throw new HttpError(400, 'the commit message is too long');
        const m = mode();
        if (m === 'none') unavailable();
        const check = await pushCheck();
        if (!check.ok) return { ok: false, output: summarizeRefusal(check), check };
        const resume = holdTree();
        try {
          if (m === 'ols') {
            const r = await ols(['-l']);
            await refreshBaseFromTree();
            return { ok: true, output: (r.stdout + r.stderr).trim() || 'Pushed with overleaf-sync.', check };
          }
          const g = git();
          await ensureRepo(g);
          const remote = await remoteName(g);
          const branch = await branchOf(g);
          const out: string[] = [];
          let committed = false;
          if (check.files.length) {
            const entries = parsePorcelain((await g.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout);
            const toStage = entries.filter((e) => !e.xy.includes('D') && isPushable(e.path) && check.files.includes(e.path)).map((e) => e.path);
            if (toStage.length) {
              const add = await g.run(['add', '--', ...toStage]);
              if (add.code !== 0) throw new HttpError(500, `git add failed: ${describeProc(add)}`);
              const staged = (await g.run(['diff', '--cached', '--name-only', '-z'])).stdout.split('\0').filter(Boolean);
              if (staged.length) {
                const c = await g.run(['commit', '--quiet', '--no-verify', '-m', msg, '--', ...staged]);
                if (c.code !== 0) {
                  await g.run(['reset', '--quiet', '--', ...staged]);
                  throw new HttpError(500, `git commit failed: ${describeProc(c)}${/user\.(name|email)|identity/i.test(c.stderr) ? ' (set your name and e-mail with git config user.name / user.email)' : ''}`);
                }
                committed = true;
                out.push(`Committed ${staged.length} file(s): ${staged.join(', ')}`);
              }
            }
          }
          // Overleaf needs the branch up to date: rebase our commit on the remote first.
          let pulledFiles: string[] = [];
          try {
            const p = await gitPullRebase(g, remote, branch);
            pulledFiles = p.changed;
            if (p.changed.length) out.push(`Rebased on co-author changes (${p.changed.length} file(s)).`);
          } catch (e) {
            if (committed) {
              await g.run(['reset', '--soft', '--quiet', 'HEAD~1']);
              await g.run(['reset', '--quiet']);
              out.push('Your commit was undone; your edits are unchanged in the working tree.');
            }
            const message = e instanceof Error ? e.message : String(e);
            return { ok: false, output: [...out, message].join('\n'), check };
          }
          if (pulledFiles.length) await reloadChanged(pulledFiles, 'pull');
          const ahead = Number((await g.run(['rev-list', '--count', `refs/remotes/${remote}/${branch}..HEAD`])).stdout.trim() || '0');
          const hasRemoteBranch = await g.ok(['rev-parse', '--verify', '-q', `refs/remotes/${remote}/${branch}`]);
          if (hasRemoteBranch && ahead === 0) {
            await refreshBaseFromHead(g);
            return { ok: true, output: [...out, 'Nothing to push: co-authors already have everything.'].join('\n'), check };
          }
          const pushed = await g.run(['push', '--porcelain', remote, `HEAD:refs/heads/${branch}`], { timeoutMs: netMs });
          if (pushed.code !== 0) {
            return { ok: false, output: [...out, `git push failed: ${describeProc(pushed)}`, committed ? 'The commit stays local; run push again after fixing the problem.' : ''].filter(Boolean).join('\n'), check };
          }
          await g.run(['fetch', '--quiet', remote, branch], { timeoutMs: netMs });
          await refreshBaseFromHead(g);
          out.push((pushed.stdout + pushed.stderr).trim().split('\n').filter((l) => !/^To |^Done$/.test(l)).join('\n') || 'Pushed.');
          return { ok: true, output: out.filter(Boolean).join('\n'), check };
        } finally {
          resume();
        }
      });
    },

    syncBaseText(file: string) {
      const p = baseOf(file);
      return existsSync(p) ? readFileSync(p, 'utf8') : null;
    },
  };
}
