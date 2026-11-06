/**
 * Cost meter: list prices in USD per million tokens and the cost of one Messages API response.
 *
 * Pricing rules implemented here (platform.claude.com pricing page, read 2026-11-06):
 * - `input_tokens` are the uncached prompt tokens, billed at `input`.
 * - `cache_read_input_tokens` are billed at `cacheRead`.
 * - Cache writes are billed by TTL: `cacheWrite5m` or `cacheWrite1h`. When the response carries the
 *   `cache_creation` split (ephemeral_5m_input_tokens / ephemeral_1h_input_tokens), the split is used and the
 *   total `cache_creation_input_tokens` is ignored; without the split the total is billed at the 5-minute
 *   price (the API's default TTL).
 * - Long-context tier (Haiku 5.5): when the whole prompt, input + cache reads + cache writes, is above
 *   `longThreshold` tokens, every token of that request (output included) uses the `long` prices.
 */

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** Prompts above this many tokens use the `long` prices (Haiku 5.5: 100k). */
  longThreshold?: number;
  long?: Omit<ModelPrice, 'longThreshold' | 'long'>;
}

/** Cache multipliers of the input price (claude-api skill, prompt-caching.md "Economics"). */
export const CACHE_MULTIPLIERS = { read: 0.1, write5m: 1.25, write1h: 2 } as const;
/** Per-model cache-read exceptions: Opus 5.5 reads at 0.05x, Fable 5.1 at 0.025x. */
const READ_MULTIPLIER: Record<string, number> = { 'claude-opus-5-5': 0.05, 'claude-fable-5-1': 0.025 };

const r12 = (x: number): number => Number(x.toPrecision(12));

/** Prices derived from the input/output list prices and the documented multipliers, so they cannot drift. */
function derive(model: string, input: number, output: number): Omit<ModelPrice, 'longThreshold' | 'long'> {
  const read = READ_MULTIPLIER[model] ?? CACHE_MULTIPLIERS.read;
  return { input, output, cacheRead: r12(input * read), cacheWrite5m: r12(input * CACHE_MULTIPLIERS.write5m), cacheWrite1h: r12(input * CACHE_MULTIPLIERS.write1h) };
}

/**
 * claude-haiku-5-5: 0.10 in / 0.50 out / 0.01 cache read / 0.125 write 5m / 0.20 write 1h; above 100k
 * prompt tokens 0.50 / 2.50 / 0.05 / 0.625 / 1.00. claude-sonnet-5-5: 2 / 10 / 0.20 / 2.50 / 4.
 * claude-opus-5-5: 4 / 20 / 0.20 (0.05x) / 5 / 8. claude-fable-5-1: 10 / 50 / 0.25 (0.025x) / 12.50 / 20.
 * (claude-api skill models.md and prompt-caching.md, read 2026-11-06: cache reads 0.1x input except
 * Opus 5.5 0.05x and Fable 5.1 0.025x; writes 1.25x for the 5-minute TTL, 2x for the 1-hour TTL.)
 */
export const PRICES: Record<string, ModelPrice> = {
  'claude-haiku-5-5': {
    ...derive('claude-haiku-5-5', 0.1, 0.5),
    longThreshold: 100_000,
    long: derive('claude-haiku-5-5', 0.5, 2.5),
  },
  'claude-sonnet-5-5': derive('claude-sonnet-5-5', 2, 10),
  'claude-opus-5-5': derive('claude-opus-5-5', 4, 20),
  'claude-fable-5-1': derive('claude-fable-5-1', 10, 50),
};

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
}

/** Token count from an API field: missing, null, negative or non-finite values count as 0. */
function tok(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The price entry for a model id. Exact ids first; then ids with a suffix after a known id (a dated
 * snapshot such as `claude-sonnet-5-5-20261001`, or a context-window tag such as `claude-sonnet-5-5[1m]`).
 * Unknown -> null.
 */
export function priceFor(model: string): ModelPrice | null {
  const exact = PRICES[model];
  if (exact) return exact;
  const id = model.trim().toLowerCase();
  let best: string | null = null;
  for (const key of Object.keys(PRICES)) {
    if (id === key || id.startsWith(key + '-') || id.startsWith(key + '[') || id.startsWith(key + '@')) {
      if (best === null || key.length > best.length) best = key;
    }
  }
  return best === null ? null : (PRICES[best] ?? null);
}

/** Token counts of one response by billing class (cache writes split by TTL). */
export function usageTokens(usage: Usage): { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; prompt: number } {
  const input = tok(usage.input_tokens);
  const output = tok(usage.output_tokens);
  const cacheRead = tok(usage.cache_read_input_tokens);
  const split = usage.cache_creation;
  const hasSplit =
    split != null &&
    ((typeof split.ephemeral_5m_input_tokens === 'number' && Number.isFinite(split.ephemeral_5m_input_tokens)) ||
      (typeof split.ephemeral_1h_input_tokens === 'number' && Number.isFinite(split.ephemeral_1h_input_tokens)));
  const cacheWrite5m = hasSplit ? tok(split?.ephemeral_5m_input_tokens) : tok(usage.cache_creation_input_tokens);
  const cacheWrite1h = hasSplit ? tok(split?.ephemeral_1h_input_tokens) : 0;
  return { input, output, cacheRead, cacheWrite5m, cacheWrite1h, prompt: input + cacheRead + cacheWrite5m + cacheWrite1h };
}

/** USD for one response. Unknown model -> 0 and the caller logs it. cache_creation split wins over the total. */
export function costOf(model: string, usage: Usage): number {
  const price = priceFor(model);
  if (!price) return 0;
  const t = usageTokens(usage);
  const p = price.long && price.longThreshold !== undefined && t.prompt > price.longThreshold ? price.long : price;
  return (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheWrite5m * p.cacheWrite5m + t.cacheWrite1h * p.cacheWrite1h) / 1e6;
}

/** Running totals for the status-bar meter (shape of api.ts CostTotals). */
export class CostMeter {
  private usd = 0;
  private byRoute: Record<string, number> = {};
  private byModel: Record<string, number> = {};
  private requests = 0;
  private cacheReadTokens = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private unknown = new Set<string>();

  /** Records one response and returns its cost in USD (0 for a model without a price; see `unknownModels`). */
  add(model: string, usage: Usage, route: string): number {
    const usd = costOf(model, usage);
    if (!priceFor(model)) this.unknown.add(model);
    const t = usageTokens(usage);
    this.usd += usd;
    this.byRoute[route] = (this.byRoute[route] ?? 0) + usd;
    this.byModel[model] = (this.byModel[model] ?? 0) + usd;
    this.requests += 1;
    this.cacheReadTokens += t.cacheRead;
    // Uncached prompt tokens, as the API reports `input_tokens`.
    this.inputTokens += t.input;
    this.outputTokens += t.output;
    return usd;
  }

  totals(): { usd: number; byRoute: Record<string, number>; byModel: Record<string, number>; requests: number; cacheReadTokens: number; inputTokens: number; outputTokens: number } {
    return {
      usd: this.usd,
      byRoute: { ...this.byRoute },
      byModel: { ...this.byModel },
      requests: this.requests,
      cacheReadTokens: this.cacheReadTokens,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    };
  }

  /** Model ids seen without a price entry (their cost was counted as 0). */
  unknownModels(): string[] {
    return [...this.unknown].sort();
  }

  reset(): void {
    this.usd = 0;
    this.byRoute = {};
    this.byModel = {};
    this.requests = 0;
    this.cacheReadTokens = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.unknown.clear();
  }
}
