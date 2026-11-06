/**
 * The author's hep-paper-writing skill as prompt material (block A of every direct-API request).
 *
 * Loads SKILL.md and references/*.md from ctx.config.skillDir. The bundle is reloaded when any of those
 * files (or the set of reference files) changes, detected by an mtime/size stamp that is checked at most
 * every `checkIntervalMs`. `version` is the sha256 of the contents (file names and texts in a fixed
 * order), so the same skill gives the same version on every machine and every edit changes it.
 *
 * The fictional numbers of the skill's invented Before/After examples (core extractFictionalNumbers) are
 * computed once per version: the gate blocks them in AI output unless they are also real fact values.
 * SKILL.md is included in that scan as well as the references, since it carries examples too.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { extractFictionalNumbers, type SkillBundle } from '@paper-copilot/core';
import type { Logger } from '../../contracts';

export interface SkillLoader {
  /** The current bundle, or null when the directory has no SKILL.md. */
  get(): SkillBundle | null;
  /** Fictional example numbers of the current bundle ([] without a skill). */
  fictionalNumbers(): string[];
  /** Force a re-read on the next get(). */
  invalidate(): void;
}

function statStamp(path: string): string | null {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

function referenceNames(dir: string): string[] {
  try {
    return readdirSync(join(dir, 'references'))
      .filter((n) => n.endsWith('.md'))
      .sort();
  } catch {
    return [];
  }
}

/** Stamp of the skill directory: SKILL.md + every reference file (name, mtime, size). */
export function skillStamp(dir: string): string | null {
  const main = statStamp(join(dir, 'SKILL.md'));
  if (main === null) return null;
  const parts = [`SKILL.md=${main}`];
  for (const n of referenceNames(dir)) parts.push(`${n}=${statStamp(join(dir, 'references', n)) ?? 'gone'}`);
  return parts.join('|');
}

/** Read a bundle from disk; null without SKILL.md. */
export function readSkillBundle(dir: string): SkillBundle | null {
  let skillMd: string;
  try {
    skillMd = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
  const references: Record<string, string> = {};
  const h = createHash('sha256');
  h.update('SKILL.md\0').update(skillMd).update('\0');
  for (const n of referenceNames(dir)) {
    try {
      const text = readFileSync(join(dir, 'references', n), 'utf8');
      references[n] = text;
      h.update(`references/${n}\0`).update(text).update('\0');
    } catch {
      /* vanished between readdir and read: skip */
    }
  }
  return { dir, skillMd, references, version: h.digest('hex') };
}

export function createSkillLoader(getDir: () => string, opts: { log?: Logger; checkIntervalMs?: number; now?: () => number } = {}): SkillLoader {
  const interval = Math.max(0, opts.checkIntervalMs ?? 500);
  const now = opts.now ?? (() => Date.now());
  let bundle: SkillBundle | null = null;
  let loadedDir: string | null = null;
  let stamp: string | null = null;
  let checkedAt = -Infinity;
  let fictional: { version: string; numbers: string[] } | null = null;
  let warnedMissing = false;

  const refresh = () => {
    const dir = getDir();
    const t = now();
    if (dir === loadedDir && t - checkedAt < interval) return;
    checkedAt = t;
    const s = dir ? skillStamp(dir) : null;
    if (dir === loadedDir && s === stamp) return;
    loadedDir = dir;
    stamp = s;
    bundle = s === null ? null : readSkillBundle(dir);
    if (!bundle) {
      if (!warnedMissing) opts.log?.warn(`hep-paper-writing skill not found at ${dir || '(unset)'}; prompts run without it`);
      warnedMissing = true;
    } else {
      warnedMissing = false;
      opts.log?.info(`skill loaded (${Object.keys(bundle.references).length} references, version ${bundle.version.slice(0, 12)})`);
    }
  };

  return {
    get() {
      refresh();
      return bundle;
    },
    fictionalNumbers() {
      refresh();
      if (!bundle) return [];
      if (fictional?.version !== bundle.version) {
        let numbers: string[] = [];
        try {
          numbers = extractFictionalNumbers({ 'SKILL.md': bundle.skillMd, ...bundle.references });
        } catch (e) {
          opts.log?.warn('cannot extract fictional numbers from the skill', String(e));
          // Do not cache a failure: the next request tries again.
          return [];
        }
        fictional = { version: bundle.version, numbers: [...new Set(numbers)].sort() };
      }
      return fictional.numbers;
    },
    invalidate() {
      checkedAt = -Infinity;
      stamp = null;
      loadedDir = null;
    },
  };
}
