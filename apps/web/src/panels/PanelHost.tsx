/** The left column: the active panel as the tabpanel of the rail's tab list. */
import type { ApiClient, LeftTab } from '../contracts';
import { panelId, tabId } from '../components/LeftRail';
import { htmlLang } from '../i18n';
import { useShell } from '../state/extra';
import { useWorkspace } from '../state/store';
import { FactsPanel } from './FactsPanel';
import { OutlinePanel } from './OutlinePanel';
import { PlaceholdersPanel } from './PlaceholdersPanel';
import { QuestionsPanel } from './QuestionsPanel';
import { ReviewPanel } from './ReviewPanel';
import { SyncPanel } from './SyncPanel';
import { VoicePanel } from './VoicePanel';

function PanelFor({ tab, api }: { tab: LeftTab; api: ApiClient }) {
  switch (tab) {
    case 'outline':
      return <OutlinePanel api={api} />;
    case 'facts':
      return <FactsPanel api={api} />;
    case 'review':
      return <ReviewPanel api={api} />;
    case 'placeholders':
      return <PlaceholdersPanel />;
    case 'questions':
      return <QuestionsPanel api={api} />;
    case 'voice':
      return <VoicePanel api={api} />;
    case 'sync':
      return <SyncPanel api={api} />;
  }
}

export function PanelHost({ api }: { api: ApiClient }) {
  const tab = useWorkspace((s) => s.leftTab);
  const lang = useShell((s) => s.lang);
  return (
    <div className="panel-host" role="tabpanel" id={panelId(tab)} aria-labelledby={tabId(tab)} lang={htmlLang(lang)} tabIndex={-1}>
      <PanelFor key={tab} tab={tab} api={api} />
    </div>
  );
}
