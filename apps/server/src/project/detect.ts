/** Detect the main .tex file (the one with \documentclass) and the .bib files of a LaTeX tree. */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { isBibName, isTexName, listFiles } from '../docs/text';
import { stripComment } from '../services/sync/scan';

const MAX_READ = 4 * 1024 * 1024;

function readSmall(path: string): string | null {
  try {
    if (statSync(path).size > MAX_READ) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Source without comments (line by line), for command detection. */
export function uncommented(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => stripComment(l))
    .join('\n');
}

const PREFERRED = ['main.tex', 'ms.tex', 'paper.tex', 'manuscript.tex', 'article.tex'];

/** The main file: a .tex with an uncommented \documentclass; preferred names, then shallowest, then with \begin{document}. */
export function detectMainFile(texRoot: string): string | null {
  const cands: Array<{ rel: string; depth: number; hasBegin: boolean; pref: number }> = [];
  for (const rel of listFiles(texRoot, isTexName)) {
    const text = readSmall(join(texRoot, rel));
    if (text === null) continue;
    const src = uncommented(text);
    if (!/\\documentclass\s*(\[[^\]]*\])?\s*\{/.test(src)) continue;
    const base = posix.basename(rel).toLowerCase();
    const pref = PREFERRED.indexOf(base);
    cands.push({ rel, depth: rel.split('/').length, hasBegin: /\\begin\s*\{document\}/.test(src), pref: pref < 0 ? 99 : pref });
  }
  cands.sort((a, b) => Number(b.hasBegin) - Number(a.hasBegin) || a.depth - b.depth || a.pref - b.pref || a.rel.localeCompare(b.rel));
  return cands[0]?.rel ?? null;
}

/** .bib files named by \bibliography{..} / \addbibresource{..} in the main file (existing ones), else every .bib in the tree. */
export function detectBibFiles(texRoot: string, mainFile: string | null): string[] {
  const all = listFiles(texRoot, isBibName);
  if (!mainFile) return all;
  const text = readSmall(join(texRoot, mainFile));
  if (text === null) return all;
  const src = uncommented(text);
  const dir = posix.dirname(mainFile);
  const out: string[] = [];
  const add = (name: string) => {
    let n = name.trim();
    if (!n) return;
    if (!/\.bib$/i.test(n)) n += '.bib';
    const candidates = [posix.normalize(posix.join(dir, n)), posix.normalize(n)];
    for (const c of candidates) {
      if (c.startsWith('..') || c.startsWith('/')) continue;
      if (existsSync(join(texRoot, c)) && !out.includes(c)) {
        out.push(c);
        return;
      }
    }
  };
  for (const m of src.matchAll(/\\bibliography\s*\{([^}]*)\}/g)) for (const n of m[1]!.split(',')) add(n);
  for (const m of src.matchAll(/\\addbibresource\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) add(m[1]!);
  return out.length ? out : all;
}
