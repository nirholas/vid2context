import { Vid2ContextError } from '@vid2context/core';
import { replayFetch } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import { apiFormat, describeError, transcriptViaApi } from '../src/lib/api.ts';
import { DEFAULT_SETTINGS } from '../src/lib/settings.ts';
import { fixture } from './helpers.ts';

interface Recorded {
  status: number;
  contentType: string;
  body: string;
}

const recorded = (name: string): Recorded => JSON.parse(fixture(name)) as Recorded;
const asResponse = (r: Recorded) => ({ status: r.status, headers: { 'content-type': r.contentType }, body: r.body });
const settings = { ...DEFAULT_SETTINGS, apiBase: 'http://127.0.0.1:24817/api/v1' };

describe('Copy transcript (via API), replaying the real server', () => {
  it('asks /transcript for the pack format when the copy format is the agent prompt', async () => {
    const ok = recorded('api-transcript-pack-jNQXAC9IVRw.json');
    const fetch = replayFetch([{ url: /\/api\/v1\/transcript\?/, response: asResponse(ok) }]);
    const text = await transcriptViaApi('https://www.youtube.com/watch?v=jNQXAC9IVRw', settings, fetch);
    expect(text).toBe(ok.body);
    const url = new URL(fetch.calls[0]?.url ?? '');
    expect(url.pathname).toBe('/api/v1/transcript');
    expect(url.searchParams.get('url')).toBe('https://www.youtube.com/watch?v=jNQXAC9IVRw');
    expect(url.searchParams.get('format')).toBe('pack');
    expect(url.searchParams.get('timestamps')).toBe('1');
  });

  it("surfaces the API's error code, message and hint", async () => {
    const fetch = replayFetch([
      { url: /\/api\/v1\/transcript\?/, response: asResponse(recorded('api-transcript-not-found.json')) },
    ]);
    const err = await transcriptViaApi('https://www.youtube.com/watch?v=xxxxxxxxxxx', settings, fetch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect((err as Vid2ContextError).code).toBe('not-found');
    expect(describeError(err)).toEqual({
      message: 'YouTube xxxxxxxxxxx: ERROR (This video is unavailable)',
      hint: 'The video does not exist or was removed. Check the video id or URL.',
    });
  });

  it('says how to start a server when the API cannot be reached', async () => {
    const err = await transcriptViaApi('https://example.com/v', settings, replayFetch([])).catch((e: unknown) => e);
    expect((err as Vid2ContextError).code).toBe('upstream');
    expect((err as Vid2ContextError).hint).toContain('npm run dev:server');
  });

  it('passes formatter ids through unchanged', () => {
    expect(apiFormat('agent')).toBe('pack');
    expect(apiFormat('srt')).toBe('srt');
  });
});
