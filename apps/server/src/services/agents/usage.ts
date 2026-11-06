/**
 * Agent SDK usage -> the core Usage shape the cost meter prices.
 *
 * `SDKResultMessage.modelUsage` is the per-model total of one query() call, and for a resumed session
 * it continues from the totals its transcript saved. So for a resumed drafter session the previous
 * totals are subtracted before reporting, or the cost meter would count earlier turns twice.
 */
import type { ModelUsage } from '@anthropic-ai/claude-agent-sdk';
import type { Usage } from '@paper-copilot/core';

/** The token counters we keep per model (a JSON-safe subset of ModelUsage). */
export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  cacheCreation1hInputTokens: number;
  costUsd: number;
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export function totalsOf(m: Partial<ModelUsage> | null | undefined): TokenTotals {
  return {
    inputTokens: n(m?.inputTokens),
    outputTokens: n(m?.outputTokens),
    cacheReadInputTokens: n(m?.cacheReadInputTokens),
    cacheCreationInputTokens: n(m?.cacheCreationInputTokens),
    cacheCreation1hInputTokens: n(m?.cacheCreationEphemeral1hInputTokens),
    costUsd: n(m?.costUSD),
  };
}

export function totalsByModel(modelUsage: Record<string, Partial<ModelUsage>> | null | undefined): Record<string, TokenTotals> {
  const out: Record<string, TokenTotals> = {};
  for (const [model, m] of Object.entries(modelUsage ?? {})) out[model] = totalsOf(m);
  return out;
}

const FIELDS: Array<keyof TokenTotals> = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'cacheCreation1hInputTokens', 'costUsd'];

/**
 * cur - prev per field. If any counter went down (a /clear or a transcript without saved totals reset
 * the running total), `cur` is already a fresh total and is returned unchanged.
 */
export function deltaTotals(cur: TokenTotals, prev: TokenTotals | undefined): TokenTotals {
  if (!prev) return { ...cur };
  if (FIELDS.some((f) => cur[f] < prev[f])) return { ...cur };
  const out = { ...cur };
  for (const f of FIELDS) out[f] = cur[f] - prev[f];
  return out;
}

export function isEmpty(t: TokenTotals): boolean {
  return FIELDS.every((f) => t[f] === 0);
}

/**
 * Core Usage for the cost meter. Cache writes the CLI could not attribute to a lifetime are priced at
 * the 5-minute rate (as the CLI's own costUSD does), so the 5m bucket is total minus the 1h bucket.
 */
export function toCoreUsage(t: TokenTotals): Usage {
  const h1 = Math.min(t.cacheCreation1hInputTokens, t.cacheCreationInputTokens);
  return {
    input_tokens: t.inputTokens,
    output_tokens: t.outputTokens,
    cache_read_input_tokens: t.cacheReadInputTokens,
    cache_creation_input_tokens: t.cacheCreationInputTokens,
    cache_creation: { ephemeral_5m_input_tokens: t.cacheCreationInputTokens - h1, ephemeral_1h_input_tokens: h1 },
  };
}
