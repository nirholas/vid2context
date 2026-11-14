# OpenRouter fixtures

Real responses from openrouter.ai recorded on 2026-11-14 from a GCP VM with curl, no key sent unless noted.

| File | Request | Notes |
|---|---|---|
| `openrouter-models.json` | `GET https://openrouter.ai/api/v1/models` | all 471 models, 14 of them `:free`. Trimmed to the fields the picker reads (`id`, `name`, `created`, `context_length`, `architecture.input_modalities` and `output_modalities`, `pricing.prompt` and `completion`); values unchanged |
| `openrouter-404.json` | `GET https://openrouter.ai/api/v1/models/nosuchvendor/retired-model:free/endpoints` | HTTP 404 in OpenRouter's standard error envelope. Recorded from the endpoints API because the chat endpoint needs a valid key; the tests replay it as a chat 404 |
| `openrouter-401.json` | `POST https://openrouter.ai/api/v1/chat/completions` with the invalid key `sk-or-v1-invalid` | HTTP 401 "User not found." |

No successful OpenRouter chat completion is recorded: there was no OpenRouter key on the VM. The LIVE test covers it when `OPENROUTER_API_KEY` is set.
