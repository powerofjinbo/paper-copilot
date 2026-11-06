/**
 * The CodeMirror 6 editor that makes the sentence the unit of writing, review and provenance.
 * See controller.ts for the extension stack and the EditorHandle implementation.
 */
import { useEffect, useRef, useState } from 'react';
import type { EditorProps } from '../contracts';
import { useWorkspace } from '../state/store';
import { EditorController } from './controller';
import { ALT_KEY, STATE_ORDER } from './labels';
import { stateShort, useEdT } from './i18n';
import { reviewQueueOf } from './safe';
import { useEditorUi } from './uiStore';
import './editor.css';

export function Editor(props: EditorProps) {
  const { api, file } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const onReadyRef = useRef(props.onReady);
  onReadyRef.current = props.onReady;
  const [status, setStatus] = useState<'loading' | 'ready'>('loading');
  const [online, setOnline] = useState(api.connected);
  const [live, setLive] = useState('');
  const heatmap = useEditorUi((s) => s.heatmap);
  const toggleHeatmap = useEditorUi((s) => s.toggleHeatmap);
  const mono = useEditorUi((s) => s.mono);
  const toggleMono = useEditorUi((s) => s.toggleMono);
  const { t, lang } = useEdT();
  const toReview = useWorkspace((s) => (s.file === null || s.file === file ? reviewQueueOf(s.units).length : 0));

  useEffect(() => {
    const parent = hostRef.current;
    if (!parent) return;
    setStatus('loading');
    let seq = 0;
    const ctrl = new EditorController({
      parent,
      api,
      file,
      onStatus: setStatus,
      // alternate a zero-width suffix so repeating the same message is announced again
      announce: (m) => setLive(m + (seq++ % 2 ? '​' : '')),
    });
    const offConn = api.onConnection(setOnline);
    setOnline(api.connected);
    onReadyRef.current(ctrl.handle);
    return () => {
      offConn();
      ctrl.destroy();
    };
  }, [api, file]);

  return (
    <div className={`pc-editor${heatmap ? ' pc-heatmap' : ''}`} data-status={status} data-font={mono ? 'mono' : 'prose'} data-testid="editor">
      <div className="pc-editor-bar">
        {!online ? (
          <span className="pc-offline" role="status">
            <span className="pc-offline-dot" aria-hidden="true" /> {t('offline')}
          </span>
        ) : null}
        {toReview > 0 ? (
          <span className="pc-bar-review">
            {t('toReview', { n: toReview })} · <kbd className="pc-kbd">{ALT_KEY}+↓</kbd>
          </span>
        ) : null}
        <span className="pc-bar-spacer" />
        {heatmap ? (
          <span className="pc-legend" aria-label={t('legend')}>
            {STATE_ORDER.filter((s) => s !== 'human').map((s) => (
              <span key={s} className="pc-legend-item">
                <span className={`pc-legend-swatch pc-s-${s}`} aria-hidden="true" />
                {stateShort(s, lang)}
              </span>
            ))}
          </span>
        ) : null}
        <button
          type="button"
          className="pc-toggle"
          aria-pressed={heatmap}
          aria-label={t('heatmapLabel')}
          title={t('heatmapTitle')}
          onClick={toggleHeatmap}
        >
          <span aria-hidden="true">◐</span> {t('heatmap')}
        </button>
        <button type="button" className="pc-toggle" aria-pressed={mono} title={t('monoTitle')} onClick={toggleMono}>
          {t('mono')}
        </button>
      </div>
      <div ref={hostRef} className="pc-editor-host" data-loading={t('opening')} />
      <div className="pc-sr-only" aria-live="polite" role="status">
        {live}
      </div>
    </div>
  );
}
