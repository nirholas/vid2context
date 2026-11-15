# Translation fixtures

Real LLM responses recorded on 2026-11-14 from this repo's VM by `scripts/record.ts` (`LIVE=1 node_modules/.bin/tsx packages/translate/scripts/record.ts`), through the testkit recorder, which scrubs keys and IP addresses. The input is the first 30 segments of the shared fixture `tests/fixtures/contexts/youtube-cCPsdFdlshc.json`, translated from English to German with `platform: false`. Tests replay them in a fixed order.

| File | Source |
|---|---|
| `llm-de-chunks-001.json` | OVH keyless `Meta-Llama-3_3-70B-Instruct`, chunk 1 of 3 (`chunkTokens: 250`): ids 0 to 11 |
| `llm-de-chunks-002.json` | Same rung, chunk 2: ids 12 to 23 |
| `llm-de-chunks-003.json` | OVH keyless `gpt-oss-120b`, chunk 3: ids 24 to 29 (the Llama rung timed out first; a timeout leaves no file) |
| `llm-de-whole-001.json` | OVH keyless `gpt-oss-120b`, all 30 segments in one chunk (default `chunkTokens`) |

| `llm-fr-echo-001.json` | Recorded 2026-11-15 from this repo's VM by `scripts/record.ts llm-fr-echo`: Kilo keyless `nvidia/nemotron-3.5-lightning:free`, "Me at the zoo" (`tests/fixtures/contexts/youtube-jNQXAC9IVRw.json`, 6 segments) to French. The model answered with the English text unchanged |
| `llm-fr-echo-002.json` | Same run: Kilo keyless `nvidia/nemotron-3-ultra-550b-a55b:free`, the retry on the next rung, a correct French translation |

Serving `llm-de-chunks-001.json` (ids 0 to 11) to a request for ids 0 to 29 is how the tests get a real answer with missing ids, to check the single retry and the keep-original fallback.

The YouTube responses (player, the creator `de` track of "Me at the zoo", and the HTTP 429 for `tlang=de`) are read from `providers/youtube/test/fixtures/`; see its README.

`test/surfaces.test.ts` (the MCP tool and HTTP route) replays the same `llm-de-whole-001.json` and YouTube responses.
