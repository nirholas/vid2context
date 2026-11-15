# packages/config test fixtures

Config files written by hand for the validator, resolver and compiler tests (2026-11-14). They are inputs to the code under test, not recorded service responses: this package makes no network calls. The three built-in example profiles are tested straight from `packages/config/examples/vid2context.config.jsonc`, and from the single-profile copies `examples/default.config.jsonc`, `examples/private.config.jsonc` and `examples/quality.config.jsonc` (a test checks each copy matches the combined file), so the shipped examples and the tests cannot drift.

| File | What it exercises |
|---|---|
| `extends.jsonc` | a three-level `extends` chain (`work-strict` -> `work` -> `base`), per-stage policy, skip and only, `prefer`, models (string, list, `env:` reference), storage, defaults, limits, env extras with an `env:` reference to a secret |
| `cycle.json` | an `extends` cycle (`a` -> `b` -> `a`); must fail |
| `comments.jsonc` | line and block comments, trailing commas, and comment markers inside a string |
| `literal-key.json` | a literal API-key-shaped value under `env.OPENAI_API_KEY` and under `models.gemini`; must fail. The values are not real keys. |
| `unknown-provider.json` | an unknown provider (`grok`) under `models`; must fail with the known keys in the hint |
| `bad-shape.json` | wrong version, bad enum, wrong type, out-of-range integer and a misspelled key; must report every problem with its JSON path |
