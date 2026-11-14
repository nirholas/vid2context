/** Plain-text summaries shared by the CLI and the MCP tools. Runtime-neutral. */
import type { MediaOptions } from './formats.ts';
import { clock } from './options.ts';

/** "12.3 MB" (one decimal under 10 MB), or "?" when unknown. */
export function mb(bytes: number | undefined): string {
  return bytes === undefined ? '?' : `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;
}

/** A compact, readable summary of the options: the agent rarely needs every field. */
export function optionsSummary(o: MediaOptions): string {
  const lines = [
    `Title: ${o.title}`,
    o.channel ? `Channel: ${o.channel}` : undefined,
    o.durationSec ? `Duration: ${clock(o.durationSec)}` : undefined,
    o.isLive ? 'Live now: cannot be downloaded until it ends.' : undefined,
    o.video.length
      ? `Video (quality: mp4 / webm / mkv, estimated):\n${o.video
          .map(
            (v) =>
              `  ${v.quality.padEnd(5)} ${v.label.padEnd(8)} ${mb(v.sizes.mp4)} / ${mb(v.sizes.webm)} / ${mb(v.sizes.mkv)}  [mp4: ${v.codecs.mp4 ?? '?'}]`,
          )
          .join('\n')}`
      : 'Video: none (audio only)',
    `Audio (estimated):\n${o.audio.map((a) => `  ${a.format.padEnd(4)} ${a.quality.padEnd(4)} ${mb(a.sizeBytes).padStart(8)}  ${a.label}`).join('\n')}`,
    o.chapters.length
      ? `Chapters:\n${o.chapters.map((c, i) => `  ${i}. ${clock(c.startSec)} ${c.title}`).join('\n')}`
      : undefined,
    o.subtitles.length
      ? `Subtitles: ${
          o.subtitles
            .filter((s) => !s.auto)
            .map((s) => s.language)
            .join(', ') || 'none from the creator'
        }${o.subtitles.some((s) => s.auto) ? ' (plus automatic captions)' : ''}`
      : undefined,
    o.canRemoveSegments ? 'SponsorBlock: sponsor segments can be cut (removeSegments).' : undefined,
  ];
  return lines.filter(Boolean).join('\n');
}
