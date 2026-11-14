# Contributing to vid2context

Thanks for helping. Bug reports, new providers, docs fixes and ideas are all welcome.

- **Questions and ideas:** [Discussions](https://github.com/nirholas/vid2context/discussions)
- **Bugs and provider requests:** [Issues](https://github.com/nirholas/vid2context/issues/new/choose)
- **Security problems:** see [SECURITY.md](SECURITY.md). Please don't open a public issue.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

You need Node.js 22 or newer.

```bash
git clone https://github.com/nirholas/vid2context.git
cd vid2context
npm install      # also generates the provider registry
npm run check    # typecheck, lint and tests; run this before every PR
```

Other scripts:

| Script                            | What it does                                      |
| --------------------------------- | ------------------------------------------------- |
| `npm test`                        | Offline tests against recorded fixtures           |
| `npm run test:live`               | Also runs tests that hit real services (`LIVE=1`) |
| `npm run lint` / `npm run format` | Biome check / Biome autofix                       |
| `npm run gen`                     | Regenerate the provider registry                  |

## Project layout

```
packages/core/       contracts, rung chain, pipeline, formatters (runtime-neutral)
packages/registry/   generated provider registries per runtime
providers/*/         one package per provider
scripts/             gen-registry.mjs
```

`llms-full.txt` at the repository root explains the data model, the rung chain and every environment variable in one place.

## Adding a provider

Providers are the easiest way to contribute. A provider is a package under `providers/<name>/`:

1. In `package.json`: name it `@vid2context/provider-<name>`, set `"type": "module"` and `"exports": { ".": "./src/index.ts" }`, depend on `@vid2context/core`, and declare the runtimes it really supports:

   ```json
   "vid2context": { "runtimes": ["node", "workers", "browser"] }
   ```

2. Default-export the provider (or an array of them) from `src/index.ts`, wrapped in `defineProvider(...)`.
3. Run `npm run gen`. The registry picks the package up automatically, so you don't edit any shared file.

Rules that keep providers portable and safe:

- Use `ctx.fetch`, `ctx.env` and `ctx.log`. Never read `process.env` or the global `fetch` directly.
- `@vid2context/core` stays runtime-neutral: no Node-only imports there.
- `match(input)` is synchronous and makes no network calls.
- Rung providers build rungs from `env` on every call and return every rung they know, enabled or not.
- Throw `Vid2ContextError` with the right `code` and a `hint` that tells the user how to recover.
- Never log or return API key values.
- Tests run offline. Record real responses as fixtures in `test/fixtures/` and guard tests that hit the network behind `LIVE=1`.

## Pull requests

- Keep each PR to one change. Open a discussion or issue first for anything large.
- Add or update tests for behaviour changes.
- `npm run check` must pass. CI runs the same checks.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/), for example `feat(youtube): parse chapter titles with emoji` or `fix(stt): retry on 503`.
- If you change a type in `packages/core/src/types.ts` or `provider.ts`, update every consumer in the same PR.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
