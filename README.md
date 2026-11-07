# paper-copilot

A local-first LaTeX editor for physics papers in which the **sentence** is the unit of writing, review and
provenance. The AI first reads your analysis repository and your bibliography, then helps you write one sentence at
a time, in your own voice, under the rules of your own writing skill, and it never invents a number or a citation.

[中文说明](README.zh-CN.md) · [Design](docs/design.md) · [Plan and acceptance tests](docs/plan.md) · [Decisions](docs/adr/)

## Why

AI already writes fluent English, but its prose sounds like everyone else's and it happily invents numbers,
cuts and references. Non-native authors pay twice: they accept more suggestions, and post-editing an AI draft
leaves an AI style the author no longer notices. paper-copilot changes the interaction instead of the model:

- **Grounded.** A deterministic extractor turns `results/*.json`, `results/*.csv` and `docs/definitions.md` of your
  analysis repo into a fact store (value, uncertainty, artifact path, JSON pointer or CSV cell, SHA-256). Every
  number in AI text must match a fact; every `\cite` key must be resolved on INSPIRE-HEP or confirmed by you.
  Anything else becomes a visible placeholder such as `[fact?: ...]` or `[ref]`.
- **Yours.** Your `hep-paper-writing` skill is loaded unchanged from disk and governs every AI sentence. A voice
  layer adds your own unassisted sentences as examples, measured norms of your writing, and a preference memo
  learned from the edits you make to AI text (grammar-only fixes are excluded). A style meter shows how far a
  section drifts from you.
- **Reviewable.** AI sentences stay visibly "not yet yours" until you accept, edit, instruct or reject them, one at
  a time. Every version is logged (model, prompt hash, instruction, edit distance), so the venue's AI disclosure
  statement writes itself.
- **Safe with co-authors.** The `.tex` file stays the single source of truth and syncs with Overleaf through the git
  bridge. All metadata lives in a `.paper/` sidecar next to it. A push is refused while unreviewed AI text,
  placeholders or Chinese intent notes remain.

## Two ways to write

**Ghost mode.** Type; at a pause or a sentence end (or on Ctrl+Space / Alt+/) the next sentence appears in light gray, grounded
in your facts. Tab accepts, Ctrl/Cmd+→ accepts one word, Esc dismisses. Press `?` for every shortcut. In voice-critical sections (abstract, introduction,
conclusions) the AI only completes a sentence you have started. Type a thought in Chinese on its own line and press
Ctrl/Cmd+Enter: it becomes one English sentence in your voice, and the Chinese note stays attached to it.

**Draft, then review.** Fill the outline (the skill's five Step-0 items: story, gap and enabler, ladder of cases,
the figure behind each claim, the headline number with its baseline). Drafting unlocks only after you have written these yourself (the AI's plan must not anchor yours). Ask for a section draft. Paragraphs first
appear as job cards to reorder; then each sentence enters in gray. Alt+↓ jumps to the next one. Ctrl/Cmd+Enter
accepts; typing edits it; Ctrl/Cmd+I gives an instruction (Chinese is fine) and shows a word diff with a drift
checklist; Ctrl/Cmd+G fixes grammar only; `l` shows alternatives; `r` lets you rewrite it yourself; `x` rejects it
into a `[claim: ...?]` placeholder so no claim is silently lost.

## The screen

- **Left rail, four steps in writing order.** Click a step to open its panel; the « button at the foot of the rail folds the panel away.
  - **① Plan** — the five Step-0 items you write yourself (story, gap and enabler, ladder of cases, figure behind
    each claim, headline number with its baseline), alternative framings, the section and paragraph plan, Draft.
  - **② Sources** — *Facts* (every number from your analysis repo, with its file and SHA, stale badges, the list
    of numerals in the text that match no fact) and *Literature* (cite keys, INSPIRE resolution).
  - **③ To do** — one list, in document order: AI sentences waiting for review, placeholders, referee questions.
  - **④ Check** — the submission check, Consistency, Terminology, Figure plan, the AI disclosure text, and Sync
    with Overleaf.
- **Top bar.** The compile pill (Compile, Show/Hide PDF, errors), Sync (Pull / Push), Check (the submission
  check's verdict), a badge that says "Simulated AI" when no API key is set, ⚙ Settings and **?** (shortcuts,
  the tour, reset the demo). With several `.tex` files, the file name in the breadcrumb is a file switcher.
- **⚙ Settings drawer.** Your voice (memo and style meter), interface language (中文 / English), theme, the
  ownership heatmap, the PDF beside the editor, and the API cost of this session.
- **When the window is narrow** the editor keeps a readable width: the PDF or the step panel steps aside behind a
  thin strip at the edge. Click the strip to bring it back.

## What else it checks

- **Submission check** (④, and the Check button): one list of blockers before you send the paper out — unreviewed
  AI sentences, placeholders, Chinese notes, numbers that match no fact, stale facts still stated in the text,
  citation keys missing from the .bib, LaTeX errors, a missing AI disclosure statement. Each row jumps to the
  sentence.
- **Consistency**: each headline number across abstract, body, conclusions and captions; flags a drifted value,
  a factor written as a percent, a dropped condition, and sentences that state a stale fact.
- **Terminology**: each defined term with its first use and the variant spellings to unify.
- **Figure plan**: each figure's job, the claim it supports, a caption checklist, and citation order.
- **Derived numbers**: "2.5 times fewer fake tracks" is accepted when it is the ratio (or difference) of two facts
  the sentence actually talks about, in the right direction. A coincidence with unrelated facts is not.
- **Repo watcher**: when you re-run the analysis and a result file changes, its facts are re-read and the
  sentences that state the old value are marked stale.
- **Restore**: every version of a sentence is kept; the sentence card's history can put an earlier one back.
- **Multi-file papers**: `\input`/`\include` trees open file by file through the file switcher; checks cover
  every file.

## First steps

1. **Try it in the browser, nothing else installed:** `pnpm install`, then `pnpm --filter @paper-copilot/web dev`
   and open `http://127.0.0.1:5173/?mock=1`. On the first visit the app offers an 8-step guided tour of an
   example paper (later: **?** → *Take the tour*). Each step asks you to do one thing: open a sentence's card,
   instruct the AI in Chinese and accept, turn a Chinese note into an English sentence, accept ghost text, change a
   number and see it flagged as having no source, draft a paragraph and review it in ③ To do, run the submission
   check. **?** → *Reset the example paper* starts again. The demo has no LaTeX: Compile shows an example PDF
   (compiled once from the fixture) that does not follow your edits, and the PDF ↔ text jumps are approximate.
   The full app (`pnpm paper open`) compiles for real.
2. **Install TeX for the real PDF.** Mac: `brew install --cask mactex-no-gui` (or BasicTeX, then
   `sudo tlmgr install latexmk revtex`), then open a new terminal. Linux:
   `sudo apt install latexmk texlive-latex-extra texlive-publishers`. Then restart `pnpm paper open`;
   `pnpm paper doctor` checks it. Without TeX the compile pill says *No LaTeX* and shows these same lines for
   your system.
3. **Your own paper:** follow the quick start below.

## Quick start

Requirements: Node ≥ 22.13 with pnpm, Python ≥ 3.11, TeX Live with `latexmk` and `synctex`, git. For real AI
suggestions, an Anthropic API key; without one the app runs with clearly labelled simulated AI.

```bash
git clone https://github.com/powerofjinbo/hep-writing-skill.git ~/.claude/skills/hep-paper-writing
```

```bash
git clone https://github.com/powerofjinbo/paper-copilot.git && cd paper-copilot && pnpm install && pnpm build
```

Create a project from your Overleaf project (git bridge URL from Overleaf: Menu → Git) and your analysis repo:

```bash
pnpm paper import https://git@git.overleaf.com/<project-id> --to ~/papers/canto
```

```bash
pnpm paper init ~/papers/canto --repo ~/code/Displaced_tracks_GNN --sync git --remote https://git@git.overleaf.com/<project-id> --branch master --venue aps --notes zh
```

Use absolute paths. Optional: `pnpm paper semantic-lines ~/papers/canto` puts one sentence per line (reversible with
`--undo`), which makes merges with Overleaf edits sentence-granular; agree on it with your co-authors first.

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # or store it in the OS keychain as service "paper-copilot"
pnpm paper open ~/papers/canto
```

`paper doctor ~/papers/canto` checks Node, Python, TeX, the skill, the key and the git remote.

## Updating

```bash
cd paper-copilot && git pull && pnpm install && pnpm build
```

Then restart `pnpm paper open`. Your papers are not touched: the `.tex` files and the `.paper/` folder stay where
they are.

## Status

Phase 0 tooling and Phases 1a and 1b of [the plan](docs/plan.md) are implemented, and Phase 2 is partly done: the
re-planner, the drafter, literature resolution, memo learning, the style meter, the Sync panel, Consistency,
Terminology, the Figure plan, the submission check, multi-file projects, derived numbers, restore and the repo
watcher all exist. What runs
and is tested here (simulated AI, local git remote, TeX Live 2023):

| Suite | Result |
|---|---|
| `packages/core` (segmenter, anchoring with a seeded fuzz test, gate, prompts, meta) | 670 tests pass |
| `packages/client-core` (ghost machine, review queue) | 102 tests pass |
| `apps/server` (services, routes, security, SDK request shapes, end-to-end in process) | 580 tests pass |
| `apps/web` (sync core, decorations, ghost, panels, API client, guided tour, demo PDF) | 242 tests pass |
| `sidecar` (your `style_check.py` behind a JSON-lines process) | 25 tests pass |
| `node e2e/fullstack.mjs` (real server + built app in Chromium: the Phase 1a acceptance walk, compile, SyncTeX both ways, draft and review, push refused then allowed, a co-author pull keeping 29/29 sentence ids, kill -9 and restart; the submission check, a planted abstract/body number drift, restoring a version, a derived "2.5 times" through the gate, a re-run result JSON marking its fact stale, the file switcher on the multi-file fixture, the 4-step layout in 中文/light/dark) | 28/28 |
| Browser harnesses (`apps/web/harness/*.mjs`: app in demo mode, editor, PDF, UX review, UX review 2; the demo walk includes the guided tour in 中文/light and EN/dark) | 33/33, 14/14, 17/17, 18/18, 17/17 |

The segmenter agrees with the skill's `style_check.py` on 100% of the fixture's sentences. An adversarial review from
five angles (integrity, anchoring, security, SDK correctness, UX) found 36 problems; a second review (integrity, data
safety, security, UX) found 33 more. Each was reproduced by a failing test and fixed, and the tests stay as
regressions. Two more runs guard data safety: `node e2e/perf.mjs` (typing, lint, compile and memory budgets on the
multi-file paper, all met) and `SOAK_SEED=11 SOAK_MINUTES=5 node e2e/soak.mjs` (5 minutes of random typing, IME,
paste, undo, AI actions, pulls, kill -9 and reloads in two tabs; seeds 11 and 23 hold every invariant after every
action). What changed overnight, in Chinese: [docs/overnight-report.md](docs/overnight-report.md).

**Not yet verified, because this needs your machine:** real Claude API calls and the Agent SDK (run
`scripts/bench/ttft.ts` and `scripts/bench/prewarm-format.ts` first, see [scripts/bench/README.md](scripts/bench/README.md)),
a real Overleaf remote, macOS key handling and the keychain, and the real Canto manuscript. Without an API key the app
says "Simulated AI" and every AI output is a deterministic stand-in.

You can try the interface without any setup: `pnpm --filter @paper-copilot/web dev` and open
`http://127.0.0.1:5173/?mock=1` (the whole server is emulated in the browser on a fixture paper).

## Development

```bash
pnpm test
```

```bash
node e2e/fullstack.mjs
```

| Path | What it is |
|---|---|
| `packages/core` | Pure, isomorphic core: schemas, wire protocol, LaTeX segmentation, anchoring, faithfulness gate, prompt builders, disclosure, cost, style metrics |
| `packages/client-core` | Client-agnostic state machines: ghost text, review queue |
| `apps/server` | Local backend: project store, sentence service, facts, literature, lint sidecar, LLM and Agent SDK services, compile, SyncTeX, Overleaf sync |
| `apps/web` | Browser client: CodeMirror 6 editor, sentence cards, panels, PDF preview |
| `sidecar/lintd.py` | Long-lived Python process that imports your skill's `style_check.py` |
| `scripts/bench` | Phase 0 latency and cache benchmarks (need an API key) |
| `fixtures/canto-demo` | A synthetic revtex paper and trimmed Canto artifacts for tests |

## License

MIT
