# packages/insights test fixtures

- `contexts/youtube-<id>.json`: real `VideoContext` output for public YouTube videos, written by `scripts/record-contexts.ts`. In `youtube-ovIkN7UgbgE.json` a contact email address and phone number in the video description were replaced with `[email redacted]` and `[phone redacted]`; nothing else was changed. The same applies to `youtube-1Xx1fmHIsiA.json`, where a contact email address in the description was replaced with `[email redacted]`.
- `llm/*.json`: real LLM responses recorded by `scripts/record-llm.ts` and replayed by the tests.
