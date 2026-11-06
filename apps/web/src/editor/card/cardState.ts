/** Which sentence card is open, and how. */
import { StateEffect, StateField } from '@codemirror/state';
import type { CardView } from '../env';
import { unitsField } from '../units';

export interface CardState {
  id: string;
  /** Pinned cards stay open until Esc, a click elsewhere, or the cursor leaving the sentence; hover cards close when the pointer leaves. */
  pinned: boolean;
  /** Move keyboard focus into the card when it opens (Ctrl+. and keyboard-opened sub-views). */
  focus: boolean;
  /** Shown above the sentence (anchored at its start) instead of below it (anchored at its end). */
  above: boolean;
  view: CardView;
  /** Increments on every open, so a re-open builds a fresh card. */
  nonce: number;
}

export const openCardEffect = StateEffect.define<Omit<CardState, 'nonce'>>();
export const closeCardEffect = StateEffect.define<null>();
export const pinCardEffect = StateEffect.define<null>();

let nonceSeq = 0;

export const cardField = StateField.define<CardState | null>({
  create: () => null,
  update(v, tr) {
    let next = v;
    let explicit = false;
    for (const e of tr.effects) {
      if (e.is(openCardEffect)) {
        next = { ...e.value, nonce: ++nonceSeq };
        explicit = true;
      } else if (e.is(closeCardEffect)) {
        next = null;
        explicit = true;
      } else if (e.is(pinCardEffect) && next) {
        next = { ...next, pinned: true };
      }
    }
    if (next) {
      const u = tr.state.field(unitsField).byId.get(next.id);
      if (!u || u.end <= u.start) return null;
      if (!explicit) {
        if (!next.pinned && tr.docChanged) return null;
        // the cursor went to another sentence (click, keys, or a programmatic reveal): the card goes
        if (tr.selection && next.pinned) {
          const head = tr.state.selection.main.head;
          if (head < u.start || head > u.end) return null;
        }
      }
    }
    return next;
  },
});
