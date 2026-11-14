# tooling test fixtures

These files are synthetic: they are inputs to the hygiene linters in `tooling/checks/`, written by hand on 2026-11-14 to contain the exact violations each check must find (and nearby text it must accept). They are not recorded from any service and no code reads them as data. Every check skips this directory when it scans the repo.

| File | Check it exercises |
|---|---|
| `dashes.md` | `no-dashes`: one en-dash and one em-dash |
| `todo.ts` | `no-todo`: markers after comment openers and with a colon or parenthesis, plus prose that must pass |
| `secrets.txt` | `secrets`: one sample of each key shape. The AWS id is the example key from AWS's own documentation; the others spell out that they are not keys |
| `edge-unsafe.ts` | `edge-safe`: `node:` and bare built-in imports, dynamic `import()`, `require()` and `export * from` |
| `process-env.ts` | `no-process-env`: `process.env`, bare `fetch()` and `globalThis.fetch`, next to `ctx` use, comments, strings and a Workers `fetch` handler that must pass |
| `console-log.ts` | `no-console-log`: `console.log` and `console.info`, next to `console.error`, a comment and a template string that must pass |
