# packages/ffmpeg test fixtures

Real media and real recorded data only. Every media file here is derived from one public-domain NASA clip and is under 1 MB.

## Source clip

[Apollo 11 Landing - first steps on the moon.ogv](https://commons.wikimedia.org/wiki/File:Apollo_11_Landing_-_first_steps_on_the_moon.ogv) on Wikimedia Commons: NASA footage, public domain. 61.5 s, Theora 320x240 with mono Vorbis audio, 4,568,753 bytes. Downloaded 2026-11-14.

Its English subtitles come from the Commons page [TimedText:Apollo 11 Landing - first steps on the moon.ogv.en.srt](https://commons.wikimedia.org/wiki/TimedText:Apollo_11_Landing_-_first_steps_on_the_moon.ogv.en.srt), fetched with `action=raw` on 2026-11-14. The words are Neil Armstrong's (NASA, public domain); the timing file is a Commons contribution, available under CC BY-SA 4.0 (Wikimedia Commons contributors).

All commands below used ffmpeg 7.0.2-static (johnvansickle.com build).

| File | What | How it was made |
|---|---|---|
| `apollo11-first-steps.mp4` | H.264 160x120 (no B-frames) + AAC mono 22.05 kHz, title/artist/date tags, 518,036 bytes | `ffmpeg -i apollo.ogv -vf scale=160:120 -c:v libx264 -preset veryslow -bf 0 -b:v 40k -pix_fmt yuv420p -c:a aac -ac 1 -ar 22050 -b:a 24k -map_metadata -1 -metadata title="Apollo 11 Landing - first steps on the moon" -metadata artist=NASA -metadata date=1969 -movflags +faststart apollo11-first-steps.mp4` |
| `apollo11-first-steps.en.srt` | the Commons subtitle file, unchanged (multi-line cues, trailing spaces, no final newline) | `curl 'https://commons.wikimedia.org/w/index.php?title=TimedText:Apollo%2011%20Landing%20-%20first%20steps%20on%20the%20moon.ogv.en.srt&action=raw'` |
| `apollo11-first-steps-subs.mkv` | Matroska with H.264, Opus and the SRT as an embedded `subrip` stream tagged `eng`, 555,246 bytes | `ffmpeg -i apollo.ogv -i apollo11-first-steps.en.srt -map 0:v -map 0:a -map 1 -vf scale=160:120 -c:v libx264 -preset veryslow -bf 0 -b:v 40k -pix_fmt yuv420p -c:a libopus -b:a 24k -ac 1 -c:s srt -map_metadata -1 -metadata title="Apollo 11 Landing - first steps on the moon" -metadata:s:a:0 language=eng -metadata:s:s:0 language=eng apollo11-first-steps-subs.mkv` (muxed from the original clip, not from the mp4, so the AAC priming delay does not shift the cue times) |
| `apollo11-first-steps-chapters.m4a` | AAC mono audio with four container chapters and tags, 254,646 bytes | `ffmpeg -i apollo.ogv -i apollo11-first-steps-chapters.ffmeta -map 0:a -map_metadata 1 -map_chapters 1 -c:a aac -ac 1 -ar 22050 -b:a 32k -metadata:s:a:0 language=eng apollo11-first-steps-chapters.m4a` |
| `apollo11-first-steps-chapters.ffmeta` | the FFMETADATA file used above. Chapter starts are the start times of the SRT cues where each part begins (0, 3.26, 36.746, 47.772 s) | written by hand from the SRT cue times |

## Recorded data

| File | Source |
|---|---|
| `btbn-checksums.sha256` | `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/checksums.sha256`, fetched 2026-11-14. Real checksum list of the BtbN static builds that the managed download verifies against. |
