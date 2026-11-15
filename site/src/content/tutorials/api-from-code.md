---
title: Call the API from your code
label: The API from code
description: Use the vid2context HTTP API from JavaScript or Python the robust way: the error shape and codes, retries with Retry-After, API keys, ETag caching, jobs and timeouts.
order: 7
---

Every block on these pages has JavaScript and Python versions of its request. This tutorial covers what those short snippets leave out: how errors look, which ones to retry, and the headers that save work.

## Errors have one shape

Every route answers errors with the same body: a stable `code` to branch on, a `message`, a `hint` that says how to recover, and `attempts`, every provider and rung that ran. Run this one, a video id that does not exist:

```run transcript-error
```

The status follows the code:

| Code | Status | Retry? |
|---|---|---|
| `bad-request`, `unsupported-input` | 400 | No: fix the request |
| `unauthorized` / `forbidden` | 401 / 403 | No: check the API key and its scope |
| `unavailable` | 403 | No: private, members-only or region-locked |
| `not-found` | 404 | No |
| `too-large` | 413 | No: send less |
| `no-transcript` | 422 | Later, or with `mode=stt` when captions are missing |
| `rate-limited` | 429 | Yes, after `Retry-After` seconds |
| `all-rungs-failed`, `upstream` | 502 | Yes, with backoff |
| `auth` | 502 | No: a key the server holds for an upstream service failed; its operator fixes it |
| `blocked`, `no-provider` | 503 | `blocked` yes, later; `no-provider` no |
| `timeout` | 504 | Yes, or ask for less |

The full list lives in the [HTTP API contract](/docs/contracts/http-api/#errors).

## A client that retries

This is a complete client for Node 22 or newer (or a browser): it retries rate limits and upstream failures, honours `Retry-After`, sends a key when one is set, and throws an error that keeps the code and the hint.

```js
const BASE = process.env.VID2CONTEXT_URL ?? 'http://127.0.0.1:8787';
const KEY = process.env.VID2CONTEXT_API_KEY;
const RETRY = new Set([429, 502, 503, 504]);
const FINAL = new Set(['no-provider', 'auth']);

export class ApiError extends Error {
  constructor(status, body) {
    super(`${body.error?.code ?? status}: ${body.error?.message ?? 'request failed'}`);
    this.status = status;
    this.code = body.error?.code;
    this.hint = body.error?.hint;
    this.attempts = body.attempts ?? [];
  }
}

export async function api(path, { params, body, tries = 4 } = {}) {
  const url = new URL(`/api/v1${path}`, BASE);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));
  const headers = { ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) };
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
    if (res.ok) return res.headers.get('content-type')?.includes('json') ? res.json() : res.text();
    const error = await res.json().catch(() => ({}));
    if (!RETRY.has(res.status) || FINAL.has(error.error?.code) || attempt >= tries) throw new ApiError(res.status, error);
    const wait = Number(res.headers.get('retry-after')) || 2 ** attempt;
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

console.log(await api('/transcript', { params: { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', timestamps: 1 } }));
```

The same in Python, with the standard library only:

```python
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("VID2CONTEXT_URL", "http://127.0.0.1:8787")
KEY = os.environ.get("VID2CONTEXT_API_KEY")
RETRY = {429, 502, 503, 504}
FINAL = {"no-provider", "auth"}


class ApiError(Exception):
    def __init__(self, status, body):
        error = body.get("error", {})
        super().__init__(f"{error.get('code', status)}: {error.get('message', 'request failed')}")
        self.status, self.code, self.hint = status, error.get("code"), error.get("hint")
        self.attempts = body.get("attempts", [])


def api(path, params=None, body=None, tries=4):
    url = f"{BASE}/api/v1{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    headers = {"Authorization": f"Bearer {KEY}"} if KEY else {}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    for attempt in range(1, tries + 1):
        req = urllib.request.Request(url, data=data, headers=headers, method="POST" if data else "GET")
        try:
            with urllib.request.urlopen(req, timeout=300) as res:
                text = res.read().decode()
                return json.loads(text) if "json" in res.headers.get("Content-Type", "") else text
        except urllib.error.HTTPError as err:
            try:
                error = json.load(err)
            except ValueError:
                error = {}
            code = error.get("error", {}).get("code")
            if err.code not in RETRY or code in FINAL or attempt == tries:
                raise ApiError(err.code, error) from None
            time.sleep(float(err.headers.get("Retry-After") or 2**attempt))


print(api("/transcript", {"url": "https://www.youtube.com/watch?v=jNQXAC9IVRw", "timestamps": 1}))
```

## API keys

A server open to the internet sets `VID2CONTEXT_API_KEYS`; then every route except `/health` needs `Authorization: Bearer <key>`. A key can be limited to a scope: `read` allows `GET` and the POST routes that only compute an answer (`/pack`, `/bundle`, `/ask`, `/research` and the like), `write` adds every other change, and `admin` allows everything. A missing or wrong key answers `401`, a key without the scope `403`. The gear button on any block sets a key for the runnable examples.

## Save work with ETags

`/context` sends an `ETag`. Keep it with your copy and send it back as `If-None-Match`; when nothing changed, the server answers `304` with no body.

```run context
```

```sh
curl -i 'https://vid2context.com/api/v1/context?url=jNQXAC9IVRw' \
  -H 'If-None-Match: "<the etag you kept>"'
```

Contexts are also saved in the server's library, so asking again for a video you already fetched is fast even without the header. Add `refresh=1` to rebuild one, for example after the creator fixed the captions.

## Long work: jobs and timeouts

- A request that runs longer than `VID2CONTEXT_REQUEST_TIMEOUT_MS` (5 minutes by default) answers `504 timeout`.
- Briefs and extractions run as jobs on servers that have a queue: `202` with a Job, then `GET /api/v1/jobs/{id}` until `status` is `succeeded`, `failed` or `canceled`. `GET /api/v1/jobs/{id}/events` streams the progress as server-sent events instead of polling. [Cited answers and briefs](/docs/tutorials/cited-answers/#3-a-cited-brief) runs one.
- Every response carries `X-Request-Id`; send your own (up to 128 characters of `A-Za-z0-9._:-`) to find a request in the server's access log.

## The whole API

`GET /api/v1/openapi.json` describes every route the server has, generated from the routes themselves, for client generators and agents. The [HTTP API guide](/docs/guides/http-api/) and the [contract](/docs/contracts/http-api/) describe each one.
