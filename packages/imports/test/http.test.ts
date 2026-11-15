import { readFileSync } from 'node:fs';
import { MemoryStorage, Registry, Vid2ContextError, type VideoContext } from '@vid2context/core';
import { type ReplayFetch, replayFetch, testContext } from '@vid2context/core/testing';
import youtube, { parseSrv3 } from '@vid2context/provider-youtube';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { importRoutes, MAX_IMPORT_BYTES } from '../src/http.ts';
import { type ImportResponse, importTranscript } from '../src/import.ts';

// Real recordings: YouTube player and next responses for "Me at the zoo" (providers/youtube/test/fixtures/README.md,
// "Metadata and chapters"), its real caption tracks, and the "Show transcript" copy in test/fixtures.
const repo = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const META = 'providers/youtube/test/fixtures/metadata';
const YT = 'providers/youtube/test/fixtures';
const copied = readFileSync(new URL('./fixtures/youtube-transcript-jNQXAC9IVRw.txt', import.meta.url), 'utf8');
const srv3 = repo(`${YT}/timedtext-jNQXAC9IVRw-en.srv3.xml`);
const vtt = repo('providers/native-transcripts/test/fixtures/vimeo-1133654544-de.vtt');
// Real Transformers.js Whisper output for the public-domain Apollo 11 clip (providers/stt-transformers/test/fixtures/README.md).
const whisper = JSON.parse(repo('providers/stt-transformers/test/fixtures/whisper-base.apollo.json')) as {
  model: string;
  detectedLanguage: string;
  output: { chunks: { timestamp: [number, number]; text: string }[] };
};
const maxres = JSON.parse(repo(`${META}/maxres-status.json`)) as Record<string, number>;

const ZOO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const json = (body: string) => ({ body, headers: { 'content-type': 'application/json' } });

/** Replays the recorded player, next and thumbnail answers for jNQXAC9IVRw. */
function zooFetch() {
  return replayFetch([
    {
      method: 'POST',
      url: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
      response: json(repo(`${META}/player-zoo-jNQXAC9IVRw.json`)),
    },
    {
      method: 'POST',
      url: 'https://www.youtube.com/youtubei/v1/next?prettyPrint=false',
      response: json(repo(`${META}/next-zoo-jNQXAC9IVRw.json`)),
    },
    {
      method: 'HEAD',
      url: /^https:\/\/i\.ytimg\.com\/vi\/jNQXAC9IVRw\/maxresdefault\.jpg$/,
      response: { status: maxres.jNQXAC9IVRw ?? 404, body: '' },
    },
  ]);
}

const registry = new Registry(youtube, 'node');

/** Mounted the way packages/server mounts sub-apps, with the same error body and statuses. */
function app(opts: { env?: Record<string, string>; fetch?: ReplayFetch; storage?: MemoryStorage; hosted?: boolean } = {}) {
  const fetch = opts.fetch ?? zooFetch();
  const storage = opts.storage ?? new MemoryStorage();
  const root = new Hono();
  root.onError((err, c) => {
    const e = err instanceof Vid2ContextError ? err : undefined;
    const status = e?.code === 'too-large' ? 413 : e?.code === 'bad-request' || e?.code === 'unsupported-input' ? 400 : 500;
    return c.json({ error: { code: e?.code ?? 'internal', message: err.message, ...(e?.hint ? { hint: e.hint } : {}) } }, status);
  });
  root.route(
    '/api/v1',
    importRoutes({
      registry,
      makeCtx: () => testContext({ fetch, env: opts.env ?? {} }),
      storage: async () => storage,
      ...(opts.hosted === undefined ? {} : { hosted: () => opts.hosted as boolean }),
    }),
  );
  return { root, storage, fetch };
}

const post = (a: Hono, body: unknown) =>
  a.request('/api/v1/imports', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('POST /imports', () => {
  it('turns the pasted "Show transcript" text into a saved VideoContext with the real metadata', async () => {
    const { root, storage } = app();
    const res = await post(root, { url: ZOO, text: copied });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ImportResponse;
    expect(body.format).toBe('youtube-transcript');
    expect(body.saved).toBe(true);
    const { metadata, transcript, attempts } = body.context;
    expect(metadata.title).toBe('Me at the zoo');
    expect(metadata.ref.id).toBe('youtube:jNQXAC9IVRw');
    // The player gives no spoken language for this video and the copy has none, so the language is und.
    expect(transcript).toMatchObject({ origin: 'imported', producer: 'import/paste', language: 'und' });
    expect(transcript.segments.map((s) => [s.startSec, s.endSec])).toEqual([
      [1, 7],
      [7, 16],
      [16, 19],
    ]);
    expect(attempts).toEqual([
      { id: 'youtube', stage: 'metadata', outcome: 'ok', ms: expect.any(Number) },
      { id: 'import', stage: 'captions', outcome: 'ok', detail: 'paste, youtube-transcript' },
    ]);
    // Later context, transcript, chat and MCP calls read it from storage.
    expect((await storage.getContext('youtube:jNQXAC9IVRw'))?.transcript.origin).toBe('imported');
  });

  it('takes segments from the extension with via browser and records the caption kind', async () => {
    const segments = parseSrv3(srv3).map(({ startSec, endSec, text }) => ({ startSec, endSec, text }));
    const { root } = app();
    const res = await post(root, {
      url: 'https://youtu.be/jNQXAC9IVRw',
      segments,
      language: 'en',
      captionKind: 'creator-captions',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ImportResponse;
    expect(body.format).toBe('segments');
    expect(body.context.transcript.producer).toBe('import/browser');
    expect(body.context.transcript.segments).toEqual(segments);
    expect(body.context.attempts.at(-1)).toEqual({
      id: 'import',
      stage: 'captions',
      outcome: 'ok',
      detail: 'browser, segments, creator-captions',
    });
  });

  it('takes segments transcribed from the media with via media and records the transcriber', async () => {
    // The browser's Whisper rung, run on audio the user picked or the server downloaded. The words are the Apollo clip's,
    // posted for the zoo video only to exercise the contract: the import trusts the segments as given.
    const segments = whisper.output.chunks.map((c) => ({ startSec: c.timestamp[0], endSec: c.timestamp[1], text: c.text }));
    const { root, storage } = app();
    const res = await post(root, {
      url: ZOO,
      segments,
      language: whisper.detectedLanguage,
      via: 'media',
      transcriber: `  stt/transformers/${whisper.model}\n`,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ImportResponse;
    expect(body.saved).toBe(true);
    expect(body.context.metadata.title).toBe('Me at the zoo');
    expect(body.context.transcript).toMatchObject({ origin: 'imported', producer: 'import/media', language: 'en' });
    expect(body.context.transcript.segments.map((s) => s.text)).toEqual(segments.map((s) => s.text.trim()));
    expect(body.context.attempts.at(-1)).toEqual({
      id: 'import',
      stage: 'captions',
      outcome: 'ok',
      detail: 'media, segments, stt/transformers/onnx-community/whisper-base',
    });
    expect((await storage.getContext('youtube:jNQXAC9IVRw'))?.transcript.producer).toBe('import/media');
  });

  it('reads an uploaded file, taking the language from its WebVTT header or filename', async () => {
    const { root } = app();
    const res = await post(root, { url: ZOO, text: vtt, filename: '/home/someone/subs/reframe.de.vtt', via: 'file' });
    const body = (await res.json()) as ImportResponse;
    expect(res.status).toBe(201);
    expect(body.format).toBe('vtt');
    expect(body.context.transcript).toMatchObject({ language: 'de', producer: 'import/file' });
    // The filename is never stored, with or without its directory.
    expect(JSON.stringify(body.context)).not.toContain('reframe');
  });

  it('never saves in hosted mode (VID2CONTEXT_HOSTED=1), and still returns the context', async () => {
    const env = app({ env: { VID2CONTEXT_HOSTED: '1' } });
    const res = await post(env.root, { url: ZOO, text: copied });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ImportResponse;
    expect(body.saved).toBe(false);
    expect(body.context.transcript.segments).toHaveLength(3);
    expect(await env.storage.getContext('youtube:jNQXAC9IVRw')).toBeNull();

    const flag = app({ hosted: true });
    expect(((await (await post(flag.root, { url: ZOO, text: copied })).json()) as ImportResponse).saved).toBe(false);
    expect(await flag.storage.getContext('youtube:jNQXAC9IVRw')).toBeNull();
  });

  it('still imports when metadata fails: minimal metadata and an error attempt', async () => {
    const { root } = app({ fetch: replayFetch([]) });
    const res = await post(root, { url: ZOO, text: copied });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ImportResponse;
    expect(body.context.metadata).toMatchObject({ title: ZOO, chapters: [] });
    expect(body.context.attempts[0]).toMatchObject({ id: 'youtube', stage: 'metadata', outcome: 'error' });
    expect(body.context.transcript.language).toBe('und');
    // Without a duration, the last segment ends 5 s after it starts.
    expect(body.context.transcript.segments.at(-1)?.endSec).toBe(21);
  });

  it('fills the gaps with the metadata the extension sent, but never overrides the source', async () => {
    const known = { title: 'Me at the zoo (from the extension)', channel: 'jawed', durationSec: 19 };
    const failed = app({ fetch: replayFetch([]) });
    const res = await post(failed.root, { url: ZOO, text: copied, via: 'browser', metadata: known });
    const body = (await res.json()) as ImportResponse;
    expect(body.context.metadata).toMatchObject({ title: known.title, channel: { name: 'jawed' }, durationSec: 19 });
    expect(body.context.transcript.segments.at(-1)?.endSec).toBe(19);

    const ok = app();
    const fetched = (await (await post(ok.root, { url: ZOO, text: copied, metadata: known })).json()) as ImportResponse;
    expect(fetched.context.metadata.title).toBe('Me at the zoo');
  });

  it('refuses bad requests with a hint', async () => {
    const { root, fetch } = app();
    const cases: [unknown, string][] = [
      [{ text: copied }, 'url must be a non-empty string.'],
      [{ url: ZOO }, 'Send the transcript as text or segments.'],
      [{ url: ZOO, text: copied, segments: [{ startSec: 0, text: 'x' }] }, 'Send text or segments, not both.'],
      [
        { url: ZOO, segments: [{ startSec: -1, text: 'x' }] },
        'segments[0].startSec must be a finite number of seconds, 0 or more.',
      ],
      [{ url: ZOO, segments: [{ startSec: 1, text: '  ' }] }, 'segments[0].text is empty.'],
      [{ url: ZOO, text: copied, via: 'email' }, 'via must be one of paste, file, browser, media.'],
      [{ url: ZOO, text: copied, language: 'not a language' }, '"not a language" is not a language code.'],
      [{ url: ZOO, text: copied, metadata: { durationSec: -3 } }, 'metadata.durationSec must be a positive number of seconds.'],
      ['{"url":', 'The body must be JSON.'],
    ];
    for (const [body, message] of cases) {
      const res = await post(root, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'bad-request', message, hint: expect.any(String) } });
    }
    // Validation happens before any network call.
    expect(fetch.calls).toHaveLength(0);
  });

  it('says which formats it accepts when nothing could be read, before any network call', async () => {
    const { root, fetch } = app();
    const res = await post(root, {
      url: ZOO,
      text: repo(`${YT}/timedtext-429-blocked.html`),
      via: 'file',
      filename: 'captions.xml',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string; hint: string } };
    expect(body.error.message).toBe('Nothing could be read from this srv3 text.');
    expect(body.error.hint).toContain('WebVTT (.vtt), SRT (.srt)');
    expect(fetch.calls).toHaveLength(0);
  });

  it('refuses playlists and inputs no source understands', async () => {
    const { root } = app();
    const playlist = await post(root, {
      url: 'https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI',
      text: copied,
    });
    expect(playlist.status).toBe(400);
    expect(await playlist.json()).toMatchObject({ error: { code: 'unsupported-input' } });
    const unknown = await post(root, { url: 'not a video', text: copied });
    expect(await unknown.json()).toMatchObject({ error: { code: 'unsupported-input' } });
  });

  it('refuses local paths in public mode', async () => {
    const { root } = app({ env: { VID2CONTEXT_PUBLIC: '1' } });
    const res = await post(root, { url: '/etc/passwd', text: copied });
    expect(await res.json()).toMatchObject({ error: { code: 'unsupported-input' } });
  });

  it('caps the body at 5 MB', async () => {
    const { root } = app();
    const big = JSON.stringify({ url: ZOO, text: copied.repeat(Math.ceil(MAX_IMPORT_BYTES / copied.length) + 1) });
    const res = await post(root, big);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: 'too-large', hint: expect.any(String) } });
  });
});

describe('importTranscript without an API (the web app in client-only mode)', () => {
  it('skips the metadata fetch and uses what the extension knew', async () => {
    const fetch = replayFetch([]);
    const segments = parseSrv3(srv3).map(({ startSec, endSec, text }) => ({ startSec, endSec, text }));
    const res = await importTranscript(
      registry,
      { url: ZOO, segments, language: 'en', via: 'browser', captionKind: 'creator-captions' },
      { fetchMetadata: false, metadata: { title: 'Me at the zoo', channel: 'jawed', durationSec: 19 } },
      testContext({ fetch, runtime: 'browser' }),
    );
    expect(fetch.calls).toHaveLength(0);
    expect(res.saved).toBe(false);
    const context: VideoContext = res.context;
    expect(context.metadata).toMatchObject({ title: 'Me at the zoo', channel: { name: 'jawed' }, durationSec: 19 });
    expect(context.attempts[0]).toEqual({ id: 'youtube', stage: 'metadata', outcome: 'skipped', reason: 'no-api' });
  });
});
