# Skips fixtures

Real responses recorded on 2026-11-14 (about 17:00 UTC) from the public SponsorBlock API, `https://sponsor.ajay.app`, with curl. No personal data: SponsorBlock responses hold only video ids, times, votes and segment UUIDs. Segment data: SponsorBlock (sponsor.ajay.app), CC BY-NC-SA 4.0.

Each prefix response was requested with every category (`sponsor, selfpromo, interaction, intro, outro, preview, hook, filler, music_offtopic, poi_highlight, exclusive_access, chapter`) and every action type (`skip, mute, full, poi, chapter`), so tests can check the client-side category filter against the full data.

| File | Request | Response |
|---|---|---|
| `skipSegments-9007.json` | `GET /api/skipSegments/9007?categories=[all 12]&actionTypes=[all 5]` | 200, 135 videos sharing prefix `9007`, among them `CrO0Timw2z4` (Linus Tech Tips, "I Let My Staff Upgrade the Office (They Almost Ruined It)", sponsored by LiberNovo and Nanoleaf): sponsor, selfpromo, preview, hook, intro and outro spans, an overlap between a 0-vote preview and a 2-vote sponsor, and a whole-video `sponsor` / `full` label |
| `skipSegments-2d69.json` | `GET /api/skipSegments/2d69?categories=[all 12]&actionTypes=[all 5]` | 200, the prefix of `cCPsdFdlshc` (the shared G-Wagon fixture video), which is not in it: no segments. Also used for real edge cases of other videos in the same response: `CFtW7MT1-Cg` (negative votes), `pGC51aAUHHc` (highlight point), `L89LAfYNwl8` (two overlapping `mute` spans, one locked), `7qeGWkS0Kn8` (community chapters) |
| `skipSegments-9007-exclusive_access-404.json` | `GET /api/skipSegments/9007?categories=["exclusive_access"]&actionTypes=[all 5]` | 404, `content-type: application/json; charset=utf-8`, body `[]`: no video with this prefix has that label |
| `context-youtube-CrO0Timw2z4.json` | `npm run cli -- https://www.youtube.com/watch?v=CrO0Timw2z4 --format json --mode captions` | The real `VideoContext`: 601 auto-caption lines (en), 1077 s. The description has only the channel's public sponsor and store links. |

The 5xx test answers with status 503 and an empty body: SponsorBlock returned no 5xx while recording, and the body is not read for the mapping. The network-failure test uses `replayFetch([])`, which rejects like an unreachable host.

To re-record a prefix response (the prefix is `printf %s <videoId> | sha256sum | cut -c1-4`):

```sh
C='["sponsor","selfpromo","interaction","intro","outro","preview","hook","filler","music_offtopic","poi_highlight","exclusive_access","chapter"]'
A='["skip","mute","full","poi","chapter"]'
curl -sG "https://sponsor.ajay.app/api/skipSegments/9007" --data-urlencode "categories=$C" --data-urlencode "actionTypes=$A" > skipSegments-9007.json
```

Votes change over time; re-recording may change the counts the tests assert.
