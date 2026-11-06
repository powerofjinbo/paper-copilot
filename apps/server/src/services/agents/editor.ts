/**
 * The drafter's in-process MCP server `editor`. The model reads the outline, plan, facts, existing
 * sentences and literature through these tools and returns prose only through `propose_paragraph`,
 * which the PostToolUse gate hook judges (collector.ts).
 *
 * Handlers are plain functions over an EditorContext (unit-testable without the SDK); buildEditorServer
 * wraps them with the SDK's tool()/createSdkMcpServer() in real mode only.
 */
import { frozenOutline, renderFact } from '@paper-copilot/core';
import type { Fact, LitRecord, Outline } from '@paper-copilot/core';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { EDITOR_SERVER, provisionalResult, type DraftCollector } from './collector';

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk');

export const EDITOR_TOOLS = ['get_outline', 'get_plan', 'get_facts', 'get_sentences', 'get_lit', 'lookup_cite', 'propose_paragraph'] as const;
export const EDITOR_TOOL_NAMES: string[] = EDITOR_TOOLS.map((t) => `mcp__${EDITOR_SERVER}__${t}`);

export interface EditorContext {
  outline(): Outline;
  facts(opts: { factIds?: string[]; query?: string; limit?: number }): Fact[];
  /** Units of a section in document order. */
  sentences(sectionId: string): Array<{ id: string; text: string; state: string; paragraphId: string; move: string | null }>;
  allowedKeys(): Array<{ key: string; title: string }>;
  litRecord(key: string): LitRecord | undefined;
  collector: DraftCollector;
}

const MAX_FACTS = 40;

function json(v: unknown): string {
  return JSON.stringify(v, null, 1);
}

export function factLine(f: Fact): { id: string; rendering: string; kind: string; unit: string; definition: string; validation: string; aliases: string[]; stale: boolean } {
  let rendering: string;
  try {
    rendering = renderFact(f);
  } catch {
    rendering = `${f.id} = ${String(f.value)}${f.unit ? ` ${f.unit}` : ''}`;
  }
  return { id: f.id, rendering, kind: f.kind, unit: f.unit, definition: f.definition, validation: f.validationState, aliases: f.aliases.slice(0, 6), stale: f.stale };
}

export function editorHandlers(ec: EditorContext) {
  return {
    get_outline(): string {
      const o = ec.outline();
      try {
        return frozenOutline(o);
      } catch {
        return json({ story: o.story, gap: o.gap, enabler: o.enabler, contrast: o.contrast, ladder: o.ladder, headline: o.headline, sections: o.sections.map((s) => ({ id: s.id, title: s.title, question: s.question, jobs: s.paragraphs.map((p) => p.job) })) });
      }
    },
    get_plan(args: { section_id: string }): string {
      const section = ec.outline().sections.find((s) => s.id === args.section_id);
      if (!section) return `Unknown section "${args.section_id}". Sections: ${ec.outline().sections.map((s) => s.id).join(', ') || '(none)'}.`;
      return json({
        id: section.id,
        title: section.title,
        question: section.question,
        template: section.template,
        paragraphs: section.paragraphs.map((p) => ({
          pid: p.pid,
          job: p.job,
          moves: p.moves,
          claim_ids: p.claimIds,
          intent_notes: p.intentNotes,
          said: p.plan.said,
          remaining: p.plan.remaining.map((st) => ({ intent: st.intent, fact_ids: st.factIds, cite_keys: st.citeKeys, move: st.move })),
        })),
      });
    },
    get_facts(args: { query?: string; ids?: string[] }): string {
      const facts = ec.facts({ factIds: args.ids, query: args.query, limit: MAX_FACTS }).slice(0, MAX_FACTS);
      if (facts.length === 0) return 'No facts match. Do not write a number for this; use a [fact?: description] placeholder.';
      return json({
        rule: 'Write numbers only at one of these renderings (or an alias). Never compute or round a new number.',
        facts: facts.map(factLine),
      });
    },
    get_sentences(args: { section_id: string }): string {
      const units = ec.sentences(args.section_id);
      if (units.length === 0) return `Section "${args.section_id}" has no sentences yet.`;
      return json(units.map((u) => ({ id: u.id, paragraph: u.paragraphId, state: u.state, move: u.move, text: u.text })));
    },
    get_lit(): string {
      const keys = ec.allowedKeys();
      if (keys.length === 0) return 'No citation keys are resolved yet. Write [ref] where a citation is needed.';
      return json({ rule: 'Cite only these keys, exactly as written: \\cite{key}.', keys });
    },
    lookup_cite(args: { key: string }): string {
      const rec = ec.litRecord(args.key);
      const allowed = ec.allowedKeys().some((k) => k.key === args.key);
      if (!rec) return `No entry "${args.key}" in the bibliography. Do not cite it; write [ref].`;
      return json({
        key: rec.key,
        allowed,
        status: rec.status,
        title: rec.title,
        authors: rec.authors,
        year: rec.year,
        arxiv: rec.arxiv,
        abstract: rec.abstract ? rec.abstract.slice(0, 1200) : null,
        quotable: rec.quotable.slice(0, 5),
        note: allowed ? 'This key may be cited.' : 'This key is not resolved; citing it turns into [ref].',
      });
    },
    propose_paragraph(args: unknown, toolUseId: string | null): string {
      ec.collector.recordPending(toolUseId, args);
      return provisionalResult((args ?? {}) as { pid?: unknown; sentences?: unknown });
    },
  };
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

function toolUseIdOf(extra: unknown): string | null {
  const meta = (extra as { _meta?: Record<string, unknown> } | null)?._meta;
  const id = meta?.['claudecode/toolUseId'];
  return typeof id === 'string' ? id : null;
}

/** Real mode: wrap the handlers as an in-process SDK MCP server. */
export function buildEditorServer(sdk: Sdk, ec: EditorContext): McpSdkServerConfigWithInstance {
  const h = editorHandlers(ec);
  const ro = { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } };
  const sentence = z.object({
    text: z.string().describe('One English sentence of LaTeX, exactly as it should appear in the paper.'),
    move: z.string().nullable().optional().describe('The rhetorical move from the plan (e.g. "gap", "result").'),
    fact_ids: z.array(z.string()).optional().describe('Ids of every fact whose number appears in the sentence.'),
    cite_keys: z.array(z.string()).optional(),
    placeholders: z.array(z.string()).optional(),
    note_zh: z.string().nullable().optional().describe('A short note for the author in the notes language.'),
    referee_question: z.string().nullable().optional(),
  });
  const tools = [
    sdk.tool('get_outline', 'The frozen outline: story, gap, enabler, ladder, headline and section jobs.', {}, async () => text(h.get_outline()), ro),
    sdk.tool('get_plan', 'The paragraph plans of one section: jobs, moves, claim ids, intent notes and remaining steps with fact ids.', { section_id: z.string() }, async (a) => text(h.get_plan(a)), ro),
    sdk.tool('get_facts', 'Facts (numbers, cuts, definitions) with their allowed renderings. Filter by ids and/or a text query.', { query: z.string().optional(), ids: z.array(z.string()).optional() }, async (a) => text(h.get_facts(a)), ro),
    sdk.tool('get_sentences', 'The existing sentences of a section, with ids and states.', { section_id: z.string() }, async (a) => text(h.get_sentences(a)), ro),
    sdk.tool('get_lit', 'Citation keys that may be cited, with titles.', {}, async () => text(h.get_lit()), ro),
    sdk.tool('lookup_cite', 'Details of one bibliography entry and whether it may be cited.', { key: z.string() }, async (a) => text(h.lookup_cite(a)), ro),
    sdk.tool(
      'propose_paragraph',
      'Propose one whole paragraph (one sentence per entry). A faithfulness gate checks every sentence and answers with the verdict; fix and re-propose when asked.',
      { pid: z.string().describe('Paragraph id from get_plan.'), job: z.string().describe("The paragraph's job, as in the plan."), sentences: z.array(sentence) },
      async (a, extra) => text(h.propose_paragraph(a, toolUseIdOf(extra))),
      { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
    ),
  ];
  return sdk.createSdkMcpServer({ name: EDITOR_SERVER, version: '1.0.0', tools, alwaysLoad: true });
}
