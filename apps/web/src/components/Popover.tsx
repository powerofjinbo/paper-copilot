/** A small anchored popover/menu: closes on outside click and Escape (focus returns to the trigger). */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void, trigger?: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        trigger?.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, open, close, trigger]);
}

/**
 * A trigger button plus a popover below it. `children` receives `close`. The trigger gets
 * aria-haspopup/aria-expanded; `role` is the popover's role ('menu' or 'dialog').
 */
export function PopoverButton({
  label,
  title,
  className,
  popClass,
  role = 'dialog',
  align = 'end',
  children,
  testId,
}: {
  label: ReactNode;
  title: string;
  className?: string;
  popClass?: string;
  role?: 'menu' | 'dialog';
  align?: 'start' | 'end';
  children: (close: () => void) => ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  useDismiss(ref, open, close, btn);
  useEffect(() => {
    if (!open || role !== 'menu') return;
    // focus the first item of a menu opened from the keyboard or mouse
    const first = ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])');
    first?.focus();
  }, [open, role]);
  return (
    <div className="pop-anchor" ref={ref}>
      <button ref={btn} type="button" className={className} aria-haspopup={role === 'menu' ? 'menu' : 'dialog'} aria-expanded={open} title={title} aria-label={title} onClick={() => setOpen((o) => !o)} data-testid={testId}>
        {label}
      </button>
      {open ? (
        <div
          className={`popover pop-${align}${popClass ? ` ${popClass}` : ''}`}
          role={role}
          aria-label={title}
          onKeyDown={(e) => {
            if (role !== 'menu' || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
            const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
            const i = items.indexOf(document.activeElement as HTMLElement);
            const n = items.length;
            if (!n) return;
            e.preventDefault();
            items[(i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n]?.focus();
          }}
        >
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}
