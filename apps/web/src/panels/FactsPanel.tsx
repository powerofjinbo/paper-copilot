/** Fact store: searchable table, confirm/exclude, unresolved numerals, rescan, repository reader. */
import { useEffect, useMemo, useState } from 'react';
import { renderFact, type Fact } from '@paper-copilot/core';
import type { ApiClient } from '../contracts';
import { refetchFacts, revealSentence } from '../components/actions';
import { isJobActive, useAction, useJob, useUnitText } from '../components/hooks';
import { IconFacts, IconRefresh, IconSearch, Spinner } from '../components/Icons';
import { Badge, Button, EmptyState, Highlight, PanelHeader, PanelSection, displayLatex } from '../components/ui';
import { useT, type MsgKey } from '../i18n';
import { useShell } from '../state/extra';
import { useWorkspace } from '../state/store';

type Filter = 'all' | 'stale' | 'unconfirmed' | 'excluded' | 'used';

/** "2.32 ± 0.28 points" (core renderFact without the leading "id = "). */
export function factValueText(f: Fact): string {
  try {
    const r = renderFact(f);
    const prefix = `${f.id} = `;
    return r.startsWith(prefix) ? r.slice(prefix.length) : r.replace(/^\S+\s*=\s*/, '');
  } catch {
    const unc = f.uncertainties.total ?? Object.values(f.uncertainties)[0];
    const v = typeof f.value === 'number' ? String(f.value) : f.value;
    return `${v}${unc !== undefined ? ` ± ${unc}` : ''}${f.unit ? ` ${f.unit}` : ''}`;
  }
}

function matches(f: Fact, q: string): boolean {
  if (!q) return true;
  const hay = `${f.id} ${f.definition} ${f.artifact} ${f.locator} ${String(f.value)} ${f.unit} ${f.tags.join(' ')} ${f.aliases.join(' ')}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

export function FactsPanel({ api }: { api: ApiClient }) {
  const t = useT();
  const facts = useWorkspace((s) => s.facts);
  const unresolved = useWorkspace((s) => s.unresolved);
  const units = useWorkspace((s) => s.units);
  const setFacts = useWorkspace((s) => s.setFacts);
  const pushNotice = useWorkspace((s) => s.pushNotice);
  const textOf = useUnitText();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [readJobId, setReadJobId] = useState<string | null>(null);
  const readJob = useJob(readJobId);
  const [pending, setPending] = useState<string | null>(null);

  const usage = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const u of units) for (const id of u.facts) m.set(id, [...(m.get(id) ?? []), u.id]);
    return m;
  }, [units]);
  const unitById = useMemo(() => new Map(units.map((u) => [u.id, u])), [units]);
  const file = useWorkspace((s) => s.file);
  const projectFiles = useShell((s) => s.files);
  // the open file's numerals first (they can be fixed right here), then the other files' in document
  // order (the \input tree of GET /api/files), each file's in line order
  const unresolvedRows = useMemo(() => {
    const here = (u: (typeof unresolved)[number]) => unitById.has(u.sentenceId) || !u.file || u.file === file;
    const rank = new Map(projectFiles.map((f, i) => [f.file, i]));
    const others = unresolved
      .map((u, i) => ({ u, i }))
      .filter((x) => !here(x.u))
      .sort((a, b) => (rank.get(a.u.file!) ?? 1e9) - (rank.get(b.u.file!) ?? 1e9) || (a.u.line ?? 0) - (b.u.line ?? 0) || a.i - b.i)
      .map((x) => x.u);
    return [...unresolved.filter(here), ...others];
  }, [unresolved, unitById, file, projectFiles]);

  const shown = useMemo(
    () =>
      facts.filter((f) => {
        if (!matches(f, query.trim())) return false;
        switch (filter) {
          case 'stale':
            return f.stale;
          case 'unconfirmed':
            return !f.confirmed && !f.excluded;
          case 'excluded':
            return f.excluded;
          case 'used':
            return (usage.get(f.id)?.length ?? 0) > 0;
          default:
            return true;
        }
      }),
    [facts, query, filter, usage],
  );

  // Keep the unresolved list in step with the text while the panel is open (debounced).
  useEffect(() => {
    const timer = setTimeout(() => void refetchFacts(api).catch(() => undefined), 500);
    return () => clearTimeout(timer);
  }, [api, units]);

  const rescan = useAction(async () => {
    const r = await api.rescanFacts();
    const fr = await api.facts();
    setFacts(fr.facts, fr.unresolved);
    pushNotice('info', t('facts.rescanned', { n: r.count, stale: r.stale.length }));
  });
  const readRepo = useAction(async () => {
    const { jobId } = await api.readRepo();
    setReadJobId(jobId);
  });

  const patch = async (f: Fact, p: Partial<Pick<Fact, 'confirmed' | 'excluded'>>) => {
    const before = useWorkspace.getState().facts;
    setPending(f.id);
    setFacts(
      before.map((x) => (x.id === f.id ? { ...x, ...p } : x)),
      useWorkspace.getState().unresolved,
    );
    try {
      const next = await api.patchFact(f.id, p);
      const cur = useWorkspace.getState();
      setFacts(
        cur.facts.map((x) => (x.id === f.id ? { ...x, ...next } : x)),
        cur.unresolved,
      );
    } catch (e) {
      setFacts(before, useWorkspace.getState().unresolved);
      pushNotice('error', t('facts.patchFailed', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setPending(null);
    }
  };

  const reading = isJobActive(readJob);

  return (
    <div className="panel">
      <PanelHeader
        title={t('facts.title')}
        subtitle={t('facts.intro')}
        actions={
          <>
            <Button size="sm" icon={<IconRefresh size={13} />} busy={rescan.busy} onClick={() => void rescan.run()}>
              {t('facts.rescan')}
            </Button>
            <Button size="sm" icon={<IconFacts size={13} />} busy={reading || readRepo.busy} onClick={() => void readRepo.run()}>
              {t('facts.readRepo')}
            </Button>
          </>
        }
      />
      <div className="panel-body">
        {readJob && (reading || readJob.state === 'error') ? (
          <div className={`job-line${readJob.state === 'error' ? ' is-error' : ''}`} role="status">
            {reading ? <Spinner size={12} /> : null}
            <span>
              {t('job.read-repo')} · {readJob.message === 'running' ? t('common.running') : readJob.message === 'queued' ? t('common.queued') : readJob.message}
            </span>
          </div>
        ) : null}

        {unresolved.length > 0 ? (
          <PanelSection className="psec-warn" title={t('facts.unresolved')} count={unresolved.length}>
            <p className="muted small">{t('facts.unresolvedHint')}</p>
            <ul className="plain-list">
              {unresolvedRows.map((u, i) => {
                // a sentence of the open file: live text and line; of another file: where the server says
                const unit = unitById.get(u.sentenceId);
                const elsewhere = !unit && !!u.file && u.file !== file;
                const line = unit ? unit.line : u.line;
                const text = unit ? textOf(unit) : (u.text ?? null);
                return (
                  <li key={`${u.sentenceId}:${u.raw}:${i}`}>
                    <button type="button" className="list-row" onClick={() => revealSentence(u.sentenceId, false, elsewhere ? u.file : null)} disabled={!unit && !elsewhere}>
                      <span className="list-row-top">
                        <code className="num-chip">{u.raw}</code>
                        {elsewhere ? <span className="muted small mono row-file">{u.file}</span> : null}
                        {line !== undefined ? <span className="muted tabular">{t('common.line', { n: line })}</span> : null}
                      </span>
                      {text ? (
                        <span className="list-row-text">
                          <Highlight text={displayLatex(text)} needle={displayLatex(u.raw)} />
                        </span>
                      ) : null}
                      <span className="list-row-meta muted small">{u.candidates.length ? t('facts.candidates', { ids: u.candidates.join(', ') }) : t('facts.noMatch')}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </PanelSection>
        ) : null}

        <div className="toolbar-row">
          <label className="search">
            <IconSearch size={14} />
            <span className="sr-only">{t('facts.search')}</span>
            <input type="search" value={query} placeholder={t('facts.search')} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <label className="select-inline">
            <span className="sr-only">{t('facts.filter')}</span>
            <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label={t('facts.filter')}>
              {(['all', 'unconfirmed', 'used', 'stale', 'excluded'] as const).map((f) => (
                <option key={f} value={f}>
                  {t(`facts.filter.${f}` as MsgKey)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="muted small count-line">{t('facts.count', { shown: shown.length, n: facts.length })}</div>

        {facts.length === 0 ? (
          <EmptyState>{t('facts.empty')}</EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState>{t('facts.noResults')}</EmptyState>
        ) : (
          <table className="facts-table">
            <thead>
              <tr>
                <th scope="col">{t('facts.col.fact')}</th>
                <th scope="col">{t('facts.col.state')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((f) => {
                const used = usage.get(f.id) ?? [];
                return (
                  <tr key={f.id} className={f.excluded ? 'is-excluded' : undefined}>
                    <td className="fact-cell">
                      <code className="fact-id" title={f.id}>
                        {f.id}
                      </code>
                      <div className="fact-value">{factValueText(f)}</div>
                      <div className="fact-def" title={`${f.definition}\n(${f.definitionSource})`}>
                        {f.definition}
                      </div>
                      <div className="fact-artifact mono" title={`sha256 ${f.artifactSha256}`}>
                        {f.artifact}
                        <span className="muted">{f.locator}</span>
                      </div>
                    </td>
                    <td className="fact-state">
                      <div className="stack">
                      <Badge tone="neutral">{t(`kind.${f.kind}` as MsgKey)}</Badge>
                      <Badge tone={f.validationState === 'candidate' ? 'neutral' : 'ok'} title={t(`validationTitle.${f.validationState}` as MsgKey)}>
                        {t(`validation.${f.validationState}` as MsgKey)}
                      </Badge>
                      {f.stale ? (
                        <Badge tone="warn" title={t('facts.staleTitle')}>
                          {t('facts.stale')}
                        </Badge>
                      ) : null}
                      {f.proseOnly ? <Badge tone="warn">{t('facts.prose')}</Badge> : null}
                      {used.length ? (
                        <button type="button" className="link-btn small" onClick={() => revealSentence(used[0]!)}>
                          {t('facts.usedIn', { n: used.length })}
                        </button>
                      ) : (
                        <span className="muted small">{t('facts.unused')}</span>
                      )}
                      <span className="stack-gap" aria-hidden="true" />
                      <label className="check" title={t('facts.confirmedTitle')}>
                        <input type="checkbox" checked={f.confirmed} disabled={pending === f.id} onChange={(e) => void patch(f, { confirmed: e.target.checked })} />
                        <span>{t('facts.confirmed')}</span>
                      </label>
                      <label className="check" title={t('facts.excludedTitle')}>
                        <input type="checkbox" checked={f.excluded} disabled={pending === f.id} onChange={(e) => void patch(f, { excluded: e.target.checked })} />
                        <span>{t('facts.excluded')}</span>
                      </label>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
