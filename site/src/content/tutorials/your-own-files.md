---
title: Your own audio and video files
label: Your own files
description: Upload an audio or video file to the vid2context HTTP API and get its transcript in any format, with a public-domain Apollo 11 clip you can send from the page.
order: 5
---

Not every video is on a platform. A recording of a meeting, a lecture you filmed, a podcast you downloaded: upload the file, and every route that takes a `url` accepts it.

## 1. Upload the file

`POST /uploads` takes a multipart form with one field, `file`. The answer holds an `input`, `upload:` followed by the file's SHA-256, that stands for the file in later requests.

The block sends a real 24-second clip of Neil Armstrong stepping onto the Moon (public domain, from NASA) unless you choose a file of your own.

```run upload
```

Facts worth knowing before you upload something large:

- The default size cap is 100 MB (`VID2CONTEXT_MAX_UPLOAD_MB`), the request limit of the Workers free plan.
- An upload is kept for 60 minutes (`VID2CONTEXT_UPLOAD_TTL_MIN`). The same bytes uploaded again are the same upload, with its time extended.
- Speech-to-text services take about 25 MB per request, so a video file is best reduced to compressed mono audio first: about 30 MB per hour at 64 kbit/s. The [web app](/app/) does this in your browser before it uploads.

## 2. Transcribe it

Run the upload above and its `input` fills in the field below. Uploads have no captions, so the transcript comes from the speech-to-text chain.

```run upload-transcript
```

An upload's transcript is kept next to the upload and expires with it; it is never saved in the library.

## Files on the server's own disk

A server you run yourself can also read local paths and `file://` URLs directly, without an upload. The CLI does the same:

```sh
{{cli}} ./meeting.mp4 --timestamps
```

Public servers refuse local paths (`VID2CONTEXT_PUBLIC=1`), so on those, upload. The [local files guide](/docs/guides/local-files/) covers formats, ffmpeg and direct media URLs.
