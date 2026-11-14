/**
 * Install commands and one-click links for MCP clients, all built from
 * MCP_COMMAND so every client starts the same published package. Link
 * formats follow each vendor's docs as of 2026-11 (VS Code
 * api/extension-guides/ai/mcp.md, cursor.com/docs/context/mcp/install-links).
 */
import { ENV_VARS, MCP_COMMAND, MCP_REGISTRY_NAME, TITLE } from './meta.ts';

const NAME = TITLE;
const COMMAND_LINE = `${MCP_COMMAND.command} ${MCP_COMMAND.args.join(' ')}`;
const serverConfig = () => ({ command: MCP_COMMAND.command, args: [...MCP_COMMAND.args] });

/** Claude Code, user scope so it works in every project. */
export const claudeCodeCommand = `claude mcp add --scope user --transport stdio ${NAME} -- ${COMMAND_LINE}`;

/** Claude Code with a key: another option must sit between --env and the name, or the name parses as KEY=value. */
export const claudeCodeCommandWithKey = `claude mcp add --env GROQ_API_KEY=your-key --scope user --transport stdio ${NAME} -- ${COMMAND_LINE}`;

export const codexCommand = `codex mcp add ${NAME} -- ${COMMAND_LINE}`;

export const geminiCommand = `gemini extensions install https://github.com/nirholas/vid2context`;

/** The `mcpServers` block used by Claude Desktop, Cursor, Windsurf, Cline and most other clients. */
export function mcpServersJson(withEnv = false): string {
  const env = withEnv ? { env: { GROQ_API_KEY: 'your-key' } } : {};
  return JSON.stringify({ mcpServers: { [NAME]: { ...serverConfig(), ...env } } }, null, 2);
}

/** VS Code's `servers` shape for `.vscode/mcp.json` or the user profile's mcp.json. */
export function vscodeMcpJson(): string {
  return JSON.stringify({ servers: { [NAME]: { type: 'stdio', ...serverConfig() } } }, null, 2);
}

/** Raw VS Code deeplink. GitHub strips custom schemes, so READMEs use vscodeInstallUrl instead. */
export function vscodeDeeplink(insiders = false): string {
  const scheme = insiders ? 'vscode-insiders' : 'vscode';
  return `${scheme}:mcp/install?${encodeURIComponent(JSON.stringify({ name: NAME, ...serverConfig() }))}`;
}

/** https wrapper around the deeplink that works from GitHub and any web page. */
export function vscodeInstallUrl(insiders = false): string {
  return `https://vscode.dev/redirect?url=${encodeURIComponent(vscodeDeeplink(insiders))}`;
}

/** Opens the server by its MCP Registry name in VS Code (works once it is published there). */
export const vscodeRegistryDeeplink = `vscode:mcp/by-name/${MCP_REGISTRY_NAME}`;

function base64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

/** Cursor deeplink: the config is the base64 of the server object, without the name. */
export function cursorDeeplink(): string {
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(NAME)}&config=${encodeURIComponent(
    base64(JSON.stringify(serverConfig())),
  )}`;
}

/** https form of the Cursor link, for GitHub where custom schemes are stripped. */
export function cursorInstallUrl(): string {
  return `https://cursor.com/install-mcp?name=${encodeURIComponent(NAME)}&config=${encodeURIComponent(
    base64(JSON.stringify(serverConfig())),
  )}`;
}

export const cursorBadge = 'https://cursor.com/deeplink/mcp-install-dark.svg';

/** LM Studio deeplink (custom scheme, so for web pages, not GitHub). */
export function lmStudioDeeplink(): string {
  return `lmstudio://add_mcp?name=${encodeURIComponent(NAME)}&config=${encodeURIComponent(base64(JSON.stringify(serverConfig())))}`;
}

/** Goose deeplink: one `arg` per argument. */
export function gooseDeeplink(description: string): string {
  const args = MCP_COMMAND.args.map((a) => `&arg=${encodeURIComponent(a)}`).join('');
  return `goose://extension?cmd=${encodeURIComponent(MCP_COMMAND.command)}${args}&id=${NAME}&name=${NAME}&description=${encodeURIComponent(description)}`;
}

/** Markdown list of the optional keys, for READMEs and install guides. */
export function envVarsMarkdown(): string {
  return ENV_VARS.map((v) => `- \`${v.name}\`: ${v.description}`).join('\n');
}
