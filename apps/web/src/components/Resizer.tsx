/** A vertical splitter between columns: drag, or focus it and use the arrow keys (Shift = larger steps). */
import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { LEFT_MAX, LEFT_MIN, RIGHT_MAX, RIGHT_MIN, useShell } from '../state/extra';

const DEFAULT_WIDTH = { left: 360, right: 520 } as const;

export function Resizer({ side, label }: { side: 'left' | 'right'; label: string }) {
  const width = useShell((s) => (side === 'left' ? s.leftWidth : s.rightWidth));
  const setLeft = useShell((s) => s.setLeftWidth);
  const setRight = useShell((s) => s.setRightWidth);
  const set = side === 'left' ? setLeft : setRight;
  const [min, max] = side === 'left' ? [LEFT_MIN, LEFT_MAX] : [RIGHT_MIN, RIGHT_MAX];
  const drag = useRef<{ x: number; w: number } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w: width };
    document.body.classList.add('is-resizing');
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    set(side === 'left' ? d.w + dx : d.w - dx);
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    document.body.classList.remove('is-resizing');
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    const grow = side === 'left' ? 1 : -1;
    if (e.key === 'ArrowRight') set(width + step * grow);
    else if (e.key === 'ArrowLeft') set(width - step * grow);
    else if (e.key === 'Home') set(min);
    else if (e.key === 'End') set(max);
    else return;
    e.preventDefault();
  };

  return (
    <div
      className={`resizer resizer-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => set(DEFAULT_WIDTH[side])}
      onKeyDown={onKeyDown}
    />
  );
}
