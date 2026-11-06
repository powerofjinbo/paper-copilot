/**
 * Phase 0 spike: can a cache pre-warm carry output_config.format, and does the real (structured) ghost
 * request that follows read the cache it wrote?
 *
 *   npx tsx scripts/bench/prewarm-format.ts [--models haiku,sonnet] [--tokens 8000]
 *
 * For each model (with the route's thinking/effort settings) and each pre-warm shape, on a fresh prefix
 * (unique nonce, so shapes cannot read each other's entries):
 *   zero              max_tokens 0, no output_config.format   (the documented pre-warm)
 *   zero-with-format  max_tokens 0, with output_config.format (documented as rejected; checked here)
 *   one-with-format   max_tokens 1, with output_config.format (bills one output token)
 * it sends the pre-warm, then one real streamed ghost request WITH the format, and reports whether the
 * pre-warm was accepted, what it wrote (cache_creation_input_tokens) and whether the real request read
 * the cache (cache_read_input_tokens > 0) and how much.
 *
 * The result decides PAPER_PREWARM_MODE (apps/server/src/services/llm/client.ts): the first shape that is
 * accepted AND is read by the real request, in the order zero, zero-with-format, one-with-format. If none
 * is read, the fallback of docs/design.md applies (plain-text ghost + stop sequence + a trailing `facts:`
 * line parsed by the gate), because the format would then be part of the cached prefix.
 *
 * Requires an API key (ANTHROPIC_API_KEY or the "paper-copilot" keychain entry); refuses to run without.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Usage } from '../../packages/core/src/meta/index';
import { buildMessageParams, createAnthropicSdk, createRealLlmClient, describeError, usageFromApi, type PrewarmMode } from '../../apps/server/src/services/llm/client';
import { resolveBaseUrl } from '../../apps/server/src/services/llm/apiKey';
import { MODELS, buildPrefix, ghostRequest, ghostTailFor, requireKey, type ModelKey } from './ttft';

const SHAPES: Array<{ mode: PrewarmMode; maxTokens: 0 | 1; format: boolean }> = [
  { mode: 'zero', maxTokens: 0, format: false },
  { mode: 'zero-with-format', maxTokens: 0, format: true },
  { mode: 'one-with-format', maxTokens: 1, format: true },
];

interface Result {
  model: ModelKey;
  mode: PrewarmMode;
  accepted: boolean;
  error: string | null;
  warmWrite: number | null;
  realRead: number | null;
  realWrite: number | null;
  realOk: boolean;
}

function parseArgs(argv: string[]): { models: ModelKey[]; tokens: number } {
  const out = { models: ['haiku', 'sonnet'] as ModelKey[], tokens: 8000 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--models' && v) {
      out.models = v.split(',').map((s) => s.trim()).filter((s): s is ModelKey => s in MODELS);
      i++;
    } else if (k === '--tokens' && v) {
      out.tokens = Math.max(2000, Number(v) || 8000);
      i++;
    } else if (k === '--help' || k === '-h') {
      process.stdout.write('usage: npx tsx scripts/bench/prewarm-format.ts [--models haiku,sonnet] [--tokens 8000]\n');
      process.exit(0);
    } else throw new Error(`unknown argument ${k}`);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = requireKey('prewarm-format');
  const baseURL = resolveBaseUrl();
  const sdk = createAnthropicSdk({ apiKey, baseURL, maxRetries: 2 });
  const client = createRealLlmClient({ apiKey, baseURL });
  const chars = Math.round(args.tokens * 3.6);
  const results: Result[] = [];

  for (const m of args.models) {
    for (const shape of SHAPES) {
      const system = buildPrefix(chars, `prewarm-${shape.mode}-${Date.now()}`);
      const req = ghostRequest(m, system, ghostTailFor(0));
      const r: Result = { model: m, mode: shape.mode, accepted: false, error: null, warmWrite: null, realRead: null, realWrite: null, realOk: false };
      try {
        const params = buildMessageParams({ ...req, messages: [{ role: 'user', content: 'warmup' }] }, { stream: false, maxTokens: shape.maxTokens, includeFormat: shape.format });
        const msg = await sdk.messages.create(params as Parameters<typeof sdk.messages.create>[0] & { stream: false });
        const u: Usage = usageFromApi((msg as { usage: Parameters<typeof usageFromApi>[0] }).usage);
        r.accepted = true;
        r.warmWrite = u.cache_creation_input_tokens ?? 0;
      } catch (e) {
        r.error = describeError(e);
      }
      if (r.accepted) {
        try {
          const res = await client.complete(req);
          r.realOk = true;
          r.realRead = res.usage.cache_read_input_tokens ?? 0;
          r.realWrite = res.usage.cache_creation_input_tokens ?? 0;
        } catch (e) {
          r.error = `real request: ${describeError(e)}`;
        }
      }
      results.push(r);
      process.stderr.write(`${MODELS[m].model} ${shape.mode}: ${r.accepted ? 'accepted' : `rejected (${r.error})`}${r.realOk ? `, real request read ${r.realRead} cached tokens` : ''}\n`);
    }
  }

  const lines = [
    `# Pre-warm with output_config.format (prefix about ${args.tokens} tokens)`,
    '',
    '| model | pre-warm shape | accepted | warm cache write | real request cache read | real request cache write | note |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    lines.push(`| ${MODELS[r.model].model} | ${r.mode} | ${r.accepted ? 'yes' : 'no'} | ${r.warmWrite ?? '-'} | ${r.realRead ?? '-'} | ${r.realWrite ?? '-'} | ${r.error ?? ''} |`);
  }
  lines.push('', '## Recommendation', '');
  for (const m of args.models) {
    const ok = results.find((r) => r.model === m && r.accepted && r.realOk && (r.realRead ?? 0) > 0);
    lines.push(
      ok
        ? `- ${MODELS[m].model}: PAPER_PREWARM_MODE=${ok.mode}${ok.mode === 'zero' ? ' (the default)' : ''} — the real structured request reads the pre-warmed cache.`
        : `- ${MODELS[m].model}: no pre-warm shape was read by the structured request: use the plain-text fallback (stop sequence + trailing facts: line) for pre-warmed routes, or skip pre-warming.`,
    );
  }
  process.stdout.write(lines.join('\n') + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    process.stderr.write(`prewarm-format: ${describeError(e)}\n`);
    process.exit(1);
  });
}
