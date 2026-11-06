/**
 * Skill discovery for Agent SDK sessions: `.paper/claude/.claude/skills/hep-paper-writing` must be a
 * symlink to the author's skill checkout (docs/design.md, "Skill and voice system", Loading).
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readlink, rename, symlink, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SKILL_NAME } from './options';

export interface SkillLinkResult {
  link: string;
  target: string;
  /** What was done: nothing, created, repaired a wrong/dangling link, or moved a non-link aside. */
  action: 'ok' | 'created' | 'repaired' | 'replaced-directory';
  /** True when the target holds a SKILL.md. */
  skillFound: boolean;
}

export function skillLinkPath(claudeCwd: string): string {
  return join(claudeCwd, '.claude', 'skills', SKILL_NAME);
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Create or repair the symlink. A wrong or dangling link is replaced; a real directory or file in its
 * place is moved aside (never deleted) as `<name>.bak-<timestamp>`.
 */
export async function ensureSkillLink(claudeCwd: string, skillDir: string): Promise<SkillLinkResult> {
  const target = resolve(skillDir);
  const link = skillLinkPath(claudeCwd);
  const skillFound = existsSync(join(target, 'SKILL.md'));
  await mkdir(join(claudeCwd, '.claude', 'skills'), { recursive: true });
  const type = process.platform === 'win32' ? 'junction' : 'dir';

  let st: ReturnType<typeof lstatSync> | null = null;
  try {
    st = lstatSync(link);
  } catch {
    st = null;
  }
  if (st === null) {
    await symlink(target, link, type);
    return { link, target, action: 'created', skillFound };
  }
  if (st.isSymbolicLink()) {
    const current = await readlink(link);
    const pointsAtTarget = resolve(join(link, '..'), current) === target || (existsSync(link) && realOr(link) === realOr(target));
    if (pointsAtTarget) return { link, target, action: 'ok', skillFound };
    await unlink(link);
    await symlink(target, link, type);
    return { link, target, action: 'repaired', skillFound };
  }
  const aside = `${link}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await rename(link, aside);
  await symlink(target, link, type);
  return { link, target, action: 'replaced-directory', skillFound };
}

const refCache = new Map<string, { stamp: string; refs: Record<string, string> }>();

/** The skill's reference files (references/*.md) by file name; {} when the skill is missing. Cached by mtime. */
export function readSkillReferences(skillDir: string): Record<string, string> {
  const dir = join(skillDir, 'references');
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
  } catch {
    return {};
  }
  const stamp = names.map((n) => `${n}:${statSync(join(dir, n)).mtimeMs}`).join('|');
  const hit = refCache.get(dir);
  if (hit && hit.stamp === stamp) return hit.refs;
  const refs: Record<string, string> = {};
  for (const n of names) refs[n] = readFileSync(join(dir, n), 'utf8');
  refCache.set(dir, { stamp, refs });
  return refs;
}

/**
 * Claude Code configuration that may sit in the agents' own folder (.paper/claude), which the CLI reads
 * because `settingSources: ['project']` is needed for skill discovery. A settings file there could set
 * `env` (ANTHROPIC_BASE_URL: the app's key would go to another host), an `apiKeyHelper` (a second
 * credential), permissions or hooks; a CLAUDE.md or an .mcp.json would add instructions or tools. The
 * folder belongs to the app and holds only `.claude/skills`, so anything else is moved aside (never
 * deleted) into `quarantine-<timestamp>/` before every real run.
 */
const CWD_CONFIG = ['CLAUDE.md', 'CLAUDE.local.md', '.mcp.json'];

export async function quarantineClaudeConfig(claudeCwd: string): Promise<{ moved: string[]; to: string | null }> {
  const candidates: string[] = [];
  for (const n of CWD_CONFIG) if (existsSync(join(claudeCwd, n))) candidates.push(n);
  const dot = join(claudeCwd, '.claude');
  let names: string[] = [];
  try {
    names = readdirSync(dot);
  } catch {
    names = [];
  }
  for (const n of names) if (n !== 'skills') candidates.push(join('.claude', n));
  if (candidates.length === 0) return { moved: [], to: null };
  const to = join(claudeCwd, `quarantine-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  for (const rel of candidates) {
    const dest = join(to, rel);
    await mkdir(join(dest, '..'), { recursive: true });
    await rename(join(claudeCwd, rel), dest);
  }
  return { moved: candidates, to };
}
