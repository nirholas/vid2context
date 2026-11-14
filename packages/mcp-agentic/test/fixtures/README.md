# mcp-agentic fixtures

| File | What it is | Recorded |
|---|---|---|
| `sampling-digest-keyless.json` | The five chat completions behind one `digest_videos` run: four map calls (one for "Me at the zoo", three for "Best & Worst G-Wagon Years" at `maxTokensPerVideo: 2000`) and one reduce call, each stored with the exact messages that produced it. Answered by the keyless OVH AI Endpoints lanes (`Meta-Llama-3_3-70B-Instruct` and `gpt-oss-120b`), no key sent. | 2026-11-14 from this repo's VM with `npx tsx packages/mcp-agentic/test/record-fixtures.ts` |
| `reduce-gpt-oss-lenticular.md` | The raw combine (reduce) answer a keyless gpt-oss model returned in the `LIVE=1` digest run: citations in lenticular brackets (U+3010, U+3011), non-breaking hyphens (U+2011) in the title, many bare timestamps. Copied verbatim from the run's output (no lines had been dropped or rewritten, because the checker did not yet read lenticular brackets); it contains the model's own dash characters, kept as recorded. | 2026-11-14, `LIVE=1 npx vitest run packages/mcp-agentic/test/live.test.ts` (OVH and Pollinations lanes, no key) |

How the recording works: `record-fixtures.ts` connects a real SDK client to a server with these features over `InMemoryTransport`, serves the two shared contexts from `tests/fixtures/contexts/` through a `MemoryStorage`, and answers `sampling/createMessage` with the vid2context LLM chain (`chat()` from core) using an empty env. A fetch wrapper keeps every successful completion with a non-empty answer. Replay (`samplingRoutes` in `test/helpers.ts`) looks responses up by the exact messages sent, so concurrent map calls can arrive in any order, and any request that was not recorded fails the test instead of reaching the network.

The recorded run produced no out-of-range timestamps. It did produce one note bullet without a timestamp, which the digest drops and reports; the tests assert that. Out-of-range dropping is tested by checking the model's real G-Wagon notes (timestamps up to 18 minutes) against the 19-second "Me at the zoo".

Re-record whenever `src/prompts.ts` or `src/chunking.ts` change, since replay matches the messages exactly. Before committing, check the file for IP addresses, emails and keys (the keyless lanes return none).

Also read in place (not copied): the YouTube provider's own real recordings in `providers/youtube/test/fixtures/` (`player-jNQXAC9IVRw.json`, `player-cCPsdFdlshc.json`, `timedtext-jNQXAC9IVRw-*.srv3.xml`, `timedtext-cCPsdFdlshc-en-asr.srv3.xml`) for the `choose_caption_track` tests, and the shared contexts in `tests/fixtures/contexts/`.
