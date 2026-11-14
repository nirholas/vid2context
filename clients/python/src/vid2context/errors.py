"""The error every client call raises, parsed from the API's error body.

Server errors look like (docs/contracts/http-api.md):

    {"error": {"code": "not-found", "message": "...", "hint": "..."},
     "attempts": [{"id": "youtube", "stage": "metadata", "outcome": "error", ...}]}

Client-side failures use the same shape: `upstream` when the server cannot be
reached or answers something that is not the contract, `timeout` when it is
too slow.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from .models import Attempt


class Vid2ContextError(Exception):
    """An error with a stable `code` and a `hint` that says how to recover."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        hint: Optional[str] = None,
        attempts: Optional[list[Attempt]] = None,
        status: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint
        self.attempts: list[Attempt] = attempts or []
        self.status = status

    def __str__(self) -> str:
        return f"{self.message} (hint: {self.hint})" if self.hint else self.message

    def __repr__(self) -> str:
        return f"Vid2ContextError(code={self.code!r}, status={self.status!r}, message={self.message!r}, hint={self.hint!r})"


def error_from_body(status: int, body: str) -> Vid2ContextError:
    """Build a Vid2ContextError from a non-2xx response body."""
    data: Any
    try:
        data = json.loads(body)
    except ValueError:
        data = None
    err = data.get("error") if isinstance(data, dict) else None
    if isinstance(err, dict) and isinstance(err.get("code"), str):
        raw_attempts = data.get("attempts") if isinstance(data, dict) else None
        attempts = [Attempt.from_dict(a) for a in raw_attempts if isinstance(a, dict)] if isinstance(raw_attempts, list) else []
        return Vid2ContextError(
            err["code"],
            str(err.get("message", "")),
            hint=err.get("hint") if isinstance(err.get("hint"), str) else None,
            attempts=attempts,
            status=status,
        )
    snippet = body[:300].strip()
    return Vid2ContextError(
        "upstream",
        f"HTTP {status} without a vid2context error body{': ' + snippet if snippet else ''}",
        hint="Check that the base URL points at a vid2context server (GET /api/v1/health should answer).",
        status=status,
    )
