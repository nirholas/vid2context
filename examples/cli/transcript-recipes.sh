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
