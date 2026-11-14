/**
 * The conversation thread. User messages on the right; assistant answers on
 * the left as Markdown with citation chips, a collapsed "Thinking"
 * disclosure when the model exposed reasoning, the model that answered
 * under each answer, and per-message actions: copy and regenerate for
 * answers, copy and edit-and-resend for questions.
 */
import { Brain, Check, Copy, Pencil, RefreshCw, Square } from 'lucide-react';
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { citedNumbers, sourceByNumber } from '../lib/citations.ts';
import { modelLabel, serviceLabel } from '../lib/models.ts';
import type { ChatSource, MessageRecord, ModelRow } from '../lib/types.ts';
import { CitationContext, TextWithCitations } from './CitationChip.tsx';
import { ErrorCard } from './ErrorCard.tsx';
import { Button, copyText, cx, IconButton, Spinner } from './ui.tsx';

const Markdown = lazy(() => import('./Markdown.tsx'));

export interface ThreadProps {
  messages: MessageRecord[];
  rows: ModelRow[] | null;
  onOpenSource: (source: ChatSource, sources: ChatSource[]) => void;
  onRegenerate: (assistantId: string) => void;
  onEditResend: (userId: string, text: string) => void;
  /** Disables actions that start a new answer while one is streaming. */
  busy: boolean;
}

export function Thread(props: ThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const last = props.messages[props.messages.length - 1];

  // Follow the stream while the reader is at the bottom; stop following when they scroll up.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the last message grows.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [last?.content, last?.reasoning, last?.status, props.messages.length]);

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="v2c-scroll min-h-0 flex-1 overflow-y-auto"
      role="log"
      aria-label="Conversation"
      aria-busy={last?.status === 'streaming'}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6">
        {props.messages.map((m) =>
          m.role === 'user' ? (
            <UserMessage key={m.id} message={m} busy={props.busy} onEditResend={props.onEditResend} />
          ) : (
            <AssistantMessage
              key={m.id}
              message={m}
              rows={props.rows}
              busy={props.busy}
              onOpenSource={props.onOpenSource}
              onRegenerate={props.onRegenerate}
            />
          ),
        )}
      </div>
    </div>
  );
}

function CopyButton(props: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      label={done ? 'Copied' : props.label}
      onClick={async () => {
        if (await copyText(props.text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }
      }}
    >
      {done ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
    </IconButton>
  );
}

function UserMessage(props: { message: MessageRecord; busy: boolean; onEditResend: (id: string, text: string) => void }) {
  const { message } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const ref = useRef<HTMLTextAreaElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on entering edit mode, not on every keystroke.
  useEffect(() => {
    if (editing) {
      ref.current?.focus();
      ref.current?.setSelectionRange(draft.length, draft.length);
    }
  }, [editing]);

  if (editing) {
    return (
      <div className="flex flex-col items-end gap-2" data-role="user">
        <label className="w-full sm:w-[85%]">
          <span className="v2c-sr-only">Edit your message</span>
          <textarea
            ref={ref}
            value={draft}
            rows={Math.min(10, Math.max(2, draft.split('\n').length))}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false);
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (draft.trim()) {
                  setEditing(false);
                  props.onEditResend(message.id, draft.trim());
                }
              }
            }}
            className="w-full resize-y rounded-lg border border-border-strong bg-surface-2 px-4 py-3 text-[0.95rem] outline-none focus:border-accent"
          />
        </label>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!draft.trim() || props.busy}
            onClick={() => {
              setEditing(false);
              props.onEditResend(message.id, draft.trim());
            }}
          >
            Save and resend
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex flex-col items-end gap-1" data-role="user">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg rounded-br-sm bg-surface-3 px-4 py-2.5 text-[0.95rem]">
        {message.content}
      </div>
      <div className="flex gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
        <CopyButton text={message.content} label="Copy message" />
        <IconButton
          label="Edit and resend"
          disabled={props.busy}
          onClick={() => {
            setDraft(message.content);
            setEditing(true);
          }}
        >
          <Pencil size={15} aria-hidden />
        </IconButton>
      </div>
    </div>
  );
}

function modelTag(message: MessageRecord, rows: ModelRow[] | null): { label: string; service?: string; fallbackFrom?: string } | null {
  if (!message.rung && !message.model) return null;
  const row = rows?.find((r) => r.id === message.rung);
  const service = row?.service ?? message.rung?.split('/')[1];
  const label = row?.label ?? modelLabel(message.model ?? message.rung ?? '', service ?? '');
  const req = message.requested;
  const fallbackFrom = req?.kind === 'rung' && message.rung && req.rung !== message.rung ? req.label : undefined;
  return { label, ...(service ? { service: serviceLabel(service) } : {}), ...(fallbackFrom ? { fallbackFrom } : {}) };
}

function AssistantMessage(props: {
  message: MessageRecord;
  rows: ModelRow[] | null;
  busy: boolean;
  onOpenSource: (source: ChatSource, sources: ChatSource[]) => void;
  onRegenerate: (id: string) => void;
}) {
  const { message } = props;
  const streaming = message.status === 'streaming';
  const tag = modelTag(message, props.rows);
  // The panel's switcher lists only the sources this answer actually cited.
  const cited = citedNumbers(message.content)
    .map((n) => sourceByNumber(message.sources, n))
    .filter((x): x is ChatSource => x !== undefined);
  const scope = { sources: message.sources, onOpen: (s: ChatSource) => props.onOpenSource(s, cited.length ? cited : [s]) };

  return (
    <div className="group flex flex-col gap-2" data-role="assistant" data-status={message.status}>
      {message.reasoning ? (
        <details className="rounded-md border border-border bg-surface text-sm">
          <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-muted">
            <Brain size={14} aria-hidden />
            {streaming && !message.content ? 'Thinking…' : 'Thinking'}
          </summary>
          <div className="whitespace-pre-wrap border-t border-border px-3 py-2 text-muted">{message.reasoning}</div>
        </details>
      ) : null}

      {message.content ? (
        <CitationContext.Provider value={scope}>
          <div className={cx('text-[0.95rem]', streaming && 'v2c-streaming')}>
            <Suspense
              fallback={
                <div className="whitespace-pre-wrap">
                  <TextWithCitations text={message.content} />
                </div>
              }
            >
              <Markdown text={message.content} />
            </Suspense>
            {streaming ? <span className="v2c-caret" aria-hidden /> : null}
          </div>
        </CitationContext.Provider>
      ) : streaming && !message.reasoning ? (
        <Spinner label={message.rung ? 'Writing…' : 'Connecting…'} />
      ) : null}

      {message.status === 'stopped' ? <p className="text-xs text-muted">Stopped.</p> : null}
      {message.unverified && message.unverified.length > 0 ? (
        <p className="text-xs text-muted">
          Removed citations that matched no source: {message.unverified.map((n) => `[${n}]`).join(' ')}
        </p>
      ) : null}
      {message.status === 'error' && message.error ? (
        <ErrorCard error={message.error} onRetry={props.busy ? undefined : () => props.onRegenerate(message.id)} />
      ) : null}

      {!streaming ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          {tag ? (
            <span className="inline-flex items-center gap-1.5 rounded-pill border border-border px-2 py-0.5" data-model-tag>
              <span className="font-medium text-fg">{tag.label}</span>
              {tag.service ? <span>{tag.service}</span> : null}
            </span>
          ) : null}
          {tag?.fallbackFrom ? <span>fell back from {tag.fallbackFrom}</span> : null}
          {message.content ? (
            <span className="flex gap-0.5">
              <CopyButton text={message.content} label="Copy answer" />
              <IconButton label="Regenerate" disabled={props.busy} onClick={() => props.onRegenerate(message.id)}>
                <RefreshCw size={15} aria-hidden />
              </IconButton>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function StopButton(props: { onStop: () => void }) {
  return (
    <Button onClick={props.onStop} aria-keyshortcuts="Escape">
      <Square size={12} fill="currentColor" aria-hidden /> Stop
    </Button>
  );
}
