import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { clearCooldowns, Vid2ContextError } from '@vid2context/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { createFfmpegExtractor, ffmpegAvailable } from '../src/ffmpeg.ts';
import { parsePlaylist, pickAudioUri } from '../src/hls.ts';
import { liveRoutes } from '../src/http.ts';
import { registerLiveTools } from '../src/mcp.ts';
import { dedupeOverlap, wordsOf } from '../src/overlap.ts';
import { resolveLive } from '../src/resolve.ts';
import type { LiveEvent } from '../src/types.ts';
import { chooseStartSequence, watchLive } from '../src/watch.ts';
import { matchYouTubeVideo } from '../src/youtube.ts';
import {
  APOLLO_URL,
  apolloRoutes,
  FIXTURES,
  fastSleep,
  liveContext,
  NASA_SEGMENTS,
  NASA_URL,
  nasaRoutes,
  RATELIMIT_SCENARIO,
  read,
  replayStt,
  runScenario,
  SCENARIOS,
  sttRegistry,
  sttRoute,
} from './scenarios.ts';

const NASA = join(FIXTURES, 'nasa-iss');
const APOLLO = join(FIXTURES, 'apollo-hls');
const hasFfmpeg = ffmpegAvailable({ PATH: process.env.PATH, FFMPEG_PATH: process.env.FFMPEG_PATH });

type Seg = Extract<LiveEvent, { type: 'segment' }>;
type Status = Extract<LiveEvent, { type: 'status' }>;
type Done = Extract<LiveEvent, { type: 'done' }>;
const segmentsOf = (events: LiveEvent[]) => events.filter((e): e is Seg => e.type === 'segment');
const statusesOf = (events: LiveEvent[]) => events.filter((e): e is Status => e.type === 'status');
const doneOf = (events: LiveEvent[]) => events.find((e): e is Done => e.type === 'done');
const segmentFetches = (urls: string[]) =>
  urls
    .map((u) => /\/sq\/(\d+)\//.exec(u)?.[1])
    .filter((s): s is string => Boolean(s))
    .map(Number);

describe('HLS playlists (recorded from NASA live on YouTube)', () => {
  it('picks the lowest-bitrate variant that carries audio from the master playlist', () => {
    const master = parsePlaylist(read(join(NASA, 'master.m3u8')), 'https://manifest.googlevideo.com/');
    expect(master.kind).toBe('master');
    if (master.kind !== 'master') return;
    expect(master.variants.length).toBeGreaterThanOrEqual(5);
    expect(master.renditions.some((r) => r.type === 'SUBTITLES')).toBe(true);
    const uri = pickAudioUri(master);
    expect(uri).toContain('/itag/91/');
    const lowest = [...master.variants].sort((a, b) => a.bandwidth - b.bandwidth)[0];
    expect(lowest?.codecs.some((c) => c.startsWith('mp4a'))).toBe(true);
  });

  it('reads media sequence, target duration, durations and program date time', () => {
    const a = parsePlaylist(read(join(NASA, 'media-1.m3u8')), 'https://x/');
    const b = parsePlaylist(read(join(NASA, 'media-2.m3u8')), 'https://x/');
    if (a.kind !== 'media' || b.kind !== 'media') throw new Error('expected media playlists');
    expect(a.targetDuration).toBe(5);
    expect(a.mediaSequence).toBe(323503);
    expect(a.segments.at(-1)?.sequence).toBe(323509);
    expect(b.mediaSequence).toBe(323505);
    expect(b.segments.map((s) => s.sequence).slice(-3)).toEqual(NASA_SEGMENTS);
    expect(a.endList).toBe(false);
    expect(a.segments[0]?.duration).toBeCloseTo(5.005);
    // PROGRAM-DATE-TIME is on the first segment only; later segments follow by duration.
    const t0 = a.segments[0]?.programDateMs ?? 0;
    expect(new Date(t0).toISOString()).toBe('2026-11-14T17:05:19.736Z');
    expect(a.segments[2]?.programDateMs).toBe(t0 + 2 * 5005);
    expect(b.segments.find((s) => s.sequence === 323509)?.uri).toBe(a.segments.find((s) => s.sequence === 323509)?.uri);
  });

  it('reads ffmpeg program date times with a +0000 zone and the end marker', () => {
    const last = parsePlaylist(read(join(APOLLO, 'playlist-7.m3u8')), APOLLO_URL);
    if (last.kind !== 'media') throw new Error('expected a media playlist');
    expect(last.endList).toBe(true);
    expect(last.playlistType).toBe('EVENT');
    expect(last.segments.map((s) => s.uri.split('/').pop())).toEqual([0, 1, 2, 3, 4, 5, 6].map((n) => `seg-${n}.ts`));
    expect(last.segments[0]?.uri).toBe('http://localhost:8000/apollo/seg-0.ts');
    expect(new Date(last.segments[1]?.programDateMs ?? 0).toISOString()).toBe('2026-11-14T17:23:33.970Z');
  });

  it('starts at the newest chunk of audio, or at fromSequence, and reports a resume gap', () => {
    const a = parsePlaylist(read(join(NASA, 'media-1.m3u8')), 'https://x/');
    if (a.kind !== 'media') throw new Error('expected a media playlist');
    // Six segments, one of them 4.94 s, make 29.96 s; the seventh crosses 30 s.
    expect(chooseStartSequence(a, { chunkSec: 30 })).toEqual({ start: 323503 });
    expect(chooseStartSequence(a, { chunkSec: 10 })).toEqual({ start: 323508 });
    expect(chooseStartSequence(a, { chunkSec: 30, fromSequence: 323507 })).toEqual({ start: 323507 });
    expect(chooseStartSequence(a, { chunkSec: 30, fromSequence: 323512 })).toEqual({ start: 323512 });
    expect(chooseStartSequence(a, { chunkSec: 30, fromSequence: 323400 })).toEqual({
      start: 323503,
      gap: { from: 323400, to: 323502 },
    });
  });
});

describe('resolving live inputs', () => {
  it('recognises single YouTube videos, including /live/ URLs', () => {
    expect(matchYouTubeVideo('https://www.youtube.com/live/M3HKLzjvKPc?si=x')?.id).toBe('youtube:M3HKLzjvKPc');
    expect(matchYouTubeVideo('youtu.be/M3HKLzjvKPc')?.nativeId).toBe('M3HKLzjvKPc');
    expect(matchYouTubeVideo('M3HKLzjvKPc')?.url).toBe('https://www.youtube.com/watch?v=M3HKLzjvKPc');
    expect(matchYouTubeVideo('https://www.youtube.com/@NASA/live')).toBeNull();
    expect(matchYouTubeVideo('https://example.com/watch?v=M3HKLzjvKPc')).toBeNull();
  });

  it('resolves a live YouTube video to the audio variant of its HLS manifest', async () => {
    const { ctx } = liveContext(nasaRoutes());
    const src = await resolveLive(NASA_URL, { registry: sttRegistry(), ctx });
    expect(src.ref.id).toBe('youtube:M3HKLzjvKPc');
    expect(src.title).toBe('Live Video from the International Space Station (Official NASA Stream)');
    expect(src.channel).toBe('NASA');
    expect(src.masterUrl).toContain('/hls_variant/');
    expect(src.mediaUrl).toContain('/itag/91/');
    expect(src.expiresAtMs).toBeGreaterThan(Date.now());
  });

  it('refuses a video that is not live and points at the normal pipeline', async () => {
    const { ctx } = liveContext(nasaRoutes());
    const err = await resolveLive('https://youtu.be/jNQXAC9IVRw', { registry: sttRegistry(), ctx }).catch((e) => e);
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect(err.code).toBe('unsupported-input');
    expect(err.message).toContain('Me at the zoo');
    expect(err.hint).toContain('get_transcript');
  });

  it('refuses inputs that are neither YouTube nor HLS', async () => {
    const { ctx } = liveContext([]);
    const err = await resolveLive('not a url', { registry: sttRegistry(), ctx }).catch((e) => e);
    expect(err.code).toBe('unsupported-input');
    expect(err.hint).toContain('.m3u8');
  });

  it('refuses a stream whose playlist has already ended', async () => {
    const { ctx } = liveContext(apolloRoutes({ startState: 7 }));
    const run = watchLive(
      APOLLO_URL,
      {},
      { registry: sttRegistry(), ctx, extractAudio: createFfmpegExtractor({ env: ctx.env }) },
    );
    const err = await run.next().catch((e) => e);
    expect(err.code).toBe('unsupported-input');
    expect(err.message).toContain('EXT-X-ENDLIST');
  });

  it('needs an audio extractor and validates options', async () => {
    const { ctx } = liveContext([]);
    const noExtractor = await watchLive(APOLLO_URL, {}, { registry: sttRegistry(), ctx })
      .next()
      .catch((e) => e);
    expect(noExtractor.code).toBe('no-provider');
    expect(noExtractor.hint).toContain('createFfmpegExtractor');
    const extractAudio = createFfmpegExtractor({ env: ctx.env });
    const badOverlap = await watchLive(
      APOLLO_URL,
      { chunkSec: 10, overlapSec: 6 },
      { registry: sttRegistry(), ctx, extractAudio },
    )
      .next()
      .catch((e) => e);
    expect(badOverlap.code).toBe('bad-request');
    const keylessOff = await watchLive(
      APOLLO_URL,
      {},
      {
        registry: sttRegistry(),
        ctx: { ...ctx, env: { VID2CONTEXT_KEYLESS: '0' } },
        extractAudio,
      },
    )
      .next()
      .catch((e) => e);
    expect(keylessOff.code).toBe('no-provider');
  });
});

describe('overlap dedupe', () => {
  it('drops the words a chunk repeats from the previous one, tolerating a garbled first word', () => {
    const prev = wordsOf([{ startSec: 0, endSec: 10, text: "I'm going to step off the limb now." }]);
    const next = [
      { startSec: 8, endSec: 10, text: 'imb now. That is one small step' },
      { startSec: 10, endSec: 14, text: 'for man.' },
    ];
    const out = dedupeOverlap(prev, next, 10);
    expect(out.method).toBe('words');
    expect(out.segments.map((s) => s.text)).toEqual(['That is one small step', 'for man.']);
    expect(out.segments[0]?.startSec).toBe(10);
  });

  it('falls back to dropping segments that lie inside the overlap when no words match', () => {
    const out = dedupeOverlap(
      ['hello', 'world'],
      [
        { startSec: 8, endSec: 9.9, text: 'something else' },
        { startSec: 9.9, endSec: 12, text: 'new words' },
      ],
      10,
    );
    expect(out.method).toBe('time');
    expect(out.segments.map((s) => s.text)).toEqual(['new words']);
  });

  it('does not treat one short common word as a repeat', () => {
    const out = dedupeOverlap(['over', 'the'], [{ startSec: 10.5, endSec: 12, text: 'the moon' }], 10);
    expect(out.method).toBe('none');
    expect(out.segments[0]?.text).toBe('the moon');
  });
});

describe.skipIf(!hasFfmpeg)('watching a stream (recorded HLS, recorded keyless speech-to-text, real ffmpeg)', () => {
  beforeEach(() => clearCooldowns());

  it('tracks media sequences across playlist refreshes: every segment once, in order', async () => {
    const stt = replayStt('nasa-sequence');
    const { events, fetch } = await runScenario(SCENARIOS.nasaSequence as never, stt);
    expect(segmentFetches(fetch.calls.map((c) => c.url))).toEqual(NASA_SEGMENTS);
    const playlistLoads = fetch.calls.filter((c) => c.url.includes('/hls_playlist/')).length;
    expect(playlistLoads).toBeGreaterThanOrEqual(2);
    expect(stt.served()).toBe(1);
    const statuses = statusesOf(events);
    expect(statuses[0]?.code).toBe('started');
    expect(statuses.some((s) => s.code === 'keyless-only')).toBe(true);
    // Stream time is media sequence x segment duration: 323509 x 5.005 s = 449:46:02.
    expect(statuses.find((s) => s.code === 'rung')?.message).toBe(
      'Transcribed 449:46:02 to 449:46:17 with stt/ovh/whisper-large-v3-turbo (keyless).',
    );
    const done = doneOf(events);
    expect(done?.reason).toBe('cancelled');
    // The 15 s window ends 15 ms before the end of 323511, so that segment is where to resume.
    expect(done?.resumeSequence).toBe(323511);
    expect(done?.transcript.origin).toBe('stt');
    expect(done?.transcript.ref.id).toBe('youtube:M3HKLzjvKPc');
    expect(done?.transcript.producer).toBe('stt/ovh/whisper-large-v3-turbo');
    expect(done?.transcript.segments).toEqual(segmentsOf(events).map((e) => e.segment));
    const start = 323509 * 5.005;
    for (const s of segmentsOf(events)) {
      expect(s.segment.startSec).toBeGreaterThanOrEqual(start - 0.01);
      expect(s.segment.endSec).toBeLessThanOrEqual(start + 15.01);
      expect(s.at?.startsWith('2026-11-14T17:05:')).toBe(true);
      expect(s.resumeSequence).toBe(323511);
    }
  });

  it('shows rate limits and cooldowns of the speech-to-text chain in status events, then retries', async () => {
    const stt = replayStt('nasa-ratelimit');
    const { events } = await runScenario(RATELIMIT_SCENARIO, stt, {
      // The chain cools a rate-limited rung down for Retry-After (46 s here); end it so the replayed retry runs now.
      onEvent: (e) => {
        if (e.type === 'status' && e.code === 'stt-retry') clearCooldowns();
      },
    });
    expect(stt.served()).toBe(2);
    const retry = statusesOf(events).find((s) => s.code === 'stt-retry');
    expect(retry?.message).toMatch(
      /^Speech-to-text failed for 449:46:02 to 449:46:17 \(stt\/ovh\/whisper-large-v3-turbo rate-limited-429\); retrying in 5 s\./,
    );
    expect(statusesOf(events).some((s) => s.code === 'rung')).toBe(true);
    expect(segmentsOf(events).map((e) => e.segment.text)).toEqual(['Thank you.']);
  });

  it('skips ahead with a status when transcription falls behind by more than maxLagSec', async () => {
    const stt = replayStt('nasa-backpressure');
    const { events, fetch } = await runScenario(SCENARIOS.nasaBackpressure as never, stt);
    expect(segmentFetches(fetch.calls.map((c) => c.url))).toEqual(NASA_SEGMENTS);
    expect(stt.served()).toBe(2);
    const skipped = statusesOf(events).filter((s) => s.code === 'skipped');
    expect(skipped.map((s) => s.message)).toEqual([
      'Transcription fell 10 s behind the live edge (limit 6 s); skipped 449:46:07 to 449:46:12 to catch up.',
    ]);
    expect(skipped[0]?.resumeSequence).toBe(323511);
    // First chunk: segment 323509. Second chunk: segment 323511 alone, with no overlap after the skip.
    const start511 = 323509 * 5.005 + 2 * 5.005;
    const late = segmentsOf(events).filter((e) => e.segment.startSec >= start511 - 0.01);
    const early = segmentsOf(events).filter((e) => e.segment.startSec < 323509 * 5.005 + 5.01);
    expect(late.length + early.length).toBe(segmentsOf(events).length);
    expect(doneOf(events)?.reason).toBe('cancelled');
  });

  it('resumes from a media sequence after a restart', async () => {
    const stt = replayStt('nasa-resume');
    const { events, fetch } = await runScenario(SCENARIOS.nasaResume as never, stt);
    expect(segmentFetches(fetch.calls.map((c) => c.url))).toEqual([323510, 323511]);
    expect(statusesOf(events).find((s) => s.code === 'rung')?.message).toContain('Transcribed 449:46:07 to 449:46:17');
    expect(doneOf(events)?.resumeSequence).toBe(323511);
    expect(stt.served()).toBe(1);
  });

  it('stops promptly on cancellation and still returns the transcript so far', async () => {
    const stop = new AbortController();
    const { ctx, fetch } = liveContext([...nasaRoutes(), sttRoute(replayStt('none'))]);
    const events: LiveEvent[] = [];
    for await (const e of watchLive(
      NASA_URL,
      { fromSequence: 323509, signal: stop.signal },
      { registry: sttRegistry(), ctx, extractAudio: createFfmpegExtractor({ env: ctx.env }), sleep: fastSleep },
    )) {
      events.push(e);
      if (e.type === 'status' && e.code === 'started') stop.abort();
    }
    const done = doneOf(events);
    expect(done?.reason).toBe('cancelled');
    expect(done?.transcript.segments).toEqual([]);
    expect(fetch.calls.some((c) => c.method === 'POST' && c.url.includes('ovh'))).toBe(false);
  });

  it('follows a stream to EXT-X-ENDLIST, overlapping chunks without repeating words', async () => {
    const stt = replayStt('apollo-overlap');
    const { events } = await runScenario(SCENARIOS.apolloOverlap as never, stt);
    expect(stt.served()).toBe(3);
    const spans = statusesOf(events)
      .filter((s) => s.code === 'rung')
      .map((s) => s.message.match(/Transcribed (\S+) to (\S+) /)?.slice(1));
    // 10 s windows, each repeating 2 s of the previous one; the last one is the tail after ENDLIST.
    expect(spans).toEqual([
      ['0:00', '0:10'],
      ['0:08', '0:20'],
      ['0:18', '0:24'],
    ]);
    expect(statusesOf(events).some((s) => s.code === 'ended' && s.message.includes('EXT-X-ENDLIST'))).toBe(true);
    const done = doneOf(events);
    expect(done?.reason).toBe('ended');
    expect(done?.transcript.language).toBe('en');
    const text = done?.transcript.segments.map((s) => s.text).join(' ') ?? '';
    expect(text.toLowerCase()).toContain('one small step for man');
    expect(text.toLowerCase()).toContain('mankind');
    // No word run of three or more repeats back to back, which is what an un-deduplicated overlap leaves.
    const words = wordsOf(done?.transcript.segments ?? []);
    for (let n = 3; n <= 6; n++) {
      for (let i = 0; i + 2 * n <= words.length; i++) {
        expect(words.slice(i, i + n).join(' ')).not.toBe(words.slice(i + n, i + 2 * n).join(' '));
      }
    }
    // Times are monotonic stream time and carry the stream's wall clock.
    const segs = segmentsOf(events);
    for (let i = 1; i < segs.length; i++) {
      expect((segs[i] as Seg).segment.startSec).toBeGreaterThanOrEqual((segs[i - 1] as Seg).segment.startSec);
    }
    expect(segs[0]?.at?.startsWith('2026-11-14T17:23:')).toBe(true);
  });
});

describe.skipIf(!hasFfmpeg)('surfaces', () => {
  it('watch_live streams progress notifications and returns the transcript', async () => {
    const { ctx } = liveContext([...apolloRoutes(), sttRoute(replayStt('apollo-whole'))]);
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerLiveTools(server, {
      registry: sttRegistry(),
      ctx,
      extractAudio: createFfmpegExtractor({ env: ctx.env }),
      sleep: fastSleep,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['watch_live']);
    const progress: { progress: number; message?: string }[] = [];
    const res = (await client.callTool({ name: 'watch_live', arguments: { url: APOLLO_URL, maxMinutes: 500 } }, undefined, {
      onprogress: (p) => progress.push(p),
    })) as { content: { text: string }[]; isError?: boolean };
    expect(res.isError).toBeFalsy();
    const text = res.content[0]?.text ?? '';
    expect(text).toContain('Live stream: http://localhost:8000/apollo/live.m3u8');
    expect(text).toContain('Stopped: the stream ended');
    expect(text).toMatch(/\[0:\d\d \| 17:23:\d\dZ\] .*small step/i);
    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect(progress.some((p) => p.message?.includes('small step'))).toBe(true);
    for (let i = 1; i < progress.length; i++) expect(progress[i]?.progress ?? 0).toBeGreaterThan(progress[i - 1]?.progress ?? 0);
  });

  it('watch_live returns tool errors with code and hint', async () => {
    const { ctx } = liveContext(nasaRoutes());
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerLiveTools(server, { registry: sttRegistry(), ctx, extractAudio: createFfmpegExtractor({ env: ctx.env }) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const res = (await client.callTool({ name: 'watch_live', arguments: { url: 'jNQXAC9IVRw' } })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]?.text ?? '{}')).toMatchObject({ error: 'unsupported-input' });
  });

  it('GET /live streams segment, status and done events', async () => {
    const { ctx } = liveContext([...apolloRoutes(), sttRoute(replayStt('apollo-whole'))]);
    const app = liveRoutes({
      registry: sttRegistry(),
      makeCtx: () => ctx,
      extractAudio: createFfmpegExtractor({ env: ctx.env }),
      sleep: fastSleep,
    });
    const res = await app.request(`/live?url=${encodeURIComponent(APOLLO_URL)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    const events = [...body.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map((m) => ({
      event: m[1],
      data: JSON.parse(m[2] ?? '{}'),
    }));
    expect(events[0]).toMatchObject({ event: 'status', data: { code: 'started' } });
    expect(events.some((e) => e.event === 'segment' && /small step/i.test(e.data.segment.text))).toBe(true);
    const done = events.at(-1);
    expect(done?.event).toBe('done');
    expect(done?.data.reason).toBe('ended');
    expect(done?.data.transcript.segments.length).toBeGreaterThan(0);
  });

  it('GET /live answers bad requests as JSON and stream failures as error events', async () => {
    const { ctx } = liveContext(nasaRoutes());
    const app = liveRoutes({
      registry: sttRegistry(),
      makeCtx: () => ctx,
      extractAudio: createFfmpegExtractor({ env: ctx.env }),
    });
    const missing = await app.request('/live');
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { code: 'bad-request' } });
    const notLive = await app.request('/live?url=jNQXAC9IVRw');
    const body = await notLive.text();
    expect(body).toContain('event: error');
    expect(body).toContain('"code":"unsupported-input"');
  });
});
