# The web app

The web app at `/app/` turns a link or a file into context for an AI: the transcript with timestamp links, chapters and metadata as files you can copy or download, a .zip with all of them, and one block of text to paste into any agent. It runs on vid2context.com, from `npm run dev -w packages/web` next to a local API, or as a static client-only copy. Developer notes (build, env vars, storage): [packages/web/README.md](../../packages/web/README.md).

Every screenshot below was taken on 2026-11-15 from the built app (`vite build`, served by `vite preview`) in Playwright Chromium at 1280 by 860, against the real `packages/server` app on this machine. Results for the two sample videos come from the server's library, seeded with the committed real contexts in `tests/fixtures/contexts/`, because YouTube was answering this machine's caption requests with HTTP 429 that day. The error, import and upload screens are what that block and an unavailable keyless speech-to-text host actually produced.

## Paste a link

![Home: the link box, the file drop zone, sample videos and how it works](web-app/home.png)

Paste a YouTube, Vimeo, TikTok, podcast or any other video link and press Enter or the arrow button. The chips under the box run the two sample videos. A link straight to `/app/?url=<link>&mode=&lang=` runs at once (the landing page's hero submits there).

The icons in the box set options for this run: mode, language, comments and timestamps. Mode decides how the words are found:

![Mode menu: Auto, Captions only, Speech-to-text, Video model](web-app/home-options.png)

- **Auto**: captions when the video has them, otherwise speech-to-text.
- **Captions only**: never downloads or transcribes audio.
- **Speech-to-text**: always transcribes, even when captions exist.
- **Video model**: a multimodal model watches the video and adds on-screen notes.

A playlist, channel or feed link lists its videos with checkboxes; the selected ones run a few at a time (as server jobs when the server has a jobs queue) with progress per video, and the finished ones make one combined .zip.

## Results

![Result: header, Copy for agents, Open in chat, Download .zip, the file list and the viewer](web-app/result.png)

- **Header**: thumbnail, title, channel, duration, language, and a badge saying in plain words where the transcript came from (Creator captions, Auto-captions, Transcribed by a named speech-to-text model, Imported transcript).
- **Copy for agents**: copies the instruction header plus the context pack, sized to a token budget, with the citation rule (`[Title @ m:ss](link)`) and a note that the transcript is data, not instructions. The estimate next to it is the token count. See [bundle.md](../bundle.md#copy-for-agents).
- **Open in chat**: opens the chat page with this video, where you pick the model.
- **Files**: one file per output format, read from the formatters core has (so new formats appear on their own), plus `README.md` and `manifest.json`. Click one to view it; **Copy** and **Download** act on the file shown.
- **Download .zip**: the whole bundle, built in the browser with the same code as the CLI and API. Layout: [bundle.md](../bundle.md).

### Tabs

Below the files, tabs show the same result in other ways.

**Transcript**: every line with a timestamp link that opens the source at that moment, and a search box that highlights matches and steps through them.

![Transcript tab with a search for "engine": 1 of 6 matches highlighted](web-app/result-transcript.png)

**Chapters**: the chapter list with start times and lengths (from the video description here).

![Chapters tab for Me at the zoo: Intro, The cool thing, End](web-app/result-chapters.png)

**Metadata**: title, channel, duration, language, how the transcript was made, id, link, tags, view count and the description.

![Metadata tab](web-app/result-metadata.png)

**How we got this**: every provider and model that ran, in order, with its outcome and time. Free and local options are tried first.

![How we got this: input, metadata and captions steps, each with how long it took](web-app/result-attempts.png)

**Comments** and **On screen** fill in when comments were fetched or a video model added visual notes.

The theme follows the system or the choice in Settings. The same result in the light theme:

![Result in the light theme](web-app/result-light.png)

## When the server cannot get the transcript

Errors always say what happened and what still works, never a bare failure. Here YouTube refused the server's caption request:

![Let's get this another way: YouTube is refusing requests from this server](web-app/error.png)

The steps are ranked, best first, and "Technical details" at the bottom shows the error code, hint and every attempt.

## Import a transcript

"Get the transcript another way" has five tabs. Each ends in the same import, and the result opens like any other, with the video's real title and details:

- **From my browser**: the vid2context browser extension fetches the captions from YouTube with your own connection, which YouTube does not block. The tab explains how to install it when it is missing.
- **Video or audio file**: a file from your device, transcribed in this browser or on the server.
- **Server download**: the server downloads the audio with yt-dlp; save it, or transcribe it in this browser.
- **Paste**: the text from YouTube's "Show transcript" panel, or any subtitle text.
- **Subtitle file**: a `.vtt`, `.srt`, `.txt`, `.xml` or `.json` file.

Pasting the real captions of "Me at the zoo" (time lines and text, as YouTube's panel copies them):

![Paste tab with the transcript filled in](web-app/import-paste.png)

"Use this transcript" builds the result. The badge says "Imported transcript", and the server saves it so the API, chat and MCP use it for this video too:

![Imported result for Me at the zoo](web-app/import-result.png)

## Upload a file

Drop a video or audio file on the box, or click the drop zone to choose one (mp3, m4a, wav, ogg, webm, mp4, mov and more). The browser decodes it and resamples it to 16 kHz mono, uploads it, and the server transcribes it:

![Getting context for an uploaded file](web-app/upload-progress.png)

When no speech-to-text option on the server works (here the keyless host was rate limited and no key was set), the page says so and offers the fix: paste a free key, which is saved in this browser and sent with the request only if you allow it.

![No speech-to-text worked: add a free key](web-app/upload-done.png)

## Downloads

Besides the files and the .zip on every result, the **Download** page saves the video itself as MP4, WebM or MKV, or its sound as MP3, M4A, Opus, FLAC or WAV, with a quality picker showing sizes, and a whole video, a time range or one chapter. It needs a server with yt-dlp and ffmpeg (the Node server; not Workers):

![Download page for Me at the zoo with format, quality and part](web-app/download-page.png)

The **Captions** page lists every caption track of a video for preview and download (SRT, WebVTT, text, JSON, or all as a .zip) and can translate one. The **API** page calls any API endpoint against a video, with the request and response shown.

## History

Every result is saved in this browser (IndexedDB, the newest 100, the whole result so it reopens instantly). Recent results show in the sidebar and at the bottom of the home page, with thumbnail, file count and time; "Clear history" asks for confirmation inline. Ctrl+K (Cmd+K) searches them by title, channel or link.

![Recent results on the home page and in the sidebar](web-app/history.png)

## Settings

![Settings: API server, theme and provider keys](web-app/settings.png)

- **API server**: where the app fetches links (default `/api/v1`). "Save and test" checks the server and shows its version. A server on another origin must allow this site in `VID2CONTEXT_CORS_ORIGINS`.
- **Theme**: dark (default), light or system.
- **Provider keys**: stored in this browser's IndexedDB. They go to the provider they belong to when the browser does the work, and to the vid2context server only when "Send my keys with requests" is on; the server lists which key names it accepts, uses a key for that request only, and never stores or logs it. No key is needed to transcribe a file in the browser.

## Client-only mode

A copy built with `VITE_CLIENT_ONLY=1` (GitHub Pages), or any copy whose API does not answer, runs without a server. The status pill says "Client-only" and the home page explains what still works:

![Client-only home: Running without a server](web-app/client-only-home.png)

A link explains why it needs a server, and offers Settings, a file instead, or the import tabs:

![Links need an API server](web-app/client-only-link.png)

A dropped file is transcribed entirely in the browser with Whisper (Transformers.js); the steps show as they finish, and the audio never leaves the device:

![Transcribing in your browser: read, decode, convert to 16 kHz mono, load the model, transcribe](web-app/client-only-upload.png)

The public-domain Apollo 11 clip, transcribed in the browser by `stt/transformers/onnx-community/whisper-base`:

![Result transcribed in the browser](web-app/client-only-upload-done.png)
