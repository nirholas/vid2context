import { FORMAT_FILE_NAMES, formatters } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { describeFile, fileText, formatterForFile, resultBundle, viewFiles } from '../src/lib/bundle.ts';
import { sharedContext } from './helpers.ts';

const createdAt = new Date('2026-11-14T16:00:00.000Z');

function expectedName(id: string): string {
  const f = formatters[id];
  return FORMAT_FILE_NAMES[id] ?? `${id}.${f?.extension}`;
}

describe('the bundle files', () => {
  it('has one file per formatter in the core formatters map, context.md first', async () => {
    const files = viewFiles(await resultBundle([sharedContext('youtube-jNQXAC9IVRw')], { createdAt }));
    const paths = files.map((f) => f.path);
    for (const id of Object.keys(formatters)) expect(paths).toContain(expectedName(id));
    expect(paths[0]).toBe('context.md');
    expect(paths).toContain('metadata.json');
    expect(paths.slice(-2)).toEqual(['README.md', 'manifest.json']);
  });

  it('adds chapters.md only for videos with chapters, and comments.md only with comments', async () => {
    const zoo = viewFiles(await resultBundle([sharedContext('youtube-jNQXAC9IVRw')], { createdAt })).map((f) => f.path);
    const gwagon = viewFiles(await resultBundle([sharedContext('youtube-cCPsdFdlshc')], { createdAt })).map((f) => f.path);
    expect(zoo).toContain('chapters.md');
    expect(gwagon).not.toContain('chapters.md');
    expect(zoo).not.toContain('comments.md');
  });

  it('writes transcript.txt with [m:ss] lines when asked, and keeps manifest.json in step', async () => {
    const context = sharedContext('youtube-jNQXAC9IVRw');
    const plain = await resultBundle([context], { createdAt });
    const stamped = await resultBundle([context], { createdAt, timestamps: true });
    const txt = (b: typeof plain) => fileText(b.files.find((f) => f.path === 'transcript.txt') as (typeof plain.files)[number]);
    expect(txt(plain)).not.toMatch(/^\[\d/);
    expect(txt(stamped).split('\n')[0]).toMatch(/^\[0:01\] All right/);
    const entry = stamped.manifest.files.find((f) => f.path === 'transcript.txt');
    const bytes = stamped.files.find((f) => f.path === 'transcript.txt')?.bytes as Uint8Array;
    expect(entry?.bytes).toBe(bytes.length);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
    expect(entry?.sha256).toBe(Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join(''));
    const manifestFile = JSON.parse(fileText(stamped.files.find((f) => f.path === 'manifest.json') as (typeof plain.files)[number]));
    expect(manifestFile.files.find((f: { path: string }) => f.path === 'transcript.txt').sha256).toBe(entry?.sha256);
    const zip = new Uint8Array(await new Response(stamped.zip()).arrayBuffer());
    expect(String.fromCharCode(zip[0] as number, zip[1] as number)).toBe('PK');
  });

  it('describes formatter files with the formatter description', () => {
    expect(formatterForFile('transcript.srt')?.id).toBe('srt');
    expect(describeFile('transcript.srt')).toBe(formatters.srt?.description);
    expect(describeFile('videos/01-x/metadata.json')).toContain('JSON');
  });

  it('builds one combined bundle for several videos', async () => {
    const bundle = await resultBundle([sharedContext('youtube-jNQXAC9IVRw'), sharedContext('youtube-cCPsdFdlshc')], { createdAt });
    const paths = bundle.files.map((f) => f.path);
    expect(bundle.root).toBe('vid2context-2-videos');
    expect(paths).toContain('index.md');
    expect(paths).toContain('llms.txt');
    expect(paths.some((p) => p.startsWith('videos/01-'))).toBe(true);
    expect(paths.some((p) => p.startsWith('videos/02-'))).toBe(true);
  });
});
