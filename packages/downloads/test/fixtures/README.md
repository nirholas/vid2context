# Download fixtures

Recorded on 2026-11-14 with the official yt-dlp 2026.10.26 `yt-dlp_linux` binary (SHA-256 verified, managed in `.vid2context/bin/`) using the Node JS runtime, from a GCP VM.

| File | Command | Notes |
|---|---|---|
| `info-youtube-aqz-KE-bpKQ.json` | `yt-dlp -J --no-download --no-playlist --no-warnings -- https://www.youtube.com/watch?v=aqz-KE-bpKQ` | Big Buck Bunny 60fps 4K (Blender Foundation, CC BY 3.0): 61 formats from 144p to 2160p60, plus 5.1 AAC, AC-3 and E-AC-3 audio and DRC variants |
| `info-youtube-jNQXAC9IVRw.json` | same, `https://www.youtube.com/watch?v=jNQXAC9IVRw` | "Me at the zoo": 25 formats up to 240p, 3 chapters, creator subtitles en and de |
| `picks-youtube.tsv` | `yt-dlp --load-info-json <full info> --print format_id --simulate -f 'bv*+ba/b' -S '<sort>'` (and `-f 'ba/b'` for audio) for every container and quality, with the `-S` values `formatChoice` builds | yt-dlp's own stream choices, which `pickVideo` and `pickAudio` must match |
| `progress-bbb-144p-mp4.stdout.txt`, `.stderr.txt` | the argv `downloadArgs` builds for `{ url: <Big Buck Bunny>, format: 'mp4', quality: '144' }`, run through the provider's `run()` with stdout and stderr lines captured | a real two-stream download (160 + 140), its plan line, 27 progress lines, and the postprocessor steps on stderr |

Sanitizing:

- `info-*.json` keep only the fields this package reads. On each format: `format_id`, `ext`, `vcodec`, `acodec`, `width`, `height`, `fps`, `tbr`, `abr`, `vbr`, `asr`, `audio_channels`, `filesize`, `filesize_approx`, `protocol`, `format_note`, `dynamic_range`, `has_drm`, `quality`. At the top level: `id`, `title`, `fulltitle`, `duration`, `uploader`, `channel`, `thumbnail`, `webpage_url`, `extractor_key`, `is_live`, `live_status`, `chapters`, `_type`, and `subtitles` and `automatic_captions` reduced to `{ ext, name }`. Every stream URL is gone, and those embed the recording machine's IP. A check that no `googlevideo` host or `ip=` parameter remains ran before saving.
- In `progress-*.stdout.txt`, the recording's temp directory in the `v2c:file:` line was replaced with `/tmp/vid2context-dl-Xq3c9Z/a0/`, because it contained the local user name. Nothing else was changed.
