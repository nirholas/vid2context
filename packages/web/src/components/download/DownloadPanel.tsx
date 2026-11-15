/**
 * Download one video or its audio: read the qualities and sizes the server
 * finds, pick, start, follow the job, save. When the server has the media
 * toolkit, tabs add captions only, frame grabs and an animated clip, and a
 * thumbnail row saves the cover image. Used on the result page and on the
 * Download page.
 */
import { Download, ImageDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CallOptions } from '../../lib/api.ts';
import {
  buildBody,
  DEFAULT_SETTINGS,
  type DownloadJob,
  type DownloadSettings,
  type DownloadStatus,
  fitQuality,
  getMediaOptions,
  type MediaOptions,
  startDownload,
  thumbnailUrl,
} from '../../lib/downloads.ts';
import { isAbort } from '../../lib/errors.ts';
import { formatDuration } from '../../lib/format.ts';
import { ErrorPanel } from '../ErrorPanel.tsx';
import { type TabDef, Tabs } from '../Tabs.tsx';
import { Button, buttonClass, Spinner } from '../ui.tsx';
import { DownloadForm } from './DownloadForm.tsx';
import { DownloadJobView, POLL_MS } from './DownloadJobView.tsx';
import { CaptionsTool, ClipTool, FramesTool } from './MediaTools.tsx';
import { useToolkit } from './use-toolkit.ts';

/** Start from the defaults, fitted to what this video offers (audio for audio-only sources). */
export function initialSettings(options: MediaOptions, base: DownloadSettings = DEFAULT_SETTINGS): DownloadSettings {
  if (options.video.length === 0)
    return { ...base, kind: 'audio', format: 'mp3', quality: 'best', subtitles: '', burnSubtitles: '' };
  return { ...base, quality: fitQuality(options, base.kind, base.quality) };
}

export function DownloadPanel({
  url,
  status,
  call = {},
  pollMs = POLL_MS,
  showTitle = false,
  onError,
}: {
  url: string;
  status: DownloadStatus;
  call?: CallOptions;
  pollMs?: number;
  /** Show the video's title and length above the form (the Download page; the result page already has them). */
  showTitle?: boolean;
  /** Called when the options cannot be read, so a page can react (a playlist URL is expanded instead). */
  onError?: (err: unknown) => boolean | undefined;
}) {
  const [options, setOptions] = useState<MediaOptions>();
  const [error, setError] = useState<unknown>();
  const [settings, setSettings] = useState<DownloadSettings>(DEFAULT_SETTINGS);
  const [job, setJob] = useState<DownloadJob>();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<unknown>();
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState('media');
  const [thumbFormat, setThumbFormat] = useState('jpg');
  const toolkit = useToolkit(call);
  const callRef = useRef(call);
  callRef.current = call;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the retry trigger.
  useEffect(() => {
    const ctrl = new AbortController();
    setOptions(undefined);
    setError(undefined);
    getMediaOptions(url, { ...callRef.current, signal: ctrl.signal }).then(
      (o) => {
        setOptions(o);
        setSettings((s) => initialSettings(o, s));
      },
      (err) => {
        if (isAbort(err)) return;
        if (onErrorRef.current?.(err)) return;
        setError(err);
      },
    );
    return () => ctrl.abort();
  }, [url, attempt]);

  const start = async () => {
    setStarting(true);
    setStartError(undefined);
    try {
      setJob(await startDownload(buildBody(url, settings), callRef.current));
    } catch (err) {
      setStartError(err);
    } finally {
      setStarting(false);
    }
  };

  if (error)
    return <ErrorPanel error={error} title="Could not read the download options" onRetry={() => setAttempt((n) => n + 1)} />;
  if (!options) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted" role="status">
        <Spinner /> Reading qualities and sizes
      </p>
    );
  }

  const media = job ? (
    <DownloadJobView job={job} call={call} pollMs={pollMs} onReset={() => setJob(undefined)} />
  ) : (
    <div className="space-y-4">
      <DownloadForm
        settings={settings}
        onChange={setSettings}
        options={options}
        qualities={status.qualities}
        disabled={starting}
      />
      {startError ? <ErrorPanel error={startError} title="The download did not start" /> : null}
      <Button variant="accent" onClick={start} disabled={starting} data-testid="download-start">
        {starting ? <Spinner /> : <Download className="size-4" aria-hidden />}
        Download {settings.kind === 'video' ? 'video' : 'audio'}
      </Button>
    </div>
  );

  return (
    <div className="space-y-4" data-testid="download-panel">
      {showTitle && (
        <div className="flex items-start gap-3">
          {options.thumbnailUrl && (
            <img
              src={options.thumbnailUrl}
              alt=""
              className="aspect-video w-32 shrink-0 rounded-v2c-sm bg-surface-3 object-cover"
            />
          )}
          <div className="min-w-0">
            <p className="font-medium text-fg" data-testid="download-title">
              {options.title}
            </p>
            <p className="text-sm text-muted">
              {[options.channel, options.durationSec ? formatDuration(options.durationSec) : undefined]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
        </div>
      )}
      {options.isLive ? (
        <p className="text-sm text-fg">This is a live stream. It can be downloaded once it has ended.</p>
      ) : toolkit ? (
        <Tabs
          label="What to save"
          active={tab}
          onChange={setTab}
          tabs={
            [
              { id: 'media', label: options.video.length > 0 ? 'Video or audio' : 'Audio', render: () => media },
              {
                id: 'captions',
                label: 'Captions',
                render: () => <CaptionsTool url={url} toolkit={toolkit} options={options} call={call} pollMs={pollMs} />,
              },
              ...(options.video.length > 0
                ? [
                    {
                      id: 'frames',
                      label: 'Frames',
                      render: () => <FramesTool url={url} toolkit={toolkit} options={options} call={call} pollMs={pollMs} />,
                    },
                    {
                      id: 'clip',
                      label: 'GIF or WebP',
                      render: () => <ClipTool url={url} toolkit={toolkit} options={options} call={call} pollMs={pollMs} />,
                    },
                  ]
                : []),
            ] satisfies TabDef[]
          }
        />
      ) : (
        media
      )}
      {status.thumbnailFormats && status.thumbnailFormats.length > 0 && !options.isLive && (
        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="thumbnail-row">
          <span className="text-muted">Thumbnail</span>
          <select
            aria-label="Thumbnail format"
            className="rounded-v2c border border-border bg-surface-2 px-2 py-1 text-sm text-fg"
            value={thumbFormat}
            onChange={(e) => setThumbFormat(e.target.value)}
          >
            {status.thumbnailFormats.map((f) => (
              <option key={f} value={f}>
                {f.toUpperCase()}
              </option>
            ))}
          </select>
          <a
            href={thumbnailUrl(url, thumbFormat, false, call.base)}
            download
            className={`${buttonClass('secondary')} px-2.5 py-1`}
            data-testid="thumbnail-save"
          >
            <ImageDown className="size-3.5" aria-hidden /> Save image
          </a>
        </div>
      )}
      <p className="text-xs text-subtle" data-testid="download-notice">
        {status.notice}
      </p>
    </div>
  );
}
