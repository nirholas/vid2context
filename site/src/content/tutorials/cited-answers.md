---
title: Cited answers and briefs
label: Cited answers and briefs
description: Ask questions about videos and get answers whose citations are checked against the transcript, stream them, build a cited brief as a background job, and extract structured data.
order: 5
---

The routes in this tutorial put a language model on top of the transcripts. They run on the free LLM chain (keyless rungs need no account), and they never trust the model's citations blindly: every quote is looked up in the transcript near the time it claims, and claims that fail the check are reported separately.

## 1. Ask a question

`POST /ask` takes a question and the videos to answer from. The answer cites sources by number; `citations` holds each one with its video, its time range, a timestamp link and the quote, and `unverified` lists the numbers whose quote was not found.

```run ask
```

`rung` and `model` say which model answered. With no keys set that is a keyless rung; add a key to the server and its free-tier rungs are tried first.

## 2. Stream it

The same request with `"stream": true` answers with server-sent events, so a chat interface can show the answer as it is written:

- `meta` once at the start: the rung, the sources and the prompt size;
- `delta` with each piece of the answer;
- `done` with the full text and the verified citations, or `error`.

```run ask-stream
```

The JavaScript and Python snippets show how to read the stream without a library.

## 3. A cited brief

`POST /briefs` writes a whole document: findings grouped by theme, where the videos agree and disagree, and the sources, as Markdown and as structured `claims`. Every claim in the body carries a citation that passed the check; the ones that did not go to an appendix, uncited.

A brief takes longer than an HTTP request should wait, so a server with a jobs queue (the Node server has one) answers `202` with a Job right away. The block polls `GET /api/v1/jobs/{id}` every second and a half and shows the result when the job succeeds. A server without a queue answers `200` with the brief itself; the snippets handle both.

```run brief
```

Pick another **Template** for a different shape: `summary`, `buyer-guide`, `comparison` or `tutorial-steps`.

## 4. Structured data

`POST /extract` returns JSON instead of prose. Use a built-in template:

```run extract-template
```

Or send your own JSON Schema. The data comes back matching the schema, and each value that came from a video has a citation with its JSON path.

```run extract-schema
```

## Next

- [Your own audio and video files](/docs/tutorials/your-own-files/).
- [Answer and brief examples](/docs/examples/answers/), with key moments and generated chapters.
- The [Cited briefs guide](/docs/guides/briefs/) explains the citation check and the map-reduce strategy for many videos.
