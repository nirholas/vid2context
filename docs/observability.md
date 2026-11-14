# Observability

vid2context can record a span for every pipeline stage and every rung attempt, counters and histograms for outcomes and latency, and a usage ledger with tokens, audio seconds and the estimated cost of paid rungs. It exports to open formats you can run yourself: OTLP/HTTP JSON (an OpenTelemetry Collector), Prometheus text, and JSON-lines logs. No vendor account is needed.

Telemetry is off unless a surface passes one in. With `ctx.telemetry` unset, the chain and the pipeline behave exactly as before and allocate nothing extra.

## Turning it on

```ts
import { createContext, createTelemetry, getVideoContext } from '@vid2context/core';

const telemetry = createTelemetry({ env, fetch }, { serviceVersion: '0.1.0' });
const ctx = createContext({ runtime: 'node', env, telemetry });
await getVideoContext(registry, url, {}, ctx);
await telemetry.shutdown(); // or flush() periodically
```

`createTelemetry` always builds the usage ledger (pass `ledger: false` to skip it) and adds an OTLP exporter when an `OTEL_EXPORTER_OTLP_*ENDPOINT` is set. Extra exporters go in `exporters`; `InMemoryExporter` keeps spans in an array for tests and debug views.

Spans nest under the innermost open span of a telemetry scope. That is exact for sequential code (the pipeline and the chain). Give each concurrent unit of work its own scope: `telemetry.scope(parseTraceparent(req.headers.get('traceparent')) ?? undefined)` for an HTTP request continues the caller's trace. `formatTraceparent(span.context)` builds the header for outgoing calls.

On Workers, set `OTEL_BSP_SCHEDULE_DELAY=0` (or `flushIntervalMs: 0`) and call `ctx.waitUntil(telemetry.flush())` at the end of each request.

## What is measured

Spans:

| Span | When | Attributes |
|---|---|---|
| `vid2context.get_context` | one per `getVideoContext` call | `vid2context.mode` |
| `vid2context.<stage>` | `resolve`, `metadata`, `captions`, `audio`, `stt`, `video`, `comments`, `save` | `vid2context.stage`, `vid2context.ref` (the ref id), `vid2context.platform`, `vid2context.outcome` (`ok`, `empty`, `error`) |
| `vid2context.rung` | each rung attempt in the chain (stt, llm, video, embed, visual) | `vid2context.rung.id`, `.service`, `.tier`, `.model`, `vid2context.stage`, `vid2context.outcome`, `vid2context.reason`, `vid2context.duration_ms`, and `vid2context.usage.tokens_in`, `.tokens_out`, `.audio_seconds`, `.usd` when known |

A failed span has status error with the error code (`rate-limited`, `auth`, ...) as its message and an `exception` event with the error type. Error messages are never recorded, because they can carry URLs or text.

Metrics (cumulative):

| Metric | Type | Attributes |
|---|---|---|
| `vid2context.rung.attempts` | counter | `rung`, `service`, `tier`, `stage`, `outcome` (`ok`, `error`, `skipped`), `reason` |
| `vid2context.rung.duration` | histogram, ms | `rung`, `service`, `tier`, `stage`, `outcome` |
| `vid2context.stage.duration` | histogram, ms | `stage`, `outcome` |
| `vid2context.llm.tokens` | counter | `rung`, `service`, `tier`, `direction` (`in`, `out`) |
| `vid2context.stt.audio_seconds` | counter, s | `rung`, `service`, `tier` |
| `vid2context.paid.usd` | counter, USD | `rung`, `service`, `tier` |
| `vid2context.events` | counter | `event` (events raised with no open span) |
| `vid2context.telemetry.dropped` | counter | `signal` (`traces`, `metrics`): batches the exporter could not deliver |

Histogram buckets (ms): 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000, 300000.

What is never recorded: transcript text, prompts, titles, input URLs or file paths (only the ref id), query strings, keys or any env value. String attributes are capped at 256 characters and URL-shaped values lose their query string as a second line of defence.

Speech-to-text audio seconds come from the result's `durationSec` when a rung reports it, otherwise from the end of the last segment, which can undercount trailing silence.

## Usage ledger and paid guard

`telemetry.ledger.snapshot()` returns plain JSON for surfaces (`vid2context models`, a `/metrics` page, the web app):

```json
{
  "day": "2026-11-14",
  "paidUsdToday": 0,
  "overBudget": false,
  "totals": { "requests": 1, "failures": 0, "tokensIn": 0, "tokensOut": 0, "audioSeconds": 23.06, "usd": 0 },
  "rungs": [{ "rung": "stt/ovh/whisper-large-v3-turbo", "tier": "keyless", "requests": 1, "failures": 0, "tokensIn": 0, "tokensOut": 0, "audioSeconds": 23.06 }]
}
```

(That is the snapshot after transcribing the shared Apollo 11 clip on the keyless OVH rung: keyless rungs have no cost, so `usd` is absent on the row.)

Cost is estimated only for paid rungs with a known price. Prices are USD: `in,out` per million tokens for LLMs, one number per audio minute for speech-to-text. Set or override one with `VID2CONTEXT_PRICE_<RUNG_ID_NORMALIZED>`: the rung id upper-cased, the pooled-key suffix (`#2`) dropped, every run of other characters turned into `_`. For example `stt/openai/whisper-1` reads `VID2CONTEXT_PRICE_STT_OPENAI_WHISPER_1`.

Shipped defaults, verified on 2026-11-14 at https://developers.openai.com/api/docs/pricing (standard tier):

| Rung | Price |
|---|---|
| `llm/openai/gpt-5.4-nano` | 0.20 in, 1.25 out per million tokens |
| `stt/openai/whisper-1` | 0.006 per minute |

Any other paid rung is counted but not estimated until you set its price. The defaults are keyed by rung id, so if `OPENAI_BASE_URL` points at another vendor, set that vendor's price explicitly.

`VID2CONTEXT_MAX_PAID_USD_PER_DAY` caps estimated paid spend per process and UTC day. Once reached, the chain skips paid rungs with attempt reason `budget` and a detail naming the variable; local, free and keyless rungs keep running. The guard only acts when the context carries telemetry with a ledger.

## Exporters

OTLP/HTTP JSON, enabled by env:

| Env var | Meaning |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | base URL; `/v1/traces` and `/v1/metrics` are appended |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | full URL per signal, used as is |
| `OTEL_EXPORTER_OTLP_HEADERS` | `key=value,key2=value2`, values percent-encoded |
| `OTEL_RESOURCE_ATTRIBUTES` | e.g. `deployment.environment=prod,service.version=1.4.0` |
| `OTEL_SERVICE_NAME` | overrides `service.name` (default `vid2context`) |
| `OTEL_BSP_SCHEDULE_DELAY` | flush interval in ms (default 5000; 0 turns the timer off) |
| `OTEL_BSP_MAX_QUEUE_SIZE`, `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` | span queue bound (2048) and batch size (512) |
| `OTEL_SDK_DISABLED=true` | no OTLP export |

Spans go out in batches when a batch fills, on the interval, and on `flush()`. Metrics go out as a cumulative snapshot on every flush. When the queue is full or the collector fails, the batch is dropped and counted in `vid2context.telemetry.dropped`; the exporter never throws into a request. Requests use the `fetch` you pass, so it works on Node, Workers and in the browser.

Prometheus: `renderPrometheus(telemetry)` returns the text exposition (serve it with `PROMETHEUS_CONTENT_TYPE`). Counters end in `_total`, millisecond histograms in `_milliseconds`, for example `vid2context_rung_attempts_total` and `vid2context_stage_duration_milliseconds_bucket`.

JSON logs: `VID2CONTEXT_LOG_FORMAT=json` makes the default stderr logger write one object per line with `ts`, `level`, `msg`, the data fields, and `trace_id` and `span_id` when a span is open. The default text format is unchanged. Both formats are redacted the same way.

## Minimal local setup

`otel-collector.yaml`:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  debug:
    verbosity: basic
  prometheus:
    endpoint: 0.0.0.0:8889
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
    metrics:
      receivers: [otlp]
      exporters: [prometheus]
```

```sh
docker run --rm -p 4318:4318 -p 8889:8889 \
  -v "$PWD/otel-collector.yaml:/etc/otelcol-contrib/config.yaml" \
  otel/opentelemetry-collector-contrib:0.115.0
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

The `prometheus` exporter ships in the contrib image; the core image has the `debug` exporter only. Point Prometheus at the collector:

```yaml
scrape_configs:
  - job_name: vid2context
    static_configs:
      - targets: ['localhost:8889']
```

Grafana can then read Prometheus for the metrics and Tempo or Jaeger (both accept OTLP) for the traces.
