# Streaming LLM fixtures

Real `POST /chat/completions` responses with `stream: true` and `stream_options: { include_usage: true }`, recorded on 2026-11-14 from the keyless lanes with no key sent. Each recording is two files:

- `<name>.body`: the raw response body bytes, exactly as received (SSE for the 200s).
- `<name>.meta.json`: URL, HTTP status, the request body sent, the recording time, and a trimmed set of response headers (`content-type`, `cache-control`, `transfer-encoding`, `retry-after`; nothing else was kept, so no request ids that could identify the caller beyond the one inside the 429 body, which is OVH's own id).

| Recording | Endpoint and model | Notes |
|---|---|---|
| `ovh-gpt-oss-120b.stream` | OVH AI Endpoints `gpt-oss-120b` | reasoning deltas in `delta.reasoning`, then content deltas, a `finish_reason: stop` chunk, a usage chunk with empty `choices`, `[DONE]` |
| `ovh-llama-3.3-70b.stream` | OVH AI Endpoints `Meta-Llama-3_3-70B-Instruct` | starts with SSE comment lines (`:`) used as keepalives; content deltas only; usage chunk; `[DONE]` |
| `pollinations-openai-fast.stream` | Pollinations `openai-fast` (serves gpt-oss-20b) | reasoning deltas, content deltas, usage chunk, `[DONE]` |
| `pollinations-openai-fast.japanese.stream` | Pollinations `openai-fast` | answer in Japanese, so the body has multi-byte UTF-8 inside deltas (used to split inside characters) |
| `ovh-llama-3.3-70b.stream.http429` | OVH AI Endpoints `Meta-Llama-3_3-70B-Instruct` | a real `429` with `retry-after: 54`, triggered by the fourth request within a minute (OVH allows about 2 per minute per model per IP) |

The prompt for the English recordings: "Which year did Apollo 11 land on the moon? Answer in one short sentence." For the Japanese one: "Translate into Japanese, reply with the translation only: That is one small step for man, one giant leap for mankind."
