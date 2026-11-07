/**
 * Left rail: the four steps of writing a paper, in order (① Plan, ② Sources, ③ To do, ④ Check &
 * submit), each with its number, icon, label and a count badge where useful. Arrow keys move between
 * steps (roving tabindex, automatic activation); clicking the active step collapses or expands the panel.
 * Voice, language, theme, the ownership heatmap and the cost meter live in the Settings drawer (top bar ⚙).
 */
import { useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { LeftStep } from '../contracts';
import { htmlLang, useT, type MsgKey } from '../i18n';
import { useShell } from '../state/extra';
import { useWorkspace } from '../state/store';
import { IconChevronLeft, IconChevronRight, IconPlan, IconShieldCheck, IconSources, IconTodo } from './Icons';
import { STEPS, openTodoCount, stepOf, submissionStatus } from './steps';

export const STEP_META: Record<LeftStep, { n: number; label: MsgKey; title: MsgKey; hint: MsgKey; icon: ReactNode }> = {
  plan: { n: 1, label: 'step.plan', title: 'step.planTitle', hint: 'step.planHint', icon: <IconPlan size={18} /> },
  sources: { n: 2, label: 'step.sources', title: 'step.sourcesTitle', hint: 'step.sourcesHint', icon: <IconSources size={18} /> },
  todo: { n: 3, label: 'step.todo', title: 'step.todoTitle', hint: 'step.todoHint', icon: <IconTodo size={18} /> },
  check: { n: 4, label: 'step.check', title: 'step.checkTitle', hint: 'step.checkHint', icon: <IconShieldCheck size={18} /> },
};

/** Kept for older imports: the rail's entries. */
export const TABS = STEPS.map((id) => ({ id, label: STEP_META[id].label, icon: STEP_META[id].icon }));

export function tabId(t: LeftStep): string {
  return `rail-tab-${t}`;
}
export function panelId(t: LeftStep): string {
  return `rail-panel-${t}`;
}

/** Counts shown as badges: what still needs the author (② unresolved numerals, ③ open items, ④ failing checks). */
function useBadges(): Partial<Record<LeftStep, { n: number; tone: 'accent' | 'warn' | 'danger' }>> {
  const units = useWorkspace((s) => s.units);
  const unresolved = useWorkspace((s) => s.unresolved);
  const submission = useShell((s) => s.submission);
  return useMemo(() => {
    const st = submissionStatus(submission);
    return {
      sources: { n: unresolved.length, tone: 'warn' },
      todo: { n: openTodoCount(units), tone: 'accent' },
      check: { n: st.issues, tone: st.blockers ? 'danger' : 'warn' },
    };
  }, [units, unresolved, submission]);
}

export function LeftRail() {
  const t = useT();
  const lang = useShell((s) => s.lang);
  const active = stepOf(useWorkspace((s) => s.leftTab)) ?? 'plan';
  const setLeftTab = useWorkspace((s) => s.setLeftTab);
  // collapsed by the user, or hidden for now to leave the editor a readable column
  const collapsed = useShell((s) => s.leftCollapsed || s.fitHidden.left);
  const setCollapsed = useShell((s) => s.setLeftCollapsed);
  const badges = useBadges();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const select = (id: LeftStep, focus = false) => {
    setLeftTab(id);
    if (collapsed) setCollapsed(false);
    if (focus) refs.current[STEPS.indexOf(id)]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = STEPS.indexOf(active);
    let next = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (i + 1) % STEPS.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (i - 1 + STEPS.length) % STEPS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = STEPS.length - 1;
    if (next >= 0) {
      e.preventDefault();
      select(STEPS[next]!, true);
    }
  };

  return (
    <nav className="rail" lang={htmlLang(lang)} aria-label={t('rail.label')}>
      <div role="tablist" aria-orientation="vertical" aria-label={t('rail.label')} className="rail-tabs" onKeyDown={onKeyDown}>
        {STEPS.map((id, i) => {
          const meta = STEP_META[id];
          const selected = id === active;
          const badge = badges[id];
          const n = badge?.n ?? 0;
          const label = t(meta.label);
          const aria = n > 0 ? t('step.ariaBadge', { n: meta.n, label: t(meta.title), count: n }) : t('step.aria', { n: meta.n, label: t(meta.title) });
          return (
            <button
              key={id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              id={tabId(id)}
              role="tab"
              type="button"
              data-step={id}
              aria-selected={selected}
              aria-controls={panelId(id)}
              aria-label={aria}
              title={`${t(meta.title)} — ${t(meta.hint)}`}
              tabIndex={selected ? 0 : -1}
              className={`rail-tab${selected ? ' is-active' : ''}${selected && collapsed ? ' is-collapsed' : ''}`}
              onClick={() => {
                // a step button only selects and opens (the first click on ① must not hide the plan the
                // intro points to); the « button at the rail foot collapses the panel
                select(id);
              }}
            >
              <span className="rail-icon">
                {meta.icon}
                {n > 0 ? (
                  <span className={`rail-badge rail-badge-${badge!.tone}`} aria-hidden="true">
                    {n > 99 ? '99+' : n}
                  </span>
                ) : null}
              </span>
              <span className="rail-label">
                <span className="rail-num" aria-hidden="true">
                  {meta.n}
                </span>
                {label}
              </span>
            </button>
          );
        })}
      </div>
      <div className="rail-foot">
        <button
          type="button"
          className="icon-btn rail-collapse"
          aria-label={collapsed ? t('panel.expand') : t('panel.collapse')}
          title={collapsed ? t('panel.expand') : t('panel.collapse')}
          aria-expanded={!collapsed}
          aria-controls={collapsed ? undefined : panelId(active)}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? <IconChevronRight /> : <IconChevronLeft />}
        </button>
      </div>
    </nav>
  );
}
