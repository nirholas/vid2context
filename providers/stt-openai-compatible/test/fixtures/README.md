# Speech-to-text fixtures

Real responses recorded on 2026-11-14 for `tests/fixtures/media/apollo11-small-step.mp3` (public domain), sent as multipart `POST <base>/audio/transcriptions` from Node 22 `fetch`. Files named `*.response.json` are envelopes `{ status, headers, body }`: the status and body exactly as received, and only the `content-type`, `retry-after` and `x-ratelimit-*` headers kept (the rest carried nothing the tests need). No IP addresses, emails or keys appear in any file (checked with grep against the recording machine's public IP).

## OVH AI Endpoints (keyless)

| File | Request | Response |
|---|---|---|
| `ovh-whisper-large-v3-turbo.verbose.json` | `model=whisper-large-v3-turbo`, `response_format=verbose_json` (body only) | 200, language `en`, two segments |
| `ovh-whisper-large-v3-turbo.words.response.json` | same, plus `timestamp_granularities[]=word` and `timestamp_granularities[]=segment` | 200, two segments and 19 top-level words |
| `ovh-json.response.json` | `response_format=json` | 200, `text` only, no segments or language |
| `ovh-text.response.json` | `response_format=text` | 200, plain text body, no Content-Type header |
| `ovh-400-extension.json` | uploaded as `audio.out` (body only) | 400 `extension "out" not supported` |
| `ovh-400-corrupt.response.json` | 4096 bytes of non-audio data uploaded as `corrupt.mp3` | 400 `Failed to read and convert audio ... Invalid data found when processing input` |
| `ovh-404-model.response.json` | `model=whisper-nope` | 404 `model_not_found` |
| `ovh-429.json` | third request inside one minute (body only) | 429 with headers `retry-after: 31`, `x-ratelimit-limit-minute: 2` |
| `ovh-429-headers.response.json` | third request in a burst | 429 with `retry-after: 56`, `x-ratelimit-remaining-minute: 0` |
| `ovh-429-short.response.json` | a request 35 s after two others | 429 with `retry-after: 11`. Copied from the recording script's console log (status, kept headers and full body as printed), because the file it wrote was overwritten by a later retry |

The keyless tier allows about 2 requests per minute per IP. Space live test runs accordingly.

## Keyed services, requested without a key

No keys for these services were available when recording, so each file is the service's real reply to a request without a valid key. They verify the endpoint URL and the error body shape; they are not transcriptions.

| File | Endpoint | Response |
|---|---|---|
| `groq-401-no-key.response.json` | `https://api.groq.com/openai/v1/audio/transcriptions` | 401 `invalid_api_key` |
| `deepinfra-401-no-key.response.json` | `https://api.deepinfra.com/v1/openai/audio/transcriptions` | 401 `missing API key` |
| `together-401-no-key.response.json` | `https://api.together.xyz/v1/audio/transcriptions` | 401 `Missing API key` |
| `mistral-401-no-key.response.json` | `https://api.mistral.ai/v1/audio/transcriptions` | 401 `Invalid API Key` |
