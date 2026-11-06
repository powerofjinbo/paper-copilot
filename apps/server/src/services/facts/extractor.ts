/**
 * Deterministic fact extractor (Node, no model). Values are read by code, definitions are built from
 * artifact metadata only, and every fact carries the artifact path, a locator and the artifact's
 * SHA-256.
 *
 * Artifacts (selected with config.factGlobs, see ./glob.ts):
 * - JSON: every finite numeric leaf -> a fact, locator = JSON pointer (`#/delta_points`,
 *   `#/models/canto_l_ttbar/0/cut_e`; RFC 6901 escaping, no percent-encoding; a file holding one
 *   number has locator `#`). Python's `NaN` / `Infinity` tokens are accepted (they give no fact).
 *   Numeric arrays longer than `maxArrayLength` (default 64) are skipped as data (event lists,
 *   histograms), with a log line. Strings, booleans and nulls are metadata, never facts.
 * - CSV/TSV: every numeric cell of a numeric column -> a fact, locator `csv:row=N;col=NAME`
 *   (N = 1-based data row, header excluded, blank lines skipped). A column is numeric when every
 *   non-empty cell is a decimal number (nan/inf/NA count as empty).
 * - Markdown (definitions style): cut / setting / definition facts, locator `md:line=N` (./markdown.ts).
 *
 * Ids: `f.<stem>.<path>`; deterministic, readable, unique.
 * - `<stem>` is a short name for the artifact: the file name split on non-alphanumerics, without
 *   version tokens (`v1`), generic words (claim, addendum, result(s), summary, output(s), final, data)
 *   and single letters shadowed by the next token (`g` before `g1`):
 *   `results/addendum_g_g1_v1_claim.json` -> `g1`. When two artifacts share a stem, the
 *   highest-priority one (claim JSON > JSON > CSV > markdown, then path order) keeps it and the others
 *   get, in this order, the extension (`g1csv`), their version (`ranking_val_v2`), their directory,
 *   the full file stem, a number. Stems are pinned in facts.json once assigned, so adding files never
 *   renames existing facts.
 * - JSON `<path>`: pointer tokens joined with `.` (`delta_points`, `eff_A_seeds.0`).
 * - CSV `<path>`: `<row label>.<column>`, the row label being the values of the shortest leading run
 *   (header order) of label columns (short string columns) that makes rows unique
 *   (`generic_iso.P_G.canto_l_ttbar.mean`); rows still not unique get `.r<N>`; no label columns -> `r<N>`.
 * - Greek letters are spelled out (η -> eta); other characters outside [A-Za-z0-9_-] become `_`; a
 *   remaining collision gets `~2`, `~3`. Ids of manual facts are never reused by the scanner.
 *
 * Uncertainty pairing (numeric fields of one JSON object, or numeric columns of one CSV, in order):
 * - uncertainty names: prefix form `sigma*`, `err*`, `unc*` (e.g. sigma_points, sigma_boot_points,
 *   err_eff), suffix form `*_sigma`, `*_err`, `*_error`, `*_unc`, `*_sd`, `*_std` (ceiling_sigma,
 *   seed_sd), and `s_seeds`. Tokens boot/seed(s)/stat/syst/tot(al)/... are qualifiers and name the
 *   uncertainty (`boot`, `seeds`; none -> `total`). `n_sigma`, `nsig`, `delta_minus_2sigma` are not
 *   uncertainties.
 * - suffix form `<base>_sigma` pairs with the field named exactly `<base>`;
 * - prefix form with a remainder (`sigma_points` -> `points`) pairs with the only value field whose
 *   name ends with that remainder, or, when several do, with the value field right before it
 *   (only other uncertainty fields in between): sigma_points -> delta_points, not fake_rate_diff_points;
 * - prefix form without remainder (`sigma_boot`, `s_seeds`, `sigma`, `seed_sd`) pairs with the value
 *   field right before it (only other uncertainty fields in between): CSV mean + sigma_boot/s_seeds/sigma.
 * - Anything else stays unpaired and is an ordinary fact; a paired uncertainty is not a fact of its own
 *   (it is in the value's `uncertainties`, as stored, same scale). Objects or tables with more than
 *   MAX_PAIRING_FIELDS (1,000) numeric fields are not paired.
 *
 * Units come from field names only (`*_points` -> points, `*_pct` -> %, `*_gev` -> GeV, `*_mm` -> mm,
 * ...); fractions are kept as stored with unit '' and tag `fraction` when 0 <= v <= 1 and the name says
 * eff/rate/frac/acc. Other tags: `count` (integer n-like fields), `claim` (artifacts named *claim*).
 *
 * Caps: at most `maxFactsPerArtifact` (5,000) facts per artifact and `maxFactsTotal` (50,000) in all;
 * `keepIds` (facts the author patched or a sentence links) are always kept. The total cap is a budget spent claim JSON first, then
 * artifacts with fewer (estimated) facts first (summary tables before per-particle dumps); files after
 * it is spent are not parsed. Every drop is logged.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { hashString, type FactKind } from '@paper-copilot/core';
import { parseCsv, parseNumberCell, isMissingCell, isBooleanCell, type CsvTable } from './csv';
import { listMatchingFiles } from './glob';
import { parseDefinitionsMarkdown, plainMdLine, transliterate } from './markdown';

export const DEFAULT_MAX_FACTS_PER_ARTIFACT = 5000;
export const DEFAULT_MAX_FACTS_TOTAL = 50000;
export const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_ARRAY_LENGTH = 64;

export interface RawFact {
  id: string;
  kind: FactKind;
  value: number | string;
  unit: string;
  uncertainties: Record<string, number>;
  definition: string;
  definitionSource: string;
  artifact: string;
  locator: string;
  artifactSha256: string;
  fingerprint: string;
  tags: string[];
  proseOnly: boolean;
}

export interface ExtractLogger {
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  debug(msg: string, data?: unknown): void;
}

export interface ExtractOptions {
  maxFactsPerArtifact?: number;
  maxFactsTotal?: number;
  maxFileBytes?: number;
  maxArrayLength?: number;
  /** Ids that survive the caps (facts the author patched). */
  keepIds?: ReadonlySet<string>;
  /** Artifacts that hold keepIds (read even after the total budget is spent). */
  keepArtifacts?: ReadonlySet<string>;
  /** Ids owned by manual / candidate facts; the extractor never assigns them (it adds a suffix). */
  reservedIds?: ReadonlySet<string>;
  /** Pinned stems: artifact path -> stem (from facts.json). */
  stems?: Record<string, string>;
  log?: ExtractLogger;
  /** Yield to the event loop when a scan has run this long without yielding (ms). Default 25. */
  yieldEveryMs?: number;
}

export type ArtifactStatus = 'ok' | 'unreadable' | 'too_large' | 'unsupported';

export interface ArtifactResult {
  artifact: string;
  sha256: string;
  status: ArtifactStatus;
  error: string | null;
  facts: RawFact[];
  /** Facts not kept because of the per-artifact cap (counted, not built). */
  droppedByCap: number;
  /** Numeric arrays skipped because they are longer than maxArrayLength. */
  skippedArrays: number;
}

export interface ExtractResult {
  facts: RawFact[];
  artifacts: ArtifactResult[];
  stems: Record<string, string>;
  /** Facts dropped at the total cap inside artifacts that were read. */
  droppedByTotalCap: number;
  /** Artifacts not read at all because the total cap was spent. */
  skippedForBudget: string[];
  /** Artifacts that lost facts to a cap (per-artifact or total), including skipped ones. */
  cappedArtifacts: string[];
  truncatedWalk: boolean;
  ms: number;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function fingerprintOf(sha: string, locator: string, value: number | string): string {
  return hashString(sha + '|' + locator + '|' + String(value));
}

/* ------------------------------------------------------------------------------------ */
/* Names                                                                                  */
/* ------------------------------------------------------------------------------------ */

/** One id segment: ASCII letters, digits, '_' and '-'; anything else becomes '_'. */
export function idSegment(s: string): string {
  const out = transliterate(s)
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return out || '_';
}

/** Lower-case tokens of a field name: split on non-alphanumerics and camelCase boundaries. */
export function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

const UNIT_TOKENS: Record<string, string> = {
  points: 'points',
  pts: 'points',
  pp: 'points',
  pct: '%',
  percent: '%',
  perc: '%',
  gev: 'GeV',
  mev: 'MeV',
  tev: 'TeV',
  kev: 'keV',
  mm: 'mm',
  cm: 'cm',
  um: 'μm',
  micron: 'μm',
  microns: 'μm',
  nm: 'nm',
  ns: 'ns',
  ps: 'ps',
  fs: 'fs',
  mrad: 'mrad',
  rad: 'rad',
  deg: 'deg',
  degrees: 'deg',
};
const TIME_TOKENS = new Set(['time', 'elapsed', 'duration', 'runtime', 'latency', 'wall', 'cpu', 'ttft']);
const UNIT_TRAILERS = new Set(['min', 'max', 'lo', 'hi', 'low', 'high', 'cut', 'up', 'down', 'mean', 'median']);

/** Unit as written in prose, inferred from the field name only ('' when the name says nothing). */
export function unitFromName(name: string): string {
  const t = nameTokens(name);
  if (t.length === 0) return '';
  const pick = (tok: string | undefined): string | null => {
    if (!tok) return null;
    if (UNIT_TOKENS[tok]) return UNIT_TOKENS[tok]!;
    if ((tok === 's' || tok === 'sec' || tok === 'seconds' || tok === 'ms') && t.some((x) => TIME_TOKENS.has(x))) return tok === 'ms' ? 'ms' : 's';
    return null;
  };
  const last = t[t.length - 1];
  const u = pick(last);
  if (u) return u;
  if (last && UNIT_TRAILERS.has(last) && t.length >= 2) return pick(t[t.length - 2]) ?? '';
  return '';
}

export function isFractionName(name: string): boolean {
  return nameTokens(name).some((x) => x.startsWith('eff') || x.startsWith('rate') || x.endsWith('rate') || x.startsWith('frac') || x.startsWith('acc'));
}

export function isNLike(name: string): boolean {
  const l = name.toLowerCase();
  return /^(?:n|num|count|counts|nevents|ntargets)$/.test(l) || /^n_/.test(l) || /_n$/.test(l) || /(?:^|_)count$/.test(l) || /^num_/.test(l);
}

function kindFromName(name: string): FactKind {
  const t = nameTokens(name);
  return t.some((x) => x === 'cut' || x === 'threshold' || x === 'thresh' || x === 'thr') ? 'cut' : 'number';
}

function tagsFor(name: string, value: number, artifact: string): string[] {
  const tags: string[] = [];
  if (value >= 0 && value <= 1 && isFractionName(name)) tags.push('fraction');
  if (Number.isInteger(value) && isNLike(name)) tags.push('count');
  if (/claim/i.test(basename(artifact))) tags.push('claim');
  return tags;
}

/* ------------------------------------------------------------------------------------ */
/* Uncertainty pairing                                                                    */
/* ------------------------------------------------------------------------------------ */

const UNC_PREFIX = new Set(['sigma', 'sigmas', 'err', 'errs', 'error', 'errors', 'unc', 'uncs', 'uncert', 'uncertainty', 'uncertainties']);
const UNC_SUFFIX = new Set(['sigma', 'err', 'error', 'unc', 'uncert', 'uncertainty', 'sd', 'std', 'stddev', 'stderr', 'se']);
const QUALIFIERS = new Set([
  'boot',
  'bootstrap',
  'seed',
  'seeds',
  'stat',
  'stats',
  'syst',
  'sys',
  'systematic',
  'statistical',
  'tot',
  'total',
  'mc',
  'up',
  'down',
  'hi',
  'lo',
  'plus',
  'minus',
  'sym',
  'comb',
  'combined',
  'binomial',
  'poisson',
  'cp',
  'paired',
  'unpaired',
]);

interface UncInfo {
  form: 'prefix' | 'suffix';
  qualifiers: string[];
  /** prefix form: value-name suffix tokens to look for (may be empty). */
  remainder: string[];
  /** suffix form: tokens of the value name. */
  base: string[];
}

export function classifyUncertainty(name: string): UncInfo | null {
  const t = nameTokens(name);
  if (t.length === 0) return null;
  if (name === 's_seeds' || (t.length === 2 && t[0] === 's' && t[1] === 'seeds')) return { form: 'prefix', qualifiers: ['seeds'], remainder: [], base: [] };
  if (UNC_PREFIX.has(t[0]!)) {
    const rest = t.slice(1);
    const qualifiers: string[] = [];
    const remainder: string[] = [];
    for (const x of rest) (QUALIFIERS.has(x) && remainder.length === 0 ? qualifiers : remainder).push(x);
    // Trailing qualifiers after the remainder (sigma_points_boot) also count.
    while (remainder.length && QUALIFIERS.has(remainder[remainder.length - 1]!)) qualifiers.push(remainder.pop()!);
    return { form: 'prefix', qualifiers, remainder, base: [] };
  }
  const last = t[t.length - 1]!;
  if (t.length >= 2 && UNC_SUFFIX.has(last)) {
    const base = t.slice(0, -1);
    if (base.length === 1 && (base[0] === 'n' || base[0] === 'num' || base[0] === 'nsig')) return null;
    const qualifiers: string[] = [];
    while (base.length && QUALIFIERS.has(base[base.length - 1]!)) qualifiers.unshift(base.pop()!);
    if (base.length === 0) return { form: 'prefix', qualifiers, remainder: [], base: [] };
    return { form: 'suffix', qualifiers, remainder: [], base };
  }
  return null;
}

function endsWithTokens(name: string, suffix: string[]): boolean {
  const t = nameTokens(name);
  if (suffix.length === 0 || t.length < suffix.length) return false;
  for (let i = 0; i < suffix.length; i++) if (t[t.length - suffix.length + i] !== suffix[i]) return false;
  return true;
}

function sameTokens(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Pair uncertainty fields with value fields. `names` are the numeric scalar fields in order.
 * Returns uncertainty field -> { value field, label }.
 */
/** Objects / tables with more numeric fields than this are not paired (keeps the scan linear). */
export const MAX_PAIRING_FIELDS = 1000;

export function pairUncertainties(names: string[]): Map<string, { value: string; label: string }> {
  if (names.length > MAX_PAIRING_FIELDS) return new Map();
  const info = names.map((n) => ({ name: n, unc: classifyUncertainty(n) }));
  const values = info.filter((x) => !x.unc).map((x) => x.name);
  const out = new Map<string, { value: string; label: string }>();
  const labels = new Map<string, Set<string>>();
  for (let i = 0; i < info.length; i++) {
    const u = info[i]!.unc;
    if (!u) continue;
    let j = i - 1;
    while (j >= 0 && info[j]!.unc) j--;
    const adjacent = j >= 0 ? info[j]!.name : null;
    let target: string | null = null;
    if (u.form === 'suffix') {
      const c = values.filter((v) => sameTokens(nameTokens(v), u.base));
      if (c.length === 1) target = c[0]!;
    } else if (u.remainder.length > 0) {
      const c = values.filter((v) => endsWithTokens(v, u.remainder));
      if (c.length === 1) target = c[0]!;
      else if (c.length > 1 && adjacent && c.includes(adjacent)) target = adjacent;
    } else if (adjacent) {
      target = adjacent;
    }
    if (!target) continue;
    const label = u.qualifiers.length ? u.qualifiers.join('_') : 'total';
    const used = labels.get(target) ?? new Set<string>();
    if (used.has(label)) continue;
    used.add(label);
    labels.set(target, used);
    out.set(info[i]!.name, { value: target, label });
  }
  return out;
}

/* ------------------------------------------------------------------------------------ */
/* Metadata for definitions                                                               */
/* ------------------------------------------------------------------------------------ */

const META_KEY_DENY =
  /^(?:git|host|hostname|user|slurm_job|job|job_id|jobid|pid|cmd|command|log|path|file|filename|dir|root|run|runs|url|uri|sha|sha1|sha256|md5|hash|checksum|created|created_utc|started|started_utc|finished|finished_utc|timestamp|time|date|ckpt|checkpoint|version)$/i;
const META_KEY_DENY_SUFFIX = /(?:_path|_dir|_file|_sha256|_sha|_md5|_hash|_utc|_ckpt|_url|_log|_time|_date)$/i;

export function isMetaString(key: string, value: string): boolean {
  const v = value.trim();
  if (!v || v.length > 80) return false;
  if (META_KEY_DENY.test(key) || META_KEY_DENY_SUFFIX.test(key)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return false;
  if (/^[0-9a-f]{12,}\b/i.test(v)) return false;
  if (/^\d{4}-\d{2}-\d{2}(?:$|[T ]\d{2}:)/.test(v)) return false;
  if (!/\s/.test(v)) {
    if (/^(?:\/|\.\/|\.\.\/|~\/)/.test(v)) return false;
    if (/\.[A-Za-z][A-Za-z0-9]{0,4}$/.test(v) && v.includes('/')) return false;
    if ((v.match(/\//g) ?? []).length >= 2 && /[A-Za-z]/.test(v)) return false;
  }
  return true;
}

interface MetaEntry {
  key: string;
  value: string;
  depth: number;
}

const MAX_META = 8;
const MAX_META_CHARS = 320;

function renderDefinition(subject: string, meta: MetaEntry[], selfKey: string | null, selfDepth: number): { definition: string; source: string } {
  const used: MetaEntry[] = [];
  const seen = new Set<string>();
  let chars = 0;
  for (const m of meta) {
    if (m.depth === selfDepth && m.key === selfKey) continue;
    if (seen.has(m.key)) continue;
    const piece = `${m.key}=${m.value}`;
    if (used.length >= MAX_META || chars + piece.length > MAX_META_CHARS) break;
    seen.add(m.key);
    used.push(m);
    chars += piece.length + 2;
  }
  if (used.length === 0) return { definition: subject, source: 'field name only' };
  return {
    definition: `${subject} (${used.map((m) => `${m.key}=${m.value}`).join('; ')})`,
    source: `metadata: ${used.map((m) => m.key).join(', ')}`,
  };
}

/* ------------------------------------------------------------------------------------ */
/* Per-artifact builders                                                                  */
/* ------------------------------------------------------------------------------------ */

interface BuildCtx {
  artifact: string;
  sha: string;
  stem: string;
  /** Maximum number of facts that are not in keepIds. */
  cap: number;
  keepIds: ReadonlySet<string> | null;
  reserved: ReadonlySet<string> | null;
  maxArrayLength: number;
  facts: RawFact[];
  /** Facts kept that are not in keepIds (what the cap counts). */
  counted: number;
  ids: Set<string>;
  dropped: number;
  skippedArrays: number;
}

function uniqueId(ctx: BuildCtx, base: string): string {
  const taken = (x: string) => ctx.ids.has(x) || (ctx.reserved !== null && ctx.reserved.has(x));
  if (!taken(base)) return base;
  let k = 2;
  while (taken(`${base}~${k}`)) k++;
  return `${base}~${k}`;
}

type FactBody = Omit<RawFact, 'artifact' | 'artifactSha256' | 'fingerprint' | 'id'>;

/**
 * Add a fact unless the per-artifact cap is reached (author-patched ids are always kept). The body is
 * built lazily, so cells over the cap are only counted.
 */
function addFact(ctx: BuildCtx, idBase: string, build: () => FactBody): void {
  const id = uniqueId(ctx, idBase);
  ctx.ids.add(id);
  const keep = ctx.keepIds !== null && ctx.keepIds.has(id);
  if (!keep) {
    if (ctx.counted >= ctx.cap) {
      ctx.dropped++;
      return;
    }
    ctx.counted++;
  }
  const f = build();
  ctx.facts.push({
    id,
    kind: f.kind,
    value: f.value,
    unit: f.unit,
    uncertainties: f.uncertainties,
    definition: f.definition,
    definitionSource: f.definitionSource,
    artifact: ctx.artifact,
    locator: f.locator,
    artifactSha256: ctx.sha,
    fingerprint: fingerprintOf(ctx.sha, f.locator, f.value),
    tags: f.tags,
    proseOnly: f.proseOnly,
  });
}

export function escapePointerToken(t: string): string {
  return t.replace(/~/g, '~0').replace(/\//g, '~1');
}

function humanPath(tokens: Array<string | number>): string {
  let out = '';
  for (const t of tokens) {
    if (typeof t === 'number') out += `[${t}]`;
    else out += out ? `.${t}` : t;
  }
  return out || '(root)';
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function objectMeta(obj: Record<string, unknown>, depth: number): MetaEntry[] {
  const strings: MetaEntry[] = [];
  const counts: MetaEntry[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && isMetaString(k, v)) strings.push({ key: k, value: v.trim(), depth });
    else if (isFiniteNumber(v) && Number.isInteger(v) && isNLike(k)) counts.push({ key: k, value: String(v), depth });
  }
  return [...strings, ...counts.slice(0, 3)];
}

function walkJson(ctx: BuildCtx, node: unknown, tokens: Array<string | number>, meta: MetaEntry[], depth: number): void {
  if (Array.isArray(node)) {
    if (node.length > ctx.maxArrayLength && node.every((x) => typeof x === 'number' || x === null)) {
      ctx.skippedArrays++;
      return;
    }
    const name = lastKey(tokens);
    for (let i = 0; i < node.length; i++) {
      const el = node[i];
      const tk = [...tokens, i];
      if (isFiniteNumber(el)) jsonLeaf(ctx, name, el, tk, meta, depth, {});
      else if (el && typeof el === 'object') walkJson(ctx, el, tk, meta, depth + 1);
    }
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const own = objectMeta(obj, depth);
  const merged = [...own, ...meta];
  const numericKeys = Object.keys(obj).filter((k) => isFiniteNumber(obj[k]));
  const pairs = pairUncertainties(numericKeys);
  const uncOf = new Map<string, Record<string, number>>();
  for (const [uName, p] of pairs) {
    const rec = uncOf.get(p.value) ?? {};
    rec[p.label] = obj[uName] as number;
    uncOf.set(p.value, rec);
  }
  for (const [k, v] of Object.entries(obj)) {
    if (isFiniteNumber(v)) {
      if (pairs.has(k)) continue;
      jsonLeaf(ctx, k, v, [...tokens, k], merged, depth, uncOf.get(k) ?? {});
    } else if (v && typeof v === 'object') {
      walkJson(ctx, v, [...tokens, k], merged, depth + 1);
    }
  }
}

function lastKey(tokens: Array<string | number>): string {
  for (let i = tokens.length - 1; i >= 0; i--) if (typeof tokens[i] === 'string') return tokens[i] as string;
  return 'value';
}

function jsonLeaf(ctx: BuildCtx, name: string, value: number, tokens: Array<string | number>, meta: MetaEntry[], depth: number, unc: Record<string, number>): void {
  const idBase = `f.${ctx.stem}.${tokens.map((t) => idSegment(String(t))).join('.')}`;
  addFact(ctx, idBase, () => {
    const locator = '#/' + tokens.map((t) => escapePointerToken(String(t))).join('/');
    const selfKey = typeof tokens[tokens.length - 1] === 'string' ? (tokens[tokens.length - 1] as string) : null;
    const def = renderDefinition(humanPath(tokens), meta, selfKey, depth);
    return {
      kind: kindFromName(name),
      value,
      unit: unitFromName(name),
      uncertainties: unc,
      definition: def.definition,
      definitionSource: def.source,
      locator,
      tags: tagsFor(name, value, ctx.artifact),
      proseOnly: false,
    };
  });
}

/* ------------------------------------------------------------------------------------ */
/* CSV                                                                                    */
/* ------------------------------------------------------------------------------------ */

export interface CsvModel {
  table: CsvTable;
  numericCols: number[];
  stringCols: number[];
  labelCols: number[];
  /** Row label (id segment path without the column), per data row. */
  rowLabels: string[];
  /** uncertainty column index -> { value column index, label } */
  pairs: Map<number, { value: number; label: string }>;
  /** Parsed numbers of numeric columns (NaN = empty/missing), indexed [col][row]. */
  numbers: Map<number, Float64Array>;
}

const LIST_LIKE = /^[\d.eE+-]+(?:;[\d.eE+-]+)+$/;

export function buildCsvModel(table: CsvTable): CsvModel {
  const { header, rows } = table;
  const numericCols: number[] = [];
  const stringCols: number[] = [];
  const boolCols = new Set<number>();
  const numbers = new Map<number, Float64Array>();
  for (let c = 0; c < header.length; c++) {
    let numeric = true;
    let anyValue = false;
    let allBool = true;
    const vals = new Float64Array(rows.length).fill(Number.NaN);
    for (let i = 0; i < rows.length; i++) {
      const cell = rows[i]![c] ?? '';
      if (isMissingCell(cell)) continue;
      anyValue = true;
      if (allBool && !isBooleanCell(cell)) allBool = false;
      if (numeric) {
        const v = parseNumberCell(cell);
        if (v === null) numeric = false;
        else vals[i] = v;
      }
      if (!numeric && !allBool) break;
    }
    if (!anyValue) continue;
    if (numeric) {
      numericCols.push(c);
      numbers.set(c, vals);
    } else {
      stringCols.push(c);
      if (allBool) boolCols.add(c);
    }
  }
  // Label columns: short, non-path, non-list strings (each distinct value checked once).
  const labelCols = stringCols.filter((c) => {
    if (boolCols.has(c)) return false;
    const checked = new Set<string>();
    for (const r of rows) {
      const v = (r[c] ?? '').trim();
      if (!v || checked.has(v)) continue;
      checked.add(v);
      if (v.length > 48 || !isMetaString(header[c]!, v) || LIST_LIKE.test(v) || /^\[.*\]$/.test(v)) return false;
    }
    return true;
  });
  // Shortest leading run of label columns that makes rows unique (keys built incrementally).
  const segCache = new Map<string, string>();
  const seg = (v: string) => {
    let out = segCache.get(v);
    if (out === undefined) {
      out = idSegment(v.trim() || '_');
      segCache.set(v, out);
    }
    return out;
  };
  let keys: string[] = rows.map(() => '');
  let chosen: number[] = [];
  for (let k = 0; k < labelCols.length; k++) {
    const c = labelCols[k]!;
    keys = keys.map((key, i) => (key ? `${key}.${seg(rows[i]![c] ?? '')}` : seg(rows[i]![c] ?? '')));
    chosen = labelCols.slice(0, k + 1);
    if (new Set(keys).size === rows.length) break;
  }
  const rowLabels = chosen.length ? keys : rows.map((_r, i) => `r${i + 1}`);
  if (chosen.length) {
    const count = new Map<string, number>();
    for (const l of rowLabels) count.set(l, (count.get(l) ?? 0) + 1);
    for (let i = 0; i < rowLabels.length; i++) if ((count.get(rowLabels[i]!) ?? 0) > 1) rowLabels[i] = `${rowLabels[i]}.r${i + 1}`;
  }
  const names = numericCols.map((c) => header[c]!);
  const byName = pairUncertainties(names);
  const pairs = new Map<number, { value: number; label: string }>();
  for (const [uName, p] of byName) pairs.set(header.indexOf(uName), { value: header.indexOf(p.value), label: p.label });
  return { table, numericCols, stringCols, labelCols: chosen, rowLabels, pairs, numbers };
}

export function csvLocator(row: number, col: string): string {
  const enc = /[;=%]/.test(col) ? col.replace(/[;=%]/g, (m) => encodeURIComponent(m)) : col;
  return `csv:row=${row};col=${enc}`;
}

function csvRowMeta(model: CsvModel, rowIdx: number): MetaEntry[] {
  const { header, rows } = model.table;
  const r = rows[rowIdx]!;
  const meta: MetaEntry[] = [];
  for (const c of model.stringCols) {
    const v = (r[c] ?? '').trim();
    if (v && isMetaString(header[c]!, v) && !LIST_LIKE.test(v)) meta.push({ key: header[c]!, value: v, depth: 0 });
  }
  let counts = 0;
  for (const c of model.numericCols) {
    if (counts >= 3) break;
    const name = header[c]!;
    const v = model.numbers.get(c)![rowIdx]!;
    if (!Number.isNaN(v) && Number.isInteger(v) && isNLike(name) && !model.pairs.has(c)) {
      meta.push({ key: name, value: String(v), depth: 0 });
      counts++;
    }
  }
  return meta;
}

/** Fact body for one CSV cell (shared by the extractor and the locator resolver). */
export function csvCellFact(model: CsvModel, rowIdx: number, col: number, rowMeta?: MetaEntry[], artifact = ''): FactBody & { stemlessId: string } {
  const { header } = model.table;
  const name = header[col]!;
  const value = model.numbers.get(col)![rowIdx]!;
  const unc: Record<string, number> = {};
  for (const [u, p] of model.pairs) {
    if (p.value !== col) continue;
    const uv = model.numbers.get(u)?.[rowIdx];
    if (uv !== undefined && !Number.isNaN(uv)) unc[p.label] = uv;
  }
  const meta = (rowMeta ?? csvRowMeta(model, rowIdx)).filter((m) => m.key !== name);
  const def = renderDefinition(name, meta, null, -1);
  return {
    stemlessId: `${model.rowLabels[rowIdx]}.${idSegment(name)}`,
    kind: kindFromName(name),
    value,
    unit: unitFromName(name),
    uncertainties: unc,
    definition: def.definition,
    definitionSource: `${def.source === 'field name only' ? 'header' : def.source + ' + header'} (CSV row ${rowIdx + 1})`,
    locator: csvLocator(rowIdx + 1, name),
    tags: tagsFor(name, value, artifact),
    proseOnly: false,
  };
}

function extractCsvInto(ctx: BuildCtx, text: string, ext: string): void {
  const model = buildCsvModel(parseCsv(text, ext));
  const { header, rows } = model.table;
  const colSeg = header.map((h) => idSegment(h));
  const valueCols = model.numericCols.filter((c) => !model.pairs.has(c));
  for (let i = 0; i < rows.length; i++) {
    let rowMeta: MetaEntry[] | null = null;
    for (const c of valueCols) {
      if (Number.isNaN(model.numbers.get(c)![i]!)) continue;
      addFact(ctx, `f.${ctx.stem}.${model.rowLabels[i]}.${colSeg[c]}`, () => {
        rowMeta ??= csvRowMeta(model, i);
        const { stemlessId: _s, ...body } = csvCellFact(model, i, c, rowMeta, ctx.artifact);
        return body;
      });
    }
  }
}

/* ------------------------------------------------------------------------------------ */
/* Markdown                                                                               */
/* ------------------------------------------------------------------------------------ */

function extractMarkdownInto(ctx: BuildCtx, text: string): void {
  for (const m of parseDefinitionsMarkdown(text, ctx.artifact)) {
    addFact(ctx, `f.${ctx.stem}.${m.idPart}`, () => ({
      kind: m.kind,
      value: m.value,
      unit: m.unit,
      uncertainties: {},
      definition: m.definition,
      definitionSource: m.definitionSource,
      locator: `md:line=${m.line}`,
      tags: m.tags,
      proseOnly: false,
    }));
  }
}

/* ------------------------------------------------------------------------------------ */
/* Artifacts                                                                              */
/* ------------------------------------------------------------------------------------ */

/**
 * JSON.parse that also accepts the non-standard tokens Python's json module writes (`NaN`,
 * `Infinity`, `-Infinity`): they become null (no fact). A BOM is ignored.
 */
export function parseJsonLenient(text: string): unknown {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return JSON.parse(src);
  } catch (e) {
    if (!/NaN|Infinity/.test(src)) throw e;
    const fixed = src.replace(/"(?:[^"\\]|\\.)*"|-?Infinity|NaN/g, (m) => (m.charCodeAt(0) === 34 ? m : 'null'));
    return JSON.parse(fixed);
  }
}

export type ArtifactType = 'json' | 'csv' | 'md' | null;

export function artifactType(rel: string): ArtifactType {
  const ext = extname(rel).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.csv' || ext === '.tsv') return 'csv';
  if (ext === '.md' || ext === '.markdown') return 'md';
  return null;
}

/** Extract facts from one artifact's text. Pure apart from logging; used by the scanner and tests. */
export function extractArtifactText(
  rel: string,
  text: string,
  sha: string,
  stem: string,
  opts: Pick<ExtractOptions, 'maxFactsPerArtifact' | 'maxArrayLength' | 'keepIds' | 'reservedIds'> = {},
): ArtifactResult {
  const ctx: BuildCtx = {
    artifact: rel,
    sha,
    stem,
    cap: opts.maxFactsPerArtifact ?? DEFAULT_MAX_FACTS_PER_ARTIFACT,
    keepIds: opts.keepIds ?? null,
    reserved: opts.reservedIds ?? null,
    maxArrayLength: opts.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH,
    facts: [],
    counted: 0,
    ids: new Set(),
    dropped: 0,
    skippedArrays: 0,
  };
  const type = artifactType(rel);
  try {
    if (type === 'json') {
      const doc = parseJsonLenient(text);
      if (isFiniteNumber(doc)) {
        // A file holding one number: locator '#' (the whole document).
        addFact(ctx, `f.${stem}.value`, () => ({ kind: 'number', value: doc, unit: '', uncertainties: {}, definition: rel, definitionSource: 'file name only', locator: '#', tags: tagsFor('value', doc, rel), proseOnly: false }));
      } else walkJson(ctx, doc, [], [], 0);
    } else if (type === 'csv') {
      extractCsvInto(ctx, text, extname(rel).slice(1).toLowerCase());
    } else if (type === 'md') {
      extractMarkdownInto(ctx, text);
    } else {
      return { artifact: rel, sha256: sha, status: 'unsupported', error: 'unsupported artifact type', facts: [], droppedByCap: 0, skippedArrays: 0 };
    }
  } catch (e) {
    return { artifact: rel, sha256: sha, status: 'unreadable', error: e instanceof Error ? e.message : String(e), facts: [], droppedByCap: 0, skippedArrays: 0 };
  }
  return { artifact: rel, sha256: sha, status: 'ok', error: null, facts: ctx.facts, droppedByCap: ctx.dropped, skippedArrays: ctx.skippedArrays };
}

/* ------------------------------------------------------------------------------------ */
/* Stems                                                                                  */
/* ------------------------------------------------------------------------------------ */

const GENERIC_STEM_TOKENS = new Set(['claim', 'claims', 'addendum', 'result', 'results', 'summary', 'output', 'outputs', 'final', 'data']);

export interface StemParts {
  short: string;
  version: string;
  full: string;
  ext: string;
  dir: string;
}

export function stemParts(rel: string): StemParts {
  const ext = extname(rel).slice(1).toLowerCase();
  const base = basename(rel, extname(rel));
  const raw = base.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const version = raw.filter((t) => /^v\d+$/i.test(t)).join('_');
  const informative: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i]!;
    if (/^v\d+$/i.test(t)) continue;
    if (GENERIC_STEM_TOKENS.has(t.toLowerCase())) continue;
    const next = raw[i + 1];
    if (t.length === 1 && /[A-Za-z]/.test(t) && next && next.toLowerCase().startsWith(t.toLowerCase()) && /\d/.test(next)) continue;
    informative.push(t);
  }
  const nonVersion = raw.filter((t) => !/^v\d+$/i.test(t));
  const short = idSegment(informative.join('_') || nonVersion.join('_') || base || 'artifact');
  const full = idSegment(raw.join('_') || base || 'artifact');
  const d = basename(dirname(rel));
  return { short, version, full, ext, dir: d && d !== '.' ? idSegment(d) : '' };
}

/** 0 claim JSON, 1 JSON, 2 CSV/TSV, 3 markdown, 4 other. */
export function artifactPriority(rel: string): number {
  const t = artifactType(rel);
  if (t === 'json') return /claim/i.test(basename(rel)) ? 0 : 1;
  if (t === 'csv') return 2;
  if (t === 'md') return 3;
  return 4;
}

function byPriorityThenPath(a: string, b: string): number {
  const pa = artifactPriority(a);
  const pb = artifactPriority(b);
  if (pa !== pb) return pa - pb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Assign stems to artifacts. Pinned stems (from earlier scans) are kept and stay reserved even for
 * artifacts that disappeared, so a returning file gets its old ids back and no file steals them.
 */
export function assignStems(artifacts: string[], pinned: Record<string, string> = {}, reserved: Iterable<string> = []): Record<string, string> {
  const result: Record<string, string> = { ...pinned };
  const taken = new Set<string>([...Object.values(pinned), ...reserved]);
  const fresh = artifacts.filter((a) => !pinned[a]).sort(byPriorityThenPath);
  const groups = new Map<string, string[]>();
  for (const a of fresh) {
    const s = stemParts(a).short;
    const g = groups.get(s) ?? [];
    g.push(a);
    groups.set(s, g);
  }
  for (const [short, members] of groups) {
    const parts = members.map((m) => ({ m, p: stemParts(m) }));
    if (parts.length > 1) {
      const versioned = parts.map(({ p }) => (p.version ? `${short}_${p.version}` : ''));
      if (versioned.every((v) => v) && new Set(versioned).size === versioned.length && versioned.every((v) => !taken.has(v))) {
        parts.forEach(({ m }, i) => {
          result[m] = versioned[i]!;
          taken.add(versioned[i]!);
        });
        continue;
      }
    }
    parts.forEach(({ m, p }, k) => {
      const cands: string[] = [];
      if (k === 0) cands.push(short);
      if (parts.filter((x) => x.p.ext === p.ext).length === 1 || k === 0) cands.push(idSegment(short + p.ext));
      if (p.version) cands.push(`${short}_${p.version}`);
      if (p.dir) cands.push(idSegment(`${p.dir}_${short}`));
      cands.push(p.full);
      let pick = cands.find((c) => !taken.has(c));
      if (!pick) {
        let n = 2;
        while (taken.has(`${p.full}_${n}`)) n++;
        pick = `${p.full}_${n}`;
      }
      result[m] = pick;
      taken.add(pick);
    });
  }
  return result;
}

/* ------------------------------------------------------------------------------------ */
/* Repository scan                                                                        */
/* ------------------------------------------------------------------------------------ */

export interface ScanFile {
  rel: string;
  abs: string;
}

/** Read an artifact once: bytes for the hash, text for parsing (no TOCTOU between them). */
export function readArtifact(abs: string, maxBytes = DEFAULT_MAX_FILE_BYTES): { ok: true; sha: string; text: string; bytes: number } | { ok: false; reason: 'too_large' | 'unreadable'; error: string } {
  try {
    const st = statSync(abs);
    if (st.size > maxBytes) return { ok: false, reason: 'too_large', error: `${st.size} bytes > ${maxBytes}` };
    const buf = readFileSync(abs);
    return { ok: true, sha: sha256Hex(buf), text: buf.toString('utf8'), bytes: buf.length };
  } catch (e) {
    return { ok: false, reason: 'unreadable', error: e instanceof Error ? e.message : String(e) };
  }
}

const yieldNow = () => new Promise<void>((r) => setImmediate(r));

/**
 * Rough number of facts an artifact holds, from a byte scan: CSV data lines x header fields, JSON
 * numeric tokens, markdown lines / 4. Unreadable or oversized files sort last.
 */
export function estimateFacts(abs: string, rel: string, maxBytes = DEFAULT_MAX_FILE_BYTES): number {
  let buf: Buffer;
  try {
    if (statSync(abs).size > maxBytes) return Number.MAX_SAFE_INTEGER;
    buf = readFileSync(abs);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
  const type = artifactType(rel);
  if (type === 'csv') {
    let lines = 0;
    for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) lines++;
    const firstEnd = buf.indexOf(10);
    const head = buf.subarray(0, firstEnd === -1 ? Math.min(buf.length, 65536) : firstEnd).toString('utf8');
    const delim = rel.toLowerCase().endsWith('.tsv') ? '\t' : head.includes(',') ? ',' : head.includes('\t') ? '\t' : ';';
    return Math.max(0, lines - 1 + (buf[buf.length - 1] === 10 ? 0 : 1)) * (head.split(delim).length || 1);
  }
  if (type === 'json') {
    const m = buf.toString('latin1').match(/[:[,]\s*-?\d/g);
    return m ? m.length : 0;
  }
  let lines = 0;
  for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) lines++;
  return Math.ceil(lines / 4);
}

/**
 * Scan the repository. Artifacts are processed claim JSON first, then by estimated fact count
 * (smaller first, so summary tables come before per-particle dumps), then path; the total cap is a
 * running budget, and once it is spent the remaining artifacts are not parsed at all (unless they
 * hold patched facts).
 */
export async function extractRepo(repoDir: string, globs: string[], opts: ExtractOptions = {}): Promise<ExtractResult> {
  const t0 = Date.now();
  const log = opts.log;
  const perCap = opts.maxFactsPerArtifact ?? DEFAULT_MAX_FACTS_PER_ARTIFACT;
  const totalCap = opts.maxFactsTotal ?? DEFAULT_MAX_FACTS_TOTAL;
  const keep = opts.keepIds ?? new Set<string>();
  const keepArtifacts = opts.keepArtifacts ?? null;
  const yieldEvery = opts.yieldEveryMs ?? 25;
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const walk = listMatchingFiles(repoDir, globs, { onWarn: (m) => log?.warn(m) });
  const unsupported = walk.files.filter((f) => !artifactType(f));
  if (unsupported.length) log?.info(`facts: ${unsupported.length} matched file(s) have no extractor (only .json, .csv, .tsv, .md)`, unsupported.slice(0, 10));
  const files = walk.files.filter((f) => artifactType(f));
  const stems = assignStems(files, opts.stems ?? {});
  // Estimated fact counts (cheap byte scans), so the budget goes to summary tables before dumps.
  const estimates = new Map<string, number>();
  for (const f of files) estimates.set(f, estimateFacts(join(repoDir, f), f, maxBytes));
  const order = [...files].sort((a, b) => {
    const pa = artifactPriority(a) === 0 ? 0 : 1;
    const pb = artifactPriority(b) === 0 ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const ea = estimates.get(a)!;
    const eb = estimates.get(b)!;
    if (ea !== eb) return ea - eb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  let budget = Math.max(0, totalCap - keep.size);
  const artifacts: ArtifactResult[] = [];
  const capped = new Set<string>();
  const skippedForBudget: string[] = [];
  let droppedByTotalCap = 0;
  let lastYield = Date.now();
  for (const rel of order) {
    if (budget <= 0 && !(keepArtifacts && keepArtifacts.has(rel))) {
      skippedForBudget.push(rel);
      capped.add(rel);
      artifacts.push({ artifact: rel, sha256: '', status: 'ok', error: null, facts: [], droppedByCap: 0, skippedArrays: 0 });
      continue;
    }
    const read = readArtifact(join(repoDir, rel), maxBytes);
    if (!read.ok) {
      log?.warn(`facts: cannot read ${rel} (${read.error})`);
      artifacts.push({ artifact: rel, sha256: '', status: read.reason, error: read.error, facts: [], droppedByCap: 0, skippedArrays: 0 });
      continue;
    }
    const cap = Math.min(perCap, budget);
    const res = extractArtifactText(rel, read.text, read.sha, stems[rel]!, { maxFactsPerArtifact: cap, maxArrayLength: opts.maxArrayLength, keepIds: keep, reservedIds: opts.reservedIds });
    if (res.status === 'unreadable') log?.warn(`facts: cannot parse ${rel}: ${res.error}`);
    const counted = res.facts.filter((f) => !keep.has(f.id)).length;
    budget -= counted;
    if (res.droppedByCap > 0) {
      capped.add(rel);
      if (cap < perCap) {
        droppedByTotalCap += res.droppedByCap;
        log?.info(`facts: ${rel}: kept ${res.facts.length} facts, dropped ${res.droppedByCap} at the total cap (${totalCap})`);
      } else {
        log?.info(`facts: ${rel}: kept ${res.facts.length} facts, dropped ${res.droppedByCap} beyond the per-artifact cap (${perCap})`);
      }
    }
    if (res.skippedArrays > 0) log?.debug(`facts: ${rel}: skipped ${res.skippedArrays} numeric array(s) longer than ${opts.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH}`);
    artifacts.push(res);
    if (Date.now() - lastYield > yieldEvery) {
      await yieldNow();
      lastYield = Date.now();
    }
  }
  if (skippedForBudget.length) {
    log?.warn(
      `facts: total cap (${totalCap}) reached; ${skippedForBudget.length} artifact(s) not read (largest tables last; narrow config.factGlobs, e.g. '!results/**/*_particles.csv', to make room)`,
      skippedForBudget.slice(0, 20),
    );
  }
  // Facts in a stable display order: claim JSON, JSON, CSV, markdown; path order; document order.
  const display = [...artifacts].sort((a, b) => byPriorityThenPath(a.artifact, b.artifact));
  const facts: RawFact[] = [];
  for (const a of display) for (const f of a.facts) facts.push(f);
  return {
    facts,
    artifacts: display,
    stems,
    droppedByTotalCap,
    skippedForBudget,
    cappedArtifacts: [...capped].sort(),
    truncatedWalk: walk.truncated,
    ms: Date.now() - t0,
  };
}

/* ------------------------------------------------------------------------------------ */
/* Locators (verification of repo-reader candidates)                                      */
/* ------------------------------------------------------------------------------------ */

export type ParsedLocator =
  | { type: 'json'; tokens: string[] }
  | { type: 'csv'; row: number; col: string }
  | { type: 'md'; line: number; match: string | null; occurrence: number | null }
  | { type: 'invalid'; reason: string };

export function parseLocator(locator: string): ParsedLocator {
  const loc = locator.trim();
  if (loc === '' || loc === '#') return { type: 'json', tokens: [] };
  if (loc.startsWith('#/') || loc.startsWith('/')) {
    const raw = loc.startsWith('#') ? loc.slice(1) : loc;
    let body = raw;
    if (/%[0-9A-Fa-f]{2}/.test(body)) {
      try {
        body = decodeURIComponent(body);
      } catch {
        /* keep as written */
      }
    }
    return { type: 'json', tokens: body.slice(1).split('/').map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~')) };
  }
  const csv = /^csv:row=(\d+);col=(.+)$/.exec(loc);
  if (csv) {
    let col = csv[2]!;
    if (/%[0-9A-Fa-f]{2}/.test(col)) {
      try {
        col = decodeURIComponent(col);
      } catch {
        /* keep */
      }
    }
    const row = Number(csv[1]);
    if (row < 1) return { type: 'invalid', reason: 'csv rows are 1-based' };
    return { type: 'csv', row, col };
  }
  const md = /^md:line=(\d+)((?:;[a-z]+=[^;]*)*)$/.exec(loc);
  if (md) {
    const line = Number(md[1]);
    if (line < 1) return { type: 'invalid', reason: 'lines are 1-based' };
    let match: string | null = null;
    let occurrence: number | null = null;
    for (const part of (md[2] ?? '').split(';').filter(Boolean)) {
      const [k, ...rest] = part.split('=');
      const v = rest.join('=');
      if (k === 'match') {
        try {
          match = decodeURIComponent(v);
        } catch {
          match = v;
        }
      } else if (k === 'occurrence' || k === 'n') occurrence = Number(v);
    }
    return { type: 'md', line, match, occurrence };
  }
  if (/^ya?ml:/.test(loc)) return { type: 'invalid', reason: 'YAML locators are not supported yet' };
  return { type: 'invalid', reason: `unrecognized locator "${locator}" (use #/json/pointer, csv:row=N;col=NAME or md:line=N)` };
}

/** Numerals in a plain-text (markdown) line: [{raw, value, start}]; thousands separators allowed. */
export function numeralsInText(text: string): Array<{ raw: string; value: number; start: number }> {
  const out: Array<{ raw: string; value: number; start: number }> = [];
  const re = /(?<![\w.])[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const value = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(value)) out.push({ raw: m[0], value, start: m.index });
  }
  return out;
}

export interface ResolvedLocator {
  value: number | string;
  /** Id path after `f.<stem>.` that the extractor scheme gives this locator. */
  idPath: string;
  unit: string;
  uncertainties: Record<string, number>;
  definition: string;
  definitionSource: string;
  tags: string[];
  locator: string;
  /** The locator is a paired uncertainty field; this is the locator of the value it belongs to. */
  coveredBy?: string;
}

/**
 * Read the value at a locator in an artifact's text, by code. `wantString` accepts string values
 * (definitions); otherwise the value must be a finite number.
 */
export function resolveLocatorInText(rel: string, text: string, locator: string, wantString: boolean): { ok: true; r: ResolvedLocator } | { ok: false; reason: string } {
  const loc = parseLocator(locator);
  const type = artifactType(rel);
  if (loc.type === 'invalid') return { ok: false, reason: loc.reason };
  if (loc.type === 'json') {
    if (type !== 'json') return { ok: false, reason: `JSON pointer on a non-JSON artifact (${rel})` };
    let doc: unknown;
    try {
      doc = parseJsonLenient(text);
    } catch (e) {
      return { ok: false, reason: `artifact is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
    let node: unknown = doc;
    const path: Array<string | number> = [];
    let meta: MetaEntry[] = [];
    let parent: Record<string, unknown> | null = null;
    for (let i = 0; i < loc.tokens.length; i++) {
      const t = loc.tokens[i]!;
      if (Array.isArray(node)) {
        if (!/^(?:0|[1-9]\d*)$/.test(t) || Number(t) >= node.length) return { ok: false, reason: `pointer token "${t}" is not an index of the array at ${humanPath(path)}` };
        path.push(Number(t));
        parent = null;
        node = node[Number(t)];
      } else if (node && typeof node === 'object') {
        const obj = node as Record<string, unknown>;
        if (!Object.prototype.hasOwnProperty.call(obj, t)) return { ok: false, reason: `pointer token "${t}" not found at ${humanPath(path)}` };
        meta = [...objectMeta(obj, i), ...meta];
        parent = obj;
        path.push(t);
        node = obj[t];
      } else {
        return { ok: false, reason: `pointer goes below a value at ${humanPath(path)}` };
      }
    }
    const name = lastKey(path);
    const okNumber = isFiniteNumber(node);
    const okString = wantString && typeof node === 'string';
    if (!okNumber && !okString) return { ok: false, reason: `locator points to ${node === null ? 'null' : Array.isArray(node) ? 'an array' : typeof node}, not a ${wantString ? 'value' : 'number'}` };
    const unc: Record<string, number> = {};
    let coveredBy: string | undefined;
    if (okNumber && parent && typeof path[path.length - 1] === 'string') {
      const numericKeys = Object.keys(parent).filter((k) => isFiniteNumber(parent![k]));
      const pairs = pairUncertainties(numericKeys);
      for (const [u, p] of pairs) if (p.value === name) unc[p.label] = parent[u] as number;
      const mine = pairs.get(name);
      if (mine) coveredBy = '#/' + [...path.slice(0, -1), mine.value].map((t) => escapePointerToken(String(t))).join('/');
    }
    const selfKey = typeof path[path.length - 1] === 'string' ? (path[path.length - 1] as string) : null;
    const def = renderDefinition(humanPath(path), meta, selfKey, path.length - 1);
    return {
      ok: true,
      r: {
        value: node as number | string,
        idPath: path.map((t) => idSegment(String(t))).join('.') || 'value',
        unit: okNumber ? unitFromName(name) : '',
        uncertainties: unc,
        definition: def.definition,
        definitionSource: def.source,
        tags: okNumber ? tagsFor(name, node as number, rel) : [],
        locator: path.length ? '#/' + path.map((t) => escapePointerToken(String(t))).join('/') : '#',
        ...(coveredBy ? { coveredBy } : {}),
      },
    };
  }
  if (loc.type === 'csv') {
    if (type !== 'csv') return { ok: false, reason: `CSV locator on a non-CSV artifact (${rel})` };
    const model = buildCsvModel(parseCsv(text, extname(rel).slice(1).toLowerCase()));
    const col = model.table.header.indexOf(loc.col);
    if (col === -1) return { ok: false, reason: `no column "${loc.col}"` };
    if (loc.row > model.table.rows.length) return { ok: false, reason: `row ${loc.row} beyond the last data row (${model.table.rows.length})` };
    const cellText = model.table.rows[loc.row - 1]![col] ?? '';
    const num = model.numbers.has(col) && !Number.isNaN(model.numbers.get(col)![loc.row - 1]!) ? model.numbers.get(col)![loc.row - 1]! : null;
    if (num === null) {
      if (wantString && cellText.trim()) {
        return {
          ok: true,
          r: { value: cellText.trim(), idPath: `${model.rowLabels[loc.row - 1]}.${idSegment(loc.col)}`, unit: '', uncertainties: {}, definition: loc.col, definitionSource: `header (CSV row ${loc.row})`, tags: [], locator: csvLocator(loc.row, loc.col) },
        };
      }
      return { ok: false, reason: `cell row ${loc.row}, column "${loc.col}" is not a number ("${cellText.slice(0, 40)}")` };
    }
    const cell = csvCellFact(model, loc.row - 1, col, undefined, rel);
    const pair = model.pairs.get(col);
    return {
      ok: true,
      r: {
        value: num,
        idPath: cell.stemlessId,
        unit: cell.unit,
        uncertainties: cell.uncertainties,
        definition: cell.definition,
        definitionSource: cell.definitionSource,
        tags: cell.tags,
        locator: cell.locator,
        ...(pair ? { coveredBy: csvLocator(loc.row, model.table.header[pair.value]!) } : {}),
      },
    };
  }
  // md
  const lines = text.split(/\r\n|\r|\n/);
  const lineText = lines[loc.line - 1];
  if (lineText === undefined) return { ok: false, reason: `line ${loc.line} beyond the end of the file (${lines.length} lines)` };
  const plain = plainMdLine(lineText).replace(/\s+/g, ' ').trim();
  const baseLoc = `md:line=${loc.line}`;
  if (wantString && !loc.match) {
    if (!plain) return { ok: false, reason: `line ${loc.line} is empty` };
    return { ok: true, r: { value: plain, idPath: '', unit: '', uncertainties: {}, definition: plain.slice(0, 200), definitionSource: `${rel} line ${loc.line}`, tags: [], locator: baseLoc } };
  }
  let nums = numeralsInText(plain);
  if (loc.match) {
    const at = plain.indexOf(loc.match);
    if (at === -1) return { ok: false, reason: `line ${loc.line} does not contain "${loc.match}"` };
    nums = nums.filter((n) => n.start >= at && n.start < at + loc.match!.length);
  }
  if (loc.occurrence !== null) {
    const pick = nums[loc.occurrence - 1];
    nums = pick ? [pick] : [];
  }
  if (nums.length === 0) return { ok: false, reason: `no number on line ${loc.line}${loc.match ? ` inside "${loc.match}"` : ''}` };
  if (nums.length > 1)
    return { ok: false, reason: `line ${loc.line} has ${nums.length} numbers (${nums.slice(0, 5).map((n) => n.raw).join(', ')}); name one with ;match=<text as written>` };
  const n = nums[0]!;
  const excerpt = plain.length > 200 ? plain.slice(0, 197) + '...' : plain;
  return {
    ok: true,
    r: {
      value: n.value,
      idPath: '',
      unit: '',
      uncertainties: {},
      definition: excerpt,
      definitionSource: `${rel} line ${loc.line} (prose)`,
      tags: [],
      locator: loc.match ? `${baseLoc};match=${encodeURIComponent(loc.match)}` : loc.occurrence !== null ? `${baseLoc};occurrence=${loc.occurrence}` : baseLoc,
    },
  };
}
