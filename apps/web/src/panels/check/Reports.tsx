/**
 * The collapsible report sections of ④ Check & submit: Consistency (the echo check: numbers grouped by
 * quantity with drift / factor-percent / condition flags, stale facts, key-phrase presence, the headline
 * number), Terminology (acronyms, spelling variants) and the Figure plan (floats with the caption anatomy
 * checklist, claims -> figures). Each loads when first opened; every row reveals its sentence, switching
 * files first. Flag labels come from the core i18n tables (`consistency.<kind>`, `caption.<key>`).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ConsistencyFlag, EchoReport, FigurePlanReport, NumberOccurrence, Part, TerminologyReport } from '@paper-copilot/core';
import type { ApiClient } from '../../contracts';
import { IconRefresh, Spinner } from '../../components/Icons';
import type { StepSection } from '../../components/steps';
import { Badge, Button, EmptyState, InlineError, PanelSection, displayLatex } from '../../components/ui';
import { errorText } from '../../api/errors';
import { useCodeT, useT, type MsgKey } from '../../i18n';
import { useWorkspace } from '../../state/store';
import { goId, goRef, refIndex } from './refs';

/* ------------------------------------------------------------------------------------ */
/* Lazy section                                                                          */
/* ------------------------------------------------------------------------------------ */

function useReport<T>(load: () => Promise<T>, enabled: boolean) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setLoading(true);
    load()
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => alive && setError(errorText(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, tick]);
  const reload = useCallback(() => setTick((x) => x + 1), []);
  return { data, error, loading, reload };
}

function ReportSection<T>({
  title,
  focusId,
  load,
  count,
  children,
}: {
  title: string;
  focusId: StepSection;
  load: () => Promise<T>;
  count?: (d: T) => number | undefined;
  children: (d: T) => ReactNode;
}) {
  const t = useT();
  const [opened, setOpened] = useState(false);
  const r = useReport(load, opened);
  const n = r.data && count ? count(r.data) : undefined;
  return (
    <PanelSection
      title={title}
      focusId={focusId}
      defaultOpen={false}
      onOpenChange={(o) => o && setOpened(true)}
      count={n ? n : undefined}
      className={`report report-${focusId}`}
      actions={
        opened ? (
          <Button size="sm" variant="quiet" icon={r.loading ? <Spinner size={12} /> : <IconRefresh size={13} />} onClick={r.reload} aria-label={`${t('common.refresh')}: ${title}`} title={t('common.refresh')} />
        ) : null
      }
    >
      <InlineError message={r.error} />
      {r.data ? children(r.data) : r.loading ? <p className="muted small">{t('check.loading')}</p> : null}
    </PanelSection>
  );
}

/* ------------------------------------------------------------------------------------ */
/* Shared bits                                                                           */
/* ------------------------------------------------------------------------------------ */

function FlagList({ flags, index }: { flags: readonly ConsistencyFlag[]; index: Map<string, { file: string; line: number | null }> }) {
  const t = useT();
  const ct = useCodeT();
  if (!flags.length) return <p className="small ok-text">{t('check.noFindings')}</p>;
  return (
    <ul className="plain-list flag-list">
      {flags.map((f) => {
        const code = `consistency.${f.kind}`;
        const first = f.sentenceIds[0];
        return (
          <li key={f.id} className={`flag flag-${f.severity}`}>
            <button type="button" className="list-row" disabled={!first} onClick={() => first && goId(index, first)}>
              <span className="list-row-top">
                <span className={`flag-dot flag-dot-${f.severity}`} aria-hidden="true" />
                <strong className="flag-label" title={ct(code, 'explain')}>
                  {ct(code)}
                </strong>
                {f.heuristic && !/heuristic|启发式/i.test(ct(code)) ? (
                  <Badge tone="neutral" title={t('check.heuristicTitle')}>
                    {t('check.heuristic')}
                  </Badge>
                ) : null}
                {f.sentenceIds.length > 1 ? <span className="muted small tabular">×{f.sentenceIds.length}</span> : null}
              </span>
              <span className="list-row-text small" lang="en">
                {f.message}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function PartChip({ part }: { part: Part }) {
  const t = useT();
  return <span className={`part-chip part-${part}`}>{t(`part.${part}` as MsgKey)}</span>;
}

/* ------------------------------------------------------------------------------------ */
/* Consistency (echo check)                                                              */
/* ------------------------------------------------------------------------------------ */

function occLabel(o: NumberOccurrence): string {
  return o.rendering || o.raw;
}

function Consistency({ r }: { r: EchoReport }) {
  const t = useT();
  const facts = useWorkspace((s) => s.facts);
  const index = useMemo(() => refIndex(r), [r]);
  const flagged = useMemo(() => new Set(r.flags.flatMap((f) => f.factIds)), [r]);
  const [openQ, setOpenQ] = useState<string | null>(null);
  // quantities with a finding or more than one form first
  const quantities = useMemo(
    () => [...r.quantities].sort((a, b) => Number(flagged.has(b.primaryFactId) || b.renderings.length > 1) - Number(flagged.has(a.primaryFactId) || a.renderings.length > 1)),
    [r, flagged],
  );
  const def = (id: string) => facts.find((f) => f.id === id)?.definition ?? id;
  return (
    <div className="report-body">
      <div className="sub-label">{t('cons.flags')}</div>
      <FlagList flags={r.flags} index={index} />

      {r.keyPhrase.phrase ? (
        <>
          <div className="sub-label">
            {t('cons.keyPhrase')}: <q lang="en">{r.keyPhrase.phrase}</q>
          </div>
          <ul className="kp-list">
            {r.keyPhrase.locations.map((l) => (
              <li key={l.where} className={`kp kp-${l.status}`}>
                <button type="button" className="kp-btn" disabled={!l.sentenceIds.length} onClick={() => l.sentenceIds[0] && goId(index, l.sentenceIds[0])} title={l.matched ?? undefined}>
                  <span className="kp-where">{t(`cons.where.${l.where}` as MsgKey)}</span>
                  <span className="kp-status">{t(`cons.status.${l.status}` as MsgKey)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted small">{t('cons.keyPhraseNone')}</p>
      )}

      {r.headline.factId ? (
        <>
          <div className="sub-label">
            {t('cons.headline')}: <span lang="en">{def(r.headline.factId)}</span>
          </div>
          <ul className="kp-list">
            {r.headline.places.map((p) => (
              <li key={p.where} className={`kp kp-${p.present ? 'present' : 'missing'}`}>
                <button type="button" className="kp-btn" disabled={!p.sentenceIds.length} onClick={() => p.sentenceIds[0] && goId(index, p.sentenceIds[0])}>
                  <span className="kp-where">{t(`cons.where.${p.where}` as MsgKey)}</span>
                  <span className="kp-status">{t(p.present ? 'cons.status.present' : 'cons.status.missing')}</span>
                  {p.baselinePresent === false ? <span className="kp-miss">− {t('cons.baseline')}</span> : null}
                  {p.conditionPresent === false ? <span className="kp-miss">− {t('cons.condition')}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {r.stale.length ? (
        <>
          <div className="sub-label">{t('cons.stale')}</div>
          <p className="muted small">{t('cons.staleHint')}</p>
          <ul className="plain-list">
            {r.stale.map((s) => (
              <li key={s.factId}>
                <div className="small" lang="en">
                  <code className="fact-id">{s.factId}</code> {s.definition}
                </div>
                {s.sentences.map((ref, i) => (
                  <button key={`${ref.sentenceId ?? i}`} type="button" className="list-row" onClick={() => goRef(ref)}>
                    <span className="list-row-text small" lang="en">
                      {displayLatex(ref.text)}
                    </span>
                  </button>
                ))}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <div className="sub-label">{t('cons.quantities')}</div>
      <p className="muted small">{t('cons.quantitiesHint')}</p>
      <ul className="plain-list q-list">
        {quantities.map((q) => {
          const isOpen = openQ === q.key;
          const warn = flagged.has(q.primaryFactId) || q.renderings.length > 1;
          return (
            <li key={q.key} className={`q-row${warn ? ' is-warn' : ''}`}>
              <button type="button" className="q-head" aria-expanded={isOpen} onClick={() => setOpenQ(isOpen ? null : q.key)}>
                <span className="q-def" lang="en">
                  {q.definition || q.primaryFactId}
                </span>
                <span className="q-meta">
                  {q.renderings.slice(0, 4).map((x) => (
                    <code key={x} className="num-chip">
                      {x}
                    </code>
                  ))}
                  {q.renderings.length > 1 ? <Badge tone="warn">{t('cons.forms', { n: q.renderings.length })}</Badge> : null}
                  {q.stale ? <Badge tone="warn">{t('facts.stale')}</Badge> : null}
                  <span className="q-sep" aria-hidden="true" />
                  {q.parts.map((p) => (
                    <PartChip key={p} part={p} />
                  ))}
                </span>
              </button>
              {isOpen ? (
                <ul className="plain-list q-occ">
                  {q.occurrences.map((o, i) => (
                    <li key={`${o.sentenceId ?? 'x'}:${i}`}>
                      <button type="button" className="list-row" onClick={() => goRef(o)}>
                        <span className="list-row-top">
                          <code className="num-chip">{occLabel(o)}</code>
                          {o.part ? <PartChip part={o.part} /> : null}
                          <span className="mono small muted">{o.file}</span>
                          {o.line !== null ? <span className="muted tabular small">{t('common.line', { n: o.line })}</span> : null}
                          {o.ambiguous ? <Badge tone="warn">?</Badge> : null}
                        </span>
                        <span className="list-row-text small" lang="en">
                          {displayLatex(o.text)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>

      {r.unmatched.length ? (
        <>
          <div className="sub-label">
            {t('cons.unmatched')} ({r.unmatched.length})
          </div>
          <ul className="plain-list">
            {r.unmatched.slice(0, 40).map((o, i) => (
              <li key={`${o.sentenceId ?? 'x'}:${o.raw}:${i}`}>
                <button type="button" className="list-row" onClick={() => goRef(o)}>
                  <span className="list-row-top">
                    <code className="num-chip">{o.raw}</code>
                    {o.part ? <PartChip part={o.part} /> : null}
                    <span className="mono small muted">{o.file}</span>
                  </span>
                  <span className="list-row-text small" lang="en">
                    {displayLatex(o.text)}
                  </span>
                </button>
              </li>
            ))}
            {r.unmatched.length > 40 ? <li className="muted small">{t('check.more', { n: r.unmatched.length - 40 })}</li> : null}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------------------ */
/* Terminology                                                                           */
/* ------------------------------------------------------------------------------------ */

function Terminology({ r }: { r: TerminologyReport }) {
  const t = useT();
  const index = useMemo(() => refIndex(r), [r]);
  const rows = useMemo(() => [...r.acronyms].sort((a, b) => Number(b.status !== 'ok' && b.status !== 'known') - Number(a.status !== 'ok' && a.status !== 'known')), [r]);
  const bad = rows.filter((a) => a.status !== 'ok' && a.status !== 'known');
  return (
    <div className="report-body">
      <div className="sub-label">{t('cons.flags')}</div>
      <FlagList flags={r.flags} index={index} />
      <div className="sub-label">
        {t('term.acronyms')} ({r.acronyms.length})
      </div>
      {bad.length === 0 && r.acronyms.length ? <p className="small ok-text">{t('term.allOk')}</p> : null}
      <ul className="plain-list acro-list">
        {rows.map((a) => {
          const target = a.status === 'used_before_definition' || a.status === 'undefined' ? a.firstUse : (a.definition ?? a.firstUse);
          const ok = a.status === 'ok' || a.status === 'known';
          return (
            <li key={a.acronym} className={`acro${ok ? '' : ' is-warn'}`}>
              <button type="button" className="list-row" disabled={!target} onClick={() => target && goRef(target)}>
                <span className="list-row-top">
                  <code className="acro-key">{a.acronym}</code>
                  <span className="small" lang="en">
                    {a.longForm ?? ''}
                  </span>
                </span>
                <span className="list-row-meta small">
                  <Badge tone={ok ? 'ok' : 'warn'}>{t(`term.status.${a.status}` as MsgKey)}</Badge> <span className="muted">{t('term.uses', { n: a.uses })}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {r.variants.length ? (
        <>
          <div className="sub-label">
            {t('term.variants')} ({r.variants.length})
          </div>
          <ul className="plain-list">
            {r.variants.map((v) => (
              <li key={`${v.kind}:${v.term}`} className="variant">
                <div className="small">
                  <strong lang="en">{v.term}</strong> <span className="muted">{t('term.keep', { form: v.preferred })}</span>
                </div>
                <div className="chips">
                  {v.forms.map((f) => (
                    <button key={f.form} type="button" className={`chip${f.form === v.preferred ? ' chip-ok' : ' chip-warn'}`} disabled={!f.first} onClick={() => f.first && goRef(f.first)} lang="en">
                      {f.form} <span className="muted">×{f.count}</span>
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {r.spelling.majority ? <p className="muted small">{t('term.spelling', { us: r.spelling.us, uk: r.spelling.uk })}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------------------------ */
/* Figure plan                                                                           */
/* ------------------------------------------------------------------------------------ */

function FigurePlan({ r }: { r: FigurePlanReport }) {
  const t = useT();
  const ct = useCodeT();
  const index = useMemo(() => refIndex(r), [r]);
  return (
    <div className="report-body">
      <div className="sub-label">{t('cons.flags')}</div>
      <FlagList flags={r.flags} index={index} />
      <div className="sub-label">
        {t('fig.floats')} ({r.floats.length})
      </div>
      {r.floats.length === 0 ? <EmptyState>{t('fig.none')}</EmptyState> : null}
      <ul className="plain-list float-list">
        {r.floats.map((f) => (
          <li key={`${f.kind}:${f.number}:${f.file}:${f.line}`} className={`float-row${f.refCount === 0 || f.outOfOrder ? ' is-warn' : ''}`}>
            <button type="button" className="list-row" onClick={() => goRef({ sentenceId: f.captionSentenceIds[0] ?? null, file: f.file, line: f.line })}>
              <span className="list-row-top">
                <strong>{t(f.kind === 'figure' ? 'fig.figure' : 'fig.table', { n: f.number })}</strong>
                {f.label ? <code className="small">{f.label}</code> : <Badge tone="warn">{t('fig.noLabel')}</Badge>}
                {f.refCount === 0 ? <Badge tone="warn">{t('fig.uncited')}</Badge> : <span className="muted small">{t('fig.refs', { n: f.refCount })}</span>}
                {f.outOfOrder ? <Badge tone="warn">{t('fig.outOfOrder')}</Badge> : null}
              </span>
              <span className="list-row-text small" lang="en">
                {displayLatex(f.caption).slice(0, 220)}
              </span>
            </button>
            <ul className="anatomy" aria-label={t('fig.anatomy')}>
              {f.checklist.map((c) => (
                <li key={c.key} className={`anat anat-${c.status}`} title={`${ct(`caption.${c.key}`, 'explain')}${c.evidence ? `\n“${c.evidence}”` : ''}`}>
                  <span aria-hidden="true">{c.status === 'ok' ? '✓' : c.status === 'na' ? '–' : '✗'}</span> {ct(`caption.${c.key}`)}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {r.claims.length ? (
        <>
          <div className="sub-label">{t('fig.claims')}</div>
          <ul className="plain-list">
            {r.claims.map((c) => (
              <li key={`${c.claimId}:${c.figureId}`} className="small">
                <code>{c.claimId}</code> → <code>{c.label ?? c.figureId}</code>{' '}
                <Badge tone={c.found && c.cited ? 'ok' : 'warn'}>{t(!c.found ? 'fig.claimMissing' : !c.cited ? 'fig.claimUncited' : 'fig.claimFound')}</Badge>
                {c.claimText ? (
                  <div className="muted" lang="en">
                    {c.claimText}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------------------ */

export function ConsistencySection({ api }: { api: ApiClient }) {
  const t = useT();
  return (
    <ReportSection title={t('check.consistency')} focusId="consistency" load={() => api.consistency()} count={(r) => r.flags.length}>
      {(r) => <Consistency r={r} />}
    </ReportSection>
  );
}

export function TerminologySection({ api }: { api: ApiClient }) {
  const t = useT();
  return (
    <ReportSection title={t('check.terminology')} focusId="terminology" load={() => api.terminologyReport()} count={(r) => r.flags.length}>
      {(r) => <Terminology r={r} />}
    </ReportSection>
  );
}

export function FigurePlanSection({ api }: { api: ApiClient }) {
  const t = useT();
  return (
    <ReportSection title={t('check.figures')} focusId="figures" load={() => api.figurePlan()} count={(r) => r.flags.length}>
      {(r) => <FigurePlan r={r} />}
    </ReportSection>
  );
}
