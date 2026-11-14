# YouTube

## Captions and blocks

Captions are the cheapest and most accurate transcript: no audio download, no speech-to-text. `youtube-captions` reads them keylessly through the innertube player API and the `timedtext` endpoint.

### How a track is chosen

With a language (`--lang de`, `language: 'de'`):

1. a creator track in that language,
2. an auto-generated (asr) track in that language, unless `allowAuto` is false,
3. YouTube's machine translation (`tlang`) of the best translatable track, unless `allowTranslated` is false. The transcript is marked `translated: true`. When the player lists translation targets, only a listed language is used, with YouTube's own code for it (`pt-BR` becomes `pt`).

Without a language: a creator track in the spoken language (an asr track's language reveals it), then any creator track (the video's default first), then the asr track.

Languages match exactly first, then by primary subtag (`en` matches `en-GB`). Tracks download as srv3, then srv1. Parsers also handle json3 and WebVTT, and the format is detected from the body, never from the request, because the endpoint does not always honour `fmt`. The raw track text is kept as is; cleaning and translation by an LLM are separate layers.

### Player clients and fallback

Clients are tried in order. Defaults, verified live from a GCP VM on 2026-11-14:

| Client | Version | Notes |
|---|---|---|
| `android` (ANDROID) | 20.10.38 | first; caption URLs fetch without a PO token |
| `ios` (IOS) | 20.10.4 | same tracks as ANDROID |

Checked and dropped the same day: TVHTML5_SIMPLY_EMBEDDED_PLAYER ("YouTube is no longer supported in this application or device"), WEB and MWEB ("The page needs to be reloaded", even with visitorData; they now need a PO token), ANDROID_VR and TVHTML5 (the bot check from the VM, while ANDROID and IOS passed). The recorded responses are in `providers/youtube/test/fixtures/`.

The next client gets a turn when the current one:

- is refused for its own reasons (LOGIN_REQUIRED without a video reason, UNPLAYABLE "page needs to be reloaded", "no longer supported"),
- gets "Sign in to confirm you're not a bot" (often specific to one client),
- returns no captions,
- fails with an HTTP error other than a block (a retired version gets HTTP 400 "Precondition check failed").

A verdict about the video itself (removed, private, members-only, upcoming) stops the search. Each client tried is recorded as an attempt (`youtube/android`, `youtube/ios`) on the player response and on the error. Player responses are cached per video for 60 seconds, so metadata and captions share one call.

Settings: `YOUTUBE_CLIENTS=ios,android` changes the order or drops a client. `YOUTUBE_ANDROID_VERSION` and `YOUTUBE_IOS_VERSION` raise a version without a release. Other modules (metadata, browse, comments) call `innertubeRequest(endpoint, body, client, ctx)` with their own client spec and share the transport below.

### Errors

| Situation | Code | What to do |
|---|---|---|
| invalid id, removed video, private video | `not-found` | check the URL |
| age-restricted | `unavailable` | a signed-in, age-verified `YOUTUBE_COOKIE`, or the yt-dlp provider with cookies |
| members-only | `unavailable` | a member's `YOUTUBE_COOKIE` |
| blocked in this IP's region | `unavailable` | run from a region where it plays |
| upcoming stream or premiere | `unavailable` | the hint includes the scheduled start time |
| live stream still running | `unavailable` | captions appear after it ends |
| bot check on every client, the HTTP 429 "automated queries" page, HTTP 403 on every caption request | `blocked` | see below |
| HTTP 429 from the API without the block page | `rate-limited` | retried automatically, then wait |
| every client refused for client reasons | `unavailable` or `upstream` | raise a client version or change `YOUTUBE_CLIENTS` |
| empty caption track | `upstream` | YouTube wants a PO token: see below |

### What a block looks like

YouTube flags many cloud and datacenter IPs. Two shapes were seen from a GCP VM on 2026-11-14:

- the player API answers `LOGIN_REQUIRED` "Sign in to confirm you're not a bot" (for some clients; vid2context moves on to the next one, and reports `blocked` only when every client gets it),
- `timedtext` answers HTTP 429 with an HTML page: "Sorry... your computer or network may be sending automated queries". On that day the player API kept answering while every caption request got this page.

Retries never help with a block and tend to extend it. So a `blocked` result is not retried, and it opens a circuit breaker: for `YOUTUBE_BLOCK_COOLDOWN_SEC` (default 600, 0 turns it off) every YouTube call in the process fails fast with the same error and hint, and an attempt with reason `circuit-open`. Rate limits and 5xx get exponential backoff with full jitter instead (at most 3 retries, Retry-After honoured).

### Fixes for a block, best first

1. Run vid2context on your own machine. A home connection is rarely blocked.
2. Keep the server where it is but send its YouTube traffic through your home network: see `docs/guides/cloudflare-tunnel.md`.
3. Route through a proxy. vid2context has no proxy code of its own: Node 24 honours `HTTPS_PROXY` when started with `NODE_USE_ENV_PROXY=1`, for example `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://host:port npx vid2context <url>`.
4. Set `YOUTUBE_COOKIE` to the Cookie header of a signed-in youtube.com tab. With a `SAPISID` cookie, the matching `SAPISIDHASH` Authorization header is derived. Warning: the cookie ties every request to that Google account, and heavy use can get the account flagged, so use a spare account. The provider runs on Node, Workers and in the browser and never reads files: the CLI and server read a Netscape cookies file from `YOUTUBE_COOKIES_FILE` into `YOUTUBE_COOKIE`. YouTube honours account cookies mainly for its web clients, so with the default app clients the gain is uncertain. Not verified live (no account was used).
5. Install the yt-dlp provider, which has its own client rotation and cookie support.
6. Wait. Blocks usually lift after some time without requests.

### PO tokens

When YouTube wants a proof-of-origin token for a client, caption tracks come back empty. `YOUTUBE_PO_TOKEN` is sent in the player request (`serviceIntegrityDimensions.poToken`) and on caption URLs (`&pot=`, with `&c=<client>`). `YOUTUBE_VISITOR_DATA` must be the visitorData the token was minted for; it goes into the client context and the `x-goog-visitor-id` header. Tokens are minted outside vid2context (for example with BgUtils) and expire. Neither was needed on 2026-11-14 with ANDROID or IOS. Cookie and token values are never logged.

## Comments

Comments often hold what a video leaves out: owners' experiences, corrections from experts, and the creator's pinned clarifications. Ask for them with `getVideoContext(registry, url, { comments: 50 }, ctx)` (or `comments: true` for the default of 50). They come back in `VideoContext.comments`, a separate array that is never merged into the transcript. Comments are untrusted text written by the public: show them to a model as quoted material, not as instructions.

How they are fetched: keyless, through innertube `next` with the WEB client (no YouTube Data API key). The first call finds the comments section, then each continuation returns about 20 top-level threads. Paging stops as soon as the limit is reached, and `ctx.signal` is checked between pages.

| Setting | Default | What it does |
|---|---|---|
| `limit` (the `comments` number) | 50 | Top-level comments returned, 1 to 500. |
| `YOUTUBE_COMMENTS_SORT` | `top` | `top` (YouTube's ranking) or `newest`. Callers of `getYouTubeComments` can also pass `sort`. |
| `YOUTUBE_COMMENT_REPLIES` | 5 | Replies kept per expanded thread, 0 to 100. 0 turns reply fetching off (no extra requests). |
| `YOUTUBE_WEB_VERSION` | `2.20251110.01.00` | WEB client version. Raise it if YouTube starts rejecting the pinned one. Shared with metadata and browse. |

Replies cost one request per thread, so they are fetched for at most 20 threads: every thread the creator replied in first, then the 5 most liked threads with replies. Within a thread a creator reply is always kept, even when the reply limit is 1; the rest are filled in YouTube's order. If a thread is marked as having a creator reply that is not on the first page of replies, up to 3 reply pages are read to find it.

Each comment maps to the core `Comment` type:

- `id`, `author` (the display name, usually the `@handle`), `text` (plain text; links are kept as full URLs, emoji as characters, timestamps like `6:38` as written).
- `likes`: YouTube shows rounded counts (`1.2K`), so likes above 1,000 are approximate.
- `publishedAt`: approximate. YouTube only says "2 years ago", so the date is computed from that text and the time of the request. Day-or-longer units give a date only (`2024-11-14`); months count as 30 days and years as 365.
- `isCreator` (the author is the video's channel) and `isPinned`: set only when true. The pinned comment is always first.
- `replies`: present only on expanded threads.

Not represented: the creator's heart on a comment (the core type has no field for it, and nothing is added to the text), whether a comment was edited, and author channel ids.

When there are no comments to give, the result is `[]` with an info log saying why: comments turned off (for example videos made for kids), members-only or age-restricted videos, and videos with no comments yet. A video that does not exist, was removed or is private is an error, using the same error codes as captions. Each request goes through the shared YouTube transport, so a blocked IP fails fast with the same `blocked` error and hint as captions.

YouTube sends comments in two shapes: the WEB client uses entity payloads (`frameworkUpdates` mutations keyed from a `commentViewModel`), and the mobile web client still uses the classic `commentRenderer`. Both were seen live on 2026-11-14 and both are parsed.

## Playlists, channels and search

`listItems` (and `expandInput`, the MCP tool `list_items`, the HTTP route `GET /items`) expands a playlist, a channel or a search into video refs. Each item is the same ref a single-video URL gives (`youtube:<videoId>`, watch URL), so cached transcripts are shared. Everything is keyless, through innertube `browse`, `search` and `navigation/resolve_url` with the WEB client; no YouTube Data API key is used. URL matching is synchronous and makes no request.

### Input forms

| Input | Ref kind | Ref id | Lists |
|---|---|---|---|
| `youtube.com/playlist?list=PL...` (also `UU`, `FL`, `OL...` albums, any `list=` without `v=`, `/embed/videoseries?list=`) | `playlist` | `youtube:playlist:<listId>` | the playlist, in playlist order |
| `youtube.com/@handle` | `channel` | `youtube:channel:@handle` | every upload (videos, shorts, past streams), newest first |
| `youtube.com/@handle/videos`, `/shorts`, `/streams` | `channel` | `youtube:channel:@handle/videos` | that tab, newest first |
| `youtube.com/@handle/playlists` | `channel` | `youtube:channel:@handle/playlists` | the videos of every playlist on the tab, playlist by playlist |
| `youtube.com/@handle/featured` | `channel` | `youtube:channel:@handle/featured` | the videos shown on the Home tab |
| `youtube.com/channel/UC...`, `/c/name`, `/user/name`, each with the same optional tab | `channel` | `youtube:channel:UC...`, `youtube:channel:c:name`, `youtube:channel:user:name` (plus `/<tab>`) | as above |
| `ytsearch:<query>`, `ytsearch<N>:<query>`, `youtube.com/results?search_query=` | `playlist` (core has no search kind) | `youtube:ytsearch:<query>`, `youtube:ytsearch<N>:<query>` | video results only, in YouTube's ranking |

Channel `nativeId` is the `UC...` id when the URL carries it, otherwise `@handle`, `c:name` or `user:name`. The tab is recorded after a slash in the ref id and the URL, never in `nativeId`. Other channel subpages (`/community`, `/about`) match as the channel itself.

Hosts: only `youtube.com`, `www.`, `m.`, `music.youtube.com`, `youtube-nocookie.com` and `youtu.be` match, plus the `ytsearch` prefix, so these forms never shadow another provider.

Rejected with `unsupported-input`: mixes (`list=RD...`, personalized and endless), `ytsearch:` without a query, and a count outside 1 to 200.

A watch URL with both `v=` and `list=` stays a single video. To list the playlist, pass the `/playlist?list=` form.

### Limits and order

- `limit` stops paging as soon as it is reached; no further page is requested. Playlists and channels have no default limit, so an uncapped channel listing pages through every upload (about 100 per request).
- Search returns 20 results by default, `ytsearch<N>:` asks for N, and the maximum is 200. A smaller `limit` wins.
- `ctx.signal` is checked between pages.
- Pages follow continuation tokens until the list ends; a token seen twice ends the listing.

### How channels are listed

A handle, `/c/` or `/user/` URL is resolved to its `UC...` id with `navigation/resolve_url`, which also returns the tab's browse params. Then the upload playlists derived from the id are tried first, because one playlist request gives a stable newest-first order: `UU...` (all uploads) for a bare channel, `UULF...` (long-form videos) for `/videos`, `UUSH...` for `/shorts`, `UULV...` for `/streams`. If that playlist does not exist, the channel tab itself is listed. A channel without the requested tab (YouTube answers with the Home tab instead) lists nothing, with a log line.

### What is skipped

- Unavailable entries (private, deleted or otherwise unplayable videos). Playlists are requested with unavailable entries shown, so they can be counted, then skipped.
- Duplicates: a video already listed is not listed again, even across the playlists of a `/playlists` tab.
- Search shelves ("People also watched", shorts shelves) and ads; the search uses the type=video filter.
- On the `/playlists` tab, a private or deleted playlist is skipped with a warning; the rest are still listed.

Skipped counts go to one log line on stderr: `youtube: skipped list entries` with `unavailable`, `duplicates` and `listed`.

### Errors

| Situation | Code |
|---|---|
| playlist does not exist, is private or was deleted; channel or handle does not exist | `not-found` |
| list blocked in the region YouTube sees | `unavailable` |
| IP blocked (HTTP 429 block page) | `blocked`, through the shared YouTube transport and circuit breaker |
| a mix, an empty search, a bad search count | `unsupported-input` |

### Metadata for lists

`getMetadata` on a list ref returns a `VideoMetadata` with `chapters: []` and `extra.kind` set to `playlist`, `channel` or `search`. Playlists carry the title, description, owner channel, thumbnail and `extra.itemCount` (the count in the header). Channels carry the title, description, avatar, `extra.handle` and `extra.itemCount`. A search needs no request: its title is `YouTube search: <query>`.

`YOUTUBE_WEB_VERSION` (shared with comments) overrides the WEB client version if YouTube starts rejecting the pinned one.
