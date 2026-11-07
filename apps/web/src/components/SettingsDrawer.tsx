/**
 * Settings drawer (top bar ⚙): language, theme, editor display (ownership heatmap, monospace font, the
 * PDF pane), the API cost of this session, and the author's voice (memo, corpus with unassisted toggles,
 * style-distance meter). A modal dialog: Escape or the backdrop closes it; focus returns to ⚙.
 */
import { useEffect, useRef } from 'react';
import type { ApiClient } from '../contracts';
import { useEditorUi } from '../editor/uiStore';
import { htmlLang, useT } from '../i18n';
import { VoicePanel } from '../panels/VoicePanel';
import { useShell, type ThemePref } from '../state/extra';
import { useWorkspace } from '../state/store';
import { IconClose } from './Icons';
import { IconButton } from './ui';

function CostLine() {
  const t = useT();
  const cost = useWorkspace((s) => s.cost);
  const fake = useShell((s) => s.fakeLlm) ?? false;
  const usd = cost?.usd ?? 0;
  const n = cost?.requests ?? 0;
  const text = usd < 10 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(1)}`;
  const routes = cost ? Object.entries(cost.byRoute).map(([k, v]) => `${k} $${v.toFixed(3)}`) : [];
  return (
    <div className="settings-cost" data-testid="settings-cost">
      <span className="cost-usd">{text}</span>
      <span className="muted small">{fake ? t('cost.simulatedTitle', { n }) : t('settings.costLine', { usd: text, n })}</span>
      {routes.length && !fake ? <span className="muted small mono">{routes.join(' · ')}</span> : null}
    </div>
  );
}

export function SettingsDrawer({ api }: { api: ApiClient }) {
  const t = useT();
  const open = useShell((s) => s.settingsOpen);
  const setOpen = useShell((s) => s.setSettingsOpen);
  const lang = useShell((s) => s.lang);
  const setLang = useShell((s) => s.setLang);
  const theme = useShell((s) => s.theme);
  const setTheme = useShell((s) => s.setTheme);
  const firstRunDone = useShell((s) => s.firstRunDone);
  const heatmap = useEditorUi((s) => s.heatmap);
  const setHeatmap = useEditorUi((s) => s.setHeatmap);
  const mono = useEditorUi((s) => s.mono);
  const toggleMono = useEditorUi((s) => s.toggleMono);
  const rightPane = useWorkspace((s) => s.rightPane);
  const setRightPane = useWorkspace((s) => s.setRightPane);
  const panelRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>('button, select, input')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      returnTo.current?.focus?.();
    };
  }, [open, setOpen]);

  if (!open) return null;
  return (
    <div className="drawer-root" lang={htmlLang(lang)}>
      <div className="drawer-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
      <div className="drawer" role="dialog" aria-modal="true" aria-labelledby="settings-title" ref={panelRef} data-testid="settings-drawer">
        <header className="drawer-head">
          <h2 id="settings-title" className="drawer-title">
            {t('settings.title')}
          </h2>
          <IconButton label={t('settings.close')} icon={<IconClose />} onClick={() => setOpen(false)} />
        </header>
        <div className="drawer-body">
          <section className="settings-group" aria-labelledby="settings-look">
            <h3 id="settings-look" className="settings-h">
              {t('settings.appearance')}
            </h3>
            <div className="settings-row">
              <span className="settings-label">{t('settings.language')}</span>
              <div className="segmented" role="group" aria-label={t('lang.label')}>
                <button type="button" aria-pressed={lang === 'en'} onClick={() => setLang('en')} lang="en">
                  EN
                </button>
                <button type="button" aria-pressed={lang === 'zh'} onClick={() => setLang('zh')} lang="zh-CN">
                  中文
                </button>
              </div>
            </div>
            <div className="settings-row">
              <span className="settings-label">{t('settings.theme')}</span>
              <div className="segmented" role="group" aria-label={t('settings.theme')}>
                {(['system', 'light', 'dark'] as ThemePref[]).map((m) => (
                  <button key={m} type="button" aria-pressed={theme === m} onClick={() => setTheme(m)}>
                    {t(`theme.${m}`)}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="settings-group" aria-labelledby="settings-editor">
            <h3 id="settings-editor" className="settings-h">
              {t('settings.editor')}
            </h3>
            <label className="settings-check">
              <input type="checkbox" checked={heatmap} onChange={(e) => setHeatmap(e.target.checked)} />
              <span>
                {t('settings.heatmap')}
                <span className="muted small settings-hint">{t('settings.heatmapHint')}</span>
              </span>
            </label>
            <label className="settings-check">
              <input type="checkbox" checked={mono} onChange={toggleMono} />
              <span>{t('settings.mono')}</span>
            </label>
            <label className="settings-check">
              <input
                type="checkbox"
                checked={rightPane === 'pdf'}
                onChange={(e) => {
                  useShell.getState().pinPdf(e.target.checked);
                  setRightPane(e.target.checked ? 'pdf' : 'none');
                }}
              />
              <span>{t('settings.pdf')}</span>
            </label>
            {firstRunDone ? (
              <button type="button" className="link-btn small" onClick={() => useShell.setState({ firstRunDone: false })}>
                {t('settings.intro')}
              </button>
            ) : null}
          </section>

          <section className="settings-group" aria-labelledby="settings-cost">
            <h3 id="settings-cost" className="settings-h">
              {t('settings.cost')}
            </h3>
            <CostLine />
          </section>

          <section className="settings-group settings-voice" aria-labelledby="settings-voice">
            <h3 id="settings-voice" className="settings-h">
              {t('settings.voice')}
            </h3>
            <p className="muted small">{t('voice.intro')}</p>
            <VoicePanel api={api} embedded />
          </section>
        </div>
      </div>
    </div>
  );
}
