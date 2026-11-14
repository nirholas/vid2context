# storage-postgres fixtures

| File | Source | Recorded |
| --- | --- | --- |
| `ovh-bge-m3-embeddings.json` | One real `POST https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/embeddings` call to the keyless OVH AI Endpoints `bge-m3` model (1024 dimensions). Inputs: all 6 caption segments of `tests/fixtures/contexts/youtube-jNQXAC9IVRw.json`, the first 6 segments of `youtube-cCPsdFdlshc.json` that mention an engine, transmission or interior, and two queries ("elephants with long trunks", "which engine and transmission are reliable"). The file keeps the request, the chunk metadata (video id, segment index, times, text) and the full response body. No headers, keys or personal data. | 2026-11-14 |

The library tests also read the shared contexts in `tests/fixtures/contexts/` (see that folder's README).
