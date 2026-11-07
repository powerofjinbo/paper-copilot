/**
 * ② Sources: everything AI text may draw on. Two sub-tabs: Facts (the fact store, unresolved numerals,
 * rescan, read repository) and Literature (bib keys with their INSPIRE status, confirm).
 */
import type { ApiClient } from '../contracts';
import { htmlLang, useT } from '../i18n';
import { useShell } from '../state/extra';
import { useWorkspace } from '../state/store';
import { FactsPanel } from './FactsPanel';
import { LiteraturePanel } from './LiteraturePanel';

export function SourcesPanel({ api }: { api: ApiClient }) {
  const t = useT();
  const lang = useShell((s) => s.lang);
  const tab = useShell((s) => s.sourcesTab);
  const setTab = useShell((s) => s.setSourcesTab);
  const unresolved = useWorkspace((s) => s.unresolved.length);
  return (
    <div className="panel step-panel" lang={htmlLang(lang)}>
      <div className="subtabs" role="tablist" aria-label={t('sources.tabs')}>
        <button type="button" role="tab" id="sources-tab-facts" aria-controls="sources-panel" aria-selected={tab === 'facts'} className="subtab" onClick={() => setTab('facts')}>
          {t('sources.facts')}
          {unresolved > 0 ? <span className="subtab-count is-warn">{unresolved}</span> : null}
        </button>
        <button type="button" role="tab" id="sources-tab-lit" aria-controls="sources-panel" aria-selected={tab === 'lit'} className="subtab" onClick={() => setTab('lit')}>
          {t('sources.lit')}
        </button>
      </div>
      <div className="subtab-panel" role="tabpanel" id="sources-panel" aria-labelledby={`sources-tab-${tab}`}>
        {tab === 'facts' ? <FactsPanel api={api} /> : <LiteraturePanel api={api} />}
      </div>
    </div>
  );
}
