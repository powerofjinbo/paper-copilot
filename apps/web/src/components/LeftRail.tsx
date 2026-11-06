/**
 * Left rail: a vertical tab list of the panels (icons + labels). Arrow keys move between tabs
 * (roving tabindex, automatic activation); clicking the active tab collapses or expands the panel.
 */
import { useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { LeftTab } from '../contracts';
import { htmlLang, useT, type MsgKey } from '../i18n';
import { useShell } from '../state/extra';
import { useWorkspace } from '../state/store';
import { IconChevronLeft, IconChevronRight, IconFacts, IconOutline, IconPlaceholder, IconQuestion, IconReview, IconSync, IconVoice } from './Icons';

export const TABS: Array<{ id: LeftTab; label: MsgKey; icon: ReactNode }> = [
  { id: 'outline', label: 'tab.outline', icon: <IconOutline size={18} /> },
  { id: 'facts', label: 'tab.facts', icon: <IconFacts size={18} /> },
  { id: 'review', label: 'tab.review', icon: <IconReview size={18} /> },
  { id: 'placeholders', label: 'tab.placeholders', icon: <IconPlaceholder size={18} /> },
  { id: 'questions', label: 'tab.questions', icon: <IconQuestion size={18} /> },
  { id: 'voice', label: 'tab.voice', icon: <IconVoice size={18} /> },
  { id: 'sync', label: 'tab.sync', icon: <IconSync size={18} /> },
];

export function tabId(t: LeftTab): string {
  return `rail-tab-${t}`;
}
export function panelId(t: LeftTab): string {
  return `rail-panel-${t}`;
}

/** Counts shown as badges: what still needs the author. */
function useBadges(): Partial<Record<LeftTab, number>> {
  const units = useWorkspace((s) => s.units);
  const unresolved = useWorkspace((s) => s.unresolved);
  const questions = useWorkspace((s) => s.questions);
  return useMemo(() => {
    let review = 0;
    let ph = 0;
    for (const u of units) {
      if (u.state === 'proposed' || u.state === 'unsupported') review++;
      ph += u.placeholders.length;
    }
    return { review, placeholders: ph, facts: unresolved.length, questions: questions.length };
  }, [units, unresolved, questions]);
}

export function LeftRail() {
  const t = useT();
  const lang = useShell((s) => s.lang);
  const active = useWorkspace((s) => s.leftTab);
  const setLeftTab = useWorkspace((s) => s.setLeftTab);
  // collapsed by the user, or hidden for now to leave the editor a readable column
  const collapsed = useShell((s) => s.leftCollapsed || s.fitHidden.left);
  const setCollapsed = useShell((s) => s.setLeftCollapsed);
  const badges = useBadges();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const select = (id: LeftTab, focus = false) => {
    setLeftTab(id);
    if (collapsed) setCollapsed(false);
    if (focus) refs.current[TABS.findIndex((x) => x.id === id)]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((x) => x.id === active);
    let next = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (i + 1) % TABS.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next >= 0) {
      e.preventDefault();
      select(TABS[next]!.id, true);
    }
  };

  return (
    <nav className="rail" lang={htmlLang(lang)} aria-label={t('tab.list')}>
      <div role="tablist" aria-orientation="vertical" aria-label={t('tab.list')} className="rail-tabs" onKeyDown={onKeyDown}>
        {TABS.map((tab, i) => {
          const selected = tab.id === active;
          const n = badges[tab.id] ?? 0;
          const label = t(tab.label);
          return (
            <button
              key={tab.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              id={tabId(tab.id)}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={panelId(tab.id)}
              aria-expanded={selected ? !collapsed : undefined}
              aria-label={n > 0 ? t('tab.badge', { label, n }) : label}
              title={label}
              tabIndex={selected ? 0 : -1}
              className={`rail-tab${selected ? ' is-active' : ''}${selected && collapsed ? ' is-collapsed' : ''}`}
              onClick={() => {
                if (selected) setCollapsed(!collapsed);
                else select(tab.id);
              }}
            >
              <span className="rail-icon">
                {tab.icon}
                {n > 0 ? (
                  <span className="rail-badge" aria-hidden="true">
                    {n > 99 ? '99+' : n}
                  </span>
                ) : null}
              </span>
              <span className="rail-label">{label}</span>
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
