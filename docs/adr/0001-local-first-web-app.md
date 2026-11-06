# 0001. A local-first web app, not an Overleaf fork or a VS Code extension

Status: accepted (2026-11-06)

## Context
The author wants an Overleaf-like LaTeX editor whose unit of interaction is the sentence: ghost text,
per-sentence review cards, an outline panel, a fact store and a PDF preview. The tool must call a local TeX
install, read the analysis repository and keep the Anthropic API key off any third-party server.

## Decision
Ship a local web app: `paper open <dir>` starts a Fastify server on 127.0.0.1 and opens the browser. The
front end is Vite + React + CodeMirror 6; the server runs latexmk/synctex, the Claude Agent SDK and a Python
sidecar for the author's `style_check.py`. The engine stays client-agnostic (`packages/client-core`) so a VS Code
client can be added later.

## Alternatives
- Fork Overleaf Community Edition: AGPL monorepo, no plugin API, heavy Docker setup for one user.
- VS Code extension on LaTeX Workshop: cheapest start, but the sentence-review UI is constrained and Copilot
  competes for the inline-completion slot.

## Consequences
Full control over the interaction model; the author installs Node, Python and TeX Live once. Packaging (Tauri)
is deferred to Phase 3.
