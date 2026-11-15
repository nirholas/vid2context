"""What the LangChain loader and the LlamaIndex reader share: input handling,
fetching contexts one video at a time, and per-video error policy."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Iterator, Sequence
from typing import Any, Optional, Union

from .chunking import CHUNKING_MODES, Chunk, chunk_context
from .client import AsyncClient, Client
from .errors import Vid2ContextError
from .models import SearchHit, TranscriptMode

log = logging.getLogger("vid2context")

Urls = Union[str, Sequence[str]]


def as_url_list(urls: Urls) -> list[str]:
    items = [urls] if isinstance(urls, str) else list(urls)
    if not items:
        raise Vid2ContextError("bad-request", "No video URLs given.", hint="Pass one URL or a list of URLs.")
    return items


def check_chunking(chunking: str, window_sec: float) -> None:
    if chunking not in CHUNKING_MODES:
        raise Vid2ContextError(
            "bad-request", f'Unknown chunking "{chunking}".', hint=f"Use one of: {', '.join(CHUNKING_MODES)}."
        )
    if not window_sec > 0:
        raise Vid2ContextError("bad-request", f"window_sec must be positive, got {window_sec}.", hint="Use a value such as 60.")


def chunk_id(chunk: Chunk, index: int) -> str:
    """Stable per chunk, so loading the same video twice yields the same ids (vector stores can upsert)."""
    return f"{chunk.metadata['video_id']}#{chunk.metadata['chunking']}-{index}"


class VideoLoading:
    """Fetches each video's context and yields its chunks, in input order."""

    def __init__(
        self,
        urls: Urls,
        *,
        chunking: str,
        window_sec: float,
        mode: Optional[TranscriptMode],
        lang: Optional[str],
        continue_on_failure: bool,
        client: Optional[Client],
        async_client: Optional[AsyncClient],
        base_url: Optional[str],
        api_key: Optional[str],
        expand: bool = False,
        max_items: Optional[int] = None,
    ) -> None:
        check_chunking(chunking, window_sec)
        if max_items is not None and max_items < 1:
            raise Vid2ContextError("bad-request", f"max_items must be at least 1, got {max_items}.", hint="Use a value such as 50.")
        self.urls = as_url_list(urls)
        self.chunking = chunking
        self.window_sec = window_sec
        self.mode = mode
        self.lang = lang
        self.continue_on_failure = continue_on_failure
        self.client = client
        self.async_client = async_client
        self.base_url = base_url
        self.api_key = api_key
        self.expand = expand
        self.max_items = max_items

    def _skip(self, url: str, err: Vid2ContextError) -> None:
        if not self.continue_on_failure:
            raise err
        log.warning("vid2context: skipped %s: %s [%s]", url, err, err.code)

    def _videos(self, client: Client) -> Iterator[str]:
        for url in self.urls:
            if not self.expand:
                yield url
                continue
            try:
                refs = client.items(url, limit=self.max_items)
            except Vid2ContextError as err:
                self._skip(url, err)
                continue
            for ref in refs:
                yield ref.url or ref.input

    async def _avideos(self, client: AsyncClient) -> AsyncIterator[str]:
        for url in self.urls:
            if not self.expand:
                yield url
                continue
            try:
                refs = await client.items(url, limit=self.max_items)
            except Vid2ContextError as err:
                self._skip(url, err)
                continue
            for ref in refs:
                yield ref.url or ref.input

    def chunks(self) -> Iterator[tuple[int, Chunk]]:
        own = self.client is None
        client = self.client or Client(self.base_url, self.api_key)
        try:
            for url in self._videos(client):
                try:
                    ctx = client.context(url, mode=self.mode, lang=self.lang)
                except Vid2ContextError as err:
                    self._skip(url, err)
                    continue
                yield from enumerate(chunk_context(ctx, self.chunking, self.window_sec))
        finally:
            if own:
                client.close()

    async def achunks(self) -> AsyncIterator[tuple[int, Chunk]]:
        own = self.async_client is None
        client = self.async_client or AsyncClient(self.base_url, self.api_key)
        try:
            async for url in self._avideos(client):
                try:
                    ctx = await client.context(url, mode=self.mode, lang=self.lang)
                except Vid2ContextError as err:
                    self._skip(url, err)
                    continue
                for item in enumerate(chunk_context(ctx, self.chunking, self.window_sec)):
                    yield item
        finally:
            if own:
                await client.aclose()


def hit_metadata(hit: SearchHit) -> dict[str, Any]:
    """Citation metadata for one search hit, shared by the LangChain and LlamaIndex retrievers."""
    meta: dict[str, Any] = {
        "source": hit.url or hit.video_id,
        "video_id": hit.video_id,
        "title": hit.title,
        "start_sec": hit.start_sec,
        "end_sec": hit.end_sec,
        "score": hit.score,
        "search_sources": list(hit.sources),
    }
    for key, value in (
        ("url", hit.url),
        ("channel", hit.channel),
        ("chapter", hit.chapter_title),
        ("rerank_score", hit.rerank_score),
    ):
        if value is not None:
            meta[key] = value
    return meta
