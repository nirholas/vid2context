/**
 * The composer: attached context chips (thumbnail, title, estimated tokens,
 * remove), a growing multi-line input, an attach button, and send or stop.
 * Enter sends, Shift+Enter adds a newline, and IME composition is respected.
 */
import { AlertCircle, ArrowUp, Film, Folder, Paperclip, X } from 'lucide-react';
import { type RefObject, useLayoutEffect } from 'react';
import { formatTokens } from '../lib/meter.ts';
import type { AttachedContext } from '../lib/types.ts';
import { StopButton } from './Thread.tsx';
import { cx, IconButton, Spinner } from './ui.tsx';

export interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  contexts: AttachedContext[];
  onRemoveContext: (key: string) => void;
  onAttach: () => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Why sending is blocked, e.g. while an attachment still loads. */
  blockedReason?: string;
}

export function ContextChip(props: { context: AttachedContext; onRemove: () => void }) {
  const c = props.context;
  const tokens = c.tokens !== undefined ? `${c.tokensApprox ? '~' : ''}${formatTokens(c.tokens)} tokens` : undefined;
  return (
    <li
      className={cx(
        'flex min-w-0 max-w-full items-center gap-2 rounded-md border bg-surface-2 py-1 pl-1 pr-1 text-xs sm:max-w-[280px]',
        c.status === 'error' ? 'border-danger/60' : 'border-border',
      )}
      data-context={c.key}
    >
      {c.thumbnailUrl ? (
        <img src={c.thumbnailUrl} alt="" referrerPolicy="no-referrer" loading="lazy" className="h-8 w-12 shrink-0 rounded-sm object-cover" />
      ) : (
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-surface-3 text-muted">
          {c.kind === 'collection' ? <Folder size={14} aria-hidden /> : <Film size={14} aria-hidden />}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-fg" title={c.title}>
          {c.title}
        </span>
        <span className="block truncate text-muted">
          {c.status === 'loading' ? (
            'Loading transcript…'
          ) : c.status === 'error' ? (
            <span className="inline-flex items-center gap-1 text-danger">
              <AlertCircle size={11} aria-hidden /> {c.error?.hint ?? c.error?.message ?? 'Could not attach'}
            </span>
          ) : (
            [c.videoCount !== undefined ? `${c.videoCount} videos` : undefined, tokens].filter(Boolean).join(' · ') || 'Attached'
          )}
        </span>
      </span>
      {c.status === 'loading' ? <Spinner size={12} /> : null}
      <IconButton label={`Remove ${c.title}`} tip={false} className="h-6 w-6" onClick={props.onRemove}>
        <X size={13} aria-hidden />
      </IconButton>
    </li>
  );
}

export function Composer(props: ComposerProps) {
  const { textareaRef, value } = props;

  // Grow with the text up to about ten lines.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the value changes.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [value, textareaRef]);

  const canSend = value.trim().length > 0 && !props.streaming && !props.blockedReason;

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-3 sm:px-6 sm:pb-5">
      <div className="rounded-lg border border-border-strong bg-surface transition-colors focus-within:border-accent">
        {props.contexts.length > 0 ? (
          <ul className="flex flex-wrap gap-2 px-3 pt-3" aria-label="Attached context">
            {props.contexts.map((c) => (
              <ContextChip key={c.key} context={c} onRemove={() => props.onRemoveContext(c.key)} />
            ))}
          </ul>
        ) : null}
        <label className="block px-4 pt-3">
          <span className="v2c-sr-only">Message</span>
          <textarea
            ref={textareaRef}
            value={value}
            rows={1}
            placeholder="Ask about your videos..."
            aria-keyshortcuts="/"
            className="block max-h-[260px] w-full resize-none bg-transparent text-[0.95rem] leading-relaxed outline-none placeholder:text-subtle"
            onChange={(e) => props.onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (canSend) props.onSend();
              }
            }}
          />
        </label>
        <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-1">
          <IconButton label="Attach videos or transcripts" onClick={props.onAttach}>
            <Paperclip size={17} aria-hidden />
          </IconButton>
          <div className="flex items-center gap-2">
            {props.blockedReason ? <span className="text-xs text-muted">{props.blockedReason}</span> : null}
            {props.streaming ? (
              <StopButton onStop={props.onStop} />
            ) : (
              <button
                type="button"
                aria-label="Send"
                disabled={!canSend}
                onClick={props.onSend}
                className="v2c-gradient inline-flex h-8 w-8 items-center justify-center rounded-full transition-opacity disabled:opacity-30"
              >
                <ArrowUp size={17} aria-hidden />
              </button>
            )}
          </div>
        </div>
      </div>
      <p className="mt-2 text-center text-[11px] text-muted">
        Answers cite the videos. Check important claims against the cited moment.
      </p>
    </div>
  );
}
