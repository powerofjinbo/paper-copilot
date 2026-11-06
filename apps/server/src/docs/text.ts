/**
 * Text helpers for the document mirror: line-ending and BOM normalization (the browser's CodeMirror
 * counts every line break as one character, so the server mirror is always LF; the file on disk keeps
 * its own convention), texRoot-relative path checks and the .tex file listing.
 */
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { safeJoin } from '../infra';
import { HttpError } from '../contracts';

export interface DiskForm {
  /** '\r\n' when the file used CRLF line endings, else '\n'. */
  eol: '\n' | '\r\n';
  bom: boolean;
}

/** Disk text -> mirror text (LF, no BOM) and the form needed to write it back unchanged. */
export function fromDisk(raw: string): { text: string; form: DiskForm } {
  let t = raw;
  const bom = t.charCodeAt(0) === 0xfeff;
  if (bom) t = t.slice(1);
  const crlf = t.includes('\r\n');
  if (crlf) t = t.replace(/\r\n/g, '\n');
  return { text: t, form: { eol: crlf ? '\r\n' : '\n', bom } };
}

/** Mirror text -> disk text in the file's own convention. */
export function toDisk(text: string, form: DiskForm): string {
  let t = form.eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text;
  if (form.bom) t = '﻿' + t;
  return t;
}

/** Normalize a client path to a clean posix path relative to texRoot (no '..', not absolute). */
export function normalizeRel(file: string): string {
  if (typeof file !== 'string' || file.length === 0 || file.length > 1024 || file.includes('\0')) throw new HttpError(400, 'invalid file path');
  const f = file.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (f.startsWith('/') || /^[a-zA-Z]:/.test(f)) throw new HttpError(400, 'file must be a path relative to the LaTeX tree');
  const parts = f.split('/').filter((p) => p.length > 0 && p !== '.');
  if (parts.some((p) => p === '..')) throw new HttpError(400, 'file must stay inside the LaTeX tree');
  if (parts.length === 0) throw new HttpError(400, 'invalid file path');
  return parts.join('/');
}

/**
 * Resolve a texRoot-relative path and refuse anything outside texRoot, including through symlinks.
 * The file may not exist yet; the deepest existing ancestor is checked with realpath.
 */
export function resolveInTex(texRoot: string, file: string): { rel: string; abs: string } {
  const rel = normalizeRel(file);
  let abs: string;
  try {
    abs = safeJoin(texRoot, rel);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : 'invalid path');
  }
  const realRoot = existsSync(texRoot) ? realpathSync(texRoot) : resolve(texRoot);
  let probe = abs;
  while (!existsSync(probe) && probe !== resolve(texRoot)) probe = resolve(probe, '..');
  const realProbe = existsSync(probe) ? realpathSync(probe) : probe;
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) throw new HttpError(400, 'path escapes the LaTeX tree');
  return { rel, abs };
}

/** Directories never descended into when listing the LaTeX tree. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.paper', '__MACOSX']);

/** Files under `root` (relative posix paths) whose name matches `test`; hidden dirs, symlinked dirs and build dirs skipped. */
export function listFiles(root: string, test: (name: string) => boolean, maxFiles = 5000): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const walk = (dir: string, depth: number): void => {
    if (depth > 12 || out.length >= maxFiles) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full, depth + 1);
      } else if (e.isFile() && test(e.name)) {
        out.push(relative(root, full).split(sep).join('/'));
      } else if (e.isSymbolicLink() && test(e.name)) {
        // a symlinked file is listed only when it resolves inside root
        try {
          const real = realpathSync(full);
          const realRoot = realpathSync(root);
          if ((real.startsWith(realRoot + sep) || real === realRoot) && lstatSync(real).isFile()) out.push(relative(root, full).split(sep).join('/'));
        } catch {
          /* dangling link */
        }
      }
    }
  };
  walk(root, 0);
  return out;
}

export const isTexName = (n: string): boolean => /\.tex$/i.test(n);
export const isBibName = (n: string): boolean => /\.bib$/i.test(n);

/** .tex files sorted, main file first. */
export function sortTexFiles(files: string[], mainFile: string): string[] {
  const sorted = [...new Set(files)].sort((a, b) => a.localeCompare(b));
  const i = sorted.indexOf(mainFile);
  if (i > 0) {
    sorted.splice(i, 1);
    sorted.unshift(mainFile);
  }
  return sorted;
}
