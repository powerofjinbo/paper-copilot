/**
 * LintService: the tier-1 linter (docs/design.md, "Faithfulness and provenance" 8 and "Skill and voice").
 *
 * Sentence pass (lintUnits): for the given units, the sidecar's sentence-local style_check checks
 * (lint.sentences: text = the unit's LaTeX source, part = unit.part, known = the terminology acronyms),
 * the AI-ese linter on the unit's plain text (core aieseFlags: Kobak excess vocabulary with its ratio,
 * pattern phrases labelled as heuristics with no rate) and the gate's claim-strength warning
 * (core gateSentence, only its `claim_strength` issues). Emits lint.update scope 'sentences'.
 *
 * Document pass (scheduleDocument / lintDocumentNow): the root document (the main file when the file is
 * part of its \input tree, else the file itself) is flattened (\input/\include, depth-limited,
 * cycle-safe), each file passed through the intent-line shadow, and sent to lint.document. Every flag
 * is mapped back to (file, line) through the flattening line map and reconciled to the sentence unit
 * covering that line whose plain text best matches the flag's excerpt (deterministic tie-break: excerpt
 * similarity, then line distance, then document order, then id). Flags that match no unit keep
 * sentenceId null. Debounced 2 s; at most one pass in flight per root (a request during a pass runs once
 * more after it). Emits lint.update scope 'document' per file.
 *
 * Flag ids follow the contract, hashString(source + check + sentenceId + word + msg), with
 * `line:<file>:<n>` standing in for a null sentenceId, so a re-lint of unchanged text yields the same
 * id and a dismissal (ctx.db.dismissLint) survives it.
 *
 * Without python3 or the skill, status() says why and the sentence pass still emits AI-ese and gate flags.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { aieseFlags, gateSentence, hashString, plainText, type Fact, type LintFlag, type SentenceUnit } from '@paper-copilot/core';
import type { Ctx, LintService } from '../../contracts';
import { safeJoin } from '../../infra';
import { flattenTex, type FlatLine } from '../build/flatten';
import { shadowText } from '../build/shadow';
import { LintSidecar } from './sidecar';

/* ------------------------------------------------------------------------------------ */
/* Sidecar client shape (sidecar/PROTOCOL.md)                                            */
/* ------------------------------------------------------------------------------------ */

/** A style_check flag as the sidecar returns it (sentence pass: sid set; document pass: line/part/sent_index). */
export interface SidecarFlag {
  sid?: string | null;
  /** Check number (1..10) or key. */
  check?: number | string | null;
  key?: string | null;
  msg: string;
  word?: string | null;
  excerpt?: string | null;
  line?: number | null;
  part?: string | null;
  sent_index?: number | null;
}

export interface SidecarDocumentResult {
  flags: SidecarFlag[];
  rates: Record<string, number>;
  referenceRates: Record<string, number>;
  words: number | null;
  sentences: number | null;
}

/** What the lint service needs from the sidecar client. */
export interface LintSidecarLike {
  readonly version: string | null;
  /** `preamble`: the document preamble, so \newcommand macros in the sentences are expanded. */
  lintSentences(items: Array<{ sid: string; text: string; part: string }>, opts: { known: string[]; maxWords?: number; preamble?: string }): Promise<SidecarFlag[]>;
  lintDocument(text: string, opts: { known: string[]; maxWords?: number }): Promise<SidecarDocumentResult>;
  close(): Promise<void>;
}

export interface StartSidecarOptions {
  skillDir: string;
  python: string;
  log: Ctx['log'];
}

export interface LintServiceOptions {
  /** Start the sidecar (tests inject a fake). Default: the LintSidecar client in ./sidecar. */
  startSidecar?: (o: StartSidecarOptions) => Promise<LintSidecarLike>;
  debounceMs?: number;
  python?: string;
  maxWords?: number;
}

/** style_check check numbers -> keys (style_check.py CHECKS). */
const CHECK_KEYS: Record<number, string> = { 1: 'long', 2: 'verb', 3: 'connectors', 4: 'vocab', 5: 'hype', 6: 'vague', 7: 'acronyms', 8: 'terms', 9: 'figures', 10: 'passive' };

/**
 * Flags per 1,000 words of style_check on the five reference papers (style_check.py CORPUS_RATE), used
 * until the sidecar has reported its reference_rates.
 */
const FALLBACK_REFERENCE_RATES: Record<string, number> = { long: 3.3, verb: 0.9, connectors: 0.4, vocab: 0.4, hype: 1.6, vague: 0.1, acronyms: 0.2, terms: 1.1, figures: 0.3, passive: 0.0 };

const WARN_CHECKS = new Set(['acronyms', 'figures']);

function checkKey(f: SidecarFlag): string {
  if (typeof f.key === 'string' && f.key) return f.key;
  if (typeof f.check === 'number') return CHECK_KEYS[f.check] ?? `check${f.check}`;
  if (typeof f.check === 'string' && f.check) return /^\d+$/.test(f.check) ? (CHECK_KEYS[Number(f.check)] ?? `check${f.check}`) : f.check;
  return 'style';
}

function numRecord(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    const key = /^\d+$/.test(k) ? (CHECK_KEYS[Number(k)] ?? k) : k;
    if (typeof n === 'number' && Number.isFinite(n)) out[key] = n;
  }
  return out;
}

/** Accept the sidecar's document response in snake_case or camelCase. */
export function normalizeDocumentResult(raw: unknown): SidecarDocumentResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const flags = Array.isArray(r.flags) ? (r.flags as SidecarFlag[]).filter((f) => f && typeof f.msg === 'string') : [];
  return {
    flags,
    rates: numRecord(r.rates),
    referenceRates: numRecord(r.reference_rates ?? r.referenceRates),
    words: typeof r.words === 'number' ? r.words : null,
    sentences: typeof r.sentences === 'number' ? r.sentences : null,
  };
}

/* ------------------------------------------------------------------------------------ */
/* Ids and reconciliation (pure; exported for tests)                                     */
/* ------------------------------------------------------------------------------------ */

export function flagId(source: string, check: string, sentenceId: string | null, word: string | null, msg: string, nullKey = ''): string {
  return hashString(source + check + (sentenceId ?? nullKey) + (word ?? '') + msg);
}

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[…]|\.\.\.$/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

/** Share of the excerpt's tokens found, in order, in the unit's tokens (LCS / excerpt length). */
export function excerptSimilarity(excerpt: string, unitText: string): number {
  const a = tokens(excerpt);
  const b = tokens(unitText);
  if (a.length === 0 || b.length === 0) return 0;
  // Excerpts are prefixes of at most ~170 chars; cap the work.
  const A = a.slice(0, 60);
  const B = b.slice(0, 200);
  let prev = new Array<number>(B.length + 1).fill(0);
  let cur = new Array<number>(B.length + 1).fill(0);
  for (let i = 1; i <= A.length; i++) {
    for (let j = 1; j <= B.length; j++) cur[j] = A[i - 1] === B[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    [prev, cur] = [cur, prev];
  }
  return prev[B.length]! / A.length;
}

export interface UnitSpan {
  id: string;
  /** 1-based first and last line of the unit in its file. */
  line: number;
  endLine: number;
  start: number;
  /** Plain text of the unit (for excerpt matching). */
  text: string;
}

export interface Reconciled {
  file: string;
  line: number | null;
  sentenceId: string | null;
}

/** Line window around a unit's span inside which an excerpt match may still claim the flag. */
const RECONCILE_WINDOW = 2;

/**
 * Map one document-pass flag (flattened line + excerpt) to a real (file, line) and a unit.
 * A unit whose span covers the line wins with a modest excerpt match (>= 0.3, or any when the flag has
 * no excerpt); a unit up to RECONCILE_WINDOW lines away needs a strong one (>= 0.6). Ties: higher
 * similarity, smaller line distance, earlier start, smaller id.
 */
export function reconcileFlag(flag: { line?: number | null; excerpt?: string | null }, map: FlatLine[], unitsByFile: Map<string, UnitSpan[]>, rootFile: string): Reconciled {
  const ln = typeof flag.line === 'number' && Number.isInteger(flag.line) ? flag.line : null;
  const real = ln !== null && ln >= 1 ? map[ln - 1] : undefined;
  if (!real) return { file: rootFile, line: null, sentenceId: null };
  const units = unitsByFile.get(real.file) ?? [];
  const excerpt = (flag.excerpt ?? '').trim();
  let best: { u: UnitSpan; sim: number; dist: number } | null = null;
  for (const u of units) {
    const dist = real.line < u.line ? u.line - real.line : real.line > u.endLine ? real.line - u.endLine : 0;
    if (dist > RECONCILE_WINDOW) continue;
    const sim = excerpt ? excerptSimilarity(excerpt, u.text) : dist === 0 ? 1 : 0;
    const ok = dist === 0 ? !excerpt || sim >= 0.3 : sim >= 0.6;
    if (!ok) continue;
    const better =
      !best ||
      sim > best.sim + 1e-9 ||
      (Math.abs(sim - best.sim) <= 1e-9 && (dist < best.dist || (dist === best.dist && (u.start < best.u.start || (u.start === best.u.start && u.id < best.u.id)))));
    if (better) best = { u, sim, dist };
  }
  return { file: real.file, line: real.line, sentenceId: best ? best.u.id : null };
}

/* ------------------------------------------------------------------------------------ */
/* Service                                                                               */
/* ------------------------------------------------------------------------------------ */

/** 1-based line of an offset, by binary search over precomputed line starts. */
export function lineTable(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Default sidecar factory: the LintSidecar client (./sidecar.ts) behind the LintSidecarLike shape. */
async function defaultStartSidecar(o: StartSidecarOptions): Promise<LintSidecarLike> {
  const sc = await LintSidecar.start({ skillDir: o.skillDir, python: o.python, log: o.log });
  return {
    version: sc.version || null,
    async lintSentences(items, opts) {
      return sc.lintSentences(items, { known: opts.known, maxWords: opts.maxWords, ...(opts.preamble ? { preamble: opts.preamble } : {}) });
    },
    async lintDocument(text, opts) {
      return normalizeDocumentResult(await sc.lintDocument(text, { known: opts.known, maxWords: opts.maxWords }));
    },
    async close() {
      await sc.close();
    },
  };
}

interface FileLint {
  sentences: Map<string, LintFlag[]>;
  document: LintFlag[];
}

export function createLintService(ctx: Ctx, opts: LintServiceOptions = {}): LintService {
  const debounceMs = opts.debounceMs ?? 2000;
  const python = opts.python ?? process.env.PAPER_PYTHON ?? 'python3';
  const maxWords = opts.maxWords ?? 40;
  const startSidecar = opts.startSidecar ?? defaultStartSidecar;

  let sidecar: LintSidecarLike | null = null;
  let reason: string | null = 'not started';
  let version: string | null = null;
  let starting: Promise<void> | null = null;
  let lastStartAttempt = 0;
  let stopped = false;
  /** python3 or the skill is missing: no point retrying until start() is called again. */
  let unavailable = false;

  /** Rates from the latest document pass (this document, per 1k words) and the sidecar's reference rates. */
  let userRates: Record<string, number> = {};
  let referenceRates: Record<string, number> = { ...FALLBACK_REFERENCE_RATES };

  const store = new Map<string, FileLint>();
  const dismissed = new Set<string>();
  const loadedDismissals = new Set<string>();

  const texRoot = () => resolve(ctx.config.texRoot || ctx.paths.tex);

  const preflight = (): string | null => {
    const skill = ctx.config.skillDir;
    if (!skill || !existsSync(join(skill, 'scripts', 'style_check.py'))) {
      return `the hep-paper-writing skill was not found (no scripts/style_check.py under ${skill || '(unset)'}); style checks are off, AI-ese and claim-strength checks still run`;
    }
    const r = spawnSync(python, ['--version'], { stdio: 'ignore', timeout: 10_000 });
    if (r.error || r.status !== 0) return `${python} was not found; style checks are off, AI-ese and claim-strength checks still run`;
    return null;
  };

  const start = async (): Promise<void> => {
    stopped = false;
    if (sidecar) return;
    if (starting) return starting;
    lastStartAttempt = Date.now();
    starting = (async () => {
      const why = preflight();
      unavailable = why !== null;
      if (why) {
        reason = why;
        ctx.log.warn(`lint: ${why}`);
        return;
      }
      try {
        sidecar = await startSidecar({ skillDir: ctx.config.skillDir, python, log: ctx.log });
        version = sidecar.version;
        reason = null;
      } catch (e) {
        sidecar = null;
        reason = `the lint sidecar did not start: ${e instanceof Error ? e.message : String(e)}`;
        ctx.log.warn(`lint: ${reason}`);
      }
    })().finally(() => {
      starting = null;
    });
    return starting;
  };

  /** The sidecar if it is up; one restart attempt per 30 s after a crash. */
  const getSidecar = async (): Promise<LintSidecarLike | null> => {
    if (stopped) return null;
    if (!sidecar && !starting && !unavailable && Date.now() - lastStartAttempt > 30_000) {
      await start();
    } else if (starting) {
      await starting;
    }
    return sidecar;
  };

  const sidecarFailed = (e: unknown) => {
    reason = `the lint sidecar failed: ${e instanceof Error ? e.message : String(e)}`;
    ctx.log.warn(`lint: ${reason}`);
    const sc = sidecar;
    sidecar = null;
    sc?.close().catch(() => undefined);
  };

  const fileLint = (file: string): FileLint => {
    let f = store.get(file);
    if (!f) store.set(file, (f = { sentences: new Map(), document: [] }));
    return f;
  };

  const loadDismissals = (file: string) => {
    if (loadedDismissals.has(file)) return;
    loadedDismissals.add(file);
    try {
      for (const f of ctx.db.lint(file)) if (f.dismissed) dismissed.add(f.id);
    } catch {
      /* no db (tests) */
    }
  };

  const withDismissed = (flags: LintFlag[]): LintFlag[] => flags.map((f) => (dismissed.has(f.id) ? { ...f, dismissed: true } : f));

  const known = (): string[] => {
    try {
      const out = new Set<string>();
      for (const t of ctx.facts.terminology()) {
        if (t.acronym && t.acronym.trim()) out.add(t.acronym.trim());
      }
      return [...out];
    } catch {
      return [];
    }
  };

  const docText = (file: string): string | null => {
    const d = ctx.docs.get(file);
    if (d) return d.text;
    try {
      const abs = safeJoin(texRoot(), file);
      return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, 'utf8') : null;
    } catch {
      return null;
    }
  };

  /** The main document's preamble (macro definitions for the sentence pass), cached by text. */
  let preambleCache: { text: string; preamble: string } | null = null;
  const preamble = (): string => {
    const main = (ctx.config.mainFile || 'main.tex').replace(/\\/g, '/').replace(/^\.\//, '');
    const text = docText(main);
    if (text === null) return '';
    if (preambleCache && preambleCache.text === text) return preambleCache.preamble;
    const i = text.indexOf('\\begin{document}');
    const pre = i > 0 ? shadowText(text.slice(0, i)) : '';
    preambleCache = { text, preamble: pre.length > 200_000 ? '' : pre };
    return preambleCache.preamble;
  };

  const unitSource = (u: SentenceUnit): string | null => {
    try {
      const t = ctx.docs.unitText(u.id);
      if (t !== null && t !== undefined) return t;
    } catch {
      /* fall through */
    }
    const text = docText(u.file);
    return text !== null && u.end <= text.length ? text.slice(u.start, u.end) : null;
  };

  const docVersion = (file: string): number => {
    try {
      return ctx.docs.get(file)?.version ?? 0;
    } catch {
      return 0;
    }
  };

  const toPlain = (latex: string): string => plainText(latex);

  const aieseFor = (u: SentenceUnit, src: string): LintFlag[] => {
    const found = aieseFlags(toPlain(src));
    const out: LintFlag[] = [];
    for (const a of found) {
      const isWord = a.kind === 'excess_vocab';
      const source = isWord ? 'aiese' : 'heuristic';
      const check = isWord ? 'excess_vocab' : 'ai_pattern';
      const msg = isWord
        ? `"${a.word}" is a marker of LLM-assisted writing${a.ratio !== null ? ` (excess frequency ratio ${a.ratio.toFixed(1)} after 2023, Kobak et al. 2025)` : ' (Kobak et al. 2025 excess-vocabulary list)'}; keep it only if it is the exact word you mean.`
        : `${a.label} (heuristic pattern, no measured rate)`;
      out.push({
        id: flagId(source, check, u.id, a.word, msg),
        sentenceId: u.id,
        check,
        source,
        msg,
        word: a.word,
        line: u.line,
        excerpt: null,
        corpusRate: null,
        userRate: null,
        severity: 'hint',
        dismissed: false,
      });
    }
    return out;
  };

  const gateContext = () => {
    let facts: Fact[] = [];
    let allowedCiteKeys: string[] = [];
    let knownLabels: string[] = [];
    try {
      facts = ctx.facts.all().filter((f) => !f.excluded);
    } catch {
      facts = [];
    }
    try {
      allowedCiteKeys = ctx.lit.bibKeys();
    } catch {
      allowedCiteKeys = [];
    }
    try {
      knownLabels = ctx.docs.labels();
    } catch {
      knownLabels = [];
    }
    return { facts, allowedCiteKeys, knownLabels };
  };

  const gateFor = (u: SentenceUnit, src: string, g: ReturnType<typeof gateContext>): LintFlag[] => {
    if (u.kind === 'footnote') return [];
    // gateSentence fails closed (a 'gate_error' block issue) instead of throwing.
    const res = gateSentence(src, { mode: 'draft', facts: g.facts, allowedCiteKeys: g.allowedCiteKeys, knownLabels: g.knownLabels, fictionalNumbers: [], claimedFactIds: u.facts, intentText: u.intentNote });
    return res.issues
      .filter((i) => i.code === 'claim_strength')
      .map((i) => {
        const word = i.raw ?? (i.start !== undefined && i.end !== undefined ? src.slice(i.start, i.end) : null);
        return {
          id: flagId('gate', 'claim_strength', u.id, word, i.message),
          sentenceId: u.id,
          check: 'claim_strength',
          source: 'gate' as const,
          msg: i.message,
          word,
          line: u.line,
          excerpt: null,
          corpusRate: null,
          userRate: null,
          severity: 'warn' as const,
          dismissed: false,
        };
      });
  };

  const styleFlag = (f: SidecarFlag, sentenceId: string | null, line: number | null, file: string): LintFlag => {
    const check = checkKey(f);
    const word = typeof f.word === 'string' && f.word ? f.word : null;
    return {
      id: flagId('style_check', check, sentenceId, word, f.msg, `line:${file}:${line ?? ''}`),
      sentenceId,
      check,
      source: 'style_check',
      msg: f.msg,
      word,
      line,
      excerpt: typeof f.excerpt === 'string' && f.excerpt ? f.excerpt : null,
      corpusRate: referenceRates[check] ?? null,
      userRate: userRates[check] ?? null,
      severity: WARN_CHECKS.has(check) ? 'warn' : 'hint',
      dismissed: false,
    };
  };

  const dedupe = (flags: LintFlag[]): LintFlag[] => {
    const seen = new Set<string>();
    return flags.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)));
  };

  // Latest sentence-pass sequence per unit, so a slow earlier pass never overwrites a newer one.
  let seq = 0;
  const latestSeq = new Map<string, number>();

  const lintUnits = async (file: string, units: SentenceUnit[]): Promise<void> => {
    const my = ++seq;
    const live = units.filter((u) => !u.orphaned && u.file === file);
    if (live.length === 0) return;
    for (const u of live) latestSeq.set(u.id, my);
    loadDismissals(file);
    const sources = new Map<string, string>();
    for (const u of live) {
      const s = unitSource(u);
      if (s !== null) sources.set(u.id, s);
    }
    const byUnit = new Map<string, LintFlag[]>();
    for (const u of live) byUnit.set(u.id, []);

    const sc = await getSidecar();
    if (sc) {
      const items = live.filter((u) => sources.has(u.id)).map((u) => ({ sid: u.id, text: sources.get(u.id)!, part: u.part }));
      if (items.length) {
        try {
          const pre = preamble();
          const flags = await sc.lintSentences(items, { known: known(), maxWords, ...(pre ? { preamble: pre } : {}) });
          const unitById = new Map(live.map((u) => [u.id, u]));
          for (const f of flags) {
            const u = typeof f.sid === 'string' ? unitById.get(f.sid) : undefined;
            if (!u) continue;
            byUnit.get(u.id)!.push(styleFlag(f, u.id, u.line, file));
          }
        } catch (e) {
          sidecarFailed(e);
        }
      }
    }
    const g = gateContext();
    for (const u of live) {
      const src = sources.get(u.id);
      if (src === undefined) continue;
      byUnit.get(u.id)!.push(...aieseFor(u, src), ...gateFor(u, src, g));
    }

    // Keep only units for which this is still the newest pass.
    const current = live.filter((u) => latestSeq.get(u.id) === my);
    if (current.length === 0) return;
    const fl = fileLint(file);
    const ids: string[] = [];
    let flags: LintFlag[] = [];
    for (const u of current) {
      const f = withDismissed(dedupe(byUnit.get(u.id) ?? []));
      fl.sentences.set(u.id, f);
      ids.push(u.id);
      flags = flags.concat(f);
    }
    try {
      ctx.db.setLint(file, flags, 'sentences', ids);
    } catch (e) {
      ctx.log.debug('lint: setLint (sentences) failed', String(e));
    }
    ctx.bus.emit({ type: 'lint.update', file, version: docVersion(file), flags, scope: 'sentences', sentenceIds: ids });
  };

  /* ---------------------------------- document pass ---------------------------------- */

  /** Files of the main document's \input tree, from the last flatten (refreshed every pass). */
  let mainTree: Set<string> | null = null;

  const mainRel = () => (ctx.config.mainFile || 'main.tex').replace(/\\/g, '/').replace(/^\.\//, '');

  const flattenFrom = (root: string) => flattenTex(root, { texRoot: texRoot(), read: docText, transform: (t) => shadowText(t) });

  const rootFor = (file: string): string => {
    const main = mainRel();
    if (file === main) return main;
    if (!mainTree) {
      try {
        mainTree = new Set(flattenFrom(main).files);
      } catch {
        mainTree = new Set([main]);
      }
    }
    return mainTree.has(file) ? main : file;
  };

  const unitSpans = (file: string): UnitSpan[] => {
    let units: SentenceUnit[] = [];
    try {
      units = ctx.docs.get(file)?.units ?? ctx.db.units(file);
    } catch {
      try {
        units = ctx.docs.get(file)?.units ?? [];
      } catch {
        units = [];
      }
    }
    const text = docText(file);
    const lineAt = text !== null ? lineTable(text) : null;
    return units
      .filter((u) => !u.orphaned)
      .map((u) => {
        const inText = text !== null && lineAt !== null && u.end <= text.length;
        const src = inText ? text.slice(u.start, u.end) : (unitSource(u) ?? '');
        const endLine = inText ? lineAt(Math.max(u.start, u.end - 1)) : u.line;
        return { id: u.id, line: u.line, endLine: Math.max(u.line, endLine), start: u.start, text: toPlain(src) };
      });
  };

  const runDocumentPass = async (root: string): Promise<void> => {
    const sc = await getSidecar();
    if (!sc) return;
    const flat = flattenFrom(root);
    if (root === mainRel()) mainTree = new Set(flat.files);
    if (!flat.text.trim()) return;
    let res: SidecarDocumentResult;
    try {
      res = await sc.lintDocument(flat.text, { known: known(), maxWords });
    } catch (e) {
      sidecarFailed(e);
      return;
    }
    userRates = res.rates;
    if (Object.keys(res.referenceRates).length) referenceRates = { ...FALLBACK_REFERENCE_RATES, ...res.referenceRates };
    const unitsByFile = new Map<string, UnitSpan[]>();
    for (const f of flat.files) unitsByFile.set(f, unitSpans(f));
    const perFile = new Map<string, LintFlag[]>();
    for (const f of flat.files) perFile.set(f, []);
    for (const f of res.flags) {
      const r = reconcileFlag(f, flat.lines, unitsByFile, root);
      if (!perFile.has(r.file)) perFile.set(r.file, []);
      perFile.get(r.file)!.push(styleFlag(f, r.sentenceId, r.line, r.file));
    }
    for (const [file, raw] of perFile) {
      loadDismissals(file);
      const flags = withDismissed(dedupe(raw));
      fileLint(file).document = flags;
      const ids = (unitsByFile.get(file) ?? []).map((u) => u.id);
      try {
        ctx.db.setLint(file, flags, 'document', ids);
      } catch (e) {
        ctx.log.debug('lint: setLint (document) failed', String(e));
      }
      ctx.bus.emit({ type: 'lint.update', file, version: docVersion(file), flags, scope: 'document', sentenceIds: ids });
    }
  };

  const inflight = new Map<string, Promise<void>>();
  const again = new Map<string, Promise<void>>();

  const lintDocumentNow = (file: string): Promise<void> => {
    const root = rootFor(file);
    const running = inflight.get(root);
    if (running) {
      // One follow-up pass shared by every request made while a pass runs.
      let next = again.get(root);
      if (!next) {
        next = running
          .catch(() => undefined)
          .then(() => {
            again.delete(root);
            return lintDocumentNow(root);
          });
        again.set(root, next);
      }
      return next;
    }
    const p = runDocumentPass(root)
      .catch((e) => ctx.log.warn(`lint: document pass for ${root} failed`, String(e)))
      .finally(() => inflight.delete(root));
    inflight.set(root, p);
    return p;
  };

  const timers = new Map<string, NodeJS.Timeout>();
  const scheduleDocument = (file: string) => {
    if (stopped) return;
    const root = rootFor(file);
    const t = timers.get(root);
    if (t) clearTimeout(t);
    const nt = setTimeout(() => {
      timers.delete(root);
      lintDocumentNow(root).catch(() => undefined);
    }, debounceMs);
    nt.unref?.();
    timers.set(root, nt);
  };

  const flags = (file: string): LintFlag[] => {
    loadDismissals(file);
    const fl = store.get(file);
    if (fl) {
      const all: LintFlag[] = [];
      for (const f of fl.sentences.values()) all.push(...f);
      all.push(...fl.document);
      return withDismissed(dedupe(all));
    }
    try {
      return withDismissed(dedupe(ctx.db.lint(file)));
    } catch {
      return [];
    }
  };

  const dismiss = (flagId: string) => {
    dismissed.add(flagId);
    for (const fl of store.values()) {
      for (const [sid, list] of fl.sentences) fl.sentences.set(sid, list.map((f) => (f.id === flagId ? { ...f, dismissed: true } : f)));
      fl.document = fl.document.map((f) => (f.id === flagId ? { ...f, dismissed: true } : f));
    }
    try {
      ctx.db.dismissLint(flagId);
    } catch (e) {
      ctx.log.debug('lint: dismissLint failed', String(e));
    }
  };

  const stop = async () => {
    stopped = true;
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    const sc = sidecar;
    sidecar = null;
    reason = 'stopped';
    if (sc) await sc.close().catch(() => undefined);
  };

  return {
    start,
    stop,
    lintUnits,
    scheduleDocument,
    lintDocumentNow,
    flags,
    dismiss,
    status: () => ({ sidecar: sidecar !== null, reason: sidecar ? null : reason, styleCheckVersion: version }),
  };
}
