/** Review queue (draft-then-review mode): proposed and unsupported sentences in document order. */
import { useMemo, useState } from 'react';
import { nextInQueue, reviewQueue } from '@paper-copilot/client-core';
import type { SentenceUnit } from '@paper-copilot/core';
import type { ApiClient } from '../contracts';
import { acceptSentence, notify, rejectSentence, revealSentence } from '../components/actions';
import { useUnitText } from '../components/hooks';
import { IconArrowDown, IconArrowUp, IconCheck, IconClose } from '../components/Icons';
import { safeReviewProgress } from '../components/StatusBar';
import { Button, EmptyState, IconButton, PanelHeader, StateTag, displayLatex } from '../components/ui';
import { useT } from '../i18n';
import { useWorkspace } from '../state/store';

function safeQueue(units: SentenceUnit[]): SentenceUnit[] {
  try {
    return reviewQueue(units);
  } catch {
    return units.filter((u) => u.state === 'proposed' || u.state === 'unsupported').sort((a, b) => a.start - b.start);
  }
}

export function useSectionTitles(): (id: string) => string {
  const outline = useWorkspace((s) => s.outline);
  return useMemo(() => {
    const m = new Map((outline?.sections ?? []).map((s) => [s.id, s.title]));
    return (id: string) => m.get(id) ?? id;
  }, [outline]);
}

export function ReviewPanel({ api }: { api: ApiClient }) {
  const t = useT();
  const units = useWorkspace((s) => s.units);
  const activeId = useWorkspace((s) => s.activeSentenceId);
  const textOf = useUnitText();
  const titleOf = useSectionTitles();
  const queue = useMemo(() => safeQueue(units), [units]);
  const progress = useMemo(() => safeReviewProgress(units), [units]);
  const [busy, setBusy] = useState<string | null>(null);

  const jump = (dir: 1 | -1) => {
    const active = units.find((u) => u.id === activeId);
    const pos = active ? (dir === 1 ? active.end + 1 : Math.max(0, active.start - 1)) : 0;
    let next: SentenceUnit | null = null;
    try {
      next = nextInQueue(units, pos, dir);
    } catch {
      next = (dir === 1 ? queue.find((u) => u.start >= pos) : [...queue].reverse().find((u) => u.end <= pos)) ?? queue[0] ?? null;
    }
    if (next) revealSentence(next.id, true);
  };

  const act = async (id: string, kind: 'accept' | 'reject') => {
    setBusy(`${kind}:${id}`);
    try {
      const ok = kind === 'accept' ? await acceptSentence(api, id) : await rejectSentence(api, id);
      if (ok) notify('info', t(kind === 'accept' ? 'review.accepted' : 'review.rejected'));
    } finally {
      setBusy(null);
    }
  };

  const pct = progress && progress.total ? Math.round((100 * progress.reviewed) / progress.total) : 0;
  let lastSection: string | null = null;

  return (
    <div className="panel">
      <PanelHeader
        title={t('review.title')}
        subtitle={t('review.intro')}
        actions={
          <>
            <IconButton label={t('review.prev')} icon={<IconArrowUp />} onClick={() => jump(-1)} disabled={!queue.length} aria-keyshortcuts="Alt+ArrowUp" />
            <IconButton label={t('review.next')} icon={<IconArrowDown />} onClick={() => jump(1)} disabled={!queue.length} aria-keyshortcuts="Alt+ArrowDown" />
          </>
        }
      />
      <div className="panel-body">
        {progress && progress.total > 0 ? (
          <div className="review-progress">
            <div className="review-progress-row">
              <span>{t('status.reviewed', { reviewed: progress.reviewed, total: progress.total })}</span>
              <span className="muted tabular">{pct}%</span>
            </div>
            <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.reviewed} aria-label={t('status.reviewed', { reviewed: progress.reviewed, total: progress.total })}>
              <span style={{ width: `${pct}%` }} />
            </div>
          </div>
        ) : null}
        <p className="kbd-hint">{t('review.keys')}</p>
        {queue.length === 0 ? (
          <EmptyState>{t('review.empty')}</EmptyState>
        ) : (
          <ol className="review-list">
            {queue.map((u) => {
              const header = u.sectionId !== lastSection ? titleOf(u.sectionId) : null;
              lastSection = u.sectionId;
              const isActive = u.id === activeId;
              return (
                <li key={u.id} className={`review-li${isActive ? ' is-active' : ''}`}>
                  {header ? <div className="list-group-label">{header}</div> : null}
                  <div className={`review-item state-${u.state}`}>
                    <button type="button" className="review-main" onClick={() => revealSentence(u.id, true)} aria-current={isActive ? 'true' : undefined}>
                      <span className="review-meta">
                        <StateTag state={u.state} />
                        <span className="muted tabular">{t('common.line', { n: u.line })}</span>
                        {u.state === 'unsupported' ? <span className="danger-text">{t('review.unsupportedHint')}</span> : null}
                      </span>
                      <span className="review-text">{displayLatex(textOf(u))}</span>
                    </button>
                    <div className="review-actions">
                      <Button size="sm" variant="primary" icon={<IconCheck size={13} />} busy={busy === `accept:${u.id}`} disabled={!!busy} onClick={() => void act(u.id, 'accept')} title={t('review.acceptTitle')} aria-label={t('review.acceptLabel', { n: u.line })}>
                        {t('review.accept')}
                      </Button>
                      <Button size="sm" icon={<IconClose size={13} />} busy={busy === `reject:${u.id}`} disabled={!!busy} onClick={() => void act(u.id, 'reject')} title={t('review.rejectTitle')} aria-label={t('review.rejectLabel', { n: u.line })}>
                        {t('review.reject')}
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
