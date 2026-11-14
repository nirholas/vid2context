# testkit fixtures

Real exchanges recorded with this package's own `recordingFetch`, so they also show what the recorder writes.

## ovh/

Recorded on 2026-11-14 from this repo's VM against the keyless OVH AI Endpoints (no account, no key), with `recordingFetch(globalThis.fetch, { dir, name: 'ovh', scrub: { env: process.env } })`.

| File | Exchange |
|---|---|
| `ovh-001.json` | `GET https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models`: the public model list (21 models) |
| `ovh-002.json` | `POST .../v1/chat/completions` from the `llm/ovh/Meta-Llama-3_3-70B-Instruct` rung asking for the year of the Apollo 11 landing; answer `1969` |

The scrub report was empty (nothing secret was sent or returned). Response headers are the recorder's allowlist (content type and rate-limit headers). Both files were grepped for the VM's public IP before committing: not present.
