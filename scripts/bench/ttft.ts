/**
 * Phase 0 latency harness for ghost text (docs/plan.md, "Phase 0").
 *
 *   npx tsx scripts/bench/ttft.ts [--runs 50] [--cold-runs 10] [--sizes 10k,27k,50k]
 *                                 [--models haiku,sonnet] [--dry-run] [--json out.json]
 *
 * For each model route and each cached-prefix size it measures, over N sequential requests:
 *   - warm: the prefix is in the cache (one priming request first; every run then reads it);
 *   - cold: a unique nonce at the start of block A forces a cache miss (and a cache write) per run.
 * Each request asks for one structured ghost sentence of about 40 output tokens, exactly like the ghost
 * route: Haiku 5.5 with thinking disabled and effort low; Sonnet 5.5 with thinking between_tools and
 * effort low; system blocks A (ttl 1h) and B (5 min) built from the real hep-paper-writing skill and the
 * fixture paper and analysis repo; JSON schema output; no retries.
 *
 * It prints p50/p95 of TTFT (first text delta) and of total time per configuration as a markdown table,
 * then the decision rule of the plan: p50 total < 1.2 s and p95 total < 2.0 s (warm, ~27k prefix) keeps
 * the pause trigger in auto-propose sections; otherwise ghost stays boundary-only there and on-demand
 * elsewhere.
 *
 * Requires an API key (ANTHROPIC_API_KEY, or the "paper-copilot" keychain entry); refuses to run
 * without one. Uses the public API unless PAPER_ANTHROPIC_BASE_URL is set (ANTHROPIC_BASE_URL is ignored).
 * Cold runs write the cache every time: the dry run prints the estimated cost first.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { LlmRequest, LlmResponse } from '../../apps/server/src/contracts';
import { createAnthropicSdk, createRealLlmClient, describeError } from '../../apps/server/src/services/llm/client';
import { resolveApiKey, resolveBaseUrl } from '../../apps/server/src/services/llm/apiKey';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..');

/* ------------------------------------------------------------------------------------ */
/* Shared with prewarm-format.ts                                                         */
/* ------------------------------------------------------------------------------------ */

export const MODELS = {
  haiku: { model: 'claude-haiku-5-5', thinking: 'disabled' as const, label: 'Haiku 5.5, thinking disabled, effort low' },
  sonnet: { model: 'claude-sonnet-5-5', thinking: 'between_tools' as const, label: 'Sonnet 5.5, thinking between_tools, effort low' },
};
export type ModelKey = keyof typeof MODELS;

/** Same shape as core GhostOutput / outputJsonSchema('ghost'): text first, all required, no extras. */
export const GHOST_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    fact_ids: { type: 'array', items: { type: 'string' } },
    cite_keys: { type: 'array', items: { type: 'string' } },
    fulfilled_move_ids: { type: 'array', items: { type: 'string' } },
  },
  required: ['text', 'fact_ids', 'cite_keys', 'fulfilled_move_ids'],
  additionalProperties: false,
};

/** Price per million tokens for the cost estimate (list prices, 2026-11-06). */
const PRICE: Record<string, { input: number; output: number; read: number; write1h: number; write5m: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, read: 0.01, write1h: 0.2, write5m: 0.125 },
  'claude-sonnet-5-5': { input: 2, output: 10, read: 0.1, write1h: 4, write5m: 2.5 },
};

export function requireKey(script: string): string {
  const { key } = resolveApiKey();
  if (!key) {
    process.stderr.write(
      `${script}: no Anthropic API key.\n` +
        'Set ANTHROPIC_API_KEY (export ANTHROPIC_API_KEY=sk-ant-...) or store it in the OS keychain under the service\n' +
        '"paper-copilot" (macOS: security add-generic-password -s paper-copilot -a "$USER" -w; Linux: secret-tool store\n' +
        "--label=paper-copilot service paper-copilot), then run again. This benchmark makes real API calls.\n",
    );
    process.exit(2);
  }
  return key;
}

function readIf(p: string): string {
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

/** Source text for the cached prefix: the real skill, then the fixture paper, bibliography and analysis repo notes. */
export function prefixSources(skillDir = process.env.PAPER_SKILL_DIR || join(REPO_ROOT, '.skill')): { a: string; b: string } {
  const refs = ['sentences-and-words.md', 'layering-and-flow.md', 'figures-and-evidence.md', 'story-and-structure.md'];
  const a = [readIf(join(skillDir, 'SKILL.md')), ...refs.map((r) => `<reference fictional_examples="true" name="${r}">\n${readIf(join(skillDir, 'references', r))}\n</reference>`)].join('\n\n');
  const fx = join(REPO_ROOT, 'fixtures', 'canto-demo');
  const b = [
    '<repo_brief>',
    readIf(join(fx, 'repo', 'README.md')),
    readIf(join(fx, 'repo', 'docs', 'definitions.md')),
    readIf(join(fx, 'repo', 'docs', 'paper_facts.md')),
    '</repo_brief>',
    '<paper_so_far>',
    readIf(join(fx, 'tex', 'main.tex')),
    '</paper_so_far>',
    '<bibliography>',
    readIf(join(fx, 'tex', 'refs.bib')),
    '</bibliography>',
  ].join('\n');
  if (a.length < 1000) throw new Error(`skill not found at ${skillDir} (set PAPER_SKILL_DIR)`);
  return { a, b };
}

/** Repeat/truncate to exactly n characters (repetition marked, so the model is not confused). */
function fit(text: string, n: number): string {
  if (n <= 0) return '';
  let out = text;
  let k = 2;
  while (out.length < n) out += `\n\n<!-- source repeated (${k++}) for prefix size -->\n\n` + text;
  return out.slice(0, n);
}

export const ROLE = 'You write one sentence at a time of a high-energy-physics paper in the author\'s voice, following the hep-paper-writing skill below. Never invent numbers or citations.';

/** System blocks A (ttl 1h, 60% of the size) and B (5 min, 40%) of about `chars` characters. */
export function buildPrefix(chars: number, nonce = ''): LlmRequest['system'] {
  const src = prefixSources();
  const aChars = Math.round(chars * 0.6);
  return [
    { type: 'text', text: `${nonce ? `<!-- run ${nonce} -->\n` : ''}${ROLE}\n\n${fit(src.a, aChars)}`, cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: fit(src.b, chars - aChars), cache_control: { type: 'ephemeral', ttl: '5m' } },
  ];
}

const PREFIXES = [
  'The efficiency gain',
  'We train the tracker',
  'On the isolated gun particles, the tracker',
  'The fake rate',
  'Compared with the baseline,',
  'This result',
];

export function ghostTailFor(i: number): string {
  const prefix = PREFIXES[i % PREFIXES.length]!;
  return [
    '<task>Continue the sentence the author is typing. Return JSON {text, fact_ids, cite_keys, fulfilled_move_ids}. `text` is the whole sentence and starts with the typed prefix verbatim. At most 35 words, about 30. No number that is not in the paper above.</task>',
    `<paragraph_before>We compare the two trackers on the same simulated events (run ${i}).</paragraph_before>`,
    `<prefix>${prefix}</prefix>`,
  ].join('\n');
}

export function ghostRequest(model: ModelKey, system: LlmRequest['system'], tail: string): LlmRequest {
  return { route: 'ghost', task: 'ghost', model: MODELS[model].model, system, messages: [{ role: 'user', content: tail }], maxTokens: 200, thinking: MODELS[model].thinking, effort: 'low', schema: GHOST_SCHEMA };
}

/* ------------------------------------------------------------------------------------ */
/* Statistics and output                                                                 */
/* ------------------------------------------------------------------------------------ */

export function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx]!;
}

interface Row {
  model: ModelKey;
  size: string;
  prefixTokens: number | null;
  cache: 'warm' | 'cold';
  runs: number;
  errors: number;
  ttft: number[];
  total: number[];
  cacheRead: number[];
  outTokens: number[];
  errorSample: string | null;
}

const fmtMs = (v: number | null) => (v === null ? 'n/a' : `${Math.round(v)}`);

function table(rows: Row[]): string {
  const lines = [
    '| model | prefix | tokens | cache | ok/runs | TTFT p50 ms | TTFT p95 ms | total p50 ms | total p95 ms | cache read (median) | output tok (median) |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    lines.push(
      `| ${MODELS[r.model].model} | ${r.size} | ${r.prefixTokens ?? '?'} | ${r.cache} | ${r.runs - r.errors}/${r.runs} | ${fmtMs(percentile(r.ttft, 50))} | ${fmtMs(percentile(r.ttft, 95))} | ${fmtMs(percentile(r.total, 50))} | ${fmtMs(percentile(r.total, 95))} | ${percentile(r.cacheRead, 50) ?? 'n/a'} | ${percentile(r.outTokens, 50) ?? 'n/a'} |`,
    );
  }
  return lines.join('\n');
}

export function decision(r: Row | undefined): { pass: boolean; text: string } {
  if (!r || r.total.length === 0) return { pass: false, text: 'no data' };
  const p50 = percentile(r.total, 50)!;
  const p95 = percentile(r.total, 95)!;
  const pass = p50 < 1200 && p95 < 2000;
  return {
    pass,
    text: `${MODELS[r.model].model} warm ${r.size}: p50 total ${Math.round(p50)} ms (< 1200?) and p95 total ${Math.round(p95)} ms (< 2000?) -> ${pass ? 'PASS: keep the pause trigger in auto-propose sections' : 'FAIL: boundary-only ghost in auto-propose sections, on-demand (Ctrl+Space) elsewhere'}`,
  };
}

/* ------------------------------------------------------------------------------------ */
/* Main                                                                                  */
/* ------------------------------------------------------------------------------------ */

interface Args {
  runs: number;
  coldRuns: number;
  sizes: string[];
  models: ModelKey[];
  dryRun: boolean;
  json: string | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { runs: 50, coldRuns: 10, sizes: ['10k', '27k', '50k'], models: ['haiku', 'sonnet'], dryRun: false, json: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--runs' && v) (a.runs = Math.max(1, Number(v) || 50)), i++;
    else if (k === '--cold-runs' && v) (a.coldRuns = Math.max(0, Number(v) || 0)), i++;
    else if (k === '--sizes' && v) (a.sizes = v.split(',').map((s) => s.trim()).filter(Boolean)), i++;
    else if (k === '--models' && v) (a.models = v.split(',').map((s) => s.trim()).filter((s): s is ModelKey => s in MODELS)), i++;
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--json' && v) (a.json = v), i++;
    else if (k === '--help' || k === '-h') {
      process.stdout.write('usage: npx tsx scripts/bench/ttft.ts [--runs 50] [--cold-runs 10] [--sizes 10k,27k,50k] [--models haiku,sonnet] [--dry-run] [--json out.json]\n');
      process.exit(0);
    } else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

/** "27k" -> 27000 tokens. */
export function sizeTokens(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*k$/i.exec(s.trim());
  const n = m ? Number(m[1]) * 1000 : Number(s);
  if (!Number.isFinite(n) || n < 1000) throw new Error(`bad size ${s}`);
  return Math.round(n);
}

function estimateUsd(a: Args): number {
  let usd = 0;
  for (const m of a.models) {
    const p = PRICE[MODELS[m].model]!;
    for (const s of a.sizes) {
      const t = sizeTokens(s);
      usd += (t * p.write1h) / 1e6; // priming write
      usd += (a.runs * (t * p.read + 120 * p.input + 60 * p.output)) / 1e6;
      usd += (a.coldRuns * (t * 0.6 * p.write1h + t * 0.4 * p.write5m + 60 * p.output)) / 1e6;
    }
  }
  return usd;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const est = estimateUsd(args);
  process.stdout.write(`# Ghost TTFT benchmark\n\nruns ${args.runs} warm + ${args.coldRuns} cold per configuration; sizes ${args.sizes.join(', ')}; models ${args.models.join(', ')}; estimated cost about $${est.toFixed(2)}\n\n`);
  if (args.dryRun) return;
  const apiKey = requireKey('ttft');
  const baseURL = resolveBaseUrl();
  const client = createRealLlmClient({ apiKey, baseURL });
  const sdk = createAnthropicSdk({ apiKey, baseURL, maxRetries: 2 });

  // Calibrate characters per token on the real prefix once per model (tokenizers differ).
  const rows: Row[] = [];
  for (const m of args.models) {
    const probe = buildPrefix(40_000);
    let charsPerToken = 3.6;
    try {
      const ct = await sdk.messages.countTokens({ model: MODELS[m].model, system: probe.map((b) => ({ type: 'text' as const, text: b.text })), messages: [{ role: 'user', content: 'x' }] });
      charsPerToken = 40_000 / Math.max(1, ct.input_tokens);
    } catch (e) {
      process.stderr.write(`token count failed (${describeError(e)}); assuming ${charsPerToken} chars/token\n`);
    }
    for (const s of args.sizes) {
      const chars = Math.round(sizeTokens(s) * charsPerToken);
      for (const cache of ['warm', 'cold'] as const) {
        const runs = cache === 'warm' ? args.runs : args.coldRuns;
        if (runs === 0) continue;
        const row: Row = { model: m, size: s, prefixTokens: null, cache, runs, errors: 0, ttft: [], total: [], cacheRead: [], outTokens: [], errorSample: null };
        const warmSystem = buildPrefix(chars, `warm-${Date.now()}`);
        if (cache === 'warm') {
          try {
            const prime = await client.complete(ghostRequest(m, warmSystem, ghostTailFor(999)));
            row.prefixTokens = prime.usage.input_tokens + (prime.usage.cache_creation_input_tokens ?? 0) + (prime.usage.cache_read_input_tokens ?? 0);
          } catch (e) {
            row.errorSample = describeError(e);
          }
        }
        for (let i = 0; i < runs; i++) {
          const system = cache === 'warm' ? warmSystem : buildPrefix(chars, `cold-${Date.now()}-${i}`);
          let res: LlmResponse;
          try {
            res = await client.complete(ghostRequest(m, system, ghostTailFor(i)));
          } catch (e) {
            row.errors++;
            row.errorSample ??= describeError(e);
            continue;
          }
          row.ttft.push(res.ttftMs ?? res.ms);
          row.total.push(res.ms);
          row.cacheRead.push(res.usage.cache_read_input_tokens ?? 0);
          row.outTokens.push(res.usage.output_tokens);
          row.prefixTokens ??= res.usage.input_tokens + (res.usage.cache_creation_input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0);
          process.stderr.write(`\r${MODELS[m].model} ${s} ${cache} ${i + 1}/${runs}   `);
        }
        process.stderr.write('\n');
        if (row.errorSample) process.stderr.write(`  errors: ${row.errors} (e.g. ${row.errorSample})\n`);
        rows.push(row);
      }
    }
  }

  process.stdout.write(table(rows) + '\n\n## Decision rule (p50 total < 1.2 s and p95 total < 2.0 s, warm, 27k prefix)\n\n');
  for (const m of args.models) {
    const r = rows.find((x) => x.model === m && x.cache === 'warm' && x.size === '27k') ?? rows.find((x) => x.model === m && x.cache === 'warm');
    process.stdout.write(`- ${decision(r).text}\n`);
  }
  const ghost = rows.find((x) => x.model === 'haiku' && x.cache === 'warm' && x.size === '27k');
  if (ghost) process.stdout.write(`\nGhost route (config.models.ghost = claude-haiku-5-5): ${decision(ghost).pass ? 'auto-propose keeps the pause trigger.' : 'auto-propose falls back to boundary-only; on-demand elsewhere.'}\n`);
  for (const r of rows) if (r.cache === 'warm' && r.cacheRead.length > 0 && (percentile(r.cacheRead, 50) ?? 0) === 0) process.stdout.write(`\nWARNING: ${MODELS[r.model].model} ${r.size} warm runs read 0 cached tokens: a silent cache invalidator is at work.\n`);
  if (args.json) writeFileSync(args.json, JSON.stringify({ args, rows }, null, 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    process.stderr.write(`ttft: ${describeError(e)}\n`);
    process.exit(1);
  });
}
