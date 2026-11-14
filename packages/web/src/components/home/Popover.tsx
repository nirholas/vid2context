/** A button that opens a small panel under it. Escape or a click outside closes it and focus returns to the button. */
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';

export function Popover({
  label,
  trigger,
  title,
  triggerClass,
  children,
}: {
  /** Accessible name of the button. */
  label: string;
  trigger: ReactNode;
  /** Heading of the panel, also its accessible name. */
  title: string;
  triggerClass: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>('input:checked, input, button')?.focus();
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={open ? `${id}-panel` : undefined}
        onClick={() => setOpen((o) => !o)}
        className={triggerClass}
      >
        {trigger}
      </button>
      {open && (
        <div
          ref={panel}
          id={`${id}-panel`}
          role="dialog"
          aria-labelledby={`${id}-title`}
          className="absolute left-0 top-full z-20 mt-2 w-[min(22rem,calc(100vw-3rem))] rounded-v2c-lg border border-border bg-surface-2 p-2 shadow-v2c"
        >
          <h3 id={`${id}-title`} className="px-2 pb-1 pt-1 text-xs font-medium text-subtle">
            {title}
          </h3>
          {children(close)}
        </div>
      )}
    </div>
  );
}
