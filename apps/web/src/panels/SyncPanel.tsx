/**
 * Sync: pull with the re-anchoring report; the push guard (blockers that reveal their sentence, the
 * exact diff co-authors will see, Push disabled while blockers remain); the AI-use disclosure.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { PushCheck, Venue } from '@paper-copilot/core';
import type { ApiClient } from '../contracts';
import { revealLine, revealSentence } from '../components/actions';
import { useAction, useLoad } from '../components/hooks';
import { IconCheck, IconCopy, IconPull, IconPush, IconRefresh, IconWarn } from '../components/Icons';
import { Badge, Button, Field, InlineError, PanelHeader, PanelSection } from '../components/ui';
import { useT, type MsgKey } from '../i18n';
import { useShell } from '../state/extra';
import { useWorkspace } from '../state/store';

const VENUES: Venue[] = ['aps', 'elsevier', 'arxiv', 'springer'];
let handledPushRequest = 0;

function DiffView({ diff }: { diff: string }) {
  const lines = diff.replace(/\n$/, '').split('\n');
  return (
    <pre className="diff" tabIndex={0}>
      {lines.map((l, i) => {
        const cls = l.startsWith('+++') || l.startsWith('---') ? 'diff-file' : l.startsWith('@@') ? 'diff-hunk' : l.startsWith('+') ? 'diff-add' : l.startsWith('-') ? 'diff-del' : 'diff-ctx';
        return (
          <span key={i} className={cls}>
            {l || ' '}
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
}

async function copyText(text: string, fallbackEl: HTMLTextAreaElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!fallbackEl) return false;
    fallbackEl.focus();
    fallbackEl.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }
}

function Blockers({ check }: { check: PushCheck }) {
  const t = useT();
  const groups = useMemo(() => {
    const m = new Map<string, PushCheck['blockers']>();
    for (const b of check.blockers) m.set(b.kind, [...(m.get(b.kind) ?? []), b]);
    return [...m.entries()];
  }, [check]);
  if (!check.blockers.length) {
    return (
      <p className="ok-line">
        <IconCheck size={14} /> {t('sync.ready')}
      </p>
    );
  }
  return (
    <div className="blockers">
      <p className="warn-line">
        <IconWarn size={14} /> {t('sync.blockers', { n: check.blockers.length })} · {t('sync.pushDisabled')}
      </p>
      {groups.map(([kind, items]) => (
        <div key={kind} className="blocker-group">
          <div className="list-group-label">
            {t(`blocker.${kind}` as MsgKey)} <span className="muted">({items.length})</span>
          </div>
          <ul className="plain-list">
            {items.map((b, i) => (
              <li key={`${b.sentenceId ?? b.line ?? 'x'}:${i}`}>
                <button
                  type="button"
                  className="list-row"
                  disabled={!b.sentenceId && b.line === null}
                  onClick={() => (b.sentenceId ? revealSentence(b.sentenceId) : b.line !== null ? revealLine(b.line) : undefined)}
                >
                  <span className="list-row-top">
                    <Badge tone={kind === 'proposed' ? 'ai' : kind === 'unsupported' || kind === 'conflict' ? 'danger' : 'warn'}>{t(`blocker.${kind}` as MsgKey)}</Badge>
                    {b.line !== null ? <span className="muted tabular">{t('common.line', { n: b.line })}</span> : null}
                  </span>
                  <span className="list-row-text">{b.text}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function SyncPanel({ api }: { api: ApiClient }) {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  const pushNotice = useWorkspace((s) => s.pushNotice);
  const reports = useShell((s) => s.pullReports);
  const setReports = useShell((s) => s.setPullReports);
  const check = useShell((s) => s.pushCheck);
  const setCheck = useShell((s) => s.setPushCheck);
  const pushRequest = useShell((s) => s.pushCheckRequest);
  const [message, setMessage] = useState('');
  const [pushOutput, setPushOutput] = useState<{ ok: boolean; output: string } | null>(null);
  const [venue, setVenue] = useState<Venue>(project?.config.venue ?? 'aps');
  const [format, setFormat] = useState<'latex' | 'plain'>('latex');
  const [edited, setEdited] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const ids = { msg: useId(), venue: useId(), text: useId() };

  const runCheck = useAction(async () => {
    const c = await api.pushCheck();
    setCheck(c);
    return c;
  });
  const runCheckNow = runCheck.run;
  useEffect(() => {
    // The top-bar Push button asks for a check (also when it caused this panel to mount).
    if (pushRequest > handledPushRequest) {
      handledPushRequest = pushRequest;
      void runCheckNow();
    }
  }, [pushRequest, runCheckNow]);

  const pull = useAction(async () => {
    const r = await api.pull();
    setReports(r);
  });
  const push = useAction(async () => {
    const r = await api.push(message.trim());
    setCheck(r.check);
    setPushOutput({ ok: r.ok, output: r.output });
    pushNotice(r.ok ? 'info' : 'warn', r.ok ? t('sync.pushed') : t('sync.refused'));
    if (r.ok) setMessage('');
  });

  const disclosure = useLoad(() => api.disclosure(venue), [api, venue]);
  useEffect(() => {
    setEdited(null);
  }, [venue, format, disclosure.data]);
  const generated = disclosure.data ? (format === 'latex' ? disclosure.data.latex : disclosure.data.plain) : '';
  const text = edited ?? generated;
  const stats = disclosure.data?.stats as { totalSentences?: number; everAi?: number } | undefined;

  const sum = reports?.reduce(
    (a, r) => ({ unchanged: a.unchanged + r.unchanged, edited: a.edited + r.edited.length, created: a.created + r.created.length, orphaned: a.orphaned + r.orphaned.length }),
    { unchanged: 0, edited: 0, created: 0, orphaned: 0 },
  );
  const editedIds = reports?.flatMap((r) => r.edited) ?? [];
  const orphanIds = reports?.flatMap((r) => r.orphaned) ?? [];
  const canPush = !!check && check.ok && message.trim().length > 0 && !push.busy;

  return (
    <div className="panel">
      <PanelHeader
        title={t('sync.title')}
        subtitle={t('sync.intro')}
        actions={
          project ? (
            <span className="muted small" title={project.config.sync.remote ?? undefined}>
              {t('sync.mode')}: {project.config.sync.mode}
            </span>
          ) : null
        }
      />
      <div className="panel-body">
        <PanelSection title={t('sync.pullSection')} actions={<Button size="sm" icon={<IconPull size={13} />} busy={pull.busy} onClick={() => void pull.run()}>{t('sync.pullButton')}</Button>}>
          {project?.config.sync.remote ? (
            <p className="muted small">
              {t('sync.remote')}: <span className="mono">{project.config.sync.remote}</span> · {project.config.sync.branch}
            </p>
          ) : null}
          {sum ? <p className="report-line">{t('sync.report', sum)}</p> : null}
          {editedIds.length ? (
            <>
              <div className="sub-label">{t('sync.edited')}</div>
              <ul className="chips">
                {editedIds.map((id) => (
                  <li key={id}>
                    <button type="button" className="chip chip-ext" onClick={() => revealSentence(id)}>
                      {t('common.goToSentence')} <code>{id.slice(-6)}</code>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {orphanIds.length ? (
            <>
              <div className="sub-label">{t('sync.orphaned')}</div>
              <ul className="chips">
                {orphanIds.map((id) => (
                  <li key={id} className="chip">
                    <code>{id.slice(-6)}</code>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </PanelSection>

        <PanelSection title={t('sync.pushSection')} actions={<Button size="sm" icon={<IconRefresh size={13} />} busy={runCheck.busy} onClick={() => void runCheck.run()}>{t('sync.check')}</Button>}>
          <InlineError message={runCheck.error} />
          {check ? (
            <>
              <Blockers check={check} />
              <div className="sub-label">{t('sync.diff')}</div>
              {check.diff ? <DiffView diff={check.diff} /> : <p className="muted small">{t('sync.noDiff')}</p>}
              <Field htmlFor={ids.msg} label={t('sync.message')}>
                <input id={ids.msg} className="input" value={message} placeholder={t('sync.messageHint')} onChange={(e) => setMessage(e.target.value)} lang="en" />
              </Field>
              <div className="row-end">
                <Button variant="primary" icon={<IconPush size={14} />} disabled={!canPush} busy={push.busy} onClick={() => void push.run()} title={!check.ok ? t('sync.pushDisabled') : undefined}>
                  {t('sync.pushButton')}
                </Button>
              </div>
              {pushOutput ? <pre className={`log-tail${pushOutput.ok ? '' : ' is-error'}`}>{pushOutput.output}</pre> : null}
            </>
          ) : (
            <p className="muted small">{t('sync.checkFirst')}</p>
          )}
        </PanelSection>

        <PanelSection title={t('sync.disclosure')}>
          <p className="muted small">{t('sync.disclosureHint')}</p>
          <div className="grid-2">
            <Field htmlFor={ids.venue} label={t('sync.venue')}>
              <select id={ids.venue} className="select" value={venue} onChange={(e) => setVenue(e.target.value as Venue)}>
                {VENUES.map((v) => (
                  <option key={v} value={v}>
                    {t(`venue.${v}` as MsgKey)}
                  </option>
                ))}
              </select>
            </Field>
            <div className="field">
              <div className="field-label-row">
                <span className="field-label">&nbsp;</span>
              </div>
              <div className="segmented segmented-sm" role="group" aria-label={t('sync.disclosure')}>
                <button type="button" aria-pressed={format === 'latex'} onClick={() => setFormat('latex')}>
                  {t('sync.latex')}
                </button>
                <button type="button" aria-pressed={format === 'plain'} onClick={() => setFormat('plain')}>
                  {t('sync.plain')}
                </button>
              </div>
            </div>
          </div>
          <InlineError message={disclosure.error} />
          {disclosure.data ? (
            <>
              <p className="small">
                <span className="sub-label">{t('sync.placement')}:</span> {disclosure.data.placement}
              </p>
              {stats && typeof stats.totalSentences === 'number' ? <p className="muted small">{t('sync.stats', { total: stats.totalSentences, everAi: stats.everAi ?? 0 })}</p> : null}
              <label className="sr-only" htmlFor={ids.text}>
                {t('sync.disclosure')}
              </label>
              <textarea id={ids.text} ref={textRef} className="textarea mono disclosure-text" rows={8} value={text} onChange={(e) => setEdited(e.target.value)} lang="en" spellCheck={false} />
              <div className="row-end">
                <Button size="sm" icon={<IconRefresh size={13} />} busy={disclosure.loading} onClick={disclosure.reload}>
                  {t('sync.generate')}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  icon={copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
                  onClick={async () => {
                    const ok = await copyText(text, textRef.current);
                    setCopied(ok);
                    if (ok) setTimeout(() => setCopied(false), 1600);
                  }}
                >
                  {copied ? t('common.copied') : t('common.copy')}
                </Button>
              </div>
            </>
          ) : disclosure.loading ? (
            <p className="muted small">{t('common.loading')}</p>
          ) : null}
        </PanelSection>
      </div>
    </div>
  );
}
