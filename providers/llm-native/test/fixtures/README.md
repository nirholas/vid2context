# llm-native fixtures

Real responses recorded on 2026-11-14 with `scripts/record-fixtures.ts`, which runs the provider's own rungs through a fetch that saves each response. Each file is a `RecordedResponse` (`status`, an allowlist of headers, `body`) for `replayFetch`. The Google Cloud project id and number are replaced with `redacted-project`; the metadata token value with `redacted-token`.

| File | Request | What it shows |
|---|---|---|
| `anthropic.401-invalid-key.json` | `POST https://api.anthropic.com/v1/messages`, `x-api-key: sk-ant-invalid`, model `claude-haiku-5-5` | Anthropic's error body (`authentication_error: invalid x-api-key`) and `x-should-retry: false` |
| `gemini-native.400-invalid-key.json` | `POST generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent`, `x-goog-api-key: invalid-key` | Google returns HTTP 400 `INVALID_ARGUMENT` with reason `API_KEY_INVALID` for a bad key, not 401 |
| `vertex-gemini.chat.403.json` | Vertex `publishers/google/models/gemini-3.8-flash:generateContent`, us-central1, gcloud user token | HTTP 403 `PERMISSION_DENIED`: the project's billing account is locked |
| `vertex-gemini.stream.403.json` | the same, `:streamGenerateContent?alt=sse` | the same error as a plain JSON object |
| `vertex-anthropic.chat.403.json` | Vertex `publishers/anthropic/models/claude-haiku-5-5:rawPredict`, global | HTTP 403, Google error shape (not Anthropic's) |
| `vertex-anthropic.stream.403.json` | the same, `:streamRawPredict` | the error body is wrapped in a one-element JSON array |
| `gce-metadata.token.json` | `GET http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token` on the owner's GCP VM | the metadata server's token shape (`access_token`, `expires_in`, `token_type`) |

Not recorded yet: successful Anthropic, Gemini and Vertex responses (chat, SSE stream, JSON Schema, the two-question cache pair) and a real 429. No Anthropic or Gemini key was available, and the Vertex project's billing was locked. To record them, set the keys and run:

```sh
npx tsx --env-file=.env providers/llm-native/scripts/record-fixtures.ts
```

Review the new files for anything personal before committing, add a row for each here, and add replay tests for stream parsing and usage mapping.
