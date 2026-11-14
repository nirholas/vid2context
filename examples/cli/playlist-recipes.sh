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
