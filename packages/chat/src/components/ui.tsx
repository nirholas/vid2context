/**
 * Small shared primitives: an accessible modal dialog (focus trap, Escape,
 * focus restore), an icon button with a visible tooltip, and a tooltip
 * wrapper that shows on hover and on keyboard focus.
 */
import { X } from 'lucide-react';
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useId, useRef } from 'react';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Dialog(props: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const { open, onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const first = node?.querySelector<HTMLElement>('[data-autofocus]') ?? node?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !node) return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) return;
      const firstEl = items[0] as HTMLElement;
      const lastEl = items[items.length - 1] as HTMLElement;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    node?.addEventListener('keydown', onKey);
    return () => {
      node?.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4">
      <button type="button" aria-label="Close dialog" tabIndex={-1} className="absolute inset-0 cursor-default" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cx(
          'relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-lg border border-border bg-surface shadow-pop sm:rounded-lg',
          props.wide ? 'sm:max-w-2xl' : 'sm:max-w-lg',
        )}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
          <h2 id={titleId} className="text-base font-semibold">
            {props.title}
          </h2>
          <IconButton label="Close" onClick={onClose}>
            <X size={18} aria-hidden />
          </IconButton>
        </div>
        <div className="v2c-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">{props.children}</div>
        {props.footer ? <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{props.footer}</div> : null}
      </div>
    </div>
  );
}

export function IconButton(
  props: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tip?: boolean; active?: boolean; children: ReactNode },
) {
  const { label, tip = true, active, className, children, ...rest } = props;
  return (
    <span className="group/tip relative inline-flex">
      <button
        type="button"
        aria-label={label}
        className={cx(
          'inline-flex h-8 w-8 items-center justify-center rounded-sm text-muted transition-colors hover:bg-surface-3 hover:text-fg disabled:opacity-40',
          active && 'bg-surface-3 text-fg',
          className,
        )}
        {...rest}
      >
        {children}
      </button>
      {tip ? <TipBubble text={label} /> : null}
    </span>
  );
}

function TipBubble(props: { text: string; side?: 'top' | 'bottom' }) {
  return (
    <span
      aria-hidden
      className={cx(
        'pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-sm border border-border bg-surface-3 px-2 py-1 text-xs text-fg opacity-0 shadow-pop transition-opacity group-hover/tip:opacity-100 group-focus-within/tip:opacity-100',
        props.side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
      )}
    >
      {props.text}
    </span>
  );
}

/** Wrap a non-interactive visual (an icon) so it has an accessible name and a tooltip. */
export function Tip(props: { text: string; children: ReactNode; side?: 'top' | 'bottom' }) {
  return (
    <span className="group/tip relative inline-flex">
      <span role="img" aria-label={props.text} className="inline-flex">
        {props.children}
      </span>
      <TipBubble text={props.text} side={props.side ?? 'top'} />
    </span>
  );
}

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'outline' | 'danger' }) {
  const { variant = 'outline', className, ...rest } = props;
  return (
    <button
      type="button"
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-pill px-3.5 py-1.5 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-40',
        variant === 'primary' && 'v2c-gradient hover:opacity-90',
        variant === 'outline' && 'border border-border-strong text-fg hover:bg-surface-3',
        variant === 'ghost' && 'text-muted hover:bg-surface-3 hover:text-fg',
        variant === 'danger' && 'bg-danger text-white hover:opacity-90',
        className,
      )}
      {...rest}
    />
  );
}

export function Spinner(props: { label?: string; size?: number }) {
  const s = props.size ?? 14;
  return (
    <span role="status" className="inline-flex items-center gap-2 text-muted">
      <svg width={s} height={s} viewBox="0 0 24 24" className="animate-spin motion-reduce:animate-none" aria-hidden>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
        <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      {props.label ? <span className="text-sm">{props.label}</span> : <span className="v2c-sr-only">Loading</span>}
    </span>
  );
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
