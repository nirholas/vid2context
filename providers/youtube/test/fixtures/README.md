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

To re-record, run the same requests (see `src/resilience/transport.ts`), apply the same trimming, and grep the result for your public IP before committing.

## Captions and blocks fixtures

Recorded from this repo's VM on 2026-11-14 with `POST /youtubei/v1/player` (`hl=en`). ANDROID is client 20.10.38 and IOS 20.10.4, with the platform fields in `src/resilience/clients.ts`. Trimming is the same as above: only `playabilityStatus`, `videoDetails` and `captions` are kept, `contextParams` is dropped, and caption `baseUrl`s have `ip=0.0.0.0`. Each file was grepped for the VM's IP, emails and phone numbers. The tests use them as follows.

| File | Source |
|---|---|
| `player-ios-jNQXAC9IVRw.json` | IOS client, "Me at the zoo": the same en and de creator tracks as ANDROID |
| `player-android_vr-bot-jNQXAC9IVRw.json` | ANDROID_VR client 1.65.10: `LOGIN_REQUIRED` "Sign in to confirm you're not a bot", while ANDROID and IOS passed from the same IP. Tests serve it as the first client's answer for the bot-check fallback |
| `player-tv_embedded-unsupported-jNQXAC9IVRw.json` | TVHTML5_SIMPLY_EMBEDDED_PLAYER 2.0: `ERROR` "YouTube is no longer supported in this application or device." (why it was dropped) |
| `player-web-reload-jNQXAC9IVRw.json`, `player-mweb-reload-jNQXAC9IVRw.json` | WEB and MWEB 2.20261112.10.00: `UNPLAYABLE` "The page needs to be reloaded." (why they were dropped) |
| `player-android-old-version-400.json` | ANDROID with the retired version 19.09.37: HTTP 400 "Precondition check failed." |
| `player-nocaptions-android-brXcsLhw84o.json`, `player-nocaptions-ios-brXcsLhw84o.json` | A one-minute piano video with no captions on either client (`OK`, no `captions`) |
| `player-age-restricted-HtVdAasjOgU.json` | ANDROID: `LOGIN_REQUIRED` "This video may be inappropriate for some users." |
| `player-members-only-Pw0wchRQJac.json` | ANDROID: `UNPLAYABLE` "Join this channel to get access to members-only content..." |
| `player-private-yZIXLfi8CZQ.json` | ANDROID: `LOGIN_REQUIRED` "This video is private" |
| `player-removed-6SJNVb0GnPI.json` | ANDROID: `ERROR` "This video has been removed for violating YouTube's policy on hate speech..." |
| `player-upcoming-w8DxIwCbsVc.json` | ANDROID, a scheduled live stream: `LIVE_STREAM_OFFLINE` with `scheduledStartTime` 1794717000 (2026-11-15T04:30:00Z) |
| `player-live-0U8ykcdZL2g.json` | ANDROID, a 24/7 live stream: `OK`, `isLive`, no captions |

The player endpoint itself was never blocked from the VM, so the block-during-fallback test serves the real `timedtext-429-blocked.html` page as a player answer.

Not recorded, because none could be found or reached from the VM: a region-blocked video, a real 5xx or a 429 with Retry-After that is not the block page, and a 403 on timedtext. The timedtext endpoint answered every request from the VM with the 429 block page from about 16:55 UTC onward, so no json3, WebVTT or `tlang` caption payload could be recorded.

To re-record, call the player as `src/resilience/transport.ts` does, with the client from `src/resilience/clients.ts`, apply the same trimming, and grep for your public IP before committing.

## Comments fixtures

Recorded from this repo's VM on 2026-11-14 with `POST /youtubei/v1/next` (WEB client `2.20251110.01.00`, `hl=en`, `gl=US`; the two `-mweb` files with the MWEB client, same version). The comments are public YouTube content; author handles are kept because the `author` field is under test.

| File | Source |
|---|---|
| `next-Pqdv2ql971M.json` | `next` for "G-Wagon Buyer's Guide: Experts Reveal Best Models to Buy" (Jimports, 178 comments): the comments section token and the Top/Newest sort menu |
| `comments-Pqdv2ql971M-top-1.json`, `-top-2.json`, `-top-3.json` | The first three Top pages (20 threads each, entity shape). Page 1 has the creator's pinned comment, three threads the creator replied in, timestamps and emoji |
| `comments-Pqdv2ql971M-newest-1.json` | The first page of the Newest sort (the pinned comment still comes first) |
| `replies-Pqdv2ql971M-<commentId>.json` | The first reply page of each of the six threads with replies on Top page 1, three of them with creator replies |
| `next-Pqdv2ql971M-mweb.json`, `comments-Pqdv2ql971M-mweb-1.json` | The same video with the MWEB client, which still returns the classic `commentRenderer` shape |
| `comments-gqYNyRIGYOQ-top-1.json`, `comments-gqYNyRIGYOQ-mweb-1.json` | A creator comment with an external link (WEB and MWEB), from a video found through innertube search; only that thread is kept |
| `next-XqZsoesa55w.json` | A made-for-kids video: "Comments are turned off." |
| `next-Pw0wchRQJac.json`, `next-HtVdAasjOgU.json` | A members-only and an age-restricted video: no comments section at all (paired with the player fixtures of the same ids) |
| `next-xxxxxxxxxxx.json` | A nonexistent id: "This video isn't available anymore" |

Trimming (only removals; nothing was added or rewritten):

- `next` responses keep only the comments section and the comments sort menu, with the path to them (the members-only, age-restricted and nonexistent ones keep only the video title or the unavailable notice). Everything else was dropped, including `responseContext`, because the full responses embed the requesting machine's IP address and visitor data.
- Comment pages keep `onResponseReceivedEndpoints` and, from `frameworkUpdates`, only the `commentEntityPayload` and `engagementToolbarStateEntityPayload` mutations.
- Dropped everywhere: tracking and logging fields, avatars and thumbnails (except `viewRepliesCreatorThumbnail`, which marks threads the creator replied in), accessibility labels, commenters' channel ids and channel links, the custom emoji catalog, and the session-bound `redir_token` parameter of redirect links.

To re-record, call `next` as in `src/comments/request.ts`, follow the continuation tokens, apply the same trimming, and grep the result for your public IP and `visitorData` before committing.

## Browse and search fixtures

Playlist, channel and search responses for `src/browse/` live in [browse/](browse/) and are documented in [browse/README.md](browse/README.md).

## Metadata and chapters fixtures

Files for `src/metadata/` live in [metadata/](metadata/). All were recorded from this repo's VM on 2026-11-14 with `test/record-metadata-fixtures.ts`, which goes through the real code path: `getPlayer` (it picked the ANDROID client 20.10.38 every time), `POST /youtubei/v1/next` with the WEB client `2.20261112.10.00` (`hl=en`, `gl=US`), and a `HEAD` of `https://i.ytimg.com/vi/<id>/maxresdefault.jpg`.

| Files (`player-<label>-<id>.json`, `next-<label>-<id>.json`) | Video |
|---|---|
| `chapters-2VDV87iHfKw` | Team Coco, a full podcast episode: 9 creator chapters in the description, 9 description links |
| `precedence-Rq5gJVxz55Q` | Data with Baraa, a 13-hour course that premiered: 37 creator chapters in h:mm:ss, while YouTube serves auto chapters (key moments) instead of description markers |
| `past-live-9JTLxLyF59M` | C-SPAN, NASA news conference after the Artemis II launch: a past live stream with auto chapters only |
| `short-0U0O-P43MNQ` | A 33-second Short (vertical streams, 1080x1920) |
| `live-rFZHOHl-L8A` | Lofi Girl's 24/7 stream, live at recording time (`isLive`, "watching now" count) |
| `upcoming-zWHMFJII-sA` | NASASpaceflight, a scheduled launch stream: `LIVE_STREAM_OFFLINE`, `isUpcoming`, `scheduledStartTime` |
| `age-HtVdAasjOgU` | The Witcher 3 trailer: `LOGIN_REQUIRED` "This video may be inappropriate for some users", with `videoDetails` |
| `members-2a1cufNNiyQ` | Linus Tech Tips: `UNPLAYABLE` members-only (the `next` response carries the `BADGE_STYLE_TYPE_MEMBERS_ONLY` badge) |
| `zoo-jNQXAC9IVRw` | "Me at the zoo": 3 description chapters plus YouTube's `DESCRIPTION_CHAPTERS` markers, no maxresdefault |

| File | Source |
|---|---|
| `maxres-status.json` | HTTP status of the maxresdefault `HEAD` for each video (200, or 404 for jNQXAC9IVRw) |
| `descriptions.json` | 74 real descriptions that contain timestamps, from 220 videos found through innertube search on 2026-11-14 (`next`, `attributedDescriptionBodyText`), each with the chapters YouTube derived from it (`DESCRIPTION_CHAPTERS` markers, `null` when it showed none) and whether it had auto chapters |

Not found: a video whose description markers exist while its description has no parseable timestamps (class (b) in prompt 07). In the 220-video sample, every `DESCRIPTION_CHAPTERS` list also parsed from the description.

Trimming (only removals, except the email redaction):

- Player responses keep `playabilityStatus` (`status`, `reason`, `liveStreamability`), `videoDetails`, `captions`, and from `streamingData` only each format's `itag`, `mimeType`, `width` and `height` (the stream URLs embed the requesting machine's IP address). The `client` and `attempts` fields vid2context adds were removed.
- `next` responses keep only `videoPrimaryInfoRenderer` and `videoSecondaryInfoRenderer` (with their path) and the player bar's `decoratedPlayerBarRenderer` (chapter markers). Dropped inside them: the rich-text description and header runs (the full description comes from the player), the subscribe button, thumbnails, click commands, accessibility objects, tracking and logging fields.
- `descriptions.json`: every email address was replaced with `[email redacted]`.

To re-record, run `npx tsx providers/youtube/test/record-metadata-fixtures.ts providers/youtube/test/fixtures/metadata <label>:<id> ...` and grep the output for your public IP and any email or phone number before committing. Counts (views, likes, live viewers) change between recordings; update the test expectations that pin them.
