# Telemetry fixtures

| File | Source |
|---|---|
| `otlp-collector-200.json` | Response of a real OpenTelemetry Collector (`otel/opentelemetry-collector:0.115.0`, OTLP/HTTP receiver, debug exporter) to `POST /v1/traces` and `POST /v1/metrics` with `content-type: application/json`, recorded locally on 2026-11-14. Both signals returned the same status, `content-type` and body. The `Date` and `Content-Length` headers were dropped. |

The telemetry tests also replay fixtures owned by other packages, unchanged:
`providers/youtube/test/fixtures/` (player and timedtext for jNQXAC9IVRw),
`providers/stt-openai-compatible/test/fixtures/` (OVH Whisper 200 and 429),
`providers/llm-openai-compatible/test/fixtures/ovh-gpt-oss-120b.json` (token usage),
and the shared `tests/fixtures/media/apollo11-small-step.mp3`.
