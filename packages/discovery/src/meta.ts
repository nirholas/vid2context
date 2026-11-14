/**
 * The facts every discovery surface repeats: names, descriptions, links,
 * keywords and the optional environment variables. Every manifest, npm
 * package and well-known document is generated from this one module, so
 * a rename or a version bump cannot leave a registry listing behind.
 */
import cliPkg from '../../cli/package.json' with { type: 'json' };
import mcpPkg from '../../mcp/package.json' with { type: 'json' };

export const SITE_URL = 'https://vid2context.com';
export const REPO_URL = 'https://github.com/nirholas/vid2context';
export const REPO_GIT_URL = 'git+https://github.com/nirholas/vid2context.git';
export const GITHUB_OWNER = 'nirholas';
export const LICENSE = 'Apache-2.0';

/** Name in the official MCP Registry. The io.github namespace is proven by GitHub login, so no DNS key is needed. */
export const MCP_REGISTRY_NAME = 'io.github.nirholas/vid2context';

export const TITLE = 'vid2context';

/** Short form for listings that cap length (the MCP Registry allows 100 characters). */
export const SHORT_DESCRIPTION = 'Turn any video into context for AI agents: transcripts, metadata, chapters, timestamps.';

export const DESCRIPTION =
  'Turn any video into context for AI agents and LLMs: YouTube transcripts, captions, speech-to-text, metadata and chapters with timestamps your agent can cite. Free-first: local models, then free tiers, then keyless hosts, paid APIs last. Works with zero configuration.';

export const KEYWORDS = [
  'mcp',
  'mcp-server',
  'model-context-protocol',
  'youtube',
  'youtube-transcript',
  'transcript',
  'captions',
  'subtitles',
  'speech-to-text',
  'whisper',
  'video-to-text',
  'video-transcription',
  'ai-agents',
  'llm',
  'context-engineering',
  'rag',
  'claude',
  'chatgpt',
  'cursor',
  'local-llm',
];

export interface PublishedPackage {
  /** npm package name. */
  name: string;
  /** Command the package installs. */
  bin: string;
  version: string;
  description: string;
  /** Workspace entry point that gets bundled. */
  entry: string;
  /** Workspace directory, recorded as `repository.directory`. */
  directory: string;
  mcpName?: string;
}

export const MCP_PACKAGE: PublishedPackage = {
  name: 'vid2context-mcp',
  bin: 'vid2context-mcp',
  version: mcpPkg.version,
  description: `MCP server for vid2context. ${DESCRIPTION}`,
  entry: 'packages/mcp/src/bin.ts',
  directory: 'packages/mcp',
  mcpName: MCP_REGISTRY_NAME,
};

export const CLI_PACKAGE: PublishedPackage = {
  name: 'vid2context',
  bin: 'vid2context',
  version: cliPkg.version,
  description: `Command line for vid2context. ${DESCRIPTION}`,
  entry: 'packages/cli/src/bin.ts',
  directory: 'packages/cli',
};

export const PACKAGES = [MCP_PACKAGE, CLI_PACKAGE];

/** How an MCP client starts the server from npm. */
export const MCP_COMMAND = { command: 'npx', args: ['-y', MCP_PACKAGE.name] } as const;

export interface EnvVar {
  name: string;
  /** Human label for install dialogs. */
  label: string;
  description: string;
  secret: boolean;
}

/**
 * The keys worth surfacing in install dialogs. All are optional: with none
 * set, captions and the keyless rungs still work. The full list, with
 * every model override, is in .env.example and docs/providers.md.
 */
export const ENV_VARS: EnvVar[] = [
  {
    name: 'GROQ_API_KEY',
    label: 'Groq API key',
    description: 'Groq free tier: fast Whisper speech-to-text and LLMs',
    secret: true,
  },
  { name: 'GEMINI_API_KEY', label: 'Gemini API key', description: 'Google AI Studio free tier LLMs', secret: true },
  { name: 'OPENAI_API_KEY', label: 'OpenAI API key', description: 'OpenAI, used last and only when set', secret: true },
  {
    name: 'OLLAMA_BASE_URL',
    label: 'Ollama URL',
    description: 'Local Ollama server, for example http://localhost:11434/v1',
    secret: false,
  },
  {
    name: 'LOCAL_STT_BASE_URL',
    label: 'Local speech-to-text URL',
    description: 'Local OpenAI-compatible speech-to-text server, for example http://localhost:8000/v1',
    secret: false,
  },
];
