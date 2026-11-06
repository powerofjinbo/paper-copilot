/**
 * Three narrow gutter columns (docs/design.md, UI layout):
 *  1. plan: move label of the active sentence (or the next planned move on an empty line), `↻` for units
 *     with a re-plan proposal, a pulsing dot while a ghost request is pending, "note" on intent lines;
 *  2. lint: a dot per line with lint flags, count and messages in the tooltip;
 *  3. provenance bar: colour per state (fill proportional to edit distance for ai-edited), state in words
 *     in the tooltip.
 * Markers are computed per visible line (binary search over units), so cost does not grow with the paper.
 */
import type { EditorState, Extension } from '@codemirror/state';
import { EditorView, GutterMarker, gutter, type BlockInfo, type ViewUpdate } from '@codemirror/view';
import type { LintFlag, SentenceUnit } from '@paper-copilot/core';
import { cardField } from './card/cardState';
import { ctxField, outlineFor, replanField } from './context';
import { editorEnv } from './env';
import { ghostField, ghostPending } from './ghost/ghostField';
import { allIntentLines } from './intent';
import { currentLang, stateLabel } from './i18n';
import { lintTitle } from './decorations';
import { unitAtPos, unitBefore, unitsField, unitsInRange } from './units';

function lineUnits(state: EditorState, line: BlockInfo): SentenceUnit[] {
  return unitsInRange(state.field(unitsField).units, line.from, line.to).filter((u) => u.start <= line.to && u.end >= line.from);
}

/* ------------------------------------------------------------------------------------ */
/* Provenance                                                                            */
/* ------------------------------------------------------------------------------------ */

interface ProvSeg {
  state: SentenceUnit['state'];
  fill: number;
}

export function provenanceTitle(u: SentenceUnit): string {
  const zh = currentLang() === 'zh';
  let t = stateLabel(u.state, zh ? 'zh' : 'en');
  if (u.state === 'ai-edited' && u.editDistance !== null) t += zh ? `（改动 ${Math.round(u.editDistance * 100)}%）` : ` (${Math.round(u.editDistance * 100)}% changed)`;
  if (u.model && u.state !== 'human') t += ` · ${u.model}`;
  if (u.everAi && (u.state === 'human' || u.state === 'external')) t += zh ? ' · 曾经有 AI 参与' : ' · AI-touched before';
  if (u.grammarFixed) t += zh ? ' · 已修语法' : ' · grammar fixed';
  return t;
}

class ProvMarker extends GutterMarker {
  constructor(
    readonly segs: readonly ProvSeg[],
    readonly label: string,
  ) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return other instanceof ProvMarker && other.label === this.label && other.segs.length === this.segs.length && other.segs.every((s, i) => s.state === this.segs[i]!.state && s.fill === this.segs[i]!.fill);
  }
  override toDOM(): Node {
    const el = document.createElement('div');
    el.className = 'pc-prov';
    el.title = this.label;
    el.setAttribute('aria-label', this.label);
    for (const s of this.segs) {
      const seg = document.createElement('span');
      seg.className = `pc-prov-seg pc-prov-${s.state}`;
      if (s.state === 'ai-edited') {
        const fill = document.createElement('span');
        fill.className = 'pc-prov-fill';
        fill.style.height = `${Math.round(Math.max(0.12, Math.min(1, s.fill)) * 100)}%`;
        seg.appendChild(fill);
      }
      el.appendChild(seg);
    }
    return el;
  }
}

export function provenanceMarkerFor(units: readonly SentenceUnit[]): ProvMarker | null {
  const shown = units.filter((u) => u.state !== 'human');
  if (shown.length === 0) return null;
  const segs = units.slice(0, 4).map((u) => ({ state: u.state, fill: u.state === 'ai-edited' ? (u.editDistance ?? 0.3) : 1 }));
  const label = units.map(provenanceTitle).join('\n');
  return new ProvMarker(segs, label);
}

/* ------------------------------------------------------------------------------------ */
/* Lint                                                                                  */
/* ------------------------------------------------------------------------------------ */

class LintMarker extends GutterMarker {
  constructor(
    readonly count: number,
    readonly severity: 'hint' | 'warn',
    readonly label: string,
  ) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return other instanceof LintMarker && other.count === this.count && other.severity === this.severity && other.label === this.label;
  }
  override toDOM(): Node {
    const el = document.createElement('div');
    el.className = `pc-lint-dot pc-lint-dot-${this.severity}`;
    el.title = this.label;
    el.setAttribute('aria-label', this.label);
    if (this.count > 1) el.textContent = String(this.count);
    return el;
  }
}

export function lintFlagsForLine(state: EditorState, line: BlockInfo): LintFlag[] {
  const ctx = state.field(ctxField);
  const out: LintFlag[] = [];
  for (const u of lineUnits(state, line)) {
    if (u.start < line.from) continue; // count a multi-line sentence once, on its first line
    const flags = ctx.lintBySentence.get(u.id);
    if (flags) out.push(...flags);
  }
  return out;
}

/* ------------------------------------------------------------------------------------ */
/* Plan                                                                                  */
/* ------------------------------------------------------------------------------------ */

class PlanMarker extends GutterMarker {
  constructor(
    readonly text: string,
    readonly kind: 'move' | 'next' | 'replan' | 'pending' | 'intent',
    readonly label: string,
  ) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return other instanceof PlanMarker && other.text === this.text && other.kind === this.kind && other.label === this.label;
  }
  override toDOM(): Node {
    const el = document.createElement('div');
    el.className = `pc-plan pc-plan-${this.kind}`;
    el.title = this.label;
    el.setAttribute('aria-label', this.label);
    if (this.kind === 'pending') {
      const dot = document.createElement('span');
      dot.className = 'pc-pulse';
      el.appendChild(dot);
    } else el.textContent = this.text;
    return el;
  }
}

export function planMarkerFor(state: EditorState, line: BlockInfo): PlanMarker | null {
  const pending = ghostPending(state);
  if (pending && pending.pos >= line.from && pending.pos <= line.to) return new PlanMarker('', 'pending', 'Ghost suggestion requested…');
  const units = lineUnits(state, line);
  const replans = state.field(replanField);
  for (const u of units) {
    const r = replans.get(u.id);
    if (r && u.start >= line.from) return new PlanMarker('↻', 'replan', `Re-plan proposal (${r.action.replace('_', ' ')}): ${r.reason}`);
  }
  const head = state.selection.main.head;
  const lineNo = state.doc.lineAt(line.from).number;
  if (allIntentLines(state).some((l) => l.line === lineNo)) return new PlanMarker('note', 'intent', 'Intent note (not paper text)');
  if (head < line.from || head > line.to) return null;
  const all = state.field(unitsField).units;
  const active = unitAtPos(all, head);
  if (active) {
    if (active.start < line.from) return null;
    const { paragraph } = outlineFor(state.field(ctxField).outline, active);
    const move = active.move ?? null;
    if (move) return new PlanMarker(move, 'move', `Move: ${move}${paragraph ? ` · paragraph job: ${paragraph.job}` : ''}`);
    return null;
  }
  // empty slot: show the next planned move of the paragraph before the cursor
  const prev = unitBefore(all, head);
  if (!prev) return null;
  const { paragraph } = outlineFor(state.field(ctxField).outline, prev);
  const next = paragraph?.plan.remaining[0];
  if (!next) return null;
  const facts = next.factIds.length ? `: ${next.factIds.join(', ')}` : '';
  return new PlanMarker(next.move ?? 'next', 'next', `Next: ${next.move ?? ''}${facts} · ${next.intent}`);
}

/* ------------------------------------------------------------------------------------ */
/* Extensions                                                                            */
/* ------------------------------------------------------------------------------------ */

function changed(u: ViewUpdate): boolean {
  return (
    u.docChanged ||
    u.selectionSet ||
    u.state.field(unitsField) !== u.startState.field(unitsField) ||
    u.state.field(ctxField) !== u.startState.field(ctxField) ||
    u.state.field(replanField) !== u.startState.field(replanField) ||
    u.state.field(ghostField).machine.state !== u.startState.field(ghostField).machine.state ||
    u.state.field(cardField) !== u.startState.field(cardField)
  );
}

function openCardAtLine(view: EditorView, line: BlockInfo): boolean {
  const units = lineUnits(view.state, line);
  const u = units.find((x) => x.start >= line.from) ?? units[0];
  const env = view.state.facet(editorEnv);
  if (!u || !env) return false;
  env.ops.openCard(view, u.id, { pinned: true, focus: false });
  return true;
}

export function paperGutters(): Extension {
  return [
    gutter({
      class: 'pc-gutter-plan',
      lineMarker: (view, line) => planMarkerFor(view.state, line),
      lineMarkerChange: changed,
      initialSpacer: () => new PlanMarker('result', 'move', ''),
      domEventHandlers: {
        mousedown: (view, line) => openCardAtLine(view, line),
      },
    }),
    gutter({
      class: 'pc-gutter-lint',
      lineMarker: (view, line) => {
        const flags = lintFlagsForLine(view.state, line);
        if (flags.length === 0) return null;
        const sev = flags.some((f) => f.severity === 'warn') ? 'warn' : 'hint';
        const label = `${flags.length} lint flag${flags.length > 1 ? 's' : ''}:\n${flags.map(lintTitle).join('\n')}`;
        return new LintMarker(flags.length, sev, label);
      },
      lineMarkerChange: changed,
      domEventHandlers: {
        mousedown: (view, line) => openCardAtLine(view, line),
      },
    }),
    gutter({
      class: 'pc-gutter-prov',
      lineMarker: (view, line) => provenanceMarkerFor(lineUnits(view.state, line)),
      lineMarkerChange: changed,
      domEventHandlers: {
        mousedown: (view, line) => openCardAtLine(view, line),
      },
    }),
  ];
}
