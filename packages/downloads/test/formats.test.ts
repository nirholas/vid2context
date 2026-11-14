import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type MediaInfo, mediaOptions, pickAudio, pickVideo } from '../src/formats.ts';
import type { VideoContainer } from '../src/options.ts';

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const bbb = JSON.parse(readFileSync(fixture('info-youtube-aqz-KE-bpKQ.json'), 'utf8')) as MediaInfo;
const zoo = JSON.parse(readFileSync(fixture('info-youtube-jNQXAC9IVRw.json'), 'utf8')) as MediaInfo;

/** yt-dlp's own picks for the same info dumps (picks-youtube.tsv, recorded with --print format_id). */
const picks = readFileSync(fixture('picks-youtube.tsv'), 'utf8')
  .trim()
  .split('\n')
  .slice(1)
  .map((line) => {
    const [video, container, quality, formatId] = line.split('\t') as [string, string, string, string];
    return { video, container, quality, formatId };
  });

const infoFor = (video: string) => (video === 'aqz-KE-bpKQ' ? bbb : zoo);
const AUDIO_PREF: Record<VideoContainer, string | undefined> = { mp4: 'aac', webm: 'opus', mkv: undefined };

describe('stream picks match yt-dlp', () => {
  const video = picks.filter((p) => ['mp4', 'webm', 'mkv'].includes(p.container));
  it.each(video)('$video $container $quality -> $formatId', ({ video, container, quality, formatId }) => {
    const formats = infoFor(video).formats ?? [];
    const limit = quality === 'best' ? Number.POSITIVE_INFINITY : Number(quality);
    const v = pickVideo(formats, limit, container as VideoContainer);
    expect(v).toBeDefined();
    const hasAudio = !!v?.acodec && v.acodec !== 'none';
    const a = hasAudio ? undefined : pickAudio(formats, AUDIO_PREF[container as VideoContainer]);
    expect(a ? `${v?.format_id}+${a.format_id}` : v?.format_id).toBe(formatId);
  });

  const audio = picks.filter((p) => ['mp3', 'm4a', 'opus'].includes(p.container));
  it.each(audio)('$video $container -> $formatId', ({ video, container, formatId }) => {
    const pref = container === 'm4a' ? 'aac' : container === 'opus' ? 'opus' : undefined;
    expect(pickAudio(infoFor(video).formats ?? [], pref)?.format_id).toBe(formatId);
  });
});

describe('mediaOptions', () => {
  it('lists every quality the 4K video offers, with codecs and sizes per container', () => {
    const o = mediaOptions(bbb);
    expect(o.title).toBe('Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film');
    expect(o.durationSec).toBe(635);
    expect(o.video.map((v) => `${v.quality}:${v.label}`)).toEqual([
      'best:2160p60',
      '1440:1440p60',
      '1080:1080p60',
      '720:720p60',
      '480:480p',
      '360:360p',
      '240:240p',
      '144:144p',
    ]);
    const hd = o.video.find((v) => v.quality === '1080');
    expect(hd?.codecs).toEqual({ mp4: 'h264 + aac', webm: 'vp9 + opus', mkv: 'av1 + opus' });
    // 299 (257,619,653 bytes) + 140 (10,271,496 bytes), both exact sizes from YouTube.
    expect(hd?.sizes.mp4).toBe(257_619_653 + 10_271_496);
    // Format 18 carries its own sound: its approximate size alone.
    expect(o.video.find((v) => v.quality === '360')?.sizes.mp4).toBe(28_526_904);
    expect(o.canRemoveSegments).toBe(true);
    expect(o.isLive).toBe(false);
  });

  it('marks m4a and opus as copies of the original streams and estimates mp3 from the duration', () => {
    const o = mediaOptions(bbb);
    const m4a = o.audio.find((a) => a.format === 'm4a');
    expect(m4a).toMatchObject({ method: 'copy', kbps: 129, sizeBytes: 10_271_496 });
    expect(o.audio.find((a) => a.format === 'opus')).toMatchObject({ method: 'copy', sizeBytes: 10_202_210 });
    expect(o.audio.find((a) => a.format === 'mp3' && a.quality === '128')?.sizeBytes).toBe(Math.round((128_000 * 635) / 8));
    expect(o.audio.find((a) => a.format === 'wav')?.label).toBe('WAV (48 kHz, 16-bit)');
  });

  it('collapses limits that land on the same stream, for small old videos', () => {
    const o = mediaOptions(zoo);
    expect(o.video.map((v) => `${v.quality}:${v.label}`)).toEqual(['best:240p', '144:144p']);
    expect(o.chapters.map((c) => c.title)).toEqual(['Intro', 'The cool thing', 'End']);
    expect(o.subtitles.filter((s) => !s.auto).map((s) => s.language)).toEqual(['en', 'de']);
    expect(o.subtitles.some((s) => s.language.endsWith('-orig'))).toBe(false);
  });

  it('still answers for sources without a format list', () => {
    const o = mediaOptions({ title: 'Direct file', duration: 10 });
    expect(o.video).toEqual([]);
    expect(o.audio.map((a) => a.format)).toContain('mp3');
    expect(o.canRemoveSegments).toBe(false);
  });
});
