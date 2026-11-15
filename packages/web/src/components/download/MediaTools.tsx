/**
 * The media toolkit tabs of the download panel: captions only (any track,
 * several at once, a machine translation, or speech-to-text when there are
 * none), frame grabs at chosen times, and an animated GIF or WebP clip. Each
 * starts a server task and follows it with the same job view as a download.
 */
import { Captions, Film, Image as ImageIcon } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { CallOptions } from '../../lib/api.ts';
import {
  type AnyJob,
  type CaptionFormatInfo,
  type CaptionTracks,
  getCaptionTracks,
  type MediaOptions,
  startTask,
  type TaskRoute,
  type ToolkitInfo,
} from '../../lib/downloads.ts';
import { isAbort } from '../../lib/errors.ts';
import { formatDuration } from '../../lib/format.ts';
import { ErrorPanel } from '../ErrorPanel.tsx';
import { Button, Spinner } from '../ui.tsx';
import { DownloadJobView, POLL_MS } from './DownloadJobView.tsx';

const FIELD = 'w-full rounded-v2c border border-border bg-surface-2 px-3 py-2 text-sm text-fg focus-visible:outline-2';
const LABEL = 'text-xs font-medium text-muted';

interface ToolProps {
  url: string;
  toolkit: ToolkitInfo;
  options?: MediaOptions;
  call?: CallOptions;
  pollMs?: number;
}

/** Start a task, then follow it; the form comes back with "Download another". */
function useTask(call: CallOptions) {
  const [job, setJob] = useState<AnyJob>();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<unknown>();
  const callRef = useRef(call);
  callRef.current = call;
  const start = async (route: TaskRoute, body: Record<string, unknown>) => {
    setStarting(true);
    setError(undefined);
    try {
      setJob(await startTask(route, body, callRef.current));
    } catch (err) {
      setError(err);
    } finally {
      setStarting(false);
    }
  };
  return { job, starting, error, start, reset: () => setJob(undefined) };
}

function TaskShell({
  task,
  call,
  pollMs,
  children,
}: {
  task: ReturnType<typeof useTask>;
  call: CallOptions;
  pollMs: number;
  children: ReactNode;
}) {
  if (task.job) return <DownloadJobView job={task.job} call={call} pollMs={pollMs} onReset={task.reset} />;
  return (
    <fieldset className="m-0 min-w-0 space-y-4 border-0 p-0" disabled={task.starting}>
      {children}
      {task.error ? <ErrorPanel error={task.error} title="That did not start" /> : null}
    </fieldset>
  );
}

/** "0:05, 1:30" from seconds, for a time list the user can still edit. */
export function timesFromSeconds(list: number[]): string {
  return list.map((s) => formatDuration(Math.max(0, Math.floor(s)))).join(', ');
}

// ---------------------------------------------------------------- captions

/** "SubRip (.srt)" from "SubRip (.srt) captions: at most 2 lines...": the name up to its extension, for a menu. */
export function shortFormatLabel(label: string): string {
  const named = /^[^(:]*\([^)]*\)/.exec(label);
  if (named) return named[0].trim();
  const cut = label.split(/[:.](\s|$)/)[0] ?? label;
  return cut.length > 48 ? `${cut.slice(0, 47)}\u2026` : cut;
}

export interface CaptionChoices {
  languages: string[];
  all: boolean;
  translateTo: string;
  format: string;
  mode: string;
  timestamps: boolean;
  zip: boolean;
  /** Seconds to shift every caption (negative: earlier), as typed. Timed formats only. */
  offset?: string;
  /** Line layout, as typed; blank keeps the server's default (42 characters, 2 lines). Timed formats only. */
  maxLineChars?: string;
  maxLines?: string;
  /** A second language shown under each caption. Bilingual formats only. */
  secondary?: string;
}

/** The POST /downloads/captions body for these choices. Nothing chosen asks for the spoken language. */
export function captionsBody(url: string, c: CaptionChoices, format?: CaptionFormatInfo): Record<string, unknown> {
  const languages = c.all ? ['all'] : [...new Set([...c.languages, ...(c.translateTo ? [c.translateTo] : [])])];
  const timed = !!format?.timed;
  const offset = Number(c.offset);
  return {
    url,
    ...(languages.length > 0 ? { languages } : {}),
    format: c.format,
    mode: c.mode,
    ...(c.format === 'txt' && c.timestamps ? { timestamps: true } : {}),
    ...(timed && c.offset?.trim() && Number.isFinite(offset) && offset !== 0 ? { offsetSec: offset } : {}),
    ...(timed && c.maxLineChars?.trim() ? { maxLineChars: Number(c.maxLineChars) } : {}),
    ...(timed && c.maxLines?.trim() ? { maxLines: Number(c.maxLines) } : {}),
    ...(format?.bilingual && c.secondary ? { secondary: c.secondary } : {}),
    ...(c.zip ? { zip: true } : {}),
  };
}

export function CaptionsTool({ url, toolkit, call = {}, pollMs = POLL_MS }: ToolProps) {
  const task = useTask(call);
  const [tracks, setTracks] = useState<CaptionTracks>();
  const [loadError, setLoadError] = useState<unknown>();
  const [attempt, setAttempt] = useState(0);
  const [languages, setLanguages] = useState<string[]>([]);
  const [all, setAll] = useState(false);
  const [translateTo, setTranslateTo] = useState('');
  const [format, setFormat] = useState(toolkit.captions.defaults.format || 'srt');
  const [mode, setMode] = useState(toolkit.captions.defaults.mode || 'auto');
  const [timestamps, setTimestamps] = useState(false);
  const [zip, setZip] = useState(false);
  const [offset, setOffset] = useState('');
  const [maxLineChars, setMaxLineChars] = useState('');
  const [maxLines, setMaxLines] = useState('');
  const [secondary, setSecondary] = useState('');
  const callRef = useRef(call);
  callRef.current = call;

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the retry trigger.
  useEffect(() => {
    const ctrl = new AbortController();
    setTracks(undefined);
    setLoadError(undefined);
    getCaptionTracks(url, { ...callRef.current, signal: ctrl.signal }).then(
      (t) => {
        setTracks(t);
        // Preselect the creator's track when there is exactly one, so one click gets the obvious file.
        const creator = t.tracks.filter((x) => !x.auto);
        setLanguages(creator.length === 1 && creator[0] ? [creator[0].language] : []);
      },
      (err) => {
        if (!isAbort(err)) setLoadError(err);
      },
    );
    return () => ctrl.abort();
  }, [url, attempt]);

  if (loadError)
    return <ErrorPanel error={loadError} title="Could not list the caption tracks" onRetry={() => setAttempt((n) => n + 1)} />;
  if (!tracks) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted" role="status">
        <Spinner /> Listing caption tracks
      </p>
    );
  }

  const formats: CaptionFormatInfo[] = tracks.formats.length > 0 ? tracks.formats : toolkit.captions.formats;
  const current = formats.find((f) => f.id === format);
  const layout = toolkit.captions.layout;
  // Languages a second line can come from: the video's own tracks, then what the platform can translate into.
  const secondChoices = [
    ...tracks.tracks.map((t) => ({ language: t.language, name: t.name || t.language })),
    ...tracks.translationTargets.filter((t) => !tracks.tracks.some((x) => x.language === t.language)),
  ];
  const chosen = all ? tracks.tracks.length : languages.length + (translateTo && !languages.includes(translateTo) ? 1 : 0);
  const toggle = (lang: string) => setLanguages((l) => (l.includes(lang) ? l.filter((x) => x !== lang) : [...l, lang]));

  return (
    <TaskShell task={task} call={call} pollMs={pollMs}>
      <legend className="sr-only">Captions and subtitles</legend>
      {tracks.tracks.length > 0 ? (
        <div className="space-y-2">
          <fieldset className="m-0 flex flex-wrap gap-x-4 gap-y-1.5 border-0 p-0 text-sm" data-testid="caption-tracks">
            <legend className={`${LABEL} mb-2 w-full`}>Languages</legend>
            <label className="inline-flex items-center gap-2 font-medium text-fg">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
              All languages ({tracks.tracks.length})
            </label>
            {tracks.tracks.map((t) => (
              <label key={`${t.language}-${t.auto}`} className="inline-flex items-center gap-2 text-fg">
                <input
                  type="checkbox"
                  disabled={all}
                  checked={all || languages.includes(t.language)}
                  onChange={() => toggle(t.language)}
                />
                {t.name || t.language}
                <span className="text-xs text-muted">
                  {t.language}
                  {t.auto ? ', automatic' : ''}
                </span>
              </label>
            ))}
          </fieldset>
          {chosen === 0 && <p className="text-xs text-subtle">Nothing ticked: you get the spoken language.</p>}
        </div>
      ) : (
        <p className="text-sm text-fg" data-testid="caption-none">
          This video has no caption tracks.{' '}
          {tracks.speechToText
            ? 'Speech-to-text can write them from the audio (choose "Captions, else speech-to-text" or "Speech-to-text").'
            : 'This server has no speech-to-text set up, so it cannot write them.'}
        </p>
      )}
      {tracks.notes.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">
          {tracks.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5">
          <span className={LABEL}>Format</span>
          <select className={FIELD} value={format} onChange={(e) => setFormat(e.target.value)}>
            {formats.map((f) => (
              <option key={f.id} value={f.id} title={f.label}>
                {shortFormatLabel(f.label)}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1.5">
          <span className={LABEL}>Source</span>
          <select className={FIELD} value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="auto">Captions, else speech-to-text</option>
            <option value="captions">Captions only</option>
            <option value="stt">Speech-to-text from the audio</option>
          </select>
        </label>
        {tracks.translationTargets.length > 0 && !all && (
          <label className="block space-y-1.5 sm:col-span-2">
            <span className={LABEL}>Add a machine translation</span>
            <select className={FIELD} value={translateTo} onChange={(e) => setTranslateTo(e.target.value)}>
              <option value="">None</option>
              {tracks.translationTargets.map((t) => (
                <option key={t.language} value={t.language}>
                  {t.name} ({t.language})
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {(current?.timed || current?.bilingual) && (
        <details className="rounded-v2c border border-border px-3 py-2" data-testid="caption-extras">
          <summary className="cursor-pointer text-sm text-fg">Timing, line length and a second language</summary>
          <div className="mt-3 grid gap-3 pb-1 sm:grid-cols-2">
            {current?.bilingual && secondChoices.length > 0 && (
              <label className="block space-y-1.5 sm:col-span-2">
                <span className={LABEL}>Second language under each caption (bilingual subtitles)</span>
                <select className={FIELD} value={secondary} onChange={(e) => setSecondary(e.target.value)}>
                  <option value="">None</option>
                  {secondChoices.map((t) => (
                    <option key={t.language} value={t.language}>
                      {t.name} ({t.language})
                    </option>
                  ))}
                </select>
              </label>
            )}
            {current?.timed && (
              <>
                <label className="block space-y-1.5">
                  <span className={LABEL}>Shift every caption by (seconds, negative is earlier)</span>
                  <input
                    className={FIELD}
                    inputMode="decimal"
                    placeholder="0"
                    value={offset}
                    onChange={(e) => setOffset(e.target.value.replace(/[^\d.-]/g, ''))}
                  />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block space-y-1.5">
                    <span className={LABEL}>
                      Characters per line{layout ? ` (${layout.maxLineChars.min} to ${layout.maxLineChars.max})` : ''}
                    </span>
                    <input
                      className={FIELD}
                      inputMode="numeric"
                      placeholder="42"
                      value={maxLineChars}
                      onChange={(e) => setMaxLineChars(e.target.value.replace(/\D/g, ''))}
                    />
                  </label>
                  <label className="block space-y-1.5">
                    <span className={LABEL}>
                      Lines per caption{layout ? ` (${layout.maxLines.min} to ${layout.maxLines.max})` : ''}
                    </span>
                    <input
                      className={FIELD}
                      inputMode="numeric"
                      placeholder="2"
                      value={maxLines}
                      onChange={(e) => setMaxLines(e.target.value.replace(/\D/g, ''))}
                    />
                  </label>
                </div>
              </>
            )}
          </div>
        </details>
      )}
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-fg">
        {format === 'txt' && (
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} />
            Timestamps on each line
          </label>
        )}
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={zip || chosen > 1} disabled={chosen > 1} onChange={(e) => setZip(e.target.checked)} />
          As a .zip{chosen > 1 ? ' (always, for several languages)' : ''}
        </label>
      </div>
      <Button
        variant="accent"
        data-testid="captions-start"
        onClick={() =>
          task.start(
            'captions',
            captionsBody(
              url,
              { languages, all, translateTo, format, mode, timestamps, zip, offset, maxLineChars, maxLines, secondary },
              current,
            ),
          )
        }
      >
        {task.starting ? <Spinner /> : <Captions className="size-4" aria-hidden />}
        Download captions
      </Button>
    </TaskShell>
  );
}

// ---------------------------------------------------------------- frames

export function FramesTool({ url, toolkit, options, call = {}, pollMs = POLL_MS }: ToolProps) {
  const task = useTask(call);
  const chapters = options?.chapters ?? [];
  const duration = options?.durationSec;
  const [times, setTimes] = useState(() =>
    duration ? timesFromSeconds([duration * 0.1, duration * 0.5, duration * 0.9]) : '0:05',
  );
  const [format, setFormat] = useState(toolkit.frames.defaults.format || 'png');
  const [width, setWidth] = useState('');
  const [zip, setZip] = useState(false);
  const count = times.split(/[,\s]+/).filter(Boolean).length;
  const tooMany = count > toolkit.frames.maxFrames;

  return (
    <TaskShell task={task} call={call} pollMs={pollMs}>
      <legend className="sr-only">Frame grabs</legend>
      <label className="block space-y-1.5">
        <span className={LABEL}>Times (seconds, m:ss or h:mm:ss, separated by commas)</span>
        <input className={FIELD} value={times} onChange={(e) => setTimes(e.target.value)} data-testid="frames-times" />
      </label>
      <div className="flex flex-wrap gap-2">
        {chapters.length > 0 && (
          <Button
            variant="secondary"
            className="px-2.5 py-1"
            onClick={() => setTimes(timesFromSeconds(chapters.map((c) => c.startSec)))}
          >
            Each chapter start ({chapters.length})
          </Button>
        )}
        {duration ? (
          <Button
            variant="secondary"
            className="px-2.5 py-1"
            onClick={() => setTimes(timesFromSeconds(Array.from({ length: 10 }, (_, i) => (duration * (i + 0.5)) / 10)))}
          >
            10 evenly spaced
          </Button>
        ) : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5">
          <span className={LABEL}>Format</span>
          <select className={FIELD} value={format} onChange={(e) => setFormat(e.target.value)}>
            {toolkit.frames.formats.map((f) => (
              <option key={f} value={f}>
                {f === 'png' ? 'PNG (lossless)' : f === 'jpg' ? 'JPEG (smaller)' : f.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1.5">
          <span className={LABEL}>Width in pixels (blank keeps the video's)</span>
          <input
            className={FIELD}
            inputMode="numeric"
            value={width}
            onChange={(e) => setWidth(e.target.value.replace(/\D/g, ''))}
          />
        </label>
      </div>
      <label className="inline-flex items-center gap-2 text-sm text-fg">
        <input type="checkbox" checked={zip || count > 1} disabled={count > 1} onChange={(e) => setZip(e.target.checked)} />
        As a .zip{count > 1 ? ' (always, for several frames)' : ''}
      </label>
      {tooMany && (
        <p className="text-sm text-danger" role="alert">
          {count} times is more than this server grabs at once ({toolkit.frames.maxFrames}).
        </p>
      )}
      <Button
        variant="accent"
        disabled={count === 0 || tooMany}
        data-testid="frames-start"
        onClick={() =>
          task.start('frames', { url, times, format, ...(width ? { width: Number(width) } : {}), ...(zip ? { zip: true } : {}) })
        }
      >
        {task.starting ? <Spinner /> : <ImageIcon className="size-4" aria-hidden />}
        Grab {count === 1 ? 'frame' : `${count} frames`}
      </Button>
    </TaskShell>
  );
}

// ---------------------------------------------------------------- clip

/** Seconds from "90", "1:30" or "1:02:03"; NaN when unreadable. */
export function clockSeconds(text: string): number {
  const t = text.trim();
  if (!t) return Number.NaN;
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(t)) return Number.NaN;
  return t.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}

export function ClipTool({ url, toolkit, options, call = {}, pollMs = POLL_MS }: ToolProps) {
  const task = useTask(call);
  const d = toolkit.clips.defaults;
  const [from, setFrom] = useState('0:00');
  const [to, setTo] = useState(formatDuration(Math.min(d.lengthSec, options?.durationSec ?? d.lengthSec)));
  const [format, setFormat] = useState(d.format || 'gif');
  const [fps, setFps] = useState(String(d.fps));
  const [width, setWidth] = useState(String(d.width));
  const [loop, setLoop] = useState(true);
  const length = clockSeconds(to) - clockSeconds(from);
  const problem = Number.isNaN(length)
    ? 'Write the times as seconds, m:ss or h:mm:ss.'
    : length <= 0
      ? '"To" must come after "From".'
      : length > toolkit.clips.maxSec
        ? `Clips are at most ${toolkit.clips.maxSec} s here; this one is ${Math.round(length)} s.`
        : Number(fps) > toolkit.clips.maxFps
          ? `At most ${toolkit.clips.maxFps} frames per second.`
          : Number(width) > toolkit.clips.maxWidth
            ? `At most ${toolkit.clips.maxWidth} pixels wide.`
            : undefined;

  return (
    <TaskShell task={task} call={call} pollMs={pollMs}>
      <legend className="sr-only">Animated clip</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5">
          <span className={LABEL}>From</span>
          <input
            className={FIELD}
            inputMode="numeric"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            data-testid="clip-from"
          />
        </label>
        <label className="block space-y-1.5">
          <span className={LABEL}>To (at most {toolkit.clips.maxSec} s later)</span>
          <input className={FIELD} inputMode="numeric" value={to} onChange={(e) => setTo(e.target.value)} data-testid="clip-to" />
        </label>
        <label className="block space-y-1.5">
          <span className={LABEL}>Format</span>
          <select className={FIELD} value={format} onChange={(e) => setFormat(e.target.value)}>
            {toolkit.clips.formats.map((f) => (
              <option key={f} value={f}>
                {f === 'gif' ? 'GIF (plays everywhere)' : f === 'webp' ? 'WebP (much smaller)' : f.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1.5">
            <span className={LABEL}>Frames per second</span>
            <input
              className={FIELD}
              inputMode="numeric"
              value={fps}
              onChange={(e) => setFps(e.target.value.replace(/\D/g, ''))}
            />
          </label>
          <label className="block space-y-1.5">
            <span className={LABEL}>Width (px)</span>
            <input
              className={FIELD}
              inputMode="numeric"
              value={width}
              onChange={(e) => setWidth(e.target.value.replace(/\D/g, ''))}
            />
          </label>
        </div>
      </div>
      <label className="inline-flex items-center gap-2 text-sm text-fg">
        <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
        Loop forever
      </label>
      {problem && (
        <p className="text-sm text-danger" role="alert" data-testid="clip-problem">
          {problem}
        </p>
      )}
      <Button
        variant="accent"
        disabled={!!problem}
        data-testid="clip-start"
        onClick={() =>
          task.start('clips', {
            url,
            from: from.trim(),
            to: to.trim(),
            format,
            ...(fps ? { fps: Number(fps) } : {}),
            ...(width ? { width: Number(width) } : {}),
            loop,
          })
        }
      >
        {task.starting ? <Spinner /> : <Film className="size-4" aria-hidden />}
        Make {format.toUpperCase()}
      </Button>
    </TaskShell>
  );
}
