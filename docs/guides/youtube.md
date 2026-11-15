# YouTube

## Captions and blocks

Captions are the cheapest and most accurate transcript: no audio download, no speech-to-text. `youtube-captions` reads them keylessly through the innertube player API and the `timedtext` endpoint.

### How a track is chosen

With a language (`--lang de`, `language: 'de'`):

1. a creator track in that language,
2. an auto-generated (asr) track in that language, unless `allowAuto` is false,
3. YouTube's machine translation (`tlang`) of the best translatable track, unless `allowTranslated` is false. The transcript is marked `translated: true` and keeps the language it was translated from in `extra.sourceLanguage`. When the player lists translation targets, only a listed language is used, with YouTube's own code for it (`pt-BR` becomes `pt`).

Without a language: a creator track in the spoken language (an asr track's language reveals it), then any creator track (the video's default first), then the asr track in the spoken language.

Auto-dubbed videos have one asr track per dubbed language, listed alphabetically, so the first one is not the spoken language (r3UXC_U6iCQ, spoken in English, listed Bangla first on 2026-11-14). The original language comes from the player's audio tracks instead: each audio track lists the original language's caption track first, and the original audio's id ends in `.4` (dubs end in `.10`). `metadata.language` uses the same rule.

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

Retries never help with a block and tend to extend it. So a `blocked` result is not retried, and it opens a circuit breaker for `YOUTUBE_BLOCK_COOLDOWN_SEC` (default 600, 0 turns it off). YouTube blocks its endpoints independently, so there is one breaker per endpoint family: `player` (the player API), `timedtext` (caption downloads) and `web` (`next`, `browse`, `search`, `resolve_url`). A caption block pauses caption downloads but not metadata, and a player block leaves `next` and oEmbed working. While a breaker is open, requests of that family fail fast with an attempt of reason `circuit-open` and a message that says this request was not sent, which family is paused, for how long, and quotes the earlier blocked request (so it never reads as if this video failed with another video's error). Rate limits and 5xx get exponential backoff with full jitter instead (at most 3 retries, Retry-After honoured).

### Fixes for a block, best first

1. Run vid2context on your own machine. A home connection is rarely blocked.
2. Keep the server where it is but send its YouTube traffic through your home network: see `docs/guides/cloudflare-tunnel.md`.
3. Route YouTube through a proxy with `YOUTUBE_PROXY` (Node: CLI, server, MCP). See [YouTube-only proxy](#youtube-only-proxy) below. This is what hosted transcript sites do: they send YouTube requests through pools of residential IP addresses.
4. Set `YOUTUBE_COOKIE` to the Cookie header of a signed-in youtube.com tab. With a `SAPISID` cookie, the matching `SAPISIDHASH` Authorization header is derived. Warning: the cookie ties every request to that Google account, and heavy use can get the account flagged, so use a spare account. The provider runs on Node, Workers and in the browser and never reads files, so reading a Netscape cookies file (`YOUTUBE_COOKIES_FILE`) into `YOUTUBE_COOKIE` is left to the Node surfaces (CLI, server); until they do, paste the header value itself. YouTube honours account cookies mainly for its web clients, so with the default app clients the gain is uncertain. Not verified live (no account was used).
5. Install the yt-dlp provider, which has its own client rotation and cookie support.
6. Wait. Blocks usually lift after some time without requests.
7. Get the transcript from the user's side: the web app's error panel offers "Get it from my browser" (the vid2context extension fetches the captions from the user's own IP), pasting YouTube's "Show transcript" text, or uploading a subtitle file. All three end in `POST /api/v1/imports` (docs/contracts/transcript-import.md).

#### YouTube-only proxy

`YOUTUBE_PROXY` takes one HTTP(S) proxy URL or several separated by commas: `http://host:port`, or `http://user:pass@host:port` for a provider that needs a login. Only requests to `youtube.com` (and subdomains), `youtu.be`, `youtube-nocookie.com`, `googlevideo.com` and `youtubei.googleapis.com` go through it. LLM, speech-to-text and storage calls stay direct, so the proxy operator never sees your API keys and proxy bandwidth is spent only on YouTube. yt-dlp gets the first proxy as `--proxy` for YouTube URLs only.

- Several proxies rotate per request. Every proxied request opens a new connection, so a rotating residential gateway gives each request (and each retry after a block) a new exit IP.
- Works with any HTTP CONNECT proxy: a paid rotating residential service, or a small proxy such as tinyproxy or Squid on a machine in your home network (reachable over a VPN such as Tailscale or WireGuard).
- SOCKS is not supported. Workers and the browser build cannot use it (Workers have no outbound proxy support): use a relay or the import routes there.
- The value can hold a password, so it is never logged, and errors name the proxy host only.
- Verified with a local CONNECT proxy in `packages/registry/test/proxy.test.ts` (routing, credentials, a new tunnel per request, rotation). Not verified with a commercial residential proxy (none was available on 2026-11-14).
- To proxy every outbound request instead (YouTube and all other services alike), Node 24 has this built in with no vid2context setting: start the process with `NODE_USE_ENV_PROXY=1` and `HTTPS_PROXY=http://host:port` (plus `NO_PROXY` for hosts that should stay direct). The YouTube provider has no proxy code of its own; it uses whatever `fetch` the surface hands it.

#### What still works while the player is blocked

A block is about this server's IP address, not the video, so it does not end a run:

- Metadata falls back to the WEB `next` response (title, description, channel, publish date, views, likes, chapters) and YouTube's oEmbed endpoint (title, channel, thumbnail). oEmbed is a separate service and is never paused by the breaker. Only the duration, tags, spoken language and Shorts detection are missing, and `extra.playerBlocked` is true with `extra.metadataSource` (`next+oembed`, `next` or `oembed`). On 2026-11-14 both kept answering from a GCP VM that got HTTP 429 on every caption download. If neither answers, the original `blocked` error is raised.
- The pipeline records a blocked metadata step and goes on to the captions providers (yt-dlp, Supadata), audio sources and speech-to-text. When none produces a transcript, the run fails with `blocked` and the block's hint (not `no-transcript`), with every attempt listed.

#### Hosted transcript API (Supadata)

Hosted transcript APIs fetch captions from their own IPs, so they work where this machine is blocked. vid2context ships one: set `SUPADATA_API_KEY` (free plan: 100 credits a month at https://dash.supadata.ai) and the `supadata-captions` provider runs after `youtube-captions` and `ytdlp-captions` have found nothing, so credits are spent only when the keyless paths fail. Without the key it never runs.

- It asks only for existing captions (`mode=native`), never Supadata's AI transcription; speech-to-text stays with vid2context's own rungs.
- Each lookup costs 1 credit, including a "transcript unavailable" answer. Async jobs are polled every second for up to `SUPADATA_MAX_WAIT_SEC` (default 120).
- Supadata does not say whether a track is the creator's or YouTube's automatic one, so results are labelled `auto-captions`; with auto-captions turned off it is skipped.
- If the requested language is missing, Supadata answers in another language; vid2context then returns nothing from it rather than the wrong language.
- Errors: `auth` (bad key or plan), `rate-limited` (1 request a second, or monthly credits used up; the hint says which), `unavailable` (private or restricted video), `not-found`, `timeout`, `upstream`.
- The video id goes to a third party. Not verified live yet (no key was available on 2026-11-14).

### PO tokens

When YouTube wants a proof-of-origin token for a client, caption tracks come back empty. `YOUTUBE_PO_TOKEN` is sent in the player request (`serviceIntegrityDimensions.poToken`) and on caption URLs (`&pot=`, with `&c=<client>`). `YOUTUBE_VISITOR_DATA` must be the visitorData the token was minted for; it goes into the client context and the `x-goog-visitor-id` header. Tokens are minted outside vid2context (for example with BgUtils) and expire. Neither was needed on 2026-11-14 with ANDROID or IOS. Cookie and token values are never logged.

## Metadata and chapters

`youtube.getMetadata` makes one player request (the same cached response the captions provider uses), one `next` request (the watch page's data, WEB client) and one `HEAD` request for the maxres thumbnail, the last two in parallel. No key. With `YOUTUBE_METADATA_MICROFORMAT=1` it also asks the WEB player for its microformat (see below), and that answer replaces the `HEAD` request. It succeeds whenever the player returns `videoDetails`, including age-restricted, members-only, live and upcoming videos: those states are reported in `extra`, and the transcript stage raises the errors. If the `next` request fails, the player fields are still returned and a warning is logged.

### Fields and where they come from

| Field | Source |
|---|---|
| `title`, `description` (full), `tags`, `durationSec` | player `videoDetails` (`title`, `shortDescription`, `keywords`, `lengthSeconds`; 0 for live and upcoming becomes `undefined`) |
| `channel.name`, `channel.id`, `channel.url` | player `author` and `channelId`; the URL is the stable `/channel/<id>` form |
| `publishedAt` | the microformat `publishDate` when it was fetched (full ISO 8601 with time and offset, `2025-06-16T04:00:04-07:00`; not used for upcoming streams, where it is the page's creation time), else the date line under the title in `next` (`dateText`), as an ISO date `YYYY-MM-DD`. "Premiered Feb 24, 2026", "Streamed live on Apr 1, 2026" and "Started streaming on Aug 19, 2026" give that date. Relative dates ("23 hours ago") and "Scheduled for" give none |
| `thumbnailUrl` | `maxresdefault.jpg` when the microformat lists it or a `HEAD` request finds it, else the largest thumbnail the player lists (usually `sddefault` or `hqdefault`). The player never lists maxres, and its presence cannot be inferred (5 of 14 sampled videos listing sddefault had none) |
| `language` | the language of the auto-caption (asr) track, which is the spoken language; `undefined` without one |
| `isLive`, `extra.isLive` | player `isLive` |
| `extra.viewCount` | player `viewCount` (total views, also for live streams) |
| `extra.likeCount` | the exact count in the like button's label in `next` ("along with 20,138,292 other people"), else the microformat `likeCount`; absent when likes are hidden |
| `extra.liveViewers` | the "watching now" (live) or "waiting" (upcoming) count in `next` |
| `extra.dateText` | the date line as YouTube shows it |
| `extra.channelHandle`, `extra.channelHandleUrl` | the owner's `@handle` from `next` (else the microformat `ownerProfileUrl`) and `https://www.youtube.com/@handle` |
| `extra.subscriberCountText` | as shown, for example "6.74M subscribers" |
| `extra.isShort` | the first signal available: the input was a `/shorts/` URL; else the microformat's `isShortsEligible` (true for the recorded Short, false for every other recorded video, checked on 2026-11-15); else every video stream is taller than wide and the video is at most 3 minutes long. The ANDROID player and `next` do not flag Shorts (checked on 2026-11-14) |
| `extra.isUpcoming`, `extra.premiereAt` | player `isUpcoming`, and the scheduled start (`scheduledStartTime`, ISO 8601) of an upcoming premiere or live stream |
| `extra.ageRestricted` | the player status is not OK and its reason mentions age or "inappropriate" |
| `extra.membersOnly` | the player reason mentions members, or `next` shows the members-only badge |
| `extra.isLiveContent`, `extra.playability` | player `isLiveContent` and `playabilityStatus.status` |
| `extra.links` | every http(s) URL in the description, de-duplicated, in order, without trailing punctuation |
| `extra.chapterSource` | `description`, `markers` or `key-moments` (absent when there are no chapters) |
| `extra.category`, `extra.uploadDate`, `extra.isUnlisted` | microformat `category` ("Comedy"), `uploadDate` (ISO 8601 with time) and `isUnlisted`; only with the microformat |
| `extra.liveStartedAt`, `extra.liveEndedAt` | microformat `liveBroadcastDetails` start and end (ISO 8601) of a live or past live stream; only with the microformat, and no start for an upcoming stream |

### The microformat (opt-in)

The category, exact publish and upload timestamps, the unlisted flag, YouTube's own Shorts flag and live start and end times exist only in the WEB player response's `microformat.playerMicroformatRenderer`. The ANDROID and IOS player responses and `next` do not carry them. The WEB player answers `UNPLAYABLE` without a PO token, but it still returns the microformat (checked for 9 videos on 2026-11-15). Fetching it is a second player request, and the default keeps to one player request shared with captions, so it is off unless `YOUTUBE_METADATA_MICROFORMAT=1` (or `true`, `yes`, `on`). When it is on, it runs in parallel with `next`, its thumbnail list replaces the maxres `HEAD` check, and a failure is logged and skipped (the `HEAD` check runs instead). A blocked answer counts against the player breaker like any other player call. A microformat already in the shared player response is always read, at no cost.

### Chapter precedence

The first source that yields a list wins:

1. Creator chapters parsed from the description.
2. YouTube's chapter markers in `next` (player bar markers, key `DESCRIPTION_CHAPTERS`): YouTube's own parse of the description.
3. Auto-generated chapters, shown as "key moments" (key `AUTO_CHAPTERS`).

Every chapter gets `endSec`: the next chapter's start, and the duration for the last one (no `endSec` for the last chapter when the duration is unknown).

### Description rules

A description yields chapters when it has a line stamped `0:00` (or `00:00`, `00:00:00`), at least three timestamped lines in all, and ascending times. Lines before the `0:00` line are ignored, and the list ends at the first time that does not ascend or that falls past the end of the video, so stray timestamps elsewhere do not leak in.

- Timestamps: `h:mm:ss`, `hh:mm:ss`, `mm:ss`, `m:ss`, optionally in brackets or parentheses, optionally as a range (`0:00 - 0:30: Intro` gives "Intro" at 0).
- The title may come before or after the timestamp, with or without a separator (`-`, `|`, `:`, dashes, bullets). Bullets and list numbers before a leading timestamp are dropped; a list number before a trailing-timestamp title stays, as on YouTube.
- A timestamp in the middle of a line is never a chapter ("at 3:45 he says"), nor a trailing one after words such as "at", "to", "from", "around" ("skip to 12:30").
- Titles are trimmed, inner spaces collapsed, emoji at either end and quotes that wrap the whole title removed (YouTube does the same).
- YouTube's help page asks for chapters of at least 10 seconds, but YouTube accepts shorter ones (the 5-second "Intro" of jNQXAC9IVRw), so this rule is not enforced.

Checked against 220 real videos on 2026-11-14: the parser matches YouTube's own chapter list for every description except six where the creator's list is valid but YouTube showed no description chapters (those keep the creator's chapters) and one that uses time ranges (YouTube keeps "0:30:" in the titles; this parser reads the range).

`YOUTUBE_WEB_VERSION` overrides the WEB client version used for `next` (default `2.20261112.10.00`).

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

A watch URL with both `v=` and `list=` (what YouTube's share button gives inside a playlist) stays a single video, and the playlist is reported next to it: `Registry.resolve` returns it as `list` (from `matchYouTubeList`), so every surface can offer it without guessing. To use the playlist:

- web app: the result (and the Download page) shows "This video is part of a playlist: <title> (N videos)" with a link that opens all of them;
- CLI: add `--playlist` to `list`, `pack`, `bundle` or `download`; `get` and the others print a note with that command;
- HTTP API: `GET /items?url=...&playlist=1` (without it, the answer carries `list`);
- MCP: `list_items` with `playlist: true` (without it, the result carries `list`);
- library: `expandInput(registry, url, ctx, { list: true })`.

Passing the `/playlist?list=` form works everywhere too. Mixes (`list=RD...`) are never offered.

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
