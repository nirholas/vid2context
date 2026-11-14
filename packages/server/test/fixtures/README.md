# Server test fixtures

| File | Source | Used by |
|---|---|---|
| `site/index.html` | Copy of the repo's landing page `site/index.html` as committed in `bcb5097` (copied 2026-11-14). Kept here because `site/` is being rebuilt with Astro and its files move. No personal data. | `discovery.test.ts`: HTML fall-through with `Vary` and `Link` headers |

Every other response the server tests replay is a recording owned by another package, used read-only:

- `providers/youtube/test/fixtures/`: innertube player, next and comments responses, timedtext payloads.
- `providers/stt-openai-compatible/test/fixtures/ovh-whisper-large-v3-turbo.verbose.json`: OVH Whisper transcribing `tests/fixtures/media/apollo11-small-step.mp3`.
- `packages/skips/test/fixtures/`: SponsorBlock `skipSegments` responses and the real `CrO0Timw2z4` VideoContext.
- `tests/fixtures/contexts/` and `tests/fixtures/media/apollo11-small-step.mp3`: shared VideoContext output and public-domain audio.
