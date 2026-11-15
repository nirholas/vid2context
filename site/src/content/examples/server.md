---
title: Server and models
label: Server and models
description: Runnable requests that describe a vid2context server: its health and version, a deep readiness check, the output formats, every model rung by tier, and the OpenAPI document.
order: 7
---

These requests need no video. Use them to check that a server is up, which formats it renders and which models it can reach with the keys it has.

## Health

```run health
```

`enabled` on a rung means its credentials are present and its tier is allowed. Keyless rungs need nothing, so a fresh server can already transcribe and answer questions.

## Readiness

`/healthz` is for container probes. Without `deep` it only says the process is up, which is what a liveness probe wants. With `deep=1` it checks everything a request needs and answers `503` when a required check fails, so a readiness probe holds traffic until the server can serve it.

```run healthz
```

## Formats

```run formats
```

## Models

```run models
```

Pick a kind to narrow the list. The same rows, grouped by tier, are in [Providers and rungs](/docs/providers/).
