/**
 * The composer: attached context chips (thumbnail, title, estimated tokens,
 * remove), a growing multi-line input, an attach button, and send or stop.
 * Enter sends, Shift+Enter adds a newline, and IME composition is respected.
 */
import { AlertCircle, ArrowUp, Film, Folder, Paperclip, X } from 'lucide-react';
import { type ReactNode, type RefObject, useLayoutEffect } from 'react';
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
  /** Extra toolbar controls shown first, before the attach button (the workspace puts the model picker here). */
  tools?: ReactNode;
  /** Hide the note under the box (the empty state shows its own pills there). */
  hideNote?: boolean;
}

export function ContextChip(props: { context: AttachedContext; onRemove: () => void }) {
  const c = props.context;
  const tokens = c.tokens !== undefined ? `${c.tokensApprox ? '~' : ''}${formatTokens(c.tokens)} tokens` : undefined;
  return (
    <li
      className={cx(
        'flex min-w-0 max-w-full items-center gap-2 rounded-v2c border bg-surface-2 py-1 pl-1 pr-1 text-xs sm:max-w-[280px]',
        c.status === 'error' ? 'border-danger/60' : 'border-border',
      )}
      data-context={c.key}
    >
      {c.thumbnailUrl ? (
        <img
          src={c.thumbnailUrl}
          alt=""
          referrerPolicy="no-referrer"
          loading="lazy"
          className="h-8 w-12 shrink-0 rounded-sm object-cover"
        />
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
    <div className="mx-auto w-full max-w-3xl px-3 pb-3 sm:px-6 sm:pb-4">
      <div className="rounded-[20px] border border-border bg-surface shadow-v2c transition-colors focus-within:border-border-strong">
        {props.contexts.length > 0 ? (
          <ul className="flex flex-wrap gap-2 px-3 pt-3" aria-label="Attached context">
            {props.contexts.map((c) => (
              <ContextChip key={c.key} context={c} onRemove={() => props.onRemoveContext(c.key)} />
            ))}
          </ul>
        ) : null}
        <label className="block px-4 pt-4">
          <span className="v2c-sr-only">Message</span>
          <textarea
            ref={textareaRef}
            value={value}
            rows={2}
            placeholder="Ask about your videos. Enter sends, Shift+Enter adds a line."
            aria-keyshortcuts="/"
            className="block max-h-[260px] min-h-12 w-full resize-none bg-transparent text-[15px] leading-relaxed outline-none placeholder:text-subtle"
            onChange={(e) => props.onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (canSend) props.onSend();
              }
            }}
          />
        </label>
        <div className="flex items-center gap-1 px-2.5 pb-2.5 pt-1">
          {props.tools}
          <IconButton
            label="Attach videos or transcripts"
            className="size-9 rounded-full hover:bg-surface-3"
            onClick={props.onAttach}
          >
            <Paperclip size={18} strokeWidth={1.75} aria-hidden />
          </IconButton>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {props.blockedReason ? <span className="truncate text-xs text-muted">{props.blockedReason}</span> : null}
            {props.streaming ? (
              <StopButton onStop={props.onStop} />
            ) : (
              <button
                type="button"
                aria-label="Send"
                disabled={!canSend}
                onClick={props.onSend}
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40 disabled:hover:opacity-40"
              >
                <ArrowUp size={18} aria-hidden />
              </button>
            )}
          </div>
        </div>
      </div>
      {props.hideNote ? null : (
        <p className="mt-2 text-center text-[11px] text-subtle">
          Answers cite the videos. Check important claims against the cited moment.
        </p>
      )}
    </div>
  );
}
