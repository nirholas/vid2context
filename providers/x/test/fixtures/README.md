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
