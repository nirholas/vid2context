---
title: Embed vid2context on your site
label: Overview and builder
description: Put a searchable, timed transcript, a chapter list, a quote or a video card on any page with one iframe or the vid2context-embed web component. Build the embed live in the page.
order: 0
---

Any page can show what vid2context knows about a video: the transcript with timestamps, the chapters, a quoted passage with its time, or a small card. The widget is a page on this site, `/embed/`, made to live in an iframe. It reads its options from the address, fetches the video's context from the API, and renders it in your theme. Nothing to install and no key.

There are three ways to embed it:

- **An iframe.** Paste the HTML. Works anywhere that accepts an iframe: WordPress, Notion, Ghost, Webflow, plain HTML.
- **The web component.** Add `/embed.js` once, then write `<vid2context-embed url="...">`. It sizes itself to its content, turns the widget's messages into DOM events, and has `seek()`, `search()` and `load()` methods.
- **A link.** Where iframes are not allowed (a GitHub README, an email), link to the widget address. It works as a page on its own.

## Build an embed

Change any option and the preview, the widget address and the code update at once. The preview is the real widget, so clicking a line in it sends the events listed under it, and the buttons under **Drive it from the page** send the commands your page can send. **Copy link to this setup** gives you an address that reopens the builder with the same options.

```widget embed-builder
```

The builder starts from a recorded sample, so the preview works without calling the API. Switch the source to **Video URL** to try a real video: the widget then calls `GET /api/v1/context` on this site. YouTube sometimes blocks cloud servers; when a video fails here, the widget shows the error and a link to the app, and the same embed pointed at your own server (the `api` option) will usually work.

## What each view looks like

These are live widgets, each one an iframe with the snippet under it.

```widget embed-gallery
```

## How it works

1. The iframe loads `/embed/?url=<video>` from this site (or from your own deployment).
2. The widget calls `GET /api/v1/context` on the same server, so no CORS setup is needed. With `sample` it reads a recorded file instead, and with `src` it reads a VideoContext JSON you host.
3. It renders the view with the text set as plain text, never as HTML, and posts `ready`, `loaded` and `resize` messages to your page.
4. Clicks post `segment` messages. With `player=1` on a YouTube video, the widget also follows playback and posts `seek` as the current line changes.

The widget makes no third-party request unless you ask for one: `player=1` loads the YouTube player from `youtube-nocookie.com`, and the card view loads the video's thumbnail.

## Next

{{pages:embed}}
