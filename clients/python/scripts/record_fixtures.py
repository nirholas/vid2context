"""Record real HTTP responses from a real vid2context server as test fixtures.

Starts packages/server on a random local port (20000 to 29999), calls it for
the videos and error cases the tests replay, writes one JSON file per call into
tests/fixtures/, then stops the server. Run from anywhere:

    uv run python scripts/record_fixtures.py

Needs Node 22+ and `npm install` at the repo root. Personal details (email
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

# (fixture name, path, query)
CALLS: list[tuple[str, str, dict[str, str]]] = [
    ("health", "/api/v1/health", {}),
    ("context-jNQXAC9IVRw", "/api/v1/context", {"url": "https://youtu.be/jNQXAC9IVRw"}),
    ("context-cCPsdFdlshc", "/api/v1/context", {"url": "https://www.youtube.com/watch?v=cCPsdFdlshc"}),
    ("context-unavailable", "/api/v1/context", {"url": "xxxxxxxxxxx"}),
    ("transcript-jNQXAC9IVRw-text", "/api/v1/transcript", {"url": "https://youtu.be/jNQXAC9IVRw"}),
    (
        "transcript-jNQXAC9IVRw-timestamps",
        "/api/v1/transcript",
        {"url": "https://youtu.be/jNQXAC9IVRw", "format": "text", "timestamps": "1"},
    ),
    ("transcript-missing-url", "/api/v1/transcript", {}),
    ("transcript-unknown-format", "/api/v1/transcript", {"url": "https://youtu.be/jNQXAC9IVRw", "format": "pdf"}),
]

EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
PHONE = re.compile(r"(?<![\d.])(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\d.])")


def redact(body: str) -> str:
    return PHONE.sub("[phone redacted]", EMAIL.sub("[email redacted]", body))


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
    port = random.randint(20000, 29999)
    base = f"http://127.0.0.1:{port}"
    env = {**os.environ, "PORT": str(port), "HOST": "127.0.0.1"}
    proc = subprocess.Popen(
        ["npx", "tsx", "packages/server/src/node.ts"], cwd=REPO, env=env, start_new_session=True
    )
    try:
        wait_for(base, proc)
        today = dt.date.today().isoformat()
        FIXTURES.mkdir(parents=True, exist_ok=True)
        with httpx.Client(base_url=base, timeout=300) as http:
            for name, path, query in CALLS:
                res = http.get(path, params=query)
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
    finally:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=10)


if __name__ == "__main__":
    main()
