"""LlamaIndex reader: `pip install "vid2context[llama-index]"`.

>>> from vid2context.llama_index import VideoContextReader
>>> docs = VideoContextReader().load_data(["https://youtu.be/jNQXAC9IVRw"])
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any, Optional

try:
    from llama_index.core.readers.base import BaseReader
    from llama_index.core.schema import Document
except ImportError as e:  # pragma: no cover - exercised only without the extra installed
    raise ImportError(
        'vid2context.llama_index needs llama-index-core. Install it with: pip install "vid2context[llama-index]"'
    ) from e

from ._loading import Urls, VideoLoading, chunk_id
from .chunking import Chunk, Chunking
from .client import AsyncClient, Client
from .models import TranscriptMode

# Kept on the node for citations, but not mixed into the text that gets embedded.
_NOT_EMBEDDED = [
    "source",
    "url",
    "video_id",
    "platform",
    "transcript_origin",
    "chunking",
    "chunking_requested",
    "chapter_index",
    "segment_index",
    "window_index",
]


def _document(chunk: Chunk, index: int) -> Document:
    return Document(
        id_=chunk_id(chunk, index),
        text=chunk.text,
        metadata=chunk.metadata,
        excluded_embed_metadata_keys=[k for k in _NOT_EMBEDDED if k in chunk.metadata],
    )


class VideoContextReader(BaseReader):
    """Read videos as LlamaIndex Documents through a vid2context server.

    Same options and metadata as `vid2context.langchain.VideoContextLoader`, but the URLs
    go to `load_data(urls)` so one reader can be reused.
    """

    def __init__(
        self,
        chunking: Chunking = "chapters",
        window_sec: float = 60,
        client: Optional[Client] = None,
        *,
        mode: Optional[TranscriptMode] = None,
        lang: Optional[str] = None,
        continue_on_failure: bool = False,
        async_client: Optional[AsyncClient] = None,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        expand: bool = False,
        max_items: Optional[int] = None,
    ) -> None:
        self.expand = expand
        self.max_items = max_items
        self.chunking = chunking
        self.window_sec = window_sec
        self.client = client
        self.mode = mode
        self.lang = lang
        self.continue_on_failure = continue_on_failure
        self.async_client = async_client
        self.base_url = base_url
        self.api_key = api_key

    def _loading(self, urls: Urls) -> VideoLoading:
        return VideoLoading(
            urls,
            chunking=self.chunking,
            window_sec=self.window_sec,
            mode=self.mode,
            lang=self.lang,
            continue_on_failure=self.continue_on_failure,
            client=self.client,
            async_client=self.async_client,
            base_url=self.base_url,
            api_key=self.api_key,
            expand=self.expand,
            max_items=self.max_items,
        )

    def lazy_load_data(self, urls: Urls, **_: Any) -> Iterable[Document]:
        for index, chunk in self._loading(urls).chunks():
            yield _document(chunk, index)

    def load_data(self, urls: Urls, **_: Any) -> list[Document]:
        return list(self.lazy_load_data(urls))

    async def aload_data(self, urls: Urls, **_: Any) -> list[Document]:
        return [_document(chunk, index) async for index, chunk in self._loading(urls).achunks()]


__all__ = ["VideoContextReader"]
