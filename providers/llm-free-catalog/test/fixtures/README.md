# Free LLM catalog fixtures

Real responses recorded on 2026-11-14 from a GCP VM with curl. Nothing was edited except where noted. No key appears in any file; Cloudflare URLs in the tests use a made-up account id, and the recorded bodies contain no account id.

Prompts: "Which year did Apollo 11 land on the moon? Answer with the year only." (plain), the same with "Use keys year and mission." (JSON modes), and the `check:llm` prompt "What is 17 plus 25? Reply with the number only." (`*.check.json`).

| File | Endpoint and model | Notes |
|---|---|---|
| `kilo-nemotron-3-ultra.json` | Kilo gateway, keyless, `nvidia/nemotron-3-ultra-550b-a55b:free`, `reasoning.enabled: false` | answer `1969` in `content`, `reasoning: null` |
| `kilo-nemotron-3-ultra.json-object.json` | same, `response_format: json_object` | JSON answer |
| `kilo-nemotron-3-ultra.check.json` | same, check prompt, `max_tokens: 400` | answer `42` |
| `kilo-nemotron-3.5-super-vl.reasoning.json` | Kilo keyless, `nvidia/nemotron-3.5-super-vl:free`, reasoning left on | answer in `content`, chain of thought in `reasoning` and `reasoning_details` |
| `kilo-404-retired-model.json` | Kilo keyless, `nvidia/nemotron-3-super-120b-a12b:free` | HTTP 404 `model_not_found`: the route three.ws pinned is gone |
| `cloudflare-llama-3.3-70b.json` | Workers AI OpenAI-compatible endpoint, `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | answer `1969`; the response header `cf-ai-neurons: 2.00` shows the cost |
| `cloudflare-llama-3.3-70b.json-object.json` | same, `json_object` | JSON answer |
| `cloudflare-llama-3.3-70b.json-schema.json` | same, `json_schema` with `strict: true` | JSON answer matching the schema |
| `cloudflare-llama-3.3-70b.check.json` | same, check prompt | answer `42` |
| `cloudflare-401.json` | same endpoint, invalid token | HTTP 401 Cloudflare error envelope |
| `nvidia-401.json` | `integrate.api.nvidia.com`, invalid key | HTTP 401 |
| `sambanova-401.json` | `api.sambanova.ai`, invalid key | HTTP 401; SambaNova masks the key it echoes |
| `zhipu-401.json` | `api.z.ai/api/paas/v4`, invalid key | HTTP 401 |
| `siliconflow-401.json` | `api.siliconflow.com`, invalid key | HTTP 401 |
| `ovh-429.json` | OVH AI Endpoints keyless, third request inside a minute | HTTP 429 body. Headers sent with it: `retry-after: 20`, `ratelimit-reset: 20`, `ratelimit-limit: 2`, `ratelimit-remaining: 0`, `x-ratelimit-limit-minute: 2`, `x-ratelimit-remaining-minute: 0` (the tests replay these values) |

The invalid key sent for the 401 recordings was the literal string `invalid-key-for-recording`.
