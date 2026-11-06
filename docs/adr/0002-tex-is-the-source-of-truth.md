# 0002. The .tex file is the single source of truth; sentences are a derived layer

Status: accepted (2026-11-06)

## Context
Co-authors keep editing the paper in Overleaf, and Overleaf git pushes destroy Overleaf comments and track
changes. Sentence metadata (ids, provenance, instructions, alternatives, history) must survive edits made in the
app, edits made in Overleaf and edits made in another editor.

## Decision
The LaTeX source is never re-printed. Sentences are offset-preserving slices found by `packages/core` segment().
All metadata lives in a sidecar `.paper/` directory that is a sibling of the LaTeX tree, so nothing of the
platform can reach Overleaf. Ids are ULIDs; spans are mapped through every CodeMirror change set; after an
external change, units are re-anchored with a three-way diff, exact hash matches, then fuzzy matching within
8 lines (similarity >= 0.6 plus an agreeing neighbour). Units that cannot be re-anchored are orphaned, never
deleted. Optional one-sentence-per-line normalization makes merges sentence-granular.

## Consequences
Re-anchoring is the hardest code in the project and is heavily tested. Provenance (`everAi`) can never be
cleared, so disclosure counts stay honest after a co-author rewrites a sentence.
