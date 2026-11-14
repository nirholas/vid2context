---
title: vid2context vs plain Whisper
label: vs plain Whisper
description: Whisper transcribes audio you already have. vid2context fetches the video, uses existing captions first, and runs Whisper-class models free-first only when it has to.
order: 3
---

[Whisper](https://github.com/openai/whisper) (MIT) is a speech recognition model. Point it at an audio file and it writes a transcript. vid2context uses Whisper-class models too, but it starts from a link, checks for captions first, and picks a Whisper rung (local, free tier or keyless) only when the video has none.

## What each one does

| | Whisper | vid2context |
|---|---|---|
| Input | An audio or video file on disk | A link or a file |
| Uses existing captions | No, always transcribes | Yes, captions first |
| Where it runs | Your machine; a GPU helps for large models | Your machine, or free hosted rungs when you have no GPU |
| Setup | Python, PyTorch, ffmpeg, a model download | Node.js; nothing else for captions and keyless rungs |
| Metadata and chapters | No | Yes |
| Output | Text, SRT, VTT, JSON | {{formats.ids}}, a .zip, MCP tool results |
| License | MIT | Apache-2.0 |

## When to pick plain Whisper

- You have audio files and a GPU, and you want full control of the model and its decoding options.
- Nothing may leave your machine and you do not need anything but the text.

## When to pick vid2context

- Your input is a link. Most YouTube videos already have captions, which cost nothing and take a second.
- You have no GPU: free hosted Whisper rungs do the work, and local ones (whisper.cpp, Transformers.js) run first when you set them up.
- You want the transcript in your agent with timestamps and chapters.

## The same model, either way

This is what the keyless OVH `whisper-large-v3-turbo` rung returned for a public-domain Apollo 11 clip, recorded from the real service:

```text
{{whisper.text}}
```

To keep everything local, set up whisper.cpp and set `VID2CONTEXT_POLICY=local-only`. See [Transcribe a video with Whisper for free](/docs/how-to/transcribe-a-video-with-whisper-for-free/).
