# Examples

Runnable examples for every way to use vid2context: the TypeScript library, the CLI, the HTTP API, the MCP server, LangChain and Python. Each one is a real file in [examples/](../../examples/) that you can run from a checkout. The code on these pages is copied from those files, so what you read is what runs.

## Run them

From a checkout, with Node 22 or newer:

```sh
git clone https://github.com/nirholas/vid2context.git
cd vid2context
npm install
npx tsx examples/library/render-formats.ts
```

No keys are needed for any example. Keys in your environment or `./.env` add more rungs (see [Providers and rungs](../providers.md)), and the examples pick them up.

**Offline** examples read real transcripts recorded from YouTube (`tests/fixtures/contexts/`) and make no network calls. The output shown under them is produced by running them, and the tests fail if it changes.

**Live** examples call real services: YouTube, the keyless Whisper host, the free-first LLM chain. Their output is a recorded run, made on 2026-11-14 with no keys set. Your output will differ in wording where a model wrote it.

## All examples

| Example | What it shows | Needs |
|---|---|---|
| [library/render-formats.ts](library.md#render-every-format) | text, timestamps, SRT, WebVTT, Markdown, context pack | offline |
| [library/outline-and-sections.ts](library.md#read-a-long-video-outline-first) | outline with token counts, then one section by index or time | offline |
| [library/chunk-for-rag.ts](library.md#chunk-for-retrieval-and-fit-a-token-budget) | token-bounded chunks with overlap, a budget across videos | offline |
| [library/clean-captions.ts](library.md#clean-up-auto-captions) | rule-based cleanup of auto-captions, with its report | offline |
| [library/search-transcripts.ts](library.md#search-across-videos) | keyword search with phrases and exclusions, timestamp links | offline |
| [library/context-bundle.ts](library.md#build-a-context-bundle-zip) | a .zip of every format, context.md, manifest and README | offline |
| [library/get-transcript.ts](library.md#get-a-transcript-from-a-url) | the full pipeline for a URL or file, with the attempts list | live |
| [library/transcribe-file.ts](library.md#transcribe-a-local-file) | speech-to-text for a local mp3 | live |
| [library/ask-a-video.ts](library.md#ask-a-question-with-citations) | an answer with verified `[n]` citations | live |
| [library/expand-playlist.ts](library.md#a-playlist-into-one-context-pack) | playlist to videos to one context pack | live |
| [cli/transcript-recipes.sh](cli.md#one-video) | formats, jq over JSON, `--out` | live, jq |
| [cli/playlist-recipes.sh](cli.md#a-playlist) | `list`, `pack`, `bundle` | live |
| [cli/local-file.sh](cli.md#a-local-file) | transcribe a file, see which rung worked, save SRT | live |
| [http/in-process.ts](http-api.md#without-a-server) | the HTTP app called with Request objects, no server | offline |
| [http/curl.sh](http-api.md#with-curl) | every common route with curl | live, server, jq |
| [http/client.ts](http-api.md#a-typed-fetch-client-with-streaming) | typed fetch client, streaming `/chat` answers | live, server |
| [mcp/in-process.ts](mcp.md#in-one-process) | an MCP client and the server over the in-memory transport | offline |
| [mcp/stdio-client.ts](mcp.md#over-stdio) | spawn the server over stdio like an agent does | live |
| [langchain/loader.ts](python-and-langchain.md#langchainjs) | LangChain.js Documents with timestamp metadata | live, server |
| [python/client_basics.py](python-and-langchain.md#the-python-client) | the Python client: outline, section, errors, `/ask` | live, server |
| [python/langchain_loader.py](python-and-langchain.md#langchain-python) | LangChain Documents in Python | live, server |
| [python/llama_index_reader.py](python-and-langchain.md#llamaindex) | LlamaIndex Documents in 90-second windows | live, server |

"Server" means the HTTP API is running: `npm run start:server` in another terminal (it listens on `http://127.0.0.1:8787`). Those examples take another base URL as their first argument.

## How these pages stay correct

`npm test` runs every offline example and compares its output, and every code block on these pages, with what is on disk. `LIVE=1 npm test` also runs the live examples, starting a server for the ones that need it. When you change an example, or a change elsewhere changes what an example prints, rewrite the blocks with:

```sh
npm run examples:docs            # rewrite the code and output blocks on these pages
npm run examples:docs -- --check # only list what is out of date
```

A new example needs a header comment that says how to run it and starts a line with `Offline:` or `Live,`. It also needs a block on one of these pages: `<!-- example: examples/<path> -->` before its code fence, and for offline examples `<!-- output: examples/<path> -->` before an output fence. The sync script and tests are in [examples/docs-sync.ts](../../examples/docs-sync.ts) and [examples/test/](../../examples/test/).
