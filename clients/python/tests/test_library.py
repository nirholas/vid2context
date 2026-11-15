"""Search and collections. Every response is a real recording of one scripted session against
packages/server (scripts/record_fixtures.py --library; see tests/fixtures/README.md)."""

from __future__ import annotations

import json

import httpx
import pytest
from conftest import load

from vid2context import (
    UNSET,
    AsyncClient,
    Client,
    CollectionDefinition,
    CollectionDetail,
    IngestResult,
    Job,
    Schedule,
    Vid2ContextError,
)

ZOO = "https://youtu.be/jNQXAC9IVRw"
GWAGON = "https://www.youtube.com/watch?v=cCPsdFdlshc"
CID = json.loads(load("collection-create")["body"])["id"]
QUEUED_CID = json.loads(load("collection-create-jobs")["body"])["id"]


def _body(req: httpx.Request) -> object:
    return json.loads(req.content)


def test_search_in_a_collection_returns_timestamped_hits(transport, replay):
    with Client(transport=transport) as v2c:
        res = v2c.search("elephants", collection_id=CID)
    assert dict(replay.requests[0].url.params) == {"q": "elephants", "collectionId": CID}
    assert len(res.hits) == 1
    hit = res.hits[0]
    assert (hit.video_id, hit.title, hit.channel) == ("youtube:jNQXAC9IVRw", "Me at the zoo", "jawed")
    assert hit.text == "All right, so here we are, in front of the elephants"
    assert hit.snippet.endswith("**elephants**")
    assert (hit.start_sec, hit.end_sec) == (1.2, 3.36)
    assert hit.url == "https://www.youtube.com/watch?v=jNQXAC9IVRw&t=1s"
    assert hit.chapter_title == "Intro"
    assert hit.sources == ["keyword"] and hit.ranks == {"keyword": 1}
    assert hit.rerank_score is None
    m = res.meta
    assert (m.mode, m.vector, m.rerank) == ("hybrid", "disabled", "off")
    assert (m.indexed_videos, m.indexed_chunks) == (2, 35)
    assert m.vector_reason == "No embedding provider is installed."
    assert m.raw["keyword"]["backend"] == "bm25"


def test_keyword_search_with_limit(transport, replay):
    with Client(transport=transport) as v2c:
        res = v2c.search("reliable V8 engine", mode="keyword", limit=5)
    assert dict(replay.requests[0].url.params) == {"q": "reliable V8 engine", "mode": "keyword", "limit": "5"}
    assert res.meta.mode == "keyword" and res.meta.vector == "off"
    assert 1 <= len(res.hits) <= 5
    assert all(h.video_id == "youtube:cCPsdFdlshc" for h in res.hits)
    assert all(h.url and h.url.startswith(GWAGON + "&t=") for h in res.hits)
    assert [h.score for h in res.hits] == sorted((h.score for h in res.hits), reverse=True)


def test_search_without_matches_is_empty_not_an_error(transport):
    with Client(transport=transport) as v2c:
        res = v2c.search("zebra giraffe")
    assert res.hits == [] and res.meta.indexed_videos == 2


def test_search_errors_come_from_the_server(make_replay):
    replay = make_replay(["search-missing-q", "search-bad-mode"])
    with Client(transport=httpx.MockTransport(replay)) as v2c:
        with pytest.raises(Vid2ContextError) as missing:
            v2c.search("")
        with pytest.raises(Vid2ContextError) as bad_mode:
            v2c.search("step", mode="fuzzy")  # type: ignore[arg-type]
    assert (missing.value.code, missing.value.status) == ("bad-request", 400)
    assert missing.value.hint == "Pass ?q=<words to search for>."
    assert bad_mode.value.message == "Unknown mode: fuzzy."
    assert "keyword" in (bad_mode.value.hint or "")


def test_search_sends_every_filter():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        rec = load("search-no-match")
        return httpx.Response(rec["status"], headers=rec["headers"], content=rec["body"].encode("utf-8"))

    with Client(transport=httpx.MockTransport(handler)) as v2c:
        v2c.search(
            "zebra giraffe",
            video_ids=["youtube:jNQXAC9IVRw", "youtube:cCPsdFdlshc"],
            rerank=True,
            channel="jawed",
            origin=["creator-captions", "auto-captions"],
            published_after="2005-01-01",
            published_before="2026-01-01",
        )
    assert dict(seen[0].url.params) == {
        "q": "zebra giraffe",
        "videoIds": "youtube:jNQXAC9IVRw,youtube:cCPsdFdlshc",
        "rerank": "1",
        "channel": "jawed",
        "origin": "creator-captions,auto-captions",
        "publishedAfter": "2005-01-01",
        "publishedBefore": "2026-01-01",
    }


def test_collection_lifecycle(transport, replay):
    with Client(transport=transport) as v2c:
        created = v2c.create_collection("Car and zoo videos", description="Two public YouTube videos")
        assert created.id == CID and created.video_ids == [] and created.sources == []

        added = v2c.add_to_collection(CID, [ZOO, GWAGON])
        assert isinstance(added, IngestResult)
        assert added.collection.video_ids == ["youtube:jNQXAC9IVRw", "youtube:cCPsdFdlshc"]
        assert [v.title for v in added.summary.added][0] == "Me at the zoo"
        assert added.summary.failed == [] and added.summary.skipped == 0
        assert added.summary.added[1].origin == "auto-captions"
        assert added.summary.added[1].duration_sec is not None and added.summary.added[1].duration_sec > 1000

        listed = v2c.collections()
        assert [c.id for c in listed] == [CID]

        detail = v2c.collection(CID)
        assert isinstance(detail, CollectionDetail)
        assert [v.id for v in detail.videos] == ["youtube:jNQXAC9IVRw", "youtube:cCPsdFdlshc"]
        assert detail.videos[0].ref.native_id == "jNQXAC9IVRw"
        assert detail.pending == [] and detail.watch is None

        updated = v2c.update_collection(
            CID, description="Two public YouTube videos, checked daily", watch={"every": "daily", "at": "06:00"}
        )
        assert updated.description == "Two public YouTube videos, checked daily"

        definition = v2c.export_collection(CID)
        assert definition.videos == ["https://www.youtube.com/watch?v=jNQXAC9IVRw", GWAGON]
        assert definition.schedule == Schedule(every="daily", at="06:00", enabled=True)

        refreshed = v2c.refresh_collection(CID, limit=5)
        assert isinstance(refreshed, IngestResult)
        assert refreshed.summary.added == [] and refreshed.summary.remaining == 0
        assert refreshed.summary.checked_at

        after_remove = v2c.remove_from_collection(CID, ["youtube:jNQXAC9IVRw"])
        assert after_remove.video_ids == ["youtube:cCPsdFdlshc"]

        imported = v2c.import_collection(definition)
        assert imported.collection.id != CID and imported.collection.name == "Car and zoo videos"
        assert imported.summary is None

        assert v2c.delete_collection(CID) is None

    by_path = {(r.method, r.url.path): r for r in replay.requests}
    assert _body(by_path[("POST", f"/api/v1/collections/{CID}/items")]) == {"inputs": [ZOO, GWAGON]}
    patch = _body(by_path[("PATCH", f"/api/v1/collections/{CID}")])
    assert patch == {"description": "Two public YouTube videos, checked daily", "watch": {"every": "daily", "at": "06:00"}}
    # The export is sent back unchanged, server fields (format, version) included.
    assert _body(by_path[("POST", "/api/v1/collections/import")]) == json.loads(load("collection-export")["body"])


def test_update_body_keeps_or_removes_the_schedule():
    from vid2context.client import _update_body

    assert _update_body("New name", None, None, UNSET) == {"name": "New name"}
    assert _update_body(None, None, None, None) == {"watch": None}
    assert _update_body(None, None, None, Schedule(every="weekly")) == {"watch": {"every": "weekly", "enabled": True}}
    assert _update_body(None, None, ["https://example.com/feed"], {"every": {"minutes": 30}}) == {
        "sources": ["https://example.com/feed"],
        "watch": {"every": {"minutes": 30}},
    }


def test_definition_round_trip_keeps_server_fields():
    d = CollectionDefinition.from_dict(json.loads(load("collection-export")["body"]))
    assert d.to_dict() == json.loads(load("collection-export")["body"])
    plain = CollectionDefinition(name="Feeds", sources=["https://example.com/feed"], videos=[])
    assert plain.to_dict() == {
        "format": "vid2context.collection",
        "version": 1,
        "name": "Feeds",
        "sources": ["https://example.com/feed"],
        "videos": [],
    }


def test_ingest_with_a_jobs_queue_returns_a_job(transport):
    with Client(transport=transport) as v2c:
        created = v2c.create_collection("Queued ingest")
        job = v2c.add_to_collection(created.id, [ZOO])
    assert created.id == QUEUED_CID
    assert isinstance(job, Job)
    assert (job.kind, job.status) == ("ingest", "queued")
    assert job.id.startswith("job_") and job.result is None


def test_collection_errors(make_replay):
    replay = make_replay(["collection-not-found", "collection-create-bad"])
    with Client(transport=httpx.MockTransport(replay)) as v2c:
        with pytest.raises(Vid2ContextError) as missing:
            v2c.collection(CID)
        with pytest.raises(Vid2ContextError) as bad:
            v2c.create_collection("")
    assert (missing.value.code, missing.value.status) == ("not-found", 404)
    assert missing.value.hint == "List collections to see valid ids."
    assert (bad.value.code, bad.value.message) == ("bad-request", "A collection needs a name.")


def test_empty_collection_id_is_refused_locally():
    with Client(transport=httpx.MockTransport(lambda r: httpx.Response(500))) as v2c:
        with pytest.raises(Vid2ContextError) as err:
            v2c.collection("")
    assert err.value.code == "bad-request"


async def test_async_client_search_and_collections(transport, replay):
    async with AsyncClient(transport=transport) as v2c:
        res = await v2c.search("elephants", collection_id=CID)
        listed = await v2c.collections()
        detail = await v2c.collection(CID)
        added = await v2c.add_to_collection(CID, [ZOO, GWAGON])
        definition = await v2c.export_collection(CID)
        imported = await v2c.import_collection(definition.raw)
        await v2c.delete_collection(CID)
    assert res.hits[0].title == "Me at the zoo"
    assert [c.name for c in listed] == ["Car and zoo videos"]
    assert len(detail.videos) == 2
    assert isinstance(added, IngestResult) and len(added.summary.added) == 2
    assert imported.collection.name == definition.name
    assert [r.method for r in replay.requests] == ["GET", "GET", "GET", "POST", "GET", "POST", "DELETE"]


def test_langchain_retriever_returns_cited_passages(transport, replay):
    from vid2context.langchain import VideoSearchRetriever

    with Client(transport=transport) as v2c:
        docs = VideoSearchRetriever(client=v2c, collection_id=CID).invoke("elephants")
    assert len(docs) == 1
    doc = docs[0]
    assert doc.page_content == "All right, so here we are, in front of the elephants"
    assert doc.metadata["url"] == "https://www.youtube.com/watch?v=jNQXAC9IVRw&t=1s"
    assert doc.metadata["source"] == doc.metadata["url"]
    assert (doc.metadata["title"], doc.metadata["chapter"], doc.metadata["start_sec"]) == ("Me at the zoo", "Intro", 1.2)
    assert doc.id == "youtube:jNQXAC9IVRw@1.2"
    assert dict(replay.requests[0].url.params) == {"q": "elephants", "collectionId": CID}


async def test_langchain_retriever_async(transport):
    from vid2context.langchain import VideoSearchRetriever

    async with AsyncClient(transport=transport) as v2c:
        docs = await VideoSearchRetriever(async_client=v2c, mode="keyword", limit=5).ainvoke("reliable V8 engine")
    assert docs and all(d.metadata["video_id"] == "youtube:cCPsdFdlshc" for d in docs)


def test_llama_index_retriever_scores_nodes(transport):
    from vid2context.llama_index import VideoSearchRetriever

    with Client(transport=transport) as v2c:
        nodes = VideoSearchRetriever(collection_id=CID, client=v2c).retrieve("elephants")
    assert len(nodes) == 1
    assert nodes[0].score == pytest.approx(0.01639344262295082)
    assert nodes[0].node.get_content() == "All right, so here we are, in front of the elephants"
    assert nodes[0].node.metadata["channel"] == "jawed"
    assert "url" in nodes[0].node.excluded_embed_metadata_keys
