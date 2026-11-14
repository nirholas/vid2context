# native-transcripts fixtures

Every file is a real response, recorded on 2026-11-14 with curl from a Google Cloud datacenter IP, keyless. Player configs were trimmed to the fields the provider reads; nothing else was changed unless noted. No file contains an IP address, email address or key (checked with grep).

## Vimeo

| File | Source | Notes |
|---|---|---|
| `vimeo-oembed-76979871.json` | `https://vimeo.com/api/oembed.json?url=https%3A%2F%2Fvimeo.com%2F76979871` | "The New Vimeo Player (You Know, For Videos)", Vimeo staff account. Unchanged. |
| `vimeo-config-76979871.json` | `https://player.vimeo.com/video/76979871/config` | Trimmed to `view`, `video` (id, title, size, duration, urls, privacy, embed permission, thumbnail, unlisted hash, locale, live event, owner id/name/url/account type) and `request` (`lang`, `text_tracks`). Removed: stream URLs (they embed the client IP), session, cookie, signatures, flags. Four creator tracks (de, es, en, fr), `provenance: user_uploaded`. |
| `vimeo-76979871-en.vtt` | the `en` track URL from that config (`captions.vimeo.com`) | Unchanged WebVTT. |
| `vimeo-oembed-1133654544.json` | oEmbed for `https://vimeo.com/1133654544` | "Vimeo REFRAME 2025 Replay". Unchanged. |
| `vimeo-config-1133654544.json` | player config for 1133654544 | Trimmed as above. One `en-x-autogen` track with `provenance: ai_generated` plus six creator tracks. |
| `vimeo-1133654544-en-x-autogen.vtt`, `vimeo-1133654544-de.vtt` | the `en-x-autogen` and `de` track URLs from that config | Unchanged WebVTT. |
| `vimeo-oembed-336812660-404.txt` | oEmbed for `https://vimeo.com/336812660` | HTTP 404, body `404 Not Found`. A private video. |
| `vimeo-config-336812660.json` | player config for 336812660 | HTTP 200 with `view: 2` and only `video.id`: what Vimeo returns for a private video (its embed page is titled "Private Video on Vimeo"). Trimmed as above. |
| `vimeo-oembed-1084537.json` | oEmbed for `https://vimeo.com/1084537` | "Big Buck Bunny" by Blender, a public video on a basic account. Unchanged. |
| `vimeo-config-1084537-403.html` | player config for 1084537 | HTTP 403 bot-check page ("We're having a little trouble") that Vimeo serves to this datacenter IP for non-enterprise videos. Inline scripts (a Cloudflare challenge with per-request tokens) removed. |
| `vimeo-oembed-1000-404.txt`, `vimeo-config-1000-404.html` | oEmbed and player config for 1000 | Both HTTP 404 ("This video does not exist"). Inline scripts removed from the HTML. |

## Loom

| File | Source | Notes |
|---|---|---|
| `loom-share-09b1aa507cb846138847bf8e98b56a71.html` | `https://www.loom.com/share/09b1aa507cb846138847bf8e98b56a71` ("Unstuck your team with Loom", Loom's own marketing account) | Reduced to the page `<title>` and the `window.__APOLLO_STATE__` script, which is all the provider reads. The video's signed media URLs (`nullableRawCdnUrl` fields) were removed; the signed captions URL was kept (its CloudFront policy holds only an expiry time). |
| `loom-09b1aa507cb846138847bf8e98b56a71.vtt` | the `captions_source_url` from that page | Unchanged WebVTT, produced by Loom's speech recognition (`processing_service: instant_whisper`). |
| `loom-share-0123456789abcdef0123456789abcdef-404.html` | the share page for an id that does not exist | HTTP 404. Reduced the same way: `getVideo` is `null` and the transcript field is an `InvalidRequestWarning`. |

## Wistia

| File | Source | Notes |
|---|---|---|
| `wistia-media-i5voqxuarc.json` | `https://fast.wistia.com/embed/medias/i5voqxuarc.json` (a video on wistia.com's home page) | Trimmed to the fields read (name, duration, created time, type, protected, status, SEO description, available transcripts) and the still-image asset. Removed: account ids, keys, stats, stream assets. |
| `wistia-captions-i5voqxuarc.json` | `https://fast.wistia.com/embed/captions/i5voqxuarc.json` | Unchanged. Seven tracks (nl, en, es-MX, fr, de, pt, es) with timed lines; the English track includes extended audio descriptions. |
| `wistia-media-26sk4lmiix.json` | media JSON for `26sk4lmiix` (the example id in Wistia's embed documentation) | Trimmed as above. |
| `wistia-captions-26sk4lmiix.json` | captions JSON for `26sk4lmiix` | Unchanged: `{"captions":[],"preferred_languages":[]}`. |
| `wistia-media-zzzzzzzzzz.json` | media JSON for an id that does not exist | Unchanged: HTTP 200 with `{"error":true,"iframe":true}`. |

## WebVTT parser input

| File | Source | Notes |
|---|---|---|
| `youtube-QYRbx7PhiB8-rolling.en.vtt` | `https://archive.org/download/youtube-QYRbx7PhiB8/` (file `Mecanique_Auto-Les_Disques_et_Plaquettes_de_Frein-QYRbx7PhiB8.en.vtt`), the Internet Archive's mirror of the YouTube video "Les Disques et Plaquettes de Frein" by Mécanique Auto | YouTube auto-captions as downloaded by youtube-dl: rolling cues, `align:start position:0%` settings, `<c>` tags and karaoke timestamps. License: CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/), as stated on the archive.org item. Unchanged. YouTube itself answered this IP with HTTP 429, so the archive copy was used. |
