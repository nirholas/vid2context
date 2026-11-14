# examples

Runnable examples for vid2context. Every file runs from the repo root after `npm install`, and none needs a key.

| Folder | Run with |
|---|---|
| [library/](library/) | `npx tsx examples/library/<file>.ts` |
| [cli/](cli/) | `bash examples/cli/<file>.sh` |
| [http/](http/) | `npx tsx examples/http/<file>.ts`, `bash examples/http/curl.sh` |
| [mcp/](mcp/) | `npx tsx examples/mcp/<file>.ts` |
| [langchain/](langchain/) | `npx tsx examples/langchain/loader.ts` |
| [python/](python/) | `python examples/python/<file>.py` after `pip install ./clients/python` |

The header of each file says how to run it and whether it is offline (recorded transcripts, no network) or live. The walkthrough, with the output of every example, is in [docs/examples](../docs/examples/README.md).

After changing an example, run `npm run examples:docs` to update the docs pages, then `npm test`. `LIVE=1 npm test` also runs the live examples, starting an HTTP server on a free port for the ones that need one.
