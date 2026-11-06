/**
 * The REAL Agent SDK path (Claude Code process) against the local mock Messages API.
 *
 * COORDINATION NOTE (in progress, 2026-11-06 18:30 UTC): two "real-paths" agents are running on this
 * task in parallel. This one is writing this file and fixing apps/server/src/services/agents/**; it
 * leaves test/real-llm.test.ts, test/support/mockAnthropic.ts, test/support/llmFixtures.ts and
 * src/services/llm/** to the other agent (it uses mockAnthropic.ts read-only). Please do not overwrite
 * this file; if you need a change here, add it below this note.
 */
export {};
