/**
 * Voice: the style-distance meter (two needles, "to you" and "to corpus", with the three sentences
 * pulling the draft furthest away), the editable voice memo, and the author's corpus with
 * "unassisted" toggles and paste-to-add. docs/design.md "Skill and voice system".
 */
import { useId, useMemo, useState } from 'react';
import type { CorpusEntry, StyleDistanceResponse } from '@paper-copilot/core';
import type { ApiClient } from '../contracts';
import { hasExtras } from '../api/extras';
import { revealSentence } from '../components/actions';
import { useAction, useLoad, useUnitText } from '../components/hooks';
import { IconPlus, IconRefresh } from '../components/Icons';
import { Badge, Button, EmptyState, Field, IconButton, InlineError, PanelHeader, PanelSection, displayLatex } from '../components/ui';
import { useT, type MsgKey } from '../i18n';
import { useWorkspace } from '../state/store';
import { useSectionList } from './QuestionsPanel';

const MAX = 1.5;
const SECTION_TYPES = ['abstract', 'intro', 'body', 'results', 'concl', 'caption', 'other'] as const;
const FEATURES = ['medianLen', 'p90Len', 'verbPos', 'passiveShare', 'weRate', 'hedgeRate', 'intensifierRate', 'connectorOpenerRate', 'inflatedRate', 'excessVocabRate', 'ttr', 'lenStd', 'dashRate', 'n'] as const;

function fmtFeature(k: string, v: number | undefined): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '—';
  if (k === 'passiveShare') return `${Math.round(v * 100)}%`;
  if (k === 'ttr') return v.toFixed(2);
  if (k === 'n') return String(Math.round(v));
  return v.toFixed(1);
}

/** Point on the gauge arc for a distance value (0 at the left, MAX at the right). */
function arcPoint(v: number, r: number, cx: number, cy: number): [number, number] {
  const a = Math.PI * (1 - Math.min(Math.max(v, 0), MAX) / MAX);
  return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
}

export function StyleGauge({ toYou, toCorpus, label }: { toYou: number | null; toCorpus: number; label: string }) {
  const cx = 130;
  const cy = 118;
  const r = 100;
  const [x0, y0] = arcPoint(0, r, cx, cy);
  const [x1, y1] = arcPoint(MAX, r, cx, cy);
  const ticks = [0, 0.5, 1, 1.5];
  const needle = (v: number, len: number) => arcPoint(v, len, cx, cy);
  const [yx, yy] = toYou !== null ? needle(toYou, r - 14) : [cx, cy];
  const [cx2, cy2] = needle(toCorpus, r - 26);
  return (
    <svg className="gauge" viewBox="0 0 260 136" role="img" aria-label={label}>
      <path d={`M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`} className="gauge-track" />
      {/* "about 1 = typical difference between authors": the band beyond 1 is shaded */}
      <path d={`M ${arcPoint(1, r, cx, cy).join(' ')} A ${r} ${r} 0 0 1 ${x1} ${y1}`} className="gauge-far" />
      {ticks.map((v) => {
        const [ax, ay] = arcPoint(v, r + 7, cx, cy);
        const [bx, by] = arcPoint(v, r - 7, cx, cy);
        const [lx, ly] = arcPoint(v, r + 18, cx, cy);
        return (
          <g key={v}>
            <line x1={ax} y1={ay} x2={bx} y2={by} className="gauge-tick" />
            <text x={lx} y={ly + 3} className="gauge-label" textAnchor="middle">
              {v.toFixed(1)}
            </text>
          </g>
        );
      })}
      <line x1={cx} y1={cy} x2={cx2} y2={cy2} className="gauge-needle gauge-needle-corpus" />
      {toYou !== null ? <line x1={cx} y1={cy} x2={yx} y2={yy} className="gauge-needle gauge-needle-you" /> : null}
      <circle cx={cx} cy={cy} r={5} className="gauge-hub" />
    </svg>
  );
}

function StyleMeter({ api, reloadKey }: { api: ApiClient; reloadKey: number }) {
  const t = useT();
  const sections = useSectionList();
  const units = useWorkspace((s) => s.units);
  const textOf = useUnitText();
  const [scope, setScope] = useState('document');
  const sid = useId();
  const res = useLoad<StyleDistanceResponse>(() => (scope === 'document' ? api.styleDistance('document') : api.styleDistance('section', scope)), [api, scope, reloadKey]);
  const d = res.data;
  const unitById = useMemo(() => new Map(units.map((u) => [u.id, u])), [units]);
  const label = d ? `${t('voice.meter')}: ${t('voice.toYou')} ${d.toAuthor === null ? '—' : d.toAuthor.toFixed(2)}, ${t('voice.toCorpus')} ${d.toCorpus.toFixed(2)}` : t('voice.meter');

  return (
    <PanelSection
      title={t('voice.meter')}
      actions={<IconButton size="sm" label={t('common.refresh')} icon={<IconRefresh size={13} />} onClick={res.reload} />}
    >
      <div className="meter-scope">
        <label htmlFor={sid} className="sub-label">
          {t('voice.scope')}
        </label>
        <select id={sid} className="select select-sm" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="document">{t('voice.scope.document')}</option>
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
      </div>
      <InlineError message={res.error} />
      {d ? (
        <>
          <div className="meter">
            <StyleGauge toYou={d.toAuthor} toCorpus={d.toCorpus} label={label} />
            <ul className="meter-legend">
              <li>
                <span className="legend-swatch legend-you" aria-hidden="true" />
                <span>{t('voice.toYou')}</span>
                <strong className="tabular">{d.toAuthor === null ? '—' : d.toAuthor.toFixed(2)}</strong>
              </li>
              <li>
                <span className="legend-swatch legend-corpus" aria-hidden="true" />
                <span>{t('voice.toCorpus')}</span>
                <strong className="tabular">{d.toCorpus.toFixed(2)}</strong>
              </li>
            </ul>
          </div>
          <p className="muted small">{t('voice.meterHint')}</p>
          <p className="muted small">{d.toAuthor === null ? t('voice.noAuthor') : t('voice.corpusSize', { n: d.corpusSize })}</p>
          <p className="muted small">{t('voice.corpusNote')}</p>
          {d.furthest.length ? (
            <>
              <div className="sub-label">{d.toAuthor === null ? t('voice.furthestCorpus') : t('voice.furthest')}</div>
              <ol className="plain-list">
                {d.furthest.slice(0, 3).map((f) => {
                  const u = unitById.get(f.sentenceId);
                  return (
                    <li key={f.sentenceId}>
                      <button type="button" className="list-row" disabled={!u} onClick={() => revealSentence(f.sentenceId)}>
                        <span className="list-row-text">{u ? displayLatex(textOf(u)) : f.sentenceId}</span>
                        <span className="list-row-meta small">
                          <span className="muted">{f.why}</span>
                          <span className="contrib" aria-hidden="true">
                            <span style={{ width: `${Math.min(100, Math.round(Math.abs(f.contribution) * 100))}%` }} />
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </>
          ) : null}
          <details className="features">
            <summary>{t('voice.features')}</summary>
            <table className="mini-table">
              <thead>
                <tr>
                  <th scope="col">{t('voice.col.feature')}</th>
                  <th scope="col">{t('voice.col.draft')}</th>
                  <th scope="col">{t('voice.col.you')}</th>
                  <th scope="col">{t('voice.col.corpus')}</th>
                </tr>
              </thead>
              <tbody>
                {FEATURES.map((k) => (
                  <tr key={k}>
                    <th scope="row">{t(`feature.${k}` as MsgKey)}</th>
                    <td className="tabular">{fmtFeature(k, d.features[k])}</td>
                    <td className="tabular">{fmtFeature(k, d.authorFeatures?.[k])}</td>
                    <td className="tabular">{fmtFeature(k, d.corpusFeatures[k])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      ) : res.loading ? (
        <p className="muted small">{t('common.loading')}</p>
      ) : null}
    </PanelSection>
  );
}

/** The voice tools. `embedded` renders only the sections (the Settings drawer provides the frame). */
export function VoicePanel({ api, embedded = false }: { api: ApiClient; embedded?: boolean }) {
  const t = useT();
  const pushNotice = useWorkspace((s) => s.pushNotice);
  const voice = useLoad(() => api.voice(), [api]);
  const [memo, setMemo] = useState<string | null>(null);
  const [meterKey, setMeterKey] = useState(0);
  const [paste, setPaste] = useState('');
  const [source, setSource] = useState('');
  const [sectionType, setSectionType] = useState<string>('body');
  const [unassisted, setUnassisted] = useState(false);
  const ids = { memo: useId(), paste: useId(), source: useId(), type: useId() };
  const canToggle = hasExtras(api);

  const memoText = memo ?? voice.data?.memo ?? '';
  const memoWords = memoText.split(/\s+/).filter(Boolean).length;
  const memoDirty = memo !== null && memo !== (voice.data?.memo ?? '');

  const saveMemo = useAction(async () => {
    await api.setMemo(memoText);
    if (voice.data) voice.setData({ ...voice.data, memo: memoText });
    setMemo(null);
    pushNotice('info', t('voice.memoSaved'));
  });

  const add = useAction(async () => {
    const parts = paste
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (!parts.length) return;
    const added = await api.addCorpus(parts.map((text) => ({ text, source: source.trim() || 'pasted', sectionType, unassisted })));
    if (voice.data) voice.setData({ ...voice.data, corpus: [...voice.data.corpus, ...added] });
    else voice.reload();
    setPaste('');
    pushNotice('info', t('voice.added', { n: added.length }));
    setMeterKey((k) => k + 1);
  });

  const toggle = useAction(async (entry: CorpusEntry, value: boolean) => {
    if (!hasExtras(api)) throw new Error(t('voice.toggleUnsupported'));
    const next = await api.setCorpusUnassisted(entry.id, value);
    if (voice.data) voice.setData({ ...voice.data, corpus: voice.data.corpus.map((c) => (c.id === entry.id ? (next ?? { ...c, unassisted: value }) : c)) });
    setMeterKey((k) => k + 1);
  });

  const corpus = voice.data?.corpus ?? [];

  const sections = (
    <>
      <StyleMeter api={api} reloadKey={meterKey} />

        <PanelSection title={t('voice.memo')}>
          <p className="muted small">{t('voice.memoHint')}</p>
          <textarea id={ids.memo} className="textarea" rows={6} value={memoText} placeholder={t('voice.memoPlaceholder')} aria-label={t('voice.memo')} onChange={(e) => setMemo(e.target.value)} />
          <div className="row-end">
            <span className={`small tabular row-start${memoWords > 400 ? ' danger-text' : ' muted'}`}>{t('voice.words', { n: memoWords })}</span>
            <Button size="sm" variant={memoDirty ? 'primary' : 'default'} disabled={!memoDirty} busy={saveMemo.busy} onClick={() => void saveMemo.run()}>
              {t('common.save')}
            </Button>
          </div>
        </PanelSection>

        <PanelSection title={t('voice.corpus')} count={corpus.length}>
          <InlineError message={voice.error} />
          {corpus.length === 0 ? <EmptyState>{t('voice.corpusEmpty')}</EmptyState> : null}
          <ul className="corpus-list">
            {corpus.map((c) => (
              <li key={c.id} className="corpus-item">
                <div className="corpus-head">
                  <strong className="corpus-source">{c.source}</strong>
                  <Badge tone="neutral">{(SECTION_TYPES as readonly string[]).includes(c.sectionType) ? t(`section.${c.sectionType}` as MsgKey) : c.sectionType}</Badge>
                  <span className="spacer" />
                  <label className="check" title={canToggle ? t('voice.unassistedTitle') : t('voice.toggleUnsupported')}>
                    <input type="checkbox" checked={c.unassisted} disabled={!canToggle || toggle.busy} onChange={(e) => void toggle.run(c, e.target.checked)} />
                    <span>{t('voice.unassisted')}</span>
                  </label>
                </div>
                <p className="corpus-text" lang="en">
                  {c.text}
                </p>
              </li>
            ))}
          </ul>
          {voice.data ? <p className="muted small">{t('voice.editPairs', { n: voice.data.editPairs.length })}</p> : null}
        </PanelSection>

        <PanelSection title={t('voice.add')}>
          <Field htmlFor={ids.paste} label={t('voice.paste')}>
            <textarea id={ids.paste} className="textarea" rows={5} value={paste} onChange={(e) => setPaste(e.target.value)} lang="en" />
          </Field>
          <div className="grid-2">
            <Field htmlFor={ids.source} label={t('voice.source')}>
              <input id={ids.source} className="input" value={source} placeholder={t('voice.sourceHint')} onChange={(e) => setSource(e.target.value)} />
            </Field>
            <Field htmlFor={ids.type} label={t('voice.sectionType')}>
              <select id={ids.type} className="select" value={sectionType} onChange={(e) => setSectionType(e.target.value)}>
                {SECTION_TYPES.map((s) => (
                  <option key={s} value={s}>
                    {t(`section.${s}` as MsgKey)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={unassisted} onChange={(e) => setUnassisted(e.target.checked)} />
            <span>{t('voice.iWroteThis')}</span>
          </label>
          <div className="row-end">
            <Button size="sm" variant="primary" icon={<IconPlus size={13} />} disabled={!paste.trim()} busy={add.busy} onClick={() => void add.run()}>
              {t('common.add')}
            </Button>
          </div>
        </PanelSection>
    </>
  );
  if (embedded) return <div className="voice-embedded">{sections}</div>;
  return (
    <div className="panel">
      <PanelHeader title={t('voice.title')} subtitle={t('voice.intro')} />
      <div className="panel-body">{sections}</div>
    </div>
  );
}
