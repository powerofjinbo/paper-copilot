/**
 * Repository hygiene: nothing of the platform ever enters the LaTeX tree that is synced to co-authors.
 *
 * - .paper must be a sibling of texRoot (never inside it, and texRoot never inside .paper).
 * - git mode: build/aux/temp patterns go to `.git/info/exclude` (local to this clone, never pushed),
 *   so an accidental `git add -A` in a terminal cannot send them either. The tracked files are never
 *   touched and no .gitignore is written into the tree co-authors share.
 * - ols mode: overleaf-sync reads `.olignore` in the synced folder; it lists the same patterns and itself.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { ProjectConfig } from '@paper-copilot/core';
import type { PaperPaths } from '../contracts';

export const IGNORE_MARKER = '# paper-copilot: local build and temp files (never synced)';

export const IGNORE_PATTERNS = ['*.tmp-*', '*.aux', '*.log', '*.out', '*.fls', '*.fdb_latexmk', '*.synctex.gz', '*.synctex(busy)', '*.blg', '*.toc', '*.run.xml', '*.bcf', '.paper/', '.paper-*'];

function inside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel));
}

/** Throws when the sidecar would end up inside the synced tree (or the tree inside the sidecar). */
export function assertLayout(paths: PaperPaths): void {
  if (inside(paths.paper, paths.tex)) throw new Error(`the sidecar ${paths.paper} would be inside the LaTeX tree ${paths.tex}; the LaTeX tree must be a subfolder (e.g. <project>/tex) or a sibling of .paper`);
  if (inside(paths.tex, paths.paper)) throw new Error(`the LaTeX tree ${paths.tex} must not be inside ${paths.paper}`);
}

/** The git dir of the tree (handles `.git` files of worktrees/submodules). */
export function gitDirOf(texRoot: string): string | null {
  const dotgit = join(texRoot, '.git');
  if (!existsSync(dotgit)) return null;
  try {
    if (statSync(dotgit).isDirectory()) return dotgit;
    const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotgit, 'utf8'));
    return m ? resolve(texRoot, m[1]!.trim()) : null;
  } catch {
    return null;
  }
}

/** Idempotently add the platform's patterns; returns a description of what was done. */
export async function ensureHygiene(paths: PaperPaths, config: Pick<ProjectConfig, 'sync'>): Promise<string[]> {
  assertLayout(paths);
  const actions: string[] = [];
  if (existsSync(join(paths.tex, '.paper'))) actions.push(`warning: ${join(paths.tex, '.paper')} exists inside the LaTeX tree; it is not used by paper-copilot and should be removed so it is never synced`);
  const block = `\n${IGNORE_MARKER}\n${IGNORE_PATTERNS.join('\n')}\n`;
  const gitDir = gitDirOf(paths.tex);
  if (gitDir) {
    const info = join(gitDir, 'info');
    const exclude = join(info, 'exclude');
    const cur = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (!cur.includes(IGNORE_MARKER)) {
      await mkdir(info, { recursive: true });
      await appendFile(exclude, (cur && !cur.endsWith('\n') ? '\n' : '') + block, 'utf8');
      actions.push(`added build/temp patterns to ${exclude} (local to this clone)`);
    }
  }
  if (config.sync.mode === 'ols') {
    const ol = join(paths.tex, '.olignore');
    const cur = existsSync(ol) ? readFileSync(ol, 'utf8') : '';
    if (!cur.includes(IGNORE_MARKER)) {
      await writeFile(ol, (cur ? cur.replace(/\n?$/, '\n') : '') + `${IGNORE_MARKER}\n.olignore\n${IGNORE_PATTERNS.join('\n')}\n`, 'utf8');
      actions.push(`wrote ${ol} for overleaf-sync`);
    }
  }
  return actions;
}
