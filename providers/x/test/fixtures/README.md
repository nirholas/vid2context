# X fixtures

Real responses recorded from this repo's VM (a US datacenter IP) on 2026-11-15 with curl, no cookie, no login. Tests replay them through `replayFetch` (`@vid2context/core/testing`), so unit tests never touch the network. JSON files hold the response body exactly as returned.

| File | Request |
|---|---|
| `syndication-2094024294988701975.json` | `GET https://cdn.syndication.twimg.com/tweet-result?id=2094024294988701975&lang=en&token=...`: NASA, "Liftoff! @NASARoman begins its flight to space...", 2026-08-30, a 32.9 s video (public domain, NASA) with an HLS playlist and six MP4 renditions from 480x270 to 3840x2160. The post replies to an earlier NASA post, whose own video is in `parent`. |
| `syndication-1882872996031066248.json` | Same for NASA, "Everybody, wave!" (Blue Ghost lander), 2025-01-24: one `animated_gif` with a single MP4 (`bitrate: 0`) |
| `syndication-20.json` | Same for post 20, "just setting up my twttr": text only, no `mediaDetails` |
| `syndication-404.html` | Same for 1263569466313105408 (no such post): HTTP 404 with X's HTML error page |
| `fxtwitter-2094024294988701975.json` | `GET https://api.fxtwitter.com/i/status/2094024294988701975`: the NASA Roman post through FxTwitter (MP4 URLs carry `?tag=29`) |
| `fxtwitter-1882872996031066248.json` | Same for the Blue Ghost GIF post (`type: gif`, one mp4 format) |
| `fxtwitter-404.json` | `GET https://api.fxtwitter.com/i/status/1263569466313105408`: HTTP 404, `{"code":404,"message":"NOT_FOUND","tweet":null}` |
| `mp4-480x270-head.mp4` | `GET https://video.twimg.com/amplify_video/2094024240437547008/vid/avc1/480x270/UazEpdmCJehe4HMQ.mp4` with `Range: bytes=0-4095`, no Referer: HTTP 206, `content-type: video/mp4`, `content-range: bytes 0-4095/558676`, the 4,096 bytes returned. The test replays status, these three headers and the bytes. |

Nothing was trimmed: the responses hold only public post data (text, public account names and ids, counts, media URLs). X media URLs carry no requesting IP or signature; the files were grepped for IPv4 addresses before committing.

Added later the same day:

| File | Request |
|---|---|
| `syndication-2121759522851115109.json` | Same endpoint for elonmusk, "The epic day has arrived...": no media, `quoted_tweet.id_str` 2121725076919717899 (the quoted post's media is not included) |
| `syndication-2121725076919717899.json` | Same for the quoted post, WalterIsaacson: text only |
| `hls/master.m3u8` | `GET` of the NASA video's HLS master playlist (the `application/x-mpegURL` variant): three audio-only renditions (32, 64, 128 kbps) and four video renditions |
| `hls/mp4a-32000.m3u8` | `GET` of the 32 kbps audio playlist: one init segment (`EXT-X-MAP`) and eleven fragments, 32.944 s |
| `hls/5upmBTnQXx3UBWed.mp4`, `hls/*.m4s` | The init segment and the eleven fragments it lists (140,530 bytes together; joined in order they are a valid 32.9 s AAC .m4a, checked with ffprobe) |

X's video host answers a missing file with HTTP 404 and an empty body (checked with a made-up segment name); the fallback test replays exactly that.

Added 2026-11-19, recorded through this provider's own `fetchGraphQL` (so the request is exactly what the code sends) with `X_BEARER_TOKEN` set to the bearer token of x.com's web client:

| File | Request |
|---|---|
| `graphql-guest-activate.json` | `POST https://api.x.com/1.1/guest/activate.json`: `{"guest_token":"..."}`. The token's digits were replaced with zeros before committing (it is a short-lived anonymous credential); nothing else was changed. |
| `graphql-2094024294988701975.json` | `GET https://api.x.com/graphql/GZsN2Pc4knAoit6pXa4HSA/TweetResultByRestId?variables=...` for the NASA Roman post: a `Tweet` with the author under `core.user_results.result.core`, the v1.1 tweet under `legacy` (same media shape as syndication: an HLS playlist and five MP4 renditions, URLs ending `?tag=29`), and `views.count` 452722. Public post and account data only. |
| `graphql-1263569466313105408.json` | The same request for the missing post: HTTP 200 with `{"data":{"tweetResult":{}}}`, which is how GraphQL says not found. |

A request with a made-up guest token was answered normally (HTTP 200) on 2026-11-19, so there is no recorded refusal to test a token refresh against, and the provider does not implement one.
