/**
 * The app sidebar: a back link to the web app, the brand, "New chat" and
 * "Search" rows, conversations grouped by Pinned, Today, Yesterday,
 * Previous 7 days and Older (each group collapsible), with a star to pin,
 * rename and delete, and a footer with help, source, settings and the theme.
 * The workspace shows it as a collapsible column from md up and as a drawer
 * below md.
 */
import {
  Check,
  ChevronDown,
  ChevronLeft,
  CircleHelp,
  CodeXml,
  Monitor,
  Moon,
  PanelLeftClose,
  Pencil,
  Search,
  Settings,
  SquarePen,
  Star,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { groupConversations, searchConversations } from '../lib/conversations.ts';
import type { Theme } from '../lib/settings.ts';
import type { Conversation } from '../lib/types.ts';
import { BrandMark, Button, cx, IconButton } from './ui.tsx';

export const WEB_APP_PATH = '/app/';
export const DOCS_PATH = '/docs/';
export const SOURCE_URL = 'https://github.com/nirholas/vid2context';

const THEME_NEXT: Record<Theme, Theme> = { dark: 'light', light: 'system', system: 'dark' };
const THEME_LABEL: Record<Theme, string> = { dark: 'Dark', light: 'Light', system: 'System' };

export interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onTogglePin: (id: string) => void;
  /** Opens the settings dialog; shows the settings button in the footer. */
  onSettings?: () => void;
  /** The current theme and how to change it; shows the theme button in the footer. */
  theme?: Theme;
  onTheme?: (theme: Theme) => void;
  /** Collapses the sidebar column (wide screens). */
  onCollapse?: () => void;
  /** Closes the drawer (narrow screens). */
  onClose?: () => void;
  /** Injected for tests and for grouping relative to a fixed time. */
  now?: number;
}

const ROW =
  'flex w-full items-center gap-3 rounded-v2c-sm px-3 py-2 text-left text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg';
const FOOT_BTN =
  'inline-flex size-9 items-center justify-center rounded-v2c-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg';

export function Sidebar(props: SidebarProps) {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  const groups = useMemo(
    () => groupConversations(searchConversations(props.conversations, query), props.now ?? Date.now()),
    [props.conversations, query, props.now],
  );

  useEffect(() => {
    if (searching) searchRef.current?.focus();
  }, [searching]);

  const toggleGroup = (g: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  const theme = props.theme;
  const ThemeIcon = theme === 'light' ? Sun : theme === 'system' ? Monitor : Moon;

  return (
    <nav aria-label="Conversations" className="flex h-full min-h-0 flex-col bg-sidebar">
      <div className="flex h-14 shrink-0 items-center gap-2 px-3">
        <a
          href={WEB_APP_PATH}
          aria-label="Back to vid2context"
          title="Back to vid2context"
          className="-ml-1 inline-flex size-8 items-center justify-center rounded-v2c-sm text-muted hover:bg-surface-2 hover:text-fg"
        >
          <ChevronLeft size={18} strokeWidth={1.75} aria-hidden />
        </a>
        <BrandMark />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-fg">Chat</span>
        {props.onCollapse ? (
          <IconButton label="Hide sidebar" onClick={props.onCollapse}>
            <PanelLeftClose size={18} strokeWidth={1.75} aria-hidden />
          </IconButton>
        ) : null}
        {props.onClose ? (
          <IconButton label="Close sidebar" onClick={props.onClose}>
            <X size={18} strokeWidth={1.75} aria-hidden />
          </IconButton>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-col gap-0.5 px-2">
        <button type="button" className={ROW} onClick={props.onNew} aria-keyshortcuts="Control+Shift+O Meta+Shift+O">
          <SquarePen size={18} strokeWidth={1.75} aria-hidden /> New chat
        </button>
        {searching || query ? (
          <label className="flex items-center gap-3 rounded-v2c-sm bg-surface-2 px-3 py-2 text-sm">
            <Search size={18} strokeWidth={1.75} className="shrink-0 text-muted" aria-hidden />
            <span className="v2c-sr-only">Search conversations</span>
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setQuery('');
                  setSearching(false);
                }
              }}
              onBlur={() => {
                if (!query) setSearching(false);
              }}
              placeholder="Search conversations"
              className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-subtle"
            />
          </label>
        ) : (
          <button type="button" className={ROW} onClick={() => setSearching(true)}>
            <Search size={18} strokeWidth={1.75} aria-hidden /> Search
          </button>
        )}
      </div>

      <div className="v2c-scroll mt-1 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {groups.length === 0 ? (
          <p className="px-3 py-3 text-sm text-muted">{query ? 'No conversation matches.' : 'No conversations yet.'}</p>
        ) : null}
        {groups.map((g) => {
          const closed = collapsed.has(g.group) && !query;
          return (
            <section key={g.group} aria-label={g.group}>
              <h3>
                <button
                  type="button"
                  aria-expanded={!closed}
                  onClick={() => toggleGroup(g.group)}
                  className="flex w-full items-center gap-1 px-3 pb-1 pt-4 text-xs font-medium text-subtle hover:text-muted"
                >
                  {g.group}
                  <ChevronDown size={12} className={cx('transition-transform', closed && '-rotate-90')} aria-hidden />
                </button>
              </h3>
              {closed ? null : (
                <ul className="flex flex-col gap-0.5">
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
              )}
            </section>
          );
        })}
      </div>

      <div className="flex h-12 shrink-0 items-center gap-0.5 px-2 pb-2">
        <FootLink href={DOCS_PATH} label="Help and docs">
          <CircleHelp size={18} strokeWidth={1.75} aria-hidden />
        </FootLink>
        <FootLink href={SOURCE_URL} label="Source on GitHub" external>
          <CodeXml size={18} strokeWidth={1.75} aria-hidden />
        </FootLink>
        {props.onSettings ? (
          <button type="button" className={FOOT_BTN} aria-label="Settings" title="Settings" onClick={props.onSettings}>
            <Settings size={18} strokeWidth={1.75} aria-hidden />
          </button>
        ) : null}
        {theme && props.onTheme ? (
          <button
            type="button"
            className={cx(FOOT_BTN, 'ml-auto')}
            aria-label={`Theme: ${THEME_LABEL[theme]}. Switch to ${THEME_LABEL[THEME_NEXT[theme]]}`}
            title={`Theme: ${THEME_LABEL[theme]}`}
            onClick={() => props.onTheme?.(THEME_NEXT[theme])}
          >
            <ThemeIcon size={18} strokeWidth={1.75} aria-hidden />
          </button>
        ) : null}
      </div>
    </nav>
  );
}

function FootLink(props: { href: string; label: string; external?: boolean; children: ReactNode }) {
  return (
    <a
      href={props.href}
      aria-label={props.label}
      title={props.label}
      className={FOOT_BTN}
      {...(props.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      {props.children}
    </a>
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
      <li className="flex items-center gap-1 rounded-v2c-sm bg-surface-2 px-2 py-1">
        <label className="min-w-0 flex-1">
          <span className="v2c-sr-only">Conversation title</span>
          <input
            ref={inputRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') {
                e.stopPropagation();
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
      <li className="flex items-center justify-between gap-2 rounded-v2c-sm bg-danger/10 px-2 py-1.5 text-sm">
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
    <li
      className={cx(
        'group relative flex items-center rounded-v2c-sm pl-1',
        props.active ? 'bg-surface-2 shadow-[inset_2px_0_0_var(--v2c-accent)]' : 'hover:bg-surface-2',
      )}
    >
      <IconButton
        label={c.pinned ? 'Unpin' : 'Pin'}
        tip={false}
        className="h-7 w-7 shrink-0"
        onClick={props.onTogglePin}
        aria-pressed={c.pinned}
      >
        <Star size={14} fill={c.pinned ? 'currentColor' : 'none'} className={c.pinned ? 'text-fg' : ''} aria-hidden />
      </IconButton>
      <button
        type="button"
        onClick={props.onSelect}
        aria-current={props.active ? 'page' : undefined}
        className={cx('min-w-0 flex-1 truncate py-2 pl-1.5 pr-2 text-left text-sm', props.active ? 'font-medium text-fg' : 'text-fg/90')}
        title={c.title}
      >
        {c.title}
      </button>
      <span className="flex shrink-0 items-center pr-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
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
    </li>
  );
}
