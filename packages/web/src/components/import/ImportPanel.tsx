/**
 * "Get the transcript another way": shown when the server could not read a
 * YouTube video's captions (YouTube blocks many cloud IPs) and in
 * client-only mode. Three ways, all ending in the same import
 * (docs/contracts/transcript-import.md):
 *
 *   From my browser  the vid2context extension fetches the captions from the user's own IP address
 *   Paste            the text copied from YouTube's "Show transcript" panel, or any subtitle text
 *   Upload           a .vtt, .srt, .txt, .xml or .json subtitle file
 *
 * The result is handed to `onImported` and shown like any other run.
 */
import { Vid2ContextError } from '@vid2context/core';
import { AlertTriangle, ClipboardPaste, ExternalLink, FileUp, Puzzle, RefreshCw } from 'lucide-react';
import { type ChangeEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { toAppError } from '../../lib/errors.ts';
import {
  type BridgeProgress,
  detectExtension,
  type ExtensionInfo,
  requestYouTubeTranscript,
} from '../../lib/extension-bridge.ts';
import { formatBytes } from '../../lib/format.ts';
import { type ImportRequest, type ImportResponse, type KnownMetadata, runImport, youtubeVideoId } from '../../lib/imports.ts';
import { Tabs } from '../Tabs.tsx';
import { Button, buttonClass, Spinner } from '../ui.tsx';

/** Same cap as POST /imports. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ACCEPT = '.vtt,.srt,.txt,.xml,.json,.srv1,.srv3,.json3,text/vtt,text/plain,application/x-subrip,application/json,text/xml';
const EXTENSION_DOCS = 'https://github.com/nirholas/vid2context/tree/main/packages/extension#readme';
/** Origins the extension's bridge runs on without any setup (match patterns ignore ports). */
const BUILT_IN_HOSTS = /^(localhost|127\.0\.0\.1|vid2context\.com|.+\.vid2context\.com)$/;

export interface ImportPanelProps {
  /** The video link the run was for. */
  url: string;
  /** The language the run asked for, if any. */
  lang?: string;
  /** No API: build the context in this browser. */
  clientOnly: boolean;
  onImported: (result: ImportResponse) => void;
}

function InlineError({ error }: { error: unknown }) {
  const e = toAppError(error);
  return (
    <div
      role="alert"
      data-testid="import-error"
      className="flex items-start gap-2 rounded-v2c border border-danger/60 bg-surface px-3 py-2 text-sm"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
      <div className="min-w-0 space-y-1">
        <p className="break-words text-fg">{e.message}</p>
        {e.hint && <p className="text-muted">{e.hint}</p>}
      </div>
    </div>
  );
}

/** Shared state for the three ways: one import at a time, its error, and cancel. */
function useImport(props: ImportPanelProps) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<unknown>();
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const run = useCallback(
    async (label: string, work: (signal: AbortSignal) => Promise<{ body: ImportRequest; metadata?: KnownMetadata }>) => {
      abort.current?.abort();
      const ac = new AbortController();
      abort.current = ac;
      setError(undefined);
      setBusy(label);
      try {
        const { body, metadata } = await work(ac.signal);
        if (ac.signal.aborted) return;
        setBusy('Importing the transcript');
        const result = await runImport(body, { clientOnly: props.clientOnly, metadata, signal: ac.signal });
        if (!ac.signal.aborted) props.onImported(result);
      } catch (err) {
        if (!ac.signal.aborted) setError(err);
      } finally {
        if (abort.current === ac) {
          abort.current = null;
          setBusy('');
        }
      }
    },
    [props],
  );
  const cancel = () => {
    abort.current?.abort();
    abort.current = null;
    setBusy('');
  };
  return { busy, error, run, cancel, setError };
}

function Busy({ label, onCancel }: { label: string; onCancel: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3" role="status" data-testid="import-busy">
      <Spinner />
      <span className="text-sm text-fg">{label}</span>
      <Button variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

function FromBrowser({ props, state }: { props: ImportPanelProps; state: ReturnType<typeof useImport> }) {
  const videoId = youtubeVideoId(props.url);
  const [ext, setExt] = useState<ExtensionInfo | null | 'checking'>('checking');
  const [progress, setProgress] = useState<BridgeProgress>();
  const check = useCallback(() => {
    setExt('checking');
    void detectExtension().then(setExt);
  }, []);
  useEffect(() => check(), [check]);

  const get = () => {
    if (!videoId) return;
    setProgress(undefined);
    void state.run('Asking the extension for the transcript', async (signal) => {
      const res = await requestYouTubeTranscript(videoId, {
        language: props.lang || undefined,
        onProgress: setProgress,
        signal,
      });
      return {
        body: {
          url: props.url,
          segments: res.transcript.segments,
          language: res.transcript.language,
          via: 'browser',
          captionKind: res.transcript.kind,
        },
        metadata: res.metadata,
      };
    });
  };

  if (ext === 'checking') {
    return (
      <p className="flex items-center gap-2 text-sm text-muted" role="status">
        <Spinner /> Looking for the vid2context extension
      </p>
    );
  }
  if (!ext?.capabilities.includes('youtube-transcript')) {
    const host = window.location.hostname;
    return (
      <div className="space-y-3 text-sm text-fg" data-testid="extension-missing">
        <p>
          {ext
            ? `The vid2context extension ${ext.version} in this browser cannot fetch transcripts yet. Update it to the latest build.`
            : 'The vid2context extension is not installed in this browser, or it is not enabled on this site.'}{' '}
          With it, your browser fetches the captions from YouTube with your own connection, which YouTube does not block.
        </p>
        <ol className="list-decimal space-y-1 pl-5 text-muted">
          <li>
            Build it from the vid2context repository: <code className="font-mono text-fg">npm install</code>, then{' '}
            <code className="font-mono text-fg">npm run build -w packages/extension</code>.
          </li>
          <li>
            Chrome or Edge: open <code className="font-mono text-fg">chrome://extensions</code>, turn on Developer mode, click
            "Load unpacked" and pick <code className="font-mono text-fg">packages/extension/dist/chrome</code>. Firefox: load{' '}
            <code className="font-mono text-fg">packages/extension/dist/firefox/manifest.json</code> from{' '}
            <code className="font-mono text-fg">about:debugging</code>.
          </li>
          {!BUILT_IN_HOSTS.test(host) && (
            <li>
              This app runs at <code className="font-mono text-fg">{window.location.origin}</code>: add it in the extension's
              options so the extension can talk to this page.
            </li>
          )}
          <li>Reload this page.</li>
        </ol>
        <div className="flex flex-wrap gap-2">
          <Button onClick={check}>
            <RefreshCw className="size-4" aria-hidden /> Check again
          </Button>
          <a href={EXTENSION_DOCS} target="_blank" rel="noreferrer" className={buttonClass('ghost')}>
            <ExternalLink className="size-4" aria-hidden /> Install guide
          </a>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3 text-sm">
      <p className="text-fg">
        The vid2context extension {ext.version} is installed. It fetches the captions from YouTube with your own connection, in
        the background, and sends them here. Nothing else leaves your browser.
      </p>
      {state.busy ? (
        <div className="space-y-2">
          <Busy label={state.busy} onCancel={state.cancel} />
          {progress && (
            <p className="text-xs text-muted" data-testid="extension-progress">
              {progress.message}
            </p>
          )}
        </div>
      ) : (
        <Button variant="accent" onClick={get} disabled={!videoId} data-testid="import-browser">
          <Puzzle className="size-4" aria-hidden /> Get it from my browser
        </Button>
      )}
    </div>
  );
}

function Paste({ props, state }: { props: ImportPanelProps; state: ReturnType<typeof useImport> }) {
  const id = useId();
  const [text, setText] = useState('');
  const submit = () => {
    if (!text.trim()) return;
    void state.run('Importing the transcript', async () => ({
      body: { url: props.url, text, via: 'paste', ...(props.lang ? { language: props.lang } : {}) },
    }));
  };
  return (
    <div className="space-y-3 text-sm">
      <ol className="list-decimal space-y-1 pl-5 text-muted">
        <li>
          Open the video on{' '}
          <a href={props.url} target="_blank" rel="noreferrer" className="text-fg underline underline-offset-2">
            YouTube
          </a>{' '}
          and click "...more" under the title to open the description.
        </li>
        <li>Scroll to "Transcript" and click "Show transcript".</li>
        <li>Select all the text in the transcript panel, copy it and paste it here.</li>
      </ol>
      <p className="text-muted">Text from an .srt or .vtt file, or plain text, works too.</p>
      <label htmlFor={id} className="sr-only">
        Transcript text
      </label>
      <textarea
        id={id}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        spellCheck={false}
        placeholder={'0:00\nFirst line of the transcript\n0:05\nNext line'}
        className="block w-full resize-y rounded-v2c border border-border bg-surface px-3 py-2 font-mono text-xs text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none"
        data-testid="import-text"
        disabled={!!state.busy}
      />
      {state.busy ? (
        <Busy label={state.busy} onCancel={state.cancel} />
      ) : (
        <Button variant="accent" onClick={submit} disabled={!text.trim()} data-testid="import-paste">
          <ClipboardPaste className="size-4" aria-hidden /> Use this transcript
        </Button>
      )}
    </div>
  );
}

function Upload({ props, state }: { props: ImportPanelProps; state: ReturnType<typeof useImport> }) {
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setName(`${file.name}, ${formatBytes(file.size)}`);
    if (file.size > MAX_FILE_BYTES) {
      state.setError(
        new Vid2ContextError('too-large', `${file.name} is ${formatBytes(file.size)}; the limit is 5 MB.`, {
          hint: 'Subtitle files are usually far smaller. Check that you picked the subtitles and not the video.',
        }),
      );
      return;
    }
    void state.run(`Reading ${file.name}`, async () => ({
      body: {
        url: props.url,
        text: await file.text(),
        filename: file.name,
        via: 'file',
        ...(props.lang ? { language: props.lang } : {}),
      },
    }));
  };
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted">
        A subtitle file for this video: WebVTT (.vtt), SRT (.srt), YouTube timedtext (.xml or .json), or text (.txt). It is read
        here and sent as text; the file name only helps tell the format and language apart.
      </p>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        onChange={onFile}
        data-testid="import-file-input"
        tabIndex={-1}
      />
      {state.busy ? (
        <Busy label={state.busy} onCancel={state.cancel} />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="accent" onClick={() => input.current?.click()} data-testid="import-file">
            <FileUp className="size-4" aria-hidden /> Choose a subtitle file
          </Button>
          {name && <span className="truncate text-xs text-muted">{name}</span>}
        </div>
      )}
    </div>
  );
}

export function ImportPanel(props: ImportPanelProps) {
  const headingId = useId();
  const [tab, setTab] = useState('browser');
  const state = useImport(props);
  return (
    <section
      aria-labelledby={headingId}
      data-testid="import-panel"
      className="space-y-3 rounded-v2c border border-border bg-surface-2 p-4"
    >
      <div>
        <h3 id={headingId} className="text-sm font-semibold text-fg">
          Get the transcript another way
        </h3>
        <p className="mt-1 text-sm text-muted">
          YouTube often refuses servers but not your own browser. Get the captions with the extension, paste them, or upload a
          subtitle file, and the result opens here like any other.
        </p>
      </div>
      <Tabs
        label="Ways to get the transcript"
        active={tab}
        onChange={(t) => {
          if (state.busy) return;
          state.setError(undefined);
          setTab(t);
        }}
        tabs={[
          { id: 'browser', label: 'From my browser', render: () => <FromBrowser props={props} state={state} /> },
          { id: 'paste', label: 'Paste', render: () => <Paste props={props} state={state} /> },
          { id: 'file', label: 'Upload a file', render: () => <Upload props={props} state={state} /> },
        ]}
      />
      {state.error !== undefined && <InlineError error={state.error} />}
    </section>
  );
}
