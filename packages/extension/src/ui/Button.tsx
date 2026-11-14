import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost';

const STYLES: Record<Variant, string> = {
  primary: 'bg-gradient-accent text-accent-fg border-transparent hover:brightness-110',
  secondary: 'bg-surface-2 text-text border-border hover:bg-surface-3 hover:border-border-strong',
  ghost: 'bg-transparent text-muted border-transparent hover:text-text hover:bg-surface-2',
};

export function Button({
  variant = 'secondary',
  icon,
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; icon?: ReactNode }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded-pill border px-4 py-2 text-sm font-medium transition disabled:cursor-default disabled:opacity-50 ${STYLES[variant]} ${className}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}
