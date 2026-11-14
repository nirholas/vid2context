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
