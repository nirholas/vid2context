# Recorded vid2context responses

Real HTTP responses from a real vid2context server (`packages/server`, started on a random local port), saved one call per file. The Python tests replay them through `httpx.MockTransport`; `packages/langchain` replays the same files through `replayFetch`. Re-record with `uv run python scripts/record_fixtures.py [name ...]`.

Each file is `{ recorded, request: { method, path, query }, status, headers: { content-type }, body }`, where `body` is the response body exactly as the server sent it, as a string.

| File | Request | Status | Recorded |
|---|---|---|---|
| `health.json` | `GET /api/v1/health` | 200 | 2026-11-14, record script, no keys set |
| `context-jNQXAC9IVRw.json` | `GET /api/v1/context?url=https://youtu.be/jNQXAC9IVRw` ("Me at the zoo", creator captions, 6 segments, 3 description chapters) | 200 | 2026-11-14 16:56 UTC, curl against the server on port 24817 |
| `context-cCPsdFdlshc.json` | `GET /api/v1/context?url=https://www.youtube.com/watch?v=cCPsdFdlshc` ("Best & Worst G-Wagon Years", auto-captions, 521 segments, no chapters, 1084 s) | 200 | 2026-11-14 16:56 UTC, curl against the server on port 24817 |
| `context-unavailable.json` | `GET /api/v1/context?url=xxxxxxxxxxx` | 404 `not-found` | 2026-11-14, record script |
| `context-blocked.json` | `GET /api/v1/context?url=https://youtu.be/jNQXAC9IVRw` while YouTube rate-limited this machine (HTTP 429 to the captions request) | 422 `no-transcript`, attempts show `blocked` | 2026-11-14 17:01 UTC, record script (kept as a real error case; the script never writes this name) |
| `route-not-found.json` | `GET /api/v1/no-such-route` (the server's own 404: no `hint`, no `attempts`) | 404 `not-found` | 2026-11-14, record script, `--minimal` |
| `transcript-apollo11-text.json` | `GET /api/v1/transcript?url=tests/fixtures/media/apollo11-small-step.mp3` (the shared public-domain Apollo 11 clip, through the media-file provider and keyless OVH Whisper) | 200 `text/plain` | 2026-11-14, record script, `--minimal` |
| `transcript-apollo11-timestamps.json` | the same with `timestamps=1` | 200 `text/plain` | 2026-11-14, record script, `--minimal` |
| `context-apollo11.json` | `GET /api/v1/context?url=tests/fixtures/media/apollo11-small-step.mp3` (stt origin, 2 segments with word timings) | 200 | 2026-11-14 17:28 UTC, record script, `--minimal` |
| `formats.json` | `GET /api/v1/formats` | 200 | 2026-11-14, record script, `--minimal` |
| `metadata-jNQXAC9IVRw.json` | `GET /api/v1/metadata?url=https://youtu.be/jNQXAC9IVRw` (player metadata only, no captions request) | 200 | 2026-11-14, record script, `--minimal` |
| `items-jNQXAC9IVRw.json` | `GET /api/v1/items?url=https://youtu.be/jNQXAC9IVRw` (a single video expands to itself) | 200 | 2026-11-14, record script, `--minimal` |
| `items-cCPsdFdlshc.json` | `GET /api/v1/items?url=https://www.youtube.com/watch?v=cCPsdFdlshc`; its canonical `url` is the request of `context-cCPsdFdlshc.json`, so the loaders' `expand` path replays end to end | 200 | 2026-11-14, record script, `--minimal` |
| `items-apollo11.json` | `GET /api/v1/items?url=tests/fixtures/media/apollo11-small-step.mp3` (a `file://` canonical URL) | 200 | 2026-11-14, record script, `--minimal` |
| `items-unsupported.json` | `GET /api/v1/items?url=https://example.com/` (no installed source understands it) | 400 `unsupported-input` | 2026-11-14, record script, `--minimal` |
| `outline-apollo11.json` | `GET /api/v1/outline?url=tests/fixtures/media/apollo11-small-step.mp3` (no chapters, so one five-minute section with its token count) | 200 | 2026-11-14, record script, `--minimal` |
| `section-apollo11-chapter.json` | `GET /api/v1/section?url=...apollo11-small-step.mp3&chapter=0` | 200 `text/plain` | 2026-11-14, record script, `--minimal` |
| `section-apollo11-range.json` | `GET /api/v1/section?url=...apollo11-small-step.mp3&from=0&to=0:06&timestamps=1` (only the first line falls in the range) | 200 `text/plain` | 2026-11-14, record script, `--minimal` |
| `section-missing-selector.json` | `GET /api/v1/section?url=https://youtu.be/jNQXAC9IVRw` without `from`, `to` or `chapter` (rejected before any YouTube call) | 400 `bad-request` | 2026-11-14, record script, `--minimal` |
| `transcript-missing-url.json` | `GET /api/v1/transcript` | 400 `bad-request` | 2026-11-14, record script |
| `transcript-unknown-format.json` | `GET /api/v1/transcript?url=...&format=pdf` | 400 `bad-request` with the format list in `hint` | 2026-11-14, record script |

`context-cCPsdFdlshc.json` had a person's email address and phone number in the video description; they are replaced with `[email redacted]` and `[phone redacted]` (the record script does this inside JSON strings and re-serializes only bodies it changed). No other edits. No stream URLs or IP addresses appear in these bodies.

Why some files came from `--minimal`: while these were recorded, about 60 agents were editing the repo, so the full provider registry often failed to load (a provider package without its `src/index.ts` yet), and YouTube was answering this machine's caption requests with HTTP 429. `--minimal` runs the same `createApp` from `packages/server` with only the YouTube, media-file and speech-to-text providers (`scripts/record_server.ts`). The transcript, outline and section routes are recorded against the shared Apollo 11 clip instead of a YouTube video because of the 429 block, as the prompt allows. The record script still lists `outline-jNQXAC9IVRw`, `section-jNQXAC9IVRw-chapter`, `section-jNQXAC9IVRw-range` and `items-playlist` (three videos of a public playlist); they were not written because YouTube's 429 block (and the server's circuit breaker after it) was in force each time they were tried on 2026-11-14. `context-apollo11.json`, `outline-apollo11.json` and `items-apollo11.json` contain the server's absolute path to that clip in the repo checkout (`/home/user/...`), which names no person.
