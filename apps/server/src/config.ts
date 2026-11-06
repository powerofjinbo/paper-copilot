/** Project configuration (.paper/project.json): defaults, load, save. */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DEFAULT_MODEL_ROUTES, ProjectConfig } from '@paper-copilot/core';
import type { PaperPaths } from './contracts';
import { writeFileAtomic } from './infra';

/** Where the hep-paper-writing skill is looked for, in order. */
export function skillDirCandidates(): string[] {
  const out: string[] = [];
  if (process.env.PAPER_SKILL_DIR) out.push(process.env.PAPER_SKILL_DIR);
  out.push(join(homedir(), '.claude', 'skills', 'hep-paper-writing'));
  out.push(join(new URL('../../..', import.meta.url).pathname, '.skill'));
  return out;
}

export function findSkillDir(): string {
  for (const d of skillDirCandidates()) if (existsSync(join(d, 'SKILL.md'))) return d;
  return skillDirCandidates()[1] ?? '';
}

export function defaultProjectConfig(paths: PaperPaths, overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  const base: ProjectConfig = {
    schemaVersion: 1,
    name: basename(paths.root),
    texRoot: paths.tex,
    mainFile: 'main.tex',
    repoDir: null,
    skillDir: findSkillDir(),
    bibFiles: [],
    venue: 'aps',
    notesLanguage: 'zh',
    factGlobs: ['results/**/*.json', 'results/**/*.csv', 'docs/definitions.md'],
    readerGlobs: ['README.md', 'docs/**/*.md', 'results/**/*.{json,csv,md}', 'configs/**/*.{yaml,yml,json}', 'figures/**/*'],
    models: { ...DEFAULT_MODEL_ROUTES },
    sync: { mode: 'none', remote: null, branch: 'master' },
    maxBudgetUsd: 5,
    semanticLines: false,
  };
  return ProjectConfig.parse({ ...base, ...overrides });
}

export function loadConfig(paths: PaperPaths): ProjectConfig | null {
  if (!existsSync(paths.config)) return null;
  const parsed = ProjectConfig.safeParse(JSON.parse(readFileSync(paths.config, 'utf8')));
  if (!parsed.success) throw new Error(`invalid ${paths.config}: ${parsed.error.message}`);
  return parsed.data;
}

export async function saveConfig(paths: PaperPaths, config: ProjectConfig): Promise<void> {
  await writeFileAtomic(paths.config, JSON.stringify(ProjectConfig.parse(config), null, 2) + '\n');
}

/**
 * A remote URL with its credentials hidden: `https://git:olp_xxx@host/...` -> `https://git:***@host/...`,
 * `https://ghp_xxx@host/...` -> `https://***@host/...` (a lone user part may itself be a token; only
 * the conventional `git` user is shown). Anything without `scheme://userinfo@` is returned unchanged.
 */
export function maskRemoteUrl(url: string): string;
export function maskRemoteUrl(url: string | null): string | null;
export function maskRemoteUrl(url: string | null): string | null {
  if (url === null) return null;
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^@/?#]*)@/i, (_m, scheme: string, cred: string) => {
    const i = cred.indexOf(':');
    const user = i >= 0 ? cred.slice(0, i) : cred;
    if (i >= 0) return `${scheme}${user === 'git' ? user : '***'}:***@`;
    return `${scheme}${user === 'git' ? user : '***'}@`;
  });
}

/** The project config as it may leave the server (browser, WebSocket): no credentials in sync.remote. */
export function publicConfig(config: ProjectConfig): ProjectConfig {
  if (!config.sync?.remote) return config;
  const remote = maskRemoteUrl(config.sync.remote);
  return remote === config.sync.remote ? config : { ...config, sync: { ...config.sync, remote } };
}
