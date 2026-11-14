#!/usr/bin/env bash
# The HTTP API with curl: health, a transcript, the outline of a long video,
# one section by time, a context pack, keyword search over the library, a
# cited answer, and what an error looks like.
#
#   npm run start:server                     # in another terminal
#   bash examples/http/curl.sh [base-url]
#
# Live, no keys needed. Needs curl and jq. Default base URL:
# http://127.0.0.1:8787. With API keys set on the server
# (VID2CONTEXT_API_KEYS), export VID2CONTEXT_API_KEY and it is sent as a
# bearer token.
set -euo pipefail

base="${1:-${VID2CONTEXT_URL:-http://127.0.0.1:8787}}/api/v1"
auth=()
if [ -n "${VID2CONTEXT_API_KEY:-}" ]; then auth=(-H "Authorization: Bearer $VID2CONTEXT_API_KEY"); fi
get() { curl -sS --fail-with-body "${auth[@]}" "$@"; }

zoo='https://www.youtube.com/watch?v=jNQXAC9IVRw'
gwagon='https://www.youtube.com/watch?v=cCPsdFdlshc'

echo "== GET /health"
get "$base/health" | jq -c '{ok, version, runtime, formats: [.formats[].id]}'

echo "== GET /transcript (text with timestamps)"
get -G "$base/transcript" --data-urlencode "url=$zoo" -d format=text -d timestamps=1

echo "== GET /outline (sections with token counts: read this first for long videos)"
get -G "$base/outline" --data-urlencode "url=$gwagon" |
  jq -r '"\(.metadata.title): \(.totalTokens) tokens", (.chapters[] | "  \(.title)  \(.tokens) tokens")'

echo "== GET /section (only 4:35 to 4:45)"
get -G "$base/section" --data-urlencode "url=$gwagon" -d from=4:35 -d to=4:45 -d timestamps=1

echo "== POST /pack (one Markdown document for a model, sized to a budget)"
get -X POST "$base/pack" -H 'Content-Type: application/json' \
  -d "{\"inputs\": [\"$zoo\", \"$gwagon\"], \"maxTokens\": 3000}" | head -n 3

echo "== GET /search (keyword side only; both videos are in the library now)"
get -G "$base/search" --data-urlencode 'q="compressor motor"' -d mode=keyword -d limit=2 |
  jq -r '.hits[] | "\(.title[0:40]) [\(.startSec | floor)s] \(.url)"'

echo "== POST /ask (an answer with verified [n] citations)"
get -X POST "$base/ask" -H 'Content-Type: application/json' \
  -d "{\"question\": \"What animal is in the video and what is special about it?\", \"inputs\": [\"$zoo\"], \"maxTokens\": 300}" |
  jq -r '.answer, (.citations[] | "  [\(.n)] \(.startSec)s \(.url)"), "answered by \(.rung)"'

echo "== An error: stable code, message and a hint on how to recover"
curl -sS "${auth[@]}" "$base/transcript" | jq -c .error
