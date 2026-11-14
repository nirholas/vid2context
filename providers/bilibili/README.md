# @vid2context/provider-bilibili

Bilibili videos as a vid2context source: metadata, multi-part videos, creator and AI subtitles, and audio for speech-to-text when a video has no subtitles. No key, plain `fetch`, runs on Node and Cloudflare Workers.

```sh
vid2context https://www.bilibili.com/video/BV1Sx411S71m          # creator subtitles (German)
vid2context "https://www.bilibili.com/video/BV1Sx411S71m?p=2"    # part 2
vid2context list "https://www.bilibili.com/video/BV1Sx411S71m?p=all"
vid2context https://b23.tv/<code>
```

Two providers: `bilibili` (source) and `bilibili-captions` (captions).

## Inputs and ref ids

| Input | Ref |
|---|---|
| `bilibili.com/video/BV...`, `m.bilibili.com/video/BV...`, bare `BV...` | `bilibili:BV...` (part 1, or the only part) |
| `.../video/av706`, bare `av706` | converted to the BV id without a request: `bilibili:BV1xx411c79H` |
| `...?p=2` | `bilibili:BV..._p2`, URL `https://www.bilibili.com/video/BV...?p=2` |
| `...?p=all` | `bilibili:playlist:BV...`, a playlist whose `listItems` yields every part |
| `player.bilibili.com/player.html?bvid=...` or `?aid=...` (`page=` or `p=`) | as above |
| `b23.tv/BV...`, `b23.tv/av...` | as above, no request |
| `b23.tv/<code>` | `bilibili:b23:<code>`; `getMetadata` (and captions or audio) resolves it with one HEAD request and reports the canonical ref in `metadata.ref` |

`match` is synchronous, so it cannot know whether a URL without `p` is a multi-part video. That URL means part 1, as on bilibili.com; `metadata.extra.parts` says how many parts exist, and `?p=all` (a vid2context convention, not a bilibili URL) asks for the list. Bangumi, cheese (paid courses), audio (`/audio/au...`), space and collection pages are not matched; the yt-dlp provider handles many of them on Node.

## Metadata

From `/x/web-interface/view`: title (for multi-part videos, the part's title is appended as `(P2 <part title>)`), uploader as `channel` with a `space.bilibili.com` URL, description, the part's duration, publish time, cover as `thumbnailUrl`. Tags from `/x/tag/archive/tags`; chapters from the player API's `view_points` when the uploader set them. Tags and chapters never fail the metadata call. `extra` has `bvid`, `aid`, `cid`, `part`, `parts`, `partTitle`, `original` (false for reposts), `category`, `views`, `likes` and `danmaku`.

## Subtitles

The player API (`/x/player/wbi/v2`) now hides subtitles from logged-out requests (`need_login_subtitle: true`, empty list), even creator ones. The danmaku view API (`/x/v2/dm/view?type=1&oid=<cid>&pid=<aid>`) returns the same list with fetchable URLs anonymously, so that is the primary source.

- type 0 (uploaded by a person): `creator-captions`.
- type 1, or a language starting with `ai-`: bilibili's speech recognition, `auto-captions`; `allowAuto: false` skips them.
- Language: `ai-zh` becomes `zh`; `zh-CN`, `de-DE` and similar stay as they are. A requested language matches exactly first, then by primary subtag. Bilibili has no machine translation, so a language with no track returns null and the pipeline moves on to speech-to-text.
- Bodies are JSON (`body: [{ from, to, content }]`, seconds) and map one line to one segment, newlines folded to spaces.

`BILIBILI_SESSDATA` (optional) is sent as the `SESSDATA` cookie to `api.bilibili.com` (never to the subtitle CDN), and the player API's own list is merged in. It is never required, and never logged.

## Audio

`getAudio` reads `/x/player/wbi/playurl` with `fnval=16` (DASH), picks the lowest-bandwidth audio-only stream (AAC in fragmented MP4, about 64 kbps), and downloads it itself, because bilibili's media hosts answer 403 without a `www.bilibili.com` Referer and speech-to-text rungs cannot send one for a `{ kind: 'url' }` input. It returns `{ kind: 'bytes', mimeType: 'audio/mp4', filename: '<BV>.m4a' }` and tries the backup hosts if the first fails. Video streams are never downloaded.

| Env var | Default | Effect |
|---|---|---|
| `BILIBILI_MAX_AUDIO_MB` | `50` | Largest audio download. The size is estimated from bandwidth times duration before downloading and enforced while reading; larger audio fails with `too-large`. About 100 minutes at 64 kbps. |
| `BILIBILI_SESSDATA` | unset | Logged-in session cookie value (optional). |

The keyless OVH speech-to-text lane takes 10 MB per upload, about 20 minutes of this audio; longer parts need a key or a local rung until long-audio splitting (item 04) handles fMP4.

## WBI signature

`/x/player/wbi/v2` and `/x/player/wbi/playurl` need bilibili's WBI signature. The keys come from `/x/web-interface/nav` (once per `Ctx`), the mixin key is their stems reordered by bilibili's 64-entry table, and `w_rid` is the MD5 of the sorted, filtered, URL-encoded query plus that key. Ported from yt-dlp (Unlicense, see `THIRD_PARTY_NOTICES.md`). MD5 is implemented in `src/md5.ts` because WebCrypto has no MD5, which keeps the provider free of `node:crypto`. The tests check the signature against the documented example vector and verify every recorded signed request.

## Errors

| API code | Error |
|---|---|
| -404 | `not-found` |
| 62002 hidden, 62012 uploader only, -403, 87008 paid | `unavailable` |
| 62004 under review | `unavailable` |
| -10403, 6002003 region | `unavailable` |
| -412, -352, HTTP 412 (risk control) | `blocked`, hint: wait, another network, or `BILIBILI_SESSDATA` |
| -101 needs login | `auth` |
| a part number past the last part | `not-found`, hint lists the valid range and `?p=all` |

## Runtimes

`node` and `workers`. Browsers cannot set the Referer bilibili requires, so there is no browser build.

## Tests

`npx vitest run providers/bilibili` replays real responses (see `test/fixtures/README.md`). `LIVE=1` adds live checks: German creator subtitles for BV1Sx411S71m through the pipeline, and a live WBI-signed playurl call plus a full audio download with the Referer.
