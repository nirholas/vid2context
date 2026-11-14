# Jobs fixtures

Real responses recorded from this repo's VM on 2026-11-14 with the same requests the YouTube provider sends (innertube WEB client for browse, ANDROID client 20.10.38 for player). Tests replay them through `replayFetch` (`@vid2context/core/testing`); the provider's own fixtures in `providers/youtube/test/fixtures/` cover "Me at the zoo" (`jNQXAC9IVRw`) and `cCPsdFdlshc`.

| File | Source |
|---|---|
| `browse-playlist-PLDWrj3hS12VU.json` | `POST /youtubei/v1/browse` with `browseId: VLPLDWrj3hS12VU` (a public 7-video playlist that starts with "Me at the zoo") |
| `player-Ay22n7jR2j4.json` | `POST /youtubei/v1/player` for the playlist's second video: `LOGIN_REQUIRED` ("Please sign in") |
| `player-cBsRvPSWXQk.json` | Same call for the third video ("Battery 35 pm"): one auto-caption track (en) |
| `timedtext-cBsRvPSWXQk-en-asr-429.html` | That track's `baseUrl` with `fmt=srv3`: HTTP 429 "automated queries" page (YouTube's datacenter IP block) |
| `google-oauth2-v3-certs.json` | `GET https://www.googleapis.com/oauth2/v3/certs`, Google's public OIDC signing keys (JWKS) |

Trimming, so nothing personal lands in this public repo:

- The browse response keeps only `contents`, `header`, `metadata` and `alerts`, and every `watchEndpointSupportedOnesieConfig` object was removed: their `initplayback` URLs embed the requesting machine's IP address. `responseContext` (visitor data) was dropped.
- Player responses keep only `playabilityStatus`, `captions` and `videoDetails`; `streamingData` and tracking fields embed the IP address.

To re-record, run the same requests, apply the same trimming, and grep the result for your public IP before committing.
