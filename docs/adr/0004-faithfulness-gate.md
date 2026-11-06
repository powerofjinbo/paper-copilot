# 0004. Every AI sentence passes a deterministic faithfulness gate

Status: accepted (2026-11-06)

## Context
Every venue the author targets (APS, Elsevier, Springer, arXiv) holds the authors responsible for AI errors.
The skill's first guardrail is "Never invent numbers, references, results, or citations."

## Decision
One pure function, `gateSentence`, runs on ghost text before display, in the drafter's PostToolUse hook and on
every rewrite. Every non-structural numeral must equal a fact read by code from an analysis artifact (JSON
pointer or CSV cell, with SHA-256), an uncertainty of a linked fact, a declared derived relation, or a number
the author typed in their own intent note. Every `\cite` key must be resolved on INSPIRE-HEP or confirmed by the
author. Rewrites must keep `\cite`, `\ref`, `\label`, math and macros. Numbers from the skill's invented
reference examples are blocked. Violations become visible placeholders such as `[fact?: ...]` and `[ref]`;
nothing is silently repaired. Claim-strength checks (exclude needs a CL >= 95 % limit fact) are warnings.

## Consequences
Over-strict matching can make drafts noisy; derived relations and an explicit "unlinked" state for numbers typed
by the author keep it usable. Facts default to `candidate`; only an evidence record raises them.
