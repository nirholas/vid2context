# vid2context for Python

A thin Python client for the [vid2context](https://github.com/nirholas/vid2context) HTTP API, with a LangChain document loader and a LlamaIndex reader that turn videos into documents with timestamp metadata.

The pipeline itself stays TypeScript (it also runs on Workers and in browsers). This package calls a vid2context server you run, by default `http://127.0.0.1:8787`, so everything stays free and local unless you point it elsewhere. The only runtime dependency is `httpx`.

## Install from the repo

Start the server once, from the repo root:

```sh
npm install
npm run start:server          # http://127.0.0.1:8787/api/v1/health
```

Then install the client into your Python 3.10+ environment:

```sh
pip install "./clients/python"                  # client only
pip install "./clients/python[langchain]"       # plus langchain-core
pip install "./clients/python[llama-index]"     # plus llama-index-core
```

With uv: `uv add ./clients/python --extra langchain`.

## Quick start

```python
from vid2context.langchain import VideoContextLoader

docs = VideoContextLoader("https://youtu.be/jNQXAC9IVRw").load()
print(docs[0].page_content)
print(docs[0].metadata)
```

```python
from vid2context.llama_index import VideoContextReader

docs = VideoContextReader(chunking="window", window_sec=90).load_data([
    "https://youtu.be/jNQXAC9IVRw",
    "https://www.youtube.com/watch?v=cCPsdFdlshc",
])
```

A whole playlist, channel or feed, expanded by the server first:

```python
docs = VideoContextLoader(
    "https://www.youtube.com/playlist?list=PL59FEE129ADFF2B12",
    expand=True,
    max_items=20,
    continue_on_failure=True,
).load()
```

The plain client:

```python
from vid2context import Client, Vid2ContextError

with Client() as v2c:
    print(v2c.health().version)
    ctx = v2c.context("https://youtu.be/jNQXAC9IVRw", lang="en")
    print(ctx.metadata.title, len(ctx.transcript.segments))
    print(v2c.transcript("https://youtu.be/jNQXAC9IVRw", timestamps=True))
    try:
        v2c.context("xxxxxxxxxxx")
    except Vid2ContextError as e:
        print(e.code, e.status, e.hint, [a.id for a in e.attempts])
```

`AsyncClient` has the same methods as coroutines (`async with AsyncClient() as v2c: await v2c.context(...)`). The loaders support `alazy_load()` / `aload()` (LangChain) and `aload_data()` (LlamaIndex) through it.

## Client

| Method | Route | Returns |
|---|---|---|
| `health()` | `GET /api/v1/health` | `Health`: version, runtime, transcript formats, providers (env var names only) |
| `context(url, mode=None, lang=None)` | `GET /api/v1/context` | `VideoContext` dataclass (`metadata`, `transcript.segments`, `attempts`, `raw` JSON) |
| `transcript(url, format="text", timestamps=False, mode=None, lang=None)` | `GET /api/v1/transcript` | `str` rendered by the server formatter; ids come from `health().formats` |
| `metadata(url)` | `GET /api/v1/metadata` | `VideoMetadata` (title, channel, duration, chapters) without fetching a transcript |
| `outline(url, mode=None, lang=None)` | `GET /api/v1/outline` | `Outline`: `chapters` (or five-minute sections) with `tokens` each, and `total_tokens` |
| `section(url, start=None, end=None, chapter=None, format="text", timestamps=False, mode=None, lang=None)` | `GET /api/v1/section` | `str`: one range (`start` to `end`, end exclusive) or one chapter (outline index or title). Times are seconds or `"m:ss"` / `"h:mm:ss"` strings. Pass at least one of them; the server answers `bad-request` otherwise |
| `items(url, limit=None)` | `GET /api/v1/items` | `list[VideoRef]`: a playlist, channel, feed or page expanded to videos; a single video returns itself |
| `formats()` | `GET /api/v1/formats` | `list[FormatInfo]` with `extension` |

Left out because `packages/server` does not mount them yet (November 2026): `search`, collections (`/collections/...`), jobs, and the intelligence routes (`/ask`, `/chat`, `/briefs`, `/extract`). The server does serve `/comments`, `/pack`, `/bundle` and `/library`; this client does not wrap them yet. Call them through `httpx` against the same base URL in the meantime.

`Client(base_url=None, api_key=None, timeout=300.0, *, headers=None, transport=None)`:

| Option | Default |
|---|---|
| `base_url` | `VID2CONTEXT_API_URL`, else `http://127.0.0.1:8787` (a trailing `/api/v1` is accepted) |
| `api_key` | `VID2CONTEXT_API_KEY`; sent as `Authorization: Bearer <key>` when set |
| `timeout` | 300 seconds, since a video without captions may go through speech-to-text |

`mode` is `auto`, `captions`, `stt` or `video`; `lang` is a BCP-47 tag.

Every failure raises `Vid2ContextError` with `code`, `message`, `hint`, `attempts` (list of `Attempt`) and `status`, parsed from the server's error body. Codes are the server's (`not-found`, `no-transcript`, `rate-limited`, ...). When the server cannot be reached the code is `upstream` and the hint says how to start it; a slow server gives `timeout`.

## Loader options

`VideoContextLoader(urls, chunking="chapters", window_sec=60, client=None, *, mode=None, lang=None, continue_on_failure=False, async_client=None, base_url=None, api_key=None, expand=False, max_items=None)`

`VideoContextReader(chunking="chapters", window_sec=60, client=None, *, ...)` takes the same options; URLs go to `load_data(urls)`.

| Option | Meaning |
|---|---|
| `urls` | One URL, YouTube id or server-readable path, or a list of them |
| `chunking="chapters"` | One document per chapter. A video without chapters is split into windows instead, and its documents say `chunking: "window"`, `chunking_requested: "chapters"` |
| `chunking="segments"` | One document per transcript segment (caption line) |
| `chunking="window"` | Documents of about `window_sec` seconds. A window starts at its first segment and takes each segment that starts before `start + window_sec`; segments are never split |
| `continue_on_failure` | Log a warning (Python `logging`, logger `vid2context`) and skip videos (or lists) that fail, instead of raising |
| `expand` | Send each URL through `GET /api/v1/items` first, so a playlist, channel, feed or page loads every video in it. A single video expands to itself. Off by default, so plain video URLs cost one request each and older servers without `/items` still work |
| `max_items` | With `expand`, the most videos taken from each list (default: the server cap, `VID2CONTEXT_MAX_PLAYLIST_ITEMS`) |

Document text is the raw transcript text of that chunk with whitespace collapsed; nothing is summarized. Each document gets a stable id, `<video_id>#<chunking>-<index>`, so loading the same video again upserts instead of duplicating.

## Metadata fields

| Field | Example |
|---|---|
| `source` | `https://www.youtube.com/watch?v=jNQXAC9IVRw` |
| `title` | `Me at the zoo` |
| `channel` | `jawed` |
| `video_id` | `youtube:jNQXAC9IVRw` (platform and native id) |
| `platform` | `youtube` |
| `start_sec`, `end_sec` | `5.0`, `17.0` |
| `url` | `https://www.youtube.com/watch?v=jNQXAC9IVRw&t=5s` (opens the video at `start_sec`) |
| `transcript_origin` | `creator-captions`, `auto-captions`, `native-transcript`, `stt` or `video-model` |
| `language` | `en` |
| `published_at` | ISO 8601, when the server knows it |
| `chunking` | `chapters`, `segments` or `window` |
| `chapter`, `chapter_index` | chapter title and position (chapters mode) |
| `segment_index` / `window_index` | position in the video (segments and window modes) |

Fields the server does not know are left out rather than set to `None`, because several vector stores reject `None` values. The LlamaIndex reader keeps `source`, `url`, `video_id` and the index fields out of the embedded text (`excluded_embed_metadata_keys`) but on the node for citations.

## Tests

```sh
cd clients/python
uv run pytest            # replays recorded server responses, no network
LIVE=1 VID2CONTEXT_API_URL=http://127.0.0.1:8787 uv run pytest tests/test_live.py
```

Unit tests replay real responses recorded from a running vid2context server through `httpx.MockTransport` (see [tests/fixtures/README.md](tests/fixtures/README.md)). To re-record them, run `uv run python scripts/record_fixtures.py`: it starts `packages/server` on a random local port, makes the calls, redacts emails and phone numbers, writes the fixtures and stops the server. Pass fixture names to record only those, and `--minimal` to serve the same app with only the YouTube, media-file and speech-to-text providers when the full registry does not load. A response with an unexpected status is retried and never replaces a good fixture. The live test starts nothing; it uses the server at `VID2CONTEXT_API_URL` and is skipped when that or `LIVE` is unset.

## Build and publish

```sh
cd clients/python
uv build                 # dist/vid2context-0.1.0-py3-none-any.whl and dist/vid2context-0.1.0.tar.gz
```

Publishing is not done from here; release tooling (roadmap item 38) owns it. The steps when it does: bump `version` in `pyproject.toml` and `__version__` in `src/vid2context/__init__.py`, run `uv run pytest`, `uv build`, then `uv publish` with a PyPI token (trusted publishing preferred), and tag the release `python-v<version>`.
