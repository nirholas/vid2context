# Search test fixtures

Real responses recorded from the real services, replayed with `replayFetch` so unit tests never reach the network. Re-record with `npx tsx packages/search/scripts/record-fixtures.ts` (about 15 minutes: the keyless OVH endpoint allows about 2 requests per minute) after changing the chunker, the embedding batch size or `queries.json`.

| File | What | Recorded |
|---|---|---|
| `queries.json` | The evaluation set: 23 queries (exact terms, paraphrases, negations) over the shared G-Wagon and zoo contexts, each with expected time ranges and the transcript lines that justify them. Written by reading `tests/fixtures/contexts/*.json`, not recorded. | 2026-11-14 |
| `embeddings-ovh-bge-m3.json` | Every embedding request the engine made while indexing `tests/fixtures/contexts/youtube-cCPsdFdlshc.json` and `youtube-jNQXAC9IVRw.json` and running each query in `queries.json`: the request `input` list and the response body verbatim. `POST https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/embeddings`, model `bge-m3`, `encoding_format: base64` (little-endian float32, 1024 dimensions), keyless. | 2026-11-14 |
| `embeddings-ovh-gemma2-zoo.json` | The zoo video's chunks and the query "animals with long noses" embedded with a second model, `bge-multilingual-gemma2`, from the same endpoint, for the model-change test. | 2026-11-14 |
| `embeddings-provider-embed-zoo.json` | The zoo chunks and the query "animals with long noses" embedded through the real `@vid2context/provider-embed` OVH rung (`embed/ovh/bge-m3`), as that provider sends them (float vectors), to check the engine works with the shipped embedding provider. | 2026-11-14 |
| `rerank-ovh.json` | One rerank chat completion for the query "does the engine use a cam chain or a belt", made through the real `llm-openai-compatible` provider's keyless lanes (no key); the rung that answered was `llm/ovh/Meta-Llama-3_3-70B-Instruct`. The body is the endpoint's response verbatim. | 2026-11-14 |

The responses contain no personal data: OVH returns only vectors, token usage and a model name; the chat response holds the model's scores. Request headers (none carry a key) are not stored.
