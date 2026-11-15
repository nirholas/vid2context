/**
 * The Captions page (?view=captions&url=...): only the captions, without the
 * rest of the context. A video lists every caption track; each can be
 * previewed and saved as SRT, WebVTT, plain text or JSON, all of them saved
 * at once as a .zip, or translated into another language. A playlist or
 * channel saves one language for every video into one .zip.
 *
 * Every request uses mode=captions, so no audio is downloaded or transcribed
 * here; videos without captions point to the run page, which can transcribe.
 */
import { Vid2ContextError, type VideoMetadata, type VideoRef } from '@vid2context/core';
import { Captions, Download, Eye, FileArchive, Languages, ListVideo } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { type CallOptions, getItems, isListError, requestJson } from '../../lib/api.ts';
import { isClientOnly, useOptionalApiStatus } from '../../lib/api-status.tsx';
import {
  type CaptionListing,
  type CaptionTrack,
  captionFileName,
  extraTargets,
  FORMAT_LABELS,
  type FormatInfo,
  fetchCaption,
  getCaptionFormats,
  getCaptionLanguages,
  ORIGIN_LABELS,
  zipCaptions,
} from '../../lib/captions.ts';
import { saveBlob } from '../../lib/download.ts';
import { type AppError, isAbort, toAppError, withAttempts } from '../../lib/errors.ts';
import { shortInput } from '../../lib/format.ts';
import { appHref, captionsSearch, navigate, onAppLinkClick, runSearch } from '../../lib/route.ts';
import { ErrorPanel } from '../ErrorPanel.tsx';
import { UrlForm } from '../home/UrlForm.tsx';
import { Button, buttonClass, Card, ProgressBar, Spinner } from '../ui.tsx';

/** Most videos captioned from one playlist or channel. */
export const CAPTION_LIST_LIMIT = 100;

type Loaded =
  | { kind: 'loading' }
  | { kind: 'video'; listing: CaptionListing; formats: FormatInfo[]; title: string }
  | { kind: 'list'; formats: FormatInfo[] }
  | { kind: 'error'; error: unknown };

function FormatPicker({
  formats,
  format,
  onFormat,
  timestamps,
  onTimestamps,
  disabled,
}: {
  formats: FormatInfo[];
  format: string;
  onFormat: (f: string) => void;
  timestamps: boolean;
  onTimestamps: (v: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-wrap items-end gap-4">
      <label className="space-y-1 text-sm" htmlFor={id}>
        <span className="block font-medium text-fg">Format</span>
        <select
          id={id}
          value={format}
          onChange={(e) => onFormat(e.target.value)}
          disabled={disabled}
          className="rounded-v2c border border-border bg-surface px-3 py-2 text-sm text-fg"
          data-testid="captions-format"
        >
          {formats.map((f) => (
            <option key={f.id} value={f.id}>
              {FORMAT_LABELS[f.id] ?? f.id}
            </option>
          ))}
        </select>
      </label>
      {format === 'text' && (
        <label className="flex items-center gap-2 pb-2 text-sm text-fg">
          <input type="checkbox" checked={timestamps} onChange={(e) => onTimestamps(e.target.checked)} disabled={disabled} />
          Timestamps before each line
        </label>
      )}
    </div>
  );
}

function OriginBadge({ track }: { track: CaptionTrack }) {
  const others = track.origins.filter((o) => o !== track.origin);
  return (
    <span className="text-xs text-muted">
      <span className="rounded-v2c-sm border border-border px-1.5 py-0.5 text-fg">{ORIGIN_LABELS[track.origin]}</span>
      {others.length > 0 && (
        <span className="ml-1.5" title="A download in this language returns the track named first.">
          also {others.map((o) => ORIGIN_LABELS[o].toLowerCase()).join(', ')}
        </span>
      )}
    </span>
  );
}

function VideoCaptions({
  url,
  listing,
  formats,
  title,
  call,
}: {
  url: string;
  listing: CaptionListing;
  formats: FormatInfo[];
  title: string;
  call: CallOptions;
}) {
  const [format, setFormat] = useState(formats[0]?.id ?? 'srt');
  const [timestamps, setTimestamps] = useState(false);
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState<number>();
  const [error, setError] = useState<unknown>();
  const [preview, setPreview] = useState<{ language: string; name: string; text: string }>();
  const [failures, setFailures] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const ext = formats.find((f) => f.id === format)?.extension ?? format;
  const targets = extraTargets(listing.translationTargets, listing.tracks);
  const targetId = useId();

  const work = async (label: string, fn: (signal: AbortSignal) => Promise<void>) => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setBusy(label);
    setProgress(undefined);
    setError(undefined);
    setFailures([]);
    try {
      await fn(ac.signal);
    } catch (err) {
      if (!isAbort(err)) setError(err);
    } finally {
      if (abort.current === ac) {
        abort.current = null;
        setBusy('');
        setProgress(undefined);
      }
    }
  };

  const save = (t: CaptionTrack) =>
    work(`Getting the ${t.name} captions`, async (signal) => {
      const file = await fetchCaption({ url, language: t.language, format, timestamps }, { ...call, signal });
      saveBlob(
        new Blob([file.text], { type: file.mimeType }),
        captionFileName(title, t.language, ext, { auto: t.origin === 'auto-captions' }),
      );
    });

  const show = (t: CaptionTrack) =>
    work(`Getting the ${t.name} captions`, async (signal) => {
      const file = await fetchCaption({ url, language: t.language, format, timestamps }, { ...call, signal });
      setPreview({ language: t.language, name: t.name, text: file.text });
    });

  const saveAll = () =>
    work('Getting every track', async (signal) => {
      const files: { name: string; text: string }[] = [];
      const failed: string[] = [];
      let first: AppError | undefined;
      for (const [i, t] of listing.tracks.entries()) {
        setBusy(`Getting ${t.name} (${i + 1} of ${listing.tracks.length})`);
        setProgress((i / listing.tracks.length) * 100);
        try {
          const file = await fetchCaption({ url, language: t.language, format, timestamps }, { ...call, signal });
          files.push({ name: captionFileName(title, t.language, ext, { auto: t.origin === 'auto-captions' }), text: file.text });
        } catch (err) {
          if (isAbort(err)) throw err;
          const e = toAppError(err);
          first ??= e;
          failed.push(`${t.name}: ${e.message}`);
        }
      }
      if (files.length === 0 && first) {
        // Keep the first failure's code, hint and retry time (a rate limit says when to try again), naming every track.
        throw withAttempts(
          new Vid2ContextError(first.code, `No track could be fetched. ${failed.join(' ')}`, {
            hint: first.hint,
            status: first.status,
            retryAfterSec: first.retryAfterSec,
            cause: first,
          }),
          first.attempts,
        );
      }
      setBusy('Making the .zip');
      saveBlob(await zipCaptions(files), captionFileName(title, '', 'zip'));
      setFailures(failed);
    });

  const translate = () => {
    const language = target.trim();
    if (!language) return;
    void work(`Translating into ${language}`, async (signal) => {
      const file = await fetchCaption({ url, language, format, timestamps, translate: true }, { ...call, signal });
      saveBlob(new Blob([file.text], { type: file.mimeType }), captionFileName(title, language, ext, { translated: true }));
    });
  };

  return (
    <div className="space-y-5" data-testid="captions-video">
      <div>
        <h2 className="text-base font-semibold text-fg" data-testid="captions-title">
          {title}
        </h2>
        <p className="text-sm text-muted">
          {listing.tracks.length} language{listing.tracks.length === 1 ? '' : 's'} with captions. Nothing is transcribed here:
          these are the platform's own tracks.
        </p>
      </div>
      <FormatPicker
        formats={formats}
        format={format}
        onFormat={setFormat}
        timestamps={timestamps}
        onTimestamps={setTimestamps}
        disabled={!!busy}
      />
      {listing.tracks.length > 0 && (
        <ul className="divide-y divide-border rounded-v2c border border-border" data-testid="captions-tracks">
          {listing.tracks.map((t) => (
            <li key={t.language} className="flex flex-wrap items-center gap-3 px-4 py-3" data-language={t.language}>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-fg">
                  {t.name} <span className="font-mono text-xs text-muted">{t.language}</span>
                </p>
                <OriginBadge track={t} />
              </div>
              <Button variant="ghost" className="px-2.5 py-1" onClick={() => show(t)} disabled={!!busy}>
                <Eye className="size-3.5" aria-hidden /> Preview
              </Button>
              <Button variant="secondary" className="px-2.5 py-1" onClick={() => save(t)} disabled={!!busy}>
                <Download className="size-3.5" aria-hidden /> Save {ext}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {listing.tracks.length > 1 && (
          <Button variant="accent" onClick={saveAll} disabled={!!busy} data-testid="captions-save-all">
            <FileArchive className="size-4" aria-hidden /> Save all {listing.tracks.length} as .zip
          </Button>
        )}
      </div>
      <div className="space-y-2 rounded-v2c border border-border bg-surface-2 p-4">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
          <Languages className="size-4" aria-hidden /> Translate
        </h3>
        <p className="text-sm text-muted">
          Captions in a language the video has no track for: the platform's own translation when it offers one, otherwise an AI
          model on this server keeps every timestamp. Needs an LLM provider on the server when the platform cannot translate.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label htmlFor={targetId} className="space-y-1 text-sm">
            <span className="block font-medium text-fg">Language code</span>
            <input
              id={targetId}
              list={`${targetId}-list`}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="fr, es, pt-BR"
              className="w-40 rounded-v2c border border-border bg-surface px-3 py-2 text-sm text-fg"
              data-testid="captions-target"
              disabled={!!busy}
            />
          </label>
          <datalist id={`${targetId}-list`}>
            {targets.map((t) => (
              <option key={t.language} value={t.language}>
                {t.name}
              </option>
            ))}
          </datalist>
          <Button onClick={translate} disabled={!!busy || !target.trim()} data-testid="captions-translate">
            <Languages className="size-4" aria-hidden /> Translate and save
          </Button>
        </div>
      </div>
      {busy && (
        <div className="space-y-2" role="status" data-testid="captions-busy">
          <div className="flex flex-wrap items-center gap-3">
            <Spinner />
            <span className="text-sm text-fg">{busy}</span>
            <Button variant="ghost" onClick={() => abort.current?.abort()}>
              Cancel
            </Button>
          </div>
          {progress !== undefined && <ProgressBar value={progress} label={busy} />}
        </div>
      )}
      {error !== undefined && <ErrorPanel title="Those captions could not be fetched" error={error} />}
      {failures.length > 0 && (
        <div className="rounded-v2c border border-border bg-surface px-3 py-2 text-sm" data-testid="captions-failures">
          <p className="font-medium text-fg">Saved the rest; these could not be fetched:</p>
          <ul className="list-disc pl-5 text-muted">
            {failures.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      )}
      {preview && (
        <section aria-labelledby={`${targetId}-preview`} className="space-y-2" data-testid="captions-preview">
          <h3 id={`${targetId}-preview`} className="text-sm font-semibold text-fg">
            Preview: {preview.name} ({FORMAT_LABELS[format] ?? format})
          </h3>
          <section
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard
            tabIndex={0}
            aria-label={`${preview.name} captions`}
            className="max-h-96 overflow-auto rounded-v2c border border-border bg-surface-2"
          >
            <pre className="whitespace-pre-wrap px-3 py-2 font-mono text-xs text-fg">{preview.text}</pre>
          </section>
        </section>
      )}
    </div>
  );
}

type ItemState = { status: 'waiting' | 'working' | 'done' | 'failed'; message?: string };

function PlaylistCaptions({ url, formats, call }: { url: string; formats: FormatInfo[]; call: CallOptions }) {
  const [items, setItems] = useState<VideoRef[]>();
  const [error, setError] = useState<unknown>();
  const [format, setFormat] = useState(formats[0]?.id ?? 'srt');
  const [timestamps, setTimestamps] = useState(false);
  const [language, setLanguage] = useState('');
  const [state, setState] = useState<Record<string, ItemState>>({});
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const langId = useId();
  const callRef = useRef(call);
  callRef.current = call;
  const ext = formats.find((f) => f.id === format)?.extension ?? format;

  useEffect(() => {
    const ac = new AbortController();
    getItems(url, { ...callRef.current, signal: ac.signal }, CAPTION_LIST_LIMIT).then(setItems, (err) => {
      if (!isAbort(err)) setError(err);
    });
    return () => ac.abort();
  }, [url]);
  useEffect(() => () => abort.current?.abort(), []);

  const keyOf = (r: VideoRef) => r.url ?? r.id;
  const run = async () => {
    if (!items) return;
    const ac = new AbortController();
    abort.current = ac;
    setRunning(true);
    setState(Object.fromEntries(items.map((r) => [keyOf(r), { status: 'waiting' } as ItemState])));
    const files: { name: string; text: string }[] = [];
    try {
      // One at a time, so a long playlist never floods the server or the platform.
      for (const [i, r] of items.entries()) {
        const key = keyOf(r);
        setState((s) => ({ ...s, [key]: { status: 'working' } }));
        try {
          const file = await fetchCaption(
            { url: key, language: language.trim() || undefined, format, timestamps },
            { ...callRef.current, signal: ac.signal },
          );
          const n = String(i + 1).padStart(String(items.length).length, '0');
          files.push({ name: `${n} ${captionFileName(r.nativeId ?? r.id, language.trim() || undefined, ext)}`, text: file.text });
          setState((s) => ({ ...s, [key]: { status: 'done' } }));
        } catch (err) {
          if (isAbort(err)) throw err;
          setState((s) => ({ ...s, [key]: { status: 'failed', message: toAppError(err).message } }));
        }
      }
      if (files.length > 0) saveBlob(await zipCaptions(files), captionFileName('captions', language.trim() || undefined, 'zip'));
    } catch (err) {
      if (!isAbort(err)) setError(err);
    } finally {
      abort.current = null;
      setRunning(false);
    }
  };

  if (error) return <ErrorPanel error={error} title="Could not list the videos" />;
  if (!items) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted" role="status">
        <Spinner /> Listing the videos
      </p>
    );
  }
  const done = Object.values(state).filter((s) => s.status === 'done' || s.status === 'failed').length;
  return (
    <div className="space-y-4" data-testid="captions-playlist">
      <p className="flex items-center gap-2 text-sm text-fg">
        <ListVideo className="size-4 text-muted" aria-hidden />
        {items.length} video{items.length === 1 ? '' : 's'}
        {items.length >= CAPTION_LIST_LIMIT ? ` (the first ${CAPTION_LIST_LIMIT})` : ''}. Their captions are fetched one at a time
        and saved together as one .zip; videos without captions in that language are listed, not transcribed.
      </p>
      <div className="flex flex-wrap items-end gap-4">
        <FormatPicker
          formats={formats}
          format={format}
          onFormat={setFormat}
          timestamps={timestamps}
          onTimestamps={setTimestamps}
          disabled={running}
        />
        <label htmlFor={langId} className="space-y-1 text-sm">
          <span className="block font-medium text-fg">Language (blank: each video's own)</span>
          <input
            id={langId}
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            placeholder="en"
            className="w-40 rounded-v2c border border-border bg-surface px-3 py-2 text-sm text-fg"
            disabled={running}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {running ? (
          <>
            <Spinner />
            <span className="text-sm text-fg" role="status">
              {done} of {items.length}
            </span>
            <Button variant="ghost" onClick={() => abort.current?.abort()}>
              Stop
            </Button>
          </>
        ) : (
          <Button variant="accent" onClick={() => void run()} data-testid="captions-playlist-start">
            <FileArchive className="size-4" aria-hidden /> Save captions for all {items.length} as .zip
          </Button>
        )}
      </div>
      {running && <ProgressBar value={(done / items.length) * 100} label="Captions fetched" />}
      <ol className="divide-y divide-border rounded-v2c border border-border" data-testid="captions-playlist-items">
        {items.map((r, i) => {
          const s = state[keyOf(r)];
          return (
            <li key={keyOf(r)} className="flex items-center gap-3 px-4 py-2 text-sm" data-status={s?.status ?? 'idle'}>
              <span className="w-6 shrink-0 text-right text-xs text-subtle tabular-nums">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-fg">{shortInput(keyOf(r), 80)}</span>
              {s?.status === 'working' && <Spinner />}
              {s?.status === 'done' && <span className="text-xs text-success">Saved</span>}
              {s?.status === 'failed' && (
                <span className="max-w-[50%] truncate text-xs text-danger" title={s.message}>
                  {s.message}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Loads the listing (or finds that the link is a list), the formats and the title, then shows the right panel. */
export function CaptionsResult({ url, call = {} }: { url: string; call?: CallOptions }) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const callRef = useRef(call);
  callRef.current = call;

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt reloads on "Try again"
  useEffect(() => {
    const ac = new AbortController();
    const c = { ...callRef.current, signal: ac.signal };
    setLoaded({ kind: 'loading' });
    (async () => {
      const formats = await getCaptionFormats(c);
      try {
        const [listing, metadata] = await Promise.all([
          getCaptionLanguages(url, c),
          requestJson<VideoMetadata>('GET', '/metadata', { url }, undefined, c).catch((err: unknown) => {
            if (isAbort(err)) throw err;
            return undefined;
          }),
        ]);
        setLoaded({ kind: 'video', listing, formats, title: metadata?.title || shortInput(url, 60) });
      } catch (err) {
        if (isListError(err)) setLoaded({ kind: 'list', formats });
        else throw err;
      }
    })().catch((err) => {
      if (!isAbort(err)) setLoaded({ kind: 'error', error: err });
    });
    return () => ac.abort();
  }, [url, attempt]);

  if (loaded.kind === 'loading') {
    return (
      <p className="flex items-center gap-2 py-6 text-sm text-muted" role="status">
        <Spinner /> Looking up the caption tracks
      </p>
    );
  }
  if (loaded.kind === 'error') {
    return (
      <ErrorPanel title="Could not list the captions" error={loaded.error} onRetry={() => setAttempt((n) => n + 1)} showSettings>
        <p className="text-sm text-muted">
          The run page can still get a transcript: from your browser with the extension, from a file on your device, or from audio
          the server downloads.{' '}
          <a
            href={appHref(runSearch({ url }))}
            onClick={(e) => onAppLinkClick(e, runSearch({ url }))}
            className="text-fg underline underline-offset-2"
          >
            Open the run page
          </a>
        </p>
      </ErrorPanel>
    );
  }
  if (loaded.kind === 'list') return <PlaylistCaptions url={url} formats={loaded.formats} call={call} />;
  if (loaded.listing.tracks.length === 0) {
    return (
      <Card className="space-y-2 p-5" data-testid="captions-none">
        <h2 className="text-base font-semibold text-fg">{loaded.title}</h2>
        <p className="text-sm text-fg">This video has no caption tracks.</p>
        {loaded.listing.notes.map((n) => (
          <p key={n} className="text-sm text-muted">
            {n}
          </p>
        ))}
        <a
          href={appHref(runSearch({ url, mode: 'stt' }))}
          onClick={(e) => onAppLinkClick(e, runSearch({ url, mode: 'stt' }))}
          className={buttonClass('accent')}
        >
          Transcribe the audio instead
        </a>
      </Card>
    );
  }
  return <VideoCaptions url={url} listing={loaded.listing} formats={loaded.formats} title={loaded.title} call={call} />;
}

export function CaptionsPage({ url }: { url?: string }) {
  const api = useOptionalApiStatus()?.state;
  const clientOnly = !api || isClientOnly(api);
  const onSubmit = useCallback((u: string) => navigate(captionsSearch(u)), []);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-fg">
          <Captions className="size-5" aria-hidden /> Captions
        </h1>
        <p className="mt-1 text-sm text-muted">
          Save a video's subtitles or captions on their own, in any language it has, as SRT, WebVTT, text or JSON. A playlist or
          channel link saves every video's captions in one .zip.
        </p>
      </div>
      <UrlForm
        key={url ?? ''}
        onSubmit={onSubmit}
        initial={url}
        submitLabel="Find captions"
        formLabel="Video, playlist or channel link"
      />
      {clientOnly ? (
        <p className="text-sm text-muted" data-testid="captions-needs-api">
          Listing caption tracks needs a vid2context server. Set the API base in{' '}
          <a href={appHref('?view=settings')} onClick={(e) => onAppLinkClick(e, '?view=settings')} className="text-fg underline">
            Settings
          </a>
          , or paste the link on the home page to import a transcript from your browser.
        </p>
      ) : (
        url && <CaptionsResult key={url} url={url} />
      )}
    </div>
  );
}

export default CaptionsPage;
