"""Sync and async clients for the vid2context HTTP API (docs/contracts/http-api.md).

Both talk to a vid2context server you run (`npm run start:server`, default
http://127.0.0.1:8787), so nothing leaves your machine unless you point them
somewhere else.
"""

from __future__ import annotations

import os
from typing import Any, Mapping, Optional, Sequence, Union
from urllib.parse import quote

import httpx

from .errors import Vid2ContextError, error_from_body
from .models import (
    Collection,
    CollectionDefinition,
    CollectionDetail,
    FormatInfo,
    Health,
    ImportResult,
    IngestResult,
    Job,
    Outline,
    Schedule,
    SearchMode,
    SearchResult,
    TranscriptMode,
    VideoContext,
    VideoMetadata,
    VideoRef,
)

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


TimeArg = Union[float, int, str]
"""Seconds (754), or a string the server parses: "754", "12:34" or "1:02:03"."""


def _time(v: TimeArg) -> str:
    if isinstance(v, bool):
        raise TypeError("a time must be seconds or an m:ss string, not a bool")
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _section_query(
    url: str,
    start: Optional[TimeArg],
    end: Optional[TimeArg],
    chapter: Optional[Union[int, str]],
    format: str,
    timestamps: bool,
    mode: Optional[TranscriptMode],
    lang: Optional[str],
) -> dict[str, str]:
    # The server rejects a request with no selector (400 bad-request with a hint); that check stays there
    # so the client reports exactly what the server says.
    q = _transcript_query(url, format, timestamps, mode, lang)
    if start is not None:
        q["from"] = _time(start)
    if end is not None:
        q["to"] = _time(end)
    if chapter is not None:
        q["chapter"] = str(chapter)
    return q


def _items_query(url: str, limit: Optional[int]) -> dict[str, str]:
    q = _video_query(url, None, None)
    if limit is not None:
        q["limit"] = str(limit)
    return q


def _search_query(
    q: str,
    collection_id: Optional[str],
    video_ids: Optional[Sequence[str]],
    limit: Optional[int],
    mode: Optional[SearchMode],
    rerank: bool,
    channel: Optional[str],
    origin: Optional[Sequence[str]],
    published_after: Optional[str],
    published_before: Optional[str],
) -> dict[str, str]:
    # An empty q is left out rather than checked here: the server answers bad-request with a hint,
    # and the client reports exactly that.
    p: dict[str, str] = {"q": q} if q else {}
    if collection_id:
        p["collectionId"] = collection_id
    if video_ids:
        p["videoIds"] = ",".join(video_ids)
    if limit is not None:
        p["limit"] = str(limit)
    if mode:
        p["mode"] = mode
    if rerank:
        p["rerank"] = "1"
    if channel:
        p["channel"] = channel
    if origin:
        p["origin"] = ",".join(origin)
    if published_after:
        p["publishedAfter"] = published_after
    if published_before:
        p["publishedBefore"] = published_before
    return p


class _Unset:
    def __repr__(self) -> str:
        return "UNSET"


UNSET: Any = _Unset()
"""Default for `update_collection(watch=...)`: leave the schedule as it is. Pass None to remove it."""

ScheduleArg = Union[Schedule, Mapping[str, Any]]
"""A `Schedule`, or the JSON form: {"every": "daily", "at": "06:00"}."""


def _cid(collection_id: str) -> str:
    if not collection_id:
        raise Vid2ContextError("bad-request", "No collection id given.", hint="Pass an id from collections().")
    return "/collections/" + quote(collection_id, safe="")


def _schedule(v: ScheduleArg) -> dict[str, Any]:
    return v.to_dict() if isinstance(v, Schedule) else dict(v)


def _create_body(
    name: str, description: Optional[str], sources: Optional[Sequence[str]], watch: Optional[ScheduleArg]
) -> dict[str, Any]:
    body: dict[str, Any] = {"name": name}
    if description is not None:
        body["description"] = description
    if sources is not None:
        body["sources"] = list(sources)
    if watch is not None:
        body["watch"] = _schedule(watch)
    return body


def _update_body(
    name: Optional[str], description: Optional[str], sources: Optional[Sequence[str]], watch: Any
) -> dict[str, Any]:
    body: dict[str, Any] = {}
    if name is not None:
        body["name"] = name
    if description is not None:
        body["description"] = description
    if sources is not None:
        body["sources"] = list(sources)
    if watch is None:
        body["watch"] = None
    elif watch is not UNSET:
        body["watch"] = _schedule(watch)
    return body


def _limit_body(limit: Optional[int], **fields: Any) -> dict[str, Any]:
    body = dict(fields)
    if limit is not None:
        body["limit"] = limit
    return body


def _ingest(res: httpx.Response) -> Union[IngestResult, Job]:
    """202 means the server queued a job; 200 means it ran the ingest inline and returns the summary."""
    body = _json(res)
    return Job.from_dict(body) if res.status_code == 202 else IngestResult.from_dict(body)


def _definition(d: Union[CollectionDefinition, Mapping[str, Any]]) -> dict[str, Any]:
    return d.to_dict() if isinstance(d, CollectionDefinition) else dict(d)


def _no_content(res: httpx.Response) -> None:
    if res.status_code >= 400:
        raise error_from_body(res.status_code, res.text)


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

    def _send(
        self, method: str, path: str, body: Any = None, params: Optional[dict[str, str]] = None
    ) -> httpx.Response:
        try:
            return self._http.request(method, path, json=body, params=params)
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

    def metadata(self, url: str) -> VideoMetadata:
        """Title, channel, duration and chapters, without fetching a transcript."""
        return VideoMetadata.from_dict(_json(self._get("/metadata", _video_query(url, None, None))))

    def outline(self, url: str, mode: Optional[TranscriptMode] = None, lang: Optional[str] = None) -> Outline:
        """Chapters (or five-minute sections) with token estimates, to choose what to fetch with `section`."""
        return Outline.from_dict(_json(self._get("/outline", _video_query(url, mode, lang))))

    def section(
        self,
        url: str,
        start: Optional[TimeArg] = None,
        end: Optional[TimeArg] = None,
        chapter: Optional[Union[int, str]] = None,
        format: str = "text",
        timestamps: bool = False,
        mode: Optional[TranscriptMode] = None,
        lang: Optional[str] = None,
    ) -> str:
        """One time range (`start` to `end`, end exclusive) or one chapter (outline index or title), rendered."""
        return _text(self._get("/section", _section_query(url, start, end, chapter, format, timestamps, mode, lang)))

    def items(self, url: str, limit: Optional[int] = None) -> list[VideoRef]:
        """Expand a playlist, channel, feed or page into video refs. A single video returns itself."""
        return [VideoRef.from_dict(r) for r in _json(self._get("/items", _items_query(url, limit))).get("items", [])]

    def formats(self) -> list[FormatInfo]:
        """Output formats this server can render, with file extensions."""
        return [FormatInfo.from_dict(f) for f in _json(self._get("/formats")).get("formats", [])]

    def search(
        self,
        q: str,
        collection_id: Optional[str] = None,
        video_ids: Optional[Sequence[str]] = None,
        limit: Optional[int] = None,
        mode: Optional[SearchMode] = None,
        rerank: bool = False,
        *,
        channel: Optional[str] = None,
        origin: Optional[Sequence[str]] = None,
        published_after: Optional[str] = None,
        published_before: Optional[str] = None,
    ) -> SearchResult:
        """Search saved transcripts (hybrid keyword and vector by default). Hits carry timestamp links."""
        p = _search_query(
            q, collection_id, video_ids, limit, mode, rerank, channel, origin, published_after, published_before
        )
        return SearchResult.from_dict(_json(self._get("/search", p)))

    def collections(self) -> list[Collection]:
        """Every collection in the server's library."""
        return [Collection.from_dict(c) for c in _json(self._get("/collections")).get("collections", [])]

    def create_collection(
        self,
        name: str,
        description: Optional[str] = None,
        sources: Optional[Sequence[str]] = None,
        watch: Optional[ScheduleArg] = None,
    ) -> Collection:
        """Create a collection. `sources` are playlist, channel or feed inputs; `watch` refreshes it on a schedule."""
        return Collection.from_dict(_json(self._send("POST", "/collections", _create_body(name, description, sources, watch))))

    def collection(self, collection_id: str) -> CollectionDetail:
        """One collection with its videos, pending imports and watch schedule."""
        return CollectionDetail.from_dict(_json(self._get(_cid(collection_id))))

    def update_collection(
        self,
        collection_id: str,
        name: Optional[str] = None,
        description: Optional[str] = None,
        sources: Optional[Sequence[str]] = None,
        watch: Any = UNSET,
    ) -> Collection:
        """Change fields; `watch=None` removes the schedule, a schedule sets it, leaving it out keeps it."""
        body = _update_body(name, description, sources, watch)
        return Collection.from_dict(_json(self._send("PATCH", _cid(collection_id), body)))

    def delete_collection(self, collection_id: str) -> None:
        """Delete a collection. Its saved videos stay in the library."""
        _no_content(self._send("DELETE", _cid(collection_id)))

    def add_to_collection(
        self, collection_id: str, inputs: Sequence[str], limit: Optional[int] = None
    ) -> Union[IngestResult, Job]:
        """Fetch videos or lists into a collection. A `Job` when the server has a jobs queue, else the run's result."""
        body = _limit_body(limit, inputs=list(inputs))
        return _ingest(self._send("POST", _cid(collection_id) + "/items", body))

    def remove_from_collection(self, collection_id: str, video_ids: Sequence[str]) -> Collection:
        """Remove videos (ids such as "youtube:cCPsdFdlshc"); a refresh will not bring them back."""
        body = {"videoIds": list(video_ids)}
        return Collection.from_dict(_json(self._send("DELETE", _cid(collection_id) + "/items", body)))

    def refresh_collection(self, collection_id: str, limit: Optional[int] = None) -> Union[IngestResult, Job]:
        """Check the collection's sources for new videos and ingest them."""
        return _ingest(self._send("POST", _cid(collection_id) + "/refresh", _limit_body(limit)))

    def export_collection(self, collection_id: str) -> CollectionDefinition:
        """The portable definition (sources and video URLs, no transcripts), for import elsewhere."""
        return CollectionDefinition.from_dict(_json(self._get(_cid(collection_id) + "/export")))

    def import_collection(
        self, definition: Union[CollectionDefinition, Mapping[str, Any]], refresh: bool = False
    ) -> ImportResult:
        """Create a collection from a definition. `refresh=True` ingests its videos now instead of on the next refresh."""
        params = {"refresh": "1"} if refresh else None
        return ImportResult.from_dict(_json(self._send("POST", "/collections/import", _definition(definition), params)))

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

    async def _send(
        self, method: str, path: str, body: Any = None, params: Optional[dict[str, str]] = None
    ) -> httpx.Response:
        try:
            return await self._http.request(method, path, json=body, params=params)
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

    async def metadata(self, url: str) -> VideoMetadata:
        return VideoMetadata.from_dict(_json(await self._get("/metadata", _video_query(url, None, None))))

    async def outline(self, url: str, mode: Optional[TranscriptMode] = None, lang: Optional[str] = None) -> Outline:
        return Outline.from_dict(_json(await self._get("/outline", _video_query(url, mode, lang))))

    async def section(
        self,
        url: str,
        start: Optional[TimeArg] = None,
        end: Optional[TimeArg] = None,
        chapter: Optional[Union[int, str]] = None,
        format: str = "text",
        timestamps: bool = False,
        mode: Optional[TranscriptMode] = None,
        lang: Optional[str] = None,
    ) -> str:
        q = _section_query(url, start, end, chapter, format, timestamps, mode, lang)
        return _text(await self._get("/section", q))

    async def items(self, url: str, limit: Optional[int] = None) -> list[VideoRef]:
        body = _json(await self._get("/items", _items_query(url, limit)))
        return [VideoRef.from_dict(r) for r in body.get("items", [])]

    async def formats(self) -> list[FormatInfo]:
        return [FormatInfo.from_dict(f) for f in _json(await self._get("/formats")).get("formats", [])]

    async def search(
        self,
        q: str,
        collection_id: Optional[str] = None,
        video_ids: Optional[Sequence[str]] = None,
        limit: Optional[int] = None,
        mode: Optional[SearchMode] = None,
        rerank: bool = False,
        *,
        channel: Optional[str] = None,
        origin: Optional[Sequence[str]] = None,
        published_after: Optional[str] = None,
        published_before: Optional[str] = None,
    ) -> SearchResult:
        p = _search_query(
            q, collection_id, video_ids, limit, mode, rerank, channel, origin, published_after, published_before
        )
        return SearchResult.from_dict(_json(await self._get("/search", p)))

    async def collections(self) -> list[Collection]:
        return [Collection.from_dict(c) for c in _json(await self._get("/collections")).get("collections", [])]

    async def create_collection(
        self,
        name: str,
        description: Optional[str] = None,
        sources: Optional[Sequence[str]] = None,
        watch: Optional[ScheduleArg] = None,
    ) -> Collection:
        body = _create_body(name, description, sources, watch)
        return Collection.from_dict(_json(await self._send("POST", "/collections", body)))

    async def collection(self, collection_id: str) -> CollectionDetail:
        return CollectionDetail.from_dict(_json(await self._get(_cid(collection_id))))

    async def update_collection(
        self,
        collection_id: str,
        name: Optional[str] = None,
        description: Optional[str] = None,
        sources: Optional[Sequence[str]] = None,
        watch: Any = UNSET,
    ) -> Collection:
        body = _update_body(name, description, sources, watch)
        return Collection.from_dict(_json(await self._send("PATCH", _cid(collection_id), body)))

    async def delete_collection(self, collection_id: str) -> None:
        _no_content(await self._send("DELETE", _cid(collection_id)))

    async def add_to_collection(
        self, collection_id: str, inputs: Sequence[str], limit: Optional[int] = None
    ) -> Union[IngestResult, Job]:
        body = _limit_body(limit, inputs=list(inputs))
        return _ingest(await self._send("POST", _cid(collection_id) + "/items", body))

    async def remove_from_collection(self, collection_id: str, video_ids: Sequence[str]) -> Collection:
        body = {"videoIds": list(video_ids)}
        return Collection.from_dict(_json(await self._send("DELETE", _cid(collection_id) + "/items", body)))

    async def refresh_collection(self, collection_id: str, limit: Optional[int] = None) -> Union[IngestResult, Job]:
        return _ingest(await self._send("POST", _cid(collection_id) + "/refresh", _limit_body(limit)))

    async def export_collection(self, collection_id: str) -> CollectionDefinition:
        return CollectionDefinition.from_dict(_json(await self._get(_cid(collection_id) + "/export")))

    async def import_collection(
        self, definition: Union[CollectionDefinition, Mapping[str, Any]], refresh: bool = False
    ) -> ImportResult:
        params = {"refresh": "1"} if refresh else None
        res = await self._send("POST", "/collections/import", _definition(definition), params)
        return ImportResult.from_dict(_json(res))

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> AsyncClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()


__all__ = ["UNSET", "AsyncClient", "Client", "DEFAULT_BASE_URL", "DEFAULT_TIMEOUT", "ScheduleArg", "TimeArg"]
