/**
 * ③ To do: ONE list of what waits for the author in the open file, grouped under small headers —
 * AI sentences to review (proposed / unsupported), placeholders, and the referee's questions — each
 * item one click from its sentence. Progress "x of y reviewed" on top; the other files' open items
 * (GET /api/files) below; "Ask the referee" per section at the end.
 */
import { useId, useMemo, useState } from 'react';
import { nextInQueue } from '@paper-copilot/client-core';
import type { SentenceUnit } from '@paper-copilot/core';
import type { ApiClient } from '../contracts';
import { acceptSentence, notify, rejectSentence, revealSentence, switchFile } from '../components/actions';
import { isJobActive, useAction, useUnitText } from '../components/hooks';
import { IconArrowDown, IconArrowUp, IconCheck, IconClose, IconFile, IconQuestion } from '../components/Icons';
import { safeReviewProgress } from '../components/StatusBar';
import { buildTodo, otherFileTodo, type TodoGroupKind, type TodoItem } from '../components/steps';
import { Button, EmptyState, Highlight, IconButton, PanelHeader, PanelSection, StateTag, displayLatex } from '../components/ui';
import { useT, type MsgKey } from '../i18n';
import { useShell } from '../state/extra';
import { useWorkspace } from '../state/store';
import { placeholderKind } from './PlaceholdersPanel';
import { useSectionList } from './QuestionsPanel';
import { useSectionTitles } from './ReviewPanel';

const GROUP_TITLE: Record<TodoGroupKind, MsgKey> = { review: 'todo.review', placeholders: 'todo.placeholders', questions: 'todo.questions' };
const GROUP_FOCUS: Record<TodoGroupKind, 'review' | 'placeholders' | 'questions'> = { review: 'review', placeholders: 'placeholders', questions: 'questions' };

export function TodoPanel({ api }: { api: ApiClient }) {
  const t = useT();
  const units = useWorkspace((s) => s.units);
  const file = useWorkspace((s) => s.file);
  const questions = useWorkspace((s) => s.questions);
  const activeId = useWorkspace((s) => s.activeSentenceId);
  const jobs = useWorkspace((s) => s.jobs);
  const files = useShell((s) => s.files);
  const textOf = useUnitText();
  const titleOf = useSectionTitles();
  const sections = useSectionList();
  const groups = useMemo(
    () =>
      buildTodo(
        units,
        questions,
        placeholderKind,
        sections.map((s) => s.id),
      ),
    [units, questions, sections],
  );
  const progress = useMemo(() => safeReviewProgress(units), [units]);
  const others = useMemo(() => otherFileTodo(files, file), [files, file]);
  const reviewQueue = groups[0]!.items;
  const [busy, setBusy] = useState<string | null>(null);
  const [askSection, setAskSection] = useState<string>('');
  const [jobBySection, setJobBySection] = useState<Record<string, string>>({});
  const askId = useId();
  const ask = useAction(async (sectionId: string) => {
    const { jobId } = await api.referee(sectionId);
    setJobBySection((m) => ({ ...m, [sectionId]: jobId }));
  });
  const chosen = askSection || sections[0]?.id || '';
  const askJob = jobBySection[chosen] ? (jobs[jobBySection[chosen]!] ?? null) : null;
  const asking = isJobActive(askJob);

  const jump = (dir: 1 | -1) => {
    const active = units.find((u) => u.id === activeId);
    const pos = active ? (dir === 1 ? active.end + 1 : Math.max(0, active.start - 1)) : 0;
    let next: SentenceUnit | null = null;
    try {
      next = nextInQueue(units, pos, dir);
    } catch {
      const q = reviewQueue.map((i) => (i as Extract<TodoItem, { kind: 'review' }>).unit);
      next = (dir === 1 ? q.find((u) => u.start >= pos) : [...q].reverse().find((u) => u.end <= pos)) ?? q[0] ?? null;
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

  const pct = progress.total ? Math.round((100 * progress.reviewed) / progress.total) : 0;
  const empty = groups.every((g) => g.items.length === 0);

  const renderItem = (item: TodoItem) => {
    if (item.kind === 'review') {
      const u = item.unit;
      const isActive = u.id === activeId;
      return (
        <li key={item.key} className={`todo-li review-li${isActive ? ' is-active' : ''}`}>
          <div className={`review-item state-${u.state}`}>
            <button type="button" className="review-main" onClick={() => revealSentence(u.id, true)} aria-current={isActive ? 'true' : undefined}>
              <span className="review-meta">
                <StateTag state={u.state} />
                <span className="muted tabular">{t('common.line', { n: u.line })}</span>
                <span className="todo-sec muted">{titleOf(u.sectionId)}</span>
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
    }
    if (item.kind === 'placeholder') {
      const u = item.unit;
      return (
        <li key={item.key} className="todo-li">
          <button type="button" className="list-row" onClick={() => revealSentence(u.id)}>
            <span className="list-row-top">
              <code className="ph-chip" title={item.placeholder}>
                {item.placeholder}
              </code>
              <span className="muted small">{t(`ph.kind.${item.phKind}` as MsgKey)}</span>
              <span className="muted tabular">{t('common.line', { n: u.line })}</span>
            </span>
            <span className="list-row-text">
              <Highlight text={displayLatex(textOf(u))} needle={item.placeholder} />
            </span>
          </button>
        </li>
      );
    }
    const q = item.question;
    return (
      <li key={item.key} className="todo-li question">
        <div className="todo-q-head muted small">{titleOf(q.sectionId)}</div>
        <p className="question-text">{q.question}</p>
        {q.estimate ? (
          <p className="question-estimate">
            <span className="question-estimate-label">{t('q.estimate')}</span> {q.estimate}
          </p>
        ) : null}
        {q.sentenceId ? (
          <button type="button" className="link-btn small" onClick={() => revealSentence(q.sentenceId!)}>
            {t('common.goToSentence')}
          </button>
        ) : null}
      </li>
    );
  };

  return (
    <div className="panel step-panel">
      <PanelHeader
        title={t('todo.title')}
        subtitle={t('todo.intro')}
        actions={
          <>
            <IconButton label={t('review.prev')} icon={<IconArrowUp />} onClick={() => jump(-1)} disabled={!reviewQueue.length} aria-keyshortcuts="Alt+ArrowUp" />
            <IconButton label={t('review.next')} icon={<IconArrowDown />} onClick={() => jump(1)} disabled={!reviewQueue.length} aria-keyshortcuts="Alt+ArrowDown" />
          </>
        }
      />
      <div className="panel-body">
        {progress.total > 0 ? (
          <div className="review-progress" data-testid="todo-progress">
            <div className="review-progress-row">
              <span>{t('todo.progress', { reviewed: progress.reviewed, total: progress.total })}</span>
              <span className="muted tabular">{pct}%</span>
            </div>
            <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.reviewed} aria-label={t('todo.progress', { reviewed: progress.reviewed, total: progress.total })}>
              <span style={{ width: `${pct}%` }} />
            </div>
          </div>
        ) : null}
        {reviewQueue.length ? <p className="kbd-hint">{t('review.keys')}</p> : null}
        {empty ? <EmptyState>{t('todo.empty')}</EmptyState> : null}
        {groups.map((g) =>
          g.items.length ? (
            <PanelSection key={g.kind} focusId={GROUP_FOCUS[g.kind]} className={`todo-group todo-${g.kind}`} title={t(GROUP_TITLE[g.kind])} count={g.items.length}>
              {g.kind === 'questions' ? <p className="muted small">{t('todo.questionsHint')}</p> : null}
              <ol className={g.kind === 'review' ? 'review-list' : 'plain-list'}>{g.items.map(renderItem)}</ol>
            </PanelSection>
          ) : null,
        )}

        {others.length ? (
          <PanelSection title={t('todo.otherFiles')} count={others.length}>
            <ul className="plain-list">
              {others.map((o) => (
                <li key={o.file}>
                  <button type="button" className="list-row" onClick={() => switchFile(o.file)} aria-label={t('todo.openFile', { file: o.file })}>
                    <span className="list-row-top">
                      <IconFile size={13} />
                      <code className="mono">{o.file}</code>
                    </span>
                    <span className="list-row-meta muted small">{t('todo.otherFile', { review: o.review, placeholders: o.placeholders })}</span>
                  </button>
                </li>
              ))}
            </ul>
          </PanelSection>
        ) : null}

        {sections.length ? (
          <div className="todo-ask" data-section="questions-ask">
            <label className="field-label" htmlFor={askId}>
              {t('todo.askSection')}
            </label>
            <div className="todo-ask-row">
              <select id={askId} className="select" value={chosen} onChange={(e) => setAskSection(e.target.value)}>
                {sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
              <Button size="sm" icon={<IconQuestion size={13} />} busy={asking || (ask.busy && !jobBySection[chosen])} disabled={!chosen} onClick={() => void ask.run(chosen)}>
                {asking ? t('q.asking') : t('q.ask')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
