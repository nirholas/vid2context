# YouTube browse and search fixtures

Real innertube responses recorded from this repo's VM on 2026-11-14 by running `listYouTube` and `listMetadata` (`src/browse/`) against YouTube with a recording `fetch`. The requests used the WEB client (version `2.20261002.00.00`, no key, no cookie). `test/browse.test.ts` replays them through `replayFetch`, so unit tests never touch the network.

`requests.json` lists every request the recording run made, in order: the endpoint, the request body without the `context` block, the HTTP status, and the file holding the response. The test replays a request only when its endpoint and body match a recorded one exactly.

| File | Request | What it shows |
|---|---|---|
| `browse-gwagon.json` | `browse` `VLPLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b` | "G-Wagon Buyer's Guide" (Alliance Motorworks): 9 videos, no continuation, playlist header and metadata |
| `browse-gwagon-badges.json` | the same `browse` request, recorded 2026-11-15 | The same playlist with each lockup's duration badge kept (`contentImage` reduced to the badge text, `11:38` and so on). Used by the parser test only, not listed in `requests.json` (the replay serves `browse-gwagon.json` for that body). |
| `browse-nasa-uploads.json`, `-p2.json` | `browse` `VLUULA_DiR1FfKNvjuUpBHmylQ` and its continuation | NASA's uploads playlist: 100 items on page 1, then a continuation page |
| `browse-29c3.json` | `browse` `VLPLwP_SiAcdui0KVebT0mU9Apz359a4ubsC` | "29C3: Not my department": 96 entries with `MxMrnsxX9ZA` twice; its only continuation sits beside the item section and leads to related playlists |
| `browse-unavailable.json` | `browse` `VLPL59FEE129ADFF2B12` | Google playlist with 3 unavailable entries (lockups without a title: `yi50KlsCBio`, `ZNbHGrGJu8Q`, `JUf1zxjR_Qw`) |
| `browse-missing-playlist.json` | `browse` `VLPLtPgu7CB4gbY9oDN3drwC3cMbJggS7dKl` | alert `ERROR` "The playlist does not exist." |
| `resolve_url-alliance.json`, `browse-alliance.json` | `navigation/resolve_url` for `@alliancemotorworks/videos`, then `browse` `VLUUdEjP_BjQ5audhxLKKzZl2A` | handle resolved to `UCdEjP_BjQ5audhxLKKzZl2A`; the uploads playlist (UU), newest first |
| `resolve_url-alliance-streams.json`, `browse-alliance-streams.json`, `-p2.json` | `resolve_url` for `/streams`, `browse` `VLUULV...`, then `browse` the channel with the streams params | the channel has no live streams: UULV "does not exist", and the streams request answers with the Home tab selected |
| `resolve_url-alliance-playlists.json`, `browse-alliance-playlists.json`, `-p2` to `-p5` | `resolve_url` for `/playlists`, `browse` the playlists tab, then each of its 4 playlists | playlist lockups on a channel tab, and the playlists they expand to |
| `resolve_url-missing-handle.json` | `resolve_url` for `@thishandledoesnotexist-zq9x7k2/videos` | HTTP 404 `NOT_FOUND` |
| `browse-missing-channel.json`, `resolve_url-missing-channel.json`, `browse-missing-channel-p2.json` | `browse` `VLUUxxxxxxxxxxxxxxxxxxxxxx`, `resolve_url`, `browse` `UCxxxxxxxxxxxxxxxxxxxxxx` | a channel id that does not exist: the playlist alert, then alert `ERROR` "This channel does not exist." |
| `resolve_url-alliance-meta.json`, `browse-alliance-meta.json` | `resolve_url` for `@alliancemotorworks`, then `browse` with the returned params | channel metadata (`channelMetadataRenderer`, header with handle and video count) |
| `browse-nasa-videos-tab.json`, `-p2.json` | `browse` `UCLA_DiR1FfKNvjuUpBHmylQ` with the videos tab params, then its continuation | a channel videos tab: `richGridRenderer` items and a `continuationItemRenderer` |
| `search-search.json`, `-p2.json` | `search` "g wagon buyers guide" with the type=video filter, then its continuation | 20 `videoRenderer` results per page; the next-page token sits beside the item section |

Trimming, so nothing personal lands in this public repo and the files stay small. Applied by a script to every file; nothing was added or reordered:

- Dropped top-level `responseContext` (it holds a visitor id), `topbar`, `frameworkUpdates`, `trackingParams` and `sidebar`.
- Dropped everywhere: `watchEndpointSupportedOnesieConfig` (its URLs embed the requesting machine's IP address), tracking and logging fields (`trackingParams`, `clickTrackingParams`, `loggingDirectives`, `loggingContext`, `serviceTrackingParams`), menus (`menu`, `menuButton`, `menuOnTap`), `thumbnailOverlays` and accessibility labels.
- Inside list items only: thumbnails, avatars, badges, inline playback and expanded snippets. Exception: `browse-gwagon-badges.json` keeps the duration badge text of each lockup and nothing else of its `contentImage`.
- Email addresses and phone numbers in descriptions replaced with `[email redacted]` and `[phone redacted]`.
- Every file was checked to contain no copy of the recording machine's IP address and no visitor data.

To re-record, run the same calls through a `ctx.fetch` that saves each response (see the request bodies in `requests.json`), apply the same trimming, and grep the result for your public IP before committing.
