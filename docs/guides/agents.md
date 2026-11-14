# Use vid2context from your agent

One command adds the vid2context MCP server to an agent's config, and one more removes it. The installer edits only the `vid2context` entry: it keeps every other server, setting and comment, writes a timestamped backup first, and never touches a file it cannot parse. Running it twice changes nothing.

```sh
npx tsx integrations/install/src/bin.ts <client> [options]
npx tsx integrations/install/src/bin.ts list          # every client and where its config lives on this machine
```

Clients: `claude-code`, `claude-desktop`, `cursor`, `vscode`, `codex`, `gemini-cli`.

The local server is the default and the recommended setup: it is free, private, and YouTube requests come from your own connection, so they are rarely blocked.

## Options

| Option | What it does |
|---|---|
| `--scope user\|project` | User config (every project) or this folder's config. Default: `user`. |
| `--dry-run` | Print the diff and write nothing. |
| `--uninstall` | Remove only the vid2context entry. |
| `--from-source` | Run this checkout (`packages/mcp/src/bin.ts` with the repo's tsx) instead of the published package. For contributors. |
| `--command "<cmd>"` | Start the server with your own command. |
| `--env KEY=VALUE` | Write an env var into the config (repeatable). |
| `--remote <url>` | Use a remote vid2context endpoint (Streamable HTTP, `/mcp`) instead of the local server. |
| `--token <token>` | With `--remote`: send `Authorization: Bearer <token>`. Stored in the config in plain text. |
| `--token-env <VAR>` | With `--remote`: reference the token from an env var instead of storing it. |
| `--legacy` | VS Code only: write the deprecated `.vscode/mcp.json` format. |
| `--no-cli` | Claude Code only: edit `.mcp.json` even when the `claude` CLI is installed. |
| `--json` | Print the result as JSON. |

**Which command the client runs.** With no `--command` or `--from-source`, the installer uses `vid2context-mcp` when it is installed globally, and otherwise `npx -y vid2context-mcp` (the published npm package). It prints which one it chose. If npx reports that the package is not found, install from a checkout with `--from-source`.

**API keys.** None are needed for YouTube captions. Keys only add speech-to-text and LLM rungs (see [providers.md](../providers.md)). The installer never writes a key unless you pass it with `--env`. Put keys in your shell environment, or point the server at your `.env` file, which is not a secret itself:

```sh
npx tsx integrations/install/src/bin.ts cursor --env VID2CONTEXT_ENV_FILE=/path/to/vid2context/.env
```

**Backups.** Before changing a file, the installer copies it to `<file>.vid2context-backup-<UTC timestamp>` in the same folder. To undo a change, copy the backup back.

## Claude Code

Docs: https://code.claude.com/docs/en/mcp (verified 2026-11-14)

```sh
npx tsx integrations/install/src/bin.ts claude-code                   # user scope, every project
npx tsx integrations/install/src/bin.ts claude-code --scope project   # .mcp.json in this folder, shareable through git
```

- **What it writes.** When the `claude` CLI is on PATH, the installer runs `claude mcp add --scope <scope> --transport stdio vid2context -- npx -y vid2context-mcp`, so Claude Code does the merge itself. A changed entry is replaced with `claude mcp remove` first. Without the CLI it writes the project `.mcp.json` directly: `{ "mcpServers": { "vid2context": { "type": "stdio", "command": "npx", "args": ["-y", "vid2context-mcp"] } } }`. User scope needs the CLI, because user servers live in `~/.claude.json`, which Claude Code rewrites while it runs.
- **Remote.** `--remote https://your-host/mcp --token <token>` writes `{ "type": "http", "url": ..., "headers": { "Authorization": "Bearer <token>" } }`. With `--token-env VAR` the header is `Bearer ${VAR}`, which Claude Code expands at startup.
- **Verify.** `claude mcp list`, or `/mcp` inside a session. Project servers ask for approval the first time you run `claude` in that folder.
- **Uninstall.** `npx tsx integrations/install/src/bin.ts claude-code --uninstall` (add `--scope project` for `.mcp.json`).

### Claude Code plugin

The plugin adds the server and a skill that teaches Claude how to use it well: outline first, fetch sections instead of whole transcripts, cite every claim as `[Title @ m:ss](link)`, and recover from errors.

```sh
claude plugin marketplace add nirholas/vid2context
claude plugin install vid2context@vid2context
```

Or in one step on Claude Code 2.1.275 or later: `/plugin install vid2context --marketplace nirholas/vid2context`. The plugin lives in [integrations/claude-plugin/](../../integrations/claude-plugin/) and runs the published package (`npx -y vid2context-mcp`). It was checked with `claude plugin validate .` against https://code.claude.com/docs/en/plugins-reference and https://code.claude.com/docs/en/plugin-marketplaces (verified 2026-11-14). If you also installed the server with the installer, remove one of the two so the tools are not listed twice.

## Claude Desktop

Docs: https://modelcontextprotocol.io/docs/develop/connect-local-servers and https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp (verified 2026-11-14)

```sh
npx tsx integrations/install/src/bin.ts claude-desktop
```

- **What it writes.** `mcpServers.vid2context = { "command": "npx", "args": ["-y", "vid2context-mcp"] }` in `claude_desktop_config.json`: `~/Library/Application Support/Claude/` on macOS, `%APPDATA%\Claude\` on Windows, `~/.config/Claude/` on Linux. There is only a user scope.
- **Remote.** Claude Desktop does not read remote servers from this file. Add a remote endpoint in the app instead: Settings, Connectors, Add custom connector, paste the URL, then sign in with OAuth or add an `Authorization: Bearer <token>` request header. The installer prints these steps when you pass `--remote`.
- **Verify.** Quit and reopen Claude Desktop, then check the tools menu in a new chat.
- **Uninstall.** `npx tsx integrations/install/src/bin.ts claude-desktop --uninstall`, then restart the app.

## Cursor

Docs: https://cursor.com/docs/context/mcp (verified 2026-11-14)

```sh
npx tsx integrations/install/src/bin.ts cursor                     # ~/.cursor/mcp.json
npx tsx integrations/install/src/bin.ts cursor --scope project     # .cursor/mcp.json
```

- **What it writes.** `mcpServers.vid2context = { "type": "stdio", "command": "npx", "args": ["-y", "vid2context-mcp"] }`. Cursor's field table lists `type` as required for stdio, so it is included.
- **Remote.** `{ "url": ..., "headers": { "Authorization": "Bearer <token>" } }`. With `--token-env VAR` the header is `Bearer ${env:VAR}`.
- **Verify.** Cursor Settings, MCP: vid2context is listed and enabled.
- **Uninstall.** `npx tsx integrations/install/src/bin.ts cursor --uninstall`.

## VS Code (GitHub Copilot)

Docs: https://code.visualstudio.com/docs/agents/reference/mcp-configuration (verified 2026-11-14)

```sh
npx tsx integrations/install/src/bin.ts vscode                            # ~/.copilot/mcp-config.json (or $COPILOT_HOME)
npx tsx integrations/install/src/bin.ts vscode --scope project            # .mcp.json at the workspace root
npx tsx integrations/install/src/bin.ts vscode --scope project --legacy   # deprecated .vscode/mcp.json
```

- **What it writes.** The portable Copilot format that VS Code now recommends: `mcpServers.vid2context = { "type": "stdio", "command": "npx", "args": ["-y", "vid2context-mcp"], "tools": ["*"] }`. The workspace `.mcp.json` is the same file Claude Code reads for project servers, and both installers accept each other's entry, so installing for both leaves one entry that works in both.
- **Legacy.** VS Code documents `.vscode/mcp.json` and the profile `mcp.json` (key `servers`) as the deprecated Local harness format, to be removed in February 2027. `--legacy` writes `.vscode/mcp.json` for workspaces that still use it. The profile file's location is not documented, so it is not supported.
- **Remote.** `{ "type": "http", "url": ..., "headers": { "Authorization": "Bearer <token>" }, "tools": ["*"] }`. With `--token-env VAR` the header is `Bearer ${VAR}` (`${env:VAR}` in the legacy format).
- **Verify.** Command Palette, "MCP: List Servers", then start vid2context.
- **Uninstall.** `npx tsx integrations/install/src/bin.ts vscode --uninstall` with the same `--scope` and `--legacy` you installed with.

## OpenAI Codex (CLI, IDE extension, ChatGPT desktop app)

Docs: https://developers.openai.com/codex/mcp and https://developers.openai.com/codex/config-reference (verified 2026-11-14)

```sh
npx tsx integrations/install/src/bin.ts codex                     # ~/.codex/config.toml (or $CODEX_HOME)
npx tsx integrations/install/src/bin.ts codex --scope project     # .codex/config.toml
```

- **What it writes.** A `[mcp_servers.vid2context]` table with `command` and `args` (plus `[mcp_servers.vid2context.env]` when you pass `--env`), the same layout `codex mcp add` writes. Other tables, keys and comments are left as they are. Codex reads the project file only in projects you have trusted.
- **Remote.** `url` plus `http_headers = { Authorization = "Bearer <token>" }`, or with `--token-env VAR`, `bearer_token_env_var = "VAR"`, which keeps the token out of the file.
- **Verify.** `codex mcp list`, or `/mcp` inside Codex.
- **Uninstall.** `npx tsx integrations/install/src/bin.ts codex --uninstall`.

## Gemini CLI

Docs: https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md and https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md (verified 2026-11-14)

```sh
npx tsx integrations/install/src/bin.ts gemini-cli                    # ~/.gemini/settings.json
npx tsx integrations/install/src/bin.ts gemini-cli --scope project    # .gemini/settings.json
```

- **What it writes.** `mcpServers.vid2context = { "command": "npx", "args": ["-y", "vid2context-mcp"] }` in `settings.json`, leaving every other setting alone.
- **Remote.** `{ "httpUrl": ..., "headers": { "Authorization": "Bearer <token>" } }`. `httpUrl` is Gemini CLI's Streamable HTTP field (`url` means SSE there). Gemini CLI documents no env var references in headers, so `--token-env` is refused. Use `--token`.
- **Verify.** `gemini mcp list`, or `/mcp` inside Gemini CLI. If it lists vid2context as Disabled, trust the folder in Gemini CLI.
- **Uninstall.** `npx tsx integrations/install/src/bin.ts gemini-cli --uninstall`.
- **Extension.** `gemini extensions install https://github.com/nirholas/vid2context` installs the server from the repo's `gemini-extension.json`.

## Windsurf

Not supported by the installer. Windsurf's official MCP page (docs.windsurf.com/windsurf/cascade/mcp) now redirects to the Devin Desktop docs, which no longer define the Windsurf config format (checked 2026-11-14). Without a current official reference the installer does not guess. Windsurf users can paste the same `mcpServers` entry shown for Claude Desktop above into their Windsurf MCP config by hand.

## ChatGPT

Three ways in, from least to most setup:

1. **Projects, zero setup.** Build `context.md` with the CLI or web app and upload it to a ChatGPT or Claude Project. See [integrations/chatgpt/projects.md](../../integrations/chatgpt/projects.md) for the steps and the instruction text to paste.
2. **Custom GPT with an Action.** Generate the OpenAPI schema for your server with `npx tsx integrations/chatgpt/src/action.ts --server https://your-host`, then follow [integrations/chatgpt/custom-gpt-instructions.md](../../integrations/chatgpt/custom-gpt-instructions.md) for the instructions, conversation starters and Bearer auth.
3. **Remote MCP connector.** Deploy the server with its Streamable HTTP endpoint at `/mcp` (`packages/mcp-http`) and add that URL as a connector in ChatGPT (developer mode) or Claude.ai (custom connectors). Sign in with OAuth, or use a bearer token where the client lets you set headers. The model gets the same tools as the local server.

The server behind options 2 and 3 must reach YouTube. Many cloud IPs are blocked, so run it on a home connection or behind a Cloudflare Tunnel to one (see [youtube.md](youtube.md)).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Could not parse <file>` | The config was already invalid, so the installer left it alone. Fix the reported line, or paste the snippet from the hint by hand. |
| `... defines mcp_servers.vid2context inline` (Codex) | Replace the inline definition with the table printed in the hint. |
| `The claude CLI is not on PATH` | Install Claude Code, or use `--scope project` to write `.mcp.json`. |
| Client shows the server as failed, npx says the package is not found | Install from a checkout with `--from-source`, or with `--command` pointing at your own build. |
| Tool calls fail with `blocked` | YouTube refused the server's network. Use the local server (the default) rather than a remote one, or route the remote server through a home connection. |
| `no-transcript` | The video has no captions. Set up a speech-to-text rung (a free Groq key or local whisper.cpp, see [speech-to-text.md](speech-to-text.md)). |
| The tools are listed twice in Claude Code | Both the plugin and an installed server are active. Remove one: `claude plugin uninstall vid2context` or the installer's `--uninstall`. |
| A change went wrong | Copy the `<file>.vid2context-backup-<timestamp>` next to the config back over it. |
