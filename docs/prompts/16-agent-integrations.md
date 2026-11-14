# 16. Agent integrations: one-command setup for every client

| | |
|---|---|
| Track | H. Surfaces |
| You own | `integrations/` |
| Shared edits allowed | None |
| Commit scope | `integrations` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. The owner's real workflow is research in ChatGPT and in Claude Code inside VS Code. The MCP server already works from Claude Code (verified by the foundation), but every client stores its MCP configuration in a different file and format, and hand-editing JSON or TOML is where most users give up. This prompt ships a safe installer for every major client, a Claude Code plugin with a skill that teaches agents how to use vid2context well, and the ChatGPT pieces: custom GPT instructions, a GPT Action schema, and the zero-setup context pack path.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `docs/contracts/mcp-tools.md` (tool names, prompts, resources; the remote endpoint at `/mcp` served by `packages/mcp-http`, prompt 45) and `docs/contracts/http-api.md` (routes a GPT Action would call).
3. `packages/mcp/src/` (the stdio server and its bin `vid2context-mcp`) and the root `package.json` (`npm run mcp`).
4. The owner's earlier project `nirholas/extract-llms-docs` for the Claude plugin layout (`plugins/llms-docs-extractor/.claude-plugin/plugin.json`, `skills/extract-llms-docs/SKILL.md`); read it with `gh api repos/nirholas/extract-llms-docs/contents/plugins` (read only).
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 2 (bundle layout and `context.md`), 4 (MCP) and 8.

## Goal

`npx tsx integrations/install/src/bin.ts <client>` adds vid2context to any supported client's MCP config safely and idempotently (local stdio or remote with a token), and `--uninstall` removes it cleanly. A Claude Code plugin with a skill, and a ChatGPT folder with GPT instructions, an Action schema and Projects instructions, make agents use vid2context the right way: outline first, fetch sections, cite timestamps.

## Requirements

### Installer (`integrations/install/`, Node, no dependencies)

- Command: `npx tsx integrations/install/src/bin.ts <client> [--scope user|project] [--remote <url> --token <token>] [--command <cmd>] [--dry-run] [--uninstall] [--json]`. Clients: `claude-code`, `claude-desktop`, `cursor`, `vscode` (Copilot), `codex`, `windsurf`, `gemini-cli`. `list` prints supported clients and where each config lives on this OS.
- Default server entry (local stdio): the published bin when installed globally, else `npx -y vid2context-mcp` once publishing exists, else the repo's `npx tsx <repo>/packages/mcp/src/bin.ts` with an absolute path. Detect which applies and say what was chosen. `--remote` writes the client's remote or Streamable HTTP form with an `Authorization: Bearer` header where the client supports headers, and explains the OAuth path (prompt 45) where it does not.
- Claude Code: use `claude mcp add vid2context --scope <scope> -- <command>` when the `claude` CLI is on PATH; otherwise write `.mcp.json` (project scope).
- Every other client: verify its current config path and format against its official docs today (WebFetch), record the URL and date in the docs, and implement exactly that. Expected starting points to verify, not to trust blindly: Claude Desktop `claude_desktop_config.json` (macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`), Cursor `.cursor/mcp.json` and `~/.cursor/mcp.json`, VS Code `.vscode/mcp.json` (key `servers`), Codex CLI `~/.codex/config.toml` (`[mcp_servers.<name>]`), Windsurf `~/.codeium/windsurf/mcp_config.json`, Gemini CLI `~/.gemini/settings.json` (`mcpServers`).
- Merge safely: parse (JSON with comments where the client allows them; a minimal TOML reader and writer for the Codex table, preserving other tables and comments as far as practical), add or replace only the `vid2context` entry, keep unknown keys, write a timestamped backup next to the file before changing it, write atomically (temp file then rename), and never touch a file whose parse fails (print the parse error and the exact snippet to add by hand). Running twice is a no-op. `--dry-run` prints the diff. `--uninstall` removes only the vid2context entry.
- Never write API keys into client configs unless the user passes them explicitly with `--env KEY=VALUE`; say that keys belong in the repo's `.env` or the user's environment.

### Claude Code plugin (`integrations/claude-plugin/`)

- `.claude-plugin/plugin.json` (name, description, version, author nirholas, the MCP server definition) and `skills/vid2context/SKILL.md`.
- The skill teaches: when to reach for vid2context (any video URL, playlist, podcast or local media), outline first (`get_outline`), then `get_section` or `search_transcript` instead of whole transcripts for long material (about 12k tokens per hour of speech), always cite as `[Title @ m:ss](timestamp url)`, flag consensus and disagreement across sources, use the `brief` and `buyer_guide` prompts for multi-video research (the owner's G-Wagon playlist example), and how to recover from errors using `hint` and `attempts` (for example, `blocked` means run locally or through the tunnel).
- Validate the plugin structure against the current Claude Code plugin docs (WebFetch) and record the date.

### ChatGPT (`integrations/chatgpt/`)

- `custom-gpt-instructions.md`: instructions and conversation starters for a custom GPT that uses vid2context, with the same citation and outline-first rules.
- `gpt-action.openapi.json`: an OpenAPI 3.1 schema covering the implemented and planned read routes from `docs/contracts/http-api.md` that a GPT Action can use (`/metadata`, `/transcript`, `/outline`, `/section`, `/search`, `/pack`), with Bearer auth. Do not commit a made-up host: take the server URL as a documented build parameter (`npx tsx integrations/chatgpt/src/action.ts --server https://your-host`) that writes the file, rather than committing a fake host.
- `projects.md`: the zero-setup path: run vid2context locally or in the web app, download the bundle, upload `context.md` to a ChatGPT Project or Claude Project, and the instruction text to paste into the Project.
- Link to the remote MCP connector guide from prompt 45 (`docs/guides/remote-mcp.md`) instead of duplicating it; if it does not exist when you finish, describe the remote option in one paragraph and report it.

## Prefer free and local

Default to the local stdio server: free, private, and YouTube requests come from the user's own IP. Remote setups are optional and documented as such.

## Out of scope

- The MCP server's tools: prompt 44. The remote transport and OAuth: prompt 45. The CLI that may later wrap this installer (`vid2context install <client>`): prompt 43.
- Publishing packages to npm: prompt 38.

## Tests

- Real config files as fixtures in `integrations/install/test/fixtures/`: copy real configs from installs you can create on this machine (for example by running `claude mcp add` against a temp project) and the examples published in each client's official docs, noting the source of each in the README. No invented formats.
- Assert for every client: fresh install into a missing file, merge into a file with other servers and unknown keys, idempotency (second run changes nothing), uninstall leaves the rest byte-identical, backup created, parse failure leaves the file untouched, dry-run prints a diff and writes nothing, remote mode writes the right shape.
- Plugin: a test that parses `plugin.json` and the skill front matter and checks required fields.
- LIVE (optional): install into a temp Claude Code project with the real `claude` CLI and list servers with `claude mcp list`.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E '^integrations/'` prints nothing (if the root tsconfig does not include `integrations/`, give it its own `tsconfig.json` and run `npx tsc -p integrations/tsconfig.json --noEmit`).
- [ ] `npx vitest run integrations` passes (add a `vitest.config.ts` inside `integrations/` if the root config does not pick up the tests, and say so).
- [ ] `npx biome check integrations` is clean.
- [ ] Installing for `claude-code` in a temp project and then running the MCP Inspector CLI against the written command lists the vid2context tools.
- [ ] Each client's docs section records the official config path and the date it was verified.

## Docs

- `docs/guides/agents.md`: one section per client (install command, what it writes, how to verify, how to uninstall), the Claude Code plugin, ChatGPT (custom GPT, Action, Projects), and troubleshooting.
- `integrations/README.md`: layout and commands.

## If credentials, tools or network are missing

No keys are needed. If you cannot reach a client's official docs, do not implement that client from memory: leave it out and report it. If the `claude` CLI is missing, test the `.mcp.json` path only and say so.

<!-- COMMON -->
