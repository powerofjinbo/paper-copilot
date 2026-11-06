/**
 * Outline: the skill's Step 0 five items (written by the author first), three framings (only after
 * the author ticks "I wrote these myself" — the anti-anchoring rule), and the section tree with
 * ghost modes, paragraph jobs, claims, the remaining plan and the Draft buttons.
 *
 * Editing happens on a local working copy; Save sends it with api.saveOutline. A ghost-mode change
 * is saved at once (it changes how the editor behaves). If the server sends a newer outline while
 * the copy has unsaved edits, a banner offers Reload; Save keeps the local version.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { GhostMode, shortId, type Fact, type Outline, type OutlineParagraph, type OutlineSection, type Provenance } from '@paper-copilot/core';
import type { ApiClient } from '../contracts';
import { revealSentence } from '../components/actions';
import { isJobActive, useAction, useLoad, useUnitText } from '../components/hooks';
import { IconArrowDown, IconArrowUp, IconDraft, IconPlus, IconSparkle, IconTrash, Spinner } from '../components/Icons';
import { Badge, Button, EmptyState, Field, Highlight, IconButton, InlineError, PanelHeader, PanelSection, ProvTag, displayLatex } from '../components/ui';
import { ghostHintKey, ghostKey, useT } from '../i18n';
import { useWorkspace } from '../state/store';
import { factValueText } from './FactsPanel';

type Edit = (o: Outline) => void;

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Editing an AI-proposed item makes it AI-edited; author items stay author items. */
function touched(p: Provenance): Provenance {
  return p === 'ai-proposed' ? 'ai-edited' : p;
}

interface WorkState {
  base: Outline | null;
  draft: Outline | null;
  incoming: Outline | null;
}

function useWorkingCopy(server: Outline | null) {
  const [st, setRaw] = useState<WorkState>({ base: server, draft: server, incoming: null });
  // Mirror of the latest state, so edits issued in one tick compose and helpers can return values.
  const ref = useRef(st);
  const setSt = (next: WorkState) => {
    ref.current = next;
    setRaw(next);
  };
  useEffect(() => {
    if (!server) return;
    const prev = ref.current;
    if (!prev.draft || !prev.base || same(prev.draft, prev.base)) setSt({ base: server, draft: server, incoming: null });
    else if (!same(server, prev.base)) setSt({ ...prev, incoming: server });
  }, [server]);
  const dirty = !!st.draft && !!st.base && !same(st.draft, st.base);
  const edit = (fn: Edit) => {
    const prev = ref.current;
    if (!prev.draft) return;
    const next = structuredClone(prev.draft);
    fn(next);
    setSt({ ...prev, draft: next });
  };
  const accept = (o: Outline) => setSt({ base: o, draft: o, incoming: null });
  /** A change saved immediately: apply it to the base (what the server has) and to the draft. */
  const applyBoth = (fn: Edit): Outline | null => {
    const prev = ref.current;
    if (!prev.base || !prev.draft) return null;
    const b = structuredClone(prev.base);
    const d = structuredClone(prev.draft);
    fn(b);
    fn(d);
    setSt({ ...prev, base: b, draft: d });
    return b;
  };
  const setBase = (b: Outline) => setSt({ ...ref.current, base: b });
  return { ...st, dirty, edit, accept, applyBoth, setBase };
}

function TextArea({ id, value, onChange, placeholder, rows = 2 }: { id?: string; value: string; onChange: (v: string) => void; placeholder?: string; rows?: number }) {
  return <textarea id={id} className="textarea" rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

function FactSelect({ value, facts, onChange, label, allowEmpty = true }: { value: string | null; facts: Fact[]; onChange: (v: string | null) => void; label: string; allowEmpty?: boolean }) {
  const t = useT();
  return (
    <select className="select" aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      {allowEmpty ? <option value="">{t('outline.chooseFact')}</option> : null}
      {value && !facts.some((f) => f.id === value) ? <option value={value}>{value}</option> : null}
      {facts.map((f) => (
        <option key={f.id} value={f.id}>
          {f.id} = {factValueText(f)}
        </option>
      ))}
    </select>
  );
}

function ItemHead({ children, provenance }: { children: ReactNode; provenance: Provenance }) {
  return (
    <span className="item-head">
      <span>{children}</span>
      <ProvTag provenance={provenance} />
    </span>
  );
}

/* ------------------------------------------------------------------------------------ */

function KeyPhraseUses({ phrase }: { phrase: string }) {
  const t = useT();
  const units = useWorkspace((s) => s.units);
  const textOf = useUnitText();
  const hits = useMemo(() => {
    const p = phrase.trim().toLowerCase();
    if (p.length < 3) return [];
    return units.filter((u) => textOf(u).toLowerCase().includes(p));
  }, [phrase, units, textOf]);
  if (phrase.trim().length < 3) return null;
  return (
    <div className="keyphrase-uses">
      <div className="muted small">{hits.length ? t('outline.keyPhraseUses', { n: hits.length }) : t('outline.keyPhraseNone')}</div>
      {hits.length ? (
        <ul className="plain-list compact">
          {hits.slice(0, 6).map((u) => (
            <li key={u.id}>
              <button type="button" className="list-row small" onClick={() => revealSentence(u.id)}>
                <span className="list-row-top">
                  <span className="muted">{u.part}</span>
                  <span className="muted tabular">{t('common.line', { n: u.line })}</span>
                </span>
                <span className="list-row-text">
                  <Highlight text={displayLatex(textOf(u))} needle={phrase} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function FiveItems({ o, edit, facts, claimOptions, figureOptions }: { o: Outline; edit: (fn: Edit) => void; facts: Fact[]; claimOptions: string[]; figureOptions: string[] }) {
  const t = useT();
  const ids = { story: useId(), key: useId(), gap: useId(), enabler: useId(), contrast: useId(), cond: useId(), htext: useId(), claims: useId(), figs: useId() };
  const usable = facts.filter((f) => !f.excluded);
  return (
    <div className="five-items">
      <Field htmlFor={ids.story} label={<ItemHead provenance={o.story.provenance}>{t('outline.story')}</ItemHead>}>
        <TextArea
          id={ids.story}
          rows={3}
          value={o.story.text}
          placeholder={t('outline.storyHint')}
          onChange={(v) =>
            edit((x) => {
              x.story.text = v;
              x.story.provenance = touched(x.story.provenance);
            })
          }
        />
      </Field>
      <Field htmlFor={ids.key} label={t('outline.keyPhrase')} hint={t('outline.keyPhraseHint')}>
        <input
          id={ids.key}
          className="input"
          value={o.story.keyPhrase}
          onChange={(e) =>
            edit((x) => {
              x.story.keyPhrase = e.target.value;
            })
          }
        />
        <KeyPhraseUses phrase={o.story.keyPhrase} />
      </Field>
      <Field htmlFor={ids.gap} label={<ItemHead provenance={o.gap.provenance}>{t('outline.gap')}</ItemHead>}>
        <TextArea
          id={ids.gap}
          value={o.gap.text}
          placeholder={t('outline.gapHint')}
          onChange={(v) =>
            edit((x) => {
              x.gap.text = v;
              x.gap.provenance = touched(x.gap.provenance);
            })
          }
        />
      </Field>
      <Field htmlFor={ids.enabler} label={<ItemHead provenance={o.enabler.provenance}>{t('outline.enabler')}</ItemHead>}>
        <TextArea
          id={ids.enabler}
          value={o.enabler.text}
          placeholder={t('outline.enablerHint')}
          onChange={(v) =>
            edit((x) => {
              x.enabler.text = v;
              x.enabler.provenance = touched(x.enabler.provenance);
            })
          }
        />
      </Field>
      <Field htmlFor={ids.contrast} label={<ItemHead provenance={o.contrast.provenance}>{t('outline.contrast')}</ItemHead>}>
        <TextArea
          id={ids.contrast}
          value={o.contrast.text}
          placeholder={t('outline.contrastHint')}
          onChange={(v) =>
            edit((x) => {
              x.contrast.text = v;
              x.contrast.provenance = touched(x.contrast.provenance);
            })
          }
        />
      </Field>

      <div className="field">
        <div className="field-label-row">
          <span className="field-label">{t('outline.ladder')}</span>
        </div>
        {o.ladder.length === 0 ? <p className="muted small">{t('outline.ladderEmpty')}</p> : null}
        <ol className="ladder">
          {o.ladder.map((c, i) => (
            <li key={c.id} className="ladder-case">
              <div className="ladder-row">
                <span className="ladder-n" aria-hidden="true">
                  {i + 1}
                </span>
                <input
                  className="input"
                  aria-label={t('outline.caseN', { n: i + 1 })}
                  value={c.text}
                  placeholder={t('outline.caseHint')}
                  onChange={(e) =>
                    edit((x) => {
                      const k = x.ladder[i]!;
                      k.text = e.target.value;
                      k.provenance = touched(k.provenance);
                    })
                  }
                />
                <IconButton size="sm" label={t('common.moveUp')} icon={<IconArrowUp size={13} />} disabled={i === 0} onClick={() => edit((x) => void x.ladder.splice(i - 1, 0, ...x.ladder.splice(i, 1)))} />
                <IconButton size="sm" label={t('common.moveDown')} icon={<IconArrowDown size={13} />} disabled={i === o.ladder.length - 1} onClick={() => edit((x) => void x.ladder.splice(i + 1, 0, ...x.ladder.splice(i, 1)))} />
                <IconButton size="sm" label={t('common.remove')} icon={<IconTrash size={13} />} onClick={() => edit((x) => void x.ladder.splice(i, 1))} />
              </div>
              <div className="chips">
                {c.factIds.map((fid) => (
                  <span key={fid} className="chip">
                    <code>{fid}</code>
                    <button type="button" className="chip-x" aria-label={`${t('common.remove')} ${fid}`} title={t('common.remove')} onClick={() => edit((x) => void (x.ladder[i]!.factIds = x.ladder[i]!.factIds.filter((y) => y !== fid)))}>
                      ×
                    </button>
                  </span>
                ))}
                <select
                  className="select select-sm"
                  aria-label={t('outline.linkFact')}
                  value=""
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v) edit((x) => void (x.ladder[i]!.factIds = [...new Set([...x.ladder[i]!.factIds, v])]));
                  }}
                >
                  <option value="">{t('outline.linkFact')}</option>
                  {usable
                    .filter((f) => !c.factIds.includes(f.id))
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.id}
                      </option>
                    ))}
                </select>
              </div>
            </li>
          ))}
        </ol>
        <Button size="sm" variant="ghost" icon={<IconPlus size={13} />} onClick={() => edit((x) => void x.ladder.push({ id: shortId('case-'), text: '', factIds: [], provenance: 'author' }))}>
          {t('outline.ladderAdd')}
        </Button>
      </div>

      <div className="field">
        <div className="field-label-row">
          <span className="field-label">{t('outline.claimFigures')}</span>
        </div>
        <datalist id={ids.claims}>
          {claimOptions.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <datalist id={ids.figs}>
          {figureOptions.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
        {o.claimFigures.length === 0 ? <p className="muted small">{t('outline.mappingEmpty')}</p> : null}
        {o.claimFigures.map((cf, i) => (
          <div key={i} className="map-row">
            <input className="input" list={ids.claims} aria-label={t('outline.claim')} placeholder={t('outline.claim')} value={cf.claimId} onChange={(e) => edit((x) => void (x.claimFigures[i]!.claimId = e.target.value))} />
            <span aria-hidden="true" className="muted">
              →
            </span>
            <input className="input" list={ids.figs} aria-label={t('outline.figure')} placeholder={t('outline.figure')} value={cf.figureId} onChange={(e) => edit((x) => void (x.claimFigures[i]!.figureId = e.target.value))} />
            <IconButton size="sm" label={t('common.remove')} icon={<IconTrash size={13} />} onClick={() => edit((x) => void x.claimFigures.splice(i, 1))} />
          </div>
        ))}
        <Button
          size="sm"
          variant="ghost"
          icon={<IconPlus size={13} />}
          onClick={() => edit((x) => void x.claimFigures.push({ claimId: claimOptions[0] ?? '', figureId: figureOptions[0] ?? '' }))}
        >
          {t('outline.addMapping')}
        </Button>
      </div>

      <div className="field">
        <div className="field-label-row">
          <span className="field-label">
            <ItemHead provenance={o.headline.provenance}>{t('outline.headline')}</ItemHead>
          </span>
        </div>
        <div className="grid-2">
          <label className="sub-field">
            <span className="sub-label">{t('outline.headlineFact')}</span>
            <FactSelect
              label={t('outline.headlineFact')}
              value={o.headline.factId}
              facts={usable}
              onChange={(v) =>
                edit((x) => {
                  x.headline.factId = v;
                  x.headline.provenance = touched(x.headline.provenance);
                })
              }
            />
          </label>
          <label className="sub-field">
            <span className="sub-label">{t('outline.baselineFact')}</span>
            <FactSelect
              label={t('outline.baselineFact')}
              value={o.headline.baselineFactId}
              facts={usable}
              onChange={(v) =>
                edit((x) => {
                  x.headline.baselineFactId = v;
                  x.headline.provenance = touched(x.headline.provenance);
                })
              }
            />
          </label>
        </div>
        <label className="sub-field" htmlFor={ids.cond}>
          <span className="sub-label">{t('outline.condition')}</span>
        </label>
        <input
          id={ids.cond}
          className="input"
          value={o.headline.condition}
          placeholder={t('outline.conditionHint')}
          onChange={(e) =>
            edit((x) => {
              x.headline.condition = e.target.value;
              x.headline.provenance = touched(x.headline.provenance);
            })
          }
        />
        <label className="sub-field" htmlFor={ids.htext}>
          <span className="sub-label">{t('outline.headlineText')}</span>
        </label>
        <input
          id={ids.htext}
          className="input"
          value={o.headline.text}
          onChange={(e) =>
            edit((x) => {
              x.headline.text = e.target.value;
              x.headline.provenance = touched(x.headline.provenance);
            })
          }
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------ */

function SectionCard({
  s,
  index,
  edit,
  onGhostMode,
  onDraft,
  draftJob,
  drafting,
  claimOptions,
  authorFilled,
}: {
  authorFilled: boolean;
  s: OutlineSection;
  index: number;
  edit: (fn: Edit) => void;
  onGhostMode: (m: GhostMode) => void;
  onDraft: (fromNotes: boolean) => void;
  draftJob: { state: string; message: string } | null;
  drafting: boolean;
  claimOptions: string[];
}) {
  const t = useT();
  const qid = useId();
  const gid = useId();
  // notes the author wrote (an AI-proposed paragraph's notes do not count): drafting from them anchors on
  // the author's own words
  const hasNotes = s.paragraphs.some((p) => p.provenance === 'author' && p.intentNotes.some((n) => n.trim().length > 0));
  // anti-anchoring (docs/design.md): the author writes the five items before the AI drafts anything
  const locked = !authorFilled;
  const sectionEdit = (fn: (x: OutlineSection) => void) =>
    edit((o) => {
      const x = o.sections[index];
      if (x) fn(x);
    });
  const active = drafting || isJobActive(draftJob);
  return (
    <PanelSection
      className="section-card"
      title={
        <span className="section-title">
          <span>{s.title || s.id}</span>
        </span>
      }
      count={<Badge tone="neutral">{t(ghostKey(s.ghostMode))}</Badge>}
      defaultOpen={false}
    >
      <p className="muted small section-meta">
        <span className="mono">{s.id}</span>
        {s.template ? ` · ${s.template}` : ''}
      </p>
      <Field htmlFor={qid} label={t('outline.question')}>
        <input
          id={qid}
          className="input"
          value={s.question}
          onChange={(e) =>
            sectionEdit((x) => {
              x.question = e.target.value;
              x.provenance = touched(x.provenance);
            })
          }
        />
      </Field>
      <Field htmlFor={gid} label={t('outline.ghostMode')} hint={t(ghostHintKey(s.ghostMode))}>
        <select id={gid} className="select" value={s.ghostMode} onChange={(e) => onGhostMode(e.target.value as GhostMode)}>
          {GhostMode.options.map((m) => (
            <option key={m} value={m}>
              {t(ghostKey(m))}
            </option>
          ))}
        </select>
      </Field>

      <div className="field">
        <div className="field-label-row">
          <span className="field-label">{t('outline.paragraphs')}</span>
        </div>
        {s.paragraphs.length === 0 ? <p className="muted small">{t('outline.noParagraphs')}</p> : null}
        <ol className="para-list">
          {s.paragraphs.map((p, pi) => (
            <ParagraphCard key={p.pid} p={p} n={pi + 1} claimOptions={claimOptions} edit={(fn) => sectionEdit((x) => fn(x.paragraphs[pi]!))} onRemove={() => sectionEdit((x) => void x.paragraphs.splice(pi, 1))} />
          ))}
        </ol>
        <Button
          size="sm"
          variant="ghost"
          icon={<IconPlus size={13} />}
          onClick={() =>
            sectionEdit((x) =>
              void x.paragraphs.push({
                pid: shortId('p-'),
                job: '',
                moves: [],
                claimIds: [],
                intentNotes: [],
                plan: { job: '', claimIds: [], said: {}, remaining: [] },
                provenance: 'author',
              }),
            )
          }
        >
          {t('outline.addParagraph')}
        </Button>
      </div>

      <div className="draft-row">
        <Button
          size="sm"
          variant={hasNotes && !locked ? 'primary' : 'default'}
          icon={<IconDraft size={13} />}
          disabled={active || locked || !hasNotes}
          title={locked ? t('outline.draftLocked') : !hasNotes ? t('outline.draftNotesLocked') : undefined}
          onClick={() => onDraft(true)}
        >
          {t('outline.draftNotes')}
        </Button>
        <Button
          size="sm"
          variant={hasNotes || locked ? 'default' : 'primary'}
          icon={<IconDraft size={13} />}
          disabled={active || locked}
          title={locked ? t('outline.draftLocked') : undefined}
          onClick={() => onDraft(false)}
        >
          {t('outline.draftOutline')}
        </Button>
      </div>
      {locked ? (
        <p className="muted small draft-locked">
          {t('outline.draftLocked')}{' '}
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              const el = document.querySelector('.five-items');
              el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
              (el?.querySelector('textarea, input') as HTMLElement | null)?.focus({ preventScroll: true });
            }}
          >
            {t('outline.toStep0')}
          </button>
        </p>
      ) : draftJob && isJobActive(draftJob) ? (
        <div className="job-line" role="status">
          <Spinner size={12} /> <span>{draftJob.message === 'running' || draftJob.message === 'queued' ? t('job.draft') : draftJob.message}</span>
        </div>
      ) : (
        <p className="muted small">{t('outline.draftHint')}</p>
      )}
    </PanelSection>
  );
}

function ParagraphCard({ p, n, edit, onRemove, claimOptions }: { p: OutlineParagraph; n: number; edit: (fn: (x: OutlineParagraph) => void) => void; onRemove: () => void; claimOptions: string[] }) {
  const t = useT();
  const jid = useId();
  const said = p.plan.said;
  return (
    <li className="para-card">
      <div className="para-head">
        <span className="para-n">{t('outline.paragraphN', { n })}</span>
        <ProvTag provenance={p.provenance} />
        <span className="spacer" />
        <IconButton size="sm" label={t('outline.removeParagraph')} icon={<IconTrash size={13} />} onClick={onRemove} />
      </div>
      <label className="sub-label" htmlFor={jid}>
        {t('outline.job')}
      </label>
      <input
        id={jid}
        className="input"
        value={p.job}
        placeholder={t('outline.jobHint')}
        onChange={(e) =>
          edit((x) => {
            x.job = e.target.value;
            x.plan.job = e.target.value;
            x.provenance = touched(x.provenance);
          })
        }
      />
      <div className="sub-label">{t('outline.claims')}</div>
      <div className="chips">
        {p.claimIds.map((c) => {
          const sid = said[c];
          return sid ? (
            <button key={c} type="button" className="chip chip-said" title={t('common.goToSentence')} onClick={() => revealSentence(sid)}>
              <code>{c}</code> <span>{t('outline.said')}</span>
            </button>
          ) : (
            <span key={c} className="chip chip-unsaid">
              <code>{c}</code> <span>{t('outline.unsaid')}</span>
              <button type="button" className="chip-x" aria-label={`${t('common.remove')} ${c}`} title={t('common.remove')} onClick={() => edit((x) => void (x.claimIds = x.claimIds.filter((y) => y !== c)))}>
                ×
              </button>
            </span>
          );
        })}
        {claimOptions.filter((c) => !p.claimIds.includes(c)).length ? (
          <select
            className="select select-sm"
            aria-label={t('outline.claims')}
            value=""
            onChange={(e) => {
              const v = e.target.value;
              if (v)
                edit((x) => {
                  x.claimIds = [...new Set([...x.claimIds, v])];
                  x.plan.claimIds = x.claimIds;
                });
            }}
          >
            <option value="">+ {t('outline.claim')}</option>
            {claimOptions
              .filter((c) => !p.claimIds.includes(c))
              .map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
          </select>
        ) : null}
      </div>
      {p.plan.remaining.length ? (
        <div className="plan-steps">
          <div className="sub-label">{t('outline.remaining')}</div>
          <ol>
            {p.plan.remaining.map((step) => (
              <li key={step.id}>
                {step.move ? <span className="move-tag">{step.move}</span> : null} {step.intent}
                {step.factIds.length ? <span className="muted mono small"> · {step.factIds.join(', ')}</span> : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {p.intentNotes.length ? (
        <ul className="intent-notes">
          {p.intentNotes.map((note, i) => (
            <li key={i} lang="zh-CN">
              {note}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/* ------------------------------------------------------------------------------------ */

export function OutlinePanel({ api }: { api: ApiClient }) {
  const t = useT();
  const server = useWorkspace((s) => s.outline);
  const setOutline = useWorkspace((s) => s.setOutline);
  const facts = useWorkspace((s) => s.facts);
  const units = useWorkspace((s) => s.units);
  const file = useWorkspace((s) => s.file);
  const jobs = useWorkspace((s) => s.jobs);
  const wc = useWorkingCopy(server);
  const panels = useLoad(() => api.panels(), [api]);
  const [framingJob, setFramingJob] = useState<string | null>(null);
  const [draftJobs, setDraftJobs] = useState<Record<string, string>>({});
  const [myStory, setMyStory] = useState<Outline['story'] | null>(null);
  const authorId = useId();

  const claimOptions = useMemo(() => [...new Set([...(panels.data?.claims.map((c) => c.claimId) ?? []), ...(server?.claimFigures.map((c) => c.claimId) ?? [])])].filter(Boolean), [panels.data, server]);
  const figureOptions = useMemo(() => [...new Set(panels.data?.figures.map((f) => f.figureId) ?? [])], [panels.data]);

  const save = useAction(async (o: Outline) => {
    const saved = await api.saveOutline(o);
    setOutline(saved);
    wc.accept(saved);
    return saved;
  });

  const ghostMode = useAction(async (sectionId: string, mode: GhostMode) => {
    const base = wc.applyBoth((o) => {
      const s = o.sections.find((x) => x.id === sectionId);
      if (s) s.ghostMode = mode;
    });
    if (!base) return;
    const saved = await api.saveOutline(base);
    setOutline(saved);
    wc.setBase(saved);
  });

  const framings = useAction(async () => {
    if (wc.dirty && wc.draft && !(await save.run(wc.draft))) return;
    const { jobId } = await api.framings();
    setFramingJob(jobId);
  });

  const draft = useAction(async (sectionId: string, fromNotes: boolean) => {
    if (wc.dirty && wc.draft && !(await save.run(wc.draft))) return;
    if (!file) throw new Error(t('editor.noFile'));
    // Anchor after the section's last prose sentence (never inside a figure, table or footnote).
    const prose = units.filter((u) => u.sectionId === sectionId && u.kind === 'prose');
    const { jobId } = await api.draft({ sectionId, paragraphIds: null, fromNotes, file, afterSentenceId: prose[prose.length - 1]?.id ?? null });
    setDraftJobs((m) => ({ ...m, [sectionId]: jobId }));
  });

  const o = wc.draft;
  if (!o) {
    return (
      <div className="panel">
        <PanelHeader title={t('outline.title')} />
        <div className="panel-body">
          <EmptyState>{t('outline.notLoaded')}</EmptyState>
        </div>
      </div>
    );
  }
  const canAttest = o.story.text.trim().length > 0;
  const fj = framingJob ? (jobs[framingJob] ?? null) : null;
  const framingActive = isJobActive(fj) || framings.busy;

  return (
    <div className="panel">
      <PanelHeader
        title={t('outline.title')}
        subtitle={t('outline.intro')}
        actions={
          <>
            <span className={`save-state${wc.dirty ? ' is-dirty' : ''}`} aria-live="polite">
              {save.busy ? t('common.saving') : wc.dirty ? t('common.unsaved') : t('common.saved')}
            </span>
            <Button size="sm" variant={wc.dirty ? 'primary' : 'default'} disabled={!wc.dirty} busy={save.busy} onClick={() => void save.run(o)}>
              {t('common.save')}
            </Button>
          </>
        }
      />
      <div className="panel-body">
        {wc.incoming ? (
          <div className="banner" role="status">
            <span>{t('outline.serverChanged')}</span>
            <Button size="sm" onClick={() => wc.incoming && wc.accept(wc.incoming)}>
              {t('outline.reload')}
            </Button>
          </div>
        ) : null}
        <InlineError message={save.error ? t('outline.saveFailed', { msg: save.error }) : null} />

        <PanelSection title={t('outline.step0')}>
          <FiveItems o={o} edit={wc.edit} facts={facts} claimOptions={claimOptions} figureOptions={figureOptions} />
          <div className="attest">
            <label className="check check-lg" htmlFor={authorId}>
              <input
                id={authorId}
                type="checkbox"
                checked={o.authorFilled}
                disabled={!canAttest && !o.authorFilled}
                onChange={(e) =>
                  wc.edit((x) => {
                    x.authorFilled = e.target.checked;
                  })
                }
              />
              <span>{t('outline.authorFilled')}</span>
            </label>
            {!canAttest && !o.authorFilled ? <p className="muted small">{t('outline.authorFilledHint')}</p> : null}
            <p className="muted small">{t('outline.antiAnchor')}</p>
            <Button icon={<IconSparkle size={14} />} disabled={!o.authorFilled || framingActive} busy={framingActive} onClick={() => void framings.run()}>
              {t('outline.proposeFramings')}
            </Button>
          </div>
        </PanelSection>

        {o.framings.length ? (
          <PanelSection title={t('outline.framings')} count={o.framings.length}>
            <ul className="framings">
              {o.framings.map((f) => (
                <li key={f.id} className={`framing${f.adopted ? ' is-adopted' : ''}`}>
                  <p>{f.text}</p>
                  <div className="framing-foot">
                    <ProvTag provenance={f.provenance} />
                    {f.adopted ? (
                      <>
                        <Badge tone="ok">{t('outline.adopted')}</Badge>
                        {myStory ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              const prev = myStory;
                              wc.edit((x) => {
                                x.story = prev;
                                x.framings.forEach((y) => (y.adopted = false));
                              });
                              setMyStory(null);
                            }}
                          >
                            {t('outline.restoreStory')}
                          </Button>
                        ) : null}
                      </>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => {
                          if (!myStory) setMyStory(structuredClone(o.story));
                          wc.edit((x) => {
                            x.framings.forEach((y) => (y.adopted = y.id === f.id));
                            x.story = { text: f.text, keyPhrase: x.story.keyPhrase, provenance: 'ai-proposed' };
                          });
                        }}
                      >
                        {t('outline.adopt')}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </PanelSection>
        ) : null}

        <PanelSection title={t('outline.sections')} count={o.sections.length}>
          {o.sections.length === 0 ? <EmptyState>{t('outline.sectionsEmpty')}</EmptyState> : null}
          {o.sections.map((s, i) => (
            <SectionCard
              key={s.id}
              s={s}
              index={i}
              edit={wc.edit}
              claimOptions={claimOptions}
              onGhostMode={(m) => void ghostMode.run(s.id, m)}
              onDraft={(fromNotes) => void draft.run(s.id, fromNotes)}
              drafting={draft.busy}
              authorFilled={o.authorFilled}
              draftJob={draftJobs[s.id] ? (jobs[draftJobs[s.id]!] ?? null) : null}
            />
          ))}
        </PanelSection>
      </div>
    </div>
  );
}
