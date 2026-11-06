# 0003. Ghost text uses direct Messages API calls; agentic work uses the Agent SDK

Status: accepted (2026-11-06), pending the Phase 0 latency benchmark

## Context
Ghost text must appear within about a second of a pause. Anthropic publishes no TTFT figures; a third-party
measurement puts claude-haiku-5-5 with thinking disabled at about 0.6 s to first token. The Agent SDK runs the
Claude Code loop in a subprocess and forwards no stream deltas from subagents.

## Decision
- Ghost text: stateless single-shot Messages API calls to claude-haiku-5-5, `thinking: {type: 'disabled'}`,
  effort low, structured output `{text, fact_ids, cite_keys, fulfilled_move_ids}`, painted atomically after the
  faithfulness gate. Triggered on a sentence boundary or a pause, never per keystroke.
- Rewrites, alternatives, grammar fixes, intent rendering and re-planning: claude-sonnet-5-5 with
  `thinking: {type: 'between_tools'}`, effort low.
- Repo reading, drafting, framings, referee questions: the Agent SDK with the author's skill loaded from disk
  (`settingSources: ['project']`, `skills: ['hep-paper-writing']`), read-only tools and a PreToolUse guard.
- Prompt layout identical for every route: block A (skill + memo, 1 h cache), block B (repo brief, frozen
  outline, facts, cite keys, 5 min), block C (exemplars, 5 min), then the volatile tail. Earlier turns are never
  edited (preserved thinking), so every sentence-level request is built from document state.

## Consequences
`scripts/bench/ttft.ts` must run on the author's laptop before auto-ghost is enabled by default
(decision rule: p50 total < 1.2 s and p95 < 2.0 s).
