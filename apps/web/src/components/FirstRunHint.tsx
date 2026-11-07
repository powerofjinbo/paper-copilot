/** The first-run hint: the four-step flow, shown once at the top of the side panel (remembered in localStorage). */
import type { LeftStep } from '../contracts';
import { useT, type MsgKey } from '../i18n';
import { useShell } from '../state/extra';
import { openStep } from './actions';
import { STEPS } from './steps';
import { Button } from './ui';

const LINES: Record<LeftStep, MsgKey> = { plan: 'firstRun.plan', sources: 'firstRun.sources', todo: 'firstRun.todo', check: 'firstRun.check' };
const LABELS: Record<LeftStep, MsgKey> = { plan: 'step.planTitle', sources: 'step.sourcesTitle', todo: 'step.todoTitle', check: 'step.checkTitle' };

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
      <div className="first-run-foot">
        <span className="muted small">{t('firstRun.settings')}</span>
        <Button size="sm" variant="primary" onClick={dismiss}>
          {t('firstRun.dismiss')}
        </Button>
      </div>
    </section>
  );
}
