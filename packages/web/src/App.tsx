/** App shell: header, the current view from the query string, footer. */
import { MessageSquare, Settings as SettingsIcon } from 'lucide-react';
import { lazy, Suspense, useEffect } from 'react';
import { ApiStatusProvider, useApiStatus } from './lib/api-status.tsx';
import { appHref, onAppLinkClick, type Route, useRoute } from './lib/route.ts';
import { Home } from './components/home/Home.tsx';
import { Loading, RunView } from './components/RunView.tsx';
import { CHAT_PATH } from './lib/links.ts';

const Settings = lazy(() => import('./components/Settings.tsx'));

const TITLES: Record<Route['view'], string> = {
  home: 'vid2context: any video as context for AI agents',
  run: 'Result | vid2context',
  settings: 'Settings | vid2context',
};

function StatusDot() {
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
      className="hidden items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-muted hover:text-fg sm:flex"
      data-testid="api-status"
      data-status={state.status}
    >
      <span className={`size-2 rounded-full ${color}`} aria-hidden />
      {label}
    </a>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-bg/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
        <a href={appHref('')} onClick={(e) => onAppLinkClick(e, '')} className="flex items-center gap-2 font-semibold text-fg">
          <span className="v2c-gradient flex size-7 items-center justify-center rounded-v2c-sm" aria-hidden>
            <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden>
              <path d="M5 3.5v9l7-4.5z" className="text-black" />
            </svg>
          </span>
          vid2context
        </a>
        <nav aria-label="Main" className="ml-auto flex items-center gap-1 sm:gap-2">
          <StatusDot />
          <a href={CHAT_PATH} className="flex items-center gap-1.5 rounded-v2c-sm px-2.5 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg">
            <MessageSquare className="size-4" aria-hidden /> Chat
          </a>
          <a
            href={appHref('?view=settings')}
            onClick={(e) => onAppLinkClick(e, '?view=settings')}
            className="flex items-center gap-1.5 rounded-v2c-sm px-2.5 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg"
          >
            <SettingsIcon className="size-4" aria-hidden /> Settings
          </a>
        </nav>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-6 text-sm text-muted sm:px-6">
        <span>vid2context turns any video into context for AI agents. Free first, open source.</span>
        <a href="/" className="hover:text-fg">
          About
        </a>
        <a href="https://github.com/nirholas/vid2context" className="hover:text-fg" rel="noopener noreferrer">
          Source on GitHub
        </a>
      </div>
    </footer>
  );
}

function Main() {
  const route = useRoute();
  useEffect(() => {
    document.title = TITLES[route.view];
  }, [route.view]);
  const runKey = route.view === 'run' ? `${route.url}|${route.mode}|${route.lang}|${route.comments}|${route.timestamps}` : route.view;
  return (
    <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6" tabIndex={-1}>
      {route.view === 'home' && <Home />}
      {route.view === 'run' && <RunView key={runKey} params={route} />}
      {route.view === 'settings' && (
        <Suspense fallback={<Loading label="Loading settings" />}>
          <Settings />
        </Suspense>
      )}
    </main>
  );
}

export function App() {
  return (
    <ApiStatusProvider>
      <div className="flex min-h-screen flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-v2c focus:bg-surface-2 focus:px-4 focus:py-2 focus:text-fg"
        >
          Skip to content
        </a>
        <Header />
        <Main />
        <Footer />
      </div>
    </ApiStatusProvider>
  );
}
