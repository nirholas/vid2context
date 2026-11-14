/**
 * How each agent client adds vid2context. This is the one file the site reads
 * install steps from, so prompt 16 (integrations) can correct a command in one
 * place. The npm commands and one-click links come from
 * @vid2context/discovery through the generated data, never retyped here.
 *
 * Until `vid2context-mcp` is on npm (checked at build time), the steps run the
 * server from a clone instead, because `npx -y vid2context-mcp` would fail.
 */
import { data } from './site.ts';

export interface InstallStep {
  /** Markdown, one or two sentences. */
  text: string;
  code?: { lang: string; text: string };
  /** One-click buttons. Custom schemes (vscode:, cursor:, lmstudio:, goose:) work on the site. */
  buttons?: { label: string; href: string }[];
}

export interface Client {
  slug: string;
  name: string;
  /** Shown in the landing grid. */
  short: string;
  vendorDocs: string;
  steps: InstallStep[];
  /** Where to confirm the server is connected. */
  verify: string;
}

const i = data.install;
export const npmPublished = data.npm.published;

export const CLONE_STEP: InstallStep = {
  text: 'Clone the repo and install it once (Node.js 22 or newer). Run the next commands from the repo root.',
  code: { lang: 'sh', text: 'git clone https://github.com/nirholas/vid2context.git\ncd vid2context\nnpm install' },
};

/** Start command for the MCP server from a clone: absolute paths, so it works from any working directory. */
export const SOURCE_COMMAND_LINE = '"$PWD/node_modules/.bin/tsx" "$PWD/packages/mcp/src/bin.ts"';

/** A shell line that prints the client config with this clone's absolute paths filled in. */
function printConfig(shape: 'mcpServers' | 'servers'): string {
  const entry =
    shape === 'servers'
      ? '{"servers":{"vid2context":{"type":"stdio","command":"%s/node_modules/.bin/tsx","args":["%s/packages/mcp/src/bin.ts"]}}}'
      : '{"mcpServers":{"vid2context":{"command":"%s/node_modules/.bin/tsx","args":["%s/packages/mcp/src/bin.ts"]}}}';
  return `printf '${entry}\\n' "$PWD" "$PWD"`;
}

/** The JSON block for clients that read an `mcpServers` file, for the current install mode. */
function mcpServersSteps(file: string): InstallStep[] {
  if (npmPublished) {
    return [{ text: `Add the server to ${file}. Merge it into \`mcpServers\` if the file already has other servers.`, code: { lang: 'json', text: i.mcpServersJson } }];
  }
  return [
    CLONE_STEP,
    {
      text: `Print the config with this clone's paths, then add it to ${file}. Merge it into \`mcpServers\` if the file already has other servers.`,
      code: { lang: 'sh', text: printConfig('mcpServers') },
    },
  ];
}

const KEY_NOTE: InstallStep = {
  text: 'Keys are optional. To unlock more free rungs, add an `env` object to the entry, for example:',
  code: { lang: 'json', text: i.mcpServersJsonWithEnv },
};

export const clients: Client[] = [
  {
    slug: 'claude-code',
    name: 'Claude Code',
    short: 'One command, user scope, every project.',
    vendorDocs: 'https://code.claude.com/docs/en/mcp',
    steps: npmPublished
      ? [
          { text: 'Add the server for your user, so it is available in every project:', code: { lang: 'sh', text: i.claudeCode } },
          {
            text: 'With an optional key (another option has to sit between `--env` and the name):',
            code: { lang: 'sh', text: i.claudeCodeWithKey },
          },
        ]
      : [CLONE_STEP, { text: 'Add the server from the repo root:', code: { lang: 'sh', text: `claude mcp add vid2context -- ${SOURCE_COMMAND_LINE}` } }],
    verify: 'Run `claude mcp list`, or type `/mcp` inside Claude Code: vid2context shows as connected.',
  },
  {
    slug: 'claude-desktop',
    name: 'Claude Desktop',
    short: 'Add one block to claude_desktop_config.json.',
    vendorDocs: 'https://modelcontextprotocol.io/docs/develop/connect-local-servers',
    steps: [
      {
        text: 'Open Settings, Developer, Edit Config. The file is `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and `%APPDATA%\\Claude\\claude_desktop_config.json` on Windows.',
      },
      ...mcpServersSteps('`claude_desktop_config.json`'),
      KEY_NOTE,
      { text: 'Quit and reopen Claude Desktop so it starts the server.' },
    ],
    verify: 'The tools menu in a new chat lists vid2context with its tools.',
  },
  {
    slug: 'cursor',
    name: 'Cursor',
    short: 'One-click install, or ~/.cursor/mcp.json.',
    vendorDocs: 'https://cursor.com/docs/context/mcp',
    steps: npmPublished
      ? [
          {
            text: 'Click to install. Cursor opens and asks you to confirm.',
            buttons: [
              { label: 'Add to Cursor', href: i.cursorDeeplink },
              { label: 'Add to Cursor (web link)', href: i.cursorInstallUrl },
            ],
          },
          { text: 'Or add it by hand to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):', code: { lang: 'json', text: i.mcpServersJson } },
        ]
      : mcpServersSteps('`~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project)'),
    verify: 'Cursor Settings, MCP: vid2context has a green dot and lists its tools. Use it from the Agent chat.',
  },
  {
    slug: 'vscode',
    name: 'VS Code',
    short: 'One-click install for GitHub Copilot agent mode.',
    vendorDocs: 'https://code.visualstudio.com/docs/agents/reference/mcp-configuration',
    steps: npmPublished
      ? [
          {
            text: 'Click to install. VS Code opens and asks you to confirm.',
            buttons: [
              { label: 'Install in VS Code', href: i.vscodeInstallUrl },
              { label: 'Install in VS Code Insiders', href: i.vscodeInsidersInstallUrl },
            ],
          },
          { text: 'Or add it to `.vscode/mcp.json` in a workspace, or to your user profile\'s `mcp.json`:', code: { lang: 'json', text: i.vscodeMcpJson } },
        ]
      : [
          CLONE_STEP,
          {
            text: 'Register the server with the VS Code command line from the repo root:',
            code: {
              lang: 'sh',
              text: 'code --add-mcp "{\\"name\\":\\"vid2context\\",\\"command\\":\\"$PWD/node_modules/.bin/tsx\\",\\"args\\":[\\"$PWD/packages/mcp/src/bin.ts\\"]}"',
            },
          },
          { text: 'Or print a `.vscode/mcp.json` block with this clone\'s paths:', code: { lang: 'sh', text: printConfig('servers') } },
        ],
    verify: 'Open Copilot Chat in Agent mode and click the tools icon: vid2context and its tools are listed.',
  },
  {
    slug: 'codex',
    name: 'Codex',
    short: 'codex mcp add, stored in ~/.codex/config.toml.',
    vendorDocs: 'https://developers.openai.com/codex/mcp',
    steps: npmPublished
      ? [{ text: 'Add the server. Codex writes it to `~/.codex/config.toml`.', code: { lang: 'sh', text: i.codex } }]
      : [CLONE_STEP, { text: 'Add the server from the repo root. Codex writes it to `~/.codex/config.toml`.', code: { lang: 'sh', text: `codex mcp add vid2context -- ${SOURCE_COMMAND_LINE}` } }],
    verify: 'Run `codex mcp list`, or `/mcp` inside a Codex session.',
  },
  {
    slug: 'gemini-cli',
    name: 'Gemini CLI',
    short: 'Install as an extension straight from GitHub.',
    vendorDocs: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md',
    steps: npmPublished
      ? [
          {
            text: 'Install the extension. It reads `gemini-extension.json` from the repo and asks for the optional keys.',
            code: { lang: 'sh', text: i.gemini },
          },
        ]
      : mcpServersSteps('`~/.gemini/settings.json`'),
    verify: 'Run `/mcp` inside Gemini CLI: vid2context is listed with its tools.',
  },
  {
    slug: 'windsurf',
    name: 'Windsurf',
    short: 'Add one block to mcp_config.json.',
    vendorDocs: 'https://docs.windsurf.com/windsurf/cascade/mcp',
    steps: [
      { text: 'In Cascade, open the MCP servers panel and choose to edit the raw config. The file is `~/.codeium/windsurf/mcp_config.json`.' },
      ...mcpServersSteps('`mcp_config.json`'),
      KEY_NOTE,
    ],
    verify: 'Refresh the MCP servers panel in Cascade: vid2context shows its tools.',
  },
  {
    slug: 'cline',
    name: 'Cline',
    short: 'Add one block to cline_mcp_settings.json.',
    vendorDocs: 'https://docs.cline.bot/mcp/configuring-mcp-servers',
    steps: [
      { text: 'Click the MCP Servers icon in the Cline panel, open Configure, then Configure MCP Servers. That opens `cline_mcp_settings.json`.' },
      ...mcpServersSteps('`cline_mcp_settings.json`'),
      KEY_NOTE,
    ],
    verify: 'The Installed tab of the MCP Servers panel lists vid2context with a green status.',
  },
  {
    slug: 'lm-studio',
    name: 'LM Studio',
    short: 'One-click deeplink, or mcp.json.',
    vendorDocs: 'https://lmstudio.ai/docs/app/mcp',
    steps: npmPublished
      ? [
          { text: 'Click to add it. LM Studio opens and asks you to confirm.', buttons: [{ label: 'Add to LM Studio', href: i.lmStudioDeeplink }] },
          { text: 'Or open the Program tab, Install, Edit mcp.json, and add:', code: { lang: 'json', text: i.mcpServersJson } },
        ]
      : [{ text: 'Open the Program tab in the right sidebar, then Install, Edit mcp.json.' }, ...mcpServersSteps('`mcp.json`')],
    verify: 'In a chat, the integrations menu lists vid2context. Pick a model that supports tool use.',
  },
  {
    slug: 'goose',
    name: 'Goose',
    short: 'One-click deeplink, or goose configure.',
    vendorDocs: 'https://block.github.io/goose/docs/getting-started/using-extensions',
    steps: npmPublished
      ? [
          { text: 'Click to add the extension. Goose Desktop opens and asks you to confirm.', buttons: [{ label: 'Add to Goose', href: i.gooseDeeplink }] },
          { text: 'Or, in the Goose CLI, run `goose configure`, choose Add Extension, then Command-line Extension, and enter this command:', code: { lang: 'sh', text: i.mcpCommandLine } },
        ]
      : [
          CLONE_STEP,
          { text: 'Print the start command with this clone\'s paths:', code: { lang: 'sh', text: `echo ${SOURCE_COMMAND_LINE}` } },
          { text: 'Run `goose configure`, choose Add Extension, then Command-line Extension, name it `vid2context` and paste that command.' },
        ],
    verify: 'Start `goose session` and ask which extensions are enabled, or open Extensions in Goose Desktop.',
  },
];

/** ChatGPT only connects to remote MCP servers over HTTPS, so today it gets a context file instead. */
export const chatgpt = {
  name: 'ChatGPT',
  short: 'Upload a context pack to a Project or custom GPT.',
  steps: [
    {
      text: data.npm.cliPublished
        ? 'Render the video (or a whole playlist) as one Markdown context pack sized for upload. You only need Node.js 22 or newer:'
        : 'From a clone of the repo, render the video (or a whole playlist) as one Markdown context pack sized for upload:',
      code: {
        lang: 'sh',
        text: `${data.npm.cliPublished ? `npx -y ${data.npm.cliPackage}` : 'npm run -s cli --'} pack "https://www.youtube.com/watch?v=jNQXAC9IVRw" > context.md`,
      },
    },
    { text: 'In ChatGPT, open a Project (or edit a custom GPT), add `context.md` as a file, and ask about the video. Timestamps in the pack let it cite moments.' },
  ] satisfies InstallStep[],
};

export function clientBySlug(slug: string): Client {
  const c = clients.find((x) => x.slug === slug);
  if (!c) throw new Error(`Unknown client ${slug}`);
  return c;
}

/** The first step with a command, for the compact landing grid. */
export function primaryCommand(c: Client): { lang: string; text: string } | undefined {
  return c.steps.find((s) => s.code && s !== CLONE_STEP)?.code;
}
