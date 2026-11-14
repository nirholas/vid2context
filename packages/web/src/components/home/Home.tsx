/**
 * Home: one input and one button, a drop zone, example chips, options, how it
 * works, and recent results. Like xactions.app/video: no login.
 */
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { isClientOnly, useApiStatus } from '../../lib/api-status.tsx';
import { clearHistory, countEntries, type HistorySummary, listEntries } from '../../lib/history.ts';
import { appHref, navigate, onAppLinkClick, runSearch } from '../../lib/route.ts';
import { Loading } from '../RunView.tsx';
import { DropZone } from './DropZone.tsx';
import { HowItWorks } from './HowItWorks.tsx';
import { DEFAULT_OPTIONS, Options, type RunOptions } from './Options.tsx';
import { RecentList } from './RecentList.tsx';
import { UrlForm } from './UrlForm.tsx';

const UploadRun = lazy(() => import('../upload/UploadRun.tsx'));

/** Real public videos, both recorded in tests/fixtures/contexts. */
export const EXAMPLES = [
  { label: 'Me at the zoo (0:19)', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' },
  { label: 'Best and Worst G-Wagon Years (18:13)', url: 'https://www.youtube.com/watch?v=cCPsdFdlshc' },
];

export function Home() {
  const { state: api } = useApiStatus();
  const clientOnly = isClientOnly(api);
  const [options, setOptions] = useState<RunOptions>(DEFAULT_OPTIONS);
  const [file, setFile] = useState<File>();
  const [recent, setRecent] = useState<HistorySummary[]>([]);
  const [total, setTotal] = useState(0);

  const loadRecent = useCallback(async () => {
    try {
      const [entries, count] = await Promise.all([listEntries(), countEntries()]);
      setRecent(entries);
      setTotal(count);
    } catch (err) {
      console.error('[vid2context] history is unavailable', err);
    }
  }, []);
  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  const run = (url: string) => navigate(runSearch({ ...options, url }));

  return (
    <div className="space-y-12">
      <section className="space-y-5 pt-6 text-center sm:pt-12">
        <h1 className="text-3xl font-semibold tracking-tight text-fg sm:text-5xl">Any video, as context for your AI</h1>
        <p className="mx-auto max-w-2xl text-base text-muted sm:text-lg">
          Paste a link or drop a file. Get the transcript with timestamp links, chapters and metadata as files you can copy,
          download or paste straight into an agent. Free, no login.
        </p>
      </section>

      <section aria-label="Get context" className="mx-auto max-w-3xl space-y-4">
        {file ? (
          <Suspense fallback={<Loading label="Loading" />}>
            <UploadRun file={file} options={options} clientOnly={clientOnly} onCancel={() => setFile(undefined)} />
          </Suspense>
        ) : (
          <>
            <UrlForm onSubmit={run} />
            {clientOnly && (
              <p
                className="rounded-v2c border border-border bg-surface px-4 py-3 text-sm text-fg"
                data-testid="client-only-banner"
              >
                {api.status === 'client-only-build' ? 'This copy runs without a server.' : `No API answered at ${api.base}.`}{' '}
                Links need a server, because video sites block browser requests;{' '}
                <a
                  href={appHref('?view=settings')}
                  onClick={(e) => onAppLinkClick(e, '?view=settings')}
                  className="text-accent underline underline-offset-4"
                >
                  set the API base in Settings
                </a>
                . Files are transcribed here in your browser.
              </p>
            )}
            <DropZone
              onFile={setFile}
              note={
                clientOnly
                  ? 'Transcribed in your browser with Whisper. The audio never leaves this device.'
                  : 'mp3, m4a, wav, ogg, webm, mp4, mov and more. Click to choose a file.'
              }
            />
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted">Try:</span>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex.url}
                  type="button"
                  onClick={() => run(ex.url)}
                  className="rounded-full border border-border bg-surface px-3 py-1 text-sm text-fg transition hover:border-border-strong hover:bg-surface-2"
                >
                  {ex.label}
                </button>
              ))}
            </div>
            <Options value={options} onChange={setOptions} />
          </>
        )}
      </section>

      <div className="mx-auto max-w-5xl space-y-12">
        <HowItWorks />
        <RecentList
          entries={recent}
          total={total}
          onClear={async () => {
            await clearHistory();
            await loadRecent();
          }}
        />
      </div>
    </div>
  );
}
