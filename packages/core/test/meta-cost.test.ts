import { describe, expect, it } from 'vitest';
import { CostMeter, PRICES, costOf, priceFor, usageTokens, type Usage } from '../src/meta/index';

const u = (p: Partial<Usage>): Usage => ({ input_tokens: 0, output_tokens: 0, ...p });

describe('PRICES', () => {
  it('holds the list prices of the doc comment (USD per million tokens)', () => {
    expect(PRICES['claude-haiku-5-5']).toEqual({
      input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2,
      longThreshold: 100_000,
      long: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1.0 },
    });
    expect(PRICES['claude-sonnet-5-5']).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 });
    expect(PRICES['claude-opus-5-5']).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 });
    expect(PRICES['claude-fable-5-1']).toEqual({ input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 });
  });
});

describe('costOf', () => {
  it('prices a warm ghost call on Haiku (the design estimate)', () => {
    // 1,500 uncached x 0.10 + 27,000 cache reads x 0.01 + 60 out x 0.50 = 150 + 270 + 30 = 450 per 1e6 -> $0.00045.
    // 80 such calls an hour = $0.036, under the design's "about $0.05 including block writes".
    expect(costOf('claude-haiku-5-5', u({ input_tokens: 1500, cache_read_input_tokens: 27_000, output_tokens: 60 }))).toBeCloseTo(0.00045, 12);
  });

  it('bills cache writes by TTL from the cache_creation split, ignoring the total', () => {
    // 1,000 in x 0.10 + 8,000 5m-writes x 0.125 + 12,000 1h-writes x 0.20 + 100 out x 0.50
    // = 100 + 1,000 + 2,400 + 50 = 3,550 -> $0.00355. (The total 20,000 is not billed again.)
    const usage = u({ input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 20_000, cache_creation: { ephemeral_5m_input_tokens: 8000, ephemeral_1h_input_tokens: 12_000 } });
    expect(costOf('claude-haiku-5-5', usage)).toBeCloseTo(0.00355, 12);
    // Even when the split disagrees with the total, the split wins: 5m 0, 1h 20,000 -> 100 + 4,000 + 50 = 4,150.
    expect(costOf('claude-haiku-5-5', u({ input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 20_000 } }))).toBeCloseTo(0.00415, 12);
  });

  it('bills the cache_creation total at the 5-minute price when there is no split', () => {
    // 1,000 x 0.10 + 20,000 x 0.125 + 100 x 0.50 = 100 + 2,500 + 50 = 2,650 -> $0.00265.
    const base = { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 20_000 };
    expect(costOf('claude-haiku-5-5', u(base))).toBeCloseTo(0.00265, 12);
    expect(costOf('claude-haiku-5-5', u({ ...base, cache_creation: null }))).toBeCloseTo(0.00265, 12);
    // A split object whose fields are all null carries no split.
    expect(costOf('claude-haiku-5-5', u({ ...base, cache_creation: { ephemeral_5m_input_tokens: null, ephemeral_1h_input_tokens: null } }))).toBeCloseTo(0.00265, 12);
  });

  it('counts cached tokens toward the Haiku 100k long-context threshold', () => {
    // Prompt = 2,000 uncached + 99,000 cache reads = 101,000 > 100,000, so every token takes the long price:
    // 2,000 x 0.50 + 99,000 x 0.05 + 100 x 2.50 = 1,000 + 4,950 + 250 = 6,200 -> $0.0062.
    // (Counting only the 2,000 uncached tokens would wrongly give 200 + 990 + 50 = 1,240 -> $0.00124.)
    expect(costOf('claude-haiku-5-5', u({ input_tokens: 2000, cache_read_input_tokens: 99_000, output_tokens: 100 }))).toBeCloseTo(0.0062, 12);
    // Cache writes count too: 1,000 in + 60,000 5m + 40,000 1h = 101,000 ->
    // 1,000 x 0.50 + 60,000 x 0.625 + 40,000 x 1.00 = 500 + 37,500 + 40,000 = 78,000 -> $0.078.
    expect(costOf('claude-haiku-5-5', u({ input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 60_000, ephemeral_1h_input_tokens: 40_000 } }))).toBeCloseTo(0.078, 12);
  });

  it('switches tiers only above the threshold', () => {
    // Exactly 100,000 cache reads: short tier, 100,000 x 0.01 = 1,000 -> $0.001.
    expect(costOf('claude-haiku-5-5', u({ cache_read_input_tokens: 100_000 }))).toBeCloseTo(0.001, 12);
    // 100,001: long tier, 100,001 x 0.05 = 5,000.05 -> $0.00500005.
    expect(costOf('claude-haiku-5-5', u({ cache_read_input_tokens: 100_001 }))).toBeCloseTo(0.00500005, 12);
    // Output tokens do not count toward the threshold: 1,000 in + 200,000 out stays short:
    // 1,000 x 0.10 + 200,000 x 0.50 = 100 + 100,000 -> $0.1001.
    expect(costOf('claude-haiku-5-5', u({ input_tokens: 1000, output_tokens: 200_000 }))).toBeCloseTo(0.1001, 12);
  });

  it('prices Sonnet, Opus and Fable (no long tier)', () => {
    // Sonnet: 10,000 x 2 + 1,000 x 10 + 50,000 x 0.20 + 5,000 x 4 (1h) = 20,000 + 10,000 + 10,000 + 20,000 = 60,000 -> $0.06.
    expect(costOf('claude-sonnet-5-5', u({ input_tokens: 10_000, output_tokens: 1000, cache_read_input_tokens: 50_000, cache_creation: { ephemeral_1h_input_tokens: 5000 } }))).toBeCloseTo(0.06, 12);
    // Sonnet has no long tier: 200,000 x 2 = 400,000 -> $0.40.
    expect(costOf('claude-sonnet-5-5', u({ input_tokens: 200_000 }))).toBeCloseTo(0.4, 12);
    // Opus: 1,000 x 4 + 1,000 x 20 = 24,000 -> $0.024.
    expect(costOf('claude-opus-5-5', u({ input_tokens: 1000, output_tokens: 1000 }))).toBeCloseTo(0.024, 12);
    // Fable: 1,000 x (10 + 50 + 0.25 + 12.50 + 20) = 92,750 -> $0.09275.
    expect(
      costOf('claude-fable-5-1', u({ input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 1000 } })),
    ).toBeCloseTo(0.09275, 12);
  });

  it('returns 0 for unknown models and accepts dated or tagged ids of known ones', () => {
    expect(costOf('gpt-9', u({ input_tokens: 1_000_000 }))).toBe(0);
    expect(costOf('claude-haiku-4-5', u({ input_tokens: 1_000_000 }))).toBe(0);
    expect(costOf('', u({ input_tokens: 1_000_000 }))).toBe(0);
    expect(costOf('claude-opus-5-5-20261101', u({ input_tokens: 1000 }))).toBeCloseTo(0.004, 12);
    expect(costOf('claude-sonnet-5-5[1m]', u({ input_tokens: 1000 }))).toBeCloseTo(0.002, 12);
    expect(priceFor('claude-opus-5-55')).toBeNull();
  });

  it('treats null, missing, negative and non-finite token counts as zero', () => {
    expect(costOf('claude-opus-5-5', u({ input_tokens: -5, output_tokens: Number.NaN, cache_read_input_tokens: null, cache_creation_input_tokens: undefined }))).toBe(0);
    expect(usageTokens(u({ input_tokens: 3, cache_read_input_tokens: 4, cache_creation: { ephemeral_5m_input_tokens: 5 } }))).toEqual({ input: 3, output: 0, cacheRead: 4, cacheWrite5m: 5, cacheWrite1h: 0, prompt: 12 });
  });
});

describe('CostMeter', () => {
  it('accumulates USD by route and model, requests and tokens', () => {
    const m = new CostMeter();
    // ghost: $0.00045 (see above); actions: Sonnet 1,000 in + 200 out = 2,000 + 2,000 = 4,000 -> $0.004.
    expect(m.add('claude-haiku-5-5', u({ input_tokens: 1500, cache_read_input_tokens: 27_000, output_tokens: 60 }), 'ghost')).toBeCloseTo(0.00045, 12);
    m.add('claude-haiku-5-5', u({ input_tokens: 1500, cache_read_input_tokens: 27_000, output_tokens: 60 }), 'ghost');
    expect(m.add('claude-sonnet-5-5', u({ input_tokens: 1000, output_tokens: 200 }), 'actions')).toBeCloseTo(0.004, 12);
    const t = m.totals();
    expect(t.usd).toBeCloseTo(0.0049, 12);
    expect(t.byRoute.ghost).toBeCloseTo(0.0009, 12);
    expect(t.byRoute.actions).toBeCloseTo(0.004, 12);
    expect(t.byModel['claude-haiku-5-5']).toBeCloseTo(0.0009, 12);
    expect(t.requests).toBe(3);
    expect(t.cacheReadTokens).toBe(54_000);
    expect(t.inputTokens).toBe(4000);
    expect(t.outputTokens).toBe(320);
  });

  it('counts unknown models as free requests and lists them', () => {
    const m = new CostMeter();
    expect(m.add('mystery-model', u({ input_tokens: 10, output_tokens: 5 }), 'reader')).toBe(0);
    const t = m.totals();
    expect(t.usd).toBe(0);
    expect(t.requests).toBe(1);
    expect(t.byModel['mystery-model']).toBe(0);
    expect(m.unknownModels()).toEqual(['mystery-model']);
  });

  it('returns copies from totals() and starts empty', () => {
    const m = new CostMeter();
    expect(m.totals()).toEqual({ usd: 0, byRoute: {}, byModel: {}, requests: 0, cacheReadTokens: 0, inputTokens: 0, outputTokens: 0 });
    m.add('claude-opus-5-5', u({ input_tokens: 1000 }), 'drafter');
    const t = m.totals();
    t.byRoute.drafter = 99;
    expect(m.totals().byRoute.drafter).toBeCloseTo(0.004, 12);
    m.reset();
    expect(m.totals().requests).toBe(0);
  });
});
