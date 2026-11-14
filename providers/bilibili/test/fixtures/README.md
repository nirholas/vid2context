# Bilibili fixtures

Real responses recorded from this repo's VM (a US datacenter IP) on 2026-11-14 with Node's `fetch`, sending a browser User-Agent and `Referer: https://www.bilibili.com/` and no cookie. Tests replay them through `replayFetch` (`@vid2context/core/testing`), so unit tests never touch the network. JSON API files hold the response body as returned, minus the trimming below.

| File | Request |
|---|---|
| `nav.json` | `GET /x/web-interface/nav` (logged out: code -101, still carries `wbi_img`; these keys give the documented mixin key `ea1db124af3c7062474693fa704f4ff8`) |
| `view-BV1Sx411S71m.json` | `GET /x/web-interface/view?bvid=BV1Sx411S71m`: "【德语CC字幕】Kurzgesagt德语科普【38P合集】" by Deutschlernen-, 38 parts, a repost (copyright 2) with German creator subtitles |
| `view-BV1xx411c79H.json` | Same for av706, "【東方】Bad Apple!! ＰＶ【影絵】", one part, no subtitles |
| `view-BV1GPWi6SECk.json` | Same for "在这里，万亿吨水被强行灌进火山……【地理志】" by 芳斯塔芙, one part, AI subtitles only |
| `view-not-found.json` | Same for BV1GJ411x7h7 (deleted): code -404 |
| `view-invisible.json` | Same for BV1Tv411T7uh: code 62002 (hidden) |
| `tags-<bvid>.json` | `GET /x/tag/archive/tags?bvid=<bvid>` for the three videos |
| `dmview-139538988.json`, `dmview-139551808.json` | `GET /x/v2/dm/view?type=1&oid=<cid>&pid=9775917`: parts 1 and 2 of BV1Sx411S71m, one `de-DE` subtitle each (type 0) |
| `dmview-3724723.json` | Same for av706: `subtitles: null` |
| `dmview-43572004328.json` | Same for BV1GPWi6SECk: one `ai-zh` subtitle (type 1) |
| `player-<bvid>-<cid>.json` | `GET /x/player/wbi/v2?bvid=&cid=` with a WBI signature: `need_login_subtitle: true`, empty subtitle list, no chapters (`view_points`) |
| `subtitle-33b93711....json`, `subtitle-a74dab83....json` | The two `de-DE` subtitle bodies from `aisubtitle.hdslb.com/bfs/subtitle/` |
| `subtitle-ai-11760883....json` | The `ai-zh` body from `aisubtitle.hdslb.com/bfs/ai_subtitle/prod/` |
| `playurl-BV1xx411c79H-3724723.json` | `GET /x/player/wbi/playurl?bvid=BV1xx411c79H&cid=3724723&fnval=16` with a WBI signature: DASH video and two audio streams |
| `audio-30232-head.json`, `audio-30232-head.m4s` | `GET` of audio stream 30232 (the lower-bandwidth one) with the Referer and `Range: bytes=0-4095`: status, headers (total size 1,814,810 bytes) and the 4,096 bytes returned (the fMP4 init segment) |
| `b23-BV1xx411c79H.json` | `HEAD https://b23.tv/BV1xx411c79H` without following redirects: 302 to `https://www.bilibili.com/video/BV1xx411c79H` |

Trimming, so nothing personal or IP-bound lands in this public repo:

- Media URLs in `playurl-*.json` and `audio-30232-head.json` lose their query strings (they carry `oi=`, the requesting IP as an integer, plus signatures and expiry times).
- Subtitle URLs in `dmview-*.json` lose their `auth_key` query string; subtitle authors keep only `mid` and `name` (the uploader's public profile).
- `player-*.json` keeps only `aid`, `bvid`, `cid`, `page_no`, `need_login_subtitle`, `subtitle` and `view_points` (the full response has `ip_info` with the requesting IP and location).
- `view-*.json` drops `ugc_season` (a 100 KB season listing), `user_garb` and `honor_reply`.
- Subtitle bodies keep their first 12 lines.
- The `.m4s` file is the first 4 KB of the stream (container headers, no meaningful audio); it was grepped for the requesting IP.

How the "Referer required" claim was checked on 2026-11-14: the same audio URL on `upos-sz-mirrorcosov.bilivideo.com` answered 403 without the Referer and 206 with it (the Akamai mirror answered 206 either way).

To re-record, run the same requests (see `src/api.ts`), apply the same trimming, and grep the results for your public IP before committing.
