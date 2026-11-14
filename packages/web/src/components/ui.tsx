/** Small shared pieces: buttons, icon buttons, the copy button with feedback, a spinner, a progress bar and the brand mark. */
import { Check, Copy, LoaderCircle } from 'lucide-react';
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useRef, useState } from 'react';
import { copyText } from '../lib/clipboard.ts';

type Variant = 'primary' | 'accent' | 'secondary' | 'ghost';

const VARIANTS: Record<Variant, string> = {
  primary:
    'v2c-gradient text-on-accent font-semibold shadow-v2c hover:opacity-90 disabled:opacity-60 disabled:hover:opacity-60',
  accent: 'bg-accent text-on-accent font-medium hover:opacity-90 disabled:opacity-60',
  secondary: 'bg-surface-2 text-fg border border-border hover:border-border-strong hover:bg-surface-3 disabled:opacity-60',
  ghost: 'text-muted hover:text-fg hover:bg-surface-2 disabled:opacity-60',
};

export function buttonClass(variant: Variant = 'secondary', extra = ''): string {
  return `inline-flex items-center justify-center gap-2 rounded-v2c px-3.5 py-2 text-sm transition focus-visible:outline-2 ${VARIANTS[variant]} ${extra}`;
}

export function Button({
  variant = 'secondary',
  className = '',
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button type={type} className={buttonClass(variant, className)} {...rest} />;
}

/** Square icon-only control: sidebar footers, composer tools, panel bars. */
export function iconButtonClass(extra = '', round = false): string {
  return `inline-flex size-9 shrink-0 items-center justify-center text-muted transition hover:bg-surface-3 hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent ${
    round ? 'rounded-full' : 'rounded-v2c-sm'
  } ${extra}`;
}

/** An icon button always has an accessible name; `label` doubles as the hover tooltip. */
export function IconButton({
  label,
  round = false,
  className = '',
  type = 'button',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; round?: boolean }) {
  return (
    <button type={type} aria-label={label} title={label} className={iconButtonClass(className, round)} {...rest}>
      {children}
    </button>
  );
}

/** The vid2context mark: a play triangle on the accent. */
export function BrandMark({ className = 'size-7' }: { className?: string }) {
  return (
    <span className={`flex shrink-0 items-center justify-center rounded-v2c-sm bg-accent text-on-accent ${className}`} aria-hidden>
      <svg viewBox="0 0 16 16" className="size-1/2" fill="currentColor" aria-hidden>
        <path d="M5 3.5v9l7-4.5z" />
      </svg>
    </span>
  );
}

export function Spinner({ label, className = '' }: { label?: string; className?: string }) {
  return (
    <LoaderCircle
      className={`size-4 animate-spin ${className}`}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
    />
  );
}

/** A copy button that says "Copied" for two seconds, or why copying failed. */
export function CopyButton({
  getText,
  label = 'Copy',
  copiedLabel = 'Copied',
  variant = 'secondary',
  className = '',
  icon,
  describedBy,
}: {
  getText: () => string | Promise<string>;
  label?: string;
  copiedLabel?: string;
  variant?: Variant;
  className?: string;
  icon?: ReactNode;
  describedBy?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onClick = async () => {
    clearTimeout(timer.current);
    try {
      await copyText(await getText());
      setState('copied');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState('failed');
    }
    timer.current = setTimeout(() => setState('idle'), state === 'failed' ? 6000 : 2000);
  };
  return (
    <>
      <Button variant={variant} className={className} onClick={onClick} aria-describedby={describedBy}>
        {state === 'copied' ? <Check className="size-4" aria-hidden /> : (icon ?? <Copy className="size-4" aria-hidden />)}
        <span>{state === 'copied' ? copiedLabel : label}</span>
      </Button>
      <span className="sr-only" role="status">
        {state === 'copied' ? copiedLabel : state === 'failed' ? `Copy failed: ${error}` : ''}
      </span>
      {state === 'failed' && <span className="text-xs text-muted">{error}</span>}
    </>
  );
}

export function ProgressBar({ value, label }: { value?: number; label: string }) {
  const pct = value === undefined ? undefined : Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct === undefined ? undefined : Math.round(pct)}
      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
    >
      <div
        className={`h-full rounded-full v2c-gradient ${pct === undefined ? 'w-1/3 animate-pulse' : 'transition-[width]'}`}
        style={pct === undefined ? undefined : { width: `${pct}%` }}
      />
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-v2c-lg border border-border bg-surface ${className}`}>{children}</section>;
}

/** Small uppercase-free section heading with an icon, as in the home and result sections. */
export function SectionTitle({ id, icon, children }: { id?: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <h2 id={id} className="flex items-center gap-2 text-[15px] font-semibold text-fg">
      {icon}
      {children}
    </h2>
  );
}
