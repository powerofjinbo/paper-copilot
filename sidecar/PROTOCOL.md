# lintd protocol

`sidecar/lintd.py` is a long-lived Python 3 process (stdlib only) that imports the user's
`hep-paper-writing/scripts/style_check.py` once and answers JSON-lines requests on stdin/stdout.
It never modifies the skill. One request per line; one response per line, in order.

Start: `python3 sidecar/lintd.py --skill-dir <path to hep-paper-writing>`
(or env `PAPER_SKILL_DIR`). On start it prints `{"ready": true, "style_check": "<path>", "version": "<sha256 prefix of style_check.py>"}`
or `{"ready": false, "error": "..."}` and exits non-zero.

Requests: `{"id": <int>, "cmd": <string>, ...}`. Responses: `{"id": <same>, "ok": true, ...}` or
`{"id": <same>, "ok": false, "error": "..."}`. A failing request never kills the process.

| cmd | request fields | response fields |
|---|---|---|
| `ping` | | `pong: true` |
| `lint.sentences` | `items: [{sid, text, part}]` (LaTeX sentences; part = abstract/intro/body/concl/app/caption/footnote), `known: [acronyms]`, `max_words` (default 40) | `flags: [{sid, check, key, msg, word, excerpt}]`, only sentence-local checks: 1 long, 2 verb, 4 vocab, 5 hype, 3 (group-A openers, stock filler, "in order to"), 10 ("It is found that") |
| `lint.document` | `text` (flattened LaTeX of the whole document), `known`, `max_words` | `flags: [{check, key, line, part, excerpt, msg, word, sent_index}]` for all ten checks, `rates: {check_key: per_1000_words}`, `reference_rates: {check_key: corpus_rate}`, `words`, `sentences` |
| `corpus.stats` | `texts: [plain or LaTeX strings]`, `fmt` (`tex`/`txt`) | the style_check report statistics: median/mean/p90 sentence length, passive share, we per 1k, median verb position |
| `shutdown` | | process exits 0 |

`word` is the offending word or phrase re-found from the `*emphasis*` in style_check's message when
possible (e.g. `utilize`), else null. `sent_index` is style_check's internal sentence index, added by
wrapping `style_check.flag` at runtime without editing the user's file.
