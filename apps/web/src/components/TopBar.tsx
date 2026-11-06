/** Top bar: project and file, the simulated-AI badge, compile status, Pull/Push, cost, language, theme. */
import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../contracts';
import { isMockClient } from '../api/extras';
import { htmlLang, useT } from '../i18n';
import { useShell, type ThemePref } from '../state/extra';
import { useWorkspace } from '../state/store';
import { compileNow, forwardSync, openPush, pullNow, revealLine } from './actions';
import { IconCheck, IconLocate, IconMonitor, IconMoon, IconPdf, IconPlay, IconPull, IconPush, IconSparkle, IconSun, IconWarn, Spinner } from './Icons';
import { Badge, Button, IconButton } from './ui';

function BrandMark() {
  return (
    <svg className="brand-mark" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <rect x="1.5" y="1.5" width="17" height="17" rx="4" fill="var(--accent)" />
      <path d="M5.5 7h9M5.5 10h9M5.5 13h5.5" stroke="var(--accent-ink)" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="14" cy="13" r="1.3" fill="var(--accent-ink)" opacity=".55" />
    </svg>
  );
}

function CompileStatus() {
  const t = useT();
  const compile = useWorkspace((s) => s.compile);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label =
    compile.state === 'running'
      ? t('compile.running')
      : compile.state === 'error'
        ? t('compile.error', { n: compile.errors.length })
        : compile.state === 'ok'
          ? compile.pdfVersion === null
            ? t('compile.okNoPdf')
            : t('compile.ok')
          : t('compile.idle');
  const icon = compile.state === 'running' ? <Spinner size={12} /> : compile.state === 'error' ? <IconWarn size={14} /> : compile.state === 'ok' ? <IconCheck size={14} /> : <span className="dot dot-idle" aria-hidden="true" />;
  return (
    <div className="compile-status" ref={ref}>
      <button type="button" className={`compile-pill compile-${compile.state}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)} title={compile.logTail ? compile.logTail.slice(-400) : label}>
        {icon}
        <span className="compile-pill-label">{label}</span>
      </button>
      {open ? (
        <div className="popover compile-popover" role="dialog" aria-label={t('compile.errors')}>
          <h3 className="popover-title">{t('compile.errors')}</h3>
          {compile.errors.length ? (
            <ul className="compile-errors">
              {compile.errors.map((e, i) => (
                <li key={i}>
                  {e.line !== null ? (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => {
                        revealLine(e.line!);
                        setOpen(false);
                      }}
                    >
                      {e.file}:{e.line}
                    </button>
                  ) : (
                    <span className="mono">{e.file}</span>
                  )}{' '}
                  <span>{e.message}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{t('compile.noErrors')}</p>
          )}
          {compile.logTail ? (
            <>
              <h4 className="popover-subtitle">{t('compile.log')}</h4>
              <pre className="log-tail">{compile.logTail.slice(-2000)}</pre>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CostMeter({ fake }: { fake: boolean }) {
  const t = useT();
  const cost = useWorkspace((s) => s.cost);
  const usd = cost?.usd ?? 0;
  const n = cost?.requests ?? 0;
  const text = usd < 10 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(1)}`;
  const routes = cost ? Object.entries(cost.byRoute).map(([k, v]) => `${k} $${v.toFixed(3)}`) : [];
  const title = fake ? t('cost.simulatedTitle', { n }) : `${t('cost.title', { usd: text, n })}${routes.length ? `\n${routes.join(' · ')}` : ''}`;
  return (
    <span className="cost-meter" title={title} aria-label={title} role="img">
      <span className="cost-usd">{text}</span>
    </span>
  );
}

function LangToggle() {
  const t = useT();
  const lang = useShell((s) => s.lang);
  const setLang = useShell((s) => s.setLang);
  return (
    <div className="segmented" role="group" aria-label={t('lang.label')}>
      <button type="button" aria-pressed={lang === 'en'} onClick={() => setLang('en')} lang="en">
        EN
      </button>
      <button type="button" aria-pressed={lang === 'zh'} onClick={() => setLang('zh')} lang="zh-CN">
        中文
      </button>
    </div>
  );
}

const NEXT_THEME: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };

function ThemeToggle() {
  const t = useT();
  const theme = useShell((s) => s.theme);
  const setTheme = useShell((s) => s.setTheme);
  const icon = theme === 'light' ? <IconSun /> : theme === 'dark' ? <IconMoon /> : <IconMonitor />;
  return <IconButton label={t('theme.label', { mode: t(`theme.${theme}`) })} icon={icon} onClick={() => setTheme(NEXT_THEME[theme])} />;
}

export function TopBar({ api }: { api: ApiClient }) {
  const t = useT();
  const lang = useShell((s) => s.lang);
  const project = useWorkspace((s) => s.project);
  const file = useWorkspace((s) => s.file);
  const rightPane = useWorkspace((s) => s.rightPane);
  const setRightPane = useWorkspace((s) => s.setRightPane);
  const fakeShell = useShell((s) => s.fakeLlm);
  const fake = fakeShell ?? project?.fakeLlm ?? false;
  const mock = isMockClient(api);
  const [pulling, setPulling] = useState(false);

  return (
    <header className="topbar" lang={htmlLang(lang)}>
      <div className="topbar-left">
        <span className="brand">
          <BrandMark />
          <span className="brand-name">paper-copilot</span>
        </span>
        <span className="crumbs">
          <span className="crumb-project" title={project?.config.texRoot ?? undefined}>
            {project?.config.name ?? '…'}
          </span>
          <span className="crumb-sep" aria-hidden="true">
            /
          </span>
          <span className="crumb-file mono" title={t('top.file')}>
            {file ?? '—'}
          </span>
        </span>
        {fake ? (
          <Badge tone="warn" title={t('top.fakeLlmTitle')} className="fake-badge">
            <IconSparkle size={13} />
            <span className="fake-long">{t('top.fakeLlm')}</span>
            <span className="fake-short">{t('top.fakeLlmShort')}</span>
          </Badge>
        ) : null}
        {mock ? (
          <Badge tone="neutral" title={t('top.demoTitle')} className="demo-badge">
            {t('top.demo')}
          </Badge>
        ) : null}
      </div>
      <div className="topbar-right" role="toolbar" aria-label={t('top.toolbar')}>
        <CompileStatus />
        <Button icon={<IconPlay size={14} />} onClick={() => void compileNow(api)} title={t('compile.title')} aria-label={t('compile.button')} aria-keyshortcuts="Control+S Meta+S">
          {t('compile.button')}
        </Button>
        <span className="topbar-divider" aria-hidden="true" />
        <Button
          icon={<IconPull size={14} />}
          busy={pulling}
          title={t('top.pullTitle')}
          aria-label={t('top.pull')}
          onClick={async () => {
            setPulling(true);
            try {
              await pullNow(api);
            } finally {
              setPulling(false);
            }
          }}
        >
          {t('top.pull')}
        </Button>
        <Button icon={<IconPush size={14} />} onClick={openPush} title={t('top.pushTitle')} aria-label={t('top.push')}>
          {t('top.push')}
        </Button>
        <span className="topbar-divider" aria-hidden="true" />
        <CostMeter fake={fake} />
        <LangToggle />
        <ThemeToggle />
        <IconButton label={t('pdf.forward')} icon={<IconLocate />} onClick={() => void forwardSync(api)} aria-keyshortcuts="Control+Shift+J Meta+Shift+J" />
        <IconButton label={rightPane === 'pdf' ? t('pdf.hide') : t('pdf.show')} icon={<IconPdf />} aria-pressed={rightPane === 'pdf'} onClick={() => setRightPane(rightPane === 'pdf' ? 'none' : 'pdf')} />
      </div>
    </header>
  );
}
