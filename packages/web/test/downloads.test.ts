import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mediaOptions } from '@vid2context/downloads';
// @vitest-environment jsdom
/**
 * The download client, settings and panels on responses recorded from the
 * real /downloads routes (scripts/record-download-fixtures.ts): Big Buck Bunny
 * from YouTube, the Apollo 11 clip as a local file, and a playlist.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Route as ReplayRoute } from '@vid2context/core/testing';
import { replayFetch } from '@vid2context/core/testing';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DownloadJobView } from '../src/components/download/DownloadJobView.tsx';
import { DownloadPage } from '../src/components/download/DownloadPage.tsx';
import { DownloadPanel, initialSettings } from '../src/components/download/DownloadPanel.tsx';
import { ResultDownloads } from '../src/components/download/ResultDownloads.tsx';
import { clearDownloadStatusCache } from '../src/components/download/use-download-status.ts';
import { isListError } from '../src/lib/api.ts';
import { type ApiState, ApiStatusProvider } from '../src/lib/api-status.tsx';
import {
  buildBody,
  DEFAULT_SETTINGS,
  type DownloadJob,
  type DownloadStatus,
  deleteDownload,
  downloadFileUrl,
  fitQuality,
  formatEta,
  formatSpeed,
  getDownloadJob,
  getDownloadStatus,
  getMediaOptions,
  type MediaOptions,
  phaseLabel,
  startDownload,
  withKind,
} from '../src/lib/downloads.ts';
import type { AppError } from '../src/lib/errors.ts';
import { parseRoute } from '../src/lib/route.ts';
import { BASE, ROOT, recorded } from './helpers.ts';

const BBB = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const APOLLO = 'tests/fixtures/media/apollo11-small-step.mp3';
const PLAYLIST = 'https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf';

const body = <T>(name: string) => recorded(name).body as T;
const status = body<DownloadStatus>('downloads-status.json');
const bbb = body<MediaOptions>('downloads-options-bbb.json');
const apollo = body<MediaOptions>('downloads-options-apollo.json');

/**
 * Serve recordings by method and path (query ignored). Several recordings of
 * one path are served in order and the last repeats, as polling a job sees
 * `running`, then `done`.
 */
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
// The provider's props type requires children; createElement passes them as the third argument.
const wrap = (node: ReactNode, initial: ApiState = online) =>
  createElement(ApiStatusProvider, { initial } as { initial: ApiState; children: ReactNode }, node);

beforeEach(clearDownloadStatusCache);
afterEach(cleanup);

describe('download client', () => {
  it('reads the status and the options the server found', async () => {
    const fetch = serve('downloads-status.json', 'downloads-options-bbb.json');
    const s = await getDownloadStatus({ base: BASE, fetch });
    expect(s.enabled).toBe(true);
    expect(s.notice).toContain('rights');
    const o = await getMediaOptions(BBB, { base: BASE, fetch });
    expect(o.title).toBe('Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film');
    expect(fetch.calls[1]?.url).toBe(`${BASE}/downloads/options?url=${encodeURIComponent(BBB)}`);
  });

  it('recognizes a playlist given to /downloads/options', async () => {
    const err = await getMediaOptions(PLAYLIST, { base: BASE, fetch: serve('downloads-options-playlist.json') }).catch((e) => e);
    expect(isListError(err)).toBe(true);
  });

  it('posts JSON, follows a job and deletes it', async () => {
    const fetch = serve('downloads-start.json', 'downloads-job-done.json', 'downloads-delete.json');
    const job = await startDownload({ url: APOLLO, format: 'mp3', quality: '128' }, { base: BASE, fetch });
    expect(fetch.calls[0]?.method).toBe('POST');
    expect(fetch.calls[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(String(fetch.calls[0]?.body))).toEqual({ url: APOLLO, format: 'mp3', quality: '128' });
    const done = await getDownloadJob(job.id, { base: BASE, fetch });
    expect(done.status).toBe('done');
    expect(await deleteDownload(job.id, { base: BASE, fetch })).toEqual({ deleted: true, id: job.id });
    expect(downloadFileUrl(job.id, true, BASE)).toBe(`${BASE}/downloads/${job.id}/file?inline=1`);
  });

  it('turns a refused request into an error with a hint', async () => {
    const err = (await startDownload(
      { url: APOLLO, format: 'mp3', quality: '1080' },
      { base: BASE, fetch: serve('downloads-start-invalid.json') },
    ).catch((e) => e)) as AppError;
    expect(err.code).toBe('bad-request');
    expect(err.status).toBe(400);
    expect(err.hint).toContain('320');
  });
});

describe('download settings', () => {
  it('builds the request body, sending bitrates only for mp3', () => {
    expect(buildBody(BBB, DEFAULT_SETTINGS)).toEqual({
      url: BBB,
      kind: 'video',
      format: 'mp4',
      quality: '1080',
      embedThumbnail: true,
      embedMetadata: true,
      embedChapters: true,
    });
    const audio = withKind(DEFAULT_SETTINGS, 'audio');
    expect(buildBody(BBB, { ...audio, format: 'm4a', quality: '192' }).quality).toBe('best');
    expect(buildBody(BBB, { ...audio, quality: '192' }).quality).toBe('192');
    const part = buildBody(BBB, {
      ...DEFAULT_SETTINGS,
      part: 'range',
      from: ' 1:00 ',
      to: '',
      subtitles: 'en',
      removeSponsors: true,
    });
    expect(part).toMatchObject({ from: '1:00', subtitles: ['en'], removeSegments: ['sponsor', 'selfpromo', 'interaction'] });
    expect(part.to).toBeUndefined();
    expect(buildBody(BBB, { ...audio, subtitles: 'en' }).subtitles).toBeUndefined();
    expect(buildBody(BBB, { ...DEFAULT_SETTINGS, part: 'chapter', chapter: '2' }).chapter).toBe('2');
  });

  it('fits the defaults to the source', () => {
    expect(fitQuality(bbb, 'video', '1080')).toBe('1080');
    // A 240p video: its `best` stream is already below 1080, so the default is best, not the smallest.
    const zoo = mediaOptions(
      JSON.parse(readFileSync(join(ROOT, 'packages/downloads/test/fixtures/info-youtube-jNQXAC9IVRw.json'), 'utf8')),
    );
    expect(zoo.video.map((v) => v.quality)).toEqual(['best', '144']);
    expect(fitQuality(zoo, 'video', '1080')).toBe('best');
    expect(fitQuality(zoo, 'video', '144')).toBe('144');
    expect(fitQuality(bbb, 'video', '100')).toBe('144');
    expect(initialSettings(apollo)).toMatchObject({ kind: 'audio', format: 'mp3', quality: 'best' });
    expect(withKind(withKind(DEFAULT_SETTINGS, 'audio'), 'video', bbb)).toMatchObject({
      kind: 'video',
      format: 'mp4',
      quality: '1080',
    });
  });

  it('describes progress in plain words', () => {
    const running = body<DownloadJob>('downloads-job-bbb-running.json');
    expect(phaseLabel(running)).toBe('Downloading 38%');
    expect(phaseLabel(body<DownloadJob>('downloads-job-bbb-done.json'))).toBe('Ready');
    expect(phaseLabel(body<DownloadJob>('downloads-job-running.json'))).toBe('Preparing');
    expect(formatSpeed(running.progress.speedBps)).toBe('35.7 MB/s');
    expect(formatSpeed(2048)).toBe('2 KB/s');
    expect(formatEta(65)).toBe('1 min 5 s left');
    expect(formatEta(0)).toBeUndefined();
  });

  it('routes ?view=download with an optional link', () => {
    expect(parseRoute('?view=download')).toEqual({ view: 'download', url: undefined });
    expect(parseRoute(`?view=download&url=${encodeURIComponent(BBB)}`)).toEqual({ view: 'download', url: BBB });
  });
});

describe('DownloadPanel', () => {
  it('lists qualities with sizes, starts the download, shows progress, then the file', async () => {
    const fetch = serve(
      'downloads-options-bbb.json',
      'downloads-start-bbb.json',
      'downloads-job-bbb-running.json',
      'downloads-job-bbb-done.json',
    );
    render(createElement(DownloadPanel, { url: BBB, status, call: { base: BASE, fetch }, pollMs: 20, showTitle: true }));
    expect((await screen.findByTestId('download-title')).textContent).toBe(bbb.title);
    expect(screen.getByTestId('download-notice').textContent).toBe(status.notice);

    const quality = screen.getByLabelText('Quality') as HTMLSelectElement;
    const labels = [...quality.options].map((o) => o.textContent);
    expect(labels[0]).toMatch(/^Best \(2160p60\), about 1\.\d+ GB$/);
    expect(labels).toContain('1080p60, about 255.5 MB');
    expect(quality.value).toBe('1080');
    expect(screen.getByRole('button', { name: 'Video' }).getAttribute('aria-pressed')).toBe('true');

    await userEvent.selectOptions(quality, '480');
    await userEvent.click(screen.getByTestId('download-start'));
    expect(JSON.parse(String(fetch.calls.find((c) => c.method === 'POST')?.body))).toMatchObject({
      url: BBB,
      kind: 'video',
      format: 'mp4',
      quality: '480',
    });

    // The start answer is still preparing; the first poll brings the recorded 38%.
    expect(within(await screen.findByTestId('download-progress')).getByRole('status').textContent).toBe('Preparing');
    await waitFor(() => expect(screen.getByTestId('download-progress').textContent).toContain('Downloading 38%'));
    const progress = screen.getByTestId('download-progress');
    expect(within(progress).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('38');
    expect(progress.textContent).toContain('13.9 MB of 36.7 MB');

    const done = await screen.findByTestId('download-done');
    const job = body<DownloadJob>('downloads-job-bbb-done.json');
    const save = within(done).getByTestId('download-save');
    expect(save.getAttribute('href')).toBe(`${BASE}/downloads/${job.id}/file`);
    expect(save.getAttribute('download')).toBe(job.file?.filename);
    expect(done.textContent).toContain('37.1 MB, 10:35');
    const preview = within(done).getByTestId('download-preview');
    expect(preview.tagName).toBe('VIDEO');
    expect(preview.getAttribute('src')).toBe(`${BASE}/downloads/${job.id}/file?inline=1`);
  });

  it('offers only audio for an audio-only file, with mp3 bitrates', async () => {
    const fetch = serve('downloads-options-apollo.json', 'downloads-start.json', 'downloads-job-done.json');
    render(createElement(DownloadPanel, { url: APOLLO, status, call: { base: BASE, fetch }, pollMs: 20 }));
    const video = await screen.findByRole('button', { name: 'Video' });
    expect((video as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Audio' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText('Format') as HTMLSelectElement).value).toBe('mp3');
    await userEvent.selectOptions(screen.getByLabelText('Quality'), '128');
    await userEvent.click(screen.getByTestId('download-start'));
    expect(JSON.parse(String(fetch.calls.find((c) => c.method === 'POST')?.body))).toMatchObject({
      url: APOLLO,
      kind: 'audio',
      format: 'mp3',
      quality: '128',
    });
    const done = await screen.findByTestId('download-done');
    expect(within(done).getByTestId('download-preview').tagName).toBe('AUDIO');
    expect(within(done).getByTestId('download-save').textContent).toContain('Save MP3');
  });

  it('shows a failed job with its message and hint', async () => {
    const fetch = serve('downloads-job-mp4-error.json');
    render(
      createElement(DownloadJobView, {
        job: body<DownloadJob>('downloads-start-mp4.json'),
        call: { base: BASE, fetch },
        pollMs: 10,
      }),
    );
    expect((await screen.findByTestId('error-message')).textContent).toBe(`${APOLLO} has no video track.`);
    expect(screen.getByTestId('error-hint').textContent).toContain('Download it as audio instead.');
  });
});

describe('Download page and the result section', () => {
  it('lists a playlist instead of failing, with one choice set for all items', async () => {
    const fetch = serve('downloads-status.json', 'downloads-options-playlist.json', 'items-playlist.json');
    render(wrap(createElement(DownloadPage, { url: PLAYLIST, call: { base: BASE, fetch } })));
    const list = await screen.findByTestId('playlist-items');
    const items = body<{ items: unknown[] }>('items-playlist.json').items;
    expect(within(list).getAllByRole('listitem')).toHaveLength(items.length);
    expect(within(list).getAllByRole('button', { name: 'Download' })).toHaveLength(items.length);
    expect(screen.getByTestId('download-all').textContent).toContain(`Download all (${items.length})`);
    expect(fetch.calls.find((c) => c.url.includes('/items'))?.url).toContain('limit=50');
  });

  it('says why downloads are missing in client-only mode, and the result page shows nothing', async () => {
    const offline: ApiState = { status: 'client-only-build', base: BASE };
    render(wrap(createElement(DownloadPage, {}), offline));
    expect((await screen.findByTestId('downloads-off')).textContent).toContain('yt-dlp and ffmpeg cannot run in the browser');
    cleanup();
    const { container } = render(wrap(createElement(ResultDownloads, { url: BBB }), offline));
    expect(container.textContent).toBe('');
  });

  it('adds the section to a result when the server offers downloads', async () => {
    const fetch = serve('downloads-status.json', 'downloads-options-bbb.json');
    render(wrap(createElement(ResultDownloads, { url: BBB, call: { base: BASE, fetch } })));
    expect((await screen.findByRole('heading', { name: 'Download video or audio' })).tagName).toBe('H2');
    expect(await screen.findByTestId('download-panel')).toBeTruthy();
  });
});
