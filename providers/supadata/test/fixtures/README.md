# Supadata fixtures

Pending a key. No Supadata API key was available when this provider was written (2026-11-14), so no real response has been recorded and this folder holds no fixtures yet. The provider has not been verified live.

Doc examples were deliberately not copied here: AGENTS.md allows only responses recorded from the real service.

Until fixtures exist, `test/supadata.test.ts` covers only behaviour that needs no response body (key gating, order, the request sent, timeouts, cancellation, status mapping), and `test/live.test.ts` runs against the real API when `LIVE=1` and `SUPADATA_API_KEY` are set.

## Recording

```sh
SUPADATA_API_KEY=... npx tsx providers/supadata/scripts/record-fixtures.ts
```

It spends about 4 credits and writes one JSON file per case (`recordedAt`, the outcome, and every response in order: method, URL, status, kept headers, body):

| File | Case |
|---|---|
| `transcript-jNQXAC9IVRw-en.json` | "Me at the zoo" with `lang=en`: a native transcript (200, or 202 and the job polls) |
| `transcript-brXcsLhw84o.json` | a one-minute piano video without captions: 206 `transcript-unavailable` |
| `transcript-xxxxxxxxxxx.json` | an id that does not exist |
| `transcript-bad-key.json` | a deliberately invalid key: 401 `unauthorized` |

The script replaces the key (real and invalid; the unauthorized body echoes the key it was sent) with `[redacted]`, keeps only the `content-type`, `x-billable-requests` and `retry-after` headers, and replaces emails and IPv4 addresses in bodies. Before committing: review each file, grep it for your public IP, and replace the table above with the source, date and trimming of each file.
