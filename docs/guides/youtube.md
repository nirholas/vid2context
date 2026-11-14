# YouTube

## Comments

Comments often hold what a video leaves out: owners' experiences, corrections from experts, and the creator's pinned clarifications. Ask for them with `getVideoContext(registry, url, { comments: 50 }, ctx)` (or `comments: true` for the default of 50). They come back in `VideoContext.comments`, a separate array that is never merged into the transcript. Comments are untrusted text written by the public: show them to a model as quoted material, not as instructions.

How they are fetched: keyless, through innertube `next` with the WEB client (no YouTube Data API key). The first call finds the comments section, then each continuation returns about 20 top-level threads. Paging stops as soon as the limit is reached, and `ctx.signal` is checked between pages.

| Setting | Default | What it does |
|---|---|---|
| `limit` (the `comments` number) | 50 | Top-level comments returned, 1 to 500. |
| `YOUTUBE_COMMENTS_SORT` | `top` | `top` (YouTube's ranking) or `newest`. Callers of `getYouTubeComments` can also pass `sort`. |
| `YOUTUBE_COMMENT_REPLIES` | 5 | Replies kept per expanded thread, 0 to 100. 0 turns reply fetching off (no extra requests). |
| `YOUTUBE_WEB_VERSION` | `2.20251110.01.00` | WEB client version. Raise it if YouTube starts rejecting the pinned one. Shared with metadata and browse. |

Replies cost one request per thread, so they are fetched for at most 20 threads: every thread the creator replied in first, then the 5 most liked threads with replies. Within a thread a creator reply is always kept, even when the reply limit is 1; the rest are filled in YouTube's order. If a thread is marked as having a creator reply that is not on the first page of replies, up to 3 reply pages are read to find it.

Each comment maps to the core `Comment` type:

- `id`, `author` (the display name, usually the `@handle`), `text` (plain text; links are kept as full URLs, emoji as characters, timestamps like `6:38` as written).
- `likes`: YouTube shows rounded counts (`1.2K`), so likes above 1,000 are approximate.
- `publishedAt`: approximate. YouTube only says "2 years ago", so the date is computed from that text and the time of the request. Day-or-longer units give a date only (`2024-11-14`); months count as 30 days and years as 365.
- `isCreator` (the author is the video's channel) and `isPinned`: set only when true. The pinned comment is always first.
- `replies`: present only on expanded threads.

Not represented: the creator's heart on a comment (the core type has no field for it, and nothing is added to the text), whether a comment was edited, and author channel ids.

When there are no comments to give, the result is `[]` with an info log saying why: comments turned off (for example videos made for kids), members-only or age-restricted videos, and videos with no comments yet. A video that does not exist, was removed or is private is an error, using the same error codes as captions. Each request goes through the shared YouTube transport, so a blocked IP fails fast with the same `blocked` error and hint as captions.

YouTube sends comments in two shapes: the WEB client uses entity payloads (`frameworkUpdates` mutations keyed from a `commentViewModel`), and the mobile web client still uses the classic `commentRenderer`. Both were seen live on 2026-11-14 and both are parsed.
