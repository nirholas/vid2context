"""Record real HTTP responses from a real vid2context server as test fixtures.

Starts packages/server on a random local port (20000 to 29999), calls it for
the videos and error cases the tests replay, writes one JSON file per call into
tests/fixtures/, then stops the server. Run from anywhere:

    uv run python scripts/record_fixtures.py [--minimal] [name ...]

With names (such as `context-cCPsdFdlshc`), only those fixtures are recorded.
A response with a different status than expected (YouTube rate-limits busy
machines with HTTP 429, which the server reports as `blocked`) is retried a
few times and then left unwritten, so a good fixture is never replaced by a
transient failure. `--minimal` serves the same packages/server app with only
the YouTube, media-file and speech-to-text providers (scripts/record_server.ts),
for when the full provider registry does not build. Needs Node 22+ and `npm install` at the repo root. Personal details (email
addresses, phone numbers) in video descriptions are replaced before writing,
as AGENTS.md requires for committed fixtures.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import random
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent
FIXTURES = HERE.parent / "tests" / "fixtures"
REPO = HERE.parents[2]

APOLLO = "tests/fixtures/media/apollo11-small-step.mp3"

# (fixture name, path, query, expected status)
CALLS: list[tuple[str, str, dict[str, str], int]] = [
    ("health", "/api/v1/health", {}, 200),
    ("context-jNQXAC9IVRw", "/api/v1/context", {"url": "https://youtu.be/jNQXAC9IVRw"}, 200),
    ("context-cCPsdFdlshc", "/api/v1/context", {"url": "https://www.youtube.com/watch?v=cCPsdFdlshc"}, 200),
    ("context-unavailable", "/api/v1/context", {"url": "xxxxxxxxxxx"}, 404),
    ("transcript-jNQXAC9IVRw-text", "/api/v1/transcript", {"url": "https://youtu.be/jNQXAC9IVRw"}, 200),
    (
        "transcript-jNQXAC9IVRw-timestamps",
        "/api/v1/transcript",
        {"url": "https://youtu.be/jNQXAC9IVRw", "timestamps": "1"},
        200,
    ),
    ("transcript-missing-url", "/api/v1/transcript", {}, 400),
    ("transcript-unknown-format", "/api/v1/transcript", {"url": "https://youtu.be/jNQXAC9IVRw", "format": "pdf"}, 400),
    ("route-not-found", "/api/v1/no-such-route", {}, 404),
    # A public-domain local file through the media-file provider and speech-to-text, for when
    # YouTube blocks the recording machine. The path is relative to the repo root (the server's cwd).
    ("transcript-apollo11-text", "/api/v1/transcript", {"url": APOLLO}, 200),
    ("transcript-apollo11-timestamps", "/api/v1/transcript", {"url": APOLLO, "timestamps": "1"}, 200),
    ("context-apollo11", "/api/v1/context", {"url": APOLLO}, 200),
]
RETRIES = 4

EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
PHONE = re.compile(r"(?<![\d.])(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\d.])")


def _redact_text(s: str) -> str:
    return PHONE.sub("[phone redacted]", EMAIL.sub("[email redacted]", s))


def _redact_json(v: object) -> object:
    if isinstance(v, str):
        return _redact_text(v)
    if isinstance(v, list):
        return [_redact_json(x) for x in v]
    if isinstance(v, dict):
        return {k: _redact_json(x) for k, x in v.items()}
    return v


def redact(body: str) -> str:
    """Redact inside JSON strings (so escapes stay valid); the raw body is kept when nothing matched."""
    try:
        data = json.loads(body)
    except ValueError:
        return _redact_text(body)
    clean = _redact_json(data)
    if clean == data:
        return body
    return json.dumps(clean, ensure_ascii=False, separators=(",", ":"))


def wait_for(base: str, proc: subprocess.Popen[bytes], seconds: float = 60) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            sys.exit(f"server exited with code {proc.returncode} before it was ready")
        try:
            if httpx.get(f"{base}/api/v1/health", timeout=2).status_code == 200:
                return
        except httpx.TransportError:
            pass
        time.sleep(0.5)
    sys.exit("server did not answer /api/v1/health within 60 s")


def main() -> None:
    # Turn SIGTERM (from `timeout` or a killed shell) into an exit so the server below is always stopped.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    args = sys.argv[1:]
    minimal = "--minimal" in args
    only = {a for a in args if a != "--minimal"}
    unknown = only - {c[0] for c in CALLS}
    if unknown:
        sys.exit(f"unknown fixture names: {', '.join(sorted(unknown))}")
    port = random.randint(20000, 29999)
    base = f"http://127.0.0.1:{port}"
    env = {**os.environ, "PORT": str(port), "HOST": "127.0.0.1"}
    proc = subprocess.Popen(
        ["npx", "tsx", str(HERE / "record_server.ts") if minimal else "packages/server/src/node.ts"],
        cwd=REPO,
        env=env,
        start_new_session=True,
    )
    try:
        wait_for(base, proc)
        today = dt.date.today().isoformat()
        FIXTURES.mkdir(parents=True, exist_ok=True)
        failed = 0
        with httpx.Client(base_url=base, timeout=300) as http:
            for name, path, query, expected in CALLS:
                if only and name not in only:
                    continue
                for attempt in range(RETRIES + 1):
                    res = http.get(path, params=query)
                    if res.status_code == expected or attempt == RETRIES:
                        break
                    wait = 15 * (attempt + 1)
                    print(f"{res.status_code} {path} {query}: expected {expected}, retrying in {wait} s", file=sys.stderr)
                    time.sleep(wait)
                if res.status_code != expected:
                    print(f"{res.status_code} {path} {query}: expected {expected}, not written: {res.text[:300]}", file=sys.stderr)
                    failed += 1
                    continue
                record = {
                    "recorded": today,
                    "request": {"method": "GET", "path": path, "query": query},
                    "status": res.status_code,
                    "headers": {"content-type": res.headers.get("content-type", "")},
                    "body": redact(res.text),
                }
                out = FIXTURES / f"{name}.json"
                out.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
                print(f"{res.status_code} {path} {query} -> {out.relative_to(REPO)}", file=sys.stderr)
        if failed:
            sys.exit(f"{failed} fixture(s) not recorded")
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=10)


if __name__ == "__main__":
    main()
