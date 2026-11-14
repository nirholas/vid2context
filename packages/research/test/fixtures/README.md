# Research fixtures

Real keyless LLM chain answers for `keyMoments()`, recorded on 2026-11-14 from this repo's VM with `scripts/record-key-moments.ts`. The script runs with an empty env, so only keyless rungs are enabled and no key is sent or stored. It records only the LLM calls (endpoint, model, HTTP status, the request body and the raw response body); no request headers. The transcript comes from the shared `tests/fixtures/contexts/youtube-cCPsdFdlshc.json` ("Best & Worst G-Wagon Years", auto-captions). `moments.test.ts`, `mcp.test.ts` and `http.test.ts` replay them by endpoint, model and exact messages, so a change to the prompt makes the replay miss and the tests fail.

| File | Command | What it holds |
|---|---|---|
| `key-moments-cCPsdFdlshc.json` | `npx tsx packages/research/scripts/record-key-moments.ts` (count 8, one chunk) | OVH `Meta-Llama-3_3-70B-Instruct` answered HTTP 429 (keyless rate limit), then OVH `gpt-oss-120b` answered with 8 moments |
| `key-moments-cCPsdFdlshc-chunked.json` | `npx tsx packages/research/scripts/record-key-moments.ts 2000 8` (2000-token chunks, 3 chunks) | OVH `gpt-oss-120b` answered chunk 1, OVH `Meta-Llama-3_3-70B-Instruct` chunks 2 and 3 (the first Llama request of that run failed before any response, so it was not recorded) |

Checked before committing: no keys, emails, phone numbers or IP addresses (the responses carry only OVH completion ids and request ids). The speakers' first names come from the public video and are already in the shared context fixture.

To re-record, run the commands above; the script waits and retries when every keyless rung is rate-limited.
