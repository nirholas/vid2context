# Installer fixtures

Real MCP client config files. Each one was either written by the client's own CLI on this machine or copied verbatim from the client's official docs. Nothing here was written by hand. All were recorded on 2026-11-14. They hold no personal data: the CLI-generated files were made in empty temp homes, and the example values (`your-api-token`, `/Users/username`) are the vendors' own.

| File | Source |
|---|---|
| `claude-code/cli-project.mcp.json` | Written by Claude Code 2.1.325 in an empty temp project: `claude mcp add --scope project everything -- npx -y @modelcontextprotocol/server-everything`, then `claude mcp add --scope project --transport http sentry https://mcp.sentry.dev/mcp --header "X-Example: 1"` |
| `claude-code/docs-stdio.mcp.json` | The `.mcp.json` example at https://code.claude.com/docs/en/mcp |
| `claude-desktop/docs-macos.json` | The macOS `claude_desktop_config.json` example at https://modelcontextprotocol.io/docs/develop/connect-local-servers |
| `cursor/docs-stdio.json` | "CLI Server - Node.js" example at https://cursor.com/docs/context/mcp |
| `cursor/docs-remote-commented.json` | "Remote Server" example at https://cursor.com/docs/context/mcp, including its leading `//` comment |
| `vscode/docs-portable.json` | The portable `.mcp.json` / `mcp-config.json` Playwright example at https://code.visualstudio.com/docs/agents/reference/mcp-configuration |
| `vscode/docs-legacy.json` | The deprecated editor-managed `.vscode/mcp.json` example (with `inputs`) on the same page |
| `codex/cli-generated.toml` | Written by Codex CLI 0.169.0 with an empty `CODEX_HOME`: `codex mcp add everything -- npx -y @modelcontextprotocol/server-everything`, then `codex mcp add sentry --url https://mcp.sentry.dev/mcp --bearer-token-env-var SENTRY_TOKEN` |
| `codex/docs-mcp.toml` | The two `[mcp_servers.*]` examples (stdio `context7`, HTTP `figma`) at https://developers.openai.com/codex/mcp, one after the other |
| `codex/docs-commented.toml` | The approvals and sandbox example (comments, inline comments, a sub-table) at https://developers.openai.com/codex/config-advanced |
| `gemini-cli/cli-user.json` | Written by Gemini CLI 0.67.0 with an empty home: `gemini mcp add --scope user everything npx -y @modelcontextprotocol/server-everything` (no trailing newline, as the CLI writes it) |
| `gemini-cli/cli-project.json` | Written by Gemini CLI 0.67.0 in an empty project: `gemini mcp add --scope project --transport http sentry https://mcp.sentry.dev/mcp -H "X-Example: 1"`, then the stdio `everything` server |
| `gemini-cli/docs-http-auth.json` | The `httpServerWithAuth` example at https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md |
| `gemini-cli/docs-settings.json` | The full example `settings.json` at https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md (many non-MCP keys) |

The parse-failure tests cut one of these files short at runtime, so they too start from real data.
