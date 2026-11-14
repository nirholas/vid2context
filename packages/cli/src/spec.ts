/**
 * The command table. Parsing, `--help` and the shell completion scripts are
 * all generated from it, so they cannot drift apart. Formatter ids come from
 * the `formatters` map at runtime, never from a list written here.
 */
import { formatters } from '@vid2context/core';

export interface FlagSpec {
  name: string;
  type: 'string' | 'boolean';
  short?: string;
  /** Placeholder shown in help, e.g. "<id>". */
  arg?: string;
  description: string;
  multiple?: boolean;
  /** Allowed values, used for validation hints and shell completion. */
  choices?: () => string[];
}

export interface SubcommandSpec {
  name: string;
  args: string;
  summary: string;
}

export interface CommandSpec {
  name: string;
  /** Positional arguments as shown in usage, e.g. "<input>". */
  args: string;
  summary: string;
  /** Command-specific flag names (keys of FLAGS). Global flags apply everywhere. */
  flags: string[];
  subcommands?: SubcommandSpec[];
  /** Whether positionals are files or URLs (shell completion offers files). */
  completesFiles?: boolean;
  notes?: string[];
  examples: string[];
}

export const MODES = ['auto', 'captions', 'stt', 'video'] as const;
export const POLICIES = ['free', 'local-only', 'quality'] as const;
export const MODEL_KINDS = ['llm', 'stt', 'embed', 'video', 'visual'] as const;
export const SHELLS = ['bash', 'zsh', 'fish'] as const;

const formatIds = () => Object.keys(formatters);

/** Every flag the CLI knows. GLOBAL_FLAGS are accepted by every command. */
export const FLAGS: Record<string, FlagSpec> = {
  format: {
    name: 'format',
    type: 'string',
    short: 'f',
    arg: '<id>',
    description: 'Output format (default: text)',
    choices: formatIds,
  },
  timestamps: {
    name: 'timestamps',
    type: 'boolean',
    short: 't',
    description: 'Prefix lines with timestamps where the format allows',
  },
  mode: {
    name: 'mode',
    type: 'string',
    arg: '<mode>',
    description: 'auto | captions | stt | video (default: auto)',
    choices: () => [...MODES],
  },
  lang: { name: 'lang', type: 'string', arg: '<code>', description: 'Preferred transcript language, e.g. en, de, pt-BR' },
  policy: {
    name: 'policy',
    type: 'string',
    arg: '<policy>',
    description: 'Rung order: free | local-only | quality (default: VID2CONTEXT_POLICY or free)',
    choices: () => [...POLICIES],
  },
  only: {
    name: 'only',
    type: 'string',
    arg: '<ids>',
    multiple: true,
    description: 'Use only these rung ids, services or providers (comma-separated)',
  },
  skip: {
    name: 'skip',
    type: 'string',
    arg: '<ids>',
    multiple: true,
    description: 'Never use these rung ids, services or providers (comma-separated)',
  },
  'allow-paid': { name: 'allow-paid', type: 'boolean', description: 'Allow paid rungs even when VID2CONTEXT_ALLOW_PAID=0' },
  json: { name: 'json', type: 'boolean', description: 'Machine-readable JSON on stdout (errors as JSON on stderr)' },
  quiet: { name: 'quiet', type: 'boolean', short: 'q', description: 'No progress or notes on stderr, only errors' },
  verbose: { name: 'verbose', type: 'boolean', description: 'Log progress and print the attempts list to stderr' },
  out: {
    name: 'out',
    type: 'string',
    short: 'o',
    arg: '<file>',
    description: 'Write program output to a file instead of stdout',
  },
  force: { name: 'force', type: 'boolean', description: 'Overwrite the --out file if it exists' },
  help: { name: 'help', type: 'boolean', short: 'h', description: 'Show help' },
  version: { name: 'version', type: 'boolean', short: 'v', description: 'Show the version' },

  comments: { name: 'comments', type: 'string', arg: '[n]', description: 'Fetch comments too, optionally at most n' },
  refresh: { name: 'refresh', type: 'boolean', description: 'Ignore the cached copy in the library and fetch again' },
  limit: { name: 'limit', type: 'string', arg: '<n>', description: 'At most n results' },
  'max-tokens': { name: 'max-tokens', type: 'string', arg: '<n>', description: 'Token budget for the context pack' },
  name: { name: 'name', type: 'string', arg: '<name>', description: 'Root folder and zip name inside the bundle' },
  collection: { name: 'collection', type: 'string', arg: '<id>', description: 'Search only this collection' },
  description: { name: 'description', type: 'string', arg: '<text>', description: 'Collection description' },
  source: {
    name: 'source',
    type: 'string',
    arg: '<input>',
    multiple: true,
    description: 'Playlist, channel or feed the collection follows (repeatable)',
  },
  kind: {
    name: 'kind',
    type: 'string',
    arg: '<kind>',
    description: 'llm | stt | embed | video | visual',
    choices: () => [...MODEL_KINDS],
  },
  profile: { name: 'profile', type: 'string', arg: '<name>', description: 'Config file profile to explain' },
  port: { name: 'port', type: 'string', arg: '<n>', description: 'Port (default: PORT or 8787)' },
  host: { name: 'host', type: 'string', arg: '<host>', description: 'Host (default: HOST or 127.0.0.1)' },
};

export const GLOBAL_FLAGS = [
  'format',
  'timestamps',
  'mode',
  'lang',
  'policy',
  'only',
  'skip',
  'allow-paid',
  'json',
  'quiet',
  'verbose',
  'out',
  'force',
  'help',
  'version',
];

const MEMORY_NOTE =
  'Without a persistent storage backend (SQLite, Postgres, D1) the library lives only for this process, so it starts empty on every run. `vid2context config` shows the backend in use.';

export const COMMANDS: CommandSpec[] = [
  {
    name: 'get',
    args: '<input>',
    summary: 'Transcript and metadata for one video (the default command)',
    flags: ['comments', 'refresh'],
    completesFiles: true,
    notes: ['<input> is a video URL, a YouTube id, a podcast episode or a local media file.'],
    examples: [
      'vid2context https://www.youtube.com/watch?v=jNQXAC9IVRw --timestamps',
      'vid2context get ./interview.mp3 --format json --out interview.json',
      'vid2context get jNQXAC9IVRw --format markdown --comments 20',
    ],
  },
  {
    name: 'list',
    args: '<input>',
    summary: 'Expand a playlist, channel, feed or page into video refs',
    flags: ['limit'],
    notes: ['Prints one video URL (or id) per line, or a JSON array of refs with --json.'],
    examples: ['vid2context list https://www.youtube.com/playlist?list=PL... --limit 20', 'vid2context list <feed-url> --json'],
  },
  {
    name: 'formats',
    args: '',
    summary: 'List the output formats',
    flags: [],
    examples: ['vid2context formats', 'vid2context formats --json'],
  },
  {
    name: 'pack',
    args: '<inputs...>',
    summary: 'One context pack (Markdown for an AI model) from one or many videos',
    flags: ['max-tokens', 'comments', 'refresh'],
    completesFiles: true,
    notes: ['Playlists, channels and feeds in <inputs> are expanded first.'],
    examples: ['vid2context pack jNQXAC9IVRw https://youtu.be/... --max-tokens 50000 > context.md'],
  },
  {
    name: 'bundle',
    args: '<inputs...>',
    summary: 'A .zip with every format, the context pack and a README for agents',
    flags: ['max-tokens', 'comments', 'refresh', 'name'],
    completesFiles: true,
    notes: ['--out is required. Playlists, channels and feeds in <inputs> are expanded first.'],
    examples: ['vid2context bundle jNQXAC9IVRw -o me-at-the-zoo.zip'],
  },
  {
    name: 'search',
    args: '<query>',
    summary: 'Keyword search over transcripts saved in the library',
    flags: ['collection', 'limit'],
    notes: [MEMORY_NOTE],
    examples: ['vid2context search "elephants" --limit 5'],
  },
  {
    name: 'library',
    args: '<ls|show|rm> [id]',
    summary: 'Saved video contexts',
    flags: ['limit'],
    subcommands: [
      { name: 'ls', args: '', summary: 'List saved videos, newest first' },
      { name: 'show', args: '<id>', summary: 'Print a saved video in --format' },
      { name: 'rm', args: '<id>', summary: 'Delete a saved video' },
    ],
    notes: [MEMORY_NOTE],
    examples: ['vid2context library ls', 'vid2context library show youtube:jNQXAC9IVRw --format markdown'],
  },
  {
    name: 'collection',
    args: '<create|add|ls|show|refresh|rm> ...',
    summary: 'Named groups of videos in the library',
    flags: ['description', 'source', 'refresh', 'limit'],
    subcommands: [
      { name: 'create', args: '<name>', summary: 'Create a collection (--description, --source)' },
      { name: 'add', args: '<id> <inputs...>', summary: 'Fetch, save and add videos (lists are expanded)' },
      { name: 'ls', args: '', summary: 'List collections' },
      { name: 'show', args: '<id>', summary: 'Show a collection and its videos' },
      { name: 'refresh', args: '<id>', summary: 'Ingest new videos from the collection sources (--limit n)' },
      { name: 'rm', args: '<id> [video-ids...]', summary: 'Remove videos from a collection, or delete it' },
    ],
    notes: [MEMORY_NOTE],
    examples: [
      'vid2context collection create "Talks" --description "Conference talks"',
      'vid2context collection add talks-1a2b3c4d jNQXAC9IVRw',
      'vid2context collection create "G-Wagon" --source "https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b"',
      'vid2context collection refresh g-wagon-1a2b3c4d --limit 5',
    ],
  },
  {
    name: 'models',
    args: '',
    summary: 'Every rung by tier, whether it is enabled, and the env vars it needs',
    flags: ['kind'],
    notes: ['Only env var names are printed, never values.'],
    examples: ['vid2context models', 'vid2context models --kind stt --json'],
  },
  {
    name: 'doctor',
    args: '',
    summary: 'Check Node, ffmpeg, yt-dlp, GPU, local servers, data directory, keys and network',
    flags: [],
    notes: [
      'Exits 1 when any check fails. Makes two small network requests (the keyless models list and a YouTube captions probe) and probes localhost for model servers.',
    ],
    examples: ['vid2context doctor', 'vid2context doctor --json'],
  },
  {
    name: 'config',
    args: '',
    summary: 'Resolved settings and where each came from, secrets masked',
    flags: ['profile'],
    examples: ['vid2context config', 'vid2context config --profile work --json'],
  },
  {
    name: 'serve',
    args: '',
    summary: 'Start the HTTP API',
    flags: ['port', 'host'],
    examples: ['vid2context serve --port 8787'],
  },
  {
    name: 'mcp',
    args: '',
    summary: 'Start the stdio MCP server',
    flags: [],
    examples: ['vid2context mcp'],
  },
  {
    name: 'completion',
    args: '<bash|zsh|fish>',
    summary: 'Print a shell completion script',
    flags: [],
    examples: ['vid2context completion bash > ~/.local/share/bash-completion/completions/vid2context'],
  },
  {
    name: 'help',
    args: '[command]',
    summary: 'Show help for a command',
    flags: [],
    examples: ['vid2context help get'],
  },
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name);
}

/** Flags a command accepts: the globals plus its own. */
export function flagsFor(command: CommandSpec): FlagSpec[] {
  return [...GLOBAL_FLAGS, ...command.flags].map((n) => FLAGS[n]).filter((f): f is FlagSpec => Boolean(f));
}
