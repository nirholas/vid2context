import { describe, expect, it } from 'vitest';
import { audioQualityArg, downloadArgs, formatChoice, PROGRESS_TEMPLATES, sectionSpec } from '../src/args.ts';
import { normalizeRequest } from '../src/options.ts';

const URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const COMMON = ['--ignore-config', '--no-color', '--no-progress'];
const plan = { common: COMMON, outTemplate: '/tmp/job/media.%(ext)s', url: URL };

describe('formatChoice', () => {
  it('prefers stereo, H.264 for mp4 and VP9 + Opus for webm, capped at the quality', () => {
    expect(formatChoice({ kind: 'video', format: 'mp4', quality: '1080' })).toEqual({
      format: 'bv*+ba/b',
      sort: 'res:1080,vcodec:h264,channels:2,acodec:aac',
    });
    expect(formatChoice({ kind: 'video', format: 'webm', quality: 'best' }).sort).toBe('res,vcodec:vp9,channels:2,acodec:opus');
    expect(formatChoice({ kind: 'video', format: 'mkv', quality: '720' }).sort).toBe('res:720,channels:2');
  });

  it('keeps the original AAC or Opus stream for m4a and opus', () => {
    expect(formatChoice({ kind: 'audio', format: 'm4a', quality: 'best' })).toEqual({
      format: 'ba/b',
      sort: 'channels:2,acodec:aac',
    });
    expect(formatChoice({ kind: 'audio', format: 'opus', quality: 'best' }).sort).toBe('channels:2,acodec:opus');
    expect(formatChoice({ kind: 'audio', format: 'mp3', quality: '320' }).sort).toBe('channels:2');
  });

  it('maps audio quality to yt-dlp values', () => {
    expect(audioQualityArg({ format: 'mp3', quality: 'best' })).toBe('0');
    expect(audioQualityArg({ format: 'mp3', quality: '192' })).toBe('192K');
    expect(audioQualityArg({ format: 'flac', quality: 'best' })).toBeUndefined();
  });
});

describe('downloadArgs', () => {
  it('builds the full argv for the default video, ending with -- and the URL', () => {
    const args = downloadArgs(normalizeRequest({ url: URL }), plan);
    expect(args).toEqual([
      ...COMMON,
      '--progress',
      '--newline',
      '--no-simulate',
      '--no-playlist',
      '--no-warnings',
      '--no-mtime',
      '--windows-filenames',
      '--trim-filenames',
      '160',
      ...PROGRESS_TEMPLATES,
      '-f',
      'bv*+ba/b',
      '-S',
      'res:1080,vcodec:h264,channels:2,acodec:aac',
      '--merge-output-format',
      'mp4/mkv',
      '--remux-video',
      'mp4',
      '--embed-metadata',
      '--embed-thumbnail',
      '--convert-thumbnails',
      'jpg',
      '--embed-chapters',
      '-o',
      '/tmp/job/media.%(ext)s',
      '--',
      URL,
    ]);
  });

  it('extracts audio at the asked bitrate and loads saved info instead of the URL', () => {
    const args = downloadArgs(normalizeRequest({ url: URL, format: 'mp3', quality: '192' }), {
      ...plan,
      infoJson: '/tmp/job/info.json',
    });
    expect(args).toContain('-x');
    expect(args.slice(args.indexOf('--audio-format'), args.indexOf('--audio-format') + 4)).toEqual([
      '--audio-format',
      'mp3',
      '--audio-quality',
      '192K',
    ]);
    expect(args.slice(-2)).toEqual(['--load-info-json', '/tmp/job/info.json']);
    expect(args).not.toContain(URL);
  });

  it('drops chapters on trimmed files and adds sections, exact cuts and SponsorBlock', () => {
    const req = normalizeRequest({ url: URL, from: '1:00', to: '1:10', exactCuts: true, removeSegments: 'sponsor,intro' });
    const args = downloadArgs(req, { ...plan, section: { fromSec: 60, toSec: 70 }, maxFilesizeBytes: 1048576 });
    expect(args).toContain('--no-embed-chapters');
    expect(args).not.toContain('--embed-chapters');
    expect(args.slice(args.indexOf('--download-sections'), args.indexOf('--download-sections') + 3)).toEqual([
      '--download-sections',
      '*60-70',
      '--force-keyframes-at-cuts',
    ]);
    expect(args.slice(args.indexOf('--sponsorblock-remove'), args.indexOf('--sponsorblock-remove') + 2)).toEqual([
      '--sponsorblock-remove',
      'sponsor,intro',
    ]);
    expect(args.slice(args.indexOf('--max-filesize'), args.indexOf('--max-filesize') + 2)).toEqual(['--max-filesize', '1048576']);
  });

  it('embeds subtitles in videos unless told to skip them', () => {
    const req = normalizeRequest({ url: URL, subtitles: 'en,de' });
    expect(downloadArgs(req, plan).join(' ')).toContain('--write-subs --write-auto-subs --sub-langs en,de --embed-subs');
    expect(downloadArgs(req, { ...plan, skipSubtitles: true })).not.toContain('--embed-subs');
  });

  it('never asks for cover art where yt-dlp cannot write it', () => {
    expect(downloadArgs(normalizeRequest({ url: URL, format: 'webm' }), plan)).not.toContain('--embed-thumbnail');
    const wav = downloadArgs(normalizeRequest({ url: URL, format: 'wav' }), plan);
    expect(wav).not.toContain('--embed-thumbnail');
    expect(wav).toContain('--no-embed-metadata');
  });

  it('writes open-ended sections', () => {
    expect(sectionSpec({ fromSec: 30 })).toBe('*30-inf');
    expect(sectionSpec({ toSec: 12.5 })).toBe('*0-12.5');
  });
});
