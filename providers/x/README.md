# @vid2context/provider-x

X (Twitter) videos as a vid2context source: the post's text, author and date as metadata, every MP4 quality X serves as a direct link, and audio for speech-to-text. No key, no login, no yt-dlp, plain `fetch`, runs on Node and Cloudflare Workers.

```sh
vid2context https://x.com/NASA/status/2094024294988701975
vid2context https://x.com/NASA/status/2094024294988701975 --format json   # metadata.extra.variants lists the MP4s
vid2context "https://x.com/<user>/status/<id>/video/2"                    # the second media item of a post
```

## Inputs and ref ids

| Input | Ref |
|---|---|
| `x.com/<user>/status/<id>`, `twitter.com/...`, `mobile.twitter.com/...`, `mobile.x.com/...` | `x:<id>` |
| `/i/status/<id>`, `/i/web/status/<id>`, `/<user>/statuses/<id>` | `x:<id>` |
| `fxtwitter.com`, `vxtwitter.com`, `fixupx.com`, `fixvx.com` links | `x:<id>` |
| `.../status/<id>/video/<n>` (or `/photo/<n>`), n from 2 to 4 | `x:<id>_v<n>`, media item n of the post |

Without a position, the post's first video or GIF is used. Live broadcasts (`/i/broadcasts/...`), Spaces and profiles are not matched; the yt-dlp provider handles broadcasts on Node.

## Metadata

The post comes from X's syndication endpoint (`cdn.syndication.twimg.com/tweet-result`, the JSON behind embedded posts). When that fails (a 404, a tombstone, a rate limit), FxTwitter (`api.fxtwitter.com/i/status/<id>`) is tried. Both are keyless.

When both fail and `X_BEARER_TOKEN` (or `TWITTER_BEARER_TOKEN`) is set, a third lane asks x.com's GraphQL (`TweetResultByRestId`) with a guest token, the same lane [xactions](https://github.com/nirholas/xactions) runs for xactions.app/video. The bearer token is the one an X web client sends (x.com's web bundle carries one); a guest token is minted from it with `POST api.x.com/1.1/guest/activate.json` and reused for 2.5 hours. The answer has the same media ladder and HLS playlist as syndication, plus reposts and views. `X_GRAPHQL_QUERY_ID` replaces the operation id when X rotates it. Without a bearer token the lane never runs.

- `title`: the first line of the post text without links, at most 100 characters. `description`: the full text, with the leading reply mentions and the trailing media link removed and t.co links expanded.
- `channel`: the author, with `https://x.com/<handle>`. `publishedAt`, `durationSec`, `thumbnailUrl` (the video poster), `tags` (hashtags).
- `extra`: `postId`, `handle`, `mediaType` (`video` or `gif`), `mediaPosition`, `mediaCount`, `width`, `height`, `variants`, `hls`, `textLanguage` (X's guess for the text, not the speech), `likes`, `replies`, `reposts` and `views` (FxTwitter and GraphQL only), `replyTo`, and `via` (`syndication`, `fxtwitter` or `graphql`).
- `variants` lists every MP4 rendition, highest bitrate first: `{ url, bitrate, width, height, quality }`, for example `1080p`. These are direct links to `video.twimg.com`, which serves them without a Referer or login, so any surface can offer a quality picker and a plain download. GIFs have one rendition and no `quality`.

A reply's parent is never used. A post with no video of its own that quotes another post uses the quoted post's video: neither service sends the quoted post's media, so it is fetched by id (one level; a quote of a quote is not followed, and a link with `/video/<n>` never follows a quote). The metadata then describes the quoted post (its author, text and video), `extra.quotedBy` holds the linked post (`postId`, `handle`, `text`), `extra.videoUrl` the quoted post's link, and `ref.url` stays the linked post. When neither has a video the answer is `unavailable`.

## Audio

X posts have no captions, so the transcript always comes from speech-to-text.

1. X's HLS master playlist lists audio-only renditions (AAC at 32, 64 and 128 kbps) as fragmented MP4. The lowest one is downloaded (init segment, then every 3-second fragment, six at a time) and joined into one `.m4a`. For the NASA test video that is 140 KB, against 558 KB for the smallest MP4.
2. When there is no usable playlist, or a fragment still fails after one retry, the smallest MP4 rendition is downloaded instead.

Each fragment request has a 30 second timeout and one retry on a network error, a 5xx or a 429 (not on a 403 or 404). When one fails for good, the requests still in flight are cancelled at once, so a broken stream never holds the download for long.

Audio-only matters beyond size: OVH's keyless speech-to-text lane answers 413 ("max 60 seconds") for X's MP4 of a 33-second video, and transcribes the `.m4a` of the same video. Both paths stop at `VID2CONTEXT_MAX_MEDIA_MB` (default 200), checked from the bitrate and duration before downloading and again while downloading. GIFs have no sound and answer `unavailable`.

## Env

| Variable | Default | Meaning |
|---|---|---|
| `X_FXTWITTER` | on | `0` turns off the FxTwitter fallback, so only X's own endpoint is asked. |
| `X_FXTWITTER_BASE_URL` | `https://api.fxtwitter.com` | A self-hosted FxEmbed instance. |
| `X_BEARER_TOKEN` | unset | Turns on the GraphQL guest-token lane, tried after the two keyless lanes. `TWITTER_BEARER_TOKEN` (the name xactions uses) works too. Redacted from logs like every `*_TOKEN`. |
| `X_GRAPHQL_QUERY_ID` | `GZsN2Pc4knAoit6pXa4HSA` | The `TweetResultByRestId` operation id, for when X rotates it. |
| `VID2CONTEXT_MAX_MEDIA_MB` | 200 | Largest audio or video download (shared with the media-url provider). |

## Limits

- Only public posts. Protected, deleted and suspended accounts answer `not-found`; age-restricted and withheld posts answer `unavailable` from syndication, and FxTwitter sometimes reads them. On Node, yt-dlp with browser cookies covers the rest.
- Downloading a chosen quality to disk is not part of this provider: use the `variants` links, or `vid2context download <url>` (yt-dlp, Node).

Verified live from a US VM on 2026-11-15: metadata from both services, HLS audio, and a full transcript through the keyless OVH lane with no keys set. The GraphQL lane was verified live on 2026-11-19 (guest token minted, the NASA post read with its five MP4 renditions and HLS playlist). Every request names its client (`user-agent: vid2context/0.1 (+https://github.com/nirholas/vid2context)`): with no user-agent, which is what Cloudflare Workers' fetch sends, X's syndication endpoint answers 400 and FxTwitter 401, and X's guest activation answers 404 to Node's default `user-agent: node`.
