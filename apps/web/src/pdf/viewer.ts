/**
 * A small imperative PDF viewer on top of PDF.js (no pdf_viewer framework): stacked page canvases,
 * lazy rendering through an IntersectionObserver, zoom, reading-position memory across reloads,
 * click -> SyncTeX point, and a fading highlight box. The React pane (PdfPane.tsx) owns the toolbar
 * and the state messages; this class owns the scroll container's content.
 *
 * Reloads are flicker-free: the new document is opened and the pages that will be on screen at the
 * remembered position are rendered offscreen before the old pages are swapped out, then the previous
 * PDFDocumentProxy is destroyed. A newer load cancels an older one at any stage.
 */
import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { clientToPageCss, cssToTopLeft, insidePage, outputScale, topLeftBoxToCss, viewportSize, type PageGeometry, type TopLeftBox } from './coords';
import {
  CSS_PER_POINT,
  clampScale,
  clampScroll,
  contentWidth,
  currentPage,
  fitWidthScale,
  layoutPages,
  offsetOf,
  pageLeft,
  positionAt,
  revealOffset,
  stepZoom,
  visiblePages,
  type Layout,
  type ReadingPosition,
} from './layout';

GlobalWorkerOptions.workerSrc = workerUrl;

export interface ViewerState {
  /** A document is on screen (possibly an older one while a newer loads). */
  hasDoc: boolean;
  loading: boolean;
  error: string | null;
  page: number;
  pages: number;
  /** CSS px per PDF point. */
  scale: number;
  fit: boolean;
}

export interface PagePoint {
  /** 1-based page. */
  page: number;
  /** SyncTeX coordinates: PDF points from the top-left corner of the page. */
  x: number;
  y: number;
}

export interface ViewerOptions {
  onState(s: ViewerState): void;
  onClick(p: PagePoint): void;
  /** A showBox highlight was drawn on this page (for a live-region announcement). */
  onBoxShown?(page: number): void;
  /** sessionStorage key for the reading position and zoom (survives a pane toggle or page refresh). */
  storageKey?: string;
}

export interface ShowBox extends TopLeftBox {
  page: number;
}

interface Slot {
  index: number;
  page: PDFPageProxy;
  geom: PageGeometry;
  el: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  renderedScale: number;
  task: RenderTask | null;
  /** Scale the in-flight task paints at. */
  taskScale: number;
  visible: boolean;
}

interface Saved {
  pos: ReadingPosition;
  scale: number | 'fit';
}

/** Rendered pages kept in memory beyond the visible ones. */
const KEEP_RENDERED = 8;
const HIGHLIGHT_MS = 1600;
const PRERENDER_TIMEOUT_MS = 2500;

function isCancel(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'RenderingCancelledException';
}

/** pdfjs-dist 6 frees a document through its loading task (PDFDocumentProxy.destroy() is gone). */
function freeDoc(doc: PDFDocumentProxy): void {
  void doc.loadingTask.destroy().catch(() => undefined);
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { name?: string; message?: string; status?: number };
    if (e.name === 'ResponseException' && e.status) return `HTTP ${e.status}`;
    if (e.name === 'InvalidPDFException') return 'The file is not a valid PDF.';
    if (e.message) return e.message;
  }
  return String(err);
}

export class PdfViewer {
  private readonly scroller: HTMLDivElement;
  private readonly opts: ViewerOptions;
  private doc: PDFDocumentProxy | null = null;
  private slots: Slot[] = [];
  private layout: Layout = layoutPages([]);
  private pagesEl: HTMLDivElement | null = null;
  private scale = CSS_PER_POINT;
  private fit = true;
  private gen = 0;
  private loadingTask: PDFDocumentLoadingTask | null = null;
  private loading = false;
  private error: string | null = null;
  private page = 0;
  private pendingBox: ShowBox | null = null;
  private saved: Saved | null;
  private destroyed = false;
  private io: IntersectionObserver;
  private ro: ResizeObserver;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollRaf = 0;
  private resizeRaf = 0;
  private lastWidth = 0;
  private down: { x: number; y: number } | null = null;
  private hlTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(scroller: HTMLDivElement, opts: ViewerOptions) {
    this.scroller = scroller;
    this.opts = opts;
    this.saved = this.readSaved();
    if (this.saved && this.saved.scale !== 'fit') {
      this.fit = false;
      this.scale = clampScale(this.saved.scale);
    }
    this.io = new IntersectionObserver((entries) => this.onIntersect(entries), { root: scroller, rootMargin: '60% 0px 60% 0px' });
    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(scroller);
    this.lastWidth = scroller.clientWidth;
    scroller.addEventListener('scroll', this.onScroll, { passive: true });
    scroller.addEventListener('pointerdown', this.onPointerDown);
    scroller.addEventListener('click', this.onClickEvent);
    scroller.addEventListener('keydown', this.onKey);
    scroller.addEventListener('wheel', this.onWheel, { passive: false });
  }

  /* ------------------------------------------------------------------------------ */
  /* Public API                                                                      */
  /* ------------------------------------------------------------------------------ */

  getState(): ViewerState {
    return {
      hasDoc: !!this.doc,
      loading: this.loading,
      error: this.error,
      page: this.page,
      pages: this.slots.length,
      scale: this.scale,
      fit: this.fit,
    };
  }

  /** Open `url`, keep the current document on screen until the new one is ready, then swap. */
  async load(url: string): Promise<void> {
    if (this.destroyed) return;
    const gen = ++this.gen;
    const prevTask = this.loadingTask;
    this.loadingTask = null;
    if (prevTask) void prevTask.destroy().catch(() => undefined);
    this.loading = true;
    this.error = null;
    this.emit();

    let doc: PDFDocumentProxy | null = null;
    let newSlots: Slot[] = [];
    try {
      const task = getDocument({ url });
      this.loadingTask = task;
      doc = await task.promise;
      if (gen !== this.gen) {
        freeDoc(doc);
        return;
      }
      const pages = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc!.getPage(i + 1)));
      if (gen !== this.gen) {
        freeDoc(doc);
        return;
      }

      // Where the reader is now (or was before a refresh), at the top of the viewport.
      const pos = this.capture(0, 0) ?? this.saved?.pos ?? { page: 1, frac: 0, xFrac: 0 };
      newSlots = pages.map((page, index) => this.makeSlot(page, index));
      const scale = this.fit ? this.fitScale(newSlots) : this.scale;
      const layout = this.computeLayout(newSlots, scale);
      const paneH = this.scroller.clientHeight;
      const paneW = this.scroller.clientWidth;
      const target = offsetOf(layout, pos, paneW);
      const top = clampScroll(target.y, layout.height, paneH);

      // Paint what will be on screen before swapping, so a re-compile never flashes blank pages.
      const onScreen = visiblePages(layout, top, paneH).map((i) => newSlots[i]!);
      await Promise.race([
        Promise.all(onScreen.map((s) => this.renderSlot(s, scale))),
        new Promise((r) => setTimeout(r, PRERENDER_TIMEOUT_MS)),
      ]);
      if (gen !== this.gen) {
        newSlots.forEach((s) => s.task?.cancel());
        freeDoc(doc);
        return;
      }

      // The reader may have zoomed the old pages while the new ones were painting.
      const wanted = this.fit ? null : this.scale;
      this.swapIn(doc, newSlots, scale, layout, pos);
      if (wanted !== null && Math.abs(wanted - scale) > 1e-6) this.setScale(wanted);
      this.loadingTask = null;
      this.loading = false;
      this.error = null;
      this.emit();
      if (this.pendingBox) {
        const b = this.pendingBox;
        this.pendingBox = null;
        this.showBox(b);
      }
    } catch (err) {
      if (gen !== this.gen || this.destroyed) return;
      newSlots.forEach((s) => s.task?.cancel());
      if (doc && doc !== this.doc) freeDoc(doc);
      this.loadingTask = null;
      this.loading = false;
      this.error = errorMessage(err);
      this.emit();
      if (this.pendingBox && this.doc) {
        const b = this.pendingBox;
        this.pendingBox = null;
        this.showBox(b);
      }
    }
  }

  /** Drop the document (no PDF any more). */
  clear(): void {
    this.gen++;
    const t = this.loadingTask;
    this.loadingTask = null;
    if (t) void t.destroy().catch(() => undefined);
    this.teardownDoc();
    this.loading = false;
    this.error = null;
    this.emit();
  }

  zoomIn(): void {
    this.setScale(stepZoom(this.scale, 1));
  }

  zoomOut(): void {
    this.setScale(stepZoom(this.scale, -1));
  }

  fitWidth(): void {
    this.fit = true;
    this.setScale(this.slots.length ? this.fitScale(this.slots) : this.scale, undefined, true);
  }

  /** Set the zoom (CSS px per point). `anchor` is a point in the scroll container's viewport that stays fixed. */
  setScale(scale: number, anchor?: { x: number; y: number }, keepFit = false): void {
    const next = clampScale(scale);
    if (!keepFit) this.fit = false;
    if (!this.slots.length) {
      this.scale = next;
      this.emit();
      this.persist();
      return;
    }
    const a = anchor ?? { x: 0, y: 0 };
    const pos = this.capture(a.x, a.y);
    this.scale = next;
    this.applyLayout();
    if (pos) this.restore(pos, a.x, a.y);
    this.scheduleRender(140);
    this.updatePage();
    this.emit();
    this.persist();
  }

  goToPage(page: number): void {
    const i = Math.min(Math.max(1, Math.round(page)), this.slots.length) - 1;
    if (i < 0) return;
    this.scroller.scrollTo({ top: this.layout.tops[i]! - 8, behavior: 'auto' });
  }

  /** Scroll a SyncTeX box (PDF points, top-left origin) into view and flash a highlight over it. */
  showBox(box: ShowBox): void {
    if (this.destroyed) return;
    if (!this.doc || this.loading) {
      this.pendingBox = box;
      return;
    }
    const slot = this.slots[box.page - 1];
    if (!slot) return;
    this.clearHighlight();
    const size = viewportSize(slot.geom, this.scale);
    const r = topLeftBoxToCss(slot.geom, this.scale, box);
    const padX = 3;
    const padY = 2;
    const left = Math.max(0, r.left - padX);
    const top = Math.max(0, r.top - padY);
    const width = Math.min(size.width - left, r.width + 2 * padX);
    const height = Math.min(size.height - top, Math.max(r.height, 6) + 2 * padY);
    const hl = document.createElement('div');
    hl.className = 'pdfp-hl';
    hl.setAttribute('aria-hidden', 'true');
    // Percentages, so the box stays put through a zoom while it fades.
    hl.style.left = `${(left / size.width) * 100}%`;
    hl.style.top = `${(top / size.height) * 100}%`;
    hl.style.width = `${(width / size.width) * 100}%`;
    hl.style.height = `${(height / size.height) * 100}%`;
    slot.el.appendChild(hl);
    this.hlTimer = setTimeout(() => hl.remove(), HIGHLIGHT_MS + 100);

    const pageTop = this.layout.tops[slot.index]!;
    const paneW = this.scroller.clientWidth;
    const pageX = pageLeft(this.layout, paneW, size.width);
    const y = revealOffset(pageTop + top, height, this.scroller.scrollTop, this.scroller.clientHeight);
    const x = this.layout.width > paneW ? revealOffset(pageX + left, width, this.scroller.scrollLeft, paneW, 24) : null;
    if (y !== null || x !== null) {
      this.scroller.scrollTo({
        top: y ?? this.scroller.scrollTop,
        left: x ?? this.scroller.scrollLeft,
        behavior: reducedMotion() ? 'auto' : 'smooth',
      });
    }
    this.opts.onBoxShown?.(box.page);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.gen++;
    const t = this.loadingTask;
    this.loadingTask = null;
    if (t) void t.destroy().catch(() => undefined);
    this.persist(true);
    this.teardownDoc();
    this.destroyed = true;
    this.io.disconnect();
    this.ro.disconnect();
    if (this.renderTimer) clearTimeout(this.renderTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.hlTimer) clearTimeout(this.hlTimer);
    cancelAnimationFrame(this.scrollRaf);
    cancelAnimationFrame(this.resizeRaf);
    this.scroller.removeEventListener('scroll', this.onScroll);
    this.scroller.removeEventListener('pointerdown', this.onPointerDown);
    this.scroller.removeEventListener('click', this.onClickEvent);
    this.scroller.removeEventListener('keydown', this.onKey);
    this.scroller.removeEventListener('wheel', this.onWheel);
  }

  /* ------------------------------------------------------------------------------ */
  /* Document and layout                                                             */
  /* ------------------------------------------------------------------------------ */

  private makeSlot(page: PDFPageProxy, index: number): Slot {
    const el = document.createElement('div');
    el.className = 'pdfp-page';
    el.dataset.index = String(index);
    el.dataset.page = String(index + 1);
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', `Page ${index + 1}`);
    return { index, page, geom: { viewBox: page.view, rotation: page.rotate, userUnit: page.userUnit }, el, canvas: null, renderedScale: 0, task: null, taskScale: 0, visible: false };
  }

  private fitScale(slots: Slot[]): number {
    const widest = Math.max(...slots.map((s) => viewportSize(s.geom, 1).width));
    return fitWidthScale(this.scroller.clientWidth, widest);
  }

  private computeLayout(slots: Slot[], scale: number): Layout {
    return layoutPages(slots.map((s) => viewportSize(s.geom, scale)));
  }

  /** Position page elements for the current scale; returns nothing, updates this.layout. */
  private applyLayout(): void {
    this.layout = this.computeLayout(this.slots, this.scale);
    if (!this.pagesEl) return;
    const paneW = this.scroller.clientWidth;
    this.pagesEl.style.height = `${this.layout.height}px`;
    this.pagesEl.style.width = `${contentWidth(this.layout, paneW)}px`;
    for (const s of this.slots) {
      const w = this.layout.widths[s.index]!;
      const h = this.layout.heights[s.index]!;
      s.el.style.width = `${w}px`;
      s.el.style.height = `${h}px`;
      s.el.style.top = `${this.layout.tops[s.index]!}px`;
      s.el.style.left = `${pageLeft(this.layout, paneW, w)}px`;
    }
  }

  private swapIn(doc: PDFDocumentProxy, slots: Slot[], scale: number, layout: Layout, pos: ReadingPosition): void {
    const oldDoc = this.doc;
    const oldSlots = this.slots;
    const oldEl = this.pagesEl;
    for (const s of oldSlots) {
      s.task?.cancel();
      this.io.unobserve(s.el);
    }

    const el = document.createElement('div');
    el.className = 'pdfp-pages';
    for (const s of slots) el.appendChild(s.el);
    this.doc = doc;
    this.slots = slots;
    this.scale = scale;
    this.layout = layout;
    this.pagesEl = el;
    if (oldEl) oldEl.replaceWith(el);
    else this.scroller.appendChild(el);
    this.applyLayout();
    this.restore(pos, 0, 0);
    this.updatePage();
    for (const s of slots) this.io.observe(s.el);
    for (const s of slots) s.el.setAttribute('aria-label', `Page ${s.index + 1} of ${slots.length}`);
    if (oldDoc) freeDoc(oldDoc);
  }

  private teardownDoc(): void {
    for (const s of this.slots) {
      s.task?.cancel();
      this.io.unobserve(s.el);
    }
    this.slots = [];
    this.pagesEl?.remove();
    this.pagesEl = null;
    this.layout = layoutPages([]);
    this.page = 0;
    const d = this.doc;
    this.doc = null;
    if (d) freeDoc(d);
  }

  /** Reading position of the viewport point (ax, ay), relative to the scroll container's top-left. */
  private capture(ax: number, ay: number): ReadingPosition | null {
    if (!this.slots.length) return null;
    return positionAt(this.layout, this.scroller.scrollTop + ay, this.scroller.scrollLeft + ax, this.scroller.clientWidth);
  }

  private restore(pos: ReadingPosition, ax: number, ay: number): void {
    const paneW = this.scroller.clientWidth;
    const o = offsetOf(this.layout, pos, paneW);
    this.scroller.scrollTop = clampScroll(o.y - ay, this.layout.height, this.scroller.clientHeight);
    const cw = contentWidth(this.layout, paneW);
    this.scroller.scrollLeft = cw > paneW ? clampScroll(o.x - ax, cw, paneW) : 0;
  }

  /* ------------------------------------------------------------------------------ */
  /* Rendering                                                                       */
  /* ------------------------------------------------------------------------------ */

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      const slot = this.slots[Number((e.target as HTMLElement).dataset.index)];
      if (slot && slot.el === e.target) slot.visible = e.isIntersecting;
    }
    this.scheduleRender(0);
  }

  private scheduleRender(delay: number): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.renderPass();
    }, delay);
  }

  private renderPass(): void {
    if (this.destroyed) return;
    const scale = this.scale;
    for (const s of this.slots) {
      if (s.visible) {
        if (s.renderedScale !== scale || !s.canvas) void this.renderSlot(s, scale);
      } else if (s.task) {
        s.task.cancel();
        s.task = null;
      }
    }
    // Free canvases of pages far from the reader.
    const rendered = this.slots.filter((s) => s.canvas && !s.visible);
    if (rendered.length > KEEP_RENDERED) {
      const cur = Math.max(0, this.page - 1);
      rendered.sort((a, b) => Math.abs(b.index - cur) - Math.abs(a.index - cur));
      for (const s of rendered.slice(0, rendered.length - KEEP_RENDERED)) this.release(s);
    }
  }

  private release(s: Slot): void {
    s.task?.cancel();
    s.task = null;
    if (s.canvas) {
      s.canvas.width = 0;
      s.canvas.height = 0;
      s.canvas.remove();
      s.canvas = null;
    }
    s.renderedScale = 0;
    s.page.cleanup();
  }

  /** Render a page at `scale` into a fresh canvas and swap it in when done (the old one stays meanwhile). */
  private async renderSlot(s: Slot, scale: number): Promise<void> {
    if (s.task) {
      if (s.taskScale === scale) return;
      s.task.cancel();
      s.task = null;
    }
    const css = viewportSize(s.geom, scale);
    const out = outputScale(window.devicePixelRatio || 1, css.width, css.height);
    const canvas = document.createElement('canvas');
    canvas.className = 'pdfp-canvas';
    canvas.width = Math.max(1, Math.floor(css.width * out));
    canvas.height = Math.max(1, Math.floor(css.height * out));
    canvas.setAttribute('aria-hidden', 'true');
    const viewport = s.page.getViewport({ scale: scale * out });
    let task: RenderTask;
    try {
      task = s.page.render({ canvas, viewport });
    } catch (err) {
      console.warn('[pdf] render failed', err);
      return;
    }
    s.task = task;
    s.taskScale = scale;
    try {
      await task.promise;
    } catch (err) {
      if (!isCancel(err)) console.warn('[pdf] page', s.index + 1, 'did not render:', err);
      if (s.task === task) s.task = null;
      return;
    }
    if (s.task !== task) return;
    s.task = null;
    if (s.canvas) {
      s.canvas.width = 0;
      s.canvas.height = 0;
      s.canvas.replaceWith(canvas);
    } else {
      s.el.prepend(canvas);
    }
    s.canvas = canvas;
    s.renderedScale = scale;
    s.el.classList.add('is-rendered');
    // The zoom moved on while this page was painting: paint again at the new scale.
    if (scale !== this.scale && s.visible) this.scheduleRender(60);
  }

  /* ------------------------------------------------------------------------------ */
  /* Events                                                                          */
  /* ------------------------------------------------------------------------------ */

  private onScroll = (): void => {
    if (this.scrollRaf) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = 0;
      if (this.updatePage()) this.emit();
      this.persist();
    });
  };

  private updatePage(): boolean {
    const p = this.slots.length ? currentPage(this.layout, this.scroller.scrollTop, this.scroller.clientHeight) : 0;
    if (p === this.page) return false;
    this.page = p;
    return true;
  }

  private onResize(): void {
    if (this.resizeRaf) return;
    this.resizeRaf = requestAnimationFrame(() => {
      this.resizeRaf = 0;
      const w = this.scroller.clientWidth;
      if (w === this.lastWidth || !this.slots.length) {
        this.lastWidth = w;
        if (this.slots.length) this.updatePage();
        return;
      }
      this.lastWidth = w;
      if (this.fit) this.setScale(this.fitScale(this.slots), undefined, true);
      else {
        const pos = this.capture(0, 0);
        this.applyLayout();
        if (pos) this.restore(pos, 0, 0);
      }
    });
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.down = { x: e.clientX, y: e.clientY };
  };

  private onClickEvent = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    const down = this.down;
    this.down = null;
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return; // a drag, not a click
    const el = (e.target as HTMLElement | null)?.closest?.('.pdfp-page') as HTMLDivElement | null;
    if (!el) return;
    const slot = this.slots[Number(el.dataset.index)];
    if (!slot || slot.el !== el) return;
    const size = viewportSize(slot.geom, this.scale);
    const p = clientToPageCss(e.clientX, e.clientY, el.getBoundingClientRect(), size.width, size.height);
    if (!insidePage(p.x, p.y, size)) return;
    const tl = cssToTopLeft(slot.geom, this.scale, p.x, p.y);
    this.flashClick(slot, p.x, p.y);
    this.opts.onClick({ page: slot.index + 1, x: Math.round(tl.x * 100) / 100, y: Math.round(tl.y * 100) / 100 });
  };

  private flashClick(slot: Slot, x: number, y: number): void {
    const dot = document.createElement('div');
    dot.className = 'pdfp-click';
    dot.setAttribute('aria-hidden', 'true');
    dot.style.left = `${x}px`;
    dot.style.top = `${y}px`;
    slot.el.appendChild(dot);
    setTimeout(() => dot.remove(), 700);
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.altKey) return;
    const k = e.key;
    let handled = true;
    if (k === '+' || k === '=') this.zoomIn();
    else if (k === '-' || k === '_') this.zoomOut();
    else if (k === '0') this.fitWidth();
    else if (!e.ctrlKey && !e.metaKey && (k === 'n' || k === 'j')) this.goToPage(this.page + 1);
    else if (!e.ctrlKey && !e.metaKey && (k === 'p' || k === 'k')) this.goToPage(this.page - 1);
    else handled = false;
    if (handled) e.preventDefault();
  };

  private onWheel = (e: WheelEvent): void => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    if (!this.slots.length) return;
    // Pixel deltas from a trackpad pinch are small; line deltas from a mouse wheel are not.
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const factor = Math.exp(-Math.max(-200, Math.min(200, dy)) * 0.0025);
    const r = this.scroller.getBoundingClientRect();
    this.setScale(this.scale * factor, { x: e.clientX - r.left, y: e.clientY - r.top });
  };

  private clearHighlight(): void {
    if (this.hlTimer) clearTimeout(this.hlTimer);
    this.hlTimer = null;
    this.scroller.querySelectorAll('.pdfp-hl').forEach((n) => n.remove());
  }

  /* ------------------------------------------------------------------------------ */
  /* State                                                                           */
  /* ------------------------------------------------------------------------------ */

  private emit(): void {
    if (!this.destroyed) this.opts.onState(this.getState());
  }

  private readSaved(): Saved | null {
    if (!this.opts.storageKey) return null;
    try {
      const raw = window.sessionStorage.getItem(this.opts.storageKey);
      if (!raw) return null;
      const v = JSON.parse(raw) as Partial<Saved>;
      const pos = v.pos;
      if (!pos || !Number.isFinite(pos.page) || !Number.isFinite(pos.frac)) return null;
      const scale = v.scale === 'fit' || (typeof v.scale === 'number' && Number.isFinite(v.scale)) ? v.scale : 'fit';
      return { pos: { page: pos.page, frac: pos.frac, xFrac: Number.isFinite(pos.xFrac) ? pos.xFrac! : 0 }, scale };
    } catch {
      return null;
    }
  }

  private persist(now = false): void {
    if (!this.opts.storageKey) return;
    const write = () => {
      this.saveTimer = null;
      const pos = this.capture(0, 0);
      if (!pos) return;
      this.saved = { pos, scale: this.fit ? 'fit' : this.scale };
      try {
        window.sessionStorage.setItem(this.opts.storageKey!, JSON.stringify(this.saved));
      } catch {
        /* private mode or blocked storage: memory only */
      }
    };
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (now) write();
    else this.saveTimer = setTimeout(write, 300);
  }
}
