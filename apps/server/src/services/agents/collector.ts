/**
 * The drafter's faithfulness loop (docs/design.md, Draft-then-review mode, step 2).
 *
 * The drafter returns prose only through the `propose_paragraph` MCP tool. A PostToolUse hook on that
 * tool runs core `gateSentence` (mode 'draft') on every sentence and replaces the tool result with the
 * verdict (`updatedToolOutput`), so the model sees exactly which sentences failed and why:
 * - all sentences pass -> the paragraph is accepted atomically, sentences in state 'proposed';
 * - some fail -> the paragraph is refused for now and the model is asked to fix only those sentences;
 * - a sentence that failed twice is kept, never dropped: state 'unsupported', its gate issues attached
 *   and its text in the gate's `repaired` form, so an unmatched number or unknown citation never reaches
 *   the .tex (it becomes a visible `[fact?: ...]` / `[ref]` placeholder; the raw value is in the issue).
 * A paragraph is also closed after MAX_PARAGRAPH_ATTEMPTS proposals, whatever the per-sentence counts,
 * so a confused model cannot loop.
 *
 * The same class serves the fake drafter, so tests exercise the real decision code.
 */
import { gateSentence } from '@paper-copilot/core';
import type { DerivedRelation, DraftParagraph, DraftSentence, Fact, GateIssue, GateIssueWire, GateResult } from '@paper-copilot/core';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const EDITOR_SERVER = 'editor';
export const PROPOSE_TOOL = `mcp__${EDITOR_SERVER}__propose_paragraph`;

/** A sentence may fail the gate this many times before it is kept as 'unsupported'. */
export const MAX_SENTENCE_FAILURES = 2;
/** Hard cap on proposals per paragraph. */
export const MAX_PARAGRAPH_ATTEMPTS = 3;

const nullableStr = z.string().nullable().optional();
const strList = z.array(z.string()).optional();

/** Lenient parse of the tool input (the MCP layer already validated the declared shape). */
export const ProposeInput = z.object({
  pid: z.string(),
  job: z.string().optional(),
  sentences: z.array(
    z.object({
      text: z.string(),
      move: nullableStr,
      fact_ids: strList,
      cite_keys: strList,
      placeholders: strList,
      note_zh: nullableStr,
      referee_question: nullableStr,
    }),
  ),
});
export type ProposeInput = z.infer<typeof ProposeInput>;

export interface GateEnv {
  facts: Fact[];
  allowedCiteKeys: string[];
  knownLabels: string[];
  fictionalNumbers: string[];
  /** Derived numbers the gate accepts (facts.derived()); optional for older callers. */
  derived?: DerivedRelation[];
}

export interface PlannedParagraph {
  pid: string;
  job: string;
  /** The author's intent notes; numbers typed there pass the gate as 'unlinked'. */
  intentNotes: string[];
}

export interface Verdict {
  status: 'accepted' | 'retry' | 'refused';
  pid: string | null;
  /** What the model reads as the tool result. */
  message: string;
  paragraph?: DraftParagraph;
  /** Sentences that failed this attempt (index into the proposal) and the gate's repaired text. */
  failing: Array<{ index: number; repaired: string; codes: string[] }>;
}

type GateFn = (text: string, ctx: Parameters<typeof gateSentence>[1]) => GateResult;

function wire(i: GateIssue): GateIssueWire {
  const w: GateIssueWire = { code: i.code, severity: i.severity, message: i.message };
  if (typeof i.start === 'number') w.start = i.start;
  if (typeof i.end === 'number') w.end = i.end;
  if (typeof i.raw === 'string') w.raw = i.raw;
  return w;
}

const blocking = (r: GateResult): GateIssue[] => r.issues.filter((i) => i.severity === 'block');

export class DraftCollector {
  private readonly order: string[];
  private readonly planned = new Map<string, PlannedParagraph>();
  private readonly accepted = new Map<string, DraftParagraph>();
  private readonly attempts = new Map<string, number>();
  private readonly failures = new Map<string, Map<number, number>>();
  private readonly pending: Array<{ toolUseId: string | null; input: unknown }> = [];
  /** The latest proposal of each paragraph the gate sent back for a fix (the run may end before the fix). */
  private readonly lastRetry = new Map<string, unknown>();
  private env: GateEnv | null = null;
  /** Every verdict, in order (for job results and logs). */
  readonly log: Array<{ pid: string | null; status: Verdict['status']; failing: number }> = [];

  constructor(
    paragraphs: PlannedParagraph[],
    private readonly gateEnv: () => GateEnv,
    private readonly gate: GateFn = gateSentence,
  ) {
    this.order = paragraphs.map((p) => p.pid);
    for (const p of paragraphs) this.planned.set(p.pid, p);
  }

  private environment(): GateEnv {
    // Computed once per run: the gate must judge every attempt against the same facts and keys.
    this.env ??= this.gateEnv();
    return this.env;
  }

  remaining(): string[] {
    return this.order.filter((pid) => !this.accepted.has(pid));
  }

  done(): boolean {
    return this.remaining().length === 0;
  }

  /** Accepted paragraphs in outline order. */
  paragraphs(): DraftParagraph[] {
    return this.order.flatMap((pid) => {
      const p = this.accepted.get(pid);
      return p ? [p] : [];
    });
  }

  /** The tool handler records a proposal; the hook takes it. Anything left is judged by finalize(). */
  recordPending(toolUseId: string | null, input: unknown): void {
    this.pending.push({ toolUseId, input });
  }

  takePending(toolUseId: string | null | undefined, input: unknown): void {
    let idx = toolUseId ? this.pending.findIndex((p) => p.toolUseId === toolUseId) : -1;
    if (idx < 0) {
      const key = JSON.stringify(input);
      idx = this.pending.findIndex((p) => JSON.stringify(p.input) === key);
    }
    if (idx >= 0) this.pending.splice(idx, 1);
  }

  /**
   * Judge proposals whose hook never ran (as final attempts, so nothing is lost), then close every
   * paragraph whose last proposal was sent back for a fix that never came (the model stopped, or the
   * run hit its turn / budget / time limit): its passing sentences are kept as proposed and the failing
   * ones as unsupported with the gate's placeholders, instead of losing the whole paragraph.
   */
  finalize(): void {
    for (const p of this.pending.splice(0)) this.propose(p.input, { final: true });
    for (const pid of this.order) {
      const raw = this.lastRetry.get(pid);
      if (raw !== undefined && !this.accepted.has(pid)) this.propose(raw, { final: true });
    }
    this.lastRetry.clear();
  }

  private remainingNote(): string {
    const rest = this.remaining();
    return rest.length === 0
      ? 'All requested paragraphs are drafted. Do not call propose_paragraph again; end with a one-line summary.'
      : `Paragraphs still to draft, in order: ${rest.join(', ')}.`;
  }

  propose(raw: unknown, opts: { final?: boolean } = {}): Verdict {
    const parsed = ProposeInput.safeParse(raw);
    if (!parsed.success) {
      return this.finish({ status: 'refused', pid: null, message: `propose_paragraph input is malformed: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}` }, 0);
    }
    const input = parsed.data;
    const plan = this.planned.get(input.pid);
    if (!plan) {
      return this.finish({ status: 'refused', pid: input.pid, message: `Paragraph "${input.pid}" is not part of this request. Valid paragraph ids: ${this.order.join(', ')}. ${this.remainingNote()}` }, 0);
    }
    if (this.accepted.has(input.pid)) {
      return this.finish({ status: 'refused', pid: input.pid, message: `Paragraph "${input.pid}" was already accepted and is final. ${this.remainingNote()}` }, 0);
    }
    const sentences = input.sentences.map((s) => ({ ...s, text: s.text.trim() })).filter((s) => s.text.length > 0);
    if (sentences.length === 0) {
      return this.finish({ status: 'refused', pid: input.pid, message: `Paragraph "${input.pid}" has no sentences. Propose one sentence per array entry.` }, 0);
    }

    const attempt = (this.attempts.get(input.pid) ?? 0) + 1;
    this.attempts.set(input.pid, attempt);
    const env = this.environment();
    const intentText = plan.intentNotes.join('\n') || null;
    const results = sentences.map((s) =>
      this.gate(s.text, {
        mode: 'draft',
        facts: env.facts,
        allowedCiteKeys: env.allowedCiteKeys,
        knownLabels: env.knownLabels,
        fictionalNumbers: env.fictionalNumbers,
        derived: env.derived ?? [],
        intentText,
        claimedFactIds: s.fact_ids ?? [],
      }),
    );
    const failing = results.flatMap((r, i) => (r.ok ? [] : [i]));
    const counts = this.failures.get(input.pid) ?? new Map<number, number>();
    this.failures.set(input.pid, counts);
    for (const i of failing) counts.set(i, (counts.get(i) ?? 0) + 1);

    const failed = failing.map((i) => ({ index: i, repaired: results[i]!.repaired, codes: blocking(results[i]!).map((x) => x.code) }));
    const close =
      failing.length === 0 || opts.final === true || attempt >= MAX_PARAGRAPH_ATTEMPTS || failing.every((i) => (counts.get(i) ?? 0) >= MAX_SENTENCE_FAILURES);

    if (!close) {
      const lines = failing.map((i) => {
        const s = sentences[i]!;
        const issues = blocking(results[i]!).map((iss) => `    - ${iss.code}${iss.raw ? ` (${JSON.stringify(iss.raw)})` : ''}: ${iss.message}`);
        return `  Sentence ${i + 1}: ${JSON.stringify(s.text)}\n${issues.join('\n')}`;
      });
      const message = [
        `Faithfulness gate: paragraph "${input.pid}" NOT accepted yet (attempt ${attempt}). ${failing.length} of ${sentences.length} sentences failed:`,
        ...lines,
        'Fix only these sentences and keep the others verbatim. Use only numbers from get_facts (at the given renderings) and only cite keys from get_lit; where the data is missing, write a descriptive placeholder such as [fact?: what is missing] instead of a number.',
        `Then call propose_paragraph again with the whole paragraph (pid "${input.pid}"). A sentence that fails twice is kept as "unsupported" for the author to resolve.`,
      ].join('\n');
      this.lastRetry.set(input.pid, raw);
      return this.finish({ status: 'retry', pid: input.pid, message, failing: failed }, failing.length);
    }

    const out: DraftSentence[] = [];
    sentences.forEach((s, i) => {
      const r = results[i]!;
      const ok = r.ok;
      const text = ok ? s.text : r.repaired.trim();
      if (!text) return; // an empty sentence has nothing to keep
      out.push({
        text,
        move: s.move ?? null,
        factIds: [...new Set(r.factIds)],
        citeKeys: [...new Set(r.citeKeys)],
        placeholders: [...new Set(r.placeholders)],
        noteZh: s.note_zh ?? null,
        refereeQuestion: s.referee_question ?? null,
        state: ok ? 'proposed' : 'unsupported',
        issues: r.issues.map(wire),
      });
    });
    const paragraph: DraftParagraph = { pid: input.pid, job: plan.job.trim() || (input.job ?? '').trim(), sentences: out };
    this.accepted.set(input.pid, paragraph);
    this.lastRetry.delete(input.pid);
    const unsupported = out.filter((s) => s.state === 'unsupported').length;
    const message = [
      `Faithfulness gate: paragraph "${input.pid}" accepted with ${out.length} sentences${unsupported ? ` (${unsupported} kept as unsupported for the author: ${failing.map((i) => i + 1).join(', ')})` : ''}.`,
      this.remainingNote(),
    ].join(' ');
    return this.finish({ status: 'accepted', pid: input.pid, message, paragraph, failing: failed }, failing.length);
  }

  private finish(v: Omit<Verdict, 'failing'> & { failing?: Verdict['failing'] }, failing: number): Verdict {
    this.log.push({ pid: v.pid, status: v.status, failing });
    return { ...v, failing: v.failing ?? [] };
  }
}

/** Text the propose_paragraph handler returns; the gate hook replaces it with the verdict. */
export function provisionalResult(input: { pid?: unknown; sentences?: unknown }): string {
  const n = Array.isArray(input.sentences) ? input.sentences.length : 0;
  return `Received paragraph ${JSON.stringify(input.pid ?? '')} (${n} sentences). The faithfulness gate verdict replaces this message; if you can read this, the gate did not run and the paragraph will be checked when drafting ends.`;
}

/** The PostToolUse hook on mcp__editor__propose_paragraph. */
export function createGateHook(collector: DraftCollector, onVerdict?: (v: Verdict) => void): HookCallback {
  return async (input, toolUseId) => {
    if (input.hook_event_name !== 'PostToolUse' || input.tool_name !== PROPOSE_TOOL) return {};
    collector.takePending(input.tool_use_id ?? toolUseId ?? null, input.tool_input);
    const verdict = collector.propose(input.tool_input);
    onVerdict?.(verdict);
    // MCP tool output is a string or a list of content blocks; a text block list replaces it.
    return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: [{ type: 'text', text: verdict.message }] } };
  };
}
