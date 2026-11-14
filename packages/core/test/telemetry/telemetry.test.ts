import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import llmProvider from '@vid2context/provider-llm-openai-compatible';
import mediaFile from '@vid2context/provider-media-file';
import sttProvider from '@vid2context/provider-stt-openai-compatible';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attemptsOf,
  chat,
  clearCooldowns,
  createContext,
  getVideoContext,
  Registry,
  stderrLogger,
  transcribe,
  type VideoContext,
} from '../../src/index.ts';
import {
  createTelemetry,
  formatTraceparent,
  InMemoryExporter,
  parseTraceparent,
  priceEnvName,
  priceFor,
  renderPrometheus,
  type SpanData,
  UsageLedger,
} from '../../src/telemetry/index.ts';
import { type RecordedCall, replayFetch, testContext } from '../../src/testing.ts';

// Real recordings only: OVH fixtures from the provider packages
// (see their test/fixtures/README.md), the shared Apollo 11 clip, and a real
// OpenTelemetry Collector response (test/telemetry/fixtures/README.md).
const root = join(import.meta.dirname, '../../../..');
const sttFixture = (name: string) => readFileSync(join(root, 'providers/stt-openai-compatible/test/fixtures', name), 'utf8');
const llmFixture = (name: string) => readFileSync(join(root, 'providers/llm-openai-compatible/test/fixtures', name), 'utf8');
const collector = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/otlp-collector-200.json'), 'utf8')) as {
  status: number;
  headers: Record<string, string>;
  body: string;
};
const APOLLO = join(root, 'tests/fixtures/media/apollo11-small-step.mp3');
const OVH_STT = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/audio/transcriptions';
const OVH_CHAT = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions';

const files = new Registry([mediaFile, sttProvider], 'node');

function withTelemetry(fetch: typeof globalThis.fetch, env: Record<string, string> = {}, telFetch = replayFetch([])) {
  const memory = new InMemoryExporter();
  const telemetry = createTelemetry({ env, fetch: telFetch }, { exporters: [memory], flushIntervalMs: 0 });
  const ctx = createContext({ runtime: 'node', env, fetch, log: testContext().log, telemetry });
  return { memory, telemetry, ctx };
}

/** Results minus wall-clock fields, so two runs compare equal. */
function stable(c: VideoContext) {
  return {
    ...c,
    transcript: { ...c.transcript, createdAt: '' },
    attempts: c.attempts.map(({ ms: _ms, ...a }) => a),
  };
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

afterEach(() => clearCooldowns());

describe('rung spans on recorded OVH speech to text', () => {
  it('puts the rung span inside the stt stage and records audio seconds', async () => {
    const fetch = replayFetch([
      { method: 'POST', url: OVH_STT, response: { body: sttFixture('ovh-whisper-large-v3-turbo.verbose.json') } },
    ]);
    const plain = await getVideoContext(
      files,
      APOLLO,
      { mode: 'stt' },
      testContext({
        fetch: replayFetch([
          { method: 'POST', url: OVH_STT, response: { body: sttFixture('ovh-whisper-large-v3-turbo.verbose.json') } },
        ]),
      }),
    );
    clearCooldowns();
    const { memory, telemetry, ctx } = withTelemetry(fetch);
    const result = await getVideoContext(files, APOLLO, { mode: 'stt' }, ctx);
    expect(stable(result)).toEqual(stable(plain));

    const request = only(memory.spans, 'vid2context.get_context');
    expect(memory.children(request).map((s) => s.name)).toEqual([
      'vid2context.resolve',
      'vid2context.metadata',
      'vid2context.audio',
      'vid2context.stt',
    ]);
    const stt = only(memory.spans, 'vid2context.stt');
    const [rung] = memory.children(stt);
    expect(rung?.name).toBe('vid2context.rung');
    expect(rung?.attributes).toMatchObject({
      'vid2context.stage': 'stt',
      'vid2context.rung.id': 'stt/ovh/whisper-large-v3-turbo',
      'vid2context.rung.service': 'ovh',
      'vid2context.rung.tier': 'keyless',
      'vid2context.outcome': 'ok',
      'vid2context.usage.audio_seconds': 23.06,
    });
    expect(typeof rung?.attributes['vid2context.duration_ms']).toBe('number');

    const m = telemetry.metrics;
    expect(m.total('vid2context.rung.attempts', { rung: 'stt/ovh/whisper-large-v3-turbo', outcome: 'ok', stage: 'stt' })).toBe(1);
    expect(m.total('vid2context.stt.audio_seconds', { service: 'ovh' })).toBe(23.06);
    expect(m.total('vid2context.paid.usd')).toBe(0);
    const dur = [...(m.histograms.get('vid2context.rung.duration')?.values() ?? [])];
    expect(dur).toHaveLength(1);
    expect(dur[0]?.count).toBe(1);

    expect(telemetry.ledger?.snapshot().rungs).toEqual([
      {
        rung: 'stt/ovh/whisper-large-v3-turbo',
        tier: 'keyless',
        requests: 1,
        failures: 0,
        tokensIn: 0,
        tokensOut: 0,
        audioSeconds: 23.06,
      },
    ]);

    assertNoText(memory.spans, [...result.transcript.segments.map((s) => s.text), APOLLO, 'apollo11-small-step']);
    expect(renderPrometheus(telemetry)).toContain(
      'vid2context_rung_attempts_total{rung="stt/ovh/whisper-large-v3-turbo",service="ovh",tier="keyless",stage="stt",outcome="ok"} 1',
    );
  });

  it('records the real 429 as a failed rung span, then the cooldown skip', async () => {
    const limited = () =>
      replayFetch([
        { url: OVH_STT, response: { status: 429, headers: { 'retry-after': '31' }, body: sttFixture('ovh-429.json') } },
      ]);
    const { memory, telemetry, ctx } = withTelemetry(limited());
    await expect(getVideoContext(files, APOLLO, { mode: 'stt' }, ctx)).rejects.toMatchObject({ code: 'no-transcript' });
    const rung = only(memory.spans, 'vid2context.rung');
    expect(rung.status).toBe('error');
    expect(rung.statusMessage).toBe('rate-limited');
    expect(rung.attributes['vid2context.reason']).toBe('rate-limited-429');
    expect(only(memory.spans, 'vid2context.get_context').status).toBe('error');

    await expect(getVideoContext(files, APOLLO, { mode: 'stt' }, ctx)).rejects.toMatchObject({ code: 'no-transcript' });
    const m = telemetry.metrics;
    expect(m.total('vid2context.rung.attempts', { outcome: 'error', reason: 'rate-limited-429' })).toBe(1);
    expect(m.total('vid2context.rung.attempts', { outcome: 'skipped', reason: 'cooldown' })).toBe(1);
    expect(telemetry.ledger?.snapshot().rungs[0]).toMatchObject({ requests: 1, failures: 1 });
  });
});

describe('LLM token usage on a recorded OVH completion', () => {
  it('counts tokens in and out from the result usage', async () => {
    const fetch = replayFetch([{ method: 'POST', url: OVH_CHAT, response: { body: llmFixture('ovh-gpt-oss-120b.json') } }]);
    const { memory, telemetry, ctx } = withTelemetry(fetch);
    const registry = new Registry([llmProvider], 'node');
    const question = 'Which year did Apollo 11 land on the moon? Answer in one short sentence.';
    const res = await chat(registry, { messages: [{ role: 'user', content: question }] }, { only: ['ovh'] }, ctx);
    expect(res.usage).toEqual({ inputTokens: 84, outputTokens: 66 });
    expect(telemetry.metrics.total('vid2context.llm.tokens', { service: 'ovh', direction: 'in' })).toBe(84);
    expect(telemetry.metrics.total('vid2context.llm.tokens', { service: 'ovh', direction: 'out' })).toBe(66);
    assertNoText(memory.spans, [question, res.text]);
  });
});

describe('usage ledger and daily paid guard', () => {
  const audio = {
    kind: 'bytes' as const,
    data: new Uint8Array(readFileSync(APOLLO)),
    mimeType: 'audio/mpeg',
    filename: 'apollo11-small-step.mp3',
  };
  const ref = { input: APOLLO, platform: 'file', kind: 'video' as const, id: 'file:apollo', nativeId: 'apollo' };

  it('skips a paid rung with reason budget once recorded spend reaches the limit', async () => {
    const env = { OPENAI_API_KEY: 'sk-x', VID2CONTEXT_MAX_PAID_USD_PER_DAY: '0.05' };
    const { telemetry, ctx } = withTelemetry(replayFetch([]), env);
    // Ten minutes of Whisper at the verified $0.006 per minute: $0.06.
    expect(telemetry.ledger?.record({ rung: 'stt/openai/whisper-1', tier: 'paid', ok: true, audioSec: 600 })).toBeCloseTo(0.06);
    expect(telemetry.ledger?.overBudget()).toBe(true);

    const err = await transcribe(files, ref, audio, { chain: { only: ['openai'] } }, ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'all-rungs-failed' });
    expect(attemptsOf(err)).toEqual([
      {
        id: 'stt/openai/whisper-1',
        stage: 'stt',
        outcome: 'skipped',
        reason: 'budget',
        detail: expect.stringContaining('VID2CONTEXT_MAX_PAID_USD_PER_DAY'),
      },
    ]);
    expect(telemetry.metrics.total('vid2context.rung.attempts', { outcome: 'skipped', reason: 'budget' })).toBe(1);
    expect(telemetry.ledger?.snapshot()).toMatchObject({
      paidUsdToday: expect.closeTo(0.06),
      maxPaidUsdPerDay: 0.05,
      overBudget: true,
    });
  });

  it('leaves keyless and free rungs alone when over budget', async () => {
    const env = { OPENAI_API_KEY: 'sk-x', VID2CONTEXT_MAX_PAID_USD_PER_DAY: '0' };
    const fetch = replayFetch([
      { method: 'POST', url: OVH_STT, response: { body: sttFixture('ovh-whisper-large-v3-turbo.verbose.json') } },
    ]);
    const { ctx } = withTelemetry(fetch, env);
    const res = await transcribe(files, ref, audio, {}, ctx);
    expect(res.transcript.producer).toBe('stt/ovh/whisper-large-v3-turbo');
  });

  it('reads prices from env, drops the pooled-key suffix and leaves unknown prices unestimated', () => {
    expect(priceEnvName('llm/groq#2/openai/gpt-oss-120b')).toBe('VID2CONTEXT_PRICE_LLM_GROQ_OPENAI_GPT_OSS_120B');
    expect(priceFor('llm/openai/gpt-5.4-nano', {})).toEqual({ kind: 'tokens', inPerM: 0.2, outPerM: 1.25 });
    expect(priceFor('llm/openai/gpt-5.4-nano', { VID2CONTEXT_PRICE_LLM_OPENAI_GPT_5_4_NANO: '1, 2' })).toEqual({
      kind: 'tokens',
      inPerM: 1,
      outPerM: 2,
    });
    expect(priceFor('stt/openai#2/whisper-1', {})).toEqual({ kind: 'audio', perMinute: 0.006 });
    expect(priceFor('llm/openai/gpt-5.4-nano', { VID2CONTEXT_PRICE_LLM_OPENAI_GPT_5_4_NANO: '3' })).toBeUndefined();
    const ledger = new UsageLedger({ env: {} });
    expect(ledger.record({ rung: 'llm/openai/some-new-model', tier: 'paid', ok: true, tokensIn: 1000 })).toBeUndefined();
    expect(
      ledger.record({ rung: 'llm/openai/gpt-5.4-nano', tier: 'paid', ok: true, tokensIn: 1_000_000, tokensOut: 1_000_000 }),
    ).toBeCloseTo(1.45);
    expect(ledger.overBudget()).toBe(false);
  });

  it('resets daily spend at UTC midnight', () => {
    let now = Date.parse('2026-11-14T23:59:00Z');
    const ledger = new UsageLedger({ env: { VID2CONTEXT_MAX_PAID_USD_PER_DAY: '0.001' }, now: () => now });
    ledger.record({ rung: 'stt/openai/whisper-1', tier: 'paid', ok: true, audioSec: 60 });
    expect(ledger.overBudget()).toBe(true);
    now = Date.parse('2026-11-15T00:00:01Z');
    expect(ledger.overBudget()).toBe(false);
    expect(ledger.snapshot()).toMatchObject({ day: '2026-11-15', paidUsdToday: 0, totals: { usd: expect.closeTo(0.006) } });
  });
});

describe('OTLP/HTTP JSON export', () => {
  const env = {
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.test:4318/',
    OTEL_EXPORTER_OTLP_HEADERS: 'x-tenant=team%20a',
    OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=test,service.version=1.2.3',
  };

  it('posts resourceSpans and resourceMetrics in the OTLP JSON encoding', async () => {
    const sink = replayFetch([
      { method: 'POST', url: /^http:\/\/collector\.test:4318\/v1\/(traces|metrics)$/, response: collector },
    ]);
    const ovh = replayFetch([
      { method: 'POST', url: OVH_STT, response: { body: sttFixture('ovh-whisper-large-v3-turbo.verbose.json') } },
    ]);
    const { telemetry, ctx } = withTelemetry(ovh, env, sink);
    await getVideoContext(files, APOLLO, { mode: 'stt' }, ctx);
    await telemetry.flush();

    expect(sink.calls.map((c) => c.url)).toEqual([
      'http://collector.test:4318/v1/traces',
      'http://collector.test:4318/v1/metrics',
    ]);
    const [tracesCall, metricsCall] = sink.calls as [RecordedCall, RecordedCall];
    expect(tracesCall.method).toBe('POST');
    expect(tracesCall.headers['content-type']).toBe('application/json');
    expect(tracesCall.headers['x-tenant']).toBe('team a');

    const traces = JSON.parse(String(tracesCall.body));
    const rs = traces.resourceSpans[0];
    expect(rs.resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'vid2context' } },
      { key: 'deployment.environment', value: { stringValue: 'test' } },
      { key: 'service.version', value: { stringValue: '1.2.3' } },
    ]);
    expect(rs.scopeSpans[0].scope).toEqual({ name: 'vid2context' });
    type OtlpSpan = {
      name: string;
      traceId: string;
      spanId: string;
      parentSpanId?: string;
      kind: number;
      startTimeUnixNano: string;
      endTimeUnixNano: string;
      attributes: unknown[];
    };
    const spans = rs.scopeSpans[0].spans as OtlpSpan[];
    // Spans are exported in the order they end.
    expect(spans.map((s) => s.name)).toEqual([
      'vid2context.resolve',
      'vid2context.metadata',
      'vid2context.audio',
      'vid2context.rung',
      'vid2context.stt',
      'vid2context.get_context',
    ]);
    const byName = Object.fromEntries(spans.map((s) => [s.name, s])) as Record<string, OtlpSpan>;
    const request = byName['vid2context.get_context'] as OtlpSpan;
    for (const s of spans) {
      expect(s.traceId).toBe(request.traceId);
      expect(s.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(s.startTimeUnixNano).toMatch(/^\d{19}$/);
      expect(s.endTimeUnixNano).toMatch(/^\d{19}$/);
      expect(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano)).toBe(true);
      expect(s.kind).toBe(1);
    }
    expect(request.parentSpanId).toBeUndefined();
    expect(byName['vid2context.stt']?.parentSpanId).toBe(request.spanId);
    expect(byName['vid2context.rung']?.parentSpanId).toBe(byName['vid2context.stt']?.spanId);
    expect(byName['vid2context.rung']?.attributes).toContainEqual({
      key: 'vid2context.rung.id',
      value: { stringValue: 'stt/ovh/whisper-large-v3-turbo' },
    });
    expect(byName['vid2context.rung']?.attributes).toContainEqual({
      key: 'vid2context.usage.audio_seconds',
      value: { doubleValue: 23.06 },
    });
    expect(String(tracesCall.body)).not.toContain('small step');

    const metrics = JSON.parse(String(metricsCall.body));
    type OtlpMetric = {
      name: string;
      unit: string;
      sum?: {
        aggregationTemporality: number;
        isMonotonic: boolean;
        dataPoints: { asInt?: string; asDouble?: number; attributes: unknown[] }[];
      };
      histogram?: {
        aggregationTemporality: number;
        dataPoints: {
          count: string;
          bucketCounts: string[];
          explicitBounds: number[];
          startTimeUnixNano: string;
          timeUnixNano: string;
          attributes: unknown[];
        }[];
      };
    };
    const list = metrics.resourceMetrics[0].scopeMetrics[0].metrics as OtlpMetric[];
    const attemptsMetric = list.find((m) => m.name === 'vid2context.rung.attempts');
    expect(attemptsMetric?.sum).toMatchObject({ aggregationTemporality: 2, isMonotonic: true });
    expect(attemptsMetric?.sum?.dataPoints[0]?.asInt).toBe('1');
    expect(list.find((m) => m.name === 'vid2context.stt.audio_seconds')?.sum?.dataPoints[0]?.asDouble).toBe(23.06);
    const stage = list.find((m) => m.name === 'vid2context.stage.duration');
    expect(stage?.unit).toBe('ms');
    expect(stage?.histogram?.aggregationTemporality).toBe(2);
    const point = stage?.histogram?.dataPoints[0];
    expect(point?.count).toBe('1');
    expect(point?.bucketCounts).toHaveLength((point?.explicitBounds.length ?? 0) + 1);
    expect(point?.bucketCounts.every((c) => typeof c === 'string')).toBe(true);
    expect(point?.startTimeUnixNano).toMatch(/^\d{19}$/);
    expect(BigInt(point?.timeUnixNano ?? '0') >= BigInt(point?.startTimeUnixNano ?? '0')).toBe(true);
    expect(point?.attributes).toContainEqual({ key: 'stage', value: { stringValue: 'resolve' } });
  });

  it('encodes int, double and bool attributes and an error status', async () => {
    const sink = replayFetch([{ method: 'POST', url: 'http://collector.test:4318/v1/traces', response: collector }]);
    const telemetry = createTelemetry(
      { env: { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector.test:4318/v1/traces' }, fetch: sink },
      { flushIntervalMs: 0 },
    );
    await telemetry
      .span('vid2context.check', { count: 3, ratio: 0.5, cached: true }, async () => {
        throw Object.assign(new Error('secret detail with https://example.com/?key=abc'), { code: 'rate-limited' });
      })
      .catch(() => undefined);
    await telemetry.flush();
    const span = JSON.parse(String(sink.calls[0]?.body)).resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.attributes).toEqual([
      { key: 'count', value: { intValue: '3' } },
      { key: 'ratio', value: { doubleValue: 0.5 } },
      { key: 'cached', value: { boolValue: true } },
    ]);
    expect(span.status).toEqual({ code: 2, message: 'rate-limited' });
    expect(JSON.stringify(span)).not.toContain('secret detail');
  });

  it('drops and counts a batch the collector cannot take, without throwing', async () => {
    const unreachable = replayFetch([]);
    const telemetry = createTelemetry({ env, fetch: unreachable }, { flushIntervalMs: 0 });
    await telemetry.span('vid2context.check', {}, async () => 1);
    await expect(telemetry.flush()).resolves.toBeUndefined();
    expect(telemetry.metrics.total('vid2context.telemetry.dropped', { signal: 'traces' })).toBe(1);
  });

  it('is off without an endpoint and when OTEL_SDK_DISABLED is true', async () => {
    const fetch = replayFetch([]);
    for (const e of [{}, { ...env, OTEL_SDK_DISABLED: 'true' }]) {
      const telemetry = createTelemetry({ env: e, fetch }, { flushIntervalMs: 0 });
      await telemetry.span('vid2context.check', {}, async () => 1);
      await telemetry.flush();
    }
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('trace context, scopes and events', () => {
  it('parses and formats W3C traceparent', () => {
    const header = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    expect(parseTraceparent(header)).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      sampled: true,
    });
    expect(formatTraceparent({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7' })).toBe(header);
    for (const bad of [
      '',
      'garbage',
      'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
      '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01',
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra',
    ]) {
      expect(parseTraceparent(bad)).toBeNull();
    }
  });

  it('continues an incoming trace in a scope and keeps events on the open span', async () => {
    const memory = new InMemoryExporter();
    const telemetry = createTelemetry({ env: {}, fetch: replayFetch([]) }, { exporters: [memory], flushIntervalMs: 0 });
    const incoming = parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    const scope = telemetry.scope(incoming ?? undefined);
    await scope.span('vid2context.request', {}, async () => {
      scope.event('vid2context.cache_hit', { ref: 'youtube:jNQXAC9IVRw' });
    });
    telemetry.event('vid2context.startup', {});
    const [span] = memory.spans;
    expect(span?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(span?.parentSpanId).toBe('00f067aa0ba902b7');
    expect(span?.events.map((e) => e.name)).toEqual(['vid2context.cache_hit']);
    expect(telemetry.metrics.total('vid2context.events', { event: 'vid2context.startup' })).toBe(1);
  });
});

describe('JSON-lines logs', () => {
  it('writes one JSON object per line with trace ids inside a span, and keeps the text format by default', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      const memory = new InMemoryExporter();
      const telemetry = createTelemetry({ env: {}, fetch: replayFetch([]) }, { exporters: [memory], flushIntervalMs: 0 });
      const ctx = createContext({
        runtime: 'node',
        env: { VID2CONTEXT_LOG_FORMAT: 'json', VID2CONTEXT_LOG_LEVEL: 'info' },
        telemetry,
      });
      ctx.log.info('outside', { rung: 'stt/ovh/whisper-large-v3-turbo' });
      await telemetry.span('vid2context.request', {}, async () => ctx.log.warn('inside', { ts: 'not overridden' }));
      stderrLogger('info').info('plain', { a: 1 });

      const [outside, inside] = lines.slice(0, 2).map((l) => JSON.parse(l));
      expect(outside).toMatchObject({ level: 'info', msg: 'outside', rung: 'stt/ovh/whisper-large-v3-turbo' });
      expect(outside.trace_id).toBeUndefined();
      expect(Number.isNaN(Date.parse(outside.ts))).toBe(false);
      expect(inside).toMatchObject({
        level: 'warn',
        msg: 'inside',
        trace_id: memory.spans[0]?.traceId,
        span_id: memory.spans[0]?.spanId,
      });
      expect(inside.ts).not.toBe('not overridden');
      expect(lines[2]).toBe('[vid2context] info: plain {"a":1}');
    } finally {
      spy.mockRestore();
    }
  });
});
