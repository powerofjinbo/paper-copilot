/**
 * ④ Check & submit: the one-click submission check on top (blockers first, each expandable to the
 * sentences it concerns), then collapsible sections: Consistency, Terminology, Figure plan, AI-use
 * disclosure, and Sync with Overleaf (pull report; push check + push with a message, disabled with a
 * reason while blockers remain).
 */
import type { ApiClient } from '../contracts';
import { PanelHeader, PanelSection } from '../components/ui';
import { useT } from '../i18n';
import { ConsistencySection, FigurePlanSection, TerminologySection } from './check/Reports';
import { SubmissionCheck } from './check/Submission';
import { SyncPanel } from './SyncPanel';

export function CheckPanel({ api }: { api: ApiClient }) {
  const t = useT();
  return (
    <div className="panel step-panel">
      <PanelHeader title={t('check.title')} subtitle={t('step.checkHint')} />
      <div className="panel-body">
        <SubmissionCheck api={api} />
        <ConsistencySection api={api} />
        <TerminologySection api={api} />
        <FigurePlanSection api={api} />
        <SyncPanel api={api} parts={['disclosure']} />
        <PanelSection title={t('check.sync')} focusId="sync" defaultOpen={false} className="sync-group">
          <SyncPanel api={api} parts={['pull', 'push']} />
        </PanelSection>
      </div>
    </div>
  );
}
