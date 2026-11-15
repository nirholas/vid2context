# Web e2e fixtures

| File | Source |
|---|---|
| `context-blocked-xAcTmDO6NTI.json` | The body of a real `GET /api/v1/context?url=https://www.youtube.com/watch?v=xAcTmDO6NTI&mode=captions` answer (HTTP 503) from a vid2context server on this repo's GCP VM, 2026-11-14, while YouTube answered its timedtext requests with HTTP 429. `import.spec.ts` serves it for `/context`, so the blocked error panel and the import panel are the real ones |

The body is pretty-printed (Biome formats JSON outside `test/fixtures`); nothing in it was changed. It holds no IP address or other personal detail (checked by hand). To re-record, run the same request against a server whose IP YouTube blocks and save the body as is.
