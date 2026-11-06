/**
 * AgentService: the read-only Agent SDK agents of paper-copilot (docs/design.md, "Grounding pipeline",
 * "Draft-then-review mode", "Skill and voice system").
 *
 * - readRepo   repo-reader (models.reader): repo_brief.md + fact candidates as LOCATORS (the facts
 *              service reads the values) + figure inventory and terminology merged into the stores.
 * - framings   outliner (models.drafter): three alternative framings, only after the author filled the
 *              five items; appended as ai-proposed, never adopted automatically.
 * - draft      drafter (models.drafter): MCP tools over the outline/plan/facts/literature, prose only
 *              through propose_paragraph, judged by the PostToolUse faithfulness gate; ONE draft.proposed
 *              event at the end. One resumable session per paper (kv 'drafter.session').
 * - referee    at most four questions per section into questions.json (never into the paper).
 * - updateMemo the CIPHER-style voice memo from >= 10 new substantive edit pairs.
 *
 * FAKE MODE (ctx.fakeLlm) never loads the SDK; fake.ts produces deterministic labelled outputs that go
 * through the same post-processing, gate and storage code.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  DraftParagraph,
  FramingsOutput,
  MemoOutput,
  Outline,
  RefereeOutput,
  RepoBriefOutput,
  buildSystemBlocks,
  draftTask,
  emptyOutline,
  extractFictionalNumbers,
  framingsTask,
  gateSentence,
  hashString,
  memoTask,
  outputJsonSchema,
  refereeTask,
  repoReaderTask,
  shortId,
} from '@paper-copilot/core';
import type {
  DraftRequest,
  EditPair,
  Fact,
  FigureEntry,
  JobKind,
  OutlineParagraph,
  OutlineSection,
  PromptBlock,
  RefereeQuestion,
  SentenceUnit,
  TaskKind,
  TermEntry,
} from '@paper-copilot/core';
import type { HookCallbackMatcher, HookEvent, McpServerConfig, PostToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import type { z } from 'zod';
import { HttpError, type AgentService, type Ctx, type DocState } from '../../contracts';
import { safeJoin } from '../../infra';
import { DraftCollector, MAX_PARAGRAPH_ATTEMPTS, PROPOSE_TOOL, createGateHook, type GateEnv, type PlannedParagraph, type Verdict } from './collector';
import { EDITOR_TOOL_NAMES, buildEditorServer, editorHandlers, type EditorContext } from './editor';
import { fakeFramings, fakeMemo, fakeParagraph, fakeReferee, fakeRepoBrief, fakeRevise, simLabel, unsupportedSentence, type FakeDraftHint, type Lang } from './fake';
import { createReadOnlyGuard } from './guard';
import { ROLE_LIMITS, SKILL_NAME, buildQueryOptions, draftMaxTurns, type AgentRole } from './options';
import { MAX_QUESTIONS, createMutex, readQuestions } from './questions';
import { loadSdk, runAgentQuery, type RunOutcome } from './runner';
import { ensureSkillLink, readSkillReferences } from './skill';
import { deltaTotals, isEmpty, toCoreUsage, totalsByModel, type TokenTotals } from './usage';

type DraftReq = z.infer<typeof DraftRequest>;
type Progress = (message: string) => void;

export interface AgentServiceOptions {
  /** Steers the fake drafter (tests). A per-request `fakeHint` on the DraftRequest object overrides it. */
  fakeHint?: { draft?: FakeDraftHint };
  /** Environment for the Claude Code process (default: process.env). */
  baseEnv?: Record<string, string | undefined>;
}

export interface AgentServiceExt extends AgentService {
  /** Abort every running agent query (server shutdown). */
  abortAll(): void;
}

/** kv key of the drafter session; value: StoredSession JSON. */
export const DRAFTER_SESSION_KEY = 'drafter.session';
/** kv key: number of edit pairs already summarized by the memo. */
export const MEMO_CURSOR_KEY = 'memo.pairCursor';
export const MEMO_MIN_PAIRS = 10;
export const MEMO_MIN_DISTANCE = 0.1;
export const MEMO_MAX_WORDS = 400;
const MAX_BRIEF_CHARS = 24_000;

interface StoredSession {
  sessionId: string;
  promptHash: string;
  model: string;
  totals: Record<string, TokenTotals>;
  updatedAt: string;
}

/** Corpus/section vocabulary used by the voice service for a skill template. */
export function sectionTypeOf(template: string | null | undefined, title = ''): string {
  const t = `${template ?? ''} ${title}`.toLowerCase();
  if (/abstract/.test(t)) return 'abstract';
  if (/intro/.test(t)) return 'intro';
  if (/conclu|summary|outlook/.test(t)) return 'concl';
  if (/result/.test(t)) return 'results';
  if (/caption/.test(t)) return 'caption';
  return 'body';
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** The unit a referee's sentence hint points at: containment first, then token overlap >= 0.5. */
export function matchSentenceHint(hint: string | null | undefined, units: Array<{ id: string; text: string }>): string | null {
  if (!hint || !hint.trim()) return null;
  const h = norm(hint);
  if (h.length >= 12) {
    for (const u of units) {
      const t = norm(u.text);
      if (t.includes(h) || (t.length >= 12 && h.includes(t))) return u.id;
    }
  }
  const ht = new Set(h.split(' ').filter((w) => w.length > 2));
  if (ht.size === 0) return null;
  let best: { id: string; score: number } | null = null;
  for (const u of units) {
    const ut = new Set(norm(u.text).split(' ').filter((w) => w.length > 2));
    let inter = 0;
    for (const w of ht) if (ut.has(w)) inter++;
    const score = inter / (ht.size + ut.size - inter || 1);
    if (score >= 0.5 && (!best || score > best.score)) best = { id: u.id, score };
  }
  return best?.id ?? null;
}

/** Keep whole lines up to `maxWords` words. */
export function capWords(text: string, maxWords: number): string {
  const out: string[] = [];
  let words = 0;
  for (const line of text.split('\n')) {
    const w = line.split(/\s+/).filter(Boolean).length;
    if (words + w > maxWords && out.length > 0) break;
    out.push(line);
    words += w;
  }
  return out.join('\n').trimEnd() + '\n';
}

function sha256File(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/** Where draft.proposed should insert when no anchor sentence was given. */
export function insertionPoint(state: DocState, sectionId: string): number {
  const units = state.units.filter((u) => u.sectionId === sectionId && !u.orphaned);
  if (units.length) return Math.max(...units.map((u) => u.end));
  const heading = state.seg.sections.find((s) => s.id === sectionId);
  if (heading) {
    const text = state.text;
    const lineEnd = (from: number) => {
      const i = text.indexOf('\n', from);
      return i < 0 ? text.length : i;
    };
    let end = lineEnd(heading.start);
    // Keep a \label{..} line that follows the heading above the new text.
    if (end < text.length) {
      const nextEnd = lineEnd(end + 1);
      if (/^\s*\\label\{[^}]*\}\s*$/.test(text.slice(end + 1, nextEnd))) end = nextEnd;
    }
    return end;
  }
  const endDoc = state.text.lastIndexOf('\\end{document}');
  return endDoc >= 0 ? endDoc : state.text.length;
}

export function createAgentService(ctx: Ctx, opts: AgentServiceOptions = {}): AgentServiceExt {
  const lang = (): Lang => ctx.config.notesLanguage;
  const running = new Map<string, string>();
  const controllers = new Set<AbortController>();
  const outlineWrite = createMutex();
  const questionsWrite = createMutex();
  const memKv = new Map<string, string>();

  /* -------------------------------- small helpers -------------------------------- */

  const kvGet = (key: string): string | undefined => {
    try {
      return ctx.db.kvGet(key);
    } catch {
      return memKv.get(key);
    }
  };
  const kvSet = (key: string, value: string): void => {
    try {
      ctx.db.kvSet(key, value);
    } catch (e) {
      ctx.log.warn(`kv ${key} kept in memory only`, String(e));
      memKv.set(key, value);
    }
  };
  const readOutline = () => ctx.files.readJson(ctx.paths.outline, Outline, emptyOutline());

  /**
   * Start a job unless one with the same key is running: 'reuse' returns the running job's id (the
   * same request again), 'conflict' refuses with 409 (a different request would race on shared state).
   */
  function startJob(kind: JobKind, key: string, onBusy: 'reuse' | 'conflict', run: (progress: Progress, jobId: string) => Promise<unknown>): string {
    const existing = running.get(key);
    if (existing) {
      const j = ctx.jobs.get(existing);
      if (j && (j.state === 'queued' || j.state === 'running')) {
        if (onBusy === 'reuse') return existing;
        throw new HttpError(409, `A ${kind} job is already running (${existing}); wait for it to finish.`);
      }
      running.delete(key);
    }
    const holder = { id: '' };
    holder.id = ctx.jobs.start(kind, async (progress) => {
      try {
        return await run(progress, holder.id || shortId('job-'));
      } finally {
        if (running.get(key) === holder.id) running.delete(key);
      }
    });
    running.set(key, holder.id);
    return holder.id;
  }

  async function ensureSkill(progress: Progress, required: boolean): Promise<void> {
    const dir = ctx.config.skillDir;
    if (!dir) {
      if (required) throw new Error('No hep-paper-writing skill directory is configured (skillDir in .paper/project.json).');
      return;
    }
    const r = await ensureSkillLink(ctx.paths.claudeCwd, dir);
    if (r.action !== 'ok') progress(`skill link ${r.action}: ${r.link} -> ${r.target}`);
    if (!r.skillFound) {
      if (required) throw new Error(`The ${SKILL_NAME} skill was not found at ${r.target} (no SKILL.md).`);
      progress(`warning: no SKILL.md at ${r.target}`);
    }
  }

  let fictionalCache: { stamp: string; numbers: string[] } | null = null;
  function fictionalNumbers(): string[] {
    const refs = readSkillReferences(ctx.config.skillDir);
    const stamp = hashString(Object.entries(refs).map(([k, v]) => k + v.length + hashString(v)).join('|'));
    if (fictionalCache?.stamp !== stamp) fictionalCache = { stamp, numbers: extractFictionalNumbers(refs) };
    return fictionalCache.numbers;
  }

  function gateEnv(planFactIds: string[]): GateEnv {
    const byId = new Map<string, Fact>();
    for (const f of [...ctx.facts.forPrompt({ factIds: planFactIds, limit: 100_000 }), ...ctx.facts.all()]) if (!f.excluded && !byId.has(f.id)) byId.set(f.id, f);
    return {
      facts: [...byId.values()],
      allowedCiteKeys: ctx.lit.allowedKeys().map((k) => k.key),
      knownLabels: ctx.docs.labels(),
      fictionalNumbers: fictionalNumbers(),
    };
  }

  async function docState(file: string): Promise<DocState> {
    return ctx.docs.get(file) ?? (await ctx.docs.open(file));
  }

  function sectionUnits(sectionId: string): Array<{ id: string; text: string; state: string; paragraphId: string; move: string | null }> {
    return ctx.docs
      .allUnits()
      .filter((u: SentenceUnit) => u.sectionId === sectionId && !u.orphaned)
      .map((u) => ({ id: u.id, text: ctx.docs.unitText(u.id) ?? '', state: u.state, paragraphId: u.paragraphId, move: u.move }));
  }

  function sectionText(units: Array<{ text: string; paragraphId: string }>): string {
    const paras: string[][] = [];
    let last: string | null = null;
    for (const u of units) {
      if (u.paragraphId !== last) paras.push([]);
      last = u.paragraphId;
      paras[paras.length - 1]!.push(u.text);
    }
    return paras.map((p) => p.join(' ')).join('\n\n');
  }

  /* ------------------------------ real-mode plumbing ------------------------------ */

  /** System prompt text: the LLM service's shared blocks, or the same core builder locally. */
  function systemPrompt(task: TaskKind, o: { sectionType: string; template?: string | null; query?: string; factIds?: string[] }): string {
    let blocks: PromptBlock[];
    try {
      blocks = ctx.llm.systemFor(task, o);
    } catch (e) {
      ctx.log.warn(`llm.systemFor unavailable (${String(e)}); building the ${task} prompt locally`);
      blocks = localSystemBlocks(task, o);
    }
    return blocks.map((b) => b.text).join('\n\n');
  }

  function localSystemBlocks(task: TaskKind, o: { sectionType: string; template?: string | null; query?: string; factIds?: string[] }): PromptBlock[] {
    const tryOr = <T>(fn: () => T, fb: T): T => {
      try {
        return fn();
      } catch {
        return fb;
      }
    };
    const dir = ctx.config.skillDir;
    const skillMd = tryOr(() => readFileSync(`${dir}/SKILL.md`, 'utf8'), '');
    const references = readSkillReferences(dir);
    return buildSystemBlocks({
      task,
      skill: { dir, skillMd, references, version: hashString(skillMd + Object.values(references).join('')) },
      memo: tryOr(() => ctx.voice.memo(), ''),
      authorNorms: tryOr(() => ctx.voice.authorNormsTable(), ''),
      notesLanguage: lang(),
      repoBrief: ctx.files.readText(ctx.paths.repoBrief) ?? '',
      litBrief: tryOr(() => ctx.lit.brief(), ''),
      outline: readOutline(),
      terminology: tryOr(() => ctx.facts.terminology(), []),
      citeKeys: tryOr(() => ctx.lit.allowedKeys(), []),
      facts: tryOr(() => ctx.facts.forPrompt({ factIds: o.factIds, query: o.query, limit: 200 }), []),
      exemplars: tryOr(() => ctx.voice.exemplars(o.sectionType, o.query ?? '', 6), []),
      sectionType: o.sectionType,
    });
  }

  function recordUsage(outcome: RunOutcome, route: string, prev?: Record<string, TokenTotals>): void {
    for (const [model, totals] of Object.entries(totalsByModel(outcome.modelUsage))) {
      const delta = deltaTotals(totals, prev?.[model]);
      if (isEmpty(delta)) continue;
      try {
        ctx.llm.recordUsage(model, toCoreUsage(delta), route);
      } catch (e) {
        ctx.log.warn(`cost not recorded for ${model}`, String(e));
      }
    }
  }

  async function runReal(
    role: AgentRole,
    r: {
      task: TaskKind;
      prompt: string;
      system: string;
      model: string;
      route: string;
      structured: boolean;
      maxTurns?: number;
      mcpServers?: Record<string, McpServerConfig>;
      mcpTools?: string[];
      hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
      resume?: string | null;
      persistSession?: boolean;
      prevTotals?: Record<string, TokenTotals>;
      progress: Progress;
    },
  ): Promise<RunOutcome> {
    const cfg = ctx.config;
    const abortController = new AbortController();
    controllers.add(abortController);
    const guard = createReadOnlyGuard(
      {
        roots: [
          ...(cfg.repoDir ? [{ dir: cfg.repoDir, kind: 'repo' as const }] : []),
          { dir: cfg.texRoot, kind: 'tex' },
          { dir: ctx.paths.claudeCwd, kind: 'claude' },
          { dir: cfg.skillDir, kind: 'skill' },
        ],
        repoGlobs: [...new Set([...cfg.readerGlobs, ...cfg.factGlobs])],
        mcpTools: r.mcpTools ?? [],
        skills: [SKILL_NAME],
        cwd: ctx.paths.claudeCwd,
      },
      (tool, d) => {
        if (!d.allow) {
          ctx.log.info(`${role}: denied ${tool}`, d.reason);
          r.progress(`denied ${tool}: ${d.reason}`);
        }
      },
    );
    const options = buildQueryOptions({
      role,
      model: r.model,
      claudeCwd: ctx.paths.claudeCwd,
      repoDir: cfg.repoDir,
      texRoot: cfg.texRoot,
      skillDir: cfg.skillDir,
      systemPrompt: r.system,
      outputSchema: r.structured ? outputJsonSchema(r.task) : null,
      maxBudgetUsd: cfg.maxBudgetUsd,
      maxTurns: r.maxTurns ?? ROLE_LIMITS[role].maxTurns,
      guard,
      mcpServers: r.mcpServers,
      mcpTools: r.mcpTools,
      hooks: r.hooks,
      resume: r.resume ?? null,
      persistSession: r.persistSession ?? false,
      abortController,
      baseEnv: opts.baseEnv ?? process.env,
      stderr: (d) => ctx.log.debug(`claude[${role}] ${d.trimEnd()}`),
    });
    try {
      const outcome = await runAgentQuery({ label: role, prompt: r.prompt, options, timeoutMs: ROLE_LIMITS[role].timeoutMs, progress: r.progress, log: ctx.log });
      recordUsage(outcome, r.route, r.prevTotals);
      r.progress(`${role} finished: ${outcome.subtype}, ${outcome.numTurns} turns, about $${outcome.costUsd.toFixed(2)}`);
      return outcome;
    } finally {
      controllers.delete(abortController);
    }
  }

  /** Run a one-shot structured role and validate its output. */
  async function structured<T>(
    role: AgentRole,
    task: TaskKind,
    schema: z.ZodType<T>,
    r: { prompt: string; system: string; model: string; route: string; progress: Progress },
  ): Promise<{ value: T; outcome: RunOutcome }> {
    const outcome = await runReal(role, { ...r, task, structured: true });
    if (!outcome.ok) throw new Error(`${role} failed: ${outcome.errors.join('; ') || outcome.subtype}`);
    const parsed = schema.safeParse(outcome.structured);
    if (!parsed.success) throw new Error(`${role} returned output that does not match the ${task} schema: ${parsed.error.message.slice(0, 400)}`);
    return { value: parsed.data, outcome };
  }

  /* ----------------------------------- readRepo ----------------------------------- */

  async function applyRepoBrief(out: RepoBriefOutput, progress: Progress, source: { model: string; simulated: boolean }) {
    const repoDir = ctx.config.repoDir!;
    let brief = out.brief_markdown.trim();
    if (brief.length > MAX_BRIEF_CHARS) brief = `${brief.slice(0, MAX_BRIEF_CHARS)}\n\n(truncated to ${MAX_BRIEF_CHARS} characters)`;
    if (out.unknowns.length && !/^#+\s.*unknown/im.test(brief)) brief += `\n\n## Unknowns\n\n${out.unknowns.map((u) => `- ${u}`).join('\n')}`;
    const header = `<!-- repo brief by ${source.simulated ? 'simulated reader' : source.model}, ${new Date().toISOString()}. Fact values are read by code at their locators, never from this text. -->\n`;
    await ctx.files.writeText(ctx.paths.repoBrief, header + brief + '\n');
    progress(`wrote ${ctx.paths.repoBrief}`);

    // Fact candidates: locators only. Refuse paths that leave the repository before the facts service sees them.
    const rejected: Array<{ candidate: unknown; reason: string }> = [];
    const inRepo = out.fact_candidates.filter((c) => {
      try {
        safeJoin(repoDir, c.artifact);
        return true;
      } catch (e) {
        rejected.push({ candidate: c, reason: `artifact path rejected: ${e instanceof Error ? e.message : String(e)}` });
        return false;
      }
    });
    const res = inRepo.length ? await ctx.facts.addCandidates(inRepo) : { added: [], rejected: [] };
    rejected.push(...res.rejected);
    progress(`registered ${res.added.length} fact candidates (${rejected.length} rejected)`);

    // Figures: existence and SHA-256 are checked by code, not taken from the model.
    const existing = ctx.facts.figures();
    const figures: FigureEntry[] = existing.map((f) => ({ ...f }));
    let figuresAdded = 0;
    for (const fig of out.figures) {
      let abs: string;
      try {
        abs = safeJoin(repoDir, fig.path);
      } catch {
        continue;
      }
      const sha = existsSync(abs) ? sha256File(abs) : null;
      const status: FigureEntry['status'] = sha ? 'exists' : 'needs_run';
      const prev = figures.find((f) => f.path === fig.path);
      if (prev) {
        prev.sha256 = sha;
        prev.status = status;
        if (!prev.job.trim()) prev.job = fig.job;
      } else {
        const base = fig.path.split('/').pop()!.replace(/\.[^.]+$/, '');
        let id = `fig:${base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'figure'}`;
        while (figures.some((f) => f.figureId === id)) id += '-2';
        figures.push({ figureId: id, label: null, path: fig.path, sha256: sha, producerScript: null, claimIds: [], captionSentenceIds: [], status, job: fig.job });
        figuresAdded++;
      }
    }
    await ctx.facts.saveFigures(figures);

    // Terminology: the author's entries win; new terms are added once.
    const terms: TermEntry[] = ctx.facts.terminology().map((t) => ({ ...t }));
    let termsAdded = 0;
    for (const t of out.terminology) {
      const m = t.term.trim().match(/^(.+?)\s*\(([A-Za-z][A-Za-z0-9-]{1,11})\)$/);
      const term = (m ? m[1]! : t.term).trim();
      if (!term || terms.some((x) => x.term.toLowerCase() === term.toLowerCase())) continue;
      terms.push({ term, definition: t.definition.trim(), acronym: m ? m[2]! : null, firstUseSentenceId: null, variants: [], symbol: null });
      termsAdded++;
    }
    await ctx.facts.saveTerminology(terms);
    progress(`figures: ${figuresAdded} new (${figures.length} in all); terms: ${termsAdded} new`);

    return {
      brief: ctx.paths.repoBrief,
      facts: { added: res.added.map((f) => f.id), rejected },
      figures: figuresAdded,
      terms: termsAdded,
      unknowns: out.unknowns,
      simulated: source.simulated,
    };
  }

  function readRepo(): string {
    const repoDir = ctx.config.repoDir;
    if (!repoDir) throw new HttpError(409, 'No analysis repository is configured (repoDir in .paper/project.json).');
    if (!existsSync(repoDir)) throw new HttpError(409, `The analysis repository ${repoDir} does not exist.`);
    return startJob('read-repo', 'read-repo', 'reuse', async (progress) => {
      await ensureSkill(progress, !ctx.fakeLlm);
      if (ctx.fakeLlm) {
        progress(`${simLabel(lang())}reading the README and the file inventory`);
        const out = RepoBriefOutput.parse(fakeRepoBrief({ repoDir, globs: ctx.config.readerGlobs, factGlobs: ctx.config.factGlobs, lang: lang() }));
        return applyRepoBrief(out, progress, { model: 'simulated', simulated: true });
      }
      progress('repo reader started (read-only)');
      const model = ctx.config.models.reader;
      const { value, outcome } = await structured('repo-reader', 'repo_reader', RepoBriefOutput, {
        prompt: repoReaderTask({ globs: ctx.config.readerGlobs, notesLanguage: lang() }),
        system: systemPrompt('repo_reader', { sectionType: 'body' }),
        model,
        route: 'reader',
        progress,
      });
      const result = await applyRepoBrief(value, progress, { model, simulated: false });
      return { ...result, costUsd: outcome.costUsd, turns: outcome.numTurns };
    });
  }

  /* ----------------------------------- framings ----------------------------------- */

  function framings(): string {
    if (!readOutline().authorFilled) {
      throw new HttpError(409, 'Write the five outline items first (story, gap and enabler, ladder, figures, headline); framings are proposed only after the author has written them.');
    }
    return startJob('outline-framings', 'outline-framings', 'reuse', async (progress) => {
      const outline = readOutline();
      if (!outline.authorFilled) throw new Error('The five outline items are not filled in.');
      let out: FramingsOutput;
      let costUsd = 0;
      if (ctx.fakeLlm) {
        progress(`${simLabel(lang())}rearranging the author's five items into three framings`);
        out = FramingsOutput.parse(fakeFramings(outline, lang()));
      } else {
        await ensureSkill(progress, true);
        progress('outliner started');
        const r = await structured('outliner', 'framings', FramingsOutput, {
          prompt: framingsTask({ outline, notesLanguage: lang() }),
          system: systemPrompt('framings', { sectionType: 'intro', template: 'introduction' }),
          model: ctx.config.models.drafter,
          route: 'drafter',
          progress,
        });
        out = r.value;
        costUsd = r.outcome.costUsd;
      }
      const proposed = out.framings.map((f) => ({ text: f.text.trim(), why: f.why.trim() })).filter((f) => f.text).slice(0, 3);
      if (proposed.length === 0) throw new Error('The outliner returned no framing.');
      return outlineWrite(async () => {
        // Re-read: the author may have edited the outline while the agent ran.
        const latest = readOutline();
        const seen = new Set(latest.framings.map((f) => norm(f.text)));
        const added = proposed
          .filter((f) => !seen.has(norm(f.text)))
          .map((f) => ({ id: shortId('fr-'), text: f.text, provenance: 'ai-proposed' as const, adopted: false, why: f.why }));
        const next = Outline.parse({ ...latest, framings: [...latest.framings, ...added.map(({ why: _w, ...f }) => f)] });
        await ctx.files.writeJson(ctx.paths.outline, next);
        ctx.bus.emit({ type: 'plan.updated', outline: next });
        progress(`added ${added.length} framings`);
        return { framings: added, simulated: ctx.fakeLlm, costUsd };
      });
    });
  }

  /* ------------------------------------- draft ------------------------------------ */

  function draftPlan(req: DraftReq): { section: OutlineSection; paragraphs: OutlineParagraph[] } {
    const outline = readOutline();
    const section = outline.sections.find((s) => s.id === req.sectionId);
    if (!section) throw new HttpError(404, `Unknown outline section "${req.sectionId}".`);
    let paragraphs = section.paragraphs;
    if (req.paragraphIds) {
      const unknown = req.paragraphIds.filter((id) => !section.paragraphs.some((p) => p.pid === id));
      if (unknown.length) throw new HttpError(400, `Unknown paragraph ids in section "${section.id}": ${unknown.join(', ')}.`);
      paragraphs = section.paragraphs.filter((p) => req.paragraphIds!.includes(p.pid));
    }
    if (paragraphs.length === 0) throw new HttpError(409, `Section "${section.id}" has no paragraph plans to draft; add paragraph jobs in the Outline first.`);
    return { section, paragraphs };
  }

  function readSession(): StoredSession | null {
    const raw = kvGet(DRAFTER_SESSION_KEY);
    if (!raw) return null;
    try {
      const s = JSON.parse(raw) as StoredSession;
      return typeof s.sessionId === 'string' && typeof s.promptHash === 'string' ? { ...s, totals: s.totals ?? {} } : null;
    } catch {
      return null;
    }
  }

  async function fakeDraft(
    req: DraftReq,
    section: OutlineSection,
    paragraphs: OutlineParagraph[],
    collector: DraftCollector,
    env: () => GateEnv,
    handlers: ReturnType<typeof editorHandlers>,
    gateHook: ReturnType<typeof createGateHook>,
    last: { verdict: Verdict | null },
    progress: Progress,
  ): Promise<void> {
    const hint: FakeDraftHint = { ...(opts.fakeHint?.draft ?? {}), ...((req as DraftReq & { fakeHint?: FakeDraftHint }).fakeHint ?? {}) };
    progress(`${simLabel(lang())}drafting ${paragraphs.length} paragraphs from the plan and the fact renderings`);
    const e = env();
    const fails = (text: string) => !gateSentence(text, { mode: 'draft', ...e }).ok;
    const bad = hint.unsupported || hint.retryFixes ? unsupportedSentence(fails) : null;
    const signal = new AbortController().signal;
    for (const [idx, p] of paragraphs.entries()) {
      let input = fakeParagraph({ section, paragraph: p, facts: e.facts, allowedKeys: e.allowedCiteKeys, fromNotes: req.fromNotes, lang: lang(), extraSentence: idx === 0 ? bad : null });
      for (let k = 0; k < MAX_PARAGRAPH_ATTEMPTS; k++) {
        const toolUseId = `fake-${p.pid}-${k}`;
        const response = handlers.propose_paragraph(input, toolUseId);
        const hookInput: PostToolUseHookInput = {
          hook_event_name: 'PostToolUse',
          session_id: 'simulated',
          transcript_path: '',
          cwd: ctx.paths.claudeCwd,
          tool_name: PROPOSE_TOOL,
          tool_input: input,
          tool_response: [{ type: 'text', text: response }],
          tool_use_id: toolUseId,
        };
        last.verdict = null;
        await gateHook(hookInput, toolUseId, { signal });
        const v = last.verdict as Verdict | null;
        if (!v || v.status !== 'retry') break;
        input = fakeRevise(input, v, (t) => hint.unsupported === true && t === bad);
      }
    }
  }

  function draft(req: DraftReq): string {
    try {
      safeJoin(ctx.config.texRoot, req.file);
    } catch (e) {
      throw new HttpError(400, `Invalid file "${req.file}": ${e instanceof Error ? e.message : String(e)}`);
    }
    const { section, paragraphs } = draftPlan(req);
    return startJob('draft', 'draft', 'conflict', async (progress, jobId) => {
      await ensureSkill(progress, !ctx.fakeLlm);
      const state = await docState(req.file);
      const planned: PlannedParagraph[] = paragraphs.map((p) => ({ pid: p.pid, job: p.job, intentNotes: p.intentNotes }));
      const planFactIds = [...new Set(paragraphs.flatMap((p) => p.plan.remaining.flatMap((s) => s.factIds)))];
      let envCache: GateEnv | null = null;
      const env = () => (envCache ??= gateEnv(planFactIds));
      const collector = new DraftCollector(planned, env);
      const last: { verdict: Verdict | null } = { verdict: null };
      const gateHook = createGateHook(collector, (v) => {
        last.verdict = v;
        progress(`${v.pid ?? '?'}: ${v.status}${v.failing.length ? ` (${v.failing.length} sentences failed the gate)` : ''}`);
      });
      const editorCtx: EditorContext = {
        outline: readOutline,
        facts: (o) => ctx.facts.forPrompt(o),
        sentences: sectionUnits,
        allowedKeys: () => ctx.lit.allowedKeys(),
        litRecord: (key) => ctx.lit.records().find((r) => r.key === key),
        collector,
      };
      const handlers = editorHandlers(editorCtx);
      let outcome: RunOutcome | null = null;

      if (ctx.fakeLlm) {
        await fakeDraft(req, section, paragraphs, collector, env, handlers, gateHook, last, progress);
      } else {
        const sdk = await loadSdk();
        const editor = buildEditorServer(sdk, editorCtx);
        const existing = sectionText(sectionUnits(section.id));
        const prompt = draftTask({ section, paragraphs, fromNotes: req.fromNotes, notesLanguage: lang(), existing });
        const system = systemPrompt('draft', {
          sectionType: sectionTypeOf(section.template, section.title),
          template: section.template,
          query: [section.title, section.question, ...paragraphs.map((p) => p.job)].join(' '),
          factIds: planFactIds,
        });
        const model = ctx.config.models.drafter;
        const promptHash = hashString(`${model}\n${system}`);
        const stored = readSession();
        const resumable = stored && stored.promptHash === promptHash && stored.model === model ? stored : null;
        const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = { PostToolUse: [{ matcher: PROPOSE_TOOL, hooks: [gateHook] }] };
        const run = (resume: StoredSession | null) =>
          runReal('drafter', {
            task: 'draft',
            prompt,
            system,
            model,
            route: 'drafter',
            structured: false,
            maxTurns: draftMaxTurns(paragraphs.length),
            mcpServers: { editor },
            mcpTools: EDITOR_TOOL_NAMES,
            hooks,
            resume: resume?.sessionId ?? null,
            persistSession: true,
            prevTotals: resume?.totals,
            progress,
          });
        progress(resumable ? `drafter resumes session ${resumable.sessionId}` : 'drafter started (new session)');
        outcome = await run(resumable);
        if (resumable && !outcome.ok && !outcome.sawAssistant) {
          progress('the stored drafting session could not be resumed; starting a new one');
          outcome = await run(null);
        }
        if (outcome.sessionId) {
          const s: StoredSession = { sessionId: outcome.sessionId, promptHash, model, totals: totalsByModel(outcome.modelUsage), updatedAt: new Date().toISOString() };
          kvSet(DRAFTER_SESSION_KEY, JSON.stringify(s));
        }
      }

      collector.finalize();
      const drafted = collector.paragraphs();
      const missing = collector.remaining();
      if (drafted.length === 0) {
        const why = outcome && !outcome.ok ? outcome.errors.join('; ') || outcome.subtype : 'no paragraph was proposed';
        throw new Error(`Drafting produced no paragraph: ${why}.`);
      }
      // Validate the event payload with the wire schema before it reaches clients.
      DraftParagraph.array().parse(drafted);

      let afterSentenceId = req.afterSentenceId;
      if (afterSentenceId && !state.units.some((u) => u.id === afterSentenceId)) {
        progress(`anchor sentence ${afterSentenceId} is not in ${req.file}; inserting at the end of the section instead`);
        afterSentenceId = null;
      }
      const latest = ctx.docs.get(req.file) ?? state;
      const insertAt = afterSentenceId ? null : insertionPoint(latest, section.id);
      ctx.bus.emit({ type: 'draft.proposed', jobId, file: req.file, afterSentenceId, insertAt, version: latest.version, paragraphs: drafted });

      const sentences = drafted.flatMap((p) => p.sentences);
      const unsupported = sentences.filter((s) => s.state === 'unsupported').length;
      progress(`proposed ${drafted.length} paragraphs, ${sentences.length} sentences (${unsupported} unsupported)${missing.length ? `; not drafted: ${missing.join(', ')}` : ''}`);
      return {
        paragraphs: drafted.length,
        sentences: sentences.length,
        unsupported,
        missing,
        partial: missing.length > 0,
        stoppedBy: outcome && !outcome.ok ? outcome.subtype : null,
        sessionId: outcome?.sessionId ?? null,
        costUsd: outcome?.costUsd ?? 0,
        simulated: ctx.fakeLlm,
      };
    });
  }

  /* ------------------------------------ referee ----------------------------------- */

  function referee(sectionId: string): string {
    if (!sectionId || !sectionId.trim()) throw new HttpError(400, 'sectionId is required.');
    return startJob('referee', `referee:${sectionId}`, 'reuse', async (progress) => {
      const main = ctx.config.mainFile;
      if (!ctx.docs.get(main)) await ctx.docs.open(main);
      const units = sectionUnits(sectionId).filter((u) => u.text.trim());
      if (units.length === 0) throw new Error(`Section "${sectionId}" has no sentences to review yet.`);
      const outlineTitle = readOutline().sections.find((s) => s.id === sectionId)?.title;
      const segTitle = ctx.docs.get(main)?.seg.sections.find((s) => s.id === sectionId)?.title;
      const title = outlineTitle || segTitle || sectionId;
      let out: RefereeOutput;
      let costUsd = 0;
      if (ctx.fakeLlm) {
        progress(`${simLabel(lang())}asking about baselines and conditions in "${title}"`);
        out = RefereeOutput.parse(fakeReferee(units, lang()));
      } else {
        await ensureSkill(progress, true);
        progress(`referee reading "${title}" (${units.length} sentences)`);
        const r = await structured('referee', 'referee', RefereeOutput, {
          prompt: refereeTask({ sectionTitle: title, sectionText: sectionText(units), notesLanguage: lang() }),
          system: systemPrompt('referee', { sectionType: sectionTypeOf(null, title), query: title }),
          model: ctx.config.models.drafter,
          route: 'drafter',
          progress,
        });
        out = r.value;
        costUsd = r.outcome.costUsd;
      }
      const questions: RefereeQuestion[] = out.questions
        .filter((q) => q.question.trim())
        .slice(0, MAX_QUESTIONS)
        .map((q) => ({ id: shortId('q-'), sectionId, sentenceId: matchSentenceHint(q.sentence_hint, units), question: q.question.trim(), estimate: q.estimate?.trim() || null }));
      await questionsWrite(async () => {
        const all = readQuestions(ctx.files, ctx.paths.questions);
        all[sectionId] = questions;
        await ctx.files.writeJson(ctx.paths.questions, all);
      });
      progress(`${questions.length} questions saved for "${title}"`);
      return { sectionId, questions, simulated: ctx.fakeLlm, costUsd };
    });
  }

  function questions(sectionId?: string): RefereeQuestion[] {
    const all = readQuestions(ctx.files, ctx.paths.questions);
    if (sectionId) return all[sectionId] ?? [];
    return Object.values(all).flat();
  }

  /* -------------------------------------- memo ------------------------------------ */

  function updateMemo(): string {
    return startJob('memo', 'memo', 'reuse', async (progress) => {
      const pairs = ctx.voice.editPairs();
      let cursor = Number.parseInt(kvGet(MEMO_CURSOR_KEY) ?? '0', 10);
      if (!Number.isFinite(cursor) || cursor < 0 || cursor > pairs.length) cursor = 0;
      const fresh: EditPair[] = pairs.slice(cursor).filter((p) => !p.grammarOnly && p.editDistance > MEMO_MIN_DISTANCE);
      if (fresh.length < MEMO_MIN_PAIRS) {
        progress(`not enough new edits (${fresh.length} of ${MEMO_MIN_PAIRS})`);
        return { updated: false, reason: 'not enough new edits', newPairs: fresh.length, needed: MEMO_MIN_PAIRS };
      }
      const current = ctx.voice.memo();
      let out: MemoOutput;
      let costUsd = 0;
      if (ctx.fakeLlm) {
        progress(`${simLabel(lang())}summarizing ${fresh.length} edit pairs`);
        out = MemoOutput.parse(fakeMemo(current, fresh, lang()));
      } else {
        await ensureSkill(progress, true);
        const r = await structured('memo', 'memo', MemoOutput, {
          prompt: memoTask({ currentMemo: current, pairs: fresh }),
          system: systemPrompt('memo', { sectionType: 'body' }),
          model: ctx.config.models.actions,
          route: 'memo',
          progress,
        });
        out = r.value;
        costUsd = r.outcome.costUsd;
      }
      const memo = capWords(out.memo_markdown.trim(), MEMO_MAX_WORDS);
      if (!memo.trim()) throw new Error('The memo agent returned an empty memo; the current memo is kept.');
      await ctx.voice.setMemo(memo);
      kvSet(MEMO_CURSOR_KEY, String(pairs.length));
      const words = memo.split(/\s+/).filter(Boolean).length;
      progress(`memo updated from ${fresh.length} edit pairs (${words} words)`);
      return { updated: true, pairs: fresh.length, words, simulated: ctx.fakeLlm, costUsd };
    });
  }

  return {
    readRepo,
    framings,
    draft,
    referee,
    updateMemo,
    questions,
    abortAll() {
      for (const c of controllers) c.abort();
    },
  };
}
