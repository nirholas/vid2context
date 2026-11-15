// @vitest-environment jsdom
/**
 * A video link that also names a playlist (watch?v=...&list=...): the API
 * client finds the playlist and the banner offers it, on responses recorded
 * from a real server (fixtures/items-watch-in-playlist.json and
 * fixtures/metadata-playlist-gwagon.json).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { replayFetch } from '@vid2context/core/testing';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { mayNamePlaylist, PlaylistNotice } from '../src/components/playlist/PlaylistNotice.tsx';
import { getPlaylistOf } from '../src/lib/api.ts';
import { appHref, downloadSearch, runSearch } from '../src/lib/route.ts';
import { BASE, recorded, replay } from './helpers.ts';

const WATCH = 'https://www.youtube.com/watch?v=PzJL3aBRas8&list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b';
const GWAGON = 'https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b';
const OTHER_PLAYLIST = 'https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf';

afterEach(cleanup);

describe('getPlaylistOf', () => {
  it('finds the playlist of a video link, with its title and size', async () => {
    const fetch = replay('items-watch-in-playlist.json', 'metadata-playlist-gwagon.json');
    expect(await getPlaylistOf(WATCH, { base: BASE, fetch })).toEqual({
      url: GWAGON,
      title: "G-Wagon Buyer's Guide",
      count: 9,
    });
    expect(fetch.calls.map((c) => new URL(c.url).pathname)).toEqual(['/api/v1/items', '/api/v1/metadata']);
  });

  it('returns null when the link names no playlist', async () => {
    // The recorded /items answer for a playlist has no `list`; served for any query.
    const items = recorded('items-playlist.json');
    const fetch = replayFetch([
      {
        url: (u: URL) => u.pathname === '/api/v1/items',
        response: { status: items.status, headers: { 'content-type': items.contentType }, body: JSON.stringify(items.body) },
      },
    ]);
    expect(await getPlaylistOf(OTHER_PLAYLIST, { base: BASE, fetch })).toBeNull();
    expect(fetch.calls).toHaveLength(1);
  });

  it('still returns the playlist when its metadata cannot be read', async () => {
    const fetch = replay('items-watch-in-playlist.json');
    expect(await getPlaylistOf(WATCH, { base: BASE, fetch })).toEqual({ url: GWAGON });
  });
});

describe('PlaylistNotice', () => {
  it('only asks about links that carry list=', () => {
    expect(mayNamePlaylist(WATCH)).toBe(true);
    expect(mayNamePlaylist('https://youtu.be/PzJL3aBRas8?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b')).toBe(true);
    expect(mayNamePlaylist('https://www.youtube.com/watch?v=PzJL3aBRas8')).toBe(false);
    expect(mayNamePlaylist('https://example.com/?playlist=1')).toBe(false);
    expect(mayNamePlaylist(GWAGON)).toBe(false);
  });

  it('names the playlist and links to every video, keeping the run options', async () => {
    const fetch = replay('items-watch-in-playlist.json', 'metadata-playlist-gwagon.json');
    const params = { url: WATCH, mode: 'captions' as const, lang: 'en', comments: false, timestamps: true };
    render(
      createElement(PlaylistNotice, {
        input: WATCH,
        searchFor: (url: string) => runSearch({ ...params, url }),
        call: { base: BASE, fetch },
      }),
    );
    const notice = await screen.findByTestId('playlist-notice');
    expect(notice.textContent).toBe("This video is part of a playlist: G-Wagon Buyer's Guide (9 videos).View all 9 videos");
    expect(screen.getByTestId('playlist-open').getAttribute('href')).toBe(appHref(runSearch({ ...params, url: GWAGON })));
  });

  it('links the download page to the playlist download list', async () => {
    const fetch = replay('items-watch-in-playlist.json', 'metadata-playlist-gwagon.json');
    render(createElement(PlaylistNotice, { input: WATCH, searchFor: downloadSearch, call: { base: BASE, fetch } }));
    expect((await screen.findByTestId('playlist-open')).getAttribute('href')).toBe(appHref(downloadSearch(GWAGON)));
  });

  it('shows nothing and asks nothing for plain links or without an API', async () => {
    const fetch = replay('items-watch-in-playlist.json', 'metadata-playlist-gwagon.json');
    const { container, rerender } = render(
      createElement(PlaylistNotice, {
        input: 'https://www.youtube.com/watch?v=PzJL3aBRas8',
        searchFor: downloadSearch,
        call: { base: BASE, fetch },
      }),
    );
    rerender(
      createElement(PlaylistNotice, { input: WATCH, enabled: false, searchFor: downloadSearch, call: { base: BASE, fetch } }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe('');
    expect(fetch.calls).toHaveLength(0);
  });
});
