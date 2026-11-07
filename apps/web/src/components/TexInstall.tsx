/**
 * "LaTeX is not installed": how to tell (the server's compile error says "latexmk was not found on PATH")
 * and how to install it, short, in the UI language, this OS first (the compile bar, the compile pill's
 * popover and the PDF pane show the same lines).
 */
import type { ReactNode } from 'react';
import { useT, type MsgKey } from '../i18n';
import { IS_MAC } from '../editor/labels';

export const NO_TEX = /latexmk[^\n]*not found|not found on PATH|command not found: (latexmk|pdflatex)|ENOENT[^\n]*(latexmk|pdflatex)|install TeX Live/i;

export function isNoTex(compile: { state: string; errors: ReadonlyArray<{ message: string }>; logTail: string }): boolean {
  if (compile.state !== 'error') return false;
  return compile.errors.some((e) => NO_TEX.test(e.message)) || NO_TEX.test(compile.logTail);
}

/** The install lines for this platform first (a Mac shows the MacTeX line first, anything else Linux first). */
export function texInstallKeys(mac: boolean = IS_MAC): MsgKey[] {
  return mac ? ['tex.installMac', 'tex.installLinux', 'tex.installThen'] : ['tex.installLinux', 'tex.installMac', 'tex.installThen'];
}

/** `code` spans of our own strings as <code>. */
export function withCode(text: string): ReactNode[] {
  return text.split(/`([^`]+)`/).map((p, i) => (i % 2 ? <code key={i} className="mono tex-cmd">{p}</code> : p));
}

export function TexInstallHint({ className, title = true }: { className?: string; title?: boolean }) {
  const t = useT();
  return (
    <div className={`tex-install${className ? ` ${className}` : ''}`} data-testid="tex-install">
      {title ? <p className="tex-install-title">{t('tex.missingTitle')}</p> : null}
      <ul className="tex-install-list">
        {texInstallKeys().map((k) => (
          <li key={k}>{withCode(t(k))}</li>
        ))}
      </ul>
    </div>
  );
}
