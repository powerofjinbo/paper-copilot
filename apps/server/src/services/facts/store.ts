/**
 * `.paper/facts.json`: the fact store of FactService (private format; other services use FactService).
 *
 * {
 *   schemaVersion: 1,
 *   scannedAt, repoDir, globs,
 *   stems:      { "<artifact>": "<stem>" }       pinned artifact stems (id stability)
 *   facts:      [BaseFact]                       facts as extracted / registered / typed, before patches
 *   patches:    { "<id>": StoredPatch }          the author's edits (never dropped by a rescan)
 *   status:     { "<id>": StoredStatus }         stale / missing bookkeeping
 *   candidates: [StoredCandidate]                repo-reader candidates, re-read on every rescan
 * }
 *
 * Loading is tolerant: an unparsable file is moved aside (facts.json.corrupt-<time>) and the store
 * starts empty; entries that fail validation are dropped one by one, so one bad row never loses the
 * author's patches.
 */
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { FactKind } from '@paper-copilot/core';
import { z } from 'zod';

export const FactOrigin = z.enum(['extractor', 'candidate', 'manual']);
export type FactOrigin = z.infer<typeof FactOrigin>;

export const BaseFact = z.object({
  id: z.string(),
  kind: FactKind,
  value: z.union([z.number(), z.string()]),
  unit: z.string(),
  uncertainties: z.record(z.string(), z.number()),
  definition: z.string(),
  definitionSource: z.string(),
  artifact: z.string(),
  locator: z.string(),
  artifactSha256: z.string(),
  fingerprint: z.string(),
  tags: z.array(z.string()),
  proseOnly: z.boolean(),
  origin: FactOrigin,
});
export type BaseFact = z.infer<typeof BaseFact>;

export const StoredPatch = z.object({
  confirmed: z.boolean().optional(),
  excluded: z.boolean().optional(),
  definition: z.string().optional(),
  unit: z.string().optional(),
  sigfigs: z.number().int().nullable().optional(),
  tags: z.array(z.string()).optional(),
  ts: z.string(),
});
export type StoredPatch = z.infer<typeof StoredPatch>;

export const StoredStatus = z.object({
  /** The value changed since the author last confirmed it (sticky until confirmed again). */
  stale: z.boolean(),
  /** The locator no longer resolves (artifact deleted, unreadable, or the field is gone). */
  missing: z.boolean(),
  firstSeen: z.string(),
  changedAt: z.string().nullable(),
  previousValue: z.union([z.number(), z.string()]).nullable(),
});
export type StoredStatus = z.infer<typeof StoredStatus>;

export const StoredCandidate = z.object({
  id: z.string(),
  artifact: z.string(),
  locator: z.string(),
  kind: FactKind,
  proposedId: z.string(),
  /** The repo reader's own wording; kept for traceability, never used as the definition. */
  paraphrase: z.string(),
  condition: z.string(),
  addedAt: z.string(),
});
export type StoredCandidate = z.infer<typeof StoredCandidate>;

export interface FactsFileData {
  schemaVersion: 1;
  scannedAt: string | null;
  repoDir: string | null;
  globs: string[];
  stems: Record<string, string>;
  facts: BaseFact[];
  patches: Record<string, StoredPatch>;
  status: Record<string, StoredStatus>;
  candidates: StoredCandidate[];
}

/**
 * Serialise facts.json with one fact / patch / status entry per line: compact (no indentation; a
 * 50k-fact store stays a fraction of the pretty-printed size) and still diff-friendly in git.
 */
export function serializeFactsFile(d: FactsFileData): string {
  const record = (o: Record<string, unknown>) => {
    const keys = Object.keys(o);
    if (keys.length === 0) return '{}';
    return '{\n' + keys.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(o[k])}`).join(',\n') + '\n }';
  };
  const list = (xs: unknown[]) => (xs.length === 0 ? '[]' : '[\n' + xs.map((x) => '  ' + JSON.stringify(x)).join(',\n') + '\n ]');
  return (
    '{\n' +
    [
      ` "schemaVersion": 1`,
      ` "scannedAt": ${JSON.stringify(d.scannedAt)}`,
      ` "repoDir": ${JSON.stringify(d.repoDir)}`,
      ` "globs": ${JSON.stringify(d.globs)}`,
      ` "stems": ${record(d.stems)}`,
      ` "patches": ${record(d.patches)}`,
      ` "status": ${record(d.status)}`,
      ` "candidates": ${list(d.candidates)}`,
      ` "facts": ${list(d.facts)}`,
    ].join(',\n') +
    '\n}\n'
  );
}

export function emptyFactsFile(): FactsFileData {
  return { schemaVersion: 1, scannedAt: null, repoDir: null, globs: [], stems: {}, facts: [], patches: {}, status: {}, candidates: [] };
}

interface Warn {
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

function salvageArray<T>(raw: unknown, schema: z.ZodType<T>, what: string, log: Warn): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  let bad = 0;
  for (const x of raw) {
    const p = schema.safeParse(x);
    if (p.success) out.push(p.data);
    else bad++;
  }
  if (bad) log.warn(`facts.json: dropped ${bad} invalid ${what}`);
  return out;
}

function salvageRecord<T>(raw: unknown, schema: z.ZodType<T>, what: string, log: Warn): Record<string, T> {
  const out: Record<string, T> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let bad = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const p = schema.safeParse(v);
    if (p.success) out[k] = p.data;
    else bad++;
  }
  if (bad) log.warn(`facts.json: dropped ${bad} invalid ${what}`);
  return out;
}

export function loadFactsFile(path: string, log: Warn): FactsFileData {
  if (!existsSync(path)) return emptyFactsFile();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    const aside = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      renameSync(path, aside);
      log.error(`facts.json is not valid JSON; moved it to ${aside} and started an empty fact store`, String(e));
    } catch (e2) {
      log.error('facts.json is not valid JSON and could not be moved aside', String(e2));
    }
    return emptyFactsFile();
  }
  if (!raw || typeof raw !== 'object') return emptyFactsFile();
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== 1) log.warn(`facts.json: unknown schemaVersion ${String(o.schemaVersion)}; reading what is compatible`);
  const stems: Record<string, string> = {};
  if (o.stems && typeof o.stems === 'object') for (const [k, v] of Object.entries(o.stems as Record<string, unknown>)) if (typeof v === 'string') stems[k] = v;
  return {
    schemaVersion: 1,
    scannedAt: typeof o.scannedAt === 'string' ? o.scannedAt : null,
    repoDir: typeof o.repoDir === 'string' ? o.repoDir : null,
    globs: Array.isArray(o.globs) ? o.globs.filter((g): g is string => typeof g === 'string') : [],
    stems,
    facts: salvageArray(o.facts, BaseFact, 'facts', log),
    patches: salvageRecord(o.patches, StoredPatch, 'patches', log),
    status: salvageRecord(o.status, StoredStatus, 'status entries', log),
    candidates: salvageArray(o.candidates, StoredCandidate, 'candidates', log),
  };
}
