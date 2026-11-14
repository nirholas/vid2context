import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { youtubeCaptions, youtubeSource } from '@vid2context/provider-youtube';
import { describe, expect, it } from 'vitest';
import { createContext, getVideoContext, Registry, type VideoContext } from '../../src/index.ts';
import { createTelemetry, InMemoryExporter, type SpanData } from '../../src/telemetry/index.ts';
import { type RecordedCall, replayFetch, testContext } from '../../src/testing.ts';

// Real YouTube recordings owned by the provider (providers/youtube/test/fixtures/README.md).
const root = join(import.meta.dirname, '../../../..');
const ytFixture = (name: string) => readFileSync(join(root, 'providers/youtube/test/fixtures', name), 'utf8');
const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const ZOO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

function youtubeReplay() {
  return replayFetch([
    {
      method: 'POST',
      url: PLAYER_URL,
      response: (call: RecordedCall) => {
        const { videoId } = JSON.parse(String(call.body)) as { videoId: string };
        const name = videoId === 'jNQXAC9IVRw' ? videoId : 'unavailable';
        return { body: ytFixture(`player-${name}.json`), headers: { 'content-type': 'application/json' } };
      },
    },
    { url: /timedtext\?v=jNQXAC9IVRw.*lang=en.*fmt=srv3/, response: { body: ytFixture('timedtext-jNQXAC9IVRw-en.srv3.xml') } },
    { url: /timedtext\?v=jNQXAC9IVRw.*lang=de.*fmt=srv3/, response: { body: ytFixture('timedtext-jNQXAC9IVRw-de.srv3.xml') } },
  ]);
}

const youtube = new Registry([youtubeSource, youtubeCaptions], 'node');

function withTelemetry(fetch: typeof globalThis.fetch) {
  const memory = new InMemoryExporter();
  const telemetry = createTelemetry({ env: {}, fetch: replayFetch([]) }, { exporters: [memory], flushIntervalMs: 0 });
  const ctx = createContext({ runtime: 'node', env: {}, fetch, log: testContext().log, telemetry });
  return { memory, telemetry, ctx };
}

function stable(c: VideoContext) {
  return { ...c, transcript: { ...c.transcript, createdAt: '' }, attempts: c.attempts.map(({ ms: _ms, ...a }) => a) };
}

function only(spans: SpanData[], name: string): SpanData {
  const found = spans.filter((s) => s.name === name);
  expect(found, name).toHaveLength(1);
  return found[0] as SpanData;
}

function assertNoText(spans: SpanData[], texts: string[]) {
  const dump = JSON.stringify(spans);
  for (const t of texts.filter((x) => x.trim().length > 3)) expect(dump).not.toContain(t.trim());
}

describe('pipeline spans on recorded YouTube captions', () => {
  it('nests stage spans under one request span and changes nothing in the result', async () => {
    const plain = await getVideoContext(youtube, ZOO, {}, testContext({ fetch: youtubeReplay() }));
    const { memory, telemetry, ctx } = withTelemetry(youtubeReplay());
    const traced = await getVideoContext(youtube, ZOO, {}, ctx);

    expect(stable(traced)).toEqual(stable(plain));

    const request = only(memory.spans, 'vid2context.get_context');
    expect(request.parentSpanId).toBeUndefined();
    expect(memory.children(request).map((s) => s.name)).toEqual([
      'vid2context.resolve',
      'vid2context.metadata',
      'vid2context.captions',
    ]);
    for (const s of memory.spans) expect(s.traceId).toBe(request.traceId);
    const captions = only(memory.spans, 'vid2context.captions');
    expect(captions.attributes).toMatchObject({
      'vid2context.stage': 'captions',
      'vid2context.ref': 'youtube:jNQXAC9IVRw',
      'vid2context.platform': 'youtube',
      'vid2context.outcome': 'ok',
    });
    expect(captions.endMs).toBeGreaterThanOrEqual(captions.startMs);

    const stages = telemetry.metrics.histograms.get('vid2context.stage.duration');
    expect([...(stages?.values() ?? [])].map((p) => [p.attrs.stage, p.attrs.outcome, p.count])).toEqual([
      ['resolve', 'ok', 1],
      ['metadata', 'ok', 1],
      ['captions', 'ok', 1],
    ]);

    assertNoText(memory.spans, [...traced.transcript.segments.map((s) => s.text), traced.metadata.title, ZOO]);
  });
});
