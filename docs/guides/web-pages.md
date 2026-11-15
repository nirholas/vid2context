# Web pages, Vimeo, Loom and Wistia

Two keyless providers cover videos that are not on YouTube:

- `providers/web-page` finds every video embedded in an article, course or landing page.
- `providers/native-transcripts` reads Vimeo, Loom and Wistia videos and the captions those platforms already publish, so no audio is downloaded and no speech-to-text runs when a track exists.

Both run on Node and Cloudflare Workers. Neither needs a key or an env var.

## The `page:` form

```sh
npm run cli -- "page:https://www.openculture.com/2012/07/ts_eliot_reads_his_modernist_masterpieces.html"
```

A `page:` prefix asks for the page's videos. Without the prefix, a plain URL goes to the platform's own source when there is one (YouTube, Vimeo, Loom, Wistia, ...) and otherwise to yt-dlp, which already handles a page with a single embed. The web-page provider never claims plain URLs, so it cannot take work away from yt-dlp.

`page:<url>` is a list ref (`kind: 'page'`). `expandInput`, `GET /items` and the MCP `list_items` tool turn it into video refs, in page order, each video once.

Surfaces can also call the discovery directly on any URL:

```ts
import { discoverVideos } from '@vid2context/provider-web-page';

const videos = await discoverVideos('https://example.com/article', ctx);
// [{ input: 'https://www.youtube.com/watch?v=...', platform: 'youtube', source: 'iframe', title?: ... }, ...]
```

## What discovery finds

| `source` | Where it looks |
|---|---|
| `iframe` | `<iframe>`, `<embed>` and `<object>` players from YouTube (including `youtube-nocookie.com`), Vimeo (`player.vimeo.com/video/`), Loom (`loom.com/embed/`), Wistia (`fast.wistia.net/embed/`, `<account>.wistia.com/medias/`, the `wistia_async_<id>` class and the `<wistia-player media-id>` element), Dailymotion, Twitch, Rumble and TED. Lazy `data-src` attributes count too. |
| `video-tag` | `<video src>` and `<source src>` inside `<video>`, resolved against the page URL (and `<base href>`). `<source>` inside `<picture>` or `<audio>` is ignored. |
| `og` | Open Graph `og:video`, `og:video:url`, `og:video:secure_url`. |
| `json-ld` | schema.org `VideoObject` anywhere in JSON-LD: top level, arrays, `@graph`, nested in an article. Reads `embedUrl`, `contentUrl`, `url`, `@id`, `name`, `description`, `uploadDate`, `duration`, `thumbnailUrl`, `inLanguage`, `author` and `transcript`. |
| `oembed` | `<link rel="alternate" type="application/json+oembed">` whose `url=` names a known video page. A site's oEmbed link for the article itself is not a video and is skipped. |
| `link` | `<a href>` to a known video page or a media file (`.mp4`, `.webm`, `.m3u8`, ...). Channel and playlist links are not videos and are skipped. |

Each result's `input` is what another source resolves: embeds become the platform's watch URL (a YouTube embed becomes `https://www.youtube.com/watch?v=...`, a Twitch player URL becomes `https://www.twitch.tv/videos/...`). When the same video appears several times (an iframe plus the JSON-LD and Open Graph that describe it), it is listed once, at its first position, with the details merged.

### Which refs `page:` expands to

The default web-page source resolves discovered inputs with the matchers it can reach on its own: YouTube, Vimeo, Loom and Wistia. Videos on other platforms, and media files, are skipped and logged at info level. A surface that holds a `Registry` can resolve through every installed source (yt-dlp included) instead:

```ts
import { createWebPageSource, registryResolve } from '@vid2context/provider-web-page';

const source = createWebPageSource({ resolve: registryResolve(registry) });
```

### Transcripts published in the page

Some pages publish the transcript in their JSON-LD (TED talk pages do). When a video has such a transcript and no platform-specific source owns it, `page:` yields a `page-video:<n>:<page url>` ref (the n-th `VideoObject` on the page). Its metadata comes from the JSON-LD, and the `web-page-transcript` captions provider returns the text as a `native-transcript`, one segment per paragraph. The text has no timings and none are invented: every segment runs from 0 to the video's duration when the duration is known (0 to 0 otherwise), and the producer is `web-page-transcript/untimed` so every surface can tell.

### Fetching limits

Pages are fetched with these limits, so a `page:` input cannot be used to reach private systems:

- http and https only; URLs with a user name or password are refused;
- hosts that are local or private are refused before any request, and again on every redirect: `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.home.arpa`, single-label names, and loopback, private, link-local, carrier-grade NAT, multicast and reserved IP literals (IPv4, IPv6, IPv4-mapped and NAT64 forms);
- at most 5 redirects, 20 seconds per request;
- at most 2 MB of HTML is read; a longer page is parsed as far as the cap and a warning is logged;
- a non-HTML response (a media file, JSON) is refused with a hint to pass the URL without `page:`.

The host check reads the hostname only. It cannot see a public name that resolves to a private address (DNS rebinding); roadmap item 10 adds that check to a shared hardened fetch.

## Vimeo, Loom and Wistia

Status verified live on 2026-11-14, keyless, from a Google Cloud VM, and re-verified on 2026-11-15 with the LIVE tests in `providers/native-transcripts/test/live.test.ts` and `providers/web-page/test/live.test.ts` (all passing).

| Platform | Shipped | Metadata | Transcript |
|---|---|---|---|
| Vimeo | yes: `vimeo`, `vimeo-captions` | oEmbed and the player config: title, owner, duration, thumbnail, upload date | the player config's WebVTT `text_tracks`: creator tracks as `creator-captions`, Vimeo's speech recognition as `auto-captions` |
| Loom | yes: `loom`, `loom-captions` | the public share page's `__APOLLO_STATE__`: title, owner, duration, chapters, created time | the WebVTT captions file the share page links to, made by Loom's speech recognition (`auto-captions`) |
| Wistia | yes: `wistia`, `wistia-captions` | `fast.wistia.com/embed/medias/<id>.json`: title, duration, created time, thumbnail | `fast.wistia.com/embed/captions/<id>.json`: every published track with timed lines (`creator-captions`) |

### Vimeo

Accepted URLs: `vimeo.com/<id>`, unlisted `vimeo.com/<id>/<hash>`, `player.vimeo.com/video/<id>` (with `?h=<hash>` for unlisted), `vimeo.com/channels/<name>/<id>`, `vimeo.com/groups/<name>/videos/<id>`, `vimeo.com/showcase/<id>/video/<id>` and `vimeo.com/album/<id>/video/<id>`. A plain Vimeo URL resolves to `vimeo`, not to yt-dlp, and a video with creator captions never costs a speech-to-text call. When there are no captions, yt-dlp supplies the audio.

Track choice: with `--lang`, a creator track in that language, then (unless auto-captions are turned off) an auto track in it. Without `--lang`, the video's locale is taken as the spoken language; then the track Vimeo marks default, then the first creator track.

Errors: a deleted video is `not-found`; a private or password video is `unavailable` (pass the full unlisted link with its hash if you have it).

From datacenter IPs, Vimeo answers the player config with a 403 bot check for many videos outside enterprise accounts ("We're having a little trouble"). oEmbed still works there, so metadata falls back to oEmbed (marked `extra.configBlocked`), and captions report `blocked`; the pipeline then moves on to yt-dlp audio. Running on your own machine avoids the bot check.

### Loom

Accepted URLs: `loom.com/share/<id>`, `loom.com/share/<title-slug>-<id>` and `loom.com/embed/<id>`. Works for videos shared with anyone with the link. Loom's captions are machine-made, so a request with auto-captions turned off (`allowAuto: false`) skips them, and a `--lang` other than the video's language returns none.

### Wistia

Accepted URLs: `fast.wistia.net/embed/iframe/<id>`, `fast.wistia.com/embed/iframe/<id>`, `fast.wistia.com/embed/medias/<id>` and `<account>.wistia.com/medias/<id>` (also `wi.st`). Wistia publishes neither the origin of a track nor the spoken language, so tracks are reported as creator captions and, with several tracks and no `--lang`, English is used when present, otherwise the first track. Extended audio descriptions (lines describing the picture) are dropped.
