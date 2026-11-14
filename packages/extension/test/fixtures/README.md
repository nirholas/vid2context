# Extension fixtures

Real responses replayed by the unit tests. Recorded on 2026-11-14 from this repo's VM with `npm run record -w packages/extension` (`scripts/record-fixtures.ts`) unless noted.

| File | Source |
|---|---|
| `watch-jNQXAC9IVRw.html` | `GET https://www.youtube.com/watch?v=jNQXAC9IVRw&hl=en` ("Me at the zoo"): two creator caption tracks (en, de), description chapters |
| `watch-nocaptions-brXcsLhw84o.html` | Same request for "1 Minute Piano Music": no caption tracks |
| `timedtext-jNQXAC9IVRw-en-429.html` | The en track's `baseUrl` with `fmt=srv3`, fetched from the VM: YouTube's HTTP 429 "automated queries" page (this network is refused captions) |
| `timedtext-jNQXAC9IVRw-en.srv3.xml` | Copied from `providers/youtube/test/fixtures/` (recorded there on 2026-11-14): the same video's en track as srv3 |
| `timedtext-jNQXAC9IVRw-en.srv1.xml` | Copied from the same folder: the en track without `fmt` (srv1) |
| `api-transcript-pack-jNQXAC9IVRw.json` | `GET /api/v1/transcript?url=<Me at the zoo>&format=pack` from the real server (`packages/server`, run locally on 127.0.0.1), as `{ status, contentType, body }` |
| `api-transcript-not-found.json` | `GET /api/v1/transcript?url=https://www.youtube.com/watch?v=xxxxxxxxxxx` from the same server: its `not-found` error body |

Trimming, so nothing personal lands in this public repo:

- Watch pages: every inline script except the player response is emptied (they carry visitor ids and session config). The player response keeps only `playabilityStatus`, `videoDetails`, `captions` and `microformat`; `streamingData` and tracking URLs were dropped because they embed the requesting IP address. Markup and external script tags are unchanged.
- The recorder fails if any recorded file contains an IP address other than the `0.0.0.0` placeholder YouTube puts in caption URLs.
- The caption body itself could not be recorded from the VM (HTTP 429), so the srv3 and srv1 tracks are the YouTube provider's recordings of the same video.

To re-record: `npm run record -w packages/extension`, optionally with `V2C_API=http://127.0.0.1:<port>/api/v1` pointing at a running `npm run start:server` to refresh the API files.
