/**
 * The app sidebar: brand, search, main navigation, recent results from this
 * browser, and a footer with docs, source and the theme. The shell decides
 * whether it is a column (wide screens) or a drawer (narrow ones).
 */
import {
  Braces,
  ChevronDown,
  CircleHelp,
  Download,
  Film,
  House,
  MessageSquare,
  PanelLeftClose,
  Search,
  Settings,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { runKey } from '../../lib/history.ts';
import { CHAT_PATH } from '../../lib/links.ts';
import { appHref, onAppLinkClick, type Route, readMode, runSearch } from '../../lib/route.ts';
import { useRecentResults } from '../../lib/use-history.ts';
import { BrandMark, IconButton, iconButtonClass } from '../ui.tsx';
import { GithubMark } from './GithubMark.tsx';
import { ThemeButton } from './ThemeButton.tsx';

const ROW = 'flex w-full items-center gap-3 rounded-v2c-sm px-3 py-2 text-left text-sm transition';
const IDLE = 'text-muted hover:bg-surface-2 hover:text-fg';
const ACTIVE = 'bg-surface-2 font-medium text-fg shadow-[inset_2px_0_0_var(--v2c-accent)]';
const ICON = 'size-[18px] shrink-0';

function NavLink({
  search,
  href,
  icon,
  active,
  children,
}: {
  /** In-app link (query string). */
  search?: string;
  /** Link to another app on the same domain. */
  href?: string;
  icon: ReactNode;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <a
      href={href ?? appHref(search)}
      onClick={search !== undefined ? (e) => onAppLinkClick(e, search) : undefined}
      aria-current={active ? 'page' : undefined}
      className={`${ROW} ${active ? ACTIVE : IDLE}`}
    >
      {icon}
      <span className="truncate">{children}</span>
    </a>
  );
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function Sidebar({
  route,
  onSearch,
  onCollapse,
  collapseLabel,
}: {
  route: Route;
  onSearch: () => void;
  onCollapse: () => void;
  collapseLabel: string;
}) {
  const { entries, total, loaded } = useRecentResults(30);
  const [recentOpen, setRecentOpen] = useState(true);
  const currentKey = route.view === 'run' ? runKey(route.url, route.mode, route.lang) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 pl-4 pr-2">
        <a
          href={appHref('')}
          onClick={(e) => onAppLinkClick(e, '')}
          className="flex min-w-0 items-center gap-2.5 rounded-v2c-sm font-semibold text-fg"
        >
          <BrandMark />
          <span className="truncate text-[15px]">vid2context</span>
        </a>
        <IconButton label={collapseLabel} className="ml-auto" onClick={onCollapse}>
          <PanelLeftClose className={ICON} strokeWidth={1.75} aria-hidden />
        </IconButton>
      </div>

      <div className="px-2">
        <button
          type="button"
          onClick={onSearch}
          className={`${ROW} ${IDLE}`}
          aria-keyshortcuts="Control+K Meta+K"
          data-testid="open-search"
        >
          <Search className={ICON} strokeWidth={1.75} aria-hidden />
          <span className="flex-1">Search</span>
          <kbd className="rounded border border-border px-1.5 font-mono text-[11px] text-subtle" aria-hidden>
            {isMac ? '⌘K' : 'Ctrl K'}
          </kbd>
        </button>
      </div>

      <nav aria-label="Main" className="mt-1 space-y-0.5 px-2">
        <NavLink search="" icon={<House className={ICON} strokeWidth={1.75} aria-hidden />} active={route.view === 'home'}>
          Home
        </NavLink>
        <NavLink href={CHAT_PATH} icon={<MessageSquare className={ICON} strokeWidth={1.75} aria-hidden />}>
          Chat
        </NavLink>
        <NavLink
          search="?view=download"
          icon={<Download className={ICON} strokeWidth={1.75} aria-hidden />}
          active={route.view === 'download'}
        >
          Download
        </NavLink>
        <NavLink
          search="?view=api"
          icon={<Braces className={ICON} strokeWidth={1.75} aria-hidden />}
          active={route.view === 'api'}
        >
          API
        </NavLink>
        <NavLink
          search="?view=settings"
          icon={<Settings className={ICON} strokeWidth={1.75} aria-hidden />}
          active={route.view === 'settings'}
        >
          Settings
        </NavLink>
      </nav>

      <section aria-labelledby="sidebar-recent" className="mt-4 flex min-h-0 flex-1 flex-col">
        <h2 id="sidebar-recent" className="px-2">
          <button
            type="button"
            aria-expanded={recentOpen}
            aria-controls="sidebar-recent-list"
            onClick={() => setRecentOpen((o) => !o)}
            className="flex w-full items-center gap-1 rounded-v2c-sm px-3 py-1 text-xs font-medium text-subtle hover:text-fg"
          >
            Recent
            <ChevronDown className={`size-3.5 transition ${recentOpen ? '' : '-rotate-90'}`} aria-hidden />
            {total > 0 && <span className="ml-auto tabular-nums">{total}</span>}
          </button>
        </h2>
        {recentOpen && (
          <div id="sidebar-recent-list" className="mt-1 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {loaded && entries.length === 0 ? (
              <p className="px-3 py-2 text-sm text-subtle">Results you open show up here.</p>
            ) : (
              <ul className="space-y-0.5" data-testid="sidebar-recent">
                {entries.map((e) => {
                  const search = runSearch({ url: e.input, mode: readMode(e.mode), lang: e.lang });
                  const active = e.key === currentKey;
                  return (
                    <li key={e.key}>
                      <a
                        href={appHref(search)}
                        onClick={(ev) => onAppLinkClick(ev, search)}
                        aria-current={active ? 'page' : undefined}
                        title={e.title}
                        className={`${ROW} ${active ? ACTIVE : IDLE}`}
                      >
                        <Film className="size-4 shrink-0 text-subtle" strokeWidth={1.75} aria-hidden />
                        <span className="truncate">{e.title}</span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
            {total > entries.length && (
              <button type="button" onClick={onSearch} className={`${ROW} ${IDLE} mt-1 text-xs`}>
                Search all {total} saved results
              </button>
            )}
          </div>
        )}
      </section>

      <div className="flex h-14 shrink-0 items-center gap-0.5 px-2">
        <a href="/docs/" className={iconButtonClass()} aria-label="Documentation" title="Documentation">
          <CircleHelp className={ICON} strokeWidth={1.75} aria-hidden />
        </a>
        <a
          href="https://github.com/nirholas/vid2context"
          rel="noopener noreferrer"
          className={iconButtonClass()}
          aria-label="Source on GitHub"
          title="Source on GitHub"
        >
          <GithubMark />
        </a>
        <a href="/" className="ml-1 rounded-v2c-sm px-2 py-1 text-xs text-subtle hover:text-fg">
          About
        </a>
        <span className="ml-auto">
          <ThemeButton />
        </span>
      </div>
    </div>
  );
}
