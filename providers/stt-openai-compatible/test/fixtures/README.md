# Speech-to-text fixtures

Real responses from OVH AI Endpoints (keyless) on 2026-11-14 for `tests/fixtures/media/apollo11-small-step.mp3`.

| File | Request | Response |
|---|---|---|
| `ovh-whisper-large-v3-turbo.verbose.json` | `POST /v1/audio/transcriptions`, `model=whisper-large-v3-turbo`, `response_format=verbose_json` | 200, language `en`, two segments |
| `ovh-400-extension.json` | Same, uploaded as `audio.out` | 400 `extension "out" not supported` |
| `ovh-429.json` | Third request inside one minute | 429 with headers `retry-after: 31`, `x-ratelimit-limit-minute: 2` |

The keyless tier allows about 2 requests per minute per IP. Space live test runs accordingly.
