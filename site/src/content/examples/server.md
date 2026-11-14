---
title: Server and models
label: Server and models
description: Runnable requests that describe a vid2context server: its health and version, the output formats, every model rung by tier, and the OpenAPI document.
order: 6
---

These requests need no video. Use them to check that a server is up, which formats it renders and which models it can reach with the keys it has.

## Health

```run health
```

`enabled` on a rung means its credentials are present and its tier is allowed. Keyless rungs need nothing, so a fresh server can already transcribe and answer questions.

## Formats

```run formats
```

## Models

```run models
```

Pick a kind to narrow the list. The same rows, grouped by tier, are in [Providers and rungs](/docs/providers/).
