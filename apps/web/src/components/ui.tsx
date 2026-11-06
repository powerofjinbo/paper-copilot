/** Small presentational building blocks shared by the shell and the panels. */
import { useId, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { Provenance, SentenceState } from '@paper-copilot/core';
import { provKey, provTitleKey, stateKey, stateTitleKey, useT } from '../i18n';
import { IconChevronDown, Spinner } from './Icons';

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger' | 'quiet';
  size?: 'sm' | 'md';
  icon?: ReactNode;
  busy?: boolean;
};

export function Button({ variant = 'default', size = 'md', icon, busy, children, className, disabled, type, ...rest }: BtnProps) {
  return (
    <button
      type={type ?? 'button'}
      className={['btn', `btn-${variant}`, size === 'sm' ? 'btn-sm' : '', className ?? ''].filter(Boolean).join(' ')}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <Spinner size={12} /> : icon}
      {children !== undefined && children !== null && children !== false ? <span className="btn-label">{children}</span> : null}
    </button>
  );
}

type IconBtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: ReactNode; size?: 'sm' | 'md' };

/** Icon-only button: the label is the accessible name and the tooltip. */
export function IconButton({ label, icon, size = 'md', className, type, ...rest }: IconBtnProps) {
  return (
    <button type={type ?? 'button'} className={['icon-btn', size === 'sm' ? 'icon-btn-sm' : '', className ?? ''].filter(Boolean).join(' ')} aria-label={label} title={label} {...rest}>
      {icon}
    </button>
  );
}

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'ai';

export function Badge({ tone = 'neutral', title, children, className }: { tone?: Tone; title?: string; children: ReactNode; className?: string }) {
  return (
    <span className={`badge badge-${tone}${className ? ` ${className}` : ''}`} title={title}>
      {children}
    </span>
  );
}

/** Sentence provenance state: colour swatch (matching the gutter) plus a text label and tooltip. */
export function StateTag({ state }: { state: SentenceState }) {
  const t = useT();
  return (
    <span className={`state-tag state-${state}`} title={t(stateTitleKey(state))}>
      <span className="state-swatch" aria-hidden="true" />
      {t(stateKey(state))}
    </span>
  );
}

/** Outline item provenance (author / AI-proposed / AI, edited), never colour alone. */
export function ProvTag({ provenance }: { provenance: Provenance }) {
  const t = useT();
  return (
    <span className={`prov-tag prov-${provenance}`} title={t(provTitleKey(provenance))}>
      {t(provKey(provenance))}
    </span>
  );
}

export function PanelHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="panel-header">
      <div className="panel-header-row">
        <h2 className="panel-title">{title}</h2>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </div>
      {subtitle ? <p className="panel-subtitle">{subtitle}</p> : null}
    </header>
  );
}

/** A collapsible group inside a panel (button with aria-expanded; content stays mounted when open). */
export function PanelSection({
  title,
  count,
  actions,
  children,
  defaultOpen = true,
  className,
}: {
  title: ReactNode;
  count?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section className={`psec${open ? ' psec-open' : ''}${className ? ` ${className}` : ''}`}>
      <div className="psec-head">
        <button type="button" className="psec-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
          <IconChevronDown className="psec-chevron" />
          <span className="psec-title">{title}</span>
          {count !== undefined ? <span className="psec-count">{count}</span> : null}
        </button>
        {actions ? <div className="psec-actions">{actions}</div> : null}
      </div>
      <div id={id} className="psec-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}

export function Field({ label, hint, htmlFor, children, aside }: { label: ReactNode; hint?: ReactNode; htmlFor?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="field">
      <div className="field-label-row">
        <label className="field-label" htmlFor={htmlFor}>
          {label}
        </label>
        {aside ? <span className="field-aside">{aside}</span> : null}
      </div>
      {children}
      {hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function InlineError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="inline-error" role="alert">
      {message}
    </div>
  );
}

/** Light display cleanup of a LaTeX sentence for lists (the editor shows the exact source). */
export function displayLatex(s: string): string {
  return s
    .replace(/(^|[^\\])%.*$/gm, '$1')
    .replace(/\\[,;:! ]/g, ' ')
    .replace(/~/g, ' ')
    .replace(/\\%/g, '%')
    .replace(/\\(?:emph|textit|textbf|textrm|mbox|text)\{([^{}]*)\}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Text with every case-insensitive occurrence of `needle` wrapped in <mark>. */
export function Highlight({ text, needle }: { text: string; needle: string }) {
  const n = needle.trim();
  if (!n) return <>{text}</>;
  const lower = text.toLowerCase();
  const nl = n.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  let k = 0;
  for (;;) {
    const j = lower.indexOf(nl, i);
    if (j < 0) break;
    if (j > i) parts.push(text.slice(i, j));
    parts.push(<mark key={k++}>{text.slice(j, j + n.length)}</mark>);
    i = j + n.length;
  }
  parts.push(text.slice(i));
  return <>{parts}</>;
}
