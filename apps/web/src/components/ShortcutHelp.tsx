/**
 * Keyboard-shortcut overlay: "?" (outside text), Ctrl/Cmd+/ (outside the editor), F1, or the "?" button
 * in the status bar. Lists every binding of editor/keymap.ts paperKeymap and App.useShortcuts in the UI
 * language, with ⌘/⌥ on macOS and Ctrl/Alt elsewhere (review finding UX-4: the ghost key was named
 * nowhere, and its Ctrl+Space default is taken by macOS and the Chinese IMEs).
 */
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { ALT_KEY, GHOST_KEY, GHOST_KEY_ALT, MOD_KEY } from '../editor/labels';
import { htmlLang, useT, type MsgKey } from '../i18n';
import { useShell } from '../state/extra';

interface Row {
  keys: string[];
  label: MsgKey;
}

const M = MOD_KEY;
const A = ALT_KEY;

const GROUPS: Array<{ title: MsgKey; rows: Row[] }> = [
  {
    title: 'help.ghost',
    rows: [
      { keys: [GHOST_KEY, ...GHOST_KEY_ALT.split(' · ')], label: 'help.ghostRequest' },
      { keys: ['Tab'], label: 'help.ghostAccept' },
      { keys: [`${M}+→`], label: 'help.ghostWord' },
      { keys: ['Esc'], label: 'help.ghostDismiss' },
    ],
  },
  {
    title: 'help.review',
    rows: [
      { keys: [`${A}+↓`, `${A}+↑`], label: 'help.reviewNext' },
      { keys: [`${M}+Enter`], label: 'help.reviewAccept' },
      { keys: [`${M}+.`], label: 'help.card' },
      { keys: [`${M}+I`], label: 'help.instruct' },
      { keys: [`${M}+G`], label: 'help.grammar' },
    ],
  },
  {
    // the letter keys of the sentence card (open it with a click or {mod}+.; the focus must be in the card)
    title: 'help.cardKeys',
    rows: [
      { keys: ['L'], label: 'help.cardAlternatives' },
      { keys: ['R'], label: 'help.cardRewrite' },
      { keys: ['X'], label: 'help.cardReject' },
      { keys: ['H'], label: 'help.cardHistory' },
      { keys: ['A'], label: 'help.cardApply' },
      { keys: ['1–9'], label: 'help.cardPick' },
    ],
  },
  {
    title: 'help.notes',
    rows: [
      { keys: [`${M}+Enter`], label: 'help.noteRender' },
      { keys: [`${A}+Enter`], label: 'help.note3' },
      { keys: ['1', '2', '3', 'Tab'], label: 'help.notePick' },
    ],
  },
  {
    title: 'help.document',
    rows: [
      { keys: [`${M}+S`], label: 'help.save' },
      { keys: [`${M}+Shift+J`], label: 'help.forward' },
      { keys: [`${M}+${A}+O`], label: 'help.heatmap' },
      { keys: [`${M}+F`], label: 'help.find' },
      { keys: [`${M}+Z`], label: 'help.undo' },
      { keys: ['?', 'F1'], label: 'help.this' },
    ],
  },
];

function Keys({ keys }: { keys: string[] }): ReactNode {
  return (
    <span className="help-keys">
      {keys.map((k, i) => (
        <span key={k}>
          {i > 0 ? <span className="help-or"> / </span> : null}
          <kbd className="kbd">{k}</kbd>
        </span>
      ))}
    </span>
  );
}

export function ShortcutHelp() {
  const t = useT();
  const lang = useShell((s) => s.lang);
  const open = useShell((s) => s.helpOpen);
  const setOpen = useShell((s) => s.setHelpOpen);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      const el = returnTo.current as HTMLElement | null;
      if (el && typeof el.focus === 'function' && document.contains(el)) el.focus();
    };
  }, [open, setOpen]);

  if (!open) return null;
  return (
    <div className="help-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="help-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} lang={htmlLang(lang)}>
        <div className="help-head">
          <h2 id={titleId}>{t('help.title')}</h2>
          <button ref={closeRef} type="button" className="icon-btn" aria-label={t('common.close')} title={`${t('common.close')} (Esc)`} onClick={() => setOpen(false)}>
            ×
          </button>
        </div>
        <p className="help-note">{t('help.ghostNote')}</p>
        <div className="help-grid">
          {GROUPS.map((g) => (
            <section key={g.title} className="help-group">
              <h3>{t(g.title)}</h3>
              <dl>
                {g.rows.map((r) => (
                  <div key={r.label} className="help-row">
                    <dt>
                      <Keys keys={r.keys} />
                    </dt>
                    <dd>{t(r.label)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
