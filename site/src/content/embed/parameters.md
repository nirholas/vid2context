---
title: Embed parameters
label: Parameters
description: Every option of the vid2context embed widget, as a query parameter of /embed/ or an attribute of vid2context-embed, with defaults, accepted values and examples.
order: 1
---

Every option is a query parameter of `/embed/` and an attribute of `<vid2context-embed>` with the same name. Leave a parameter out to use its default. The widget checks every value: a bad one shows an error in the widget (code `bad_param`) instead of being ignored silently.

## All parameters

{{embed.params}}

## Where the context comes from

Give exactly one source. When more than one is set, `sample` wins, then `src`, then `url`.

- `url`: the widget calls `GET /api/v1/context?url=...` on the server that serves it, or on `api` when set. `lang` and `mode` are passed along.
- `sample`: a recorded context served by this site. No API call, so it is the quickest way to try a layout. The samples:

  {{embed.samples}}

- `src`: any URL that returns a VideoContext JSON, for example a file you saved with `vid2context <url> --format json` and host next to your page. The host must send `Access-Control-Allow-Origin` for the widget's origin (or `*`).

## Examples

A searchable transcript in a light theme with a blue accent:

```text
https://vid2context.com/embed/?url=https://www.youtube.com/watch?v=jNQXAC9IVRw&theme=light&accent=3b82f6
```

The video above its transcript, with the current line highlighted as it plays:

```text
https://vid2context.com/embed/?url=https://www.youtube.com/watch?v=jNQXAC9IVRw&player=1
```

A quote of the lines between 0:05 and 0:13, with a link to that moment:

```text
https://vid2context.com/embed/?sample=zoo&view=quote&start=0:05&end=0:13
```

Only the first two minutes of a long video, without the header or the credit line:

```text
https://vid2context.com/embed/?url=https://www.youtube.com/watch?v=cCPsdFdlshc&end=2m&header=0&branding=0
```

A widget that reads a context file you host:

```text
https://vid2context.com/embed/?src=https://example.org/contexts/talk.json
```

Try any of them in the [builder](/docs/embed/), which writes the address for you.

## Sizing

An iframe has the height you give it. The transcript and chapters views scroll inside that height, and the quote, card and link box views are as tall as their content. The builder's snippets use a height that fits the view. The web component sizes the iframe for you: up to `max-height` (default 640) for the views that scroll, and exactly to the content for the others. Set `height` on the element to fix it instead.
