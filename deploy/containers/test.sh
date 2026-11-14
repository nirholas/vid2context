#!/usr/bin/env bash
# Checks for the vid2context container image and deploy configs. Run from
# anywhere; paths resolve from this script.
#
#   deploy/containers/test.sh                    lint configs, build, run checks
#   deploy/containers/test.sh --whisper          build with WITH_WHISPER=1
#   deploy/containers/test.sh --image vid2context:dev   skip the build, test a tag
#   deploy/containers/test.sh --context DIR      build from another checkout
#   deploy/containers/test.sh --lint-only        configs only, no image
#   LIVE=1 deploy/containers/test.sh             also a real YouTube transcript and
#                                                a speech-to-text run on the Apollo clip
#
# Needs Docker. hadolint, yq and the Railway schema check run through
# containers or are skipped with a note when they cannot.
# pass() only prints, so `cmd && pass ... || fail ...` never runs both.
# shellcheck disable=SC2015
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
context="$repo"
image=""
whisper=0
lint_only=0
while [ $# -gt 0 ]; do
  case "$1" in
    --whisper) whisper=1 ;;
    --image) image="$2"; shift ;;
    --context) context="$(cd "$2" && pwd)"; shift ;;
    --lint-only) lint_only=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

failures=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; failures=$((failures + 1)); }
skip() { printf 'SKIP  %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

containers=()
volumes=()
# shellcheck disable=SC2329 # called by the EXIT trap below
cleanup() {
  for c in "${containers[@]}"; do docker rm -f "$c" >/dev/null 2>&1; done
  for v in "${volumes[@]}"; do docker volume rm "$v" >/dev/null 2>&1; done
}
trap cleanup EXIT

if ! have docker || ! docker info >/dev/null 2>&1; then
  echo "Docker is not available: nothing can be built or run here." >&2
  exit 1
fi

# ------------------------------------------------------------ configs

if have hadolint; then
  hadolint "$here/Dockerfile" && pass "hadolint Dockerfile" || fail "hadolint Dockerfile"
elif docker run --rm -i hadolint/hadolint:v2.14.0 hadolint - < "$here/Dockerfile"; then
  pass "hadolint Dockerfile (container)"
else
  fail "hadolint Dockerfile"
fi

if "$here/railway/gen-dockerfile.sh" --check; then
  pass "railway/Dockerfile matches gen-dockerfile.sh output"
else
  fail "railway/Dockerfile is stale: run deploy/containers/railway/gen-dockerfile.sh"
fi

if docker compose -f "$here/compose.yaml" --profile postgres --profile stt --profile ollama config --quiet; then
  pass "docker compose config (all profiles)"
else
  fail "docker compose config"
fi

yaml_ok() {
  if have python3 && python3 -c 'import yaml' 2>/dev/null; then
    python3 -c 'import sys, yaml; list(yaml.safe_load_all(open(sys.argv[1])))' "$1"
  else
    docker run --rm -i mikefarah/yq:4 eval '.' - < "$1" >/dev/null
  fi
}
for f in cloud-run/service.yaml cloud-run/cloudbuild.yaml alibaba/s.yaml; do
  yaml_ok "$here/$f" && pass "YAML parses: $f" || fail "YAML parses: $f"
done

# The Railway schema check needs the network; skip quietly offline.
schema="$(mktemp)"
if curl -fsSL --max-time 15 https://backboard.railway.app/railway.schema.json -o "$schema" 2>/dev/null; then
  if node "$here/validate-json.mjs" "$schema" "$here/railway/railway.json"; then
    pass "railway.json matches Railway's published schema"
  else
    fail "railway.json schema"
  fi
else
  skip "railway.json schema (could not download it)"
fi

# Alibaba: resolve the Serverless Devs variables (env defaults, vars.*) and
# check the fc3 props against the component's published schema.
props="$(mktemp)"
if ! { have python3 && python3 -c 'import yaml' 2>/dev/null; }; then
  skip "alibaba/s.yaml fc3 schema (needs python3 with PyYAML)"
elif ! curl -fsSL --max-time 15 https://raw.githubusercontent.com/devsapp/fc3/master/src/schema.json -o "$schema" 2>/dev/null; then
  skip "alibaba/s.yaml fc3 schema (could not download it)"
else
  python3 - "$here/alibaba/s.yaml" > "$props" <<'PY'
import json, re, sys, yaml
doc = yaml.safe_load(open(sys.argv[1]))
def resolve(v):
    if isinstance(v, dict):
        return {k: resolve(x) for k, x in v.items()}
    if isinstance(v, list):
        return [resolve(x) for x in v]
    if not isinstance(v, str):
        return v
    v = re.sub(r"\$\{env\('(\w+)'(?:, '([^']*)')?\)\}", lambda m: m.group(2) if m.group(2) is not None else 'set-from-env', v)
    return re.sub(r"\$\{vars\.(\w+)\}", lambda m: resolve(doc['vars'][m.group(1)]), v)
print(json.dumps(resolve(doc['resources']['vid2context']['props'])))
PY
  if node "$here/validate-json.mjs" "$schema" "$props"; then
    pass "alibaba/s.yaml matches the fc3 component schema"
  else
    fail "alibaba/s.yaml fc3 schema"
  fi
fi
rm -f "$schema" "$props"

if [ "$lint_only" = 1 ]; then
  echo
  [ "$failures" = 0 ] && echo "All config checks passed." || echo "$failures check(s) failed."
  exit $((failures > 0))
fi

# ------------------------------------------------------------ build

if [ -z "$image" ]; then
  image="vid2context:test"
  [ "$whisper" = 1 ] && image="vid2context:test-whisper"
  if docker build -f "$here/Dockerfile" --build-arg "WITH_WHISPER=$whisper" -t "$image" "$context"; then
    pass "docker build ($image)"
  else
    fail "docker build"
    exit 1
  fi
fi
size_mb="$(docker image inspect "$image" --format '{{.Size}}' | awk '{printf "%.0f", $1 / 1000000}')"
echo "INFO  image $image is ${size_mb} MB uncompressed"

# ------------------------------------------------------------ run

port=$((20000 + RANDOM % 10000))
name="v2c-test-$port"
vol="v2c-test-data-$port"
containers+=("$name")
volumes+=("$vol")
docker run -d --name "$name" --read-only --tmpfs /tmp -v "$vol:/data" \
  -p "127.0.0.1:$port:8787" "$image" >/dev/null || { fail "docker run"; exit 1; }

wait_health() {
  for _ in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:$1/api/v1/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}
if wait_health "$port"; then
  pass "GET /api/v1/health on port $port (read-only root, tmpfs /tmp)"
else
  fail "health did not answer within 60 s"
  docker logs "$name" 2>&1 | tail -20
  exit 1
fi

docker exec "$name" node /usr/local/lib/vid2context/healthcheck.mjs && pass "HEALTHCHECK command" || fail "HEALTHCHECK command"

uid="$(docker exec "$name" id -u)"
[ "$uid" != 0 ] && pass "runs as non-root (uid $uid)" || fail "runs as root"

if docker exec "$name" sh -c 'touch /app/.write-test' 2>/dev/null; then
  fail "root filesystem is writable under --read-only"
else
  pass "root filesystem is read-only"
fi
docker exec "$name" sh -c 'touch /data/.write-test && rm /data/.write-test' && pass "/data is writable" || fail "/data is not writable"

docker exec "$name" sh -c 'yt-dlp --version && deno --version | head -n1 && ffmpeg -hide_banner -version | head -n1 && ffprobe -hide_banner -version | head -n1' \
  && pass "yt-dlp, deno, ffmpeg and ffprobe run (noexec /tmp)" || fail "a bundled tool does not run"

if [ "$whisper" = 1 ] || docker exec "$name" sh -c 'command -v whisper-cli' >/dev/null 2>&1; then
  docker exec "$name" sh -c 'whisper-cli --help >/dev/null 2>&1 && cat /opt/whisper.cpp/build.json' \
    && pass "whisper-cli runs" || fail "whisper-cli does not run"
fi

# ------------------------------------------------------------ live

if [ -z "${LIVE:-}" ]; then
  skip "live checks (set LIVE=1)"
else
  out="$(mktemp)"
  code="$(curl -sS -o "$out" -w '%{http_code}' --max-time 300 \
    "http://127.0.0.1:$port/api/v1/transcript?url=https://youtu.be/jNQXAC9IVRw")"
  if [ "$code" = 200 ] && [ -s "$out" ]; then
    pass "LIVE transcript of jNQXAC9IVRw: $(head -c 120 "$out" | tr '\n' ' ')"
  else
    fail "LIVE transcript of jNQXAC9IVRw: HTTP $code (YouTube blocks many datacenter IPs; see docs/deploy/docker.md)"
    head -c 1500 "$out"; echo
  fi

  # Speech-to-text on the public-domain Apollo 11 clip, mounted read-only.
  # VID2CONTEXT_PUBLIC=0 allows local file inputs for this one container.
  clip="$repo/tests/fixtures/media/apollo11-small-step.mp3"
  if [ -f "$clip" ]; then
    port2=$((20000 + RANDOM % 10000))
    name2="v2c-test-stt-$port2"
    containers+=("$name2")
    docker run -d --name "$name2" --read-only --tmpfs /tmp -e VID2CONTEXT_PUBLIC=0 \
      -v "$clip:/media/apollo11-small-step.mp3:ro" -p "127.0.0.1:$port2:8787" "$image" >/dev/null
    if wait_health "$port2"; then
      code="$(curl -sS -o "$out" -w '%{http_code}' --max-time 300 \
        "http://127.0.0.1:$port2/api/v1/transcript?mode=stt&url=/media/apollo11-small-step.mp3")"
      if [ "$code" = 200 ] && grep -qi "small step" "$out"; then
        pass "LIVE speech-to-text on the Apollo clip: $(head -c 120 "$out" | tr '\n' ' ')"
      else
        fail "LIVE speech-to-text on the Apollo clip: HTTP $code"
        head -c 1500 "$out"; echo
      fi
    else
      fail "speech-to-text container did not become healthy"
    fi
  else
    skip "Apollo clip not found at $clip"
  fi
  rm -f "$out"
fi

echo
if [ "$failures" = 0 ]; then echo "All checks passed."; else echo "$failures check(s) failed."; fi
exit $((failures > 0))
