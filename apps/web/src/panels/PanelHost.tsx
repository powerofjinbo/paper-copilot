/** The left column: the active step's panel as the tabpanel of the rail's tab list, with the first-run hint. */
import type { ApiClient, LeftStep } from '../contracts';
import { panelId, tabId } from '../components/LeftRail';
import { FirstRunHint } from '../components/FirstRunHint';
import { stepOf } from '../components/steps';
import { htmlLang } from '../i18n';
import { useShell } from '../state/extra';
import { useWorkspace } from '../state/store';
import { CheckPanel } from './CheckPanel';
import { OutlinePanel } from './OutlinePanel';
import { SourcesPanel } from './SourcesPanel';
import { TodoPanel } from './TodoPanel';

function PanelFor({ step, api }: { step: LeftStep; api: ApiClient }) {
  switch (step) {
    case 'plan':
      return <OutlinePanel api={api} />;
    case 'sources':
      return <SourcesPanel api={api} />;
    case 'todo':
      return <TodoPanel api={api} />;
    case 'check':
      return <CheckPanel api={api} />;
  }
}

export function PanelHost({ api }: { api: ApiClient }) {
  const step = stepOf(useWorkspace((s) => s.leftTab)) ?? 'plan';
  const lang = useShell((s) => s.lang);
  return (
    <div className="panel-host" role="tabpanel" id={panelId(step)} aria-labelledby={tabId(step)} lang={htmlLang(lang)} tabIndex={-1} data-step={step}>
      <FirstRunHint />
      <PanelFor key={step} step={step} api={api} />
    </div>
  );
}
