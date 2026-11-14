# YouTube fixtures

Real responses recorded from this repo's VM on 2026-11-14. Tests replay them through `replayFetch` (`@vid2context/core/testing`), so unit tests never touch the network.

| File | Source |
|---|---|
| `player-jNQXAC9IVRw.json` | `POST /youtubei/v1/player` (ANDROID client 20.10.38) for "Me at the zoo": two creator tracks (en, de), no auto-captions, description chapters |
| `player-cCPsdFdlshc.json` | Same call for "Best & Worst G-Wagon Years" (Alliance Motorworks): one auto-caption track (en), 16 translation languages, no chapters |
| `player-unavailable.json` | Same call for the id `xxxxxxxxxxx`: `playabilityStatus.status = ERROR` |
| `timedtext-jNQXAC9IVRw-en.srv3.xml` | The en track's `baseUrl` (srv3) |
| `timedtext-jNQXAC9IVRw-de.srv3.xml` | The de track's `baseUrl` (srv3) |
| `timedtext-jNQXAC9IVRw-en.srv1.xml` | The en track's `baseUrl` without `fmt` (srv1, double-encoded entities) |
| `timedtext-cCPsdFdlshc-en-asr.srv3.xml` | The auto-caption track (srv3 with per-word `<s>` timing and append paragraphs) |
| `timedtext-429-blocked.html` | HTTP 429 "automated queries" page YouTube returned for `&tlang=de` on the auto track (datacenter IP block) |

Trimming, so nothing personal lands in this public repo:

- Player responses keep only `playabilityStatus`, `captions` and `videoDetails`. `streamingData` and tracking fields were dropped because their URLs embed the requesting machine's IP address.
- `player-cCPsdFdlshc.json` has a person's email and phone number in the description replaced with `[email redacted]` and `[phone redacted]`.

To re-record, run the same requests (see `src/innertube.ts`), apply the same trimming, and grep the result for your public IP before committing.
