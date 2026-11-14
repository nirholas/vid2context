# n8n-nodes-vid2context

n8n community nodes for [vid2context](https://github.com/nirholas/vid2context): fetch a video's transcript, metadata or full context, and start workflows when vid2context ingests a video, updates a collection, finishes a job or has a brief ready. For example: "a new G-Wagon video arrived, summarize it and message me".

n8n is free to self-host, and the nodes need only a running vid2context server.

## Nodes

**vid2context** (action node). Operations:

| Operation | API call | Output |
|---|---|---|
| Get Transcript | `GET /api/v1/transcript` | `{ url, format, contentType, transcript }`; `transcript` is text, or parsed JSON for JSON formats. The format list is read from the server (`text`, `json`, `markdown`, `srt`, ...) |
| Get Metadata | `GET /api/v1/metadata` (falls back to `GET /api/v1/context` on servers without that route) | title, channel, description, duration, chapters, tags |
| Get Context | `GET /api/v1/context` | the full VideoContext: metadata, timed segments, attempts |
| List Items | `GET /api/v1/items` | one item per video in a playlist, channel, feed or page |
| Add to Collection | `POST /api/v1/collections/:id/items` | `{ collection, summary }` (videos added, skipped, failed); on a server running a jobs queue, the `202` ingest job instead |

Options: mode (`auto`, `captions`, `stt`, `video`) and language. Add to Collection picks the collection from a list loaded with `GET /api/v1/collections` (or takes an id from an expression), takes video, playlist or feed URLs one per line, and an optional cap on new videos; videos the collection already has are skipped, so re-running a workflow does not duplicate them. With "Continue On Fail", errors become items with `error` and the API's own message in `description`.

**vid2context Trigger**. Pick the events (`video.ingested`, `collection.updated`, `job.succeeded`, `job.failed`, `brief.ready`). On activation it registers the workflow's webhook URL with `POST /api/v1/webhooks` and keeps the returned signing secret in the workflow's static data; on deactivation it deletes the webhook. Every delivery is checked against its Standard Webhooks signature (HMAC-SHA256 over the raw body, 5 minute timestamp tolerance); unsigned or forged requests get `401` and never start the workflow. Output is the event payload `{ type, timestamp, data, messageId }`. Payloads carry ids, titles and API links, not transcripts: add a vid2context node after the trigger to fetch the text (for example Get Transcript with URL `{{ $json.data.added[0].url }}`).

## Credentials

| Field | Value |
|---|---|
| Base URL | where the vid2context API runs, e.g. `http://127.0.0.1:8787` (a trailing `/api/v1` is fine) |
| API Key | one of the keys in `VID2CONTEXT_API_KEYS` on the server; leave empty for a server without keys. Sent as `Authorization: Bearer <key>` |

The credential test calls `GET /api/v1/health`, which checks that the server is reachable; that route does not need a key, so a wrong key shows up on the first real call.

The trigger needs vid2context to reach n8n. Webhook targets must be public `https:` URLs unless the vid2context server sets `VID2CONTEXT_WEBHOOKS_ALLOW_LOCAL=1`, which allows `http:` and hosts on this machine or the private network (n8n on `localhost:5678`, in Docker or on the LAN). Set `WEBHOOK_URL` in n8n when it runs behind a proxy so it registers the right address.

## Build and install into a local n8n

This package is the one exception to the repo's source exports: n8n loads community nodes as compiled CommonJS, so it builds to `dist/` with the n8n starter's layout (`dist/credentials/*.credentials.js`, `dist/nodes/<Name>/<Name>.node.js`, icons next to them, the `n8n` field in `package.json`).

```sh
npm install                              # at the repository root
npm run build -w packages/n8n-nodes      # tsc to dist/ plus icons
```

Install the built package where n8n looks for community nodes (`~/.n8n/nodes`, or `$N8N_USER_FOLDER/.n8n/nodes`):

```sh
cd packages/n8n-nodes && npm pack        # n8n-nodes-vid2context-0.1.0.tgz
mkdir -p ~/.n8n/nodes && cd ~/.n8n/nodes
npm install /path/to/n8n-nodes-vid2context-0.1.0.tgz
npx n8n start                            # the nodes appear as "vid2context" and "vid2context Trigger"
```

During development a symlink works too: `ln -s "$PWD/packages/n8n-nodes" ~/.n8n/nodes/node_modules/n8n-nodes-vid2context` (rebuild and restart n8n after changes). The package has no runtime dependencies; `n8n-workflow` is a peer dependency that n8n provides.

## Zapier and Make

There is no Zapier or Make app. Both work with the plain HTTP API and these webhooks.

**Zapier**

- Trigger: "Webhooks by Zapier", event "Catch Raw Hook" (raw, so the body stays byte-exact for signature checks). Copy the hook URL and register it: `curl -X POST <server>/api/v1/webhooks -H 'content-type: application/json' -d '{"url":"<zapier hook URL>","events":["collection.updated"]}'`. Keep the returned `secret`. Send a test with `POST /api/v1/webhooks/<id>/test`.
- To verify signatures, add a "Code by Zapier" step (JavaScript) that recomputes `v1,` + base64 HMAC-SHA256 of `webhook-id + "." + webhook-timestamp + "." + raw body` with the secret's base64-decoded bytes and compares it with the `webhook-signature` header, as described in `packages/webhooks/README.md`. Without that step, treat the hook URL as a secret.
- Actions: "Webhooks by Zapier", event "GET", URL `<server>/api/v1/transcript`, query `url=<video URL>` and `format=text`, header `Authorization: Bearer <key>` when the server has keys. Use `/api/v1/context` for JSON.

**Make**

- Trigger: the "Webhooks" app, "Custom webhook". Register its address with `POST /api/v1/webhooks` as above. Turn on "Get request headers" and "JSON pass-through" so the headers and the raw body reach the scenario for verification (Make's "Custom webhook" can also restrict callers by IP).
- Actions: the "HTTP" app, "Make a request", `GET <server>/api/v1/transcript?url=...&format=text` (or `/context`), with the `Authorization` header when needed; "Parse response" for JSON.

Webhook payloads link to the API (`data.added[].links.transcript`, `data.job.links.job`); set `VID2CONTEXT_WEBHOOKS_BASE_URL` on the server to make those links absolute so Zapier and Make can call them directly.

## Tests

`npx vitest run packages/n8n-nodes` starts a real vid2context server on a random port (recorded YouTube responses replayed underneath, the webhook routes mounted) and checks the request building, the transcript, metadata and context calls, Add to Collection through the server's collection routes, the trigger's register, exists and delete logic, and signature checks against the Standard Webhooks published vector, the official `standardwebhooks` library and `@vid2context/webhooks`.
