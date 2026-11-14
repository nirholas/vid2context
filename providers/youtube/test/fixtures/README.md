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
