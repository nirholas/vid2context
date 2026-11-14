# CLI fixtures

Real outputs captured on this repo's VM on 2026-11-14. The tests also replay the YouTube and speech-to-text recordings in `providers/youtube/test/fixtures/` and `providers/stt-openai-compatible/test/fixtures/`.

| File | Source |
|---|---|
| `ffmpeg-version.txt` | stdout of `ffmpeg -version` for the static build in `~/.local/bin` (7.0.2-static, johnvansickle.com) |
| `ffprobe-version.txt` | stdout of `ffprobe -version` from the same build |
| `ytdlp-version.txt` | stdout of `yt-dlp --version` for the managed copy in `.vid2context/bin/` |
| `ovh-models.json` | `GET https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models` without a key (the keyless reachability probe in `doctor`), 21 models |
| `playlist-gwagon.json` | Every request `vid2context list https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b --limit 3` made (one innertube `browse` call, WEB client, no key or cookie), recorded by `LIVE=1 npx tsx packages/cli/test/record-fixtures.ts` |

Trimming in `playlist-gwagon.json`, applied by the recording script: the request body keeps no `context` block; the response drops top-level `responseContext` (visitor id), `topbar`, `frameworkUpdates`, `trackingParams` and `sidebar`, and everywhere drops IP-bearing `watchEndpointSupportedOnesieConfig`, tracking and logging fields, menus, thumbnail overlays, thumbnails, avatars, badges and accessibility labels. Email addresses and phone numbers in strings are replaced with `[email redacted]` and `[phone redacted]`. The script refuses to write the file when it still contains the recording machine's public IP address.

No `nvidia-smi` or `deno --version` output is stored: this VM has no NVIDIA GPU and no deno, so those checks are tested only for their missing-tool paths, and live through `doctor`.
