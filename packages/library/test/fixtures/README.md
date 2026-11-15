# packages/library test fixtures

Real responses, replayed through `replayFetch` (`test/replay.ts`, `test/helpers.ts`), so unit tests never reach the network.

| File | Source |
|---|---|
| `youtube-gwagon-playlist.json` | Recorded on 2026-11-14 from this repo's VM by `scripts/record-fixtures.ts`, running the real YouTube provider: the innertube `browse` response for the public playlist `PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b` (9 videos, Alliance Motorworks G-Wagon series), the ANDROID `player` response for 8 of its videos (all but `cCPsdFdlshc`), the HTTP 429 "automated queries" page YouTube returned for each of their caption tracks (a real datacenter block at recording time), and the `player` response for the nonexistent id `xxxxxxxxxxx` (`playabilityStatus.status = ERROR`). |
| `player-cCPsdFdlshc.json`, `timedtext-cCPsdFdlshc-en-asr.srv3.xml` | Copied unchanged from `providers/youtube/test/fixtures/` (recorded there on 2026-11-14): player response and auto-caption track for "Best & Worst G-Wagon Years", the playlist video whose captions were served. |
| `player-jNQXAC9IVRw.json`, `timedtext-jNQXAC9IVRw-en.srv3.xml` | Copied unchanged from `providers/youtube/test/fixtures/`: player response and the en creator track for "Me at the zoo". |

Trimming, so nothing personal lands in this public repo:

- Player responses keep only what the provider reads; `streamingData`, `playbackTracking`, `responseContext` and other tracking fields are dropped because their URLs embed the requesting machine's IP address. Browse responses drop `responseContext`, `trackingParams` and `frameworkUpdates`, and every property holding a googlevideo.com media URL.
- A contact email address and phone number in the channel's video descriptions are replaced with `[email redacted]` and `[phone redacted]`.
- The recorder refuses to write the file if the machine's public IP still appears anywhere in it.

To re-record: `npx tsx packages/library/scripts/record-fixtures.ts`, then check the diff. If YouTube serves the caption tracks at that moment, the 8 videos will record as successes and the tests that count failures need updating.

Replay rule for blocked captions: the 429 pages were YouTube refusing this machine's IP, which covers every caption track of the video. `blockedCaptions()` in `test/replay.ts` serves each video's recorded 429 to any caption request for that video, so a change in which track the provider picks (it now skips the machine-dubbed `variant=timing-optimized` tracks) does not turn a recorded block into a missing-fixture error.
