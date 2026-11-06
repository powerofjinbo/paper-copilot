# 0005. Overleaf sync through the git bridge, with a push guard

Status: accepted (2026-11-06)

## Context
The Canto project lives on Overleaf with a paid owner, so the Overleaf git bridge is available (username `git`
plus a token; one `main` branch; no force push). Advisors must never see unreviewed AI text.

## Decision
`paper pull` runs `git pull --rebase` in the LaTeX tree and re-anchors every changed file; changed sentences
become `external`. `paper push` first runs a push check and refuses while any sentence is `proposed`,
`unsupported` or a placeholder, while any Chinese intent line or CJK character remains in the .tex, or while
merge markers exist; it shows the exact diff co-authors will see, commits only the LaTeX tree and never
force-pushes or renames files. `overleaf-sync` (`ols`) is the fallback for projects without the git bridge.

## Consequences
Proposed sentences can be parked in the sidecar if the author needs to push before reviewing everything.
