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
for when the full provider registry does not build. `--library` records the
collection and search routes instead: one scripted session against the minimal
server (an empty in-memory library), creating a collection, ingesting two
public YouTube videos (read from a library seeded with the committed real
contexts in tests/fixtures/contexts/, since YouTube rate-limits caption
requests from busy machines), searching them, editing, exporting, importing and deleting, with
each call's JSON request body saved next to its response; `--library --jobs`
records the same ingest call against a server with a jobs queue (202 Job).
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
    ("formats", "/api/v1/formats", {}, 200),
    ("metadata-jNQXAC9IVRw", "/api/v1/metadata", {"url": "https://youtu.be/jNQXAC9IVRw"}, 200),
    ("outline-jNQXAC9IVRw", "/api/v1/outline", {"url": "https://youtu.be/jNQXAC9IVRw"}, 200),
    ("items-jNQXAC9IVRw", "/api/v1/items", {"url": "https://youtu.be/jNQXAC9IVRw"}, 200),
    # Its canonical url is the same request as context-cCPsdFdlshc, so loaders can expand then load.
    ("items-cCPsdFdlshc", "/api/v1/items", {"url": "https://www.youtube.com/watch?v=cCPsdFdlshc"}, 200),
    (
        "items-playlist",
        "/api/v1/items",
        {"url": "https://www.youtube.com/playlist?list=PL59FEE129ADFF2B12", "limit": "3"},
        200,
    ),
    ("section-jNQXAC9IVRw-chapter", "/api/v1/section", {"url": "https://youtu.be/jNQXAC9IVRw", "chapter": "1"}, 200),
    (
        "section-jNQXAC9IVRw-range",
        "/api/v1/section",
        {"url": "https://youtu.be/jNQXAC9IVRw", "from": "0:05", "to": "0:17", "timestamps": "1"},
        200,
    ),
    ("section-missing-selector", "/api/v1/section", {"url": "https://youtu.be/jNQXAC9IVRw"}, 400),
    # The transcript routes again on the Apollo 11 clip, for when YouTube blocks caption requests.
    ("outline-apollo11", "/api/v1/outline", {"url": APOLLO}, 200),
    ("section-apollo11-chapter", "/api/v1/section", {"url": APOLLO, "chapter": "0"}, 200),
    ("section-apollo11-range", "/api/v1/section", {"url": APOLLO, "from": "0", "to": "0:06", "timestamps": "1"}, 200),
    ("items-apollo11", "/api/v1/items", {"url": APOLLO}, 200),
    ("items-unsupported", "/api/v1/items", {"url": "https://example.com/"}, 400),
]
RETRIES = 4

ZOO = "https://youtu.be/jNQXAC9IVRw"
GWAGON = "https://www.youtube.com/watch?v=cCPsdFdlshc"

# Real VideoContext output committed at the repo root, saved into the recording server's library
# first, so ingesting ZOO and GWAGON reads them from storage instead of asking YouTube for captions.
SEED = ["youtube-jNQXAC9IVRw.json", "youtube-cCPsdFdlshc.json"]

# The library session: (fixture name, method, path, query, JSON body, expected status). Paths and
# bodies may use {id} (the collection created first), {video} (the ingested video id), {export}
# (the export response body) and {imported} (the collection the import created).
LIBRARY_CALLS: list[tuple[str, str, str, dict[str, str], object, int]] = [
    (
        "collection-create",
        "POST",
        "/api/v1/collections",
        {},
        {"name": "Car and zoo videos", "description": "Two public YouTube videos"},
        201,
    ),
    ("collection-add-items", "POST", "/api/v1/collections/{id}/items", {}, {"inputs": [ZOO, GWAGON]}, 200),
    ("collections-list", "GET", "/api/v1/collections", {}, None, 200),
    ("collection-detail", "GET", "/api/v1/collections/{id}", {}, None, 200),
    (
        "collection-update",
        "PATCH",
        "/api/v1/collections/{id}",
        {},
        {"description": "Two public YouTube videos, checked daily", "watch": {"every": "daily", "at": "06:00"}},
        200,
    ),
    ("search-collection", "GET", "/api/v1/search", {"q": "elephants", "collectionId": "{id}"}, None, 200),
    ("search-keyword", "GET", "/api/v1/search", {"q": "reliable V8 engine", "mode": "keyword", "limit": "5"}, None, 200),
    ("search-no-match", "GET", "/api/v1/search", {"q": "zebra giraffe"}, None, 200),
    ("search-missing-q", "GET", "/api/v1/search", {}, None, 400),
    ("search-bad-mode", "GET", "/api/v1/search", {"q": "step", "mode": "fuzzy"}, None, 400),
    ("collection-export", "GET", "/api/v1/collections/{id}/export", {}, None, 200),
    ("collection-refresh", "POST", "/api/v1/collections/{id}/refresh", {}, {"limit": 5}, 200),
    ("collection-remove-items", "DELETE", "/api/v1/collections/{id}/items", {}, {"videoIds": ["{video}"]}, 200),
    ("collection-import", "POST", "/api/v1/collections/import", {}, "{export}", 201),
    ("collection-delete", "DELETE", "/api/v1/collections/{id}", {}, None, 204),
    ("collection-not-found", "GET", "/api/v1/collections/{id}", {}, None, 404),
    ("collection-create-bad", "POST", "/api/v1/collections", {}, {"name": ""}, 400),
]
# With RECORD_JOBS=1: ingest answers 202 with a queued Job.
JOBS_CALLS: list[tuple[str, str, str, dict[str, str], object, int]] = [
    ("collection-create-jobs", "POST", "/api/v1/collections", {}, {"name": "Queued ingest"}, 201),
    ("collection-add-items-job", "POST", "/api/v1/collections/{id}/items", {}, {"inputs": [ZOO]}, 202),
]

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


def _fill(v: object, values: dict[str, object]) -> object:
    """Substitute {name} placeholders; a string that is exactly one placeholder takes the value as is."""
    if isinstance(v, str):
        for k, val in values.items():
            if v == "{" + k + "}":
                return val
        for k, val in values.items():
            if isinstance(val, str):
                v = v.replace("{" + k + "}", val)
        return v
    if isinstance(v, list):
        return [_fill(x, values) for x in v]
    if isinstance(v, dict):
        return {k: _fill(x, values) for k, x in v.items()}
    return v


def record_session(http: httpx.Client, calls: list[tuple[str, str, str, dict[str, str], object, int]]) -> int:
    """Run one scripted session in order, writing every response. Stops at the first unexpected status."""
    today = dt.date.today().isoformat()
    values: dict[str, object] = {}
    for name, method, path_t, query_t, body_t, expected in calls:
        path = str(_fill(path_t, values))
        query = {k: str(_fill(v, values)) for k, v in query_t.items()}
        body = _fill(body_t, values) if body_t is not None else None
        res = http.request(method, path, params=query or None, json=body)
        if res.status_code != expected:
            print(f"{res.status_code} {method} {path}: expected {expected}, stopping: {res.text[:300]}", file=sys.stderr)
            return 1
        data = res.json() if res.content and "json" in res.headers.get("content-type", "") else None
        if name.startswith("collection-create") and res.status_code == 201 and isinstance(data, dict):
            values["id"] = data["id"]
        if name == "collection-add-items" and isinstance(data, dict):
            added = data["summary"]["added"]
            if not added:
                print(f"ingest added nothing: {res.text[:500]}", file=sys.stderr)
                return 1
            values["video"] = added[0]["id"]
        if name == "collection-export":
            values["export"] = data
        request: dict[str, object] = {"method": method, "path": path, "query": query}
        if body is not None:
            request["json"] = body
        record = {
            "recorded": today,
            "request": request,
            "status": res.status_code,
            "headers": {"content-type": res.headers.get("content-type", "")},
            "body": redact(res.text),
        }
        out = FIXTURES / f"{name}.json"
        out.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"{res.status_code} {method} {path} -> {out.relative_to(REPO)}", file=sys.stderr)
    return 0


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
    library = "--library" in args
    jobs = "--jobs" in args
    minimal = "--minimal" in args or library
    only = {a for a in args if a not in ("--minimal", "--library", "--jobs")}
    unknown = only - {c[0] for c in CALLS}
    if unknown:
        sys.exit(f"unknown fixture names: {', '.join(sorted(unknown))}")
    port = random.randint(20000, 29999)
    base = f"http://127.0.0.1:{port}"
    env = {**os.environ, "PORT": str(port), "HOST": "127.0.0.1"}
    if jobs:
        env["RECORD_JOBS"] = "1"
    if library:
        env["RECORD_SEED"] = ",".join(str(REPO / "tests/fixtures/contexts" / f) for f in SEED)
    proc = subprocess.Popen(
        ["npx", "tsx", str(HERE / "record_server.ts") if minimal else "packages/server/src/node.ts"],
        cwd=REPO,
        env=env,
        start_new_session=True,
    )
    try:
        wait_for(base, proc)
        if library:
            FIXTURES.mkdir(parents=True, exist_ok=True)
            with httpx.Client(base_url=base, timeout=300) as http:
                if record_session(http, JOBS_CALLS if jobs else LIBRARY_CALLS):
                    sys.exit("library session not fully recorded")
            return
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
