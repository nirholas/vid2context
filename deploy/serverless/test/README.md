# deploy/serverless tests

```sh
npx vitest run -c deploy/serverless/vitest.config.ts                    # assets, Vercel output, Pages dry run
WRANGLER_TEST=1 npx vitest run -c deploy/serverless/vitest.config.ts    # also the Workers runtime (wrangler dev) and the real Astro site build
LIVE=1 npx vitest run -c deploy/serverless/vitest.config.ts             # also a real YouTube transcript through the Worker
```

Fixtures (real data, no invented content):

| Fixture | Source |
|---|---|
| `site-fixture.ts` | the static landing page `site/index.html` and `site/404.html` from commit 09fe38a (2026-11-14), read with `git show` at test time |
| repo `llms.txt`, `llms-full.txt` | the current files at the repo root |
| Worker SPA test app | the same real files, copied under `/app/` to exercise the fallback paths |
