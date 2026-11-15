---
title: Your own files
label: Your own files
description: Runnable requests that upload an audio or video file to the vid2context HTTP API and transcribe it, or import a transcript you already have, with a public-domain Apollo 11 clip you can send from the page.
order: 6
---

## Upload a file

```run upload
```

## Transcribe the upload

Run the upload first: its `input` fills in this field.

```run upload-transcript
```

## Import a transcript you already have

When you already have a transcript (captions you corrected, a file from your editor, a transcript you have the rights to), import it instead of transcribing. Edit the text and run it: your wording and timing are kept, and `origin` is `imported` so nothing downstream mistakes it for the platform's captions.

```run import-transcript
```

[Your own audio and video files](/docs/tutorials/your-own-files/) covers size limits, how long uploads last and local paths.
