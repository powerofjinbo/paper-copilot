# lintd: the style_check sidecar

`lintd.py` is a long-lived Python 3 process (standard library only) that imports the user's
`hep-paper-writing/scripts/style_check.py` once and answers JSON-lines requests on stdin/stdout. The wire
protocol is in [PROTOCOL.md](PROTOCOL.md). The Node client is `apps/server/src/services/lint/sidecar.ts`
(`LintSidecar`).

```
python3 sidecar/lintd.py --skill-dir ~/.claude/skills/hep-paper-writing
```

## Finding the skill

In order: `--skill-dir`, `$PAPER_SKILL_DIR`, `~/.claude/skills/hep-paper-writing`, the repository's `.skill`.
The directory may be the skill root (with `scripts/style_check.py`), its `scripts/` directory, or the file itself.
A location given by `--skill-dir` or `$PAPER_SKILL_DIR` must hold the file; the defaults are tried in turn. When
nothing is found the process prints `{"ready": false, "error": ...}` and exits 2.

## What it does to the user's file

Nothing. `style_check.py` is imported from its own path with `importlib` (no copy), with bytecode writing off so
no `__pycache__` appears in the skill. At run time `style_check.flag` is replaced, on the loaded module only, by a
wrapper that adds `sent_index` (`Sent.i`), `block` and `raw` to every flag. `version` is the first 12 hex digits
of the file's sha256, so the server can tell when the user edits the skill.

## Commands

- `ping` -> `pong: true, version`.
- `lint.sentences {items: [{sid, text, part}], known, max_words, preamble?}` -> `flags: [{sid, check, key, msg,
  word, excerpt}]`, in item order, then style_check's check order. Each item is a LaTeX sentence converted on its
  own (style_check's `TexConv`) into a paragraph of the given part (`caption` and `footnote` are their own kinds,
  everything else is prose; an unknown part reads as `body`). Checks 1, 2, 3, 4, 5 and 10 run (the `--only`
  equivalent); then the flags that depend on other sentences are dropped: check 3's *Second stock connector in a
  row* and check 10's abstract passive share. What is left is local to the sentence: long, late verb, group-A
  openers, stock filler, *in order to*, inflated words, hype, *It is found that*. The optional `preamble` (LaTeX
  with `\newcommand`/`\def`) lets sentences use the paper's macros. An item that style_check cannot process is
  reported in `errors: [{sid, error}]` while the rest are linted.
- `lint.document {text, known, max_words, fmt?}` -> `flags: [{check, key, line, part, excerpt, msg, word,
  sent_index}]` for all ten checks, `rates` and `reference_rates` (per 1,000 words, by check key), `words`,
  `sentences`, `includes`. `fmt` defaults to `tex` (`md`, `txt`, `auto` also accepted). Notes (style_check's
  non-counted `info` items) are not returned.
- `corpus.stats {texts, fmt}` (`fmt` default `txt`) -> `texts, words, sentences, prose_sentences,
  median_length, mean_length, p90_length, gt40_pct` (prose sentences), `length_by_part`, `passive_share`
  (fraction of prose sentences with a passive), `passive_pct`, `passive_by_part`, `we_per_1k`,
  `median_verb_position`, `verb_positions_n`, and the skill's corpus norms under `corpus`. Statistics are `null`
  when there are no sentences.
- `shutdown` -> `{id, ok: true}`, then exit 0. End of stdin also exits 0.

`word` is the first `*emphasis*` in style_check's message that occurs in the sentence (e.g. `utilize`,
`Moreover`, `It is found that`), else `null`; it is always `null` for check 1, whose emphasis is a split hint.
`lint.sentence {sid?, text, part}` is accepted as a one-item `lint.sentences`.

## Robustness

A request that fails (bad JSON, unknown `cmd`, wrong field types, an exception inside style_check) gets
`{"id": ..., "ok": false, "error": "..."}` and the process continues. Responses are ASCII JSON, one per line,
flushed. Anything style_check prints goes to stderr, never to stdout. Lines over 64 MB are refused.

## Speed

One process start takes about 0.1 s. 1,000 `lint.sentences` items in one request take about 0.2 s (target:
under 2 s): every item is its own paragraph block and the checks run once over all of them, which gives the same
sentence-local flags as one tiny document per sentence. If style_check throws on the combined pass, the items are
re-run one by one to isolate the bad one.

## Tests

```
python3 -B -m unittest sidecar/test_lintd.py -v                       # skipped without the skill
cd apps/server && npx vitest run test/sidecar.test.ts                 # the Node client
```
