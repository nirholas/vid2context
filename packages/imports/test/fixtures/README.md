# Import fixtures

Text copied from the "Show transcript" panel on real YouTube watch pages, recorded from this repo's VM on 2026-11-14 with Playwright (Chromium, `hl=en`, `gl=US`, not signed in): open the watch page, click "...more" under the title, click "Show transcript", select the whole transcript list in the panel and press Ctrl+C. Each file is the clipboard text exactly as copied, byte for byte; nothing was trimmed or rewritten.

| File | Video |
|---|---|
| `youtube-transcript-jNQXAC9IVRw.txt` | "Me at the zoo" (19 s, creator captions, 3 rows, 3 chapter headings). Its words match the creator track in `providers/youtube/test/fixtures/timedtext-jNQXAC9IVRw-en.srv3.xml` |
| `youtube-transcript-cCPsdFdlshc.txt` | "Best & Worst G-Wagon Years" (Alliance Motorworks, 18 min, auto-captions, 137 rows, 9 chapter headings) |
| `youtube-transcript-xAcTmDO6NTI.txt` | MIT OpenCourseWare 6.100L Lecture 1, "Introduction to CS and Programming Using Python" (1:03:30, creator captions, 545 rows, 33 chapter headings, two rows with no text). MIT OCW content is published under CC BY-NC-SA 4.0 |

What the 2026 panel copies: one line per row, with the timestamp, its spoken-length label and the text run together (`0:011 secondAll right, so here we are...`, `1:00:071 hour, 7 secondsI've just created this.`), and the chapter headings (`Chapter 2: The cool thing`) on lines of their own. The older panel layout (timestamp and text on separate lines) could not be recorded: YouTube served the new layout on every attempt.

Nothing personal is in these files: they are public transcripts of public videos, copied without signing in. The transcript panel loaded from the VM even while every `/api/timedtext` request, the player's own included, answered HTTP 429, so no json3 body could be recorded from the browser either.

To re-record, repeat the steps above in any browser and save the clipboard as UTF-8.

Other tests in this package read real fixtures from elsewhere in the repo (see the paths in `test/parse.test.ts` and `test/http.test.ts`): SRT and WebVTT files from `packages/ffmpeg`, `packages/core`, `providers/podcast` and `providers/native-transcripts`, and YouTube player, next and timedtext recordings from `providers/youtube/test/fixtures`.
