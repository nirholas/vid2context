# Site fixtures

## runnables/

One real HTTP API response per runnable example in `src/data/runnables.ts`, shown on the docs pages before anyone presses Run, and in each page's Markdown twin. `scripts/record-runnables.ts` writes them by sending each example's default request to a running server:

```sh
npm run start:server                                  # repo root, another terminal
npm --prefix site run record                          # every example
npm --prefix site run record -- transcript brief      # only these
```

Each file is a `Recording` (`src/lib/runnable.ts`): the request as sent (method, path, query, JSON body or file field), the status, the time it took, the response headers worth showing (`X-Request-Id` is dropped), and the body: text for JSON, text, Markdown, captions and server-sent events, base64 for the zip. When a POST answered `202` with a Job, `job` holds the number of polls and the finished Job.

Recorded on 2026-11-14 from the Node server at `http://127.0.0.1:8787` (vid2context 0.1.0) on this repo's VM. Many responses came from that server's library, filled by earlier runs (which is why their time is a few milliseconds); the pack's header, for example, names the Cloudflare Whisper rung that made its transcript then. The LLM answers, briefs and extractions came from keyless rungs; each response's `rung` fields say which. The Cloudflare token in that server's environment was rejected (HTTP 401), which `search.json` shows in its attempts.

What is in them, and what was kept out:

- Videos: "Me at the zoo" (`jNQXAC9IVRw`), the G-Wagon buyer's guide `cCPsdFdlshc` and its playlist `PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b`, Kurzgesagt's "Optimistic Nihilism" (`MBRqu0YOH14`, which has SponsorBlock segments) and `PzJL3aBRas8` from the same playlist (six creator chapters, compared with generated ones in `chapters-auto.json`). The upload is the public-domain Apollo 11 clip from `tests/fixtures/media/`.
- The recorder refuses to write a response that contains an email address, a stream URL with an `ip=` parameter, or a bearer token (`src/lib/fixture-privacy.ts`), and `test/runnables.test.ts` checks every file again. The G-Wagon video's description holds the channel's business email, so no example returns that video's metadata or outline.
- `comments.json` keeps the author handles of the top comment and its replies: comments are public YouTube content, the same rule as `providers/youtube/test/fixtures/README.md`. The example asks for one comment, the San Diego Zoo's.
- `transcript-error.json` is the error example on purpose: a well-formed id that does not exist, answered `404 not-found`.
- `outline-sections.json` and `chapters-auto.json` were meant for `1Xx1fmHIsiA`, a 15-minute playlist video without chapters, but YouTube was blocking this VM (HTTP 429 on captions, then on every request) and the keyless Whisper rung was rate-limited, so they use videos the server had already read. Re-record them with a longer chapterless video when YouTube answers again.
- `search.json` reflects the recording server's library at the time (its `meta.indexed` counts the videos it held).

The collection, library, import and readiness examples (`collection-*.json`, `obsidian-export.json`, `library*.json`, `import-transcript.json`, `healthz.json`) were recorded on 2026-11-15 from the same Node server, run with `VID2CONTEXT_DB` pointing at a copy of its library trimmed to the example videos, because YouTube was again answering this VM with HTTP 429. That way the collection's two videos (`cCPsdFdlshc` and `PzJL3aBRas8`) came from the library, and `library.json` lists only example videos. Notes:

- `collection-create.json` holds the id the server generated (`g-wagon-research-2c2983f1`). `COLLECTION_ID` in `src/data/runnables.ts` is that id, and the blocks that read it were recorded with it; a test checks they agree. Re-record the whole chain together (`record -- collection-create collection-add collection-get collection-pack collection-export`) and update `COLLECTION_ID`.
- `obsidian-export.json` exports `PzJL3aBRas8` only: the notes carry each video's description, and the G-Wagon buyer's guide description holds the channel's business email, which the recorder refuses.
- `import-transcript.json` imports the creator captions of "Me at the zoo" exactly as `transcript-srt.json` returns them.

`test/runnables.test.ts` fails when a file is missing, when a file has no example, or when an example's default request no longer matches the recorded one: re-record that example after changing its spec.
