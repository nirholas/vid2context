# 10. Security hardening and threat model

| | |
|---|---|
| Track | A. Core bones |
| You own | `packages/core/src/security/`, `docs/security/` |
| Shared edits allowed | `packages/core/src/pipeline.ts` (input policy check at resolve time), `packages/core/src/chain.ts` (redact secrets in attempt details), `packages/core/src/context.ts` (redacting stderr logger), root `SECURITY.md` (one link to the threat model), one `export *` line in `packages/core/src/index.ts` |
| Commit scope | `security` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. That makes it an attractive target: it fetches arbitrary user-supplied URLs (server-side request forgery into cloud metadata endpoints), reads local file paths (a public server must never serve `/etc/passwd`), spawns binaries such as yt-dlp and ffmpeg (argument injection), holds many provider keys (which must never appear in logs, attempts or health output), runs as a public HTTP API and remote MCP endpoint, and feeds untrusted transcripts and comments to LLMs (prompt injection). This prompt builds the shared, runtime-neutral defenses every other package uses, wires the few that must be global into the core, and writes the threat model an enterprise reviewer will ask for.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts`, `packages/core/src/provider.ts`, `packages/core/src/errors.ts`, `packages/core/src/testing.ts`.
3. `packages/core/src/pipeline.ts` (`getVideoContext`, `expandInput`), `packages/core/src/chain.ts` (`errMessage`, attempt details), `packages/core/src/context.ts` (`stderrLogger`, `createContext`, `fetchWithTimeout`), `packages/core/src/registry.ts` (`health`).
4. `providers/media-file/src/index.ts` (reads local paths), `packages/server/src/` (the HTTP surface), the root `SECURITY.md`.
5. `docs/contracts/http-api.md` (secrets rule, auth and limits).
6. `docs/prompts/SHARED-CONTRACTS.md`, section 8.

## Goal

A `packages/core/src/security/` module that every package can import (URL policy, safe fetch, public-mode input policy, secret redaction, untrusted-text fencing, argument and path safety, central limits), enforced globally where it must be (input policy in the pipeline, redaction in logs and attempts), plus a threat model and hardening guide in `docs/security/`.

## Requirements

### URL policy (runtime-neutral)

- `checkUrl(url, policy?)` returns `{ ok: true, url: URL } | { ok: false, reason }`. Default policy: only `http:` and `https:`; no credentials in the URL; reject loopback, private, link-local, CGNAT, multicast, reserved and unspecified ranges for IPv4 and IPv6 (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10`, `0.0.0.0/8`, `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped and IPv4-compatible IPv6), and metadata hostnames (`metadata.google.internal`, `metadata`, `169.254.169.254`, `fd00:ec2::254`). Normalize hosts first: decimal (`2130706433`), octal (`0177.0.0.1`), hex (`0x7f.1`), short forms (`127.1`), trailing dots, IDN to punycode, uppercase.
- Optional `allowPorts` list and `allowPrivate: true` for local use.
- DNS rebinding: core cannot import `node:dns`, so `checkUrl` accepts an injected `resolve?: (host) => Promise<string[]>` and, when given, checks every resolved address. Document how Node surfaces pass `node:dns/promises` in.

### `safeFetch`

- `safeFetch(ctx, url, { maxBytes, maxRedirects = 5, timeoutMs, policy, accept? })`: uses `ctx.fetch` with `redirect: 'manual'`, re-checks every hop with `checkUrl`, caps the body by streaming and aborting past `maxBytes` (throw `too-large`), applies a timeout combined with `ctx.signal`, and optionally checks `Content-Type`. Returns the final `Response`-like `{ url, status, headers, bytes }`. Other prompts (podcasts, web pages, media URLs) will use it.

### Public mode and input policy

- `VID2CONTEXT_PUBLIC=1` (set by public servers and the remote MCP endpoint) means: refuse local file paths and `file://` inputs, refuse URLs failing the default `checkUrl` policy, refuse inputs longer than the limit.
- `checkInput(input, env)` implements it and returns a `Vid2ContextError('unsupported-input')` with a clear hint when refused.
- Shared edit: call it once at the top of `getVideoContext` and `expandInput` in `packages/core/src/pipeline.ts` (re-read right before editing; prompts 02, 04, 21, 22 and 42 also edit this file; keep it to a few lines).

### Secret redaction

- `redact(value, env?)` for strings and plain objects (deep, cycle-safe): `Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, `api-key` header values; query params named `key`, `api_key`, `apikey`, `token`, `access_token`, `sig`; known key shapes (OpenAI `sk-`, `sk-proj-`, Anthropic `sk-ant-`, Groq `gsk_`, Google `AIza`, GitHub `ghp_`, `gho_`, `github_pat_`, Hugging Face `hf_`, xAI `xai-`, Bearer tokens in text); and the literal values of every env var whose name ends with `_KEY`, `_KEYS`, `_TOKEN`, `_SECRET`, `_PASSWORD` or `_COOKIE` (skip values shorter than 8 characters to avoid redacting common words). Replace with `[redacted]`.
- Shared edits: in `packages/core/src/chain.ts`, pass attempt `detail` through `redact(..., ctx.env)`; in `packages/core/src/context.ts`, make `stderrLogger` redact messages and data. Keep `redact` cheap; build the env value list once per context.

### Untrusted text for LLMs

- `fenceUntrusted(text, label)`: wraps transcript, comment or page text in a clearly delimited block (a random per-call boundary token the text cannot contain, with the label and the source) and returns the block plus a standard system-prompt sentence saying that content inside such blocks is data to analyze, never instructions to follow. Document how prompts 32 (briefs), 34 (ask and chat) and 35 (translation) must use it.

### Argument and path safety (pure functions, no `node:` imports)

- `assertSafeArg(value, label)`: reject values starting with `-`, containing NUL or newlines, for anything passed as a positional argument to a binary.
- `safeJoin(base, name)`: POSIX and Windows separators, `..` segments, absolute paths and drive letters rejected; returns the joined path string.
- `safeFilename(name, maxLength = 120)`: strips control characters, path separators, reserved Windows names (`CON`, `NUL`, `COM1`...), trailing dots and spaces.

### Central limits

- One `limits(env)` function returning defaults with env overrides: `VID2CONTEXT_MAX_INPUT_CHARS` (2048), `VID2CONTEXT_MAX_PLAYLIST_ITEMS` (500), `VID2CONTEXT_MAX_UPLOAD_MB` (200), `VID2CONTEXT_MAX_AUDIO_MB` (1024), `VID2CONTEXT_MAX_SEGMENTS` (200000), `VID2CONTEXT_FETCH_TIMEOUT_MS` (30000). Other prompts import these instead of inventing their own.

### Exports

- Export from `packages/core/src/security/index.ts`, add the `export *` line to `packages/core/src/index.ts`. Names must not collide with other core exports.

## Out of scope

- API keys, OAuth and rate limiting for the HTTP API and remote MCP: prompts 46 and 45 (they use your redaction and limits).
- Hygiene scans in CI (secret patterns in the repo): prompt 38.
- Fixing providers to use `safeFetch`: each provider's owner adopts it; list candidates in your report.

## Tests

Put tests in `packages/core/test/security/`.

- A real-world SSRF payload corpus: collect bypass payloads from public references (for example the PayloadsAllTheThings SSRF list), commit them as a fixture file with the source and date in a `README.md`, and assert every one is rejected; a corpus of ordinary public URLs (YouTube, Vimeo, podcast hosts, CDNs) that must pass.
- Redirect chain to a private address: start a real local HTTP server in the test (`node:http`, a random port, allowed only through an explicit test policy for the first hop) that redirects to `http://169.254.169.254/`; assert `safeFetch` refuses the second hop. Byte cap: the server streams more than `maxBytes`; assert `too-large` and that the connection was aborted.
- Redaction: real key formats (syntactically valid samples, documented as format samples and not real credentials), headers objects, nested attempts, env value redaction, and a check that short env values are not redacted.
- Public mode: local paths, `file://`, private URLs refused with the right code and hint; ordinary inputs pass. Pipeline integration test: `getVideoContext` with `VID2CONTEXT_PUBLIC=1` and a local path throws before any provider is called.
- `fenceUntrusted`: text that contains a fake boundary or "ignore previous instructions" stays inside the block.
- `safeJoin`, `safeFilename`, `assertSafeArg` with real-world malicious inputs.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'packages/core/src/(security|pipeline|chain|context)'` prints nothing.
- [ ] `npx vitest run packages/core` passes (existing tests included).
- [ ] `npx biome check packages/core/src/security packages/core/test/security` is clean.
- [ ] `packages/core/src/security/` imports no `node:` module.
- [ ] With a real key set in env, a failing rung's attempt detail and the stderr log show `[redacted]` instead of the key (demonstrate with a real request to a provider using a deliberately wrong key and paste the redacted output).

## Docs

- `docs/security/threat-model.md`: assets (keys, the owner's library, the home IP), trust boundaries (user input, transcripts and comments, third-party keyless hosts that see data without an account, YouTube terms and IP blocking, local binaries, the browser extension), threats and mitigations in a table, residual risks.
- `docs/security/hardening.md`: settings for public deployments (`VID2CONTEXT_PUBLIC=1`, keyless off when data is sensitive, API keys, CORS, limits), and how other packages must use `safeFetch`, `checkInput`, `redact` and `fenceUntrusted`.
- Root `SECURITY.md`: add one line linking to the threat model (re-read first).

## If credentials, tools or network are missing

Nothing here needs a key. The live redaction demo needs any provider endpoint reachable with a wrong key; if the network is down, demonstrate with a recorded real error response replayed through `replayFetch` and say so.

## Repo rules (binding, same as AGENTS.md)

- Never use the em-dash or en-dash characters: not in code, comments, docs, UI copy or commit messages. Use commas, colons, periods or parentheses. No emojis.
- No mocks, fake data, placeholders, TODOs, stub functions or "coming soon" text. If a piece cannot be built for real now, leave it out and say so in your final report.
- Tests use real data only: fixtures recorded from the real service, replayed through `replayFetch` and `testContext` from `@vid2context/core/testing`, or live calls gated by `LIVE=1` (`describe.skipIf(!process.env.LIVE)`). A unit test must never reach the network. Every fixture gets a line in its folder's `README.md` saying where and when it was recorded.
- Core code and providers never read `process.env` or the global `fetch`: use the `ctx` passed to every call. Log through `ctx.log` (stderr). stdout is program output and the MCP stdio channel.
- Prefer plain `fetch` over vendor SDKs. `packages/core` and every provider that declares the `workers` or `browser` runtime must not import Node built-ins.
- Every error a user can see is a `Vid2ContextError` with a stable `code` and a `hint` that says how to recover.
- Free first: local, then free tiers with the user's own key, then keyless hosts, and paid services last, only when their key is set. Every model id is overridable by env. New env vars go into `.env.example` and `docs/providers.md` in the same commit.
- Keep raw transcripts. Cleaned text, summaries, translations and briefs are added layers, never replacements.
- TypeScript, ESM, explicit `.ts` import extensions, Biome formatting (`npx biome check --write <your paths>`).

## Working in a shared folder

You are one of 50 agents working at the same time in this folder, each owning different directories.

- Create and edit files only inside the directories this prompt says you own, plus the shared edits listed in its header. Keep shared edits small and additive, and re-read a shared file immediately before every edit: another agent may have changed it a minute ago. `docs/prompts/SHARED-CONTRACTS.md` section 8 lists who may edit which shared file.
- If the foundation code differs from what this prompt describes, the code wins: read it and adapt. If something you need from another prompt has not landed yet, build everything else first and check again before you finish. If it is still missing, leave that piece out and list it in your report. Never stub it.
- Dependencies go only into your own package's `package.json`. Install through the shared lock so parallel installs cannot corrupt `node_modules`: `mkdir -p .vid2context/locks && flock .vid2context/locks/npm npm install -w <your package dir> <name>@<version>`. Never hand-edit `package-lock.json`; if it conflicts, rerun the install through the lock. Never edit `packages/registry/src/generated/`; run `npm run gen` instead.
- Other agents' unfinished work can break the repo-wide `npm run typecheck` and `npm test`. Judge your own paths: `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E '<your dirs>'` prints nothing, `npx vitest run <your dirs>` passes, `npx biome check <your dirs>` is clean. Do not fix other agents' files; mention breakage you saw in your report.
- Never run commands that touch other agents' work: `git add -A`, `git add .`, `git commit -a`, `git stash`, `git reset`, `git checkout -- <path>`, `git restore`, `git clean`, `git rebase`, `git push`.
- Servers you start for testing: pick a random port between 20000 and 29999, and stop them when you are done.

## Committing

The owner asks you to commit your own work as described here. Commit each coherent piece as soon as it works, not only at the end.

1. `git status --short` and check that every path you will commit is yours.
2. `flock .vid2context/locks/git git add <explicit paths>` (needed for new files).
3. Commit only your paths, which leaves anything other agents staged untouched:
   `flock .vid2context/locks/git git commit -m "<type>(<scope>): <what changed and why it matters>" -m "<body: what and why, in plain language>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <explicit paths>`
   (use the Co-Authored-By trailer your harness specifies if it names a different model).
4. `git show --stat HEAD` and confirm only your files are in the commit.

Types: feat, fix, refactor, perf, test, docs, chore. Never use subjects like "update" or "wip". Do not push. Never amend or rewrite a commit you did not make.

## Final report

Finish with a short report to the owner: what you built (paths), what you verified live and how, what you could not verify and why (missing key, tool or network), every shared-file edit you made, what the integration pass needs to wire up, and any breakage you noticed outside your directories.
