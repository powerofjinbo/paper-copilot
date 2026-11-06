/** Hover over a sentence for 400 ms opens its card; leaving both the sentence and the card closes it. */
import type { Extension } from '@codemirror/state';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { editorEnv } from '../env';
import { cardField, closeCardEffect } from './cardState';

export const HOVER_MS = 400;
const CLOSE_MS = 280;
const QUIET_AFTER_TYPING_MS = 900;

class HoverCards {
  openTimer: ReturnType<typeof setTimeout> | null = null;
  closeTimer: ReturnType<typeof setTimeout> | null = null;
  candidate: string | null = null;
  lastTyping = 0;
  onCardEnter = () => this.cancelClose();
  onCardLeave = () => this.scheduleClose();

  constructor(readonly view: EditorView) {
    view.dom.addEventListener('pc-card-enter', this.onCardEnter);
    view.dom.addEventListener('pc-card-leave', this.onCardLeave);
  }

  update(u: ViewUpdate): void {
    if (u.transactions.some((tr) => tr.isUserEvent('input') || tr.isUserEvent('delete'))) this.lastTyping = Date.now();
  }

  move(e: MouseEvent): void {
    if (e.buttons) return;
    const card = this.view.state.field(cardField);
    if (card?.pinned) return;
    const target = e.target as HTMLElement | null;
    const el = target && typeof target.closest === 'function' ? target.closest('[data-unit]') : null;
    const id = el?.getAttribute('data-unit') ?? null;
    if (card && id === card.id) {
      this.cancelClose();
      this.candidate = id;
      return;
    }
    if (card) this.scheduleClose();
    if (id !== this.candidate) {
      this.candidate = id;
      if (this.openTimer) clearTimeout(this.openTimer);
      this.openTimer = id ? setTimeout(() => this.open(id), HOVER_MS) : null;
    }
  }

  leave(e: MouseEvent): void {
    this.candidate = null;
    if (this.openTimer) clearTimeout(this.openTimer);
    this.openTimer = null;
    const to = e.relatedTarget as HTMLElement | null;
    if (to && typeof to.closest === 'function' && to.closest('.pc-card-host')) return;
    this.scheduleClose();
  }

  open(id: string): void {
    this.openTimer = null;
    if (this.candidate !== id) return;
    if (Date.now() - this.lastTyping < QUIET_AFTER_TYPING_MS || this.view.composing) return;
    const card = this.view.state.field(cardField);
    if (card?.pinned || card?.id === id) return;
    this.cancelClose();
    this.view.state.facet(editorEnv)?.ops.openCard(this.view, id, { pinned: false, focus: false });
  }

  scheduleClose(): void {
    if (this.closeTimer) return;
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      const c = this.view.state.field(cardField);
      if (c && !c.pinned) this.view.dispatch({ effects: closeCardEffect.of(null) });
    }, CLOSE_MS);
  }

  cancelClose(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
  }

  destroy(): void {
    if (this.openTimer) clearTimeout(this.openTimer);
    this.cancelClose();
    this.view.dom.removeEventListener('pc-card-enter', this.onCardEnter);
    this.view.dom.removeEventListener('pc-card-leave', this.onCardLeave);
  }
}

export function hoverCards(): Extension {
  return ViewPlugin.fromClass(HoverCards, {
    eventHandlers: {
      mousemove(this: HoverCards, e: MouseEvent) {
        this.move(e);
      },
      mouseleave(this: HoverCards, e: MouseEvent) {
        this.leave(e);
      },
    },
  });
}
