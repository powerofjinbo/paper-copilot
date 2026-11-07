/**
 * PDF pane (contracts.ts PdfPaneProps / PdfHandle): PDF.js pages rendered lazily at devicePixelRatio,
 * fit-width by default, zoom (+ / − / 0, Ctrl+wheel), a page indicator, reading position kept across
 * re-compiles, click -> api.synctexInverse -> onInverse, and PdfHandle.showBox for forward search.
 *
 * States: no PDF yet ("Compile to see the PDF"), loading, error (with retry), and stale: the last good
 * PDF stays on screen while a compile runs or after it failed, with a small badge in the toolbar.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { PdfHandle, PdfPaneProps } from '../contracts';
import { isMockClient } from '../api/extras';
import { useWorkspace } from '../state/store';
import { zoomPercent } from './layout';
import { usePdfT } from './strings';
import { PdfViewer, type ViewerState } from './viewer';
import './pdf.css';

const STORAGE_KEY = 'paper-copilot.pdf.v1';

const INITIAL: ViewerState = { hasDoc: false, loading: false, error: null, page: 0, pages: 0, scale: 96 / 72, fit: true };

export function PdfPane({ api, pdfVersion, onInverse, onReady }: PdfPaneProps) {
  const t = usePdfT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PdfViewer | null>(null);
  const [vs, setVs] = useState<ViewerState>(INITIAL);
  const [notice, setNotice] = useState<{ id: number; text: string; tone: 'info' | 'error' } | null>(null);
  const [announce, setAnnounce] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const [pageDraft, setPageDraft] = useState<string | null>(null);
  const compileState = useWorkspace((s) => s.compile.state);
  const logTail = useWorkspace((s) => s.compile.logTail);
  const logLast = logTail.trim().split('\n').slice(-2).join(' ').slice(0, 300);
  const mock = isMockClient(api);

  // Latest props for callbacks created once.
  const latest = useRef({ api, onInverse, t });
  latest.current = { api, onInverse, t };
  const clickSeq = useRef(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((text: string, tone: 'info' | 'error' = 'info') => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice({ id: Date.now(), text, tone });
    noticeTimer.current = setTimeout(() => setNotice(null), tone === 'error' ? 5000 : 2400);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const viewer = new PdfViewer(el, {
      storageKey: STORAGE_KEY,
      onState: setVs,
      onBoxShown: (page) => {
        const { t } = latest.current;
        setAnnounce(t('highlighted', { where: t('pageN', { n: page }) }));
      },
      onClick: (p) => {
        const seq = ++clickSeq.current;
        const { api } = latest.current;
        api.synctexInverse(p.page, p.x, p.y).then(
          (target) => {
            if (seq !== clickSeq.current) return; // a newer click wins
            if (target) latest.current.onInverse(target);
            else flash(latest.current.t('noSource'));
          },
          (err: unknown) => {
            if (seq !== clickSeq.current) return;
            flash(latest.current.t('inverseFailed', { msg: err instanceof Error ? err.message : String(err) }), 'error');
          },
        );
      },
    });
    viewerRef.current = viewer;
    setVs(viewer.getState());
    return () => {
      viewer.destroy();
      viewerRef.current = null;
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, [flash]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (pdfVersion === null) viewer.clear();
    else void viewer.load(api.pdfUrl(pdfVersion));
  }, [api, pdfVersion, retryKey]);

  const handle = useMemo<PdfHandle>(() => ({ showBox: (box) => viewerRef.current?.showBox(box) }), []);
  useEffect(() => {
    onReady?.(handle);
  }, [onReady, handle]);

  const retry = useCallback(() => setRetryKey((k) => k + 1), []);
  const compile = useCallback(() => {
    latest.current.api.compile().catch((err: unknown) => flash(err instanceof Error ? err.message : String(err), 'error'));
  }, [flash]);

  const onPageSubmit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(pageDraft);
    if (Number.isFinite(n)) viewerRef.current?.goToPage(n);
    setPageDraft(null);
    scrollRef.current?.focus({ preventScroll: true });
  };

  const running = compileState === 'running';
  let badge: { text: string; tone: 'busy' | 'warn' | 'error' } | null = null;
  if (vs.hasDoc) {
    if (vs.error) badge = { text: t('errorNew', { msg: vs.error }), tone: 'error' };
    else if (vs.loading) badge = { text: t('updating'), tone: 'busy' };
    else if (running) badge = { text: t('staleCompiling'), tone: 'busy' };
    else if (compileState === 'error') badge = { text: t('staleFailed'), tone: 'warn' };
  }

  const state = vs.hasDoc ? 'ready' : vs.error ? 'error' : vs.loading ? 'loading' : pdfVersion === null ? 'empty' : 'loading';
  const pct = zoomPercent(vs.scale);
  const shownPage = vs.pages ? Math.max(1, vs.page) : 0;

  return (
    <div className="pdfp" data-state={state} data-stale={badge ? 'true' : 'false'}>
      <div className="pdfp-bar" role="toolbar" aria-label={t('toolbar')}>
        <form className="pdfp-pagebox" onSubmit={onPageSubmit} hidden={!vs.hasDoc}>
          <label className="pdfp-pagelabel">
            <span className="pdfp-muted">{t('page')}</span>
            <input
              className="pdfp-pageinput"
              inputMode="numeric"
              aria-label={t('pageInput')}
              disabled={!vs.pages}
              value={pageDraft ?? (shownPage ? String(shownPage) : '–')}
              onChange={(e) => setPageDraft(e.target.value.replace(/[^\d]/g, ''))}
              onFocus={(e) => {
                setPageDraft(String(shownPage || ''));
                e.target.select();
              }}
              onBlur={() => setPageDraft(null)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setPageDraft(null);
                  scrollRef.current?.focus({ preventScroll: true });
                }
              }}
            />
            <span className="pdfp-muted">{t('pageOf', { n: vs.pages || '–' })}</span>
          </label>
        </form>
        <span className="pdfp-spacer" />
        <div className="pdfp-zoom" hidden={!vs.hasDoc}>
          <button type="button" className="pdfp-btn" aria-label={t('zoomOut')} title={t('zoomOut')} disabled={!vs.hasDoc} onClick={() => viewerRef.current?.zoomOut()}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3.5 8h9" />
            </svg>
          </button>
          <span className="pdfp-pct" aria-label={t('zoomLevel', { p: pct })} title={t('zoomLevel', { p: pct })}>
            {vs.hasDoc ? `${pct}%` : '–'}
          </span>
          <button type="button" className="pdfp-btn" aria-label={t('zoomIn')} title={t('zoomIn')} disabled={!vs.hasDoc} onClick={() => viewerRef.current?.zoomIn()}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3.5 8h9M8 3.5v9" />
            </svg>
          </button>
          <button
            type="button"
            className="pdfp-btn"
            aria-label={t('fitWidth')}
            title={t('fitWidth')}
            aria-pressed={vs.fit}
            disabled={!vs.hasDoc}
            onClick={() => viewerRef.current?.fitWidth()}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2.5 3v10M13.5 3v10M5 8h6M6.5 6.2 4.8 8l1.7 1.8M9.5 6.2 11.2 8l-1.7 1.8" />
            </svg>
          </button>
        </div>
      </div>

      <div className="pdfp-body">
        <div ref={scrollRef} className="pdfp-scroll" tabIndex={0} role="region" aria-label={t('pages')} aria-busy={vs.loading} />
        <div className="pdfp-status" aria-live="polite">
          {badge ? (
            <span className={`pdfp-badge is-${badge.tone}`} title={badge.text}>
              {badge.tone === 'busy' ? <span className="pdfp-dot" aria-hidden="true" /> : null}
              <span className="pdfp-badge-text">{badge.text}</span>
              {badge.tone === 'error' ? (
                <button type="button" className="pdfp-link" onClick={retry}>
                  {t('retry')}
                </button>
              ) : null}
            </span>
          ) : null}
        </div>
        {state !== 'ready' ? (
          <div className="pdfp-message" role={state === 'error' ? 'alert' : 'status'}>
            {state === 'empty' ? (
              running ? (
                <>
                  <span className="pdfp-spinner" aria-hidden="true" />
                  <p className="pdfp-title">{t('compiling')}</p>
                </>
              ) : (
                <>
                  <svg className="pdfp-glyph" viewBox="0 0 40 48" aria-hidden="true">
                    <path d="M7 2.5h18l8.5 8.5v32a2.5 2.5 0 0 1-2.5 2.5H7A2.5 2.5 0 0 1 4.5 43V5A2.5 2.5 0 0 1 7 2.5Z" />
                    <path d="M25 2.5V11h8.5M11 20h18M11 26h18M11 32h12" />
                  </svg>
                  {compileState === 'error' ? (
                    <>
                      <p className="pdfp-title">{t('failedTitle')}</p>
                      <p className="pdfp-hint">{t('emptyFailed')}</p>
                      <button type="button" className="pdfp-action" onClick={compile}>
                        {t('compileAgain')}
                      </button>
                    </>
                  ) : compileState === 'ok' ? (
                    // a compile succeeded without a PDF (the browser demo has no LaTeX): say why, and do not
                    // offer the same Compile button again
                    mock ? (
                      <>
                        <p className="pdfp-title">{t('demoTitle')}</p>
                        <p className="pdfp-hint">{t('demoHint')}</p>
                      </>
                    ) : (
                      <>
                        <p className="pdfp-title">{t('noPdfTitle')}</p>
                        {logLast ? <p className="pdfp-hint pdfp-errmsg">{logLast}</p> : null}
                      </>
                    )
                  ) : (
                    <>
                      <p className="pdfp-title">{t('empty')}</p>
                      <p className="pdfp-hint">{t('emptyHint')}</p>
                      <button type="button" className="pdfp-action" onClick={compile}>
                        {t('compile')}
                      </button>
                    </>
                  )}
                </>
              )
            ) : state === 'loading' ? (
              <>
                <span className="pdfp-spinner" aria-hidden="true" />
                <p className="pdfp-title">{t('loading')}</p>
              </>
            ) : (
              <>
                <p className="pdfp-title">{t('error')}</p>
                <p className="pdfp-hint pdfp-errmsg">{vs.error}</p>
                <button type="button" className="pdfp-action" onClick={retry}>
                  {t('retry')}
                </button>
              </>
            )}
          </div>
        ) : null}
        {notice ? (
          <div key={notice.id} className={`pdfp-notice is-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
            {notice.text}
          </div>
        ) : null}
        <div className="pdfp-sr" aria-live="polite">
          {announce}
        </div>
      </div>
    </div>
  );
}
