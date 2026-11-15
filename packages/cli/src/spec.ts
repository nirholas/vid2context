/**
 * The command table. Parsing, `--help` and the shell completion scripts are
 * all generated from it, so they cannot drift apart. Formatter ids come from
 * the `formatters` map at runtime, never from a list written here.
 */
import { formatters, LINE_CHARS_RANGE, LINES_RANGE } from '@vid2context/core';
import {
  AUDIO_FORMATS,
  AUDIO_QUALITIES,
  CAPTION_FORMATS,
  CAPTION_VIA,
  FRAME_FORMATS,
  NOTICE,
  SPONSOR_CATEGORIES,
  THUMBNAIL_FORMATS,
  VIDEO_CONTAINERS,
  VIDEO_QUALITIES,
} from '@vid2context/downloads';

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
  playlist: {
    name: 'playlist',
    type: 'boolean',
    description: 'When a video link also names a playlist (watch?v=...&list=...), use the whole playlist',
  },
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

  video: {
    name: 'video',
    type: 'string',
    arg: '[mp4|webm|mkv]',
    description: 'Save the video (default when neither --video nor --audio is given; format default mp4)',
    choices: () => [...VIDEO_CONTAINERS],
  },
  audio: {
    name: 'audio',
    type: 'string',
    arg: '[mp3|m4a|opus|flac|wav]',
    description: 'Save only the audio (format default mp3)',
    choices: () => [...AUDIO_FORMATS],
  },
  quality: {
    name: 'quality',
    type: 'string',
    arg: '<q>',
    description: 'Video: best, 2160 ... 144 (default 1080). mp3: best, 320 ... 64 kbps (default best)',
    choices: () => [...new Set([...VIDEO_QUALITIES, ...AUDIO_QUALITIES])],
  },
  from: { name: 'from', type: 'string', arg: '<time>', description: 'Keep from this time: seconds, m:ss or h:mm:ss' },
  to: { name: 'to', type: 'string', arg: '<time>', description: 'Keep up to this time' },
  chapter: { name: 'chapter', type: 'string', arg: '<n|title>', description: 'Keep one chapter: 0-based index or title' },
  'exact-cuts': {
    name: 'exact-cuts',
    type: 'boolean',
    description: 'Re-encode at the cuts so a trimmed video starts exactly at --from',
  },
  subs: { name: 'subs', type: 'string', arg: '<langs>', description: 'Embed subtitles in the video, e.g. en or en,de' },
  sponsorblock: {
    name: 'sponsorblock',
    type: 'string',
    arg: '[cats]',
    description: `Cut SponsorBlock segments from YouTube videos (default sponsor,selfpromo,interaction; all: ${SPONSOR_CATEGORIES.join(',')})`,
  },
  'no-thumbnail': { name: 'no-thumbnail', type: 'boolean', description: 'Do not embed the cover art' },
  'no-metadata': { name: 'no-metadata', type: 'boolean', description: 'Do not write title, channel and date tags' },
  'no-chapters': { name: 'no-chapters', type: 'boolean', description: 'Do not write chapter markers' },
  dir: {
    name: 'dir',
    type: 'string',
    short: 'd',
    arg: '<folder>',
    description: 'Save files here (default: VID2CONTEXT_DOWNLOAD_DIR or the current directory)',
  },
  info: { name: 'info', type: 'boolean', description: 'Show qualities, formats and estimated sizes; download nothing' },
  'burn-subs': {
    name: 'burn-subs',
    type: 'string',
    arg: '<lang>',
    description: 'Burn one language of subtitles into the picture (video only; re-encodes)',
  },
  'split-chapters': {
    name: 'split-chapters',
    type: 'boolean',
    description: 'Also save one file per chapter, next to the full file',
  },
  thumbnail: {
    name: 'thumbnail',
    type: 'string',
    arg: '[jpg|png|webp]',
    description: 'Save only the thumbnail image (format default jpg)',
    choices: () => [...THUMBNAIL_FORMATS],
  },
  frames: {
    name: 'frames',
    type: 'string',
    arg: '<times>',
    description: 'Save still frames at these times instead of the video, e.g. 0:10,1:30 (several come as a .zip)',
  },
  'frame-format': {
    name: 'frame-format',
    type: 'string',
    arg: '<png|jpg>',
    description: 'Image format for --frames (default png)',
    choices: () => [...FRAME_FORMATS],
  },
  gif: {
    name: 'gif',
    type: 'boolean',
    description: 'Save --from to --to as an animated GIF (short ranges; see VID2CONTEXT_MAX_CLIP_SEC)',
  },
  webp: { name: 'webp', type: 'boolean', description: 'Save --from to --to as an animated WebP' },
  fps: { name: 'fps', type: 'string', arg: '<n>', description: 'Frames per second for --gif and --webp (default 10)' },
  width: {
    name: 'width',
    type: 'string',
    arg: '<px>',
    description: 'Width for --gif, --webp (default 480) and --frames (default: source)',
  },
  zip: { name: 'zip', type: 'boolean', description: 'Pack every saved file into one .zip' },
  list: { name: 'list', type: 'boolean', description: 'List the caption tracks and translation languages; download nothing' },
  via: {
    name: 'via',
    type: 'string',
    arg: '<path>',
    description: 'auto | pipeline | ytdlp: where captions come from (default auto: the transcript pipeline, then yt-dlp)',
    choices: () => [...CAPTION_VIA],
  },
  'no-auto': { name: 'no-auto', type: 'boolean', description: "Never use the platform's automatic captions" },
  'no-translate': { name: 'no-translate', type: 'boolean', description: "Never use the platform's machine translation" },
  offset: {
    name: 'offset',
    type: 'string',
    arg: '<sec>',
    description: 'Shift every caption by this many seconds (negative: earlier), e.g. 2.5 or -1',
  },
  'max-line-chars': {
    name: 'max-line-chars',
    type: 'string',
    arg: '<n>',
    description: `Longest caption line, ${LINE_CHARS_RANGE.min} to ${LINE_CHARS_RANGE.max} characters (default 42)`,
  },
  'max-lines': {
    name: 'max-lines',
    type: 'string',
    arg: '<n>',
    description: `Most lines per caption, ${LINES_RANGE.min} to ${LINES_RANGE.max} (default 2)`,
  },
  secondary: {
    name: 'secondary',
    type: 'string',
    arg: '<lang>',
    description: 'Show a second language under each caption (bilingual srt, vtt, ass, ...)',
  },
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

const DOWNLOAD_NOTES = [
  'Video: mp4 (default; H.264 + stereo AAC up to 1080p, plays everywhere), webm (VP9 + Opus) or mkv (best streams in any codec).',
  'Audio: mp3 (default; best VBR, about 245 kbps), m4a and opus (the original stream, no re-encode), flac or wav.',
  `--quality: video ${VIDEO_QUALITIES.join(', ')} (default 1080); mp3 kbps ${AUDIO_QUALITIES.join(', ')}.`,
  `Formats: ${VIDEO_CONTAINERS.join(', ')} | ${AUDIO_FORMATS.join(', ')}. Cover art, tags and chapters are embedded by default; trimmed files get no chapters.`,
  'Playlists and channels download every video, up to --limit (default VID2CONTEXT_MAX_PLAYLIST_ITEMS). --playlist does the same for a video link that names a playlist (watch?v=...&list=...).',
  'Files go to --dir, else VID2CONTEXT_DOWNLOAD_DIR, else the current directory. Existing files are kept (--force replaces them).',
  'stdout gets one saved path per line (JSON with --json); progress and notes go to stderr.',
  NOTICE,
];

const CAPTIONS_NOTES = [
  `-f picks the format: ${CAPTION_FORMATS.join(', ')} (default srt). txt takes --timestamps.`,
  '--offset retimes every caption; --max-line-chars and --max-lines reflow the cue formats; --secondary <lang> adds a second language under each caption, fetched like the first.',
  '--lang takes one or several codes (en,de) or all; without it you get the spoken language. Several files come as one .zip (--zip forces one).',
  'Text comes from the transcript pipeline first (any source, no yt-dlp needed), then from yt-dlp. -f original keeps the file the site serves (or the local sidecar or embedded stream).',
  '--mode auto (default) transcribes the audio with speech-to-text when a video has no captions; --mode captions never does; --mode stt always does.',
  'Several inputs, playlists and channels run as a batch: failed items are listed on stderr and the rest are saved.',
  'Files go to --dir, else VID2CONTEXT_DOWNLOAD_DIR, else the current directory. stdout gets the saved paths (JSON with --json).',
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
    notes: [
      '<input> is a video URL, a YouTube id, a podcast episode or a local media file.',
      'A video link that also names a playlist (watch?v=...&list=...) gets the one video; a note says how to use the playlist (list, pack, bundle or download with --playlist).',
    ],
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
    flags: ['limit', 'playlist'],
    notes: [
      'Prints one video URL (or id) per line, or a JSON array of refs with --json.',
      'A video link that names a playlist lists just that video; add --playlist to list the playlist.',
    ],
    examples: [
      'vid2context list https://www.youtube.com/playlist?list=PL... --limit 20',
      'vid2context list "https://www.youtube.com/watch?v=...&list=PL..." --playlist',
      'vid2context list <feed-url> --json',
    ],
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
    flags: ['max-tokens', 'comments', 'refresh', 'playlist'],
    completesFiles: true,
    notes: [
      'Playlists, channels and feeds in <inputs> are expanded first.',
      '--playlist also expands video links that name a playlist (watch?v=...&list=...).',
    ],
    examples: [
      'vid2context pack jNQXAC9IVRw https://youtu.be/... --max-tokens 50000 > context.md',
      'vid2context pack "https://www.youtube.com/watch?v=...&list=PL..." --playlist > playlist.md',
    ],
  },
  {
    name: 'bundle',
    args: '<inputs...>',
    summary: 'A .zip with every format, the context pack and a README for agents',
    flags: ['max-tokens', 'comments', 'refresh', 'name', 'playlist'],
    completesFiles: true,
    notes: [
      '--out is required. Playlists, channels and feeds in <inputs> are expanded first.',
      '--playlist also expands video links that name a playlist (watch?v=...&list=...).',
    ],
    examples: ['vid2context bundle jNQXAC9IVRw -o me-at-the-zoo.zip'],
  },
  {
    name: 'download',
    args: '<inputs...>',
    summary: 'Save videos as mp4, webm or mkv, or their audio as mp3, m4a, opus, flac or wav',
    flags: [
      'video',
      'audio',
      'quality',
      'from',
      'to',
      'chapter',
      'exact-cuts',
      'subs',
      'sponsorblock',
      'no-thumbnail',
      'no-metadata',
      'no-chapters',
      'dir',
      'info',
      'limit',
      'playlist',
      'burn-subs',
      'split-chapters',
      'thumbnail',
      'frames',
      'frame-format',
      'gif',
      'webp',
      'fps',
      'width',
      'zip',
    ],
    completesFiles: true,
    notes: DOWNLOAD_NOTES,
    examples: [
      'vid2context download https://www.youtube.com/watch?v=aqz-KE-bpKQ',
      'vid2context download aqz-KE-bpKQ --video webm --quality 720 -d ~/Videos',
      'vid2context download aqz-KE-bpKQ --audio mp3 --quality 320',
      'vid2context download aqz-KE-bpKQ --audio m4a --from 1:00 --to 2:30',
      'vid2context download <talk-url> --chapter "Q&A" --audio',
      'vid2context download <playlist-url> --audio --limit 20 --sponsorblock',
      'vid2context download aqz-KE-bpKQ --info',
      'vid2context download ./lecture.mkv --audio opus',
      'vid2context download aqz-KE-bpKQ --frames 0:30,1:00,2:00 --frame-format jpg',
      'vid2context download aqz-KE-bpKQ --gif --from 1:00 --to 1:04 --width 320',
      'vid2context download aqz-KE-bpKQ --burn-subs en --quality 720',
      'vid2context download aqz-KE-bpKQ --thumbnail png',
      'vid2context download <url1> <url2> --audio --zip',
    ],
  },
  {
    name: 'captions',
    args: '<inputs...>',
    summary: 'Save captions or subtitles only: srt, vtt, txt, json, markdown or the original file',
    flags: [
      'list',
      'via',
      'no-auto',
      'no-translate',
      'offset',
      'max-line-chars',
      'max-lines',
      'secondary',
      'zip',
      'dir',
      'limit',
      'playlist',
    ],
    completesFiles: true,
    notes: CAPTIONS_NOTES,
    examples: [
      'vid2context captions jNQXAC9IVRw                       # srt in the spoken language',
      'vid2context captions jNQXAC9IVRw --list                # tracks and translation languages',
      'vid2context captions jNQXAC9IVRw --lang en,de -f vtt   # two files, as one .zip',
      'vid2context captions jNQXAC9IVRw --lang all -f original',
      'vid2context captions ./lecture.mkv -f txt --timestamps',
      'vid2context captions jNQXAC9IVRw --lang en --secondary de -f ass --offset -0.5',
      'vid2context captions <podcast-or-video-without-captions> --mode auto  # speech-to-text',
      'vid2context captions <playlist-url> --limit 20 --zip',
    ],
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
