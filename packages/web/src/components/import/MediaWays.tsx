/**
 * The two import tabs that work from the video itself rather than from
 * captions (docs/contracts/transcript-import.md, "Media in the web app"):
 *
 *   MediaFile       a video or audio file from the user's device, transcribed on this device or on the server
 *   ServerDownload  the server downloads the audio with yt-dlp; the user saves it or transcribes it in this browser
 */
import { CloudDownload, Download, FileAudio, Laptop, Server } from 'lucide-react';
import { type ChangeEvent, useEffect, useId, useRef, useState } from 'react';
import { type DownloadJob, downloadFileUrl } from '../../lib/downloads.ts';
import { isAbort } from '../../lib/errors.ts';
import { formatBytes, formatDuration } from '../../lib/format.ts';
import {
  downloadAudioOnServer,
  fetchJobFile,
  jobStep,
  type MediaStep,
  mediaImportBody,
  type TranscribeWhere,
  transcribeMedia,
  ytdlpCommand,
} from '../../lib/media-import.ts';
import { useDownloadStatus } from '../download/use-download-status.ts';
import { Button, buttonClass, CopyButton, ProgressBar, Spinner } from '../ui.tsx';
import { Busy, type ImportPanelProps, type ImportState, InlineError } from './shared.tsx';

const MEDIA_ACCEPT = 'audio/*,video/*,.mp3,.m4a,.m4b,.aac,.wav,.ogg,.oga,.opus,.flac,.weba,.webm,.mp4,.m4v,.mov,.mkv,.3gp';

function WherePicker({
  where,
  onChange,
  clientOnly,
  disabled,
}: {
  where: TranscribeWhere;
  onChange: (w: TranscribeWhere) => void;
  clientOnly: boolean;
  disabled: boolean;
}) {
  const name = useId();
  const options: { id: TranscribeWhere; label: string; detail: string; icon: typeof Laptop }[] = [
    {
      id: 'browser',
      label: 'On this device',
      detail:
        'Free and private: the audio never leaves your computer. The first run downloads the Whisper model from huggingface.co and keeps it in this browser. A long video can take several minutes. Hosted speech-to-text keys saved in Settings are used too.',
      icon: Laptop,
    },
    ...(clientOnly
      ? []
      : [
          {
            id: 'server' as const,
            label: 'On the server',
            detail:
              "Uploads the audio (converted to 16 kHz mono in this browser first, so it stays small) and runs the server's speech-to-text chain. Needs the server's speech-to-text keys to work.",
            icon: Server,
          },
        ]),
  ];
  if (options.length === 1) return null;
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium text-fg">Where to transcribe</legend>
      {options.map((o) => (
        <label
          key={o.id}
          className="flex cursor-pointer items-start gap-2 rounded-v2c border border-border bg-surface px-3 py-2 has-[:checked]:border-border-strong"
        >
          <input
            type="radio"
            name={name}
            value={o.id}
            checked={where === o.id}
            onChange={() => onChange(o.id)}
            className="mt-1"
            data-testid={`media-where-${o.id}`}
          />
          <span className="min-w-0 text-sm">
            <span className="flex items-center gap-1.5 font-medium text-fg">
              <o.icon className="size-4" aria-hidden /> {o.label}
            </span>
            <span className="block text-muted">{o.detail}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function MediaFile({ props, state }: { props: ImportPanelProps; state: ImportState }) {
  const input = useRef<HTMLInputElement>(null);
  const [where, setWhere] = useState<TranscribeWhere>('browser');
  const [name, setName] = useState('');
  const command = ytdlpCommand(props.url);
  const commandId = useId();

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setName(`${file.name}, ${formatBytes(file.size)}`);
    void state.run(`Reading ${file.name}`, async (signal, onStep) => ({
      body: mediaImportBody(props.url, await transcribeMedia(file, where, { lang: props.lang, onStep }, signal), props.lang),
    }));
  };

  return (
    <div className="space-y-4 text-sm">
      <p className="text-muted">
        Have the video or its audio on your device? Pick it here and vid2context transcribes the speech itself, then attaches the
        transcript to this link with the video's title and details. Any format your browser plays works: mp4, webm, mov, mkv, mp3,
        m4a, wav, ogg, opus or flac.
      </p>
      <WherePicker where={where} onChange={setWhere} clientOnly={props.clientOnly} disabled={!!state.busy} />
      <input
        ref={input}
        type="file"
        accept={MEDIA_ACCEPT}
        className="sr-only"
        onChange={onFile}
        aria-label="Video or audio file"
        data-testid="media-file-input"
        tabIndex={-1}
      />
      {state.busy ? (
        <Busy state={state} />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="accent" onClick={() => input.current?.click()} data-testid="media-file">
            <FileAudio className="size-4" aria-hidden /> Choose a video or audio file
          </Button>
          {name && <span className="truncate text-xs text-muted">{name}</span>}
        </div>
      )}
      <details className="rounded-v2c border border-border bg-surface px-3 py-2">
        <summary className="cursor-pointer font-medium text-fg">Don't have the file? Download it on your own computer</summary>
        <div className="mt-2 space-y-2 text-muted">
          <p>
            YouTube rarely blocks home connections. With{' '}
            <a
              href="https://github.com/yt-dlp/yt-dlp#installation"
              target="_blank"
              rel="noreferrer"
              className="text-fg underline underline-offset-2"
            >
              yt-dlp
            </a>{' '}
            installed, this saves just the audio (about 1 MB per minute), then pick the file above:
          </p>
          <section
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard
            tabIndex={0}
            aria-label="yt-dlp command"
            className="overflow-x-auto rounded-v2c border border-border bg-surface-2"
          >
            <pre id={commandId} className="px-3 py-2 font-mono text-xs text-fg" data-testid="ytdlp-command">
              {command}
            </pre>
          </section>
          <CopyButton getText={() => command} label="Copy the command" describedBy={commandId} />
          {!props.clientOnly && <p>Or let the server try the download for you in the "Server download" tab.</p>}
        </div>
      </details>
    </div>
  );
}

type DownloadState =
  | { kind: 'idle' }
  | { kind: 'running'; step: MediaStep }
  | { kind: 'done'; job: DownloadJob }
  | { kind: 'error'; error: unknown };

export function ServerDownload({ props, state }: { props: ImportPanelProps; state: ImportState }) {
  const availability = useDownloadStatus();
  const [dl, setDl] = useState<DownloadState>({ kind: 'idle' });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const start = () => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setDl({ kind: 'running', step: { label: 'Asking the server to download the audio' } });
    downloadAudioOnServer(
      props.url,
      { onJob: (job) => !ac.signal.aborted && setDl({ kind: 'running', step: jobStep(job) }) },
      ac.signal,
    )
      .then((job) => !ac.signal.aborted && setDl({ kind: 'done', job }))
      .catch((error) => !ac.signal.aborted && !isAbort(error) && setDl({ kind: 'error', error }));
  };
  const cancel = () => {
    abort.current?.abort();
    abort.current = null;
    setDl({ kind: 'idle' });
  };
  const transcribe = (job: DownloadJob) =>
    void state.run('Fetching the audio from the server', async (signal, onStep) => {
      const file = await fetchJobFile(job, { onStep }, signal);
      return {
        body: mediaImportBody(
          props.url,
          await transcribeMedia(file, 'browser', { lang: props.lang, onStep }, signal),
          props.lang,
        ),
      };
    });

  if (availability.state === 'checking') {
    return (
      <p className="flex items-center gap-2 text-sm text-muted" role="status">
        <Spinner /> Checking whether this server can download media
      </p>
    );
  }
  if (availability.state === 'off') {
    return (
      <div className="space-y-2 text-sm" data-testid="server-download-off">
        <p className="text-fg">This server does not download media: {availability.reason}</p>
        <p className="text-muted">Use the "Video or audio file" tab with a file from your device instead.</p>
      </div>
    );
  }
  const { limits } = availability.status;
  return (
    <div className="space-y-4 text-sm" data-testid="server-download">
      <p className="text-muted">
        The server downloads the video's audio with yt-dlp. That often still works when YouTube refuses the server's caption
        requests. Then save the audio to your device, or transcribe it here in this browser with Whisper, free and with no keys.
        Videos up to {formatDuration(limits.maxDurationSec)} and {formatBytes(limits.maxBytes)}; the file stays on the server for{' '}
        {limits.ttlMin} min.
      </p>
      {dl.kind === 'idle' && (
        <Button variant="accent" onClick={start} data-testid="server-download-start">
          <CloudDownload className="size-4" aria-hidden /> Download the audio on the server
        </Button>
      )}
      {dl.kind === 'running' && (
        <div className="space-y-2" data-testid="server-download-busy">
          <div className="flex flex-wrap items-center gap-3" role="status">
            <Spinner />
            <span className="text-fg">
              {dl.step.label}
              {dl.step.percent !== undefined && <span className="tabular-nums text-muted"> {Math.round(dl.step.percent)}%</span>}
            </span>
            <Button variant="ghost" onClick={cancel}>
              Stop waiting
            </Button>
          </div>
          {dl.step.percent !== undefined && <ProgressBar value={dl.step.percent} label={dl.step.label} />}
        </div>
      )}
      {dl.kind === 'error' && (
        <div className="space-y-2">
          <InlineError error={dl.error} />
          <div className="flex flex-wrap gap-2">
            <Button onClick={start}>Try the download again</Button>
          </div>
          <p className="text-muted">
            If yt-dlp is blocked too, download the file on your own computer (the command is in the "Video or audio file" tab) and
            pick it there.
          </p>
        </div>
      )}
      {dl.kind === 'done' && dl.job.file && (
        <div className="space-y-3" data-testid="server-download-done">
          <p className="text-fg">
            Downloaded <span className="font-mono">{dl.job.file.filename}</span> ({formatBytes(dl.job.file.bytes)}
            {dl.job.file.durationSec ? `, ${formatDuration(dl.job.file.durationSec)}` : ''}).
          </p>
          {state.busy ? (
            <Busy state={state} />
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button variant="accent" onClick={() => transcribe(dl.job)} data-testid="server-download-transcribe">
                <Laptop className="size-4" aria-hidden /> Transcribe it in this browser
              </Button>
              <a href={downloadFileUrl(dl.job.id)} download={dl.job.file.filename} className={buttonClass('secondary')}>
                <Download className="size-4" aria-hidden /> Save to my device
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
