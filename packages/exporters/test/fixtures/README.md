# Exporter test fixtures

| File | What it is | Recorded |
|---|---|---|
| `youtube-jNQXAC9IVRw.comments.json` | Real `Comment[]` returned by the YouTube source's `getComments` (`providers/youtube`, innertube, no key) for "Me at the zoo" (`youtube:jNQXAC9IVRw`). Trimmed to the first two top-level comments with two replies each; nothing else changed. No emails, phone numbers or links were present. The tests attach it to `tests/fixtures/contexts/youtube-jNQXAC9IVRw.json` as `context.comments`, which is what the pipeline does when `comments` is requested. | 2026-11-14, live from a GCP VM with `getComments(ref, ctx, { limit: 6 })` |

The full pipeline could not record a context with comments in one run that day, because YouTube answered caption requests from the VM with HTTP 429 (automated-traffic block). Metadata and comments still answered, so the comments were recorded on their own.
