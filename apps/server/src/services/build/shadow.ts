/**
 * The compile shadow: a mirror of texRoot in which every intent line (a line of the author's Chinese
 * notes) is blanked to a lone `%` (core shadowForCompile), so pdflatex never sees CJK and every line keeps its number (SyncTeX positions and
 * error lines in the shadow are the real source positions).
 *
 * Layout: the whole texRoot tree is copied once into `.paper/build/src`; later syncs rewrite only the
 * files that changed (a .tex file is rewritten when its shadowed text differs from the shadow copy; any
 * other file when its size or mtime differs) and delete the mirrored files that disappeared from the
 * source. Only files this mirror wrote itself (recorded in a manifest) are ever deleted, so files a
 * package writes into the working directory (filecontents, minted) are left alone.
 */
import { createHash } from 'node:crypto';
import { constants as fsc, existsSync, readFileSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { shadowForCompile } from '@paper-copilot/core';
import type { Logger } from '../../contracts';

/* ------------------------------------------------------------------------------------ */
/* shadowForCompile with a stand-in while core is still a stub                          */
/* ------------------------------------------------------------------------------------ */

const CJK = /[ᄀ-ᇿ⺀-⿟　-〿぀-ヿ㄀-㏿㐀-䶿一-鿿ꥠ-꥿가-퟿豈-﫿︰-﹏＀-￯]|[\ud840-\ud8bf][\udc00-\udfff]/g;

/** Same rule as core isIntentLine (latex/lines.ts), used only while core throws "not implemented". */
function fallbackIsIntentLine(line: string): boolean {
  const t = line.replace(/\r$/, '');
  const lead = t.trimStart();
  if (!lead || lead.startsWith('%')) return false;
  // Judge only the part before an unescaped %.
  let stop = lead.length;
  for (let i = 0; i < lead.length; i++) {
    if (lead[i] === '\\') {
      i++;
      continue;
    }
    if (lead[i] === '%') {
      stop = i;
      break;
    }
  }
  const body = lead.slice(0, stop);
  const cjk = (body.match(CJK) ?? []).length;
  if (cjk === 0) return false;
  const nonSpace = body.replace(/\s+/g, '').replace(CJK, 'x').length;
  const latin = (body.match(/[A-Za-zÀ-ɏ]/g) ?? []).length;
  return cjk >= 0.3 * nonSpace || (cjk >= 4 && cjk > latin);
}

export function fallbackShadow(source: string): string {
  return source
    .split('\n')
    // '%' (not an empty line): an empty line would end the paragraph the note sits in.
    .map((l) => (fallbackIsIntentLine(l) ? (l.endsWith('\r') ? '%\r' : '%') : l))
    .join('\n');
}

let coreShadowMissing = false;

/** core shadowForCompile; the local stand-in is used only while core still throws "not implemented". */
export function shadowText(source: string): string {
  if (!coreShadowMissing) {
    try {
      return shadowForCompile(source);
    } catch (e) {
      if (!(e instanceof Error && e.message.startsWith('not implemented'))) throw e;
      coreShadowMissing = true;
    }
  }
  return fallbackShadow(source);
}

/* ------------------------------------------------------------------------------------ */
/* Tree mirror                                                                           */
/* ------------------------------------------------------------------------------------ */

/** Source files that get the intent-line shadow. */
export const SHADOWED_EXT = /\.(tex|ltx)$/i;

/** Directory names never mirrored (VCS, editors, node_modules) and the sidecar itself. */
const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', '.paper', '.vscode', '.idea', '__pycache__']);

export interface ShadowSyncResult {
  written: string[];
  removed: string[];
  files: number;
  /** Relative directories of the tree (for creating include sub-directories in the output dir). */
  dirs: string[];
}

interface ManifestEntry {
  size: number;
  mtimeMs: number;
  /** sha256 of the shadow text for shadowed files. */
  sha?: string;
}

const MAX_FILES = 20_000;
const MAX_DEPTH = 24;

export function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface ShadowTreeOptions {
  /** Output-file names of the main job that must not be copied from a source tree compiled in place. */
  jobName?: string;
  log?: Logger;
  /** Absolute paths never mirrored (e.g. the .paper directory when it lives inside texRoot). */
  exclude?: string[];
}

export class ShadowTree {
  private manifest = new Map<string, ManifestEntry>();
  private readonly manifestPath: string;
  private loaded = false;

  constructor(
    private readonly srcRoot: string,
    private readonly dstRoot: string,
    private readonly opts: ShadowTreeOptions = {},
  ) {
    this.manifestPath = join(dirname(dstRoot), 'shadow-manifest.json');
  }

  /** Absolute path of a texRoot-relative file inside the shadow. */
  shadowPath(rel: string): string {
    return join(this.dstRoot, rel);
  }

  private loadManifest(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (existsSync(this.manifestPath)) {
        const raw = JSON.parse(readFileSync(this.manifestPath, 'utf8')) as Record<string, ManifestEntry>;
        for (const [k, v] of Object.entries(raw)) if (v && typeof v.size === 'number') this.manifest.set(k, v);
      }
    } catch {
      this.manifest.clear();
    }
  }

  private async saveManifest(): Promise<void> {
    const tmp = `${this.manifestPath}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(Object.fromEntries(this.manifest)), 'utf8');
    await rename(tmp, this.manifestPath);
  }

  private isJobOutput(rel: string): boolean {
    const job = this.opts.jobName;
    if (!job || rel.includes('/')) return false;
    return new RegExp(`^${job.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(aux|log|pdf|synctex(\\.gz)?|fdb_latexmk|fls|out|toc|lof|lot|bcf|run\\.xml|blg|xdv|dvi)$`).test(rel);
  }

  /** Walk the source tree: relative file paths (forward slashes) and directories. */
  private async walk(): Promise<{ files: string[]; dirs: string[] }> {
    const files: string[] = [];
    const dirs: string[] = [];
    const seen = new Set<string>();
    const exclude = (this.opts.exclude ?? []).map((p) => p.replace(/[\\/]+$/, ''));
    const visit = async (abs: string, rel: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
      let real: string;
      try {
        real = await realpath(abs);
      } catch {
        return;
      }
      if (seen.has(real)) return; // symlink loop
      seen.add(real);
      let entries;
      try {
        entries = await readdir(abs, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        const childAbs = join(abs, e.name);
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (exclude.some((x) => childAbs === x || childAbs.startsWith(x + sep))) continue;
        let isDir = e.isDirectory();
        let isFile = e.isFile();
        if (e.isSymbolicLink()) {
          try {
            const st = await stat(childAbs);
            isDir = st.isDirectory();
            isFile = st.isFile();
          } catch {
            continue; // dangling link
          }
        }
        if (isDir) {
          if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
          dirs.push(childRel);
          await visit(childAbs, childRel, depth + 1);
        } else if (isFile) {
          if (e.name.endsWith('~') || e.name.startsWith('.#')) continue;
          if (this.isJobOutput(childRel)) continue;
          files.push(childRel);
          if (files.length >= MAX_FILES) {
            this.opts.log?.warn(`shadow: more than ${MAX_FILES} files under texRoot; the rest are not mirrored`);
            return;
          }
        }
      }
    };
    await visit(this.srcRoot, '', 0);
    return { files, dirs };
  }

  /**
   * Bring the shadow up to date. `liveText(rel)` may return the editor's current text for a file
   * (otherwise the disk text is used).
   */
  async sync(liveText?: (rel: string) => string | null): Promise<ShadowSyncResult> {
    this.loadManifest();
    await mkdir(this.dstRoot, { recursive: true });
    const { files, dirs } = await this.walk();
    const written: string[] = [];
    const removed: string[] = [];
    const present = new Set(files);
    for (const d of dirs) await mkdir(join(this.dstRoot, d), { recursive: true });
    for (const rel of files) {
      const src = join(this.srcRoot, rel);
      const dst = join(this.dstRoot, rel);
      let st;
      try {
        st = await stat(src);
      } catch {
        present.delete(rel);
        continue;
      }
      const prev = this.manifest.get(rel);
      if (SHADOWED_EXT.test(rel)) {
        const live = liveText?.(rel) ?? null;
        let text: string;
        try {
          text = live ?? (await readFile(src, 'utf8'));
        } catch {
          continue;
        }
        const shadow = shadowText(text);
        const h = sha(shadow);
        if (prev?.sha === h && existsSync(dst)) continue;
        await mkdir(dirname(dst), { recursive: true });
        const tmp = `${dst}.tmp-${process.pid}`;
        await writeFile(tmp, shadow, 'utf8');
        await rename(tmp, dst);
        this.manifest.set(rel, { size: st.size, mtimeMs: st.mtimeMs, sha: h });
        written.push(rel);
      } else {
        if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs && existsSync(dst)) continue;
        await mkdir(dirname(dst), { recursive: true });
        // Never hard-link: a tool writing into the shadow must not be able to touch the real file.
        await copyFile(src, dst, fsc.COPYFILE_FICLONE);
        try {
          await utimes(dst, st.atime, st.mtime);
        } catch {
          /* best effort */
        }
        this.manifest.set(rel, { size: st.size, mtimeMs: st.mtimeMs });
        written.push(rel);
      }
    }
    for (const rel of [...this.manifest.keys()]) {
      if (present.has(rel)) continue;
      this.manifest.delete(rel);
      const dst = join(this.dstRoot, rel);
      // Only inside the shadow root.
      if (relative(this.dstRoot, dst).startsWith('..')) continue;
      try {
        await rm(dst, { force: true });
        removed.push(rel);
      } catch {
        /* ignore */
      }
    }
    if (written.length || removed.length) await this.saveManifest();
    return { written, removed, files: files.length, dirs };
  }

  /** sha256 of the shadow text of every shadowed (.tex-like) file as last synced, by relative path. */
  textShas(): Map<string, string> {
    this.loadManifest();
    const out = new Map<string, string>();
    for (const [rel, e] of this.manifest) if (e.sha) out.set(rel, e.sha);
    return out;
  }

  /** Does the shadow hold this relative path as a regular file? */
  async has(rel: string): Promise<boolean> {
    try {
      return (await lstat(join(this.dstRoot, rel))).isFile();
    } catch {
      return false;
    }
  }
}
