/**
 * Conversation sidebar: New chat, search, conversations grouped by Pinned,
 * Today, Yesterday, Previous 7 days and Older, with star to pin, rename and
 * delete. A drawer on narrow screens, collapsible on wide ones.
 */
import { Check, MessageSquarePlus, Pencil, Search, Star, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { groupConversations, searchConversations } from '../lib/conversations.ts';
import type { Conversation } from '../lib/types.ts';
import { Button, cx, IconButton } from './ui.tsx';

export interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onTogglePin: (id: string) => void;
  /** Injected for tests and for grouping relative to a fixed time. */
  now?: number;
}

export function Sidebar(props: SidebarProps) {
  const [query, setQuery] = useState('');
  const groups = useMemo(
    () => groupConversations(searchConversations(props.conversations, query), props.now ?? Date.now()),
    [props.conversations, query, props.now],
  );

  return (
    <nav aria-label="Conversations" className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-2 p-3">
        <Button variant="outline" className="w-full justify-start rounded-md py-2" onClick={props.onNew} aria-keyshortcuts="Control+Shift+O Meta+Shift+O">
          <MessageSquarePlus size={16} aria-hidden /> New chat
        </Button>
        <label className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 focus-within:border-accent">
          <Search size={14} className="shrink-0 text-muted" aria-hidden />
          <span className="v2c-sr-only">Search conversations</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle"
          />
        </label>
      </div>
      <div className="v2c-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {groups.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted">{query ? 'No conversation matches.' : 'No conversations yet.'}</p>
        ) : null}
        {groups.map((g) => (
          <section key={g.group} aria-label={g.group} className="mb-3">
            <h3 className="px-2 pb-1 pt-2 text-xs font-medium text-muted">{g.group}</h3>
            <ul>
              {g.items.map((c) => (
                <ConversationItem
                  key={c.id}
                  conversation={c}
                  active={c.id === props.activeId}
                  onSelect={() => props.onSelect(c.id)}
                  onRename={(t) => props.onRename(c.id, t)}
                  onDelete={() => props.onDelete(c.id)}
                  onTogglePin={() => props.onTogglePin(c.id)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </nav>
  );
}

function ConversationItem(props: {
  conversation: Conversation;
  active: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  onTogglePin: () => void;
}) {
  const c = props.conversation;
  const [mode, setMode] = useState<'view' | 'rename' | 'confirm'>('view');
  const [title, setTitle] = useState(c.title);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (mode === 'rename') inputRef.current?.select();
  }, [mode]);

  if (mode === 'rename') {
    const save = () => {
      if (title.trim()) props.onRename(title.trim());
      setMode('view');
    };
    return (
      <li className="flex items-center gap-1 rounded-md bg-surface-3 px-2 py-1">
        <label className="min-w-0 flex-1">
          <span className="v2c-sr-only">Conversation title</span>
          <input
            ref={inputRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') {
                setTitle(c.title);
                setMode('view');
              }
            }}
            className="w-full bg-transparent py-1 text-sm outline-none"
          />
        </label>
        <IconButton label="Save title" tip={false} className="h-7 w-7" onClick={save}>
          <Check size={14} aria-hidden />
        </IconButton>
        <IconButton label="Cancel rename" tip={false} className="h-7 w-7" onClick={() => setMode('view')}>
          <X size={14} aria-hidden />
        </IconButton>
      </li>
    );
  }

  if (mode === 'confirm') {
    return (
      <li className="flex items-center justify-between gap-2 rounded-md bg-danger/10 px-2 py-1.5 text-sm" role="group" aria-label={`Delete ${c.title}?`}>
        <span className="min-w-0 truncate">Delete "{c.title}"?</span>
        <span className="flex shrink-0 gap-1">
          <Button variant="danger" className="px-2.5 py-0.5 text-xs" onClick={props.onDelete} autoFocus>
            Delete
          </Button>
          <Button variant="ghost" className="px-2.5 py-0.5 text-xs" onClick={() => setMode('view')}>
            Keep
          </Button>
        </span>
      </li>
    );
  }

  return (
    <li className={cx('group relative flex items-center rounded-md', props.active ? 'bg-surface-3' : 'hover:bg-surface-2')}>
      <button
        type="button"
        onClick={props.onSelect}
        aria-current={props.active ? 'page' : undefined}
        className="min-w-0 flex-1 truncate px-2.5 py-2 text-left text-sm"
        title={c.title}
      >
        {c.title}
      </button>
      <span
        className={cx(
          'flex shrink-0 items-center pr-1',
          c.pinned ? '' : 'opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100',
        )}
      >
        <IconButton label={c.pinned ? 'Unpin' : 'Pin'} tip={false} className="h-7 w-7" onClick={props.onTogglePin} aria-pressed={c.pinned}>
          <Star size={13} fill={c.pinned ? 'currentColor' : 'none'} className={c.pinned ? 'text-warning' : ''} aria-hidden />
        </IconButton>
        <span className="flex opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          <IconButton
            label="Rename"
            tip={false}
            className="h-7 w-7"
            onClick={() => {
              setTitle(c.title);
              setMode('rename');
            }}
          >
            <Pencil size={13} aria-hidden />
          </IconButton>
          <IconButton label="Delete" tip={false} className="h-7 w-7" onClick={() => setMode('confirm')}>
            <Trash2 size={13} aria-hidden />
          </IconButton>
        </span>
      </span>
    </li>
  );
}
