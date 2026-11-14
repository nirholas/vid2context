# web-page fixtures

Real pages and responses, recorded on 2026-11-14 with curl (user agent `vid2context`) from a Google Cloud datacenter IP. The HTML pages were trimmed with the same steps so they stay small but keep their structure and every element discovery looks at:

- removed every `<script>` except `application/ld+json`, and every `<style>`, `<svg>`, `<noscript>` and `<template>` element and HTML comment;
- removed `style` attributes and `class` attributes (except classes containing `wistia`);
- collapsed runs of spaces and blank lines.

No file contains an IP address or email address (checked with grep).

| File | Source | What it exercises | Extra trimming |
|---|---|---|---|
| `openculture-ts-eliot.html` | https://www.openculture.com/2012/07/ts_eliot_reads_his_modernist_masterpieces.html | A protocol-relative YouTube iframe (`//www.youtube.com/embed/...`), a Vimeo iframe, an anchor to a YouTube watch page, a WordPress oEmbed link that points at the article itself (not a video), page title, language and image | The reader comment thread (`<div id="commentblock">`, 25 comments with commenter names) was removed. |
| `ted-do-schools-kill-creativity.html` | https://www.ted.com/talks/sir_ken_robinson_do_schools_kill_creativity | `og:video:url` and a JSON-LD `VideoObject` with `embedUrl`, `contentUrl`, `name`, `uploadDate`, `duration`, `inLanguage`, `author` and a full `transcript` (TED HTML-escapes inside the JSON) | None. |
| `w3schools-html5-video.html` | https://www.w3schools.com/html/html5_video.asp | Two `<video>` elements with relative `<source src="mov_bbb.mp4">` and `.ogg` children (the same files twice), and `<source srcset>` inside `<picture>` that must be ignored | Lines holding the site's two contact email addresses were removed. |
| `wistia-home.html` | https://wistia.com/ | `og:video` pointing at an mp4 file and three `<wistia-player media-id>` elements | None. |
| `youtube-watch-jNQXAC9IVRw.html` | https://www.youtube.com/watch?v=jNQXAC9IVRw | One video described by a JSON-LD `VideoObject` (identified by `@id`), `og:video:url` and an oEmbed link | The JSON-LD `comment` array (viewer comments with their handles) was removed. |
| `openculture-404.html` | https://www.openculture.com/this-page-does-not-exist-vid2context-test | HTTP 404 page | None. |
| `responses.json` | the URLs it names | Real status codes, `Location` headers and bodies of two redirects (Open Culture http to https, absolute; TED old slug to new slug, relative), the `content-type` of each page above, and a non-HTML response (Vimeo oEmbed JSON for video 7602340, `application/json`) | None. |
