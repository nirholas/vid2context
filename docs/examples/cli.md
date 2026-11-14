# CLI examples

Shell recipes for the `vid2context` command. Each script runs the CLI from your checkout through a small `v2c` function; with the npm package installed, `vid2context` works the same way. All of them are live and need no keys. The full command reference is in [the CLI guide](../cli.md).

Two rules make the CLI easy to script. stdout carries only program output (the transcript, the JSON, the list), and progress, notes and errors go to stderr, so pipes and `>` stay clean. `--out <file>` refuses to overwrite an existing file unless you pass `--force`.

## One video

Plain text, timestamps, SRT, JSON picked apart with `jq`, and Markdown written to a file.

<!-- example: examples/cli/transcript-recipes.sh -->
```bash
#!/usr/bin/env bash
# Everyday CLI recipes for one video: plain text, timestamps, captions,
# JSON picked apart with jq, and a file written with --out.
#
#   bash examples/cli/transcript-recipes.sh [url] [out-dir]
#
# Live, no keys needed. Needs jq. Runs the CLI from this checkout; with the
# npm package installed, `vid2context` works in place of `v2c`.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
v2c() { "$repo/node_modules/.bin/tsx" "$repo/packages/cli/src/bin.ts" "$@"; }

url="${1:-https://www.youtube.com/watch?v=jNQXAC9IVRw}"
outdir="${2:-$(mktemp -d)}"

echo "== Plain transcript (stdout carries only the transcript)"
v2c "$url" --quiet

echo "== With timestamps"
v2c "$url" --timestamps --quiet

echo "== The first SRT cue, for a video player or editor"
v2c "$url" --format srt --quiet | head -n 4

echo "== JSON: title, transcript origin and segment count, with jq"
v2c "$url" --format json --quiet | jq -r '"\(.metadata.title) | \(.transcript.origin) | \(.transcript.segments | length) segments"'

echo "== Segments that mention a word, with their start time in seconds"
v2c "$url" --format json --quiet | jq -r '.transcript.segments[] | select(.text | test("trunk"; "i")) | "\(.startSec)s  \(.text)"'

echo "== Markdown with linked timestamps into a file (refuses to overwrite without --force)"
v2c "$url" --format markdown --out "$outdir/transcript.md" --force --quiet
head -n 1 "$outdir/transcript.md"
echo "wrote $outdir/transcript.md"
```

Recorded run, no keys (`bash examples/cli/transcript-recipes.sh "" cli1`):

```text
== Plain transcript (stdout carries only the transcript)
All right, so here we are, in front of the elephants the cool thing about these guys is that they have really... really really long trunks and that's cool (baaaaaaaaaaahhh!!) and that's pretty much all there is to say
== With timestamps
[0:01] All right, so here we are, in front of the elephants
[0:05] the cool thing about these guys is that they have really...
[0:07] really really long trunks
[0:12] and that's cool
[0:14] (baaaaaaaaaaahhh!!)
[0:16] and that's pretty much all there is to say
== The first SRT cue, for a video player or editor
1
00:00:01,200 --> 00:00:03,360
All right, so here we are,
in front of the elephants
== JSON: title, transcript origin and segment count, with jq
Me at the zoo | creator-captions | 6 segments
== Segments that mention a word, with their start time in seconds
7.974s  really really long trunks
== Markdown with linked timestamps into a file (refuses to overwrite without --force)
# Me at the zoo
wrote cli1/transcript.md
```

Each command fetches the video again unless a persistent library is set up (SQLite, when that provider is installed). With one, `get` answers from the library and `--refresh` fetches again. `vid2context config` shows which backend is in use.

## A playlist

List the videos of a playlist, then build one context pack and one bundle from them. `pack` and `bundle` also take a playlist URL directly; listing first lets you pick or filter the videos.

<!-- example: examples/cli/playlist-recipes.sh -->
```bash
#!/usr/bin/env bash
# Many videos at once: list a playlist, build one context pack for a model,
# and write a .zip bundle an agent or a ChatGPT/Claude Project can read.
#
#   bash examples/cli/playlist-recipes.sh [playlist-url] [count] [out-dir]
#
# Live, no keys needed. Runs the CLI from this checkout; with the npm package
# installed, `vid2context` works in place of `v2c`.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
v2c() { "$repo/node_modules/.bin/tsx" "$repo/packages/cli/src/bin.ts" "$@"; }

playlist="${1:-https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b}"
count="${2:-2}"
outdir="${3:-$(mktemp -d)}"

echo "== The first $count videos of the playlist, one URL per line"
v2c list "$playlist" --limit "$count" --quiet | tee "$outdir/videos.txt"

echo "== One context pack from those videos, capped at 6000 tokens"
# xargs passes every URL as an argument; failed videos are reported and the rest still go in.
xargs "$repo/node_modules/.bin/tsx" "$repo/packages/cli/src/bin.ts" pack --max-tokens 6000 --quiet \
  --out "$outdir/pack.md" --force < "$outdir/videos.txt"
grep -m 1 '^This document' "$outdir/pack.md"
echo "wrote $outdir/pack.md ($(wc -c < "$outdir/pack.md") bytes)"

echo "== A bundle: every format per video, context.md, manifest and README"
xargs "$repo/node_modules/.bin/tsx" "$repo/packages/cli/src/bin.ts" bundle --out "$outdir/videos.zip" --force \
  < "$outdir/videos.txt"
```

Recorded run, no keys (`bash examples/cli/playlist-recipes.sh "" "" cli2`). The last line, which names the zip path, is left out:

```text
== The first 2 videos of the playlist, one URL per line
https://www.youtube.com/watch?v=PzJL3aBRas8
https://www.youtube.com/watch?v=1Xx1fmHIsiA
== One context pack from those videos, capped at 6000 tokens
This document holds the transcripts and metadata of 2 videos (26:43 in total), prepared by vid2context for an AI model to read. Each transcript paragraph starts with the time it begins in the video, in brackets; linked times open the video at that moment.
wrote cli2/pack.md (21516 bytes)
== A bundle: every format per video, context.md, manifest and README
20 files for 2 videos in vid2context-2-videos/
```

## A local file

Speech-to-text for an audio or video file, with `--verbose` showing which rung did the work. `vid2context models` lists every rung in the order they are tried on your machine.

<!-- example: examples/cli/local-file.sh -->
```bash
#!/usr/bin/env bash
# A local media file: transcribe it with speech-to-text, see which rung did
# the work, and save SRT captions next to it.
#
#   bash examples/cli/local-file.sh [file] [out-dir]
#
# Live, no keys needed: the audio goes to the first enabled speech-to-text
# rung (local server, then free keys, then the keyless Whisper host). Run
# `v2c models` to see the order on your machine. Default file: NASA's
# public-domain Apollo 11 recording, 24 seconds.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
v2c() { "$repo/node_modules/.bin/tsx" "$repo/packages/cli/src/bin.ts" "$@"; }

file="${1:-$repo/tests/fixtures/media/apollo11-small-step.mp3}"
outdir="${2:-$(mktemp -d)}"

echo "== Transcript with timestamps; --verbose prints every attempt to stderr"
v2c "$file" --timestamps --verbose 2> "$outdir/attempts.log"
grep -E '^\s+stt ' "$outdir/attempts.log" || true

echo "== SRT captions into a file"
v2c "$file" --format srt --out "$outdir/captions.srt" --force --quiet
cat "$outdir/captions.srt"
```

Recorded run, no keys:

```text
== Transcript with timestamps; --verbose prints every attempt to stderr
[0:03] I'm going to step off the limb now.
[0:14] That's one small step for man, one giant leap for mankind.
  stt      ok      stt/ovh/whisper-large-v3-turbo
== SRT captions into a file
1
00:00:03,500 --> 00:00:05,160
I'm going to step off the limb now.

2
00:00:14,980 --> 00:00:23,040
That's one small step for man,
one giant leap for mankind.
```

The attempts list written to stderr by `--verbose`:

```text
Attempts:
  resolve  ok      media-file  file:38010fa474cd134a25d80936cf1877b2
  metadata ok      media-file
  captions empty   media-file-captions  no-tracks
  audio    ok      media-file
  stt      ok      stt/ovh/whisper-large-v3-turbo
```
