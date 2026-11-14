/**
 * Home: a headline, the composer (link input, run options, file drop strip),
 * example chips, a notice when there is no API, recent results and how it
 * works. A file dropped anywhere on the page is transcribed too. No login.
 */
import { MessageSquare, Play, ServerOff, Settings, Upload } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { isClientOnly, useApiStatus } from '../../lib/api-status.tsx';
import { EXAMPLES } from '../../lib/examples.ts';
import { clearHistory } from '../../lib/history.ts';
import { CHAT_PATH } from '../../lib/links.ts';
import { appHref, navigate, onAppLinkClick, runSearch } from '../../lib/route.ts';
import { useRecentResults } from '../../lib/use-history.ts';
import { Loading } from '../RunView.tsx';
import { buttonClass } from '../ui.tsx';
import { ACCEPT, DropZone } from './DropZone.tsx';
import { HowItWorks } from './HowItWorks.tsx';
import { ComposerTools, DEFAULT_OPTIONS, type RunOptions } from './Options.tsx';
import { RecentList } from './RecentList.tsx';
import { UrlForm } from './UrlForm.tsx';

const UploadRun = lazy(() => import('../upload/UploadRun.tsx'));

/** Real public videos, both recorded in tests/fixtures/contexts (shared with the API page). */
export { EXAMPLES };

const CHIP =
  'inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm text-fg transition hover:border-border-strong hover:bg-surface-2';

/** Accepts a file dropped anywhere in the window while home is open, with a full-window hint while dragging. */
function useWindowDrop(onFile: (f: File) => void, enabled: boolean): boolean {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const cb = useRef(onFile);
  cb.current = onFile;
  useEffect(() => {
    if (!enabled) return;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current += 1;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const file = e.dataTransfer?.files[0];
      if (file) cb.current(file);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
      depth.current = 0;
      setDragging(false);
    };
  }, [enabled]);
  return dragging;
}

function NoApiCard({ status, base }: { status: string; base: string }) {
  return (
    <section
      aria-labelledby="no-api-title"
      className="flex flex-col gap-4 rounded-v2c-lg border border-border bg-surface p-5 sm:flex-row sm:items-center"
      data-testid="client-only-banner"
    >
      <span className="flex size-11 shrink-0 items-center justify-center rounded-v2c bg-surface-3 text-fg" aria-hidden>
        <ServerOff className="size-5" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <h2 id="no-api-title" className="text-[15px] font-semibold text-fg">
          Running without a server
        </h2>
        <p className="text-sm text-muted">
          {status === 'client-only-build' ? 'This copy runs without a server.' : `No API answered at ${base}.`} Links need a
          server, because video sites block browser requests. Files are transcribed here in your browser.
        </p>
      </div>
      <a
        href={appHref('?view=settings')}
        onClick={(e) => onAppLinkClick(e, '?view=settings')}
        className={buttonClass('secondary', 'shrink-0 rounded-full')}
      >
        <Settings className="size-4" aria-hidden /> Set the API base in Settings
      </a>
    </section>
  );
}

export function Home() {
  const { state: api } = useApiStatus();
  const clientOnly = isClientOnly(api);
  const [options, setOptions] = useState<RunOptions>(DEFAULT_OPTIONS);
  const [file, setFile] = useState<File>();
  const { entries, total } = useRecentResults();
  const fileInput = useRef<HTMLInputElement>(null);
  const dragging = useWindowDrop(setFile, !file);

  const run = (url: string) => navigate(runSearch({ ...options, url }));
  const pick = () => fileInput.current?.click();

  return (
    <div className="space-y-14">
      <input
        ref={fileInput}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) setFile(f);
          e.target.value = '';
        }}
        data-testid="file-input"
      />

      {dragging && (
        <div
          className="pointer-events-none fixed inset-3 z-50 flex items-center justify-center rounded-v2c-lg border-2 border-dashed border-accent bg-black/70"
          aria-hidden
        >
          <p className="flex items-center gap-3 text-lg font-medium text-white">
            <Upload className="size-6" aria-hidden /> Drop to transcribe
          </p>
        </div>
      )}

      <section aria-label="Get context" className="space-y-6 pt-[8vh] sm:pt-[12vh]">
        <div className="space-y-3 text-center">
          <h1 className="text-[2rem] font-semibold leading-tight tracking-tight text-fg sm:text-[2.6rem]">
            Any video, as context for your AI
          </h1>
          <p className="mx-auto max-w-xl text-[15px] text-muted">
            Paste a link or drop a file. Get the transcript with timestamp links, chapters and metadata as files you can copy,
            download or paste straight into an agent. Free, no login.
          </p>
        </div>

        {file ? (
          <Suspense fallback={<Loading label="Loading" />}>
            <UploadRun file={file} options={options} clientOnly={clientOnly} onCancel={() => setFile(undefined)} />
          </Suspense>
        ) : (
          <>
            <UrlForm
              onSubmit={run}
              tools={<ComposerTools value={options} onChange={setOptions} onPickFile={pick} />}
              footer={
                <DropZone
                  onFile={setFile}
                  onPick={pick}
                  note={
                    clientOnly
                      ? 'Transcribed in your browser with Whisper. The audio never leaves this device.'
                      : 'mp3, m4a, wav, ogg, webm, mp4, mov and more. Click to choose a file.'
                  }
                />
              }
            />
            <div className="flex flex-wrap items-center justify-center gap-2.5">
              <span className="sr-only">Try an example:</span>
              {EXAMPLES.map((ex) => (
                <button key={ex.url} type="button" onClick={() => run(ex.url)} className={CHIP}>
                  <Play className="size-4 text-muted" strokeWidth={1.75} aria-hidden />
                  {ex.label}
                </button>
              ))}
              <a href={CHAT_PATH} className={CHIP}>
                <MessageSquare className="size-4 text-muted" strokeWidth={1.75} aria-hidden />
                Chat about a video
              </a>
            </div>
            {clientOnly && <NoApiCard status={api.status} base={api.base} />}
          </>
        )}
      </section>

      <RecentList entries={entries} total={total} onClear={clearHistory} />
      <HowItWorks />
    </div>
  );
}
