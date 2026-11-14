/**
 * App shell: a sidebar (a column on wide screens, a drawer on narrow ones)
 * and a framed main panel that scrolls on its own. The current view comes
 * from the query string.
 */
import { Menu, PanelLeftOpen } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Home } from './components/home/Home.tsx';
import { Loading, RunView } from './components/RunView.tsx';
import { SearchDialog } from './components/shell/SearchDialog.tsx';
import { Sidebar } from './components/shell/Sidebar.tsx';
import { IconButton } from './components/ui.tsx';
import { ApiStatusProvider, useApiStatus } from './lib/api-status.tsx';
import { appHref, onAppLinkClick, type Route, useRoute } from './lib/route.ts';

const Settings = lazy(() => import('./components/Settings.tsx'));
const ApiPlayground = lazy(() => import('./components/api/ApiPlayground.tsx'));
const DownloadPage = lazy(() => import('./components/download/DownloadPage.tsx'));

const TITLES: Record<Route['view'], string> = {
  home: 'vid2context: any video as context for AI agents',
  run: 'Result | vid2context',
  settings: 'Settings | vid2context',
  api: 'API | vid2context',
  download: 'Download video or audio | vid2context',
};

/** localStorage key for the collapsed sidebar on wide screens. */
export const SIDEBAR_KEY = 'v2c.sidebar';
const WIDE = '(min-width: 768px)';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

function StatusPill() {
  const { state } = useApiStatus();
  const label =
    state.status === 'online'
      ? 'API connected'
      : state.status === 'checking'
        ? 'Checking the API'
        : state.status === 'client-only-build'
          ? 'Client-only'
          : 'API offline, client-only';
  const color = state.status === 'online' ? 'bg-success' : state.status === 'checking' ? 'bg-subtle' : 'bg-warning';
  return (
    <a
      href={appHref('?view=settings')}
      onClick={(e) => onAppLinkClick(e, '?view=settings')}
      className="flex items-center gap-2 rounded-full px-3 py-1.5 text-xs text-muted transition hover:bg-surface-2 hover:text-fg"
      data-testid="api-status"
      data-status={state.status}
    >
      <span className={`size-2 rounded-full ${color}`} aria-hidden />
      <span className="hidden sm:inline">{label}</span>
      <span className="sr-only sm:hidden">{label}</span>
    </a>
  );
}

function Shell() {
  const route = useRoute();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawer, setDrawer] = useState(false);
  const [searching, setSearching] = useState(false);
  const main = useRef<HTMLElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  const setCollapsedSaved = useCallback((c: boolean) => {
    setCollapsed(c);
    try {
      localStorage.setItem(SIDEBAR_KEY, c ? 'collapsed' : 'open');
    } catch {
      // Storage blocked: the choice lasts for this page only.
    }
  }, []);

  const runKey =
    route.view === 'run'
      ? `${route.url}|${route.mode}|${route.lang}|${route.comments}|${route.timestamps}`
      : route.view === 'download'
        ? `download|${route.url ?? ''}`
        : route.view;

  // New view: set the title, close the drawer and start the panel at the top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runKey is the trigger: a new run in the same view also starts at the top.
  useEffect(() => {
    document.title = TITLES[route.view];
    setDrawer(false);
    main.current?.scrollTo({ top: 0 });
  }, [route.view, runKey]);

  // Ctrl+K or Cmd+K opens search from anywhere.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearching(true);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  // The drawer: move focus into it, close on Escape, give focus back on close.
  useEffect(() => {
    if (!drawer) return;
    sidebar.current?.querySelector<HTMLElement>('a, button')?.focus();
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawer(false);
    };
    window.addEventListener('keydown', on);
    return () => {
      window.removeEventListener('keydown', on);
      opener.current?.focus();
    };
  }, [drawer]);

  const wide = () => window.matchMedia(WIDE).matches;
  const openSidebar = () => (wide() ? setCollapsedSaved(false) : setDrawer(true));
  const closeSidebar = () => (wide() ? setCollapsedSaved(true) : setDrawer(false));

  return (
    <div className="flex h-dvh overflow-hidden bg-sidebar text-fg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-v2c focus:bg-surface-2 focus:px-4 focus:py-2 focus:text-fg"
      >
        Skip to content
      </a>

      {drawer && <div className="fixed inset-0 z-30 bg-black/60 md:hidden" aria-hidden onClick={() => setDrawer(false)} />}
      <aside
        ref={sidebar}
        id="sidebar"
        aria-label="Sidebar"
        className={`w-[260px] shrink-0 bg-sidebar max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:border-r max-md:border-border max-md:transition-transform ${
          drawer ? 'max-md:translate-x-0' : 'max-md:invisible max-md:-translate-x-full'
        } ${collapsed ? 'md:hidden' : ''}`}
      >
        <Sidebar
          route={route}
          onSearch={() => setSearching(true)}
          onCollapse={closeSidebar}
          collapseLabel={drawer ? 'Close sidebar' : 'Collapse sidebar'}
        />
      </aside>

      <div className={`flex min-w-0 flex-1 flex-col md:p-2 ${collapsed ? '' : 'md:pl-0'}`}>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-panel md:rounded-v2c-lg md:border md:border-border">
          <div className="flex h-12 shrink-0 items-center gap-1 px-2 sm:px-3">
            <IconButton
              ref={opener}
              label="Open sidebar"
              aria-controls="sidebar"
              aria-expanded={drawer}
              className="md:hidden"
              onClick={openSidebar}
            >
              <Menu className="size-[18px]" strokeWidth={1.75} aria-hidden />
            </IconButton>
            {collapsed && (
              <IconButton label="Expand sidebar" className="max-md:hidden" onClick={openSidebar}>
                <PanelLeftOpen className="size-[18px]" strokeWidth={1.75} aria-hidden />
              </IconButton>
            )}
            <div className="ml-auto">
              <StatusPill />
            </div>
          </div>
          <main ref={main} id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto focus:outline-none">
            <div className={`mx-auto w-full px-4 pb-16 sm:px-6 ${route.view === 'home' ? 'max-w-4xl' : 'max-w-6xl pt-2'}`}>
              {route.view === 'home' && <Home />}
              {route.view === 'run' && <RunView key={runKey} params={route} />}
              {route.view === 'settings' && (
                <Suspense fallback={<Loading label="Loading settings" />}>
                  <Settings />
                </Suspense>
              )}
              {route.view === 'download' && (
                <Suspense fallback={<Loading label="Loading the download page" />}>
                  <DownloadPage url={route.url} />
                </Suspense>
              )}
              {route.view === 'api' && (
                <Suspense fallback={<Loading label="Loading the API page" />}>
                  <ApiPlayground initial={route} />
                </Suspense>
              )}
            </div>
          </main>
        </div>
      </div>

      <SearchDialog open={searching} onClose={() => setSearching(false)} />
    </div>
  );
}

export function App() {
  return (
    <ApiStatusProvider>
      <Shell />
    </ApiStatusProvider>
  );
}
