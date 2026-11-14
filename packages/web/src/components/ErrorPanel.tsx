/** Every failure shows its message, its hint and what was tried. Never a bare "something went wrong". */
import { RefreshCw, Settings, TriangleExclamationPoint } from 'lucide-react';
import type { ReactNode } from 'react';
import { type AppError, toAppError } from '../lib/errors.ts';
import { appHref, onAppLinkClick } from '../lib/route.ts';
import { AttemptsTimeline } from './AttemptsTimeline.tsx';
import { Button, buttonClass } from './ui.tsx';

export function ErrorPanel({
  error,
  title = 'That did not work',
  onRetry,
  showSettings,
  children,
}: {
  error: unknown;
  title?: string;
  onRetry?: () => void;
  showSettings?: boolean;
  children?: ReactNode;
}) {
  const e: AppError = toAppError(error);
  return (
    <section role="alert" aria-labelledby="error-title" className="rounded-v2c-lg border border-danger/60 bg-surface p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <TriangleExclamationPoint className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h2 id="error-title" className="text-base font-semibold text-fg">
              {title}
            </h2>
            <p className="mt-1 text-sm text-fg break-words" data-testid="error-message">
              {e.message}
            </p>
          </div>
          {e.hint && (
            <p className="rounded-v2c border border-border bg-surface-2 px-3 py-2 text-sm text-fg" data-testid="error-hint">
              <span className="font-semibold">How to fix it: </span>
              {e.hint}
            </p>
          )}
          <p className="text-xs text-muted">
            Error code <code className="font-mono">{e.code}</code>
            {e.status ? `, upstream HTTP ${e.status}` : ''}
            {e.retryAfterSec ? `, retry after ${e.retryAfterSec} s` : ''}
          </p>
          {children}
          {e.attempts.length > 0 && (
            <details className="group" open={e.attempts.length <= 6}>
              <summary className="cursor-pointer text-sm font-medium text-fg">What was tried ({e.attempts.length})</summary>
              <div className="mt-3">
                <AttemptsTimeline attempts={e.attempts} />
              </div>
            </details>
          )}
          {(onRetry || showSettings) && (
            <div className="flex flex-wrap gap-2 pt-1">
              {onRetry && (
                <Button onClick={onRetry}>
                  <RefreshCw className="size-4" aria-hidden /> Try again
                </Button>
              )}
              {showSettings && (
                <a
                  href={appHref('?view=settings')}
                  onClick={(ev) => onAppLinkClick(ev, '?view=settings')}
                  className={buttonClass('ghost')}
                >
                  <Settings className="size-4" aria-hidden /> Settings
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
