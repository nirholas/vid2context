/**
 * The download choices: video or audio, format, quality with estimated sizes,
 * which part to keep, what to embed, subtitles burned into the picture, and
 * one file per chapter. Controlled: the parent owns the
 * settings, so the playlist page can apply one set of choices to every item.
 * Without `options` (a playlist) the qualities come from the server's list
 * and no sizes are shown.
 */
import { AudioLines, Film } from 'lucide-react';
import { useId } from 'react';
import {
  AUDIO_FORMATS,
  type DownloadSettings,
  FORMAT_LABELS,
  type MediaOptions,
  VIDEO_CONTAINERS,
  type VideoContainer,
  withKind,
} from '../../lib/downloads.ts';
import { formatBytes, formatDuration } from '../../lib/format.ts';

const FIELD = 'w-full rounded-v2c border border-border bg-surface-2 px-3 py-2 text-sm text-fg focus-visible:outline-2';
const LABEL = 'text-xs font-medium text-muted';
const SEG = 'inline-flex items-center gap-1.5 rounded-v2c-sm px-3 py-1.5 text-sm transition';
const SEG_ON = 'bg-surface text-fg shadow-v2c';
const SEG_OFF = 'text-muted hover:text-fg';

const VIDEO_QUALITY_FALLBACK = ['best', '2160', '1440', '1080', '720', '480', '360', '240', '144'];
const AUDIO_QUALITY_FALLBACK = ['best', '320', '256', '192', '160', '128', '96', '64'];

function size(bytes: number | undefined): string {
  return bytes === undefined ? '' : `, about ${formatBytes(bytes)}`;
}

/** The quality menu entries for the current kind and format. */
export function qualityChoices(
  settings: Pick<DownloadSettings, 'kind' | 'format'>,
  options?: MediaOptions,
  qualities?: { video: string[]; audio: string[] },
): { value: string; label: string }[] {
  if (settings.kind === 'video') {
    if (options && options.video.length > 0) {
      return options.video.map((v) => ({
        value: v.quality,
        label: `${v.quality === 'best' ? `Best (${v.label})` : v.label}${v.hdr ? ' HDR' : ''}${size(v.sizes[settings.format as VideoContainer])}`,
      }));
    }
    return (qualities?.video ?? VIDEO_QUALITY_FALLBACK).map((q) => ({
      value: q,
      label: q === 'best' ? 'Best available' : `Up to ${q}p`,
    }));
  }
  if (options) {
    const list = options.audio.filter((a) => a.format === settings.format);
    if (list.length > 0) return list.map((a) => ({ value: a.quality, label: `${a.label}${size(a.sizeBytes)}` }));
  }
  if (settings.format !== 'mp3') return [{ value: 'best', label: 'Original quality' }];
  return (qualities?.audio ?? AUDIO_QUALITY_FALLBACK).map((q) => ({
    value: q,
    label: q === 'best' ? 'Best (VBR, about 245 kbps)' : `${q} kbps`,
  }));
}

export function DownloadForm({
  settings,
  onChange,
  options,
  qualities,
  disabled,
}: {
  settings: DownloadSettings;
  onChange: (s: DownloadSettings) => void;
  options?: MediaOptions;
  qualities?: { video: string[]; audio: string[] };
  disabled?: boolean;
}) {
  const id = useId();
  const set = (patch: Partial<DownloadSettings>) => onChange({ ...settings, ...patch });
  const hasVideo = !options || options.video.length > 0;
  const formats = settings.kind === 'video' ? VIDEO_CONTAINERS : AUDIO_FORMATS;
  const choices = qualityChoices(settings, options, qualities);
  const chapters = options?.chapters ?? [];
  const subtitles = options?.subtitles ?? [];

  return (
    <fieldset className="m-0 min-w-0 space-y-4 border-0 p-0" disabled={disabled}>
      <legend className="sr-only">Download options</legend>

      <div className="flex flex-wrap items-center gap-3">
        <fieldset className="m-0 inline-flex rounded-v2c border-0 bg-surface-3 p-1">
          <legend className="sr-only">Download as</legend>
          <button
            type="button"
            aria-pressed={settings.kind === 'video'}
            disabled={!hasVideo}
            title={hasVideo ? undefined : 'This source has no picture'}
            onClick={() => onChange(withKind(settings, 'video', options))}
            className={`${SEG} ${settings.kind === 'video' ? SEG_ON : SEG_OFF} disabled:opacity-40`}
          >
            <Film className="size-4" aria-hidden /> Video
          </button>
          <button
            type="button"
            aria-pressed={settings.kind === 'audio'}
            onClick={() => onChange(withKind(settings, 'audio', options))}
            className={`${SEG} ${settings.kind === 'audio' ? SEG_ON : SEG_OFF}`}
          >
            <AudioLines className="size-4" aria-hidden /> Audio
          </button>
        </fieldset>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5">
          <span className={LABEL}>Format</span>
          <select
            className={FIELD}
            value={settings.format}
            onChange={(e) => {
              const format = e.target.value;
              // Bitrates belong to mp3; other audio formats keep the source.
              set({ format, ...(settings.kind === 'audio' && format !== 'mp3' ? { quality: 'best' } : {}) });
            }}
          >
            {formats.map((f) => (
              <option key={f} value={f}>
                {FORMAT_LABELS[f]}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1.5">
          <span className={LABEL}>Quality</span>
          <select className={FIELD} value={settings.quality} onChange={(e) => set({ quality: e.target.value })}>
            {choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="space-y-2">
        <span className={LABEL} id={`${id}-part`}>
          Part
        </span>
        <div role="radiogroup" aria-labelledby={`${id}-part`} className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {(
            [['all', 'Whole video'], ['range', 'From and to'], ...(chapters.length > 0 ? [['chapter', 'One chapter']] : [])] as [
              DownloadSettings['part'],
              string,
            ][]
          ).map(([value, label]) => (
            <label key={value} className="inline-flex cursor-pointer items-center gap-2 text-fg">
              <input type="radio" name={`${id}-part`} checked={settings.part === value} onChange={() => set({ part: value })} />
              {label}
            </label>
          ))}
        </div>
        {settings.part === 'range' && (
          <div className="grid max-w-md grid-cols-2 gap-3">
            <label className="block space-y-1.5">
              <span className={LABEL}>From</span>
              <input
                className={FIELD}
                inputMode="numeric"
                placeholder="0:00"
                value={settings.from}
                onChange={(e) => set({ from: e.target.value })}
              />
            </label>
            <label className="block space-y-1.5">
              <span className={LABEL}>To</span>
              <input
                className={FIELD}
                inputMode="numeric"
                placeholder={options?.durationSec ? formatDuration(options.durationSec) : 'end'}
                value={settings.to}
                onChange={(e) => set({ to: e.target.value })}
              />
            </label>
          </div>
        )}
        {settings.part === 'chapter' && chapters.length > 0 && (
          <label className="block max-w-md space-y-1.5">
            <span className={LABEL}>Chapter</span>
            <select className={FIELD} value={settings.chapter} onChange={(e) => set({ chapter: e.target.value })}>
              {chapters.map((c, i) => (
                <option key={`${c.startSec}-${c.title}`} value={String(i)}>
                  {formatDuration(c.startSec)} {c.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <details className="group rounded-v2c border border-border px-3 py-2">
        <summary className="cursor-pointer text-sm text-fg">More options</summary>
        <div className="mt-3 space-y-3 pb-1">
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-fg">
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.embedThumbnail}
                onChange={(e) => set({ embedThumbnail: e.target.checked })}
              />
              Cover art
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.embedMetadata}
                onChange={(e) => set({ embedMetadata: e.target.checked })}
              />
              Title and channel tags
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.embedChapters}
                onChange={(e) => set({ embedChapters: e.target.checked })}
              />
              Chapter markers
            </label>
            {chapters.length > 0 && (
              <label
                className="inline-flex items-center gap-2"
                title="Needs the whole video; a trimmed part has no chapters to split by."
              >
                <input
                  type="checkbox"
                  checked={settings.splitChapters && settings.part === 'all'}
                  disabled={settings.part !== 'all'}
                  onChange={(e) => set({ splitChapters: e.target.checked })}
                  data-testid="split-chapters"
                />
                Also one file per chapter ({chapters.length})
              </label>
            )}
            {(!options || options.canRemoveSegments) && (
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={settings.removeSponsors}
                  onChange={(e) => set({ removeSponsors: e.target.checked })}
                />
                Cut sponsor segments (SponsorBlock)
              </label>
            )}
          </div>
          {settings.kind === 'video' && subtitles.length > 0 && (
            <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
              <label className="block space-y-1.5">
                <span className={LABEL}>Embed subtitles (a track you can turn on and off)</span>
                <select className={FIELD} value={settings.subtitles} onChange={(e) => set({ subtitles: e.target.value })}>
                  <option value="">None</option>
                  {subtitles.map((s) => (
                    <option key={`${s.language}-${s.auto}`} value={s.language}>
                      {s.name ? `${s.name} (${s.language})` : s.language}
                      {s.auto ? ', automatic' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1.5">
                <span className={LABEL}>Burn into the picture (always visible)</span>
                <select
                  className={FIELD}
                  value={settings.burnSubtitles}
                  onChange={(e) => set({ burnSubtitles: e.target.value })}
                  data-testid="burn-subtitles"
                >
                  <option value="">None</option>
                  {subtitles.map((s) => (
                    <option key={`${s.language}-${s.auto}`} value={s.language}>
                      {s.name ? `${s.name} (${s.language})` : s.language}
                      {s.auto ? ', automatic' : ''}
                    </option>
                  ))}
                </select>
              </label>
              {settings.burnSubtitles && (
                <p className="text-xs text-subtle sm:col-span-2">
                  Burning in re-encodes the whole video, so it takes longer than the download itself. Use it for players and sites
                  that cannot show a subtitle track.
                </p>
              )}
            </div>
          )}
          <p className="text-xs text-subtle">
            {settings.kind === 'video' && settings.format === 'mp4'
              ? 'MP4 prefers H.264 and stereo AAC so the file plays on every device. Above 1080p sites usually offer only VP9 or AV1.'
              : settings.kind === 'audio' && settings.format !== 'mp3'
                ? 'This format keeps the original stream when the site has one, so there is no quality loss.'
                : 'Trimmed files get no chapter markers, because the chapter times would no longer fit.'}
          </p>
        </div>
      </details>
    </fieldset>
  );
}
