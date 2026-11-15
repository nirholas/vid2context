"""LlamaIndex reader: `pip install "vid2context[llama-index]"`.

>>> from vid2context.llama_index import VideoContextReader
>>> docs = VideoContextReader().load_data(["https://youtu.be/jNQXAC9IVRw"])
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any, Optional

try:
    from llama_index.core.readers.base import BaseReader
    from llama_index.core.retrievers import BaseRetriever
    from llama_index.core.schema import Document, NodeWithScore, QueryBundle, TextNode
except ImportError as e:  # pragma: no cover - exercised only without the extra installed
    raise ImportError(
        'vid2context.llama_index needs llama-index-core. Install it with: pip install "vid2context[llama-index]"'
    ) from e

from ._loading import Urls, VideoLoading, chunk_id, hit_metadata
from .chunking import Chunk, Chunking
from .client import AsyncClient, Client
from .models import SearchMode, SearchResult, TranscriptMode

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


def _hit_nodes(result: SearchResult) -> list[NodeWithScore]:
    out = []
    for h in result.hits:
        meta = hit_metadata(h)
        node = TextNode(
            id_=f"{h.video_id}@{h.start_sec:g}",
            text=h.text,
            metadata=meta,
            excluded_embed_metadata_keys=[k for k in ("source", "url", "video_id", "score", "search_sources") if k in meta],
        )
        out.append(NodeWithScore(node=node, score=h.score))
    return out


class VideoSearchRetriever(BaseRetriever):
    """Retrieve passages from videos saved in a vid2context server's library (GET /api/v1/search).

    >>> from vid2context.llama_index import VideoSearchRetriever
    >>> nodes = VideoSearchRetriever(collection_id=collection.id).retrieve("which engine is most reliable")

    Each node is one matching passage scored by the server, with the same metadata as
    `vid2context.langchain.VideoSearchRetriever`.
    """

    def __init__(
        self,
        collection_id: Optional[str] = None,
        video_ids: Optional[list[str]] = None,
        limit: Optional[int] = None,
        mode: Optional[SearchMode] = None,
        rerank: bool = False,
        client: Optional[Client] = None,
        *,
        async_client: Optional[AsyncClient] = None,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
    ) -> None:
        super().__init__()
        self.search_kwargs: dict[str, Any] = {
            "collection_id": collection_id,
            "video_ids": video_ids,
            "limit": limit,
            "mode": mode,
            "rerank": rerank,
        }
        self.client = client
        self.async_client = async_client
        self.base_url = base_url
        self.api_key = api_key

    def _retrieve(self, query_bundle: QueryBundle) -> list[NodeWithScore]:
        if self.client is not None:
            return _hit_nodes(self.client.search(query_bundle.query_str, **self.search_kwargs))
        with Client(self.base_url, self.api_key) as client:
            return _hit_nodes(client.search(query_bundle.query_str, **self.search_kwargs))

    async def _aretrieve(self, query_bundle: QueryBundle) -> list[NodeWithScore]:
        if self.async_client is not None:
            return _hit_nodes(await self.async_client.search(query_bundle.query_str, **self.search_kwargs))
        async with AsyncClient(self.base_url, self.api_key) as client:
            return _hit_nodes(await client.search(query_bundle.query_str, **self.search_kwargs))


__all__ = ["VideoContextReader", "VideoSearchRetriever"]
