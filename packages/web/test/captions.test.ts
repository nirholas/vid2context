// @vitest-environment jsdom
/**
 * The Captions page and its client (lib/captions.ts) on responses recorded
 * from the real API (test/fixtures/README.md, captions-*): "Me at the zoo"
 * with English and German creator captions listed by two providers, its
 * tracks as SRT and WebVTT, an LLM translation into French, and the French
 * request that YouTube blocked without translate=1.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Vid2ContextError } from '@vid2context/core';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { deserializeError, serializeError } from '../src/audio/worker-protocol.ts';
import { CaptionsResult } from '../src/components/captions/CaptionsPage.tsx';
import {
  type CaptionLanguagesResponse,
  captionFileName,
  captionUrl,
  extraTargets,
  fetchCaption,
  getCaptionFormats,
  getCaptionLanguages,
  mergeTracks,
} from '../src/lib/captions.ts';
import type { AppError } from '../src/lib/errors.ts';
import { captionsSearch, parseRoute } from '../src/lib/route.ts';
import { BASE, recorded, replay } from './helpers.ts';

const ZOO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const listing = recorded('captions-languages-jNQXAC9IVRw.json').body as CaptionLanguagesResponse;
const text = (name: string) => recorded(name).body as string;

afterEach(cleanup);

describe('caption tracks', () => {
  it('merges the providers into one row per language, naming the track a download returns', () => {
    expect(listing.tracks).toHaveLength(6);
    expect(mergeTracks(listing.tracks)).toEqual([
      {
        language: 'en',
        name: 'English',
        origin: 'creator-captions',
        origins: ['creator-captions', 'auto-captions'],
        translatable: true,
        providers: ['youtube-captions', 'ytdlp-captions'],
      },
      {
        language: 'de',
        name: 'German',
        origin: 'creator-captions',
        origins: ['creator-captions', 'auto-captions'],
        translatable: true,
        providers: ['youtube-captions', 'ytdlp-captions'],
      },
    ]);
    // This recording has no YouTube translation targets; a target already covered by a track is never offered twice.
    expect(listing.translationTargets).toEqual([]);
    expect(
      extraTargets(
        [
          { language: 'de', name: 'German' },
          { language: 'fr', name: 'French' },
        ],
        mergeTracks(listing.tracks),
      ),
    ).toEqual([{ language: 'fr', name: 'French' }]);
  });

  it('lists the tracks and keeps only the caption formats, in order', async () => {
    const fetch = replay('captions-languages-jNQXAC9IVRw.json', 'captions-formats.json');
    const got = await getCaptionLanguages(ZOO, { base: BASE, fetch });
    expect(got.tracks.map((t) => t.language)).toEqual(['en', 'de']);
    const formats = await getCaptionFormats({ base: BASE, fetch });
    expect(formats.map((f) => f.id)).toEqual(['srt', 'vtt', 'text', 'json']);
    expect(formats.find((f) => f.id === 'text')?.extension).toBe('txt');
  });
});

describe('one track', () => {
  it('asks for captions only, so no audio is ever transcribed for a missing track', () => {
    const u = new URL(captionUrl({ url: ZOO, language: 'de', format: 'vtt' }, BASE));
    expect(Object.fromEntries(u.searchParams)).toEqual({ url: ZOO, lang: 'de', format: 'vtt', mode: 'captions' });
    const t = new URL(captionUrl({ url: ZOO, language: 'fr', format: 'text', translate: true, timestamps: true }, BASE));
    expect(t.searchParams.get('translate')).toBe('1');
    expect(t.searchParams.get('timestamps')).toBe('1');
    // No language: the video's default track.
    expect(new URL(captionUrl({ url: ZOO, format: 'srt' }, BASE)).searchParams.has('lang')).toBe(false);
  });

  it('fetches the English SRT and a French translation as text', async () => {
    const fetch = replay('captions-transcript-en-srt.json', 'captions-transcript-fr-translate.json');
    const en = await fetchCaption({ url: ZOO, language: 'en', format: 'srt' }, { base: BASE, fetch });
    expect(en.text).toBe(text('captions-transcript-en-srt.json'));
    expect(en.mimeType).toContain('application/x-subrip');
    const fr = await fetchCaption({ url: ZOO, language: 'fr', format: 'srt', translate: true }, { base: BASE, fetch });
    expect(fr.text).toContain('Alors nous voici devant les éléphants.');
    expect(fr.text).toContain('00:00:05,067 --> 00:00:12,467');
  });

  it('keeps the code, hint and attempts of a blocked track', async () => {
    const fetch = replay('captions-transcript-fr-missing.json');
    const err = (await fetchCaption({ url: ZOO, language: 'fr', format: 'srt' }, { base: BASE, fetch }).catch(
      (e: unknown) => e,
    )) as AppError;
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect(err).toMatchObject({ code: 'blocked', status: 503, hint: expect.stringContaining('YouTube is refusing requests') });
    expect(err.attempts.length).toBeGreaterThan(0);
  });

  it('names files after the title, the language and the kind, safely', () => {
    expect(captionFileName('Me at the zoo', 'de', 'srt')).toBe('Me at the zoo.de.srt');
    expect(captionFileName('Me at the zoo', 'en', 'vtt', { auto: true })).toBe('Me at the zoo.en.auto.vtt');
    expect(captionFileName('a/b: "c"?\u0007.', 'fr', 'srt', { translated: true })).toBe('a b c.fr.translated.srt');
    expect(captionFileName('   ', undefined, 'zip')).toBe('captions.zip');
  });
});

describe('the Captions page', () => {
  it('has its own route', () => {
    expect(captionsSearch(ZOO)).toBe(`?view=captions&url=${encodeURIComponent(ZOO)}`);
    expect(parseRoute(captionsSearch(ZOO))).toEqual({ view: 'captions', url: ZOO });
    expect(parseRoute('?view=captions')).toEqual({ view: 'captions', url: undefined });
  });

  it('lists one row per language and previews the German track as WebVTT', async () => {
    const fetch = replay(
      'captions-formats.json',
      'captions-languages-jNQXAC9IVRw.json',
      'captions-metadata-jNQXAC9IVRw.json',
      'captions-transcript-de-vtt.json',
    );
    render(createElement(CaptionsResult, { url: ZOO, call: { base: BASE, fetch } }));
    expect(await screen.findByTestId('captions-title')).toHaveProperty('textContent', 'Me at the zoo');
    const rows = within(screen.getByTestId('captions-tracks')).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-language'))).toEqual(['en', 'de']);
    expect(rows[0]?.textContent).toContain('Creator captions');
    expect(rows[0]?.textContent).toContain('also auto-captions');
    expect(screen.getByTestId('captions-save-all').textContent).toContain('Save all 2 as .zip');

    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('captions-format'), 'vtt');
    await user.click(within(rows[1] as HTMLElement).getByRole('button', { name: /Preview/ }));
    const preview = await screen.findByTestId('captions-preview');
    expect(preview.textContent).toContain('WebVTT (.vtt)');
    expect(preview.textContent).toContain('Also hier sind wir vor den Elefanten.');
    // Only caption calls were made: no context, no audio.
    expect(fetch.calls.every((c) => !c.url.includes('/context'))).toBe(true);
  });

  it('shows why a listing failed and points to the run page', async () => {
    const fetch = replay('captions-formats.json', 'captions-transcript-fr-missing.json');
    // The recorded blocked body, served for the listing: any API error renders the same way.
    const blocked = recorded('captions-transcript-fr-missing.json');
    const failing: typeof globalThis.fetch = async (input, init) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (href.includes('/caption-languages')) {
        return new Response(JSON.stringify(blocked.body), {
          status: blocked.status,
          headers: { 'content-type': blocked.contentType },
        });
      }
      return fetch(input, init);
    };
    render(createElement(CaptionsResult, { url: ZOO, call: { base: BASE, fetch: failing } }));
    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(alert.textContent).toContain('Could not list the captions'));
    expect(alert.textContent).toContain('Error code blocked');
    expect(within(alert).getByRole('link', { name: 'Open the run page' }).getAttribute('href')).toContain(
      `?url=${encodeURIComponent(ZOO)}`,
    );
  });
});

describe('the speech-to-text worker protocol', () => {
  it('carries an error across postMessage with its code, hint and attempts', () => {
    const body = recorded('captions-transcript-fr-missing.json').body as {
      error: { code: 'blocked'; message: string; hint: string };
      attempts: unknown[];
    };
    const original = Object.assign(new Vid2ContextError(body.error.code, body.error.message, { hint: body.error.hint }), {
      attempts: body.attempts,
    });
    // structuredClone is what postMessage does to the data.
    const back = deserializeError(structuredClone(serializeError(original))) as AppError;
    expect(back).toBeInstanceOf(Vid2ContextError);
    expect(back).toMatchObject({ code: 'blocked', message: body.error.message, hint: body.error.hint });
    expect(back.attempts).toEqual(body.attempts);
    const plain = deserializeError(structuredClone(serializeError(new TypeError('boom'))));
    expect(plain).toMatchObject({ name: 'TypeError', message: 'boom' });
  });
});
