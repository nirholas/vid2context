/**
 * Generates every discovery manifest from meta.ts. The root copies are
 * written by `npm run discovery:gen`, and a test fails `npm run check` when
 * a committed copy drifts from what this module produces.
 *
 * Formats, checked 2026-11-14:
 * - server.json: MCP Registry schema 2025-12-11 (registry CLI v1.8.9)
 * - glama.json: https://glama.ai/mcp/schemas/server.json
 * - gemini-extension.json: gemini-cli docs/extensions/reference.md
 * - context7.json: https://context7.com/schema/context7.json
 * - llms-install.md: Cline MCP Marketplace convention
 */
import {
  claudeCodeCommand,
  claudeCodeCommandWithKey,
  codexCommand,
  cursorBadge,
  cursorInstallUrl,
  envVarsMarkdown,
  geminiCommand,
  mcpServersJson,
  vscodeInstallUrl,
  vscodeMcpJson,
} from './install.ts';
import {
  CLI_PACKAGE,
  DESCRIPTION,
  ENV_VARS,
  GITHUB_OWNER,
  MCP_COMMAND,
  MCP_PACKAGE,
  MCP_REGISTRY_NAME,
  type PublishedPackage,
  REPO_URL,
  SHORT_DESCRIPTION,
  SITE_URL,
  TITLE,
} from './meta.ts';

export const LOGO_PNG_URL = 'https://raw.githubusercontent.com/nirholas/vid2context/main/packages/discovery/assets/logo.png';
export const SERVER_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';

export function serverJson() {
  return {
    $schema: SERVER_SCHEMA,
    name: MCP_REGISTRY_NAME,
    title: TITLE,
    description: SHORT_DESCRIPTION,
    version: MCP_PACKAGE.version,
    websiteUrl: SITE_URL,
    repository: { url: REPO_URL, source: 'github' },
    icons: [{ src: LOGO_PNG_URL, mimeType: 'image/png', sizes: ['400x400'] }],
    packages: [
      {
        registryType: 'npm',
        registryBaseUrl: 'https://registry.npmjs.org',
        identifier: MCP_PACKAGE.name,
        version: MCP_PACKAGE.version,
        transport: { type: 'stdio' },
        environmentVariables: ENV_VARS.map((v) => ({
          name: v.name,
          description: `Optional. ${v.description}`,
          isRequired: false,
          isSecret: v.secret,
          format: 'string',
        })),
      },
    ],
  };
}

export function glamaJson() {
  return { $schema: 'https://glama.ai/mcp/schemas/server.json', maintainers: [GITHUB_OWNER] };
}

export function geminiExtensionJson() {
  return {
    name: TITLE,
    version: MCP_PACKAGE.version,
    description: SHORT_DESCRIPTION,
    mcpServers: { [TITLE]: { command: MCP_COMMAND.command, args: [...MCP_COMMAND.args] } },
    // Extensions do not inherit the shell environment, so every key the server reads is declared here.
    settings: ENV_VARS.map((v) => ({
      name: v.label,
      description: `Optional, leave empty to skip. ${v.description}`,
      envVar: v.name,
      sensitive: v.secret,
    })),
  };
}

export function context7Json() {
  return {
    $schema: 'https://context7.com/schema/context7.json',
    projectTitle: TITLE,
    description: DESCRIPTION,
    branch: 'main',
    folders: ['docs', 'packages', 'providers'],
    excludeFolders: [
      'docs/prompts',
      'tests/fixtures',
      'packages/*/test/fixtures',
      'providers/*/test/fixtures',
      'packages/registry/src/generated',
    ],
    rules: [
      'Run the MCP server with `npx -y vid2context-mcp`; it needs no keys and prefers existing captions before speech-to-text.',
      'In library code, call getVideoContext from @vid2context/core with a registry from @vid2context/registry/node and a context from createNodeContext.',
      'Providers never read process.env or the global fetch: they use ctx.env, ctx.fetch, ctx.log and ctx.signal.',
      'Raw transcripts are always kept; summaries and briefs are added layers.',
      'Every model id is overridable from env; see .env.example and docs/providers.md.',
      'Import workspace packages with explicit .ts extensions; packages export TypeScript source.',
    ],
  };
}

export function llmsInstallMd(): string {
  return `# Installing vid2context

These steps are for AI agents (Cline, Claude Code, Cursor and others) setting up the vid2context MCP server for a user.

vid2context turns a video URL or a local media file into context: the transcript with timestamps, metadata and chapters. It needs Node.js 22 or newer and no API keys.

## 1. Add the server

Add this to the client's MCP settings (for Cline, \`cline_mcp_settings.json\`):

\`\`\`json
${mcpServersJson()}
\`\`\`

Claude Code users can run:

\`\`\`sh
${claudeCodeCommand}
\`\`\`

## 2. Optional keys

Nothing is required: creator captions and auto-captions work with no key, and speech-to-text falls back to keyless hosts. Ask the user whether they have any of these, and if so add them under \`"env"\` in the server entry:

${envVarsMarkdown()}

## 3. Verify

Call the \`get_transcript\` tool with \`{"url": "https://www.youtube.com/watch?v=jNQXAC9IVRw", "timestamps": true}\`. The result starts with a header (title, channel, URL) followed by lines such as \`[0:01] All right, so here we are, in front of the elephants\`.

If a call fails, the error carries a \`hint\` that says how to recover. Source and docs: ${REPO_URL}
`;
}

const MCP_README_TOOLS = `28 tools, grouped by job:

- One video: \`get_transcript\` (text with \`[m:ss]\` timestamps, JSON, Markdown, SRT, VTT or a context pack), \`get_metadata\`, \`get_outline\` (chapters with token counts; start here for long videos), \`get_section\`, \`get_comments\`, \`get_key_moments\`, \`get_skip_segments\`, \`list_caption_languages\`, \`choose_caption_track\`, \`list_formats\`
- Many videos: \`list_items\` (expand a playlist, channel, feed or page), \`research_videos\`, \`export_context_pack\`, \`find_duplicates\`, \`digest_videos\`
- Library: \`create_collection\`, \`add_to_collection\`, \`get_collection\`, \`list_collections\`, \`search_transcript\`
- Answers: \`ask\` (Q&A with timestamp citations), \`build_brief\` (cited brief across videos), \`extract\` (buyer guide, tutorial steps, comparison or your own JSON Schema)
- Live and export: \`watch_live\`, \`open_transcript_viewer\`, \`export_obsidian\`, \`export_notion\`
- Setup: \`list_models\`

Prompts: \`brief\`, \`buyer_guide\`, \`digest\`. Resources: saved videos, transcripts and collections.`;

export function npmReadme(pkg: PublishedPackage): string {
  if (pkg.name === MCP_PACKAGE.name) {
    return `# vid2context-mcp

${DESCRIPTION}

This is the MCP server for [vid2context](${REPO_URL}). Give your agent a YouTube link or a media file and it gets the transcript with timestamps it can cite.

## Install

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_vid2context-0098FF?logo=visualstudiocode&logoColor=white)](${vscodeInstallUrl()}) [![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_vid2context-24bfa5?logo=visualstudiocode&logoColor=white)](${vscodeInstallUrl(true)}) [![Install in Cursor](${cursorBadge})](${cursorInstallUrl()})

Claude Code:

\`\`\`sh
${claudeCodeCommand}
\`\`\`

Codex: \`${codexCommand}\`. Gemini CLI: \`${geminiCommand}\`.

Claude Desktop, Cursor, Windsurf, Cline and other clients:

\`\`\`json
${mcpServersJson()}
\`\`\`

VS Code (\`.vscode/mcp.json\`):

\`\`\`json
${vscodeMcpJson()}
\`\`\`

## Tools

${MCP_README_TOOLS}

## Keys (all optional)

It works with no configuration. Keys unlock faster or better rungs; pass them as \`env\` in the server entry:

${envVarsMarkdown()}

With a key in Claude Code: \`${claudeCodeCommandWithKey}\`

The full list, with model overrides, is in [.env.example](${REPO_URL}/blob/main/.env.example) and [docs/providers.md](${REPO_URL}/blob/main/docs/providers.md).

## Links

- Website: ${SITE_URL}
- Source, issues and docs: ${REPO_URL}
- MCP Registry name: \`${MCP_REGISTRY_NAME}\`

License: Apache-2.0
`;
  }
  if (pkg.name === CLI_PACKAGE.name) {
    return `# vid2context

${DESCRIPTION}

\`\`\`sh
npx vid2context https://www.youtube.com/watch?v=jNQXAC9IVRw --timestamps
npx vid2context ./interview.mp3 --format json > interview.json
\`\`\`

Commands: \`get\` (the default), \`list\` (expand a playlist, channel, feed or page), \`pack\` (one context pack for many videos), \`bundle\` (a .zip with every format), \`search\`, \`library\`, \`collection\`, \`models\`, \`doctor\`, \`config\`, \`serve\` (HTTP API), \`mcp\` (stdio MCP server). Formats: text, json, markdown, srt, vtt, pack.

Run \`npx vid2context --help\` for every option.

For agents, use the MCP server: \`npx -y vid2context-mcp\` ([vid2context-mcp](https://www.npmjs.com/package/vid2context-mcp)).

## Keys (all optional)

${envVarsMarkdown()}

Put keys in a \`.env\` file in the working directory or export them. The full list is in [.env.example](${REPO_URL}/blob/main/.env.example).

## Links

- Website: ${SITE_URL}
- Source, issues and docs: ${REPO_URL}

License: Apache-2.0
`;
  }
  throw new Error(`no README template for ${pkg.name}`);
}

/** Root files generated from this module, keyed by repo-relative path. */
export function rootFiles(): Record<string, string> {
  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  return {
    'server.json': json(serverJson()),
    'glama.json': json(glamaJson()),
    'gemini-extension.json': json(geminiExtensionJson()),
    'context7.json': json(context7Json()),
    'llms-install.md': llmsInstallMd(),
  };
}
