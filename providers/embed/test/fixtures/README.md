# Embedding fixtures

Real responses recorded on 2026-11-14 from a GCP VM with curl or Node `fetch`. OVH calls sent no key. Cloudflare calls used the owner's account token; the responses contain no account id or token. Nothing in these files is personal.

`sentences.json` holds eight sentences copied verbatim from the auto-captions in `tests/fixtures/contexts/youtube-cCPsdFdlshc.json`. Pairs 0 and 1, 2 and 3, 4 and 5 say the same thing in different words; 6 and 7 are about other topics.

| File | Request | Response |
|---|---|---|
| `ovh-models.json` | `GET https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models` | 200, the model listing (includes `bge-m3`, `Qwen3-Embedding-8B`, `bge-multilingual-gemma2`) |
| `ovh-bge-m3.json` | OVH `POST /v1/embeddings`, model `bge-m3`, input: the eight sentences | 200, eight 1024-value vectors, already unit length |
| `ovh-qwen3-embedding-8b.json` | same, model `Qwen3-Embedding-8B` | 200, eight 4096-value vectors |
| `ovh-bge-m3-single.json` | model `bge-m3`, input: `["wherever you can always get parts for it"]` | 200, one vector |
| `ovh-bge-m3-truncated.json` | model `bge-m3`, input: the full transcript repeated twice (39,733 characters) after `truncateForEmbedding(text, 8192)` cut it to 28,458 characters | 200, `prompt_tokens` 6764 |
| `ovh-context-overflow.400.json` | model `bge-m3`, input: the same 39,733 characters untruncated | 400, "maximum context length is 8192 tokens ... you requested 9382 tokens" |
| `ovh-batch-overflow.400.json` | model `bge-m3`, 1000 short inputs | 400, `{"given":1000,"max":25}` |
| `ovh-qwen3-batch-overflow.400.json` | model `Qwen3-Embedding-8B`, 1000 short inputs | 400, same limit of 25 |
| `ovh-bad-model.404.json` | model `bge-m4` (does not exist) | 404, `model_not_found` |
| `ovh-rate-limited.429.json` | the third `bge-m3` request within a minute | 429, headers `retry-after: 2`, `x-ratelimit-limit-minute: 2` |
| `cloudflare-bge-m3.json` | `POST https://api.cloudflare.com/client/v4/accounts/<account>/ai/v1/embeddings`, model `@cf/baai/bge-m3`, the eight sentences | 200, eight 1024-value vectors with norms slightly above 1 |

Status codes and headers are not stored in the files; the tests pass them to `replayFetch` as listed here.
