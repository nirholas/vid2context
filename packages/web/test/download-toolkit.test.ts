// @vitest-environment jsdom
/**
 * The media toolkit in the download section: captions only, frame grabs,
 * GIF/WebP clips, batches and chapter splits, on responses recorded from the
 * real routes, task queue and downloader with the public-domain Apollo 11
 * clips (scripts/record-toolkit-fixtures.ts, test/fixtures/README.md).
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Route as ReplayRoute, replayFetch } from '@vid2context/core/testing';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DownloadJobView } from '../src/components/download/DownloadJobView.tsx';
import { DownloadPanel } from '../src/components/download/DownloadPanel.tsx';
import { saveLabel } from '../src/components/download/JobResult.tsx';
import {
  CaptionsTool,
  ClipTool,
  captionsBody,
  clockSeconds,
  shortFormatLabel,
  timesFromSeconds,
} from '../src/components/download/MediaTools.tsx';
import { clearDownloadStatusCache } from '../src/components/download/use-download-status.ts';
import { clearToolkitCache } from '../src/components/download/use-toolkit.ts';
import { type ApiState, ApiStatusProvider } from '../src/lib/api-status.tsx';
import {
  type AnyJob,
  buildBody,
  DEFAULT_SETTINGS,
  type DownloadStatus,
  type MediaOptions,
  phaseLabel,
  stepLabel,
  type TaskJob,
  type ToolkitInfo,
} from '../src/lib/downloads.ts';
import { BASE, recorded } from './helpers.ts';

const body = <T>(name: string) => recorded(name).body as T;
const toolkit = body<ToolkitInfo>('toolkit.json');
const status = body<DownloadStatus>('downloads-status.json');
const MKV = 'packages/ffmpeg/test/fixtures/apollo11-first-steps-subs.mkv';
const MP4 = 'packages/ffmpeg/test/fixtures/apollo11-first-steps.mp4';

/** Serve recordings by method and path (query ignored), in order per path, the last repeating. */
function serve(...names: string[]) {
  const groups = new Map<string, ReturnType<typeof recorded>[]>();
  for (const name of names) {
    const r = recorded(name);
    const key = `${r.request.method} ${new URL(`${BASE}${r.request.path}`).pathname}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const routes: ReplayRoute[] = [...groups].map(([key, list]) => {
    const [method, pathname] = key.split(' ') as [string, string];
    let i = 0;
    return {
      method,
      url: (u: URL) => u.pathname === pathname,
      response: () => {
        const r = list[Math.min(i++, list.length - 1)] as ReturnType<typeof recorded>;
        return { status: r.status, headers: { 'content-type': r.contentType }, body: JSON.stringify(r.body) };
      },
    };
  });
  return replayFetch(routes);
}

const online: ApiState = { status: 'online', base: BASE, health: body('health.json') };
const wrap = (node: ReactNode) =>
  createElement(ApiStatusProvider, { initial: online } as { initial: ApiState; children: ReactNode }, node);

beforeEach(() => {
  clearDownloadStatusCache();
  clearToolkitCache();
});
afterEach(cleanup);

describe('labels and request bodies', () => {
  it('names processing steps, including batch items and captions', () => {
    expect(stepLabel('Burn subtitles')).toBe('Burning in subtitles');
    expect(stepLabel('2/5 Merger')).toBe('Item 2 of 5: Merging video and audio');
    expect(stepLabel('1/2')).toBe('Item 1 of 2');
    expect(stepLabel('Captions de')).toBe('Captions (de)');
    expect(stepLabel('Captions de (second language)')).toBe('Captions (de, second language)');
    expect(stepLabel('Captions default')).toBe('Captions (spoken language)');
    expect(stepLabel('Chapter 2 of 4')).toBe('Chapter 2 of 4');
  });

  it("shows a processing step's own percentage, and none while it is unknown", () => {
    const running = body<AnyJob>('toolkit-batch-running.json');
    expect(phaseLabel({ ...running, progress: { phase: 'processing', step: 'GIF', percent: 40, downloadedBytes: 0 } })).toBe(
      'Making the GIF 40%',
    );
    expect(phaseLabel({ ...running, progress: { phase: 'processing', step: 'Frames', downloadedBytes: 0 } })).toBe(
      'Grabbing frames',
    );
  });

  it('builds the captions body from the choices that apply to the format', () => {
    const formats = toolkit.captions.formats;
    const srt = formats.find((f) => f.id === 'srt');
    const markdown = formats.find((f) => f.id === 'markdown');
    const base = { languages: ['en'], all: false, translateTo: '', format: 'srt', mode: 'auto', timestamps: false, zip: false };
    expect(captionsBody(MKV, { ...base, offset: '-1.5', maxLineChars: '32', secondary: 'de' }, srt)).toEqual({
      url: MKV,
      languages: ['en'],
      format: 'srt',
      mode: 'auto',
      offsetSec: -1.5,
      maxLineChars: 32,
      secondary: 'de',
    });
    // markdown has no subtitle times and no second language: those choices are left out instead of refused by the server.
    expect(captionsBody(MKV, { ...base, format: 'markdown', offset: '2', secondary: 'de' }, markdown)).toEqual({
      url: MKV,
      languages: ['en'],
      format: 'markdown',
      mode: 'auto',
    });
    expect(captionsBody(MKV, { ...base, all: true, translateTo: 'fr' }, srt).languages).toEqual(['all']);
    expect(captionsBody(MKV, { ...base, languages: [], translateTo: 'fr' }, srt).languages).toEqual(['fr']);
  });

  it('adds burn-in and the chapter split to a video download, the split only for the whole video', () => {
    const s = { ...DEFAULT_SETTINGS, burnSubtitles: 'en', splitChapters: true };
    expect(buildBody(MP4, s)).toMatchObject({ burnSubtitles: 'en', splitChapters: true });
    expect(buildBody(MP4, { ...s, part: 'range', from: '0:10' }).splitChapters).toBeUndefined();
    expect(buildBody(MP4, { ...s, kind: 'audio', format: 'mp3' }).burnSubtitles).toBeUndefined();
  });

  it('shortens format descriptions for the menu and reads clock times', () => {
    expect(shortFormatLabel(toolkit.captions.formats[0]?.label ?? '')).toBe('SubRip (.srt)');
    expect(timesFromSeconds([5, 90.7])).toBe('0:05, 1:30');
    expect(clockSeconds('1:30')).toBe(90);
    expect(clockSeconds('1:02:03')).toBe(3723);
    expect(Number.isNaN(clockSeconds('soon'))).toBe(true);
    expect(saveLabel({ format: 'zip', entries: [1, 2] })).toBe('Save ZIP (2 files)');
  });
});

describe('download panel with the toolkit', () => {
  it('offers captions, frames and a clip next to video and audio, and a thumbnail', async () => {
    const fetch = serve('toolkit-options-mp4.json', 'toolkit.json');
    const withThumbs: DownloadStatus = { ...status, thumbnailFormats: ['jpg', 'png', 'webp'] };
    render(wrap(createElement(DownloadPanel, { url: MP4, status: withThumbs, call: { base: BASE, fetch } })));
    const tabs = await screen.findByRole('tablist', { name: 'What to save' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Video or audio', 'Captions', 'Frames', 'GIF or WebP']);
    const save = screen.getByTestId('thumbnail-save') as HTMLAnchorElement;
    expect(save.href).toContain('/downloads/thumbnail?');
    expect(save.href).toContain('format=jpg');
  });

  it('has no frames or clip tabs for audio, and plain video and audio when the server has no toolkit', async () => {
    const fetch = serve('toolkit-options-m4a.json', 'toolkit.json');
    render(wrap(createElement(DownloadPanel, { url: 'apollo.m4a', status, call: { base: BASE, fetch } })));
    const tabs = await screen.findByRole('tablist', { name: 'What to save' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Audio', 'Captions']);
    cleanup();
    clearToolkitCache();
    // A server without the toolkit route: nothing is recorded for /downloads/toolkit, so that request fails,
    // and the panel is the plain video and audio form, as before.
    const old = serve('toolkit-options-m4a.json');
    render(wrap(createElement(DownloadPanel, { url: 'apollo.m4a', status, call: { base: BASE, fetch: old } })));
    await screen.findByTestId('download-start');
    expect(screen.queryByRole('tablist')).toBeNull();
  });
});

describe('captions tab', () => {
  it('lists the tracks, offers the timing and second-language options for timed formats, and saves the file', async () => {
    const fetch = serve(
      'toolkit-tracks-mkv.json',
      'toolkit-captions-ass-start.json',
      'toolkit-captions-ass-running.json',
      'toolkit-captions-ass-done.json',
    );
    render(createElement(CaptionsTool, { url: MKV, toolkit, call: { base: BASE, fetch }, pollMs: 5 }));
    const tracks = await screen.findByTestId('caption-tracks');
    // The only creator track is preselected.
    expect((within(tracks).getByRole('checkbox', { name: /stream 2/ }) as HTMLInputElement).checked).toBe(true);
    const format = screen.getByRole('combobox', { name: 'Format' }) as HTMLSelectElement;
    expect([...format.options].map((o) => o.value)).toContain('ass');
    await userEvent.selectOptions(format, 'ass');
    expect(screen.getByTestId('caption-extras')).toBeTruthy();
    await userEvent.selectOptions(format, 'markdown');
    expect(screen.queryByTestId('caption-extras')).toBeNull();
    await userEvent.selectOptions(format, 'ass');
    await userEvent.click(screen.getByTestId('captions-start'));

    const done = await screen.findByTestId('download-done');
    const ass = body<TaskJob>('toolkit-captions-ass-done.json');
    expect(within(done).getByTestId('download-save').textContent).toContain('Save ASS');
    expect(within(done).getByText(ass.file?.filename ?? '')).toBeTruthy();
    expect(within(done).getByTestId('download-tracks').textContent).toContain("en from the creator's captions");
    const sent = fetch.calls.find((c) => c.method === 'POST');
    expect(JSON.parse(String(sent?.body))).toMatchObject({ url: MKV, languages: ['en'], format: 'ass' });
  });
});

describe('finished toolkit jobs', () => {
  it('lists the frames inside the .zip', () => {
    render(createElement(DownloadJobView, { job: body<TaskJob>('toolkit-frames-done.json'), call: { base: BASE } }));
    expect(screen.getByTestId('download-save').textContent).toContain('Save ZIP (2 files)');
    const entries = screen.getByTestId('download-entries');
    expect(within(entries).getAllByRole('listitem')).toHaveLength(2);
  });

  it('previews a clip as an image', () => {
    const clip = body<TaskJob>('toolkit-clip-done.json');
    render(createElement(DownloadJobView, { job: clip, call: { base: BASE } }));
    const img = screen.getByTestId('download-preview') as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.src).toContain(`/downloads/${clip.id}/file?inline=1`);
  });

  it('links each video of a batch saved without a .zip', () => {
    const batch = body<TaskJob>('toolkit-batch-done.json');
    render(createElement(DownloadJobView, { job: batch, call: { base: BASE } }));
    const items = screen.getByTestId('batch-items');
    const links = within(items).getAllByRole('link') as HTMLAnchorElement[];
    expect(links).toHaveLength(batch.items?.length ?? 0);
    expect(links[0]?.href).toContain(`/downloads/${batch.id}/items/0/file`);
    expect(screen.queryByTestId('download-save')).toBeNull();
  });

  it('links one file per chapter after a split', () => {
    const split = body<AnyJob>('toolkit-split-done.json');
    render(createElement(DownloadJobView, { job: split, call: { base: BASE } }));
    const parts = screen.getByTestId('download-parts');
    const links = within(parts).getAllByRole('link') as HTMLAnchorElement[];
    expect(links).toHaveLength(4);
    expect(links[1]?.href).toContain('part=1');
    expect(links[0]?.getAttribute('download')).toBe('01 - At the foot of the ladder.m4a');
  });
});

describe('clip tab', () => {
  it('explains a range it cannot make instead of sending it', async () => {
    const options = body<MediaOptions>('toolkit-options-mp4.json');
    const fetch = serve('toolkit-clip-start.json');
    render(createElement(ClipTool, { url: MP4, toolkit, options, call: { base: BASE, fetch } }));
    const to = screen.getByTestId('clip-to');
    await userEvent.clear(to);
    await userEvent.type(to, `0:${String(toolkit.clips.maxSec + 5).padStart(2, '0')}`);
    expect(screen.getByTestId('clip-problem').textContent).toContain(`at most ${toolkit.clips.maxSec} s`);
    expect((screen.getByTestId('clip-start') as HTMLButtonElement).disabled).toBe(true);
    await userEvent.clear(to);
    await userEvent.type(to, '0:03');
    await waitFor(() => expect(screen.queryByTestId('clip-problem')).toBeNull());
    expect(fetch.calls).toHaveLength(0);
  });
});
