# storage-sqlite fixtures

| File | Source |
|---|---|
| `ovh-bge-m3-embeddings.request.json` | The request body sent: model `bge-m3` and five inputs. Inputs 0 and 1 are segments of `tests/fixtures/contexts/youtube-cCPsdFdlshc.json` (71.119 s and 80.04 s), 2 and 3 are segments of `youtube-jNQXAC9IVRw.json` (5.318 s and 7.974 s), 4 is a query written for the test. |
| `ovh-bge-m3-embeddings.json` | The real response, unmodified: `POST https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/embeddings` (OVH AI Endpoints, keyless), recorded with curl on 2026-11-14. HTTP 200, five 1024-dimension embeddings, 55 prompt tokens. |

Nothing personal is in either file. The keyless tier allows about 2 requests per minute per IP (`x-ratelimit-limit-minute: 2`), so a third request inside a minute gets `{"message":"API rate limit exceeded"}`.

Re-record with the request file:

```sh
curl -sS https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/embeddings \
  -H 'content-type: application/json' --data @ovh-bge-m3-embeddings.request.json \
  -o ovh-bge-m3-embeddings.json
```
