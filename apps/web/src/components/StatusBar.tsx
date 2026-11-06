/** Bottom status bar: connection, review progress, lint counts, the active sentence's state and model. */
import { useMemo, useRef } from 'react';
import { reviewProgress } from '@paper-copilot/client-core';
import type { SentenceUnit } from '@paper-copilot/core';
import type { ApiClient } from '../contracts';
import { isMockClient } from '../api/extras';
import { htmlLang, useT } from '../i18n';
import { useShell } from '../state/extra';
import { useWorkspace } from '../state/store';
import { StateTag } from './ui';

/**
 * client-core reviewProgress, guarded so a missing or broken helper never takes the status bar
 * down. The fallback counts AI-written units of this session (not imported) as the total and the
 * ones no longer proposed/unsupported as reviewed.
 */
export function safeReviewProgress(units: SentenceUnit[]): { reviewed: number; total: number } {
  try {
    return reviewProgress(units);
  } catch {
    let total = 0;
    let pending = 0;
    for (const u of units) {
      if (u.state === 'proposed' || u.state === 'unsupported') {
        total++;
        pending++;
      } else if (u.everAi && !u.imported) total++;
    }
    return { reviewed: total - pending, total };
  }
}

export function StatusBar({ api }: { api: ApiClient }) {
  const t = useT();
  const lang = useShell((s) => s.lang);
  const connected = useWorkspace((s) => s.connected);
  const units = useWorkspace((s) => s.units);
  const lint = useWorkspace((s) => s.lint);
  const activeId = useWorkspace((s) => s.activeSentenceId);
  const setLeftTab = useWorkspace((s) => s.setLeftTab);
  const setCollapsed = useShell((s) => s.setLeftCollapsed);
  const everConnected = useRef(false);
  if (connected) everConnected.current = true;
  const mock = isMockClient(api);

  const progress = useMemo(() => safeReviewProgress(units), [units]);
  const lintCounts = useMemo(() => {
    let warn = 0;
    let hint = 0;
    for (const f of lint) {
      if (f.dismissed) continue;
      if (f.severity === 'warn') warn++;
      else hint++;
    }
    return { warn, hint };
  }, [lint]);
  const active = useMemo(() => (activeId ? (units.find((u) => u.id === activeId) ?? null) : null), [activeId, units]);

  const conn = connected ? (mock ? t('status.demo') : t('status.connected')) : everConnected.current ? t('status.offline') : t('status.connecting');
  const connClass = connected ? 'ok' : everConnected.current ? 'bad' : 'pending';

  return (
    <footer className="statusbar" lang={htmlLang(lang)} aria-label={t('status.bar')}>
      <div className="status-left">
        <span className={`status-item status-conn conn-${connClass}`} role="status" aria-live="polite">
          <span className="dot" aria-hidden="true" />
          {conn}
        </span>
        <button
          type="button"
          className="status-item status-btn"
          onClick={() => {
            setLeftTab('review');
            setCollapsed(false);
          }}
        >
          {progress && progress.total > 0 ? (
            <>
              <span className="mini-progress" aria-hidden="true">
                <span style={{ width: `${Math.round((100 * progress.reviewed) / Math.max(1, progress.total))}%` }} />
              </span>
              {t('status.reviewed', { reviewed: progress.reviewed, total: progress.total })}
            </>
          ) : (
            t('status.nothingToReview')
          )}
        </button>
        <span className="status-item" title={t('status.lintTitle')}>
          <span className={`lint-dot lint-warn${lintCounts.warn ? '' : ' is-zero'}`} aria-hidden="true" />
          <span className={`lint-dot lint-hint${lintCounts.hint ? '' : ' is-zero'}`} aria-hidden="true" />
          {t('status.lint', lintCounts)}
        </span>
        <span className="status-item muted">{t('status.units', { n: units.length })}</span>
      </div>
      <div className="status-right">
        <button type="button" className="status-item status-btn status-help" aria-label={t('status.help')} title={t('status.help')} onClick={() => useShell.getState().setHelpOpen(true)}>
          ?
        </button>
        {active ? (
          <span className="status-item status-sentence">
            <StateTag state={active.state} />
            {active.model ? <span className="muted mono">{t('status.model', { model: active.model })}</span> : null}
            <span className="muted">{t('common.line', { n: active.line })}</span>
          </span>
        ) : (
          <span className="status-item muted">{t('status.noSentence')}</span>
        )}
      </div>
    </footer>
  );
}
