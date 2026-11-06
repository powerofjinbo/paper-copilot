/** Toasts for server notices and job progress (bottom right, above the status bar; never shifts layout). */
import { useEffect, useRef, useState } from 'react';
import { htmlLang, jobKey, useT } from '../i18n';
import { useShell } from '../state/extra';
import { useWorkspace } from '../state/store';
import { IconCheck, IconClose, IconInfo, IconWarn, Spinner } from './Icons';

const NOTICE_MS = { info: 6000, warn: 10000, error: 0 } as const;
const JOB_LINGER_MS = 3500;

function useNow(active: boolean, every = 500): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(id);
  }, [active, every]);
  return now;
}

export function Toasts() {
  const t = useT();
  const lang = useShell((s) => s.lang);
  const notices = useWorkspace((s) => s.notices);
  const dismiss = useWorkspace((s) => s.dismissNotice);
  const jobs = useWorkspace((s) => s.jobs);
  const finishedAt = useShell((s) => s.jobFinishedAt);
  const markFinished = useShell((s) => s.markJobFinished);
  const shownAt = useRef(new Map<number, number>());

  // Remember when each job finished, so its "done" toast lingers briefly.
  useEffect(() => {
    for (const [id, j] of Object.entries(jobs)) {
      if ((j.state === 'done' || j.state === 'error') && finishedAt[id] === undefined) markFinished(id, Date.now());
    }
  }, [jobs, finishedAt, markFinished]);

  const now = useNow(notices.length > 0 || Object.keys(jobs).length > 0);

  // Auto-dismiss info and warn notices.
  useEffect(() => {
    for (const n of notices) {
      if (!shownAt.current.has(n.id)) shownAt.current.set(n.id, Date.now());
      const ttl = NOTICE_MS[n.level];
      const t0 = shownAt.current.get(n.id) ?? now;
      if (ttl > 0 && now - t0 > ttl) dismiss(n.id);
    }
  }, [notices, now, dismiss]);

  const jobToasts = Object.entries(jobs).filter(([id, j]) => {
    if (j.state === 'queued' || j.state === 'running') return true;
    if (j.state === 'done') return now - (finishedAt[id] ?? now) < JOB_LINGER_MS;
    return false; // errors become notices
  });

  const generic = (m: string) => (m === 'queued' ? t('common.queued') : m === 'running' ? t('common.running') : m === 'done' ? t('common.done') : m);

  return (
    <div className="toasts" lang={htmlLang(lang)}>
      <div className="toast-stack" aria-live="polite" aria-relevant="additions text">
        {jobToasts.map(([id, j]) => (
          <div key={id} className={`toast toast-job${j.state === 'done' ? ' is-done' : ''}`}>
            <span className="toast-icon">{j.state === 'done' ? <IconCheck size={14} /> : <Spinner size={13} />}</span>
            <span className="toast-body">
              <strong>{t(jobKey(j.kind))}</strong>
              <span className="toast-msg">{j.state === 'done' ? t('common.done') : generic(j.message)}</span>
            </span>
          </div>
        ))}
        {notices.map((n) => (
          <div key={n.id} className={`toast toast-${n.level}`} role={n.level === 'error' ? 'alert' : 'status'}>
            <span className="toast-icon">{n.level === 'info' ? <IconInfo size={14} /> : <IconWarn size={14} />}</span>
            <span className="toast-body">
              <span className="toast-msg">{n.message}</span>
            </span>
            <button type="button" className="icon-btn icon-btn-sm toast-close" aria-label={t('common.dismiss')} title={t('common.dismiss')} onClick={() => dismiss(n.id)}>
              <IconClose size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
