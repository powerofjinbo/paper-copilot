/**
 * The workspace shell (docs/design.md "UI layout"): top bar; left rail of panel tabs and the active
 * panel; the CodeMirror editor in the centre; the PDF on the right (resizable, collapsible); the
 * status bar; toasts. The shell owns the ApiClient, routes server messages into the stores and binds
 * the global shortcuts (Ctrl/Cmd+S compile, Ctrl/Cmd+Shift+J forward search).
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { ApiClient, EditorHandle, PdfHandle } from './contracts';
import { Editor } from './editor/Editor';
import { PdfPane } from './pdf/PdfPane';
import { getApiClient } from './api';
import { errorText } from './api/errors';
import { compileNow, forwardSync, loadWorkspace, notify, refetchFacts, refetchOutline, refetchQuestions } from './components/actions';
import { LeftRail } from './components/LeftRail';
import { Resizer } from './components/Resizer';
import { ShortcutHelp } from './components/ShortcutHelp';
import { StatusBar } from './components/StatusBar';
import { Toasts } from './components/Toasts';
import { TopBar } from './components/TopBar';
import { PanelHost } from './panels/PanelHost';
import { htmlLang, jobKey, translate, useT } from './i18n';
import { useShell } from './state/extra';
import { useWorkspace } from './state/store';
import './styles/shell.css';
import './styles/panels.css';

function tr(key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]): string {
  return translate(useShell.getState().lang, key, vars);
}

/** Apply the theme preference as `data-theme` on <html> (tokens.css reads it). */
function useThemeAttribute(): void {
  const theme = useShell((s) => s.theme);
  useEffect(() => {
    const el = document.documentElement;
    if (theme === 'system') el.removeAttribute('data-theme');
    else el.setAttribute('data-theme', theme);
  }, [theme]);
}

/** Load the project and keep it fresh across reconnects. */
function useBootstrap(api: ApiClient): void {
  useEffect(() => {
    let firstConnection = true;
    const ws = useWorkspace.getState();
    ws.setConnected(api.connected);
    const off = api.onConnection((c) => {
      useWorkspace.getState().setConnected(c);
      if (c) {
        // The first connection follows the initial load (reload only if that load failed, e.g. the
        // server was still starting); later connections may follow a server restart.
        if (!firstConnection || !useWorkspace.getState().project) void loadWorkspace(api);
        firstConnection = false;
      }
    });
    void loadWorkspace(api);
    void api.ready();
    return off;
  }, [api]);
}

/** Route server messages into the stores. */
function useBus(api: ApiClient): void {
  useEffect(() => {
    const ws = () => useWorkspace.getState();
    let factsTimer: ReturnType<typeof setTimeout> | null = null;
    const onJobDone = (kind: string) => {
      if (kind === 'read-repo') void refetchFacts(api).catch(() => undefined);
      else if (kind === 'outline-framings') void refetchOutline(api).catch(() => undefined);
      else if (kind === 'referee') void refetchQuestions(api).catch(() => undefined);
    };
    const offs = [
      api.on('welcome', (m) => {
        useShell.getState().setFakeLlm(m.fakeLlm);
        useShell.getState().setServerVersion(m.serverVersion);
      }),
      api.on('compile.status', (m) => {
        const prev = ws().compile;
        // Keep showing the last PDF while a new compile runs or fails.
        ws().setCompile({ state: m.state, pdfVersion: m.pdfVersion ?? prev.pdfVersion, errors: m.errors, logTail: m.logTail });
      }),
      api.on('job.progress', (m) => {
        ws().upsertJob(m.jobId, { kind: m.kind, state: m.state, message: m.message });
        if (m.state === 'done') onJobDone(m.kind);
        if (m.state === 'error') notify('error', tr('job.errorMsg', { job: tr(jobKey(m.kind)), msg: m.message }));
      }),
      api.on('facts.updated', () => {
        if (factsTimer) clearTimeout(factsTimer);
        factsTimer = setTimeout(() => {
          factsTimer = null;
          void refetchFacts(api).catch((e: unknown) => notify('warn', errorText(e)));
        }, 120);
      }),
      api.on('plan.updated', (m) => ws().setOutline(m.outline)),
      api.on('cost.update', (m) => ws().setCost(m.totals)),
      api.on('notice', (m) => notify(m.level, m.message)),
      api.on('lint.update', (m) => {
        // The flags are the FULL list for that file.
        const f = ws().file;
        if (!f || m.file === f) ws().setLint(m.flags);
      }),
      api.on('draft.proposed', (m) => {
        const ed = ws().editor;
        if (ed) ed.insertDraft(m);
        else useShell.getState().queueDraft(m);
      }),
    ];
    return () => {
      if (factsTimer) clearTimeout(factsTimer);
      for (const off of offs) off();
    };
  }, [api]);
}

/**
 * Ctrl/Cmd+S compiles (the editor's own Mod-s handler runs first and flushes the document, so the
 * compile sees the latest text); Ctrl/Cmd+Shift+J shows the current line in the PDF unless the
 * editor already handled that key.
 */
function useShortcuts(api: ApiClient): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isHelpKey(e)) {
        e.preventDefault();
        useShell.getState().setHelpOpen(!useShell.getState().helpOpen);
        return;
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.repeat) return;
      const k = e.key.toLowerCase();
      if (k === 's' && !e.shiftKey) {
        e.preventDefault();
        void compileNow(api);
      } else if (k === 'j' && e.shiftKey && !e.defaultPrevented) {
        e.preventDefault();
        void forwardSync(api);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [api]);
}

/** Is the key event typing into a text field or the editor (where "?" is a character)? */
function inText(e: KeyboardEvent): boolean {
  const el = (e.target instanceof Element ? e.target : null) ?? document.activeElement;
  if (!el) return false;
  return !!el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], .cm-editor');
}

/** "?" outside text, Ctrl/Cmd+/ outside text (in the editor it toggles a LaTeX comment), F1 anywhere. */
function isHelpKey(e: KeyboardEvent): boolean {
  if (e.repeat || e.defaultPrevented) return false;
  if (e.key === 'F1' && !e.ctrlKey && !e.metaKey && !e.altKey) return true;
  if (inText(e)) return false;
  if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) return true;
  return e.key === '/' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
}

/** Narrowest editor column the auto-fit keeps (about 60 characters of prose plus the gutters). */
const EDITOR_MIN_PX = 560;

/**
 * Give the editor priority over the side panes (one sentence per line only reads well on a wide
 * column): when the editor would be narrower than EDITOR_MIN_PX, hide the PDF first, then the left
 * panel (the rail stays). A pane the user opened explicitly (pinned) is never hidden. Nothing is
 * persisted, so the panes come back when the window is wide enough again.
 */
function useAutoFit(mainRef: RefObject<HTMLDivElement | null>, wantLeft: boolean, wantPdf: boolean): void {
  const leftWidth = useShell((s) => s.leftWidth);
  const rightWidth = useShell((s) => s.rightWidth);
  const pinned = useShell((s) => s.pinned);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? el.getBoundingClientRect().width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [mainRef]);
  useEffect(() => {
    if (!width) return;
    const vw = window.innerWidth;
    const rail = (mainRef.current?.querySelector('.rail') as HTMLElement | null)?.getBoundingClientRect().width ?? 0;
    // the panes' CSS limits (shell.css): left 260px..42vw, PDF 240px..50vw
    const lw = Math.max(260, Math.min(leftWidth, 0.42 * vw));
    const pw = Math.max(240, Math.min(rightWidth, 0.5 * vw));
    const editor = (l: boolean, p: boolean) => width - rail - (l ? lw + 1 : 0) - (p ? pw + 1 : 0);
    let pdf = wantPdf;
    let left = wantLeft;
    if (pdf && !pinned.pdf && editor(left, true) < EDITOR_MIN_PX) pdf = false;
    if (left && !pinned.left && editor(true, pdf) < EDITOR_MIN_PX) left = false;
    useShell.getState().setFitHidden({ left: wantLeft && !left, pdf: wantPdf && !pdf });
  }, [width, wantLeft, wantPdf, leftWidth, rightWidth, pinned, mainRef]);
}

function useDevHandle(api: ApiClient): void {
  useEffect(() => {
    // Dev server, or a build made for the full-stack E2E (`VITE_PAPER_E2E=1 vite build`, e2e/fullstack.mjs).
    if (!import.meta.env.DEV && import.meta.env.VITE_PAPER_E2E !== '1') return;
    (window as unknown as Record<string, unknown>).__paper = { api, workspace: useWorkspace, shell: useShell };
  }, [api]);
}

function Workspace({ api }: { api: ApiClient }) {
  const t = useT();
  useBootstrap(api);
  useBus(api);
  useShortcuts(api);
  useDevHandle(api);
  const lang = useShell((s) => s.lang);
  const file = useWorkspace((s) => s.file);
  const connected = useWorkspace((s) => s.connected);
  const rightPane = useWorkspace((s) => s.rightPane);
  const pdfVersion = useWorkspace((s) => s.compile.pdfVersion);
  const userCollapsed = useShell((s) => s.leftCollapsed);
  const leftWidth = useShell((s) => s.leftWidth);
  const rightWidth = useShell((s) => s.rightWidth);
  const fitHidden = useShell((s) => s.fitHidden);
  const pdfPinned = useShell((s) => s.pinned.pdf);
  const compileState = useWorkspace((s) => s.compile.state);
  const mainRef = useRef<HTMLDivElement>(null);
  // No empty "compile to see the PDF" pane: the PDF pane opens once a PDF exists, a compile ran, or the
  // author asked for it (top-bar PDF button, forward search).
  const wantPdf = rightPane === 'pdf' && (pdfVersion !== null || compileState !== 'idle' || pdfPinned);
  useAutoFit(mainRef, !userCollapsed, wantPdf);
  const leftCollapsed = userCollapsed || fitHidden.left;
  const showPdf = wantPdf && !fitHidden.pdf;

  const onEditorReady = useCallback((h: EditorHandle) => {
    useWorkspace.getState().setEditor(h);
    for (const d of useShell.getState().takeDrafts()) h.insertDraft(d);
  }, []);
  const onPdfReady = useCallback((h: PdfHandle) => useShell.getState().setPdf(h), []);
  const onInverse = useCallback((target: { file: string; line: number }) => {
    const ws = useWorkspace.getState();
    if (target.file !== ws.file) {
      ws.pushNotice('info', `${target.file}:${target.line}`);
      return;
    }
    ws.editor?.revealLine(target.line);
  }, []);
  useEffect(() => {
    if (!showPdf) useShell.getState().setPdf(null);
  }, [showPdf]);

  const style = { '--left-w': `${leftWidth}px`, '--right-w': `${rightWidth}px` } as CSSProperties;

  return (
    <div className={`shell${leftCollapsed ? ' left-collapsed' : ''}${showPdf ? '' : ' right-collapsed'}`} style={style}>
      <TopBar api={api} />
      <div className="shell-main" ref={mainRef}>
        <LeftRail />
        {!leftCollapsed ? (
          <>
            <aside className="shell-panel" aria-label={t('tab.list')} lang={htmlLang(lang)}>
              <PanelHost api={api} />
            </aside>
            <Resizer side="left" label={t('panel.resizeLeft')} />
          </>
        ) : null}
        <main className="shell-editor" lang="en">
          {file ? (
            <Editor key={file} api={api} file={file} onReady={onEditorReady} />
          ) : (
            <div className="editor-empty">
              <p>{t('editor.noFile')}</p>
              {!connected ? <p className="editor-empty-hint">{t('app.fatalHint')}</p> : null}
            </div>
          )}
        </main>
        {showPdf ? (
          <>
            <Resizer side="right" label={t('panel.resizeRight')} />
            <section className="shell-pdf" aria-label="PDF">
              <PdfPane api={api} pdfVersion={pdfVersion} onInverse={onInverse} onReady={onPdfReady} />
            </section>
          </>
        ) : null}
      </div>
      <StatusBar api={api} />
      <Toasts />
      <ShortcutHelp />
    </div>
  );
}

function Splash() {
  const t = useT();
  return (
    <div className="splash" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{t('app.loading')}</span>
    </div>
  );
}

function Fatal({ message }: { message: string }) {
  const t = useT();
  return (
    <div className="splash splash-error" role="alert">
      <h1>{t('app.fatal')}</h1>
      <p className="mono">{message}</p>
      <p className="muted">{t('app.fatalHint')}</p>
    </div>
  );
}

export function App() {
  const [api, setApi] = useState<ApiClient | null>(null);
  const [error, setError] = useState<string | null>(null);
  useThemeAttribute();
  useEffect(() => {
    let alive = true;
    getApiClient().then(
      (a) => alive && setApi(a),
      (e: unknown) => alive && setError(errorText(e)),
    );
    return () => {
      alive = false;
    };
  }, []);
  if (error) return <Fatal message={error} />;
  if (!api) return <Splash />;
  return <Workspace api={api} />;
}
