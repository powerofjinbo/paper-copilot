/**
 * Literature (② Sources): every .bib key with its INSPIRE-HEP status. AI text may cite only keys that
 * were found on INSPIRE or that the author confirmed; the rest become [ref] placeholders.
 */
import { useEffect, useMemo, useState } from 'react';
import type { LitRecord } from '@paper-copilot/core';
import type { ApiClient } from '../contracts';
import { isJobActive, useAction, useJob, useLoad } from '../components/hooks';
import { IconRefresh, IconSearch, Spinner } from '../components/Icons';
import { Badge, Button, EmptyState, InlineError, PanelHeader, PanelSection } from '../components/ui';
import { useT, type MsgKey } from '../i18n';
import { useWorkspace } from '../state/store';

function matches(r: LitRecord, q: string): boolean {
  if (!q) return true;
  const hay = `${r.key} ${r.title} ${r.authors} ${r.year ?? ''} ${r.arxiv ?? ''} ${r.doi ?? ''}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/** Records split into "needs you" (unresolved) and usable, each sorted by key. */
export function splitLit(records: readonly LitRecord[]): { unresolved: LitRecord[]; usable: LitRecord[] } {
  const byKey = (a: LitRecord, b: LitRecord) => a.key.localeCompare(b.key);
  return {
    unresolved: records.filter((r) => r.status === 'unresolved').sort(byKey),
    usable: records.filter((r) => r.status !== 'unresolved').sort(byKey),
  };
}

export function LiteraturePanel({ api }: { api: ApiClient }) {
  const t = useT();
  const units = useWorkspace((s) => s.units);
  const pushNotice = useWorkspace((s) => s.pushNotice);
  const lit = useLoad(() => api.panels().then((p) => p.lit), [api]);
  const [query, setQuery] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId);
  const [pending, setPending] = useState<string | null>(null);
  const resolving = isJobActive(job);

  const resolve = useAction(async () => {
    const { jobId: id } = await api.resolveLit();
    setJobId(id);
  });
  const { reload } = lit;
  useEffect(() => {
    if (job?.state === 'done') reload();
  }, [job?.state, reload]);

  const cited = useMemo(() => new Set(units.flatMap((u) => u.cites)), [units]);
  const records = lit.data ?? [];
  const shown = records.filter((r) => matches(r, query.trim()));
  const { unresolved, usable } = splitLit(shown);
  const okCount = records.filter((r) => r.status !== 'unresolved').length;

  const confirm = async (r: LitRecord, on: boolean) => {
    setPending(r.key);
    try {
      const next = await api.confirmLit(r.key, on);
      lit.setData((lit.data ?? []).map((x) => (x.key === r.key ? next : x)));
    } catch (e) {
      pushNotice('error', e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };

  const row = (r: LitRecord) => (
    <li key={r.key} className={`lit-row lit-${r.status}`}>
      <div className="lit-top">
        <code className="lit-key" title={r.texkey ?? r.key}>
          {r.key}
        </code>
        <Badge tone={r.status === 'unresolved' ? 'warn' : 'ok'}>{t(`lit.status.${r.status}` as MsgKey)}</Badge>
        {cited.has(r.key) ? <span className="muted small">\cite</span> : null}
      </div>
      {r.title ? <div className="lit-title">{r.title}</div> : null}
      <div className="lit-meta muted small">
        {[r.authors, r.year, r.arxiv ? `arXiv:${r.arxiv}` : null, r.doi].filter(Boolean).join(' · ')}
      </div>
      <div className="lit-actions">
        {r.status === 'unresolved' ? (
          <Button size="sm" busy={pending === r.key} onClick={() => void confirm(r, true)} title={t('lit.confirmTitle')}>
            {t('lit.confirm')}
          </Button>
        ) : r.status === 'user_confirmed' ? (
          <Button size="sm" variant="quiet" busy={pending === r.key} onClick={() => void confirm(r, false)}>
            {t('lit.unconfirm')}
          </Button>
        ) : null}
      </div>
    </li>
  );

  return (
    <div className="panel">
      <PanelHeader
        title={t('lit.title')}
        subtitle={t('lit.intro')}
        actions={
          <Button size="sm" icon={<IconRefresh size={13} />} busy={resolving || resolve.busy} onClick={() => void resolve.run()}>
            {resolving ? t('lit.resolving') : t('lit.resolve')}
          </Button>
        }
      />
      <div className="panel-body">
        {job && (resolving || job.state === 'error') ? (
          <div className={`job-line${job.state === 'error' ? ' is-error' : ''}`} role="status">
            {resolving ? <Spinner size={12} /> : null}
            <span>{job.message === 'running' ? t('common.running') : job.message === 'queued' ? t('common.queued') : job.message}</span>
          </div>
        ) : null}
        <InlineError message={lit.error} />
        {records.length === 0 ? (
          lit.loading ? (
            <p className="muted small">{t('common.loading')}</p>
          ) : (
            <EmptyState>{t('lit.empty')}</EmptyState>
          )
        ) : (
          <>
            <div className="toolbar-row">
              <label className="search">
                <IconSearch size={14} />
                <span className="sr-only">{t('lit.filter')}</span>
                <input type="search" value={query} placeholder={t('lit.filter')} onChange={(e) => setQuery(e.target.value)} />
              </label>
            </div>
            <div className="muted small count-line">{t('lit.count', { ok: okCount, n: records.length })}</div>
            {unresolved.length ? (
              <PanelSection className="psec-warn" title={t('lit.unresolvedFirst', { n: unresolved.length })}>
                <ul className="plain-list lit-list">{unresolved.map(row)}</ul>
              </PanelSection>
            ) : null}
            {usable.length ? (
              <PanelSection title={t('lit.usable', { n: usable.length })} defaultOpen={unresolved.length === 0 || usable.length <= 12}>
                <ul className="plain-list lit-list">{usable.map(row)}</ul>
              </PanelSection>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
