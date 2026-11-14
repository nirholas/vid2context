import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type DownloadProgress, ProgressTracker, parseLine } from '../src/progress.ts';

const lines = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean);

// Recorded from a real two-stream download (160 video + 140 audio) of Big Buck Bunny at 144p.
const stdout = lines('progress-bbb-144p-mp4.stdout.txt');
const stderr = lines('progress-bbb-144p-mp4.stderr.txt');

describe('parseLine', () => {
  it('reads the plan, download, postprocess and file lines and ignores everything else', () => {
    expect(parseLine(stdout[0] as string)).toEqual({ type: 'plan', formatId: '160+140', totalBytes: 14_595_389, ext: 'mp4' });
    expect(parseLine('v2c:dl:downloading:1024:4323893:NA:NA:NA:160')).toEqual({
      type: 'download',
      status: 'downloading',
      downloadedBytes: 1024,
      totalBytes: 4_323_893,
      formatId: '160',
    });
    expect(parseLine('v2c:pp:started:Merger')).toEqual({ type: 'postprocess', status: 'started', step: 'Merger' });
    expect(parseLine('v2c:file:/tmp/vid2context-dl-Xq3c9Z/a0/media.mp4')).toEqual({
      type: 'file',
      path: '/tmp/vid2context-dl-Xq3c9Z/a0/media.mp4',
    });
    expect(parseLine('WARNING: Unknown codec iamf.001.001.Opus')).toBeUndefined();
    expect(parseLine('v2c:other:1')).toBeUndefined();
  });

  it('keeps colons in file paths (Windows drive letters)', () => {
    expect(parseLine('v2c:file:C:\\Users\\a\\media.mp4')).toEqual({ type: 'file', path: 'C:\\Users\\a\\media.mp4' });
  });
});

describe('ProgressTracker on a recorded download', () => {
  it('counts both streams against the planned total so the percentage only goes up', () => {
    const t = new ProgressTracker();
    const seen: DownloadProgress[] = [];
    for (const line of [...stdout, ...stderr]) {
      const e = parseLine(line);
      if (e && t.apply(e)) seen.push(t.progress);
    }
    const percents = seen.filter((p) => p.phase === 'downloading').map((p) => p.percent ?? 0);
    expect(percents.length).toBeGreaterThan(10);
    for (let i = 1; i < percents.length; i++) expect(percents[i]).toBeGreaterThanOrEqual(percents[i - 1] as number);
    const lastDownload = seen.filter((p) => p.phase === 'downloading').at(-1);
    expect(lastDownload?.downloadedBytes).toBe(4_323_893 + 10_271_496);
    expect(lastDownload?.totalBytes).toBe(14_595_389);
    // The postprocessors that matter are reported; MoveFiles is not.
    expect(seen.filter((p) => p.phase === 'processing').map((p) => p.step)).toEqual([
      'ThumbnailsConvertor',
      'Merger',
      'VideoRemuxer',
      'Metadata',
      'EmbedThumbnail',
    ]);
    expect(t.files).toEqual(['/tmp/vid2context-dl-Xq3c9Z/a0/media.mp4']);
    expect(t.finish(14_963_212)).toMatchObject({ phase: 'finished', percent: 100, totalBytes: 14_963_212, formatId: '160+140' });
  });
});
