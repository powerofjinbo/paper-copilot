/**
 * A small, dependency-free glob matcher and repository walker for `config.factGlobs`.
 *
 * Pattern syntax (paths are POSIX-style and relative to the repository root):
 * - `**` as a whole segment matches any number of directories, including none
 *   (`results/**\/*.json` matches `results/a.json` and `results/x/y/a.json`);
 * - `*` matches any run of characters except `/`;
 * - `?` matches one character except `/`;
 * - `{a,b,c}` matches one of the alternatives (alternatives may contain glob syntax and nest);
 * - `[abc]`, `[a-z]`, `[!abc]` / `[^abc]` character classes; `\x` escapes `x`;
 * - a pattern starting with `!` excludes files matched by the other patterns.
 * Hidden files and directories (a segment starting with `.`) are only matched by a pattern segment
 * that itself starts with `.`; the walker never descends into `.git`, `node_modules` or `__pycache__`.
 */
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const GLOB_CHARS = /[*?[{\\]/;

export interface CompiledGlob {
  pattern: string;
  negated: boolean;
  regex: RegExp;
  /** Longest leading run of literal segments ('' = repository root). */
  base: string;
}

function escapeRegex(ch: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(ch) ? '\\' + ch : ch;
}

/** Compile one segment-internal piece of a glob (no `/`-level `**` handling here). */
function compilePiece(src: string, atSegmentStart: { v: boolean }): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '\\' && i + 1 < src.length) {
      out += escapeRegex(src[i + 1]!);
      atSegmentStart.v = false;
      i += 2;
      continue;
    }
    if (ch === '/') {
      out += '\\/';
      atSegmentStart.v = true;
      i++;
      continue;
    }
    if (ch === '*') {
      // Collapse runs of '*' inside a segment.
      while (src[i + 1] === '*') i++;
      out += atSegmentStart.v ? '(?!\\.)[^/]*' : '[^/]*';
      atSegmentStart.v = false;
      i++;
      continue;
    }
    if (ch === '?') {
      out += atSegmentStart.v ? '[^/.]' : '[^/]';
      atSegmentStart.v = false;
      i++;
      continue;
    }
    if (ch === '[') {
      const close = src.indexOf(']', i + 2);
      if (close === -1) {
        out += '\\[';
        atSegmentStart.v = false;
        i++;
        continue;
      }
      let body = src.slice(i + 1, close);
      let neg = false;
      if (body.startsWith('!') || body.startsWith('^')) {
        neg = true;
        body = body.slice(1);
      }
      const cls = body.replace(/[\\\]^]/g, (m) => '\\' + m);
      out += neg ? `[^/${cls}]` : `[${cls}]`;
      atSegmentStart.v = false;
      i = close + 1;
      continue;
    }
    if (ch === '{') {
      const close = matchingBrace(src, i);
      if (close === -1) {
        out += '\\{';
        atSegmentStart.v = false;
        i++;
        continue;
      }
      const alts = splitAlternatives(src.slice(i + 1, close));
      const startState = atSegmentStart.v;
      const compiled = alts.map((alt) => {
        const st = { v: startState };
        return compileWithGlobstar(alt, st);
      });
      out += '(?:' + compiled.join('|') + ')';
      atSegmentStart.v = false;
      i = close + 1;
      continue;
    }
    out += escapeRegex(ch);
    atSegmentStart.v = false;
    i++;
  }
  return out;
}

function matchingBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitAlternatives(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '\\' && i + 1 < body.length) {
      cur += ch + body[i + 1];
      i++;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Compile a pattern fragment, handling `**` segments. */
function compileWithGlobstar(src: string, atSegmentStart: { v: boolean }): string {
  // Split on '/', but keep braces intact (a '/' inside {..} belongs to the alternative).
  const segments: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '\\' && i + 1 < src.length) {
      cur += ch + src[i + 1];
      i++;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === '/' && depth === 0) {
      segments.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  segments.push(cur);
  let out = '';
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s]!;
    const last = s === segments.length - 1;
    if (seg === '**') {
      if (last) {
        // Trailing '**': anything below (including nothing when preceded by '/').
        out += '(?:(?!\\.)[^/]*(?:\\/(?!\\.)[^/]*)*)?';
      } else {
        out += '(?:(?!\\.)[^/]+\\/)*';
      }
      atSegmentStart.v = true;
      continue;
    }
    out += compilePiece(seg, atSegmentStart);
    if (!last) {
      out += '\\/';
      atSegmentStart.v = true;
    }
  }
  return out;
}

export function compileGlob(pattern: string): CompiledGlob {
  let p = pattern.trim();
  let negated = false;
  if (p.startsWith('!')) {
    negated = true;
    p = p.slice(1);
  }
  while (p.startsWith('./')) p = p.slice(2);
  while (p.startsWith('/')) p = p.slice(1);
  const st = { v: true };
  const regex = new RegExp('^' + compileWithGlobstar(p, st) + '$');
  const segs = p.split('/');
  const baseSegs: string[] = [];
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    if (GLOB_CHARS.test(seg) || seg === '' || seg === '.' || seg === '..') break;
    baseSegs.push(seg);
  }
  return { pattern, negated, regex, base: baseSegs.join('/') };
}

export function matchGlob(pattern: string | CompiledGlob, path: string): boolean {
  const g = typeof pattern === 'string' ? compileGlob(pattern) : pattern;
  return g.regex.test(path);
}

/** True when `path` matches at least one positive pattern and no negated one. */
export function matchAny(globs: CompiledGlob[], path: string): boolean {
  let hit = false;
  for (const g of globs) {
    if (g.negated) continue;
    if (g.regex.test(path)) {
      hit = true;
      break;
    }
  }
  if (!hit) return false;
  for (const g of globs) if (g.negated && g.regex.test(path)) return false;
  return true;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', '.tox', '.mypy_cache', '.pytest_cache']);

export interface WalkOptions {
  /** Stop after visiting this many directory entries (protects against huge trees). Default 200,000. */
  maxEntries?: number;
  maxDepth?: number;
  onWarn?: (msg: string) => void;
}

export interface WalkResult {
  files: string[];
  truncated: boolean;
  visited: number;
}

function isInside(base: string, p: string): boolean {
  return p === base || p.startsWith(base + sep);
}

/**
 * List files under `root` matching the patterns, relative POSIX paths sorted by code point.
 * Only the static base directories of the positive patterns are walked. Symlinked files are followed
 * only when their target stays inside `root`; symlinked directories are never followed.
 */
export function listMatchingFiles(root: string, patterns: string[], opts: WalkOptions = {}): WalkResult {
  const maxEntries = opts.maxEntries ?? 200_000;
  const maxDepth = opts.maxDepth ?? 40;
  const globs = patterns.filter((p) => p.trim() && p.trim() !== '!').map(compileGlob);
  const positives = globs.filter((g) => !g.negated);
  if (positives.length === 0) return { files: [], truncated: false, visited: 0 };
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { files: [], truncated: false, visited: 0 };
  }
  // Base directories, without nested duplicates ('' covers everything).
  const bases = [...new Set(positives.map((g) => g.base))].sort((a, b) => a.length - b.length);
  const roots: string[] = [];
  for (const b of bases) if (!roots.some((r) => r === '' || b === r || b.startsWith(r + '/'))) roots.push(b);

  const out = new Set<string>();
  let visited = 0;
  let truncated = false;
  const walk = (relDir: string, depth: number): void => {
    if (truncated) return;
    if (depth > maxDepth) {
      opts.onWarn?.(`glob walk: ${relDir || '.'} is deeper than ${maxDepth} levels; not descending`);
      return;
    }
    const absDir = relDir ? join(realRoot, relDir) : realRoot;
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (++visited > maxEntries) {
        truncated = true;
        opts.onWarn?.(`glob walk: stopped after ${maxEntries} entries under ${root}`);
        return;
      }
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(rel, depth + 1);
      } else if (e.isFile()) {
        if (matchAny(globs, rel)) out.add(rel);
      } else if (e.isSymbolicLink()) {
        const abs = join(absDir, e.name);
        try {
          const target = realpathSync(abs);
          if (!isInside(realRoot, target)) continue;
          if (statSync(target).isFile() && matchAny(globs, rel)) out.add(rel);
        } catch {
          /* dangling link */
        }
      }
    }
  };
  for (const r of roots) {
    if (r === '') {
      walk('', 0);
      continue;
    }
    const abs = join(realRoot, r);
    try {
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        const target = realpathSync(abs);
        if (!isInside(realRoot, target)) continue;
      }
      if (statSync(abs).isDirectory()) walk(r, r.split('/').length);
    } catch {
      /* base directory does not exist */
    }
  }
  return { files: [...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), truncated, visited };
}

/**
 * Resolve a repository-relative path and refuse anything outside the repository: absolute paths,
 * `..` segments, NUL bytes, and symlinks whose target leaves the repository.
 */
export function resolveInsideRepo(repoDir: string, rel: string): string {
  if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\0')) throw new Error('invalid path');
  const norm = rel.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[a-zA-Z]:\//.test(norm)) throw new Error('absolute paths are not allowed');
  if (norm.split('/').some((s) => s === '..')) throw new Error('path escapes the repository');
  const realRoot = realpathSync(repoDir);
  const full = join(realRoot, norm);
  let real: string;
  try {
    real = realpathSync(full);
  } catch {
    throw new Error(`no such file: ${rel}`);
  }
  if (!isInside(realRoot, real)) throw new Error('path escapes the repository');
  return real;
}

/** POSIX relative path of `abs` under `root`. */
export function relPosix(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/');
}
