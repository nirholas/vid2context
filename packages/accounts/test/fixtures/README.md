# Accounts fixtures

Real responses recorded with `curl` on 2026-11-14 from the services hosted mode talks to. Nothing personal is in them: the Turnstile calls use Cloudflare's public test keys, and the GitHub calls use a client id that belongs to no OAuth app and an invalid token, so GitHub answers with its standard errors. Response headers were not kept; the status is listed below and set by the tests.

| File | Request | Response |
|---|---|---|
| `turnstile-siteverify-pass.json` | `POST https://challenges.cloudflare.com/turnstile/v0/siteverify`, form body `secret=1x0000000000000000000000000000000AA` (test secret, always passes), `response=XXXX.DUMMY.TOKEN.XXXX` | 200, `success: true`, `hostname: example.com` |
| `turnstile-siteverify-fail.json` | Same, `secret=2x0000000000000000000000000000000AA` (test secret, always fails) | 200, `success: false`, `error-codes: ["invalid-input-response"]` |
| `turnstile-siteverify-duplicate.json` | Same, `secret=3x0000000000000000000000000000000AA` (test secret, simulates a redeemed token) | 200, `success: false`, `error-codes: ["timeout-or-duplicate"]` |
| `github-token-unknown-client.json` | `POST https://github.com/login/oauth/access_token` with `Accept: application/json`, `client_id=Ov23li0000000000000000` (no such app), a dummy secret, code and PKCE verifier | 404, `{"error":"Not Found"}` |
| `github-user-bad-credentials.json` | `GET https://api.github.com/user` with `Authorization: Bearer gho_000...` (invalid token) | 401, `Bad credentials` |

Test keys are documented at https://developers.cloudflare.com/turnstile/troubleshooting/testing/. `../live.test.ts` repeats these calls against the real services when `LIVE=1`.

Not recorded: a successful GitHub token exchange and `/user` response. That needs a registered OAuth app (`GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`) and a person clicking "Authorize" in a browser, which was not available when this package was built, so the success path of the callback has no recorded data yet.
