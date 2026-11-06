/**
 * `paper init`: create the .paper sidecar and project.json for a LaTeX tree.
 *
 * Layout (docs/design.md, "Data model"): <root>/tex is the LaTeX tree (the Overleaf clone; the only
 * thing ever synced) and <root>/.paper the sidecar. `paper init <dir>` accepts either the project root
 * (with a `tex/` folder) or the LaTeX tree itself (then the project root is its parent, so .paper is a
 * sibling of the tree, never inside it); `--tex` names the tree explicitly.
 *
 * Re-running init on an existing project changes only the options given.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { ProjectConfig, type NotesLanguage, type Venue } from '@paper-copilot/core';
import { defaultProjectConfig, findSkillDir, loadConfig, saveConfig } from '../config';
import type { PaperPaths } from '../contracts';
import { ensureLayout, paperPaths } from '../infra';
import { isTexName, listFiles } from '../docs/text';
import { createGit } from '../services/sync/proc';
import { detectBibFiles, detectMainFile, uncommented } from './detect';
import { assertLayout, ensureHygiene } from './hygiene';
import { applySemanticLines, type SemanticResult } from './semanticLines';

export interface InitOptions {
  /** The LaTeX tree, when it is not <root>/tex. */
  tex?: string;
  /** Analysis repository (read-only). */
  repo?: string | null;
  /** hep-paper-writing skill checkout. */
  skill?: string;
  venue?: Venue;
  notes?: NotesLanguage;
  sync?: 'git' | 'ols' | 'none';
  remote?: string | null;
  branch?: string;
  /** Apply reversible one-sentence-per-line normalization to every .tex file. */
  semanticLines?: boolean;
  name?: string;
  /** Main file relative to the tree (default: detected). */
  main?: string;
}

export interface InitResult {
  root: string;
  paths: PaperPaths;
  config: ProjectConfig;
  created: boolean;
  actions: string[];
  semantic: SemanticResult[];
}

export class InitError extends Error {}

function hasDocumentclass(dir: string): boolean {
  for (const rel of listFiles(dir, isTexName, 200)) {
    try {
      const p = join(dir, rel);
      if (statSync(p).size > 4 * 1024 * 1024) continue;
      if (/\\documentclass/.test(uncommented(readFileSync(p, 'utf8')))) return true;
    } catch {
      /* unreadable */
    }
  }
  return false;
}

/** Decide project root and LaTeX tree from the user's arguments. */
export function resolveLayout(dir: string, tex?: string): { root: string; texRoot: string } {
  const d = resolve(dir);
  if (tex) return { root: d, texRoot: resolve(tex) };
  // an existing project: its project.json says where the tree is
  const cfgPath = join(d, '.paper', 'project.json');
  if (existsSync(cfgPath)) {
    try {
      const cfg = ProjectConfig.parse(JSON.parse(readFileSync(cfgPath, 'utf8')));
      return { root: d, texRoot: cfg.texRoot };
    } catch {
      /* fall through */
    }
  }
  if (existsSync(join(d, 'tex')) && statSync(join(d, 'tex')).isDirectory()) return { root: d, texRoot: join(d, 'tex') };
  if (existsSync(d) && statSync(d).isDirectory() && hasDocumentclass(d)) {
    const parent = dirname(d);
    const pcfg = join(parent, '.paper', 'project.json');
    if (existsSync(pcfg)) {
      try {
        const cfg = ProjectConfig.parse(JSON.parse(readFileSync(pcfg, 'utf8')));
        if (resolve(cfg.texRoot) !== d) throw new InitError(`${parent}/.paper already belongs to another LaTeX tree (${cfg.texRoot}); use --tex with a different project folder`);
      } catch (e) {
        if (e instanceof InitError) throw e;
      }
    }
    return { root: parent, texRoot: d };
  }
  throw new InitError(`no LaTeX tree found at ${d}: expected ${join(d, 'tex')} or .tex files with \\documentclass (use --tex <dir>, or \`paper import\` to fetch one)`);
}

/** Current branch and remote URL of a git LaTeX tree (null when it is not one). */
export async function gitInfo(texRoot: string): Promise<{ branch: string; remote: string | null } | null> {
  if (!existsSync(join(texRoot, '.git'))) return null;
  const g = createGit(texRoot);
  const inside = await g.run(['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0) return null;
  const branch = (await g.run(['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim() || 'master';
  const remotes = (await g.run(['remote'])).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const name = remotes.includes('origin') ? 'origin' : remotes[0];
  const remote = name ? (await g.run(['remote', 'get-url', name])).stdout.trim() || null : null;
  return { branch, remote };
}

export async function initProject(dir: string, opts: InitOptions = {}): Promise<InitResult> {
  const { root, texRoot } = resolveLayout(dir, opts.tex);
  if (!existsSync(texRoot) || !statSync(texRoot).isDirectory()) throw new InitError(`the LaTeX tree ${texRoot} does not exist`);
  const paths = paperPaths(root, texRoot);
  try {
    assertLayout(paths);
  } catch (e) {
    throw new InitError(e instanceof Error ? e.message : String(e));
  }
  const existing = (() => {
    try {
      return loadConfig(paths);
    } catch (e) {
      throw new InitError(e instanceof Error ? e.message : String(e));
    }
  })();
  const actions: string[] = [];

  const main = opts.main ?? (existing && existsSync(join(texRoot, existing.mainFile)) ? existing.mainFile : detectMainFile(texRoot));
  if (!main) throw new InitError(`no .tex file with \\documentclass in ${texRoot}; pass --main <file>`);
  if (!existsSync(join(texRoot, main))) throw new InitError(`main file ${main} not found in ${texRoot}`);

  const repo = opts.repo === undefined ? (existing?.repoDir ?? null) : opts.repo === null ? null : resolve(opts.repo);
  if (repo && !existsSync(repo)) throw new InitError(`analysis repository ${repo} does not exist`);
  const skill = opts.skill ? resolve(opts.skill) : (existing?.skillDir ?? findSkillDir());
  if (!existsSync(join(skill, 'SKILL.md'))) actions.push(`warning: no SKILL.md in ${skill}; set --skill to your hep-paper-writing checkout (AI help works without it but ignores your style rules)`);

  let sync = existing?.sync ?? { mode: 'none' as const, remote: null, branch: 'master' };
  const gi = await gitInfo(texRoot);
  if (opts.sync) sync = { ...sync, mode: opts.sync };
  else if (!existing && gi) sync = { mode: 'git', remote: gi.remote, branch: gi.branch };
  if (opts.remote !== undefined) sync = { ...sync, remote: opts.remote };
  if (opts.branch) sync = { ...sync, branch: opts.branch };
  if (sync.mode === 'git' && gi && !opts.branch) sync = { ...sync, branch: gi.branch, remote: sync.remote ?? gi.remote };
  if (sync.mode === 'git' && !gi) actions.push(`warning: sync mode git but ${texRoot} is not a git clone; pull/push will fail until it is one`);

  const base = existing ?? defaultProjectConfig(paths);
  const config = ProjectConfig.parse({
    ...base,
    name: opts.name ?? existing?.name ?? (basename(root) || 'paper'),
    texRoot,
    mainFile: main,
    repoDir: repo,
    skillDir: skill,
    bibFiles: existing && !opts.main ? (existing.bibFiles.filter((b) => existsSync(join(texRoot, b))).length ? existing.bibFiles : detectBibFiles(texRoot, main)) : detectBibFiles(texRoot, main),
    venue: opts.venue ?? base.venue,
    notesLanguage: opts.notes ?? base.notesLanguage,
    sync,
  });

  await ensureLayout(paths);
  actions.push(...(await ensureHygiene(paths, config)));
  const semantic: SemanticResult[] = [];
  if (opts.semanticLines) {
    for (const f of listFiles(texRoot, isTexName)) {
      try {
        const r = await applySemanticLines(paths, f);
        semantic.push(r);
      } catch (e) {
        actions.push(`warning: semantic line breaks skipped for ${f}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    config.semanticLines = true;
    const n = semantic.reduce((a, r) => a + r.changed, 0);
    actions.push(`one sentence per line: ${n} line break(s) in ${semantic.filter((r) => r.changed).length} file(s); undo with \`paper semantic-lines ${root} --undo\``);
  }
  await saveConfig(paths, config);
  actions.unshift(`${existing ? 'updated' : 'created'} ${paths.config}`);
  return { root, paths, config, created: !existing, actions, semantic };
}
