/**
 * Install commands and one-click links for MCP clients. Each is built from
 * MCP_COMMAND so every client starts the same published package.
 */
import { MCP_COMMAND, TITLE } from './meta.ts';

const NAME = TITLE;

/** `claude mcp add` for Claude Code, user scope so it works in every project. */
export const claudeCodeCommand = `claude mcp add --scope user ${NAME} -- ${MCP_COMMAND.command} ${MCP_COMMAND.args.join(' ')}`;

/** Codex CLI command. */
export const codexCommand = `codex mcp add ${NAME} -- ${MCP_COMMAND.command} ${MCP_COMMAND.args.join(' ')}`;

/** Gemini CLI command. */
export const geminiCommand = `gemini mcp add ${NAME} ${MCP_COMMAND.command} ${MCP_COMMAND.args.join(' ')}`;

/** The `mcpServers` block used by Claude Desktop, Cursor, Windsurf, Cline and most other clients. */
export function mcpServersJson(): string {
  return JSON.stringify({ mcpServers: { [NAME]: { command: MCP_COMMAND.command, args: [...MCP_COMMAND.args] } } }, null, 2);
}

/** VS Code's own `servers` shape for `.vscode/mcp.json`. */
export function vscodeMcpJson(): string {
  return JSON.stringify({ servers: { [NAME]: { type: 'stdio', command: MCP_COMMAND.command, args: [...MCP_COMMAND.args] } } }, null, 2);
}

function vscodeConfig(): string {
  return JSON.stringify({ name: NAME, command: MCP_COMMAND.command, args: [...MCP_COMMAND.args] });
}

/** Opens VS Code's MCP install prompt. The https form works from GitHub, where custom schemes are stripped. */
export function vscodeInstallUrl(insiders = false): string {
  const scheme = insiders ? 'vscode-insiders' : 'vscode';
  return `https://insiders.vscode.dev/redirect/mcp/install?name=${encodeURIComponent(NAME)}&config=${encodeURIComponent(
    JSON.stringify({ command: MCP_COMMAND.command, args: [...MCP_COMMAND.args] }),
  )}${insiders ? '&quality=insiders' : ''}`.replace('insiders.vscode.dev', insiders ? 'insiders.vscode.dev' : 'insiders.vscode.dev') +
    (scheme ? '' : '');
}

/** The raw `vscode:` deeplink, for pages that are not on GitHub. */
export function vscodeDeeplink(insiders = false): string {
  return `${insiders ? 'vscode-insiders' : 'vscode'}:mcp/install?${encodeURIComponent(vscodeConfig())}`;
}

function base64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

/** Cursor's install link: base64 of the server config. */
export function cursorInstallUrl(): string {
  const config = base64(JSON.stringify({ command: MCP_COMMAND.command, args: [...MCP_COMMAND.args] }));
  return `https://cursor.com/en/install-mcp?name=${encodeURIComponent(NAME)}&config=${encodeURIComponent(config)}`;
}

export function cursorDeeplink(): string {
  const config = base64(JSON.stringify({ command: MCP_COMMAND.command, args: [...MCP_COMMAND.args] }));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(NAME)}&config=${encodeURIComponent(config)}`;
}
