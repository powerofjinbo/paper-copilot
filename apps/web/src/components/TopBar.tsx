/**
 * Top bar, deliberately short: app name · project / file switcher (per-file proposed counts) · compile
 * status pill (click compiles; the caret shows errors, the log, the PDF pane and forward search) · Sync
 * (Pull / Push… / last pull report) · submission status (green ready / amber n issues, opens ④) · the
 * simulated-AI badge (fake mode only) · ⚙ Settings · ? help.
 */
import { useId, useMemo, useState } from 'react';
import type { ApiClient } from '../contracts';
import { htmlLang, useT } from '../i18n';
import { useShell } from '../state/extra';
import { useWorkspace } from '../state/store';
import { compileNow, forwardSync, notify, openPush, openStep, pullNow, revealLine, runSubmissionCheck, switchFile } from './actions';
import { IconCheck, IconChevronDown, IconFile, IconGear, IconHelp, IconLocate, IconPdf, IconPlay, IconPull, IconPush, IconSparkle, IconSync, IconWarn, Spinner } from './Icons';
import { PopoverButton } from './Popover';
import { submissionStatus } from './steps';
import { isNoTex, TexInstallHint, withCode } from './TexInstall';
import { isMockClient } from '../api/extras';
import { startTour, useTour, markDemoReset } from '../tour/Tour';
import { menuEntry, TOUR_STEPS } from '../tour/machine';
import { Badge, IconButton } from './ui';

function BrandMark() {
  return (
    <svg className="brand-mark" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <rect x="1.5" y="1.5" width="17" height="17" rx="4" fill="var(--accent)" />
      <path d="M5.5 7h9M5.5 10h9M5.5 13h5.5" stroke="var(--accent-ink)" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="14" cy="13" r="1.3" fill="var(--accent-ink)" opacity=".55" />
    </svg>
  );
}

/** Project name / file, as a dropdown of the project's .tex files with their open review counts. */
function FileSwitcher() {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  const file = useWorkspace((s) => s.file);
  const units = useWorkspace((s) => s.units);
  const files = useShell((s) => s.files);
  const list = useMemo(() => {
    if (files.length) return files.map((f) => ({ file: f.file, review: f.proposed + f.unsupported, depth: f.depth, included: f.included }));
    return (project?.files ?? []).map((f) => ({ file: f, review: 0, depth: 0, included: true }));
  }, [files, project]);
  // the open file's count is live (units), the others come from GET /api/files
  const liveReview = useMemo(() => units.filter((u) => u.state === 'proposed' || u.state === 'unsupported').length, [units]);
  const label = (
    <>
      <span className="crumb-project">{project?.config.name ?? '…'}</span>
      <span className="crumb-sep" aria-hidden="true">
        /
      </span>
      <span className="crumb-file mono">{file ?? '—'}</span>
      {list.length > 1 ? <IconChevronDown size={13} className="crumb-caret" /> : null}
    </>
  );
  if (list.length <= 1) {
    return (
      <span className="crumbs" title={project?.config.texRoot ?? undefined}>
        {label}
      </span>
    );
  }
  return (
    <PopoverButton className="crumbs crumbs-btn" title={`${t('top.switchFile')}: ${file ?? ''}`} role="menu" align="start" popClass="file-menu" label={label} testId="file-switcher">
      {(close) => (
        <>
          <div className="menu-title">{t('top.files')}</div>
          {list.map((f) => {
            const n = f.file === file ? liveReview : f.review;
            const current = f.file === file;
            return (
              <button
                key={f.file}
                type="button"
                role="menuitem"
                className={`menu-item file-item${current ? ' is-current' : ''}`}
                style={{ paddingLeft: 10 + Math.min(3, f.depth) * 12 }}
                aria-current={current ? 'true' : undefined}
                data-file={f.file}
                onClick={() => {
                  close();
                  switchFile(f.file);
                }}
              >
                <IconFile size={13} />
                <span className="mono file-name">{f.file}</span>
                {n > 0 ? (
                  <span className="file-count" title={t('top.fileReview', { n })}>
                    {t('top.fileReview', { n })}
                  </span>
                ) : null}
              </button>
            );
          })}
        </>
      )}
    </PopoverButton>
  );
}

function compileLabel(t: ReturnType<typeof useT>, compile: ReturnType<typeof useWorkspace.getState>['compile'], demo: boolean): string {
  // the browser demo shows an example PDF (it has no LaTeX): say so instead of "Compiled"
  if (demo && compile.state !== 'running' && compile.pdfVersion !== null) return t('compile.demoPdf');
  if (isNoTex(compile)) return t('compile.noTex');
  return compile.state === 'running'
    ? t('compile.running')
    : compile.state === 'error'
      ? t('compile.error', { n: compile.errors.length })
      : compile.state === 'ok'
        ? compile.pdfVersion === null
          ? t('compile.okNoPdf')
          : t('compile.ok')
        : compile.pdfVersion !== null
          ? t('compile.lastPdf')
          : t('compile.idle');
}

/** Status pill: click compiles; the caret opens the errors, the log, the PDF pane toggle and forward search. */
function CompilePill({ api }: { api: ApiClient }) {
  const t = useT();
  const compile = useWorkspace((s) => s.compile);
  const connected = useWorkspace((s) => s.connected);
  const rightPane = useWorkspace((s) => s.rightPane);
  const setRightPane = useWorkspace((s) => s.setRightPane);
  const pdfFitHidden = useShell((s) => s.fitHidden.pdf);
  const pdfShown = rightPane === 'pdf' && !pdfFitHidden;
  const statusId = useId();
  const demo = isMockClient(api);
  const noTex = isNoTex(compile);
  const label = compileLabel(t, compile, demo);
  const why = demo && compile.pdfVersion !== null ? t('compile.demoTitle') : noTex ? t('compile.noTexTitle') : null;
  const icon = compile.state === 'running' ? <Spinner size={12} /> : compile.state === 'error' ? <IconWarn size={14} /> : compile.state === 'ok' ? <IconCheck size={14} /> : <IconPlay size={12} />;
  return (
    <div className={`compile-split compile-${compile.state}`}>
      <button
        type="button"
        className={`compile-pill compile-${compile.state}`}
        onClick={() => (connected ? void compileNow(api) : notify('warn', t('net.unreachable')))}
        aria-label={t('compile.button')}
        aria-describedby={statusId}
        aria-keyshortcuts="Control+S Meta+S"
        // the server is gone (terminal closed, laptop slept): the pill looks off, and a click says why and how
        // to restart it instead of a raw "Failed to fetch"
        data-offline={connected ? undefined : 'true'}
        title={connected ? `${label} — ${t('compile.clickToCompile')}${why ? `\n${why}` : ''}` : t('compile.offline')}
      >
        {icon}
        <span className="compile-pill-label" id={statusId}>
          {label}
        </span>
      </button>
      <PopoverButton
        className={`compile-caret${compile.errors.length ? ' has-errors' : ''}`}
        title={compile.errors.length ? `${t('compile.errors')} (${compile.errors.length})` : t('compile.details')}
        popClass="compile-popover"
        label={compile.errors.length ? <span className="compile-err-count">{compile.errors.length > 99 ? '99+' : compile.errors.length}</span> : <IconChevronDown size={13} />}
      >
        {(close) => (
          <>
            {demo && compile.pdfVersion !== null ? <p className="compile-demo-note small" data-testid="compile-demo-note">{withCode(t('compile.demoTitle'))}</p> : null}
            {noTex ? <TexInstallHint className="compile-pop-tex" /> : null}
            {!noTex ? <h3 className="popover-title">{t('compile.errors')}</h3> : null}
            {compile.errors.length && !noTex ? (
              <ul className="compile-errors">
                {compile.errors.map((e, i) => (
                  <li key={i}>
                    {e.line !== null ? (
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => {
                          revealLine(e.line!, e.file);
                          close();
                        }}
                      >
                        {e.file}:{e.line}
                      </button>
                    ) : (
                      <span className="mono">{e.file}</span>
                    )}{' '}
                    <span>{e.message}</span>
                  </li>
                ))}
              </ul>
            ) : noTex ? null : (
              <p className="muted">{t('compile.noErrors')}</p>
            )}
            {compile.logTail ? (
              <>
                <h4 className="popover-subtitle">{t('compile.log')}</h4>
                <pre className="log-tail">{compile.logTail.slice(-2000)}</pre>
              </>
            ) : null}
            <div className="popover-actions">
              <button
                type="button"
                className="btn btn-sm btn-default"
                aria-pressed={pdfShown}
                onClick={() => {
                  // an explicit "show" pins the pane (it is then never hidden to make room for the editor)
                  useShell.getState().pinPdf(!pdfShown, !pdfShown);
                  setRightPane(pdfShown ? 'none' : 'pdf');
                  close();
                }}
              >
                <IconPdf size={14} />
                <span className="btn-label">{pdfShown ? t('pdf.hide') : t('pdf.show')}</span>
              </button>
              <button
                type="button"
                className="btn btn-sm btn-default"
                aria-keyshortcuts="Control+Shift+J Meta+Shift+J"
                onClick={() => {
                  close();
                  void forwardSync(api);
                }}
              >
                <IconLocate size={14} />
                <span className="btn-label">{t('pdf.forward')}</span>
              </button>
            </div>
          </>
        )}
      </PopoverButton>
    </div>
  );
}

function SyncMenu({ api }: { api: ApiClient }) {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  const reports = useShell((s) => s.pullReports);
  const connected = useWorkspace((s) => s.connected);
  const [pulling, setPulling] = useState(false);
  const syncOff = project?.config.sync.mode === 'none';
  const sum = reports?.reduce(
    (a, r) => ({ unchanged: a.unchanged + r.unchanged, edited: a.edited + r.edited.length, created: a.created + r.created.length, orphaned: a.orphaned + r.orphaned.length }),
    { unchanged: 0, edited: 0, created: 0, orphaned: 0 },
  );
  return (
    <PopoverButton
      className="btn btn-default sync-btn"
      title={t('top.syncMenu')}
      role="menu"
      popClass="sync-menu"
      testId="sync-menu"
      label={
        <>
          {pulling ? <Spinner size={12} /> : <IconSync size={14} />}
          <span className="btn-label">{t('top.sync')}</span>
          <IconChevronDown size={12} />
        </>
      }
    >
      {(close) => (
        <>
          {syncOff ? <p className="menu-note muted small">{t('sync.offShort')}</p> : null}
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={syncOff || pulling || !connected}
            title={t('top.pullTitle')}
            onClick={async () => {
              close();
              setPulling(true);
              try {
                await pullNow(api);
              } finally {
                setPulling(false);
              }
            }}
          >
            <IconPull size={14} />
            <span>{t('top.syncPull')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={!connected}
            title={!connected ? t('compile.offline') : syncOff ? t('sync.offShort') : t('top.pushTitle')}
            onClick={() => {
              close();
              openPush();
            }}
          >
            <IconPush size={14} />
            <span>{t('top.syncPush')}</span>
          </button>
          <div className="menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="menu-item menu-item-note"
            onClick={() => {
              close();
              openStep('check', 'sync');
            }}
          >
            <span className="small">{sum ? t('top.syncReport', { report: t('sync.report', sum) }) : t('top.syncNoReport')}</span>
          </button>
        </>
      )}
    </PopoverButton>
  );
}

/** Green "Ready" / amber "n issues" / neutral "Check": opens ④ (and runs the check the first time). */
function SubmissionPill({ api }: { api: ApiClient }) {
  const t = useT();
  const report = useShell((s) => s.submission);
  const st = submissionStatus(report);
  const label = st.tone === 'unknown' ? t('top.submitUnknown') : st.tone === 'ready' ? t('top.submitReady') : t('top.submitIssues', { n: st.issues });
  return (
    <button
      type="button"
      className={`submit-pill submit-${st.tone}`}
      title={t('top.submitTitle')}
      data-testid="submission-pill"
      onClick={() => {
        openStep('check', 'submission');
        if (!report) void runSubmissionCheck(api);
      }}
    >
      {st.tone === 'ready' ? <IconCheck size={13} /> : st.tone === 'unknown' ? <span className="dot dot-idle" aria-hidden="true" /> : <IconWarn size={13} />}
      <span>{label}</span>
    </button>
  );
}

/**
 * "?": keyboard shortcuts, the guided tour (start, continue, start over) and, in the browser demo, a reset
 * of the example paper. (F1 and "?" outside the text still open the shortcuts directly.)
 */
function HelpMenu({ api }: { api: ApiClient }) {
  const t = useT();
  const tour = useTour((s) => s.state);
  const demo = isMockClient(api);
  const entry = menuEntry(tour);
  return (
    <PopoverButton className="icon-btn help-btn" title={t('top.help')} role="menu" popClass="help-menu" testId="help-menu" label={<IconHelp />}>
      {(close) => (
        <>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            aria-keyshortcuts="F1"
            onClick={() => {
              close();
              useShell.getState().setHelpOpen(true);
            }}
          >
            <span>{t('help.shortcuts')}</span>
            <kbd className="kbd menu-kbd">?</kbd>
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            data-testid="tour-menu-start"
            onClick={() => {
              close();
              startTour();
            }}
          >
            <span>{entry.kind === 'resume' ? t('tour.menuResume', { n: entry.step, total: TOUR_STEPS.length }) : t('tour.menu')}</span>
          </button>
          {entry.kind === 'resume' ? (
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              data-testid="tour-menu-restart"
              onClick={() => {
                close();
                startTour(true);
              }}
            >
              <span>{t('tour.menuRestart')}</span>
            </button>
          ) : null}
          {demo ? (
            <>
              <div className="menu-sep" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                title={t('demo.resetTitle')}
                data-testid="demo-reset"
                onClick={() => {
                  close();
                  resetDemo(t('demo.resetConfirm'));
                }}
              >
                <span>{t('demo.reset')}</span>
              </button>
            </>
          ) : null}
        </>
      )}
    </PopoverButton>
  );
}

/**
 * The demo paper lives only in this tab (the in-browser mock): reloading the page starts it again from the
 * fixture text. Asked first, since the author's changes in the demo go.
 */
function resetDemo(question: string): void {
  let ok = true;
  try {
    ok = window.confirm(question);
  } catch {
    ok = true;
  }
  if (!ok) return;
  markDemoReset();
  window.location.reload();
}

export function TopBar({ api }: { api: ApiClient }) {
  const t = useT();
  const lang = useShell((s) => s.lang);
  const project = useWorkspace((s) => s.project);
  const fakeShell = useShell((s) => s.fakeLlm);
  const fake = fakeShell ?? project?.fakeLlm ?? false;

  return (
    <header className="topbar" lang={htmlLang(lang)}>
      <div className="topbar-left">
        <span className="brand">
          <BrandMark />
          <span className="brand-name">paper-copilot</span>
        </span>
        <FileSwitcher />
      </div>
      <div className="topbar-right" role="toolbar" aria-label={t('top.toolbar')}>
        <CompilePill api={api} />
        <SyncMenu api={api} />
        <SubmissionPill api={api} />
        {fake ? (
          <Badge tone="warn" title={t('top.fakeLlmTitle')} className="fake-badge">
            <IconSparkle size={12} />
            <span>{t('top.fakeLlmShort')}</span>
          </Badge>
        ) : null}
        <span className="topbar-divider" aria-hidden="true" />
        <IconButton label={t('top.settings')} icon={<IconGear />} onClick={() => useShell.getState().setSettingsOpen(true)} data-testid="settings-button" aria-haspopup="dialog" />
        <HelpMenu api={api} />
      </div>
    </header>
  );
}
