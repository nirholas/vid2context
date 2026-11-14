---
title: Transcribe a video with Whisper for free
label: Transcribe with Whisper for free
description: Transcribe any video or audio file with Whisper at no cost: keyless hosted Whisper with no account, free tiers with your own key, or Whisper on your own machine.
order: 5
---

vid2context transcribes any video or audio file with Whisper-class models and never charges you for it. It tries, in order: Whisper on your machine, hosted free tiers with your own key, and keyless hosts that need no account at all. Paid services are used only when you set their key.

## Transcribe a file with no setup

From a clone of the repo, with no keys set:

```sh
git clone https://github.com/nirholas/vid2context.git
cd vid2context
npm install
{{cli}} tests/fixtures/media/apollo11-small-step.mp3 --timestamps
```

That file is Neil Armstrong's first words on the Moon (public domain, {{whisper.durationSec}} seconds). This is the transcript the keyless OVH `whisper-large-v3-turbo` rung returned for it, recorded from the real service and rendered by vid2context:

```text
{{whisper.text}}
```

Detected language: `{{whisper.language}}`. MP3 and WAV work as they are; other audio and video formats need ffmpeg installed so the audio can be extracted. Links work too: for a YouTube video with captions, add `--mode stt` to skip the captions and transcribe the audio instead.

## Keyless, no account

These rungs need nothing:

{{sttKeyless.list}}

Keyless hosts allow only a few requests per minute per IP, and they receive your audio. When one rate-limits, the chain cools it down and moves on. Set `VID2CONTEXT_KEYLESS=0` to never use them.

## Free tiers with your own key

A free key is faster and has higher limits. Each of these is free to sign up for:

{{sttFree.list}}

Put the key in `.env` at the repo root (every key is optional; `.env.example` lists them all).

## On your own machine

Local rungs run first and send nothing anywhere:

{{sttLocal.list}}

The quickest is whisper.cpp: `npx tsx providers/stt-whisper-cpp/src/setup.ts` installs the official binary (checksum verified), downloads a model, and prints the env lines to add. To make sure nothing ever leaves your machine, set `VID2CONTEXT_POLICY=local-only`.

## Long files

Hosted rungs cap upload size (Groq takes 25 MB per file), so long audio is split into chunks, transcribed, and joined back with correct timestamps. MP3 and WAV split without extra tools; other formats split with ffmpeg.

## Where the transcript goes

Raw transcripts are always kept. Ask for any format with `--format` ({{formats.ids}}), or hand the file to your agent through the [MCP server](/docs/how-to/youtube-transcript-mcp-server/), which accepts local file paths too.
