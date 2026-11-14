/**
 * Every supported client: where its MCP config lives and the exact entry it
 * expects. Each one was checked against the vendor's official docs on the
 * date in `verified`; docs/guides/agents.md repeats the links. Clients whose
 * official docs could not be reached (Windsurf, whose MCP page now redirects
 * to Devin Desktop) are left out rather than guessed.
 */
import { join } from 'node:path';
import { Vid2ContextError } from '@vid2context/core';

export type Scope = 'user' | 'project';

export interface Environment {
  home: string;
  cwd: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

export interface LocalServer {
  kind: 'local';
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface RemoteServer {
  kind: 'remote';
  url: string;
  /** A token written into the config as `Authorization: Bearer <token>`. */
  token?: string;
  /** The name of an env var holding the token, referenced instead of writing the token. */
  tokenEnv?: string;
}

export type ServerSpec = LocalServer | RemoteServer;

export interface ClientDoc {
  url: string;
  verified: string;
}

interface ClientBase {
  id: string;
  label: string;
  docs: ClientDoc[];
  scopes: Scope[];
  defaultScope: Scope;
  /** Config file for a scope, or undefined when that scope has no file on this OS. */
  path(scope: Scope, e: Environment): string | undefined;
  /** One-line note shown by `list`. */
  note?: string;
}

export interface JsonClient extends ClientBase {
  format: 'json';
  /** Key holding the server map, for example mcpServers. */
  key(opts: { legacy?: boolean }): string;
  /** The entry to write, or a Vid2ContextError explaining why this client cannot take it. */
  entry(server: ServerSpec, opts: { legacy?: boolean }): Record<string, unknown>;
}

export interface TomlClient extends ClientBase {
  format: 'toml';
  /** Table path prefix, for example ['mcp_servers']. */
  table: string[];
  entry(server: ServerSpec): Record<string, unknown>;
}

export type Client = JsonClient | TomlClient;

export const SERVER_NAME = 'vid2context';
const VERIFIED = '2026-11-14';

function envObject(server: LocalServer): Record<string, unknown> {
  return Object.keys(server.env).length > 0 ? { env: { ...server.env } } : {};
}

/** `{ Authorization: 'Bearer ...' }`, or nothing when no token was given. `ref` formats an env var reference. */
function authHeaders(server: RemoteServer, ref?: (name: string) => string, client?: string): Record<string, unknown> {
  if (server.tokenEnv) {
    if (!ref) {
      throw new Vid2ContextError('bad-request', `${client} has no documented way to read a header from an env var.`, {
        hint: 'Pass the token with --token instead of --token-env.',
      });
    }
    return { headers: { Authorization: `Bearer ${ref(server.tokenEnv)}` } };
  }
  return server.token ? { headers: { Authorization: `Bearer ${server.token}` } } : {};
}

function appData(e: Environment): string {
  return e.env.APPDATA ?? join(e.home, 'AppData', 'Roaming');
}

const claudeCode: JsonClient = {
  id: 'claude-code',
  label: 'Claude Code',
  format: 'json',
  docs: [{ url: 'https://code.claude.com/docs/en/mcp', verified: VERIFIED }],
  scopes: ['user', 'project'],
  defaultScope: 'user',
  note: 'Uses `claude mcp add` when the claude CLI is on PATH; otherwise writes the project .mcp.json.',
  path: (scope, e) => (scope === 'project' ? join(e.cwd, '.mcp.json') : join(e.home, '.claude.json')),
  key: () => 'mcpServers',
  entry: (server) =>
    server.kind === 'local'
      ? { type: 'stdio', command: server.command, args: server.args, ...envObject(server) }
      : { type: 'http', url: server.url, ...authHeaders(server, (n) => `\${${n}}`) },
};

const claudeDesktop: JsonClient = {
  id: 'claude-desktop',
  label: 'Claude Desktop',
  format: 'json',
  docs: [
    { url: 'https://modelcontextprotocol.io/docs/develop/connect-local-servers', verified: VERIFIED },
    {
      url: 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp',
      verified: VERIFIED,
    },
  ],
  scopes: ['user'],
  defaultScope: 'user',
  note: 'Local servers only. Remote servers are added in the app as custom connectors.',
  path: (_scope, e) => {
    if (e.platform === 'darwin') return join(e.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    if (e.platform === 'win32') return join(appData(e), 'Claude', 'claude_desktop_config.json');
    return join(e.home, '.config', 'Claude', 'claude_desktop_config.json');
  },
  key: () => 'mcpServers',
  entry: (server) => {
    if (server.kind === 'remote') {
      throw new Vid2ContextError('unsupported-input', 'Claude Desktop does not read remote servers from claude_desktop_config.json.', {
        hint:
          `In Claude Desktop open Settings, Connectors, Add custom connector, and paste ${server.url}. ` +
          'Use the connector form to add a request header (Authorization: Bearer <token>) or sign in with OAuth. ' +
          'Or run this installer without --remote to use the free local server.',
      });
    }
    return { command: server.command, args: server.args, ...envObject(server) };
  },
};

const cursor: JsonClient = {
  id: 'cursor',
  label: 'Cursor',
  format: 'json',
  docs: [{ url: 'https://cursor.com/docs/context/mcp', verified: VERIFIED }],
  scopes: ['user', 'project'],
  defaultScope: 'user',
  path: (scope, e) => (scope === 'project' ? join(e.cwd, '.cursor', 'mcp.json') : join(e.home, '.cursor', 'mcp.json')),
  key: () => 'mcpServers',
  entry: (server) =>
    server.kind === 'local'
      ? { type: 'stdio', command: server.command, args: server.args, ...envObject(server) }
      : { url: server.url, ...authHeaders(server, (n) => `\${env:${n}}`) },
};

const vscode: JsonClient = {
  id: 'vscode',
  label: 'VS Code (GitHub Copilot)',
  format: 'json',
  docs: [{ url: 'https://code.visualstudio.com/docs/agents/reference/mcp-configuration', verified: VERIFIED }],
  scopes: ['user', 'project'],
  defaultScope: 'user',
  note: 'Writes the portable Copilot format. --legacy writes the deprecated .vscode/mcp.json (project scope only).',
  path: (scope, e) => {
    if (scope === 'project') return join(e.cwd, '.mcp.json');
    return join(e.env.COPILOT_HOME ?? join(e.home, '.copilot'), 'mcp-config.json');
  },
  key: ({ legacy }) => (legacy ? 'servers' : 'mcpServers'),
  entry: (server, { legacy }) => {
    if (server.kind === 'local') {
      const base = { type: 'stdio', command: server.command, args: server.args, ...envObject(server) };
      return legacy ? base : { ...base, tools: ['*'] };
    }
    const headers = authHeaders(server, (n) => (legacy ? `\${env:${n}}` : `\${${n}}`));
    return legacy ? { type: 'http', url: server.url, ...headers } : { type: 'http', url: server.url, ...headers, tools: ['*'] };
  },
};

/** Legacy VS Code path, kept separate because it only exists per workspace. */
export function vscodeLegacyPath(e: Environment): string {
  return join(e.cwd, '.vscode', 'mcp.json');
}

const codex: TomlClient = {
  id: 'codex',
  label: 'OpenAI Codex (CLI, IDE extension, ChatGPT desktop)',
  format: 'toml',
  docs: [
    { url: 'https://developers.openai.com/codex/mcp', verified: VERIFIED },
    { url: 'https://developers.openai.com/codex/config-reference', verified: VERIFIED },
  ],
  scopes: ['user', 'project'],
  defaultScope: 'user',
  note: 'Project config (.codex/config.toml) is read only in projects you have trusted in Codex.',
  path: (scope, e) =>
    scope === 'project' ? join(e.cwd, '.codex', 'config.toml') : join(e.env.CODEX_HOME ?? join(e.home, '.codex'), 'config.toml'),
  table: ['mcp_servers'],
  entry: (server) => {
    if (server.kind === 'local') return { command: server.command, args: server.args, ...envObject(server) };
    if (server.tokenEnv) return { url: server.url, bearer_token_env_var: server.tokenEnv };
    return server.token ? { url: server.url, http_headers: { Authorization: `Bearer ${server.token}` } } : { url: server.url };
  },
};

const geminiCli: JsonClient = {
  id: 'gemini-cli',
  label: 'Gemini CLI',
  format: 'json',
  docs: [
    { url: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md', verified: VERIFIED },
    { url: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md', verified: VERIFIED },
  ],
  scopes: ['user', 'project'],
  defaultScope: 'user',
  path: (scope, e) =>
    scope === 'project' ? join(e.cwd, '.gemini', 'settings.json') : join(e.home, '.gemini', 'settings.json'),
  key: () => 'mcpServers',
  entry: (server) =>
    server.kind === 'local'
      ? { command: server.command, args: server.args, ...envObject(server) }
      : { httpUrl: server.url, ...authHeaders(server, undefined, 'Gemini CLI') },
};

export const CLIENTS: Client[] = [claudeCode, claudeDesktop, cursor, vscode, codex, geminiCli];

export function getClient(id: string): Client {
  const client = CLIENTS.find((c) => c.id === id);
  if (!client) {
    throw new Vid2ContextError('unsupported-input', `Unknown client: ${id}`, {
      hint: `Supported clients: ${CLIENTS.map((c) => c.id).join(', ')}. Run the installer with "list" to see where each config lives.`,
    });
  }
  return client;
}
