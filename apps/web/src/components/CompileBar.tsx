/**
 * Compile problems above the editor: after a failed compile (a LaTeX error, latexmk missing) the reason is
 * on screen next to the text, with file:line links, a hint when TeX itself is missing (a Mac with BasicTeX
 * has no latexmk), and the log on demand. It stays until the next compile or until dismissed, whether or
 * not the PDF pane is open (on a laptop the pane is often hidden to keep the editor readable).
 */
import { useState } from 'react';
import { useT } from '../i18n';
import { useWorkspace } from '../state/store';
import { revealLine } from './actions';

const MAX_SHOWN = 3;
const NO_TEX = /latexmk[^\n]*not found|not found on PATH|command not found: (latexmk|pdflatex)|ENOENT[^\n]*(latexmk|pdflatex)|install TeX Live/i;

export function CompileBar() {
  const t = useT();
  const compile = useWorkspace((s) => s.compile);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  if (compile.state !== 'error' && compile.errors.length === 0) return null;
  if (compile.state === 'running') return null;
  const key = JSON.stringify([compile.state, compile.errors, compile.logTail.length]);
  if (dismissed === key) return null;
  const noTex = compile.errors.some((e) => NO_TEX.test(e.message)) || NO_TEX.test(compile.logTail);
  const shown = compile.errors.slice(0, MAX_SHOWN);
  const more = compile.errors.length - shown.length;
  return (
    <section className={`compile-bar${compile.state === 'error' ? '' : ' is-warn'}`} role="alert" data-testid="compile-bar">
      <div className="compile-bar-head">
        <span className="compile-bar-title">{compile.state === 'error' ? t('compileBar.failed') : t('compileBar.withPdf')}</span>
        <span className="compile-bar-spacer" />
        {compile.logTail ? (
          <button type="button" className="link-btn small" aria-expanded={showLog} onClick={() => setShowLog(!showLog)}>
            {showLog ? t('compileBar.hideLog') : t('compileBar.showLog')}
          </button>
        ) : null}
        <button type="button" className="link-btn small" onClick={() => setDismissed(key)}>
          {t('compileBar.dismiss')}
        </button>
      </div>
      {shown.length ? (
        <ul className="compile-bar-list">
          {shown.map((e, i) => (
            <li key={i}>
              {e.line !== null ? (
                <button type="button" className="link-btn compile-bar-loc" onClick={() => revealLine(e.line!, e.file)}>
                  {e.file}:{e.line}
                </button>
              ) : (
                <span className="compile-bar-loc">{e.file}</span>
              )}
              <span>{e.message}</span>
            </li>
          ))}
          {more > 0 ? <li className="muted small">{t('compileBar.more', { n: more })}</li> : null}
        </ul>
      ) : null}
      {noTex ? <p className="compile-bar-hint">{t('compileBar.noTex')}</p> : null}
      {showLog && compile.logTail ? <pre className="compile-bar-log">{compile.logTail.slice(-4000)}</pre> : null}
    </section>
  );
}
