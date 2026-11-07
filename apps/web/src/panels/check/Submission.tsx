/**
 * The one-click submission check (top of ④): blockers first, each failing item expandable to the
 * sentences or lines it concerns (click reveals, switching files first). Labels come from the core i18n
 * tables (`submission.<id>`), so they follow the UI language.
 */
import { useId, useState } from 'react';
import type { SubmissionItem, SubmissionReport, Venue } from '@paper-copilot/core';
import type { ApiClient } from '../../contracts';
import { runSubmissionCheck } from '../../components/actions';
import { IconCheck, IconChevronDown, IconRefresh, IconWarn } from '../../components/Icons';
import { orderSubmissionItems, submissionStatus } from '../../components/steps';
import { Badge, Button, displayLatex } from '../../components/ui';
import { useCodeT, useT, type MsgKey } from '../../i18n';
import { useShell } from '../../state/extra';
import { useWorkspace } from '../../state/store';
import { goRef } from './refs';

const VENUES: Venue[] = ['aps', 'elsevier', 'arxiv', 'springer'];

function ItemRow({ item }: { item: SubmissionItem }) {
  const t = useT();
  const ct = useCodeT();
  const [open, setOpen] = useState(false);
  const id = useId();
  const code = `submission.${item.id}`;
  const failing = !item.ok;
  const tone = item.ok ? 'ok' : item.severity === 'block' ? 'danger' : item.severity === 'warn' ? 'warn' : 'neutral';
  const expandable = failing && (item.items.length > 0 || !!item.note);
  return (
    <li className={`sub-item sub-${item.ok ? 'ok' : item.severity}`} data-item={item.id}>
      <button type="button" className="sub-head" aria-expanded={expandable ? open : undefined} aria-controls={expandable ? id : undefined} onClick={() => expandable && setOpen((o) => !o)} disabled={!expandable}>
        <span className={`sub-icon sub-icon-${tone}`} aria-hidden="true">
          {item.ok ? <IconCheck size={13} /> : <IconWarn size={13} />}
        </span>
        <span className="sub-label" title={ct(code, 'explain')}>
          {ct(code)}
        </span>
        {failing ? (
          <Badge tone={tone}>
            {item.count > 0 ? `${item.count} · ` : ''}
            {t(`check.sev.${item.severity}` as MsgKey)}
          </Badge>
        ) : null}
        {expandable ? <IconChevronDown className={`sub-chevron${open ? ' is-open' : ''}`} /> : null}
      </button>
      {expandable && open ? (
        <div id={id} className="sub-body">
          <p className="muted small">{ct(code, 'explain')}</p>
          {item.note ? (
            <p className="small sub-note" lang="en">
              {item.note}
            </p>
          ) : null}
          {item.items.length ? (
            <ul className="plain-list sub-entries">
              {item.items.map((e, i) => (
                <li key={`${e.file}:${e.sentenceId ?? e.line ?? i}:${i}`}>
                  <button type="button" className="list-row" onClick={() => goRef({ sentenceId: e.sentenceId, file: e.file, line: e.line })} disabled={!e.sentenceId && e.line === null}>
                    <span className="list-row-top">
                      <span className="mono small">{e.file}</span>
                      {e.line !== null ? <span className="muted tabular">{t('common.line', { n: e.line })}</span> : null}
                    </span>
                    <span className="list-row-text" lang="en">
                      {displayLatex(e.text)}
                    </span>
                  </button>
                </li>
              ))}
              {item.count > item.items.length ? <li className="muted small">{t('check.more', { n: item.count - item.items.length })}</li> : null}
            </ul>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function SubmissionCheck({ api }: { api: ApiClient }) {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  const report = useShell((s) => s.submission);
  const [venue, setVenue] = useState<Venue>(project?.config.venue ?? 'aps');
  const [busy, setBusy] = useState(false);
  const [showPassed, setShowPassed] = useState(false);
  const venueId = useId();
  const run = async (v: Venue = venue) => {
    setBusy(true);
    try {
      await runSubmissionCheck(api, v);
    } finally {
      setBusy(false);
    }
  };
  const st = submissionStatus(report);
  const items: SubmissionReport['items'] = report ? orderSubmissionItems(report) : [];
  const failing = items.filter((i) => !i.ok);
  const passed = items.filter((i) => i.ok);
  return (
    <section className={`submission submission-${st.tone}`} data-section="submission" aria-labelledby="submission-title" data-testid="submission-check">
      <div className="submission-head">
        <h3 id="submission-title" className="submission-title">
          {report ? (st.tone === 'ready' ? t('check.ready') : st.blockers ? t('check.blockers', { n: st.blockers }) : t('check.warnings', { n: st.issues })) : t('check.subTitle')}
        </h3>
        <div className="submission-actions">
          <label className="sr-only" htmlFor={venueId}>
            {t('check.venue')}
          </label>
          <select
            id={venueId}
            className="select select-sm"
            value={venue}
            onChange={(e) => {
              const v = e.target.value as Venue;
              setVenue(v);
              if (report) void run(v);
            }}
            title={t('check.venue')}
          >
            {VENUES.map((v) => (
              <option key={v} value={v}>
                {t(`venue.${v}` as MsgKey)}
              </option>
            ))}
          </select>
          <Button size="sm" variant={report ? 'default' : 'primary'} icon={<IconRefresh size={13} />} busy={busy} onClick={() => void run()}>
            {report ? t('check.rerun') : t('check.run')}
          </Button>
        </div>
      </div>
      {!report ? (
        <p className="muted small">{t('check.never')}</p>
      ) : (
        <>
          {st.blockers && st.issues > st.blockers ? <p className="muted small">{t('check.warnings', { n: st.issues - st.blockers })}</p> : null}
          {failing.length ? (
            <ul className="plain-list sub-list">
              {failing.map((i) => (
                <ItemRow key={i.id} item={i} />
              ))}
            </ul>
          ) : (
            <p className="small ok-text">{t('check.allOk', { n: items.length })}</p>
          )}
          {passed.length ? (
            <div className="sub-passed">
              <button type="button" className="link-btn small" aria-expanded={showPassed} onClick={() => setShowPassed((x) => !x)}>
                {t('check.passed', { n: passed.length })}
              </button>
              {showPassed ? (
                <ul className="plain-list sub-list">
                  {passed.map((i) => (
                    <ItemRow key={i.id} item={i} />
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
