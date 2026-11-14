"""Replay real recorded vid2context responses (tests/fixtures/*.json) through httpx.MockTransport.

A request that matches no recording fails the test, so unit tests never reach the network.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

import httpx
import pytest

FIXTURES = Path(__file__).parent / "fixtures"


def load(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


# Same request as context-jNQXAC9IVRw, recorded while YouTube was blocking the machine.
# Error tests load it by name; the replay server answers that request with the good recording.
NOT_SERVED = {"context-blocked"}


def all_recordings() -> list[dict[str, Any]]:
    return [json.loads(p.read_text(encoding="utf-8")) for p in sorted(FIXTURES.glob("*.json")) if p.stem not in NOT_SERVED]


class Replay:
    """Serves recordings by method, path and exact query; keeps every request for assertions."""

    def __init__(self, recordings: list[dict[str, Any]]) -> None:
        self.recordings = recordings
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        query = dict(request.url.params.multi_items())
        for rec in self.recordings:
            r = rec["request"]
            if r["method"] == request.method and r["path"] == request.url.path and r["query"] == query:
                return httpx.Response(rec["status"], headers=rec["headers"], content=rec["body"].encode("utf-8"))
        raise AssertionError(f"no recorded response for {request.method} {request.url}")


@pytest.fixture
def replay() -> Replay:
    return Replay(all_recordings())


@pytest.fixture
def make_replay() -> Callable[[list[str]], Replay]:
    return lambda names: Replay([load(n) for n in names])


@pytest.fixture
def transport(replay: Replay) -> httpx.MockTransport:
    return httpx.MockTransport(replay)
