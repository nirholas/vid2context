# @vid2context/config

Versioned config files with named profiles for vid2context. A profile compiles to env vars plus per-stage chain options, so providers keep reading `ctx.env` and need no changes. The real environment always wins over the file.

- `@vid2context/config`: runtime-neutral core (no `node:` imports): `parseConfig`, `validateConfig`, `resolveProfile`, `toEnv`, `mergeEnv`, `chainOptionsFor`, `applyPrefer`, `explain`.
- `@vid2context/config/node`: finds the file (`VID2CONTEXT_CONFIG`, `./vid2context.config.json`, `./vid2context.config.jsonc`, `~/.config/vid2context/config.json`), loads `.env`, and returns the merged env through `loadConfiguredEnv()`.

```ts
import { loadConfiguredEnv } from '@vid2context/config/node';
import { createNodeContext } from '@vid2context/registry/node';

const { env, explain } = await loadConfiguredEnv({ profile: 'private' });
const ctx = createNodeContext({ env });
```

`vid2context config [--profile name]` prints the effective settings and where each came from.

- Example file with the `default`, `private`, `quality` and `hybrid` profiles: [examples/vid2context.config.jsonc](examples/vid2context.config.jsonc)
- JSON Schema for editor autocomplete: [schema/config.schema.json](schema/config.schema.json) (regenerate with `npm run gen:schema -w @vid2context/config`)
- Full reference: [docs/configuration.md](../../docs/configuration.md)
