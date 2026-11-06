/**
 * The sentence card as a CodeMirror tooltip with a React root inside. The tooltip is anchored at the
 * sentence start (shown above) or at its end (shown below), with `strictSide`, so it never covers the
 * sentence it describes.
 */
import { createRoot, type Root } from 'react-dom/client';
import type { EditorState, Extension } from '@codemirror/state';
import { EditorView, showTooltip, type Tooltip, type TooltipView } from '@codemirror/view';
import { editorEnv } from '../env';
import { unitsField } from '../units';
import { SentenceCard } from './Card';
import { cardSnapshot, sameSnapshot, type CardSnapshot } from './cardData';
import { cardField, type CardState } from './cardState';

function createCardView(view: EditorView, nonce: number, above: boolean): TooltipView {
  const dom = document.createElement('div');
  dom.className = 'pc-card-host';
  let root: Root | null = createRoot(dom);
  let last: CardSnapshot | null = null;

  const render = (state: EditorState) => {
    const env = state.facet(editorEnv);
    const snap = cardSnapshot(state);
    if (!env || !snap || !root || snap.card.nonce !== nonce) return;
    if (last && sameSnapshot(last, snap)) return;
    last = snap;
    root.render(<SentenceCard key={nonce} view={view} env={env} snap={snap} />);
  };
  render(view.state);

  dom.addEventListener('mouseenter', () => view.dom.dispatchEvent(new CustomEvent('pc-card-enter')));
  dom.addEventListener('mouseleave', () => view.dom.dispatchEvent(new CustomEvent('pc-card-leave')));

  return {
    dom,
    overlap: true,
    // Anchor vertically to the sentence's first (above) or last (below) visual line, but horizontally to
    // the start of that text line, so the card sits in the text column and never covers its sentence.
    getCoords(pos) {
      const at = view.coordsAtPos(pos, above ? 1 : -1);
      if (!at) return { left: -10000, right: -10000, top: -10000, bottom: -10000 };
      const lineStart = view.coordsAtPos(view.state.doc.lineAt(pos).from, 1);
      const x = lineStart ? Math.min(lineStart.left, at.left) : at.left;
      return { left: x, right: x + 1, top: at.top, bottom: at.bottom };
    },
    update(u) {
      render(u.state);
    },
    destroy() {
      const r = root;
      root = null;
      const hadFocus = dom.contains(document.activeElement);
      // never unmount synchronously inside another React commit or a CodeMirror update
      setTimeout(() => r?.unmount(), 0);
      if (hadFocus) setTimeout(() => view.focus(), 0);
    },
  };
}

const creators = new Map<number, (view: EditorView) => TooltipView>();

function creatorFor(nonce: number, above: boolean): (view: EditorView) => TooltipView {
  let c = creators.get(nonce);
  if (!c) {
    creators.clear();
    c = (view: EditorView) => createCardView(view, nonce, above);
    creators.set(nonce, c);
  }
  return c;
}

function tooltipFor(state: EditorState, card: CardState | null): Tooltip | null {
  if (!card) return null;
  const u = state.field(unitsField).byId.get(card.id);
  if (!u) return null;
  return {
    pos: card.above ? u.start : u.end,
    above: card.above,
    strictSide: true,
    arrow: false,
    create: creatorFor(card.nonce, card.above),
  };
}

export function cardTooltip(): Extension {
  return [cardField, showTooltip.compute([cardField, unitsField], (state) => tooltipFor(state, state.field(cardField)))];
}

/** Choose the side with more room: above the start of the sentence or below its end. */
export function chooseCardSide(view: EditorView, start: number, end: number): boolean {
  const top = view.coordsAtPos(start, 1);
  const bottom = view.coordsAtPos(end, -1);
  if (!top || !bottom) return false;
  const rect = view.scrollDOM.getBoundingClientRect();
  const spaceAbove = top.top - Math.max(0, rect.top);
  const spaceBelow = Math.min(window.innerHeight, rect.bottom) - bottom.bottom;
  return spaceBelow < 300 && spaceAbove > spaceBelow;
}
