/**
 * Attach context to the conversation. Server mode: paste a video URL (any
 * input the server accepts), pick from the library, pick a collection, or
 * upload a media file, each shown only when this server has the route.
 * Client-only mode: drop vid2context JSON files or paste a timed transcript,
 * because the browser cannot fetch captions from YouTube itself.
 */
import type { Collection, VideoContext, VideoSummary } from '@vid2context/core';
import { formatTimestamp } from '@vid2context/core';
import { ClipboardPaste, FileJson, Folder, Library, Link2, Upload } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { toErrorData } from '../lib/api.ts';
import type { BackendFeatures } from '../lib/backend.ts';
import { contextFromPaste, parseContextJson } from '../lib/local-context.ts';
import type { ChatErrorData } from '../lib/types.ts';
import { Button, cx, Dialog, Spinner } from './ui.tsx';

type Tab = 'link' | 'library' | 'collections' | 'upload' | 'json' | 'paste';

export interface AttachDialogProps {
  open: boolean;
  onClose: () => void;
  features: BackendFeatures;
  onLink: (input: string) => void;
  onLibrary: (item: VideoSummary) => void;
  onCollection: (id: string) => void;
  onUpload: (file: File) => Promise<void>;
  onLocal: (contexts: VideoContext[]) => Promise<void>;
  listLibrary: () => Promise<VideoSummary[]>;
  listCollections: () => Promise<Collection[]>;
}

const TABS: { id: Tab; label: string; icon: ReactNode; feature: keyof BackendFeatures }[] = [
  { id: 'link', label: 'Link', icon: <Link2 size={14} aria-hidden />, feature: 'link' },
  { id: 'library', label: 'Library', icon: <Library size={14} aria-hidden />, feature: 'library' },
  { id: 'collections', label: 'Collections', icon: <Folder size={14} aria-hidden />, feature: 'collections' },
  { id: 'upload', label: 'Upload', icon: <Upload size={14} aria-hidden />, feature: 'uploads' },
  { id: 'json', label: 'JSON files', icon: <FileJson size={14} aria-hidden />, feature: 'localFiles' },
  { id: 'paste', label: 'Paste transcript', icon: <ClipboardPaste size={14} aria-hidden />, feature: 'localFiles' },
];

export function AttachDialog(props: AttachDialogProps) {
  const tabs = TABS.filter((t) => props.features[t.feature]);
  const [tab, setTab] = useState<Tab>(tabs[0]?.id ?? 'link');
  const baseId = useId();
  useEffect(() => {
    if (props.open && !tabs.some((t) => t.id === tab)) setTab(tabs[0]?.id ?? 'link');
  }, [props.open, tabs, tab]);

  return (
    <Dialog open={props.open} title="Attach context" onClose={props.onClose} wide>
      <div role="tablist" aria-label="Ways to attach" className="mb-4 flex flex-wrap gap-1.5">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${baseId}-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`${baseId}-panel`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              const i = tabs.findIndex((x) => x.id === tab);
              const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
              if (next) {
                setTab(next.id);
                document.getElementById(`${baseId}-tab-${next.id}`)?.focus();
              }
            }}
            className={cx(
              'inline-flex items-center gap-1.5 rounded-pill border px-3 py-1 text-sm',
              tab === t.id ? 'border-accent bg-surface-3 text-fg' : 'border-border text-muted hover:text-fg',
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${tab}`}>
        {tab === 'link' ? <LinkTab onLink={props.onLink} /> : null}
        {tab === 'library' ? <LibraryTab list={props.listLibrary} onPick={props.onLibrary} /> : null}
        {tab === 'collections' ? <CollectionsTab list={props.listCollections} onPick={props.onCollection} /> : null}
        {tab === 'upload' ? <UploadTab onUpload={props.onUpload} /> : null}
        {tab === 'json' ? <JsonTab onLocal={props.onLocal} /> : null}
        {tab === 'paste' ? <PasteTab onLocal={props.onLocal} /> : null}
      </div>
    </Dialog>
  );
}

function ErrorText(props: { error?: ChatErrorData }) {
  if (!props.error) return null;
  return (
    <div role="alert" className="mt-3 rounded-md border border-danger/50 bg-danger/10 p-3 text-sm">
      <p>{props.error.message}</p>
      {props.error.hint ? <p className="mt-1 text-muted">{props.error.hint}</p> : null}
    </div>
  );
}

const inputClass =
  'w-full rounded-md border border-border-strong bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent';

function LinkTab(props: { onLink: (input: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const lines = value
          .split(/\s+/)
          .map((s) => s.trim())
          .filter(Boolean);
        for (const l of lines) props.onLink(l);
        setValue('');
      }}
    >
      <label className="block text-sm">
        <span className="mb-1.5 block text-muted">
          Video links or ids, one per line (YouTube, podcasts, anything the server accepts)
        </span>
        <textarea
          data-autofocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={3}
          placeholder="https://www.youtube.com/watch?v=..."
          className={cx(inputClass, 'resize-y font-mono')}
        />
      </label>
      <div className="mt-3 flex justify-end">
        <Button type="submit" variant="primary" disabled={!value.trim()}>
          Attach
        </Button>
      </div>
    </form>
  );
}

function useList<T>(load: () => Promise<T[]>) {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<ChatErrorData | undefined>();
  useEffect(() => {
    let live = true;
    load()
      .then((x) => live && setItems(x))
      .catch((err) => live && setError(toErrorData(err)));
    return () => {
      live = false;
    };
  }, [load]);
  return { items, error };
}

function LibraryTab(props: { list: () => Promise<VideoSummary[]>; onPick: (v: VideoSummary) => void }) {
  const { items, error } = useList(props.list);
  const [q, setQ] = useState('');
  if (error) return <ErrorText error={error} />;
  if (!items) return <Spinner label="Loading library" />;
  const shown = items.filter((v) => `${v.title} ${v.channel ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <input
        data-autofocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Filter by title or channel"
        aria-label="Filter library"
        className={inputClass}
      />
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-muted">The library is empty. Attach a link first; fetched videos are saved there.</p>
      ) : null}
      <ul className="mt-3 flex flex-col gap-1">
        {shown.map((v) => (
          <li key={v.id}>
            <button
              type="button"
              onClick={() => props.onPick(v)}
              className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-surface-3"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{v.title}</span>
                <span className="block truncate text-xs text-muted">
                  {[v.channel, v.durationSec ? formatTimestamp(v.durationSec) : undefined, v.origin].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span className="shrink-0 text-xs text-accent">Attach</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CollectionsTab(props: { list: () => Promise<Collection[]>; onPick: (id: string) => void }) {
  const { items, error } = useList(props.list);
  if (error) return <ErrorText error={error} />;
  if (!items) return <Spinner label="Loading collections" />;
  if (items.length === 0)
    return <p className="text-sm text-muted">No collections yet. Create one in the vid2context app or with the CLI.</p>;
  return (
    <div>
      <p className="mb-2 text-sm text-muted">A conversation can use one collection; picking another replaces it.</p>
      <ul className="flex flex-col gap-1">
        {items.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => props.onPick(c.id)}
              className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-surface-3"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{c.name}</span>
                <span className="block truncate text-xs text-muted">
                  {c.videoIds.length} videos{c.description ? ` · ${c.description}` : ''}
                </span>
              </span>
              <span className="shrink-0 text-xs text-accent">Attach</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FileDrop(props: {
  accept: string;
  label: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  busy?: boolean;
}) {
  const [over, setOver] = useState(false);
  const id = useId();
  return (
    <label
      htmlFor={id}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = [...e.dataTransfer.files];
        if (files.length) props.onFiles(files);
      }}
      className={cx(
        'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center text-sm',
        over ? 'border-accent bg-surface-3' : 'border-border-strong hover:bg-surface-2',
      )}
    >
      {props.busy ? <Spinner label="Reading" /> : <Upload size={20} className="text-muted" aria-hidden />}
      <span>{props.label}</span>
      <span className="text-xs text-muted">Drop here, or click to choose</span>
      <input
        id={id}
        data-autofocus
        type="file"
        accept={props.accept}
        multiple={props.multiple}
        className="v2c-sr-only"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          if (files.length) props.onFiles(files);
          e.target.value = '';
        }}
      />
    </label>
  );
}

function UploadTab(props: { onUpload: (file: File) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ChatErrorData | undefined>();
  return (
    <div>
      <FileDrop
        accept="audio/*,video/*"
        label="Upload an audio or video file. The server transcribes it; it is not saved to the library unless you save the result."
        busy={busy}
        onFiles={async (files) => {
          const f = files[0];
          if (!f) return;
          setBusy(true);
          setError(undefined);
          try {
            await props.onUpload(f);
          } catch (err) {
            setError(toErrorData(err));
          } finally {
            setBusy(false);
          }
        }}
      />
      <ErrorText error={error} />
    </div>
  );
}

function JsonTab(props: { onLocal: (contexts: VideoContext[]) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ChatErrorData | undefined>();
  return (
    <div>
      <FileDrop
        accept=".json,application/json"
        multiple
        label="vid2context JSON: the output of --format json, or context.json from a bundle"
        busy={busy}
        onFiles={async (files) => {
          setBusy(true);
          setError(undefined);
          try {
            const all: VideoContext[] = [];
            for (const f of files) all.push(...parseContextJson(await f.text(), f.name));
            await props.onLocal(all);
          } catch (err) {
            setError(toErrorData(err));
          } finally {
            setBusy(false);
          }
        }}
      />
      <p className="mt-3 text-xs text-muted">
        Make one with <code className="font-mono">npx vid2context &lt;url&gt; --format json &gt; video.json</code>. Files stay in
        this browser.
      </p>
      <ErrorText error={error} />
    </div>
  );
}

function PasteTab(props: { onLocal: (contexts: VideoContext[]) => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<ChatErrorData | undefined>();
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError(undefined);
        try {
          await props.onLocal([contextFromPaste({ title, url, text })]);
        } catch (err) {
          setError(toErrorData(err));
        }
      }}
      className="flex flex-col gap-3"
    >
      <label className="block text-sm">
        <span className="mb-1 block text-muted">Title</span>
        <input
          data-autofocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className={inputClass}
          placeholder="What the video is called"
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-muted">Video link (optional; a YouTube link makes citations open the video)</span>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className={cx(inputClass, 'font-mono')}
          placeholder="https://www.youtube.com/watch?v=..."
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-muted">
          Transcript with timestamps (YouTube "Show transcript", SRT, WebVTT, or "[1:05] text" lines)
        </span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          className={cx(inputClass, 'resize-y font-mono')}
        />
      </label>
      <ErrorText error={error} />
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={!text.trim()}>
          Attach transcript
        </Button>
      </div>
    </form>
  );
}
