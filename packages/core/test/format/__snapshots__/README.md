# Format snapshots

- `<id>.<format>.<ext>`: `toMatchFileSnapshot` output of each formatter for the real contexts in `tests/fixtures/contexts/` (`many.pack.md` is `renderMany` over both, `cCPsdFdlshc.pack-<n>.md` the pack at a `maxTokens` budget). Regenerate with `npx vitest run packages/core/test/format -u` and read the diff.
- `<id>.foundation-*.txt`: `text` and `json` output of the foundation formatters, written on 2026-11-14 from the committed `packages/core/src/format/index.ts` before the new formats were added. The test asserts the current output is byte-identical. Never regenerate these with `-u`; they are named `.txt` so Biome does not reformat the JSON.
