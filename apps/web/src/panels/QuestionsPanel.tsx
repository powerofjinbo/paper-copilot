/** Referee questions per section. They are notes for the author and are never inserted into the paper. */
import { useMemo, useState } from 'react';
import type { ApiClient } from '../contracts';
import { revealSentence } from '../components/actions';
import { isJobActive, useAction } from '../components/hooks';
import { IconQuestion } from '../components/Icons';
import { Button, EmptyState, PanelHeader, PanelSection } from '../components/ui';
import { useT } from '../i18n';
import { useWorkspace } from '../state/store';

export function useSectionList(): Array<{ id: string; title: string }> {
  const outline = useWorkspace((s) => s.outline);
  const units = useWorkspace((s) => s.units);
  return useMemo(() => {
    if (outline && outline.sections.length) return outline.sections.map((s) => ({ id: s.id, title: s.title || s.id }));
    const seen = new Set<string>();
    const out: Array<{ id: string; title: string }> = [];
    for (const u of units) {
      if (!seen.has(u.sectionId)) {
        seen.add(u.sectionId);
        out.push({ id: u.sectionId, title: u.sectionId });
      }
    }
    return out;
  }, [outline, units]);
}

export function QuestionsPanel({ api }: { api: ApiClient }) {
  const t = useT();
  const sections = useSectionList();
  const questions = useWorkspace((s) => s.questions);
  const jobs = useWorkspace((s) => s.jobs);
  const [jobBySection, setJobBySection] = useState<Record<string, string>>({});
  const ask = useAction(async (sectionId: string) => {
    const { jobId } = await api.referee(sectionId);
    setJobBySection((m) => ({ ...m, [sectionId]: jobId }));
  });

  const bySection = useMemo(() => {
    const m = new Map<string, typeof questions>();
    for (const q of questions) {
      const l = m.get(q.sectionId) ?? [];
      l.push(q);
      m.set(q.sectionId, l);
    }
    return m;
  }, [questions]);

  return (
    <div className="panel">
      <PanelHeader title={t('q.title')} subtitle={t('q.intro')} actions={questions.length ? <span className="count-pill">{t('q.count', { n: questions.length })}</span> : null} />
      <div className="panel-body">
        {sections.length === 0 ? <EmptyState>{t('q.noSections')}</EmptyState> : null}
        {sections.map((s) => {
          const qs = bySection.get(s.id) ?? [];
          const jobId = jobBySection[s.id];
          const job = jobId ? (jobs[jobId] ?? null) : null;
          const active = isJobActive(job);
          return (
            <PanelSection
              key={s.id}
              title={s.title}
              count={qs.length || undefined}
              actions={
                <Button size="sm" icon={<IconQuestion size={13} />} busy={active || (ask.busy && !jobId)} onClick={() => void ask.run(s.id)}>
                  {active ? t('q.asking') : t('q.ask')}
                </Button>
              }
            >
              {qs.length === 0 ? (
                <p className="muted small">{t('q.none')}</p>
              ) : (
                <ol className="question-list">
                  {qs.map((q) => (
                    <li key={q.id} className="question">
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
                  ))}
                </ol>
              )}
            </PanelSection>
          );
        })}
      </div>
    </div>
  );
}
