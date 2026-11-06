# Phase 0 benchmarks (run on the laptop)

These scripts make **real** Claude API calls. They cannot run in the sandbox (no API key, and
api.anthropic.com may be blocked there). Run them on your own machine and record the output in
`docs/adr/`.

## Setup

1. Dependencies installed once from the repository root: `pnpm install`.
2. An API key, either
   - in the environment: `export ANTHROPIC_API_KEY=sk-ant-...`, or
   - in the OS keychain under the service name `paper-copilot` (the app reads the same entry):
     - macOS: `security add-generic-password -s paper-copilot -a "$USER" -w` (it prompts for the key)
     - Linux (libsecret): `secret-tool store --label=paper-copilot service paper-copilot`

   Both scripts refuse to run without a key and print how to set one. The key is never printed.
3. Network: the scripts talk to `https://api.anthropic.com`. `ANTHROPIC_BASE_URL` is ignored on
   purpose (other tools set it for themselves); to go through a gateway set
   `PAPER_ANTHROPIC_BASE_URL=https://...` instead.
4. The skill is read from `$PAPER_SKILL_DIR`, else `./.skill` of this repository. The prefix also uses
   `fixtures/canto-demo` (paper, bibliography, analysis-repo notes).

## 1. Ghost latency: `ttft.ts`

```bash
npx tsx scripts/bench/ttft.ts --dry-run          # prints the plan and the estimated cost, no calls
npx tsx scripts/bench/ttft.ts                    # 50 warm + 10 cold runs per configuration
npx tsx scripts/bench/ttft.ts --runs 50 --cold-runs 10 --sizes 10k,27k,50k --models haiku,sonnet --json ttft.json
```

What it measures, per model route and cached-prefix size (10k / 27k / 50k tokens):

| route | model | thinking | effort |
|---|---|---|---|
| ghost (default) | `claude-haiku-5-5` | `disabled` | `low` |
| candidate | `claude-sonnet-5-5` | `between_tools` | `low` |

- the request is the ghost request of the app: system blocks A (skill, `ttl: 1h`) and B (paper, repo
  notes, bibliography, 5 min) with `cache_control`, a short volatile tail, `output_config.format` with
  the ghost JSON schema, `max_tokens: 200`, about 40 output tokens, streaming, no retries;
- **warm**: one priming request, then N runs on the same prefix (each should read the cache: the table
  shows the median `cache_read_input_tokens`, and the script warns if it is 0);
- **cold**: a unique nonce at the start of block A per run forces a miss and a cache write (costly,
  hence the separate, smaller `--cold-runs`);
- TTFT = time to the first text delta; total = time to the end of the stream. p50 and p95 of each.

The output is a markdown table plus the decision rule of `docs/plan.md`:

> p50 total < 1.2 s and p95 total < 2.0 s (warm, 27k prefix) keeps the pause trigger in `auto-propose`
> sections; otherwise ghost is boundary-only there and on-demand (Ctrl+Space) elsewhere.

Cost with the defaults is a few dollars (printed before the run; Sonnet cold writes dominate). Lower
`--runs`/`--cold-runs` or use `--models haiku` for a cheaper pass.

## 2. Pre-warm with a format: `prewarm-format.ts`

```bash
npx tsx scripts/bench/prewarm-format.ts                    # both models, ~8k-token prefix
npx tsx scripts/bench/prewarm-format.ts --models haiku --tokens 12000
```

For each model and each pre-warm shape (on its own fresh prefix):

| shape | request |
|---|---|
| `zero` | `max_tokens: 0`, no `output_config.format` (the documented pre-warm) |
| `zero-with-format` | `max_tokens: 0` with the format (documented as rejected; checked) |
| `one-with-format` | `max_tokens: 1` with the format (one output token billed) |

it sends the pre-warm, then one real structured ghost request, and reports whether the pre-warm was
accepted and whether the real request read the cache (`cache_read_input_tokens > 0`).

Use the recommendation it prints to set the app's pre-warm shape:

```bash
export PAPER_PREWARM_MODE=zero              # default
export PAPER_PREWARM_MODE=zero-with-format  # only if accepted and read
export PAPER_PREWARM_MODE=one-with-format   # if the format must be on the warm request
```

If no shape is read by the structured request, the format is part of the cached prefix and the app
should fall back to the plain-text ghost (stop sequence + trailing `facts:` line parsed by the gate,
`docs/design.md`), or skip pre-warming.

## Notes

- Requests are sequential; nothing runs in parallel, so the numbers are per-request latency.
- Both scripts use the app's own client (`apps/server/src/services/llm/client.ts`), so the request bodies
  are exactly what the app sends.
- Record the date, the network (home / institute / VPN) and the printed table in `docs/adr/`.
