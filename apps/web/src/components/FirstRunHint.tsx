/** The first-run hint: the four-step flow, shown once at the top of the side panel (remembered in localStorage). */
import type { LeftStep } from '../contracts';
import { useT, type MsgKey } from '../i18n';
import { useShell } from '../state/extra';
import { openStep } from './actions';
import { STEPS } from './steps';
import { Button } from './ui';

const LINES: Record<LeftStep, MsgKey> = { plan: 'firstRun.plan', sources: 'firstRun.sources', todo: 'firstRun.todo', check: 'firstRun.check' };
const LABELS: Record<LeftStep, MsgKey> = { plan: 'step.planTitle', sources: 'step.sourcesTitle', todo: 'step.todoTitle', check: 'step.checkTitle' };
/** How to write with the AI: the interactions all happen in the editor, so the intro names them (Mac-aware keys). */
const EDITOR_LINES: readonly MsgKey[] = ['firstRun.editorClick', 'firstRun.editorGhost', 'firstRun.editorIntent', 'firstRun.editorReview', 'firstRun.editorCompile', 'firstRun.editorHelp'];

/** Key names in the (translated, our own) text, shown as <kbd>: ⌘+Enter, ⌥/, ⌥+↓, Ctrl+S, Tab, ?. */
const KEY_RE = /((?:⌘|⌥|Ctrl|Alt)(?:\+?(?:Enter|Space|Shift|\/|↓|↑|→|\.|[A-Za-z](?![a-z])))+|\bTab\b|\?)/;

function withKeys(text: string) {
  return text.split(KEY_RE).map((p, i) => (i % 2 ? <kbd key={i} className="kbd">{p}</kbd> : p));
}

export function FirstRunHint() {
  const t = useT();
  const done = useShell((s) => s.firstRunDone);
  const dismiss = useShell((s) => s.dismissFirstRun);
  if (done) return null;
  return (
    <section className="first-run" aria-labelledby="first-run-title" data-testid="first-run">
      <h2 id="first-run-title" className="first-run-title">
        {t('firstRun.title')}
      </h2>
      <ol className="first-run-steps">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button type="button" className="first-run-step" onClick={() => openStep(s)}>
              <span className="first-run-num" aria-hidden="true">
                {i + 1}
              </span>
              <span>
                <strong>{t(LABELS[s])}</strong> <span className="first-run-line">{t(LINES[s])}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
      <h3 className="first-run-subtitle">{t('firstRun.editorTitle')}</h3>
      <ul className="first-run-editor">
        {EDITOR_LINES.map((k) => (
          <li key={k}>{withKeys(t(k))}</li>
        ))}
      </ul>
      <div className="first-run-foot">
        <span className="muted small">{t('firstRun.settings')}</span>
        <Button size="sm" variant="primary" onClick={dismiss}>
          {t('firstRun.dismiss')}
        </Button>
      </div>
    </section>
  );
}
