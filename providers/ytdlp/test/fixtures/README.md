# yt-dlp fixtures

All recorded on 2026-11-14 from a GCP VM with the official yt-dlp 2026.10.26 `yt-dlp_linux` release binary (SHA-256 verified against the release's SHA2-256SUMS), using the Node JS runtime (`--js-runtimes node`).

`info-*.json` and `flat-playlist-youtube.json` were passed through a sanitizer that deletes stream and per-request fields (`formats`, `requested_formats`, `requested_downloads`, `requested_subtitles`, `url` on non-entry objects, `manifest_url`, `fragments`, `http_headers`, `format*`, `ext`, `protocol`, `heatmap`, `__x_forwarded_for_ip`) and reduces each subtitle track entry to `{ ext, name }`. Stream URLs embed the recording machine's IP; after sanitizing, no file contains it. Nothing else was changed.

| File | Command | Notes |
|---|---|---|
| `info-youtube-jNQXAC9IVRw.json` | `yt-dlp -J --no-download --no-playlist --no-warnings -- https://www.youtube.com/watch?v=jNQXAC9IVRw` | "Me at the zoo": creator subtitles en and de, automatic captions, 3 chapters |
| `info-vimeo-76979871.json` | same, `https://player.vimeo.com/video/76979871` | "The New Vimeo Player": creator subtitles es, en, fr, de. The `vimeo.com/76979871` page itself answered with `stderr-vimeo-login.txt` from this IP |
| `info-ted-66.json` | same, `https://www.ted.com/talks/ken_robinson_do_schools_kill_creativity` | TED talk metadata with many subtitle languages, `upload_date` only (no `timestamp`) |
| `flat-playlist-youtube.json` | `yt-dlp --flat-playlist -J --playlist-end 5 --no-warnings -- "https://www.youtube.com/playlist?list=PLzMcBGfZo4-lwGZWXz5Qgta_YNX3_vLS2"` | five flat entries |
| `comments-youtube-jNQXAC9IVRw.json` | `yt-dlp -J --no-download --no-playlist --no-warnings --write-comments --extractor-args "youtube:max_comments=6,all,2,2;comment_sort=top" -- https://www.youtube.com/watch?v=jNQXAC9IVRw` | only `id`, `extractor_key`, `comment_count` and `comments` kept. `author_thumbnail` removed from every comment; `author`, `author_id` and `author_url` removed for commenters who are neither verified nor the uploader (private individuals). Comment text unchanged |
| `subs-vimeo-76979871.en.vtt` | `yt-dlp --skip-download --write-subs --sub-langs en --sub-format vtt/srv3/best -o '%(id)s.%(ext)s' -- https://player.vimeo.com/video/76979871` | creator WebVTT with `<i>` tags and multi-line cues |
| `stderr-unsupported-url.txt` | `yt-dlp -J --no-download --no-warnings -- https://example.com/` | stderr, exit 1 |
| `stderr-video-unavailable.txt` | `yt-dlp -J --no-download --no-warnings -- https://www.youtube.com/watch?v=aaaaaaaaaaa` | stderr, exit 1 |
| `stderr-subtitles-429.txt` | `yt-dlp --skip-download --write-auto-subs --sub-langs en --sub-format vtt -- https://www.youtube.com/watch?v=cCPsdFdlshc` | stderr: YouTube rate-limited subtitle downloads from this IP |
| `stderr-vimeo-login.txt` | `yt-dlp -J --no-download --no-playlist --no-warnings -- https://vimeo.com/76979871` | stderr: the vimeo.com page wants a login from this IP (the player URL works) |
| `SHA2-256SUMS-2026.10.26.txt` | `curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS` | release 2026.10.26 checksums, unchanged |
| `releases-latest-head.txt` | `curl -sI https://github.com/yt-dlp/yt-dlp/releases/latest`, status and `location` lines only | the redirect that reveals the latest tag |
| `stderr-outdated-youtube-no-formats.txt` | `yt-dlp -J --no-download --no-playlist --no-warnings -- https://www.youtube.com/watch?v=jNQXAC9IVRw` with the outdated official release 2023.03.04 (`yt-dlp_linux`), recorded 2026-11-15 | stderr, exit 1: "No video formats found!; please report this issue ... Confirm you are on the latest version using yt-dlp -U". Drives the self-update path |
| `stderr-outdated-vimeo-406.txt` | same binary, `https://vimeo.com/76979871`, recorded 2026-11-15 | stderr, exit 1: HTTP 406 from an old extractor, with the same "latest version" request |

Not recorded: an automatic-caption WebVTT with rolling duplicates. YouTube answered every subtitle download from this VM with HTTP 429 (`stderr-subtitles-429.txt`), so the rolling-cue collapsing in `src/vtt.ts` is covered only by the live test path, not by a fixture.
