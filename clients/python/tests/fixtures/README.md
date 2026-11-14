# Recorded vid2context responses

Real HTTP responses from a real vid2context server (`packages/server`, Node entry, started on a random local port), saved one call per file. The Python tests replay them through `httpx.MockTransport`; `packages/langchain` replays the same files through `replayFetch`. Re-record with `uv run python scripts/record_fixtures.py [name ...]`.

Each file is `{ recorded, request: { method, path, query }, status, headers: { content-type }, body }`, where `body` is the response body exactly as the server sent it, as a string.

| File | Request | Status | Recorded |
|---|---|---|---|
| `health.json` | `GET /api/v1/health` | 200 | 2026-11-14, record script, no keys set |
| `context-jNQXAC9IVRw.json` | `GET /api/v1/context?url=https://youtu.be/jNQXAC9IVRw` ("Me at the zoo", creator captions, 6 segments, 3 description chapters) | 200 | 2026-11-14 16:56 UTC, curl against the server on port 24817 |
| `context-cCPsdFdlshc.json` | `GET /api/v1/context?url=https://www.youtube.com/watch?v=cCPsdFdlshc` ("Best & Worst G-Wagon Years", auto-captions, 521 segments, no chapters, 1084 s) | 200 | 2026-11-14 16:56 UTC, curl against the server on port 24817 |
| `context-unavailable.json` | `GET /api/v1/context?url=xxxxxxxxxxx` | 404 `not-found` | 2026-11-14, record script |
| `context-blocked.json` | `GET /api/v1/context?url=https://youtu.be/jNQXAC9IVRw` while YouTube rate-limited this machine (HTTP 429 to the captions request) | 422 `no-transcript`, attempts show `blocked` | 2026-11-14 17:01 UTC, record script (kept as a real error case; the script never writes this name) |
| `transcript-missing-url.json` | `GET /api/v1/transcript` | 400 `bad-request` | 2026-11-14, record script |
| `transcript-unknown-format.json` | `GET /api/v1/transcript?url=...&format=pdf` | 400 `bad-request` with the format list in `hint` | 2026-11-14, record script |

`context-cCPsdFdlshc.json` had a person's email address and phone number in the video description; they are replaced with `[email redacted]` and `[phone redacted]` (the record script does this inside JSON strings and re-serializes only bodies it changed). No other edits. No stream URLs or IP addresses appear in these bodies.
