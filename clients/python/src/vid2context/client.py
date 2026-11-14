"""Sync and async clients for the vid2context HTTP API (docs/contracts/http-api.md).

Both talk to a vid2context server you run (`npm run start:server`, default
http://127.0.0.1:8787), so nothing leaves your machine unless you point them
somewhere else.
"""

from __future__ import annotations

import os
from typing import Any, Mapping, Optional

import httpx

from .errors import Vid2ContextError, error_from_body
from .models import Health, TranscriptMode, VideoContext

DEFAULT_BASE_URL = "http://127.0.0.1:8787"
DEFAULT_TIMEOUT = 300.0
"""Seconds. Generous because a video without captions may go through speech-to-text."""

API_PREFIX = "/api/v1"


def _resolve_base_url(base_url: Optional[str]) -> str:
    url = base_url or os.environ.get("VID2CONTEXT_API_URL") or DEFAULT_BASE_URL
    url = url.rstrip("/")
    # Accept both http://host:8787 and http://host:8787/api/v1.
    if url.endswith(API_PREFIX):
        url = url[: -len(API_PREFIX)]
    return url


def _headers(api_key: Optional[str], extra: Optional[Mapping[str, str]]) -> dict[str, str]:
    key = api_key if api_key is not None else os.environ.get("VID2CONTEXT_API_KEY")
    headers = {"accept": "application/json, text/*;q=0.9", "user-agent": "vid2context-python/0.1.0"}
    if key:
        headers["authorization"] = f"Bearer {key}"
    if extra:
        headers.update(extra)
    return headers


def _video_query(url: str, mode: Optional[TranscriptMode], lang: Optional[str]) -> dict[str, str]:
    if not url:
        raise Vid2ContextError("bad-request", "No video URL given.", hint="Pass a video URL, a YouTube id or a local path.")
    q = {"url": url}
    if mode:
        q["mode"] = mode
    if lang:
        q["lang"] = lang
    return q


def _transcript_query(
    url: str, format: str, timestamps: bool, mode: Optional[TranscriptMode], lang: Optional[str]
) -> dict[str, str]:
    q = _video_query(url, mode, lang)
    # The server's default format is text (docs/contracts/http-api.md), so it is only sent when different.
    if format != "text":
        q["format"] = format
    if timestamps:
        q["timestamps"] = "1"
    return q


def _json(res: httpx.Response) -> Any:
    if res.status_code >= 400:
        raise error_from_body(res.status_code, res.text)
    try:
        return res.json()
    except ValueError as e:
        raise Vid2ContextError(
            "upstream",
            f"Expected JSON from {res.request.url.path}, got {res.headers.get('content-type', 'no content type')}.",
            hint="Check that the base URL points at a vid2context server.",
            status=res.status_code,
        ) from e


def _text(res: httpx.Response) -> str:
    if res.status_code >= 400:
        raise error_from_body(res.status_code, res.text)
    return res.text


def _transport_error(base_url: str, err: httpx.TransportError) -> Vid2ContextError:
    if isinstance(err, httpx.TimeoutException):
        return Vid2ContextError(
            "timeout",
            f"vid2context at {base_url} did not answer in time.",
            hint="Raise the client timeout, or try mode='captions' for a faster, captions-only result.",
        )
    return Vid2ContextError(
        "upstream",
        f"Could not reach vid2context at {base_url}: {err}",
        hint="Start the server with `npm run start:server` in the vid2context repo, or set VID2CONTEXT_API_URL.",
    )


class Client:
    """Blocking client.

    >>> from vid2context import Client
    >>> with Client() as v2c:
    ...     ctx = v2c.context("https://youtu.be/jNQXAC9IVRw")
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
        *,
        headers: Optional[Mapping[str, str]] = None,
        transport: Optional[httpx.BaseTransport] = None,
    ) -> None:
        self.base_url = _resolve_base_url(base_url)
        self._http = httpx.Client(
            base_url=self.base_url + API_PREFIX, headers=_headers(api_key, headers), timeout=timeout, transport=transport
        )

    def _get(self, path: str, params: Optional[dict[str, str]] = None) -> httpx.Response:
        try:
            return self._http.get(path, params=params)
        except httpx.TransportError as e:
            raise _transport_error(self.base_url, e) from e

    def health(self) -> Health:
        """Server version, transcript formats and providers (env var names only, never values)."""
        return Health.from_dict(_json(self._get("/health")))

    def context(self, url: str, mode: Optional[TranscriptMode] = None, lang: Optional[str] = None) -> VideoContext:
        """The full VideoContext: metadata, chapters, timed transcript segments and attempts."""
        return VideoContext.from_dict(_json(self._get("/context", _video_query(url, mode, lang))))

    def transcript(
        self,
        url: str,
        format: str = "text",
        timestamps: bool = False,
        mode: Optional[TranscriptMode] = None,
        lang: Optional[str] = None,
    ) -> str:
        """The transcript rendered by a server formatter (ids listed in `health().formats`)."""
        return _text(self._get("/transcript", _transcript_query(url, format, timestamps, mode, lang)))

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> Client:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


class AsyncClient:
    """Asyncio client with the same methods as `Client`, awaited."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
        *,
        headers: Optional[Mapping[str, str]] = None,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self.base_url = _resolve_base_url(base_url)
        self._http = httpx.AsyncClient(
            base_url=self.base_url + API_PREFIX, headers=_headers(api_key, headers), timeout=timeout, transport=transport
        )

    async def _get(self, path: str, params: Optional[dict[str, str]] = None) -> httpx.Response:
        try:
            return await self._http.get(path, params=params)
        except httpx.TransportError as e:
            raise _transport_error(self.base_url, e) from e

    async def health(self) -> Health:
        return Health.from_dict(_json(await self._get("/health")))

    async def context(self, url: str, mode: Optional[TranscriptMode] = None, lang: Optional[str] = None) -> VideoContext:
        return VideoContext.from_dict(_json(await self._get("/context", _video_query(url, mode, lang))))

    async def transcript(
        self,
        url: str,
        format: str = "text",
        timestamps: bool = False,
        mode: Optional[TranscriptMode] = None,
        lang: Optional[str] = None,
    ) -> str:
        return _text(await self._get("/transcript", _transcript_query(url, format, timestamps, mode, lang)))

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> AsyncClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()


__all__ = ["AsyncClient", "Client", "DEFAULT_BASE_URL", "DEFAULT_TIMEOUT"]
