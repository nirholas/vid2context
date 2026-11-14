# yt-dlp: any video site

The `providers/ytdlp` package (`@vid2context/provider-ytdlp`, Node only) uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) to make "any video" work: Vimeo, TikTok, X, Instagram, Reddit, Twitch VODs, Loom, Rumble, TED, news sites with embedded players and more than a thousand other sites. It is also where YouTube audio comes from when a video has no captions, so speech-to-text can transcribe it.

It needs no key. yt-dlp runs on your machine.

## What it provides

| Provider id | Kind | What |
|---|---|---|
| `ytdlp` | source, catch-all | any http(s) URL no specific provider claims: metadata, chapters, playlist and channel items, comments, and audio for speech-to-text. Also supplies audio for YouTube refs. |
| `ytdlp-captions` | captions | creator subtitles and the site's automatic captions for any http(s) video; for YouTube it runs after `youtube-captions`, as a fallback |

Specific providers always win: a YouTube URL resolves to the `youtube` provider, a local file to `media-file`. yt-dlp is tried last.

Refs: a YouTube URL gets the same ref as the YouTube provider (`youtube:<id>`), so the cache is shared. Any other URL gets `<platform>:<hash>`, where `platform` comes from the host (`vimeo`, `tiktok`, `twitter`, `reddit`, ..., else `web`) and `hash` is part of the SHA-256 of the canonical URL (lowercased host without `www.`, no fragment, tracking parameters such as `utm_*`, `si` and `fbclid` dropped, the rest sorted). The ref stays URL-based even after metadata reveals the site's own id, because the cache lookup happens before that; the site id is in `metadata.extra.extractorId` and the extractor in `metadata.extra.extractor`.

Audio is extracted as 16 kHz mono mp3 at 32 kbps: about 14 MB per hour, under Groq's 25 MB upload limit for about 1.7 hours. Longer audio is split by the long-audio orchestrator before speech-to-text.

## The binary

vid2context finds yt-dlp in this order:

1. `YTDLP_PATH`
2. `yt-dlp` on `PATH`
3. a managed copy in `.vid2context/bin/yt-dlp` (or `$VID2CONTEXT_HOME/bin/yt-dlp`)

When none exists, the first request installs the managed copy: it downloads the official release asset for your platform (`yt-dlp_linux`, `yt-dlp_linux_aarch64`, `yt-dlp_macos`, `yt-dlp.exe`, `yt-dlp_arm64.exe`) from GitHub, checks its SHA-256 against the release's `SHA2-256SUMS`, writes it to a temp file, renames it into place and records the version in `.vid2context/bin/yt-dlp.json`. A lock file (`.vid2context/locks/ytdlp`) makes parallel processes wait instead of downloading twice; a lock older than 10 minutes, or one held by a process that is gone, is taken over.

Install ahead of time and see what will be used:

```sh
npx tsx providers/ytdlp/src/setup.ts
```

It prints `{ path, version, managed, jsRuntime, ffmpeg }` as JSON. The same object comes from `ensureYtDlp(ctx)`, which the CLI's `doctor` uses.

Updates: the managed copy checks for a new release at most once a week (the tag behind `releases/latest`, or the GitHub API), then downloads and verifies the new one the same way. A failed check keeps the installed version. `YTDLP_AUTO_UPDATE=0` turns this off. A binary you supplied (`YTDLP_PATH` or `PATH`) is never updated by vid2context. To force a check, delete `.vid2context/bin/yt-dlp.json`.

Platforms without a standalone release binary (for example FreeBSD or 32-bit ARM Linux) need yt-dlp installed with pip and on `PATH`.

## JavaScript runtime

yt-dlp needs a JavaScript runtime for YouTube. When `deno` is on `PATH`, yt-dlp uses it by default. Otherwise vid2context passes `--js-runtimes node:<path>` (Node is always present). `ensureYtDlp` reports which one is used.

## ffmpeg

Audio extraction needs ffmpeg. vid2context passes `--ffmpeg-location` with the first one it finds: `FFMPEG_PATH`, `ffmpeg` on `PATH`, `~/.local/bin/ffmpeg`, then a managed copy in `.vid2context/bin/ffmpeg`. Without ffmpeg, metadata and captions still work and audio fails with a `no-provider` error that says how to install it. With ffmpeg, subtitles in other text formats are converted to WebVTT.

## Cookies

Some sites want a signed-in session (age-restricted videos, members-only content, some Vimeo pages from datacenter IPs).

- `YTDLP_COOKIES_FROM_BROWSER=firefox` (or `chrome`, `edge`, ...) reads cookies from a local browser profile.
- `YTDLP_COOKIES_FILE=/path/to/cookies.txt` uses a Netscape-format cookies file.

vid2context never logs cookie values or file contents.

Vimeo: `vimeo.com/<id>` pages now ask for a login from many IPs, while the embed player URL for the same id works without one. When no cookies are configured and Vimeo answers that way, vid2context retries once with `https://player.vimeo.com/video/<id>`.

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `YTDLP_PATH` | unset | use this yt-dlp binary; never updated |
| `YTDLP_AUTO_UPDATE` | `1` | `0` turns off the weekly update check of the managed copy |
| `YTDLP_TIMEOUT_SEC` | per step | one timeout for every yt-dlp run. Unset: 60 s metadata, 120 s playlists and subtitles, 300 s audio and comments |
| `YTDLP_CONCURRENCY` | `2` | most yt-dlp processes at once per Node process |
| `YTDLP_COOKIES_FILE` | unset | `--cookies` file |
| `YTDLP_COOKIES_FROM_BROWSER` | unset | `--cookies-from-browser` value |
| `FFMPEG_PATH` | unset | ffmpeg binary for audio extraction |
| `VID2CONTEXT_HOME` | `./.vid2context` | where `bin/` and `locks/` live |

## Errors

| Code | When | What to do |
|---|---|---|
| `blocked` | "Sign in to confirm you're not a bot" | run on a home connection or behind a Cloudflare Tunnel to one, or pass cookies |
| `not-found` | "Video unavailable", "This video has been removed", HTTP 404 | check the URL |
| `unavailable` | "Private video", "Requested format is not available", DRM, geo restriction | pass cookies for private videos you can see; update yt-dlp; DRM is not supported |
| `unsupported-input` | "Unsupported URL", a non-http(s) input, an input starting with `-` | pass a page from a supported site or a direct media URL |
| `rate-limited` | HTTP 429 | wait and retry, or pass cookies |
| `auth` | the site wants a login | pass cookies |
| `no-provider` | ffmpeg missing, or yt-dlp missing and not installable | install ffmpeg or set `FFMPEG_PATH`; install yt-dlp or set `YTDLP_PATH` |
| `timeout` | a run took longer than its timeout | raise `YTDLP_TIMEOUT_SEC` |
| `upstream` | any other yt-dlp failure | update yt-dlp or retry later |

## Safety

yt-dlp is spawned with an argument array, never a shell. Every command ends with `--` and the URL, and inputs that are not http(s) URLs or start with `-` are rejected before spawning. Each run has a timeout, an abort kills the whole process tree, and stderr is captured with a size bound.

## Out of scope: DRM

DRM-protected services (Netflix, Spotify, Disney+, Prime Video and similar) are not supported, and yt-dlp does not download them. Such URLs fail with `unavailable` and a hint saying so.
