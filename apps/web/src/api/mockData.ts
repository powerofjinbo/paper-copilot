/**
 * Pure builders for the in-browser demo (MockApiClient): facts from a results claim JSON (the
 * deterministic-extractor shape of docs/design.md "Data model"), literature records from a .bib,
 * the pre-filled outline, claims/figures for the panels, push blockers and a unified diff.
 * No timers, no I/O: everything here is unit-testable in Node.
 */
import {
  emptyOutline,
  factAliases,
  hashString,
  type Claim,
  type Fact,
  type FigureEntry,
  type GhostMode,
  type LitRecord,
  type Outline,
  type OutlineSection,
} from '@paper-copilot/core';

/* ------------------------------------------------------------------------------------ */
/* Facts                                                                                 */
/* ------------------------------------------------------------------------------------ */

type Json = Record<string, unknown>;

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;
}

/** Plain-English definition from the claim file's metadata fields only (never invented). */
export function claimFactDefinition(key: string, index: number | null, meta: Json): string {
  const A = str(meta.A, 'model A');
  const B = str(meta.B, 'model B');
  const claim = str(meta.claim, '?');
  const cond = [meta.population ? `population ${str(meta.population)}` : '', str(meta.split), meta.n_targets !== undefined ? `n=${str(meta.n_targets)}` : '']
    .filter(Boolean)
    .join(', ');
  const tail = cond ? `, ${cond}` : '';
  switch (key) {
    case 'eff_A':
      return `Efficiency of ${A}${tail}`;
    case 'eff_B':
      return `Efficiency of ${B}${tail}`;
    case 'eff_A_seeds':
      return `Efficiency of ${A}, training seed ${index ?? 0}${tail}`;
    case 'eff_B_seeds':
      return `Efficiency of ${B}, training seed ${index ?? 0}${tail}`;
    case 'delta_points':
      return `Efficiency difference, ${A} minus ${B}, in percentage points${tail}`;
    case 'sigma_points':
      return `Total uncertainty of the efficiency difference (bootstrap and seed spread combined), in points${tail}`;
    case 'sigma_boot_points':
      return `Event-bootstrap uncertainty of the efficiency difference, in points${tail}`;
    case 'sigma_seeds_points':
      return `Training-seed spread of the efficiency difference, in points${tail}`;
    case 'delta_minus_2sigma':
      return `Efficiency difference minus two total uncertainties, in points${tail}`;
    case 'delta_plus_2sigma':
      return `Efficiency difference plus two total uncertainties, in points${tail}`;
    case 'margin':
      return `Pre-registered margin for claim ${claim}, in points`;
    case 'fake_rate_A':
      return `Track fake rate of ${A}${tail}`;
    case 'fake_rate_B':
      return `Track fake rate of ${B}${tail}`;
    case 'fake_rate_diff_points':
      return `Fake-rate difference, ${A} minus ${B}, in points${tail}`;
    case 'n_targets':
      return `Number of target particles, population ${str(meta.population, '?')}, ${str(meta.split, '')}`.replace(/, $/, '');
    default:
      return `${key}${index !== null ? `[${index}]` : ''} (claim ${claim})${tail}`;
  }
}

function unitFor(key: string): string {
  if (key.endsWith('_points') || key === 'margin' || key.endsWith('_2sigma')) return 'points';
  return '';
}

function safeAliases(f: Fact): string[] {
  try {
    return factAliases(f);
  } catch {
    return [];
  }
}

/**
 * One fact per numeric leaf of a claim JSON (arrays of numbers by index), with JSON-pointer locators.
 * Booleans and strings are metadata (definitions), not facts; `outcome: holds` is a claim outcome.
 */
export function buildClaimFacts(raw: string, artifact: string, sha256: string): Fact[] {
  const meta = JSON.parse(raw) as Json;
  const claim = str(meta.claim, 'claim').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const facts: Fact[] = [];
  const make = (key: string, index: number | null, value: number): Fact => {
    const id = `f.${claim}.${key}${index !== null ? `.${index}` : ''}`;
    const locator = `#/${key}${index !== null ? `/${index}` : ''}`;
    const uncertainties: Record<string, number> = {};
    if (key === 'delta_points') {
      if (typeof meta.sigma_points === 'number') uncertainties.total = meta.sigma_points;
      if (typeof meta.sigma_boot_points === 'number') uncertainties.boot = meta.sigma_boot_points;
      if (typeof meta.sigma_seeds_points === 'number') uncertainties.seeds = meta.sigma_seeds_points;
    }
    const f: Fact = {
      id,
      kind: key === 'margin' ? 'setting' : 'number',
      value,
      sigfigs: null,
      unit: unitFor(key),
      uncertainties,
      definition: claimFactDefinition(key, index, meta),
      definitionSource: 'metadata: claim, A, B, population, split, n_targets',
      artifact,
      locator,
      artifactSha256: sha256,
      fingerprint: hashString(`${sha256}|${locator}|${String(value)}`),
      stale: false,
      validationState: 'candidate',
      aliases: [],
      confirmed: false,
      excluded: false,
      proseOnly: false,
      tags: [`claim:${str(meta.claim, '?')}`],
    };
    f.aliases = safeAliases(f);
    return f;
  };
  for (const [key, v] of Object.entries(meta)) {
    if (typeof v === 'number' && Number.isFinite(v)) facts.push(make(key, null, v));
    else if (Array.isArray(v)) v.forEach((x, i) => typeof x === 'number' && Number.isFinite(x) && facts.push(make(key, i, x)));
  }
  return facts;
}

/** Find a fact by the last segment(s) of its id, e.g. `factBySuffix(facts, 'eff_A')`. */
export function factBySuffix(facts: Fact[], suffix: string): Fact | undefined {
  return facts.find((f) => f.id.endsWith(`.${suffix}`) && !f.excluded);
}

/* ------------------------------------------------------------------------------------ */
/* Literature                                                                            */
/* ------------------------------------------------------------------------------------ */

function stripBraces(s: string): string {
  return s.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

/** Minimal .bib reader for the demo (the server uses @retorquere/bibtex-parser). */
export function buildLitFromBib(bib: string): LitRecord[] {
  const out: LitRecord[] = [];
  const entryRe = /@(\w+)\s*\{\s*([^,\s]+)\s*,([\s\S]*?)\n\}/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(bib))) {
    const body = m[3] ?? '';
    const field = (name: string): string | null => {
      const fm = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|\\{((?:[^{}]|\\{[^{}]*\\})*)\\}|(\\d+))`, 'i').exec(body);
      if (!fm) return null;
      return stripBraces(fm[1] ?? fm[2] ?? fm[3] ?? '');
    };
    const year = field('year');
    out.push({
      key: m[2] ?? '',
      status: 'user_confirmed',
      texkey: null,
      recid: null,
      arxiv: field('eprint'),
      doi: field('doi'),
      title: field('title') ?? '',
      authors: field('author') ?? '',
      year: year && /^\d{4}$/.test(year) ? Number(year) : null,
      abstract: null,
      quotable: [],
      usableFor: [],
      source: 'bib',
    });
  }
  return out;
}

/* ------------------------------------------------------------------------------------ */
/* Outline                                                                               */
/* ------------------------------------------------------------------------------------ */

/** Skill template for a section title. */
export function templateFor(title: string, id: string): string {
  const t = `${title} ${id}`.toLowerCase();
  if (/abstract/.test(t)) return 'abstract';
  if (/intro/.test(t)) return 'introduction';
  if (/conclu|summary|outlook/.test(t)) return 'conclusions';
  if (/result/.test(t)) return 'results';
  return 'section';
}

/** docs/design.md: complete-my-sentence for abstract, introduction, conclusions; auto-propose elsewhere. */
export function defaultGhostMode(template: string): GhostMode {
  return template === 'abstract' || template === 'introduction' || template === 'conclusions' ? 'complete-my-sentence' : 'auto-propose';
}

export interface SectionHead {
  id: string;
  title: string;
}

/** `\section{Title}` (+ an optional `\label{key}` right after) from the source; used when segment() is unavailable. */
export function sectionsFromSource(source: string): SectionHead[] {
  const body = source.includes('\\begin{document}') ? source.slice(source.indexOf('\\begin{document}')) : source;
  const out: SectionHead[] = [];
  const seen = new Set<string>();
  if (/\\begin\{abstract\}/.test(body)) {
    out.push({ id: 'abstract', title: 'Abstract' });
    seen.add('abstract');
  }
  const re = /^[ \t]*\\section\*?\{([^}]*)\}[ \t]*(?:\r?\n[ \t]*\\label\{([^}]*)\})?/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const title = (m[1] ?? '').trim();
    let id = m[2] ? m[2].trim() : `sec:${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    let k = 2;
    while (seen.has(id)) id = `${id}-${k++}`;
    seen.add(id);
    out.push({ id, title });
  }
  return out;
}

/** An empty outline (core emptyOutline) with the document's sections pre-filled: titles only. */
export function outlineWithSections(heads: SectionHead[]): Outline {
  const o = emptyOutline();
  o.sections = heads.map((h): OutlineSection => {
    const template = templateFor(h.title, h.id);
    return { id: h.id, title: h.title, question: '', template, ghostMode: defaultGhostMode(template), paragraphs: [], provenance: 'author' };
  });
  return o;
}

/* ------------------------------------------------------------------------------------ */
/* Claims and figures                                                                    */
/* ------------------------------------------------------------------------------------ */

export function buildClaims(raw: string, facts: Fact[]): Claim[] {
  const meta = JSON.parse(raw) as Json;
  const id = str(meta.claim, 'C1');
  const ev = ['delta_points', 'sigma_points', 'fake_rate_A', 'fake_rate_B'].map((k) => factBySuffix(facts, k)?.id).filter((x): x is string => !!x);
  return [
    {
      claimId: id,
      text: `${str(meta.A, 'A')} finds more targets than ${str(meta.B, 'B')} at a comparable fake-track rate`,
      evidence: ev,
      citations: [],
      qualification: `population ${str(meta.population)}, ${str(meta.split)}; one simulated detector without pileup`,
      status: 'supported',
      sentenceIds: [],
      section: 'sec:results',
      move: 'result',
    },
  ];
}

/** Figures from `\begin{figure}...\label{fig:..}` blocks of the source. */
export function figuresFromSource(source: string, claimIds: string[]): FigureEntry[] {
  const out: FigureEntry[] = [];
  const re = /\\begin\{figure\*?\}([\s\S]*?)\\end\{figure\*?\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const body = m[1] ?? '';
    const label = /\\label\{([^}]*)\}/.exec(body)?.[1] ?? null;
    const path = /\\includegraphics(?:\[[^\]]*\])?\{([^}]*)\}/.exec(body)?.[1] ?? null;
    const caption = /\\caption(?:\[[^\]]*\])?\{([^.]*)/.exec(body)?.[1]?.trim() ?? '';
    out.push({
      figureId: label ?? `figure-${out.length + 1}`,
      label,
      path,
      sha256: null,
      producerScript: null,
      claimIds,
      captionSentenceIds: [],
      status: path ? 'exists' : 'needs_run',
      job: caption,
    });
  }
  return out;
}

/* ------------------------------------------------------------------------------------ */
/* Push guard helpers                                                                    */
/* ------------------------------------------------------------------------------------ */

const CJK_RE = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/;

export function hasCjk(s: string): boolean {
  return CJK_RE.test(s);
}

/** Lines (1-based) with CJK outside comments, for the 'cjk' push blocker. */
export function cjkLines(source: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  source.split('\n').forEach((l, i) => {
    const code = l.replace(/(^|[^\\])%.*$/, '$1');
    if (hasCjk(code)) out.push({ line: i + 1, text: l.trim() });
  });
  return out;
}

/* ------------------------------------------------------------------------------------ */
/* Unified diff (line based; the push check shows exactly what co-authors will see)      */
/* ------------------------------------------------------------------------------------ */

type Op = { op: ' ' | '-' | '+'; text: string; a: number; b: number };

function lineOps(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ op: ' ', text: a[i] ?? '', a: i, b: i });
  const n = am.length;
  const m = bm.length;
  if (n * m > 4_000_000) {
    // Too large for the LCS table: show the middle as a replacement block.
    am.forEach((t, i) => ops.push({ op: '-', text: t, a: pre + i, b: pre }));
    bm.forEach((t, j) => ops.push({ op: '+', text: t, a: pre + n, b: pre + j }));
  } else {
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      const row = dp[i]!;
      const next = dp[i + 1]!;
      for (let j = m - 1; j >= 0; j--) row[j] = am[i] === bm[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) {
        ops.push({ op: ' ', text: am[i] ?? '', a: pre + i, b: pre + j });
        i++;
        j++;
      } else if (i < n && (j >= m || dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
        ops.push({ op: '-', text: am[i] ?? '', a: pre + i, b: pre + j });
        i++;
      } else {
        ops.push({ op: '+', text: bm[j] ?? '', a: pre + i, b: pre + j });
        j++;
      }
    }
  }
  for (let k = 0; k < suf; k++) ops.push({ op: ' ', text: a[a.length - suf + k] ?? '', a: a.length - suf + k, b: b.length - suf + k });
  return ops;
}

/** Unified diff with 3 lines of context; '' when the texts are equal. */
export function unifiedDiff(before: string, after: string, file: string, context = 3): string {
  if (before === after) return '';
  const ops = lineOps(before.split('\n'), after.split('\n'));
  const changed = ops.map((o, k) => (o.op !== ' ' ? k : -1)).filter((k) => k >= 0);
  if (!changed.length) return '';
  const hunks: Array<[number, number]> = [];
  for (const k of changed) {
    const lo = Math.max(0, k - context);
    const hi = Math.min(ops.length - 1, k + context);
    const last = hunks[hunks.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else hunks.push([lo, hi]);
  }
  const out = [`--- a/${file}`, `+++ b/${file}`];
  for (const [lo, hi] of hunks) {
    const slice = ops.slice(lo, hi + 1);
    const first = slice[0]!;
    const aCount = slice.filter((o) => o.op !== '+').length;
    const bCount = slice.filter((o) => o.op !== '-').length;
    out.push(`@@ -${first.a + 1},${aCount} +${first.b + 1},${bCount} @@`);
    for (const o of slice) out.push(`${o.op}${o.text}`);
  }
  return out.join('\n') + '\n';
}

/* ------------------------------------------------------------------------------------ */
/* Hashing                                                                               */
/* ------------------------------------------------------------------------------------ */

export async function sha256Hex(text: string): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw new Error('no subtle crypto');
    const buf = await subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // Non-secure context: a non-cryptographic stand-in, clearly not a SHA-256.
    return `cyrb53:${hashString(text)}`;
  }
}
