/**
 * Every runnable example on the docs site. A page shows one with a fenced
 * block whose info string is `run <id>`; the build renders the form, the
 * snippets and the response recorded in site/test/fixtures/runnables/<id>.json
 * (scripts/record-runnables.ts writes those from a real server).
 *
 * The videos are real and public: "Me at the zoo" (0:19, three chapters), a
 * G-Wagon buyer video (18 min, nine chapters) and its playlist, and
 * Kurzgesagt's "Optimistic Nihilism" (7:26, no chapters, SponsorBlock
 * segments), and an 11-minute video from the playlist with six chapters. Responses that would carry an email address (the G-Wagon
 * description has one) are refused by the recorder, so no example shows that
 * video's metadata.
 */
import { formatters } from '@vid2context/core';
import type { Field, RunnableSpec } from '../lib/runnable.ts';

export const ZOO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
export const GWAGON = 'https://www.youtube.com/watch?v=cCPsdFdlshc';
export const GWAGON_PLAYLIST = 'https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b';
export const NIHILISM = 'https://www.youtube.com/watch?v=MBRqu0YOH14';
/** From the G-Wagon playlist: 11:37 with six creator chapters, to compare generated chapters against. */
export const SELLING = 'https://www.youtube.com/watch?v=PzJL3aBRas8';
/** A well-formed YouTube id that does not exist, for the error example. */
export const MISSING = 'https://www.youtube.com/watch?v=xxxxxxxxxxx';

/** The public-domain Apollo 11 clip from tests/fixtures/media, served by the site at this path. */
export const APOLLO_SAMPLE = {
  href: '/samples/apollo11-small-step.mp3',
  name: 'apollo11-small-step.mp3',
  label: 'Use the Apollo 11 sample (0:24, public domain)',
  repoPath: 'tests/fixtures/media/apollo11-small-step.mp3',
};

/** Single-video formats from the core formatter map, never a typed-in list. */
const FORMATS = Object.keys(formatters).filter((id) => id !== 'pack');
const MODES = ['auto', 'captions', 'stt', 'video'];

// ------------------------------------------------------------------ field builders

const url = (def: string, over: Partial<Field> = {}): Field => ({
  name: 'url',
  label: 'Video URL',
  type: 'url',
  in: 'query',
  default: def,
  cli: { positional: true },
  mcp: { arg: 'url' },
  ...over,
});

const format = (def = 'text'): Field => ({
  name: 'format',
  label: 'Format',
  type: 'select',
  in: 'query',
  default: def,
  options: FORMATS,
  cli: { flag: '--format' },
  mcp: { arg: 'format' },
});

const timestamps = (on = false): Field => ({
  name: 'timestamps',
  label: 'Timestamps',
  type: 'checkbox',
  in: 'query',
  default: on ? 'true' : '',
  cli: { flag: '--timestamps' },
  mcp: { arg: 'timestamps' },
});

const lang = (def = ''): Field => ({
  name: 'lang',
  label: 'Language',
  type: 'text',
  in: 'query',
  default: def,
  optional: true,
  help: 'BCP-47, for example en, de or pt-BR',
  cli: { flag: '--lang' },
  mcp: { arg: 'language' },
});

const mode = (def = 'auto'): Field => ({
  name: 'mode',
  label: 'Mode',
  type: 'select',
  in: 'query',
  default: def,
  options: MODES,
  serverDefault: 'auto',
  help: 'auto (the default): captions first, then speech-to-text',
  cli: { flag: '--mode' },
  mcp: { arg: 'mode' },
});

const inputs = (urls: string[], over: Partial<Field> = {}): Field => ({
  name: 'inputs',
  label: 'Videos (one per line)',
  type: 'list',
  in: 'body',
  default: urls.join('\n'),
  cli: { positional: true },
  mcp: { arg: 'urls' },
  ...over,
});

const question = (def: string): Field => ({
  name: 'question',
  label: 'Question',
  type: 'text',
  in: 'body',
  default: def,
  mcp: { arg: 'question' },
});

/** The collection created by "collection-create", as it was when the examples were recorded. */
export const COLLECTION_ID = 'g-wagon-research-2c2983f1';

const collectionId = (over: Partial<Field> = {}): Field => ({
  name: 'id',
  label: 'Collection id',
  type: 'text',
  in: 'path',
  default: COLLECTION_ID,
  from: 'collection',
  cli: { positional: true },
  mcp: { arg: 'collection' },
  ...over,
});

/** The creator captions of "Me at the zoo" as SRT, exactly as GET /transcript?format=srt returns them. */
const ZOO_SRT = [
  '1',
  '00:00:01,200 --> 00:00:03,360',
  'All right, so here we are,',
  'in front of the elephants',
  '',
  '2',
  '00:00:05,318 --> 00:00:07,974',
  'the cool thing about these guys',
  'is that they have really...',
  '',
  '3',
  '00:00:07,974 --> 00:00:12,616',
  'really really long trunks',
  '',
  '4',
  '00:00:12,616 --> 00:00:14,367',
  "and that's cool",
  '',
  '5',
  '00:00:14,421 --> 00:00:15,733',
  '(baaaaaaaaaaahhh!!)',
  '',
  '6',
  '00:00:16,881 --> 00:00:18,881',
  "and that's pretty much all there is to say",
].join('\n');

const transcript = (id: string, title: string, fields: Field[], note?: string): RunnableSpec => ({
  id,
  title,
  method: 'GET',
  path: '/api/v1/transcript',
  fields,
  response: 'text',
  cli: { command: ['get'] },
  mcp: { tool: 'get_transcript' },
  ...(note ? { note } : {}),
});

// ------------------------------------------------------------------ the catalog

export const runnables: RunnableSpec[] = [
  // Server
  {
    id: 'health',
    title: 'Check the server',
    method: 'GET',
    path: '/api/v1/health',
    fields: [],
    response: 'json',
    note: 'Version, runtime, formats, and every provider and rung with whether it is enabled.',
  },
  {
    id: 'formats',
    title: 'List the output formats',
    method: 'GET',
    path: '/api/v1/formats',
    fields: [],
    response: 'json',
    cli: { command: ['formats'] },
    mcp: { tool: 'list_formats' },
  },
  {
    id: 'models',
    title: 'List the models',
    method: 'GET',
    path: '/api/v1/models',
    fields: [
      {
        name: 'kind',
        label: 'Kind',
        type: 'select',
        in: 'query',
        default: 'stt',
        options: ['', 'llm', 'stt', 'embed', 'video', 'visual'],
        optional: true,
        cli: { flag: '--kind' },
        mcp: { arg: 'kind' },
      },
    ],
    response: 'json',
    cli: { command: ['models'], extra: ['--json'] },
    mcp: { tool: 'list_models' },
    note: 'Every rung, enabled or not. requires names env vars, never their values.',
  },
  {
    id: 'healthz',
    title: 'Readiness for a container probe',
    method: 'GET',
    path: '/api/v1/healthz',
    fields: [{ name: 'deep', label: 'Deep check', type: 'checkbox', in: 'query', default: 'true' }],
    response: 'json',
    note: 'Without deep it only says the process is up. With deep=1 it checks storage, rungs, disk, yt-dlp, ffmpeg and the network, and answers 503 when a required check fails.',
  },

  // Transcripts
  transcript('transcript', 'Get a transcript', [url(ZOO), format('text'), timestamps(false), lang(), mode()]),
  transcript('transcript-timestamps', 'Transcript with timestamps', [url(ZOO), format('text'), timestamps(true), lang(), mode()]),
  transcript('transcript-srt', 'Captions as SRT', [url(ZOO), format('srt'), lang(), mode()]),
  transcript('transcript-vtt', 'Captions as WebVTT', [url(ZOO), format('vtt'), lang(), mode()]),
  transcript('transcript-markdown', 'Markdown with chapter headings', [url(ZOO), format('markdown'), lang(), mode()]),
  transcript('transcript-json', 'The whole VideoContext as JSON', [url(ZOO), format('json'), lang(), mode()]),
  transcript(
    'transcript-captions-only',
    'Captions only, never audio',
    [url(ZOO), format('text'), timestamps(true), mode('captions')],
    'mode=captions fails fast with no-transcript instead of downloading audio for speech-to-text.',
  ),
  transcript(
    'transcript-translate',
    'Translate a transcript',
    [
      url(ZOO),
      format('text'),
      timestamps(true),
      lang('de'),
      { name: 'translate', label: 'Translate', type: 'checkbox', in: 'query', default: 'true' },
    ],
    'X-Translated-Via says which step answered: source, platform or llm. The stored transcript stays in its own language.',
  ),
  transcript(
    'transcript-skip',
    'Remove sponsor and self-promotion segments',
    [
      url(NIHILISM),
      format('text'),
      timestamps(true),
      { name: 'skip', label: 'Skip categories', type: 'text', in: 'query', default: 'selfpromo,outro', optional: true },
    ],
    'SponsorBlock segments are cut from a copy; X-Data-Attribution credits the data.',
  ),
  transcript('transcript-error', 'What an error looks like', [url(MISSING), format('text')], 'A video that does not exist.'),
  {
    id: 'context',
    title: 'The full context',
    method: 'GET',
    path: '/api/v1/context',
    fields: [url(ZOO, { cli: undefined, mcp: undefined }), lang(), mode()],
    response: 'json',
    note: 'Metadata, timed segments, how the transcript was made, and every attempt.',
  },

  // Structure
  {
    id: 'metadata',
    title: 'Metadata only',
    method: 'GET',
    path: '/api/v1/metadata',
    fields: [url(ZOO)],
    response: 'json',
    mcp: { tool: 'get_metadata' },
    note: 'Title, channel, duration and chapters, without fetching captions or audio.',
  },
  {
    id: 'outline',
    title: 'Outline with token counts',
    method: 'GET',
    path: '/api/v1/outline',
    fields: [url(ZOO, { cli: undefined }), lang(), mode()],
    response: 'json',
    mcp: { tool: 'get_outline' },
  },
  {
    id: 'outline-sections',
    title: 'Outline of a video without chapters',
    method: 'GET',
    path: '/api/v1/outline',
    fields: [url(NIHILISM, { cli: undefined }), lang(), mode()],
    response: 'json',
    mcp: { tool: 'get_outline' },
    note: 'No chapters, so the outline is sections of about five minutes, cut where the speech pauses.',
  },
  {
    id: 'section-chapter',
    title: 'One chapter',
    method: 'GET',
    path: '/api/v1/section',
    fields: [
      url(ZOO, { cli: undefined }),
      {
        name: 'chapter',
        label: 'Chapter',
        type: 'text',
        in: 'query',
        default: 'The cool thing',
        optional: true,
        help: 'An outline index (0, 1, ...) or a title: exact, then prefix, then substring',
        mcp: { arg: 'chapter' },
      },
      format('text'),
      timestamps(true),
    ],
    response: 'text',
    mcp: { tool: 'get_section' },
  },
  {
    id: 'section-time',
    title: 'A time range',
    method: 'GET',
    path: '/api/v1/section',
    fields: [
      url(GWAGON, { cli: undefined }),
      { name: 'from', label: 'From', type: 'text', in: 'query', default: '5:00', optional: true, mcp: { arg: 'from' } },
      { name: 'to', label: 'To', type: 'text', in: 'query', default: '6:00', optional: true, mcp: { arg: 'to' } },
      format('text'),
      timestamps(true),
    ],
    response: 'text',
    mcp: { tool: 'get_section' },
    note: 'from and to take seconds, m:ss or h:mm:ss. to is exclusive.',
  },
  {
    id: 'comments',
    title: 'Top comments',
    method: 'GET',
    path: '/api/v1/comments',
    fields: [
      url(ZOO, { cli: undefined }),
      // One by default: the top comment is the San Diego Zoo's; the next ones are private people's handles.
      { name: 'limit', label: 'Limit', type: 'number', in: 'query', default: '1', optional: true, mcp: { arg: 'limit' } },
    ],
    response: 'json',
    mcp: { tool: 'get_comments' },
  },
  {
    id: 'caption-languages',
    title: 'Caption languages',
    method: 'GET',
    path: '/api/v1/caption-languages',
    fields: [url(ZOO, { cli: undefined })],
    response: 'json',
    mcp: { tool: 'list_caption_languages' },
    note: 'Caption tracks (creator or auto) and the languages YouTube can translate into.',
  },
  {
    id: 'skips',
    title: 'SponsorBlock segments',
    method: 'GET',
    path: '/api/v1/skips',
    fields: [
      url(NIHILISM, { cli: undefined }),
      {
        name: 'categories',
        label: 'Categories',
        type: 'text',
        in: 'query',
        default: '',
        optional: true,
        help: 'Comma-separated, for example sponsor,selfpromo. Empty for the defaults',
        mcp: { arg: 'categories' },
      },
    ],
    response: 'json',
    mcp: { tool: 'get_skip_segments' },
  },
  {
    id: 'chapters-auto',
    title: 'Generate chapters',
    method: 'POST',
    path: '/api/v1/chapters',
    fields: [
      url(SELLING, { in: 'body', cli: undefined, mcp: undefined }),
      {
        name: 'force',
        label: 'Force',
        type: 'checkbox',
        in: 'body',
        default: 'true',
        help: 'Propose chapters even when the video has its own',
      },
      { name: 'summaries', label: 'Summaries', type: 'checkbox', in: 'body', default: '' },
    ],
    response: 'json',
    note: 'An LLM on the free chain proposes chapters from the transcript. This video has six of its own; force asks for new ones to compare.',
  },
  {
    id: 'key-moments',
    title: 'Key moments',
    method: 'GET',
    path: '/api/v1/key-moments',
    fields: [
      url(GWAGON, { cli: undefined }),
      { name: 'count', label: 'Count', type: 'number', in: 'query', default: '5', optional: true, mcp: { arg: 'count' } },
    ],
    response: 'json',
    mcp: { tool: 'get_key_moments' },
    note: 'Chosen by the LLM chain; every timestamp is checked against real segments.',
  },

  // Many videos
  {
    id: 'items',
    title: 'Expand a playlist',
    method: 'GET',
    path: '/api/v1/items',
    fields: [
      url(GWAGON_PLAYLIST, { label: 'Playlist, channel or feed URL' }),
      {
        name: 'limit',
        label: 'Limit',
        type: 'number',
        in: 'query',
        default: '5',
        optional: true,
        cli: { flag: '--limit' },
        mcp: { arg: 'limit' },
      },
    ],
    response: 'json',
    cli: { command: ['list'], extra: ['--json'] },
    mcp: { tool: 'list_items' },
  },
  {
    id: 'pack',
    title: 'A context pack for one video',
    method: 'GET',
    path: '/api/v1/pack',
    fields: [
      url(GWAGON, { mcp: undefined }),
      {
        name: 'maxTokens',
        label: 'Max tokens',
        type: 'number',
        in: 'query',
        default: '1500',
        optional: true,
        cli: { flag: '--max-tokens' },
      },
    ],
    response: 'text',
    cli: { command: ['pack'] },
    note: 'One Markdown file sized for a token budget, with citation instructions for the model.',
  },
  {
    id: 'pack-many',
    title: 'One pack for several videos',
    method: 'POST',
    path: '/api/v1/pack',
    fields: [
      inputs([ZOO, GWAGON]),
      {
        name: 'maxTokens',
        label: 'Max tokens',
        type: 'number',
        in: 'body',
        default: '3000',
        optional: true,
        cli: { flag: '--max-tokens' },
        mcp: { arg: 'maxTokens' },
      },
    ],
    response: 'text',
    cli: { command: ['pack'] },
    mcp: { tool: 'export_context_pack' },
    note: 'Playlists in inputs are expanded. A video that fails is listed under "Not included"; the rest still go in.',
  },
  {
    id: 'bundle',
    title: 'Every format in a zip',
    method: 'GET',
    path: '/api/v1/bundle',
    fields: [
      url(ZOO),
      {
        name: 'formats',
        label: 'Formats',
        type: 'text',
        in: 'query',
        default: '',
        optional: true,
        help: `Comma-separated, empty for all: ${FORMATS.join(', ')}`,
      },
    ],
    response: 'zip',
    cli: { command: ['bundle'], extra: ['-o', 'bundle.zip'] },
    note: 'context.md is always in the zip, next to one file per format, the metadata and a README for agents.',
  },
  {
    id: 'research',
    title: 'Find a topic across videos',
    method: 'POST',
    path: '/api/v1/research',
    fields: [
      inputs([GWAGON], { name: 'urls', cli: undefined }),
      { name: 'query', label: 'Query', type: 'text', in: 'body', default: 'reliability', mcp: { arg: 'query' } },
      {
        name: 'maxExcerpts',
        label: 'Max excerpts',
        type: 'number',
        in: 'body',
        default: '3',
        optional: true,
        mcp: { arg: 'maxExcerpts' },
      },
    ],
    response: 'json',
    mcp: { tool: 'research_videos' },
    note: 'Ranked excerpts with context and timestamp links. Needs no saved library.',
  },
  {
    id: 'search',
    title: 'Search saved transcripts',
    method: 'GET',
    path: '/api/v1/search',
    fields: [
      {
        name: 'q',
        label: 'Query',
        type: 'text',
        in: 'query',
        default: 'elephants',
        cli: { positional: true },
        mcp: { arg: 'query' },
      },
      {
        name: 'limit',
        label: 'Limit',
        type: 'number',
        in: 'query',
        default: '5',
        optional: true,
        cli: { flag: '--limit' },
        mcp: { arg: 'limit' },
      },
    ],
    response: 'json',
    cli: { command: ['search'] },
    mcp: { tool: 'search_transcript' },
    note: 'Searches the library: every video a request above has read is saved there.',
  },

  // Library and collections
  {
    id: 'collection-create',
    title: 'Create a collection',
    method: 'POST',
    path: '/api/v1/collections',
    fields: [
      {
        name: 'name',
        label: 'Name',
        type: 'text',
        in: 'body',
        default: 'G-Wagon research',
        cli: { positional: true },
        mcp: { arg: 'name' },
      },
      {
        name: 'description',
        label: 'Description',
        type: 'text',
        in: 'body',
        default: 'Buyer videos to compare model years',
        optional: true,
        cli: { flag: '--description' },
        mcp: { arg: 'description' },
      },
      {
        name: 'sources',
        label: 'Sources to follow (one per line)',
        type: 'list',
        in: 'body',
        default: '',
        optional: true,
        help: 'Playlists, channels or feeds. A refresh adds their new videos.',
        cli: { flag: '--source' },
        mcp: { arg: 'sources' },
      },
    ],
    response: 'json',
    cli: { command: ['collection', 'create'] },
    mcp: { tool: 'create_collection' },
    provides: { name: 'collection', path: 'id' },
    note: 'The id is the name as a slug plus a random suffix. The blocks below use it once you run this one.',
  },
  {
    id: 'collection-add',
    title: 'Add videos to the collection',
    method: 'POST',
    path: '/api/v1/collections/{id}/items',
    fields: [
      collectionId(),
      inputs([GWAGON, SELLING], { label: 'Videos or playlists (one per line)', cli: { positional: true }, mcp: { arg: 'urls' } }),
    ],
    response: 'json',
    job: true,
    cli: { command: ['collection', 'add'] },
    mcp: { tool: 'add_to_collection' },
    note: 'Each video is read once and saved in the library. With a jobs queue this answers 202 and a Job; the runner polls it.',
  },
  {
    id: 'collection-get',
    title: 'Read the collection',
    method: 'GET',
    path: '/api/v1/collections/{id}',
    fields: [collectionId()],
    response: 'json',
    cli: { command: ['collection', 'show'] },
    mcp: { tool: 'get_collection' },
    note: 'Its videos (title, channel, duration, how the transcript was made), videos still pending, and the refresh schedule.',
  },
  {
    id: 'collection-pack',
    title: 'One context pack for the collection',
    method: 'POST',
    path: '/api/v1/pack',
    fields: [
      collectionId({ name: 'collectionId', in: 'body', cli: undefined, mcp: { arg: 'collectionId' } }),
      {
        name: 'maxTokens',
        label: 'Max tokens',
        type: 'number',
        in: 'body',
        default: '2500',
        optional: true,
        mcp: { arg: 'maxTokens' },
      },
    ],
    response: 'text',
    mcp: { tool: 'export_context_pack' },
    note: 'The same pack as for a list of inputs, built from every video in the collection.',
  },
  {
    id: 'obsidian-export',
    title: 'Export notes for Obsidian',
    method: 'POST',
    path: '/api/v1/exports/obsidian',
    fields: [
      inputs([SELLING], { optional: true, cli: undefined, mcp: undefined }),
      collectionId({
        name: 'collectionId',
        in: 'body',
        default: '',
        optional: true,
        from: undefined,
        help: 'Optional: a collection id from "Create a collection", to export every video in it too.',
        cli: undefined,
        mcp: undefined,
      }),
      {
        name: 'folder',
        label: 'Folder',
        type: 'text',
        in: 'body',
        default: '',
        optional: true,
        help: 'Default: the collection name, or vid2context',
      },
    ],
    response: 'json',
    note: 'One Markdown note per video with frontmatter, chapters and timestamp links, and an index note. The server writes nothing: you get the files.',
  },
  {
    id: 'collection-export',
    title: 'Export the collection definition',
    method: 'GET',
    path: '/api/v1/collections/{id}/export',
    fields: [collectionId()],
    response: 'json',
    note: 'Name, sources, video ids and schedule: everything another server needs to rebuild the collection with POST /collections/import.',
  },
  {
    id: 'library',
    title: 'List the library',
    method: 'GET',
    path: '/api/v1/library',
    fields: [
      { name: 'limit', label: 'Limit', type: 'number', in: 'query', default: '5', optional: true, cli: { flag: '--limit' } },
    ],
    response: 'json',
    cli: { command: ['library', 'ls'] },
    note: 'Every saved video, newest first. A page with more after it has a cursor to pass back.',
  },
  {
    id: 'library-item',
    title: 'One saved video',
    method: 'GET',
    path: '/api/v1/library/{id}',
    fields: [
      {
        name: 'id',
        label: 'Video id',
        type: 'text',
        in: 'path',
        default: 'youtube:MBRqu0YOH14',
        help: 'platform:id, as the library list shows it',
        cli: { positional: true },
      },
    ],
    response: 'json',
    cli: { command: ['library', 'show'], extra: ['--format', 'json'] },
    note: 'The saved VideoContext, read from storage without contacting the platform.',
  },

  // Answers and briefs
  {
    id: 'ask',
    title: 'Ask a question',
    method: 'POST',
    path: '/api/v1/ask',
    fields: [question('What does he say about the elephants?'), inputs([ZOO], { cli: undefined })],
    response: 'json',
    mcp: { tool: 'ask' },
    note: 'A cited answer from the free LLM chain. Every citation is checked against the transcript.',
  },
  {
    id: 'ask-stream',
    title: 'Stream the answer',
    method: 'POST',
    path: '/api/v1/ask',
    fields: [question('What does he say about the elephants?'), inputs([ZOO], { cli: undefined, mcp: undefined })],
    fixedBody: { stream: true },
    response: 'sse',
    note: 'Server-sent events: meta (rung, sources), delta (answer text), then done with the citations.',
  },
  {
    id: 'brief',
    title: 'A cited brief',
    method: 'POST',
    path: '/api/v1/briefs',
    fields: [
      inputs([GWAGON], { cli: undefined }),
      question('Which G-Wagon years are the most reliable, and which should be avoided?'),
      {
        name: 'template',
        label: 'Template',
        type: 'select',
        in: 'body',
        default: 'brief',
        options: ['brief', 'summary', 'buyer-guide', 'comparison', 'tutorial-steps'],
        optional: true,
        mcp: { arg: 'template' },
      },
    ],
    response: 'json',
    job: true,
    mcp: { tool: 'build_brief', fixed: { format: 'json' } },
    note: 'With a jobs queue the server answers 202 and a Job; the runner polls it until it finishes.',
  },
  {
    id: 'extract-template',
    title: 'Structured data from a template',
    method: 'POST',
    path: '/api/v1/extract',
    fields: [
      inputs([GWAGON], { cli: undefined }),
      {
        name: 'template',
        label: 'Template',
        type: 'select',
        in: 'body',
        default: 'buyer-guide',
        options: ['buyer-guide', 'summary', 'brief', 'comparison', 'tutorial-steps'],
        mcp: { arg: 'template' },
      },
    ],
    response: 'json',
    job: true,
    mcp: { tool: 'extract' },
    note: 'JSON that matches the template, with citations verified against the transcript.',
  },
  {
    id: 'extract-schema',
    title: 'Structured data from your own schema',
    method: 'POST',
    path: '/api/v1/extract',
    fields: [
      inputs([GWAGON], { cli: undefined }),
      {
        name: 'schema',
        label: 'JSON Schema',
        type: 'json',
        in: 'body',
        default: JSON.stringify(
          {
            type: 'object',
            properties: {
              bestYears: { type: 'array', items: { type: 'string' }, description: 'Model years the video recommends' },
              worstYears: { type: 'array', items: { type: 'string' }, description: 'Model years the video warns against' },
            },
            required: ['bestYears', 'worstYears'],
          },
          null,
          2,
        ),
        mcp: { arg: 'schema' },
      },
    ],
    response: 'json',
    job: true,
    mcp: { tool: 'extract' },
  },

  // Your own files
  {
    id: 'upload',
    title: 'Upload an audio file',
    method: 'POST',
    path: '/api/v1/uploads',
    fields: [{ name: 'file', label: 'Audio or video file', type: 'file', in: 'form' }],
    response: 'json',
    sample: APOLLO_SAMPLE,
    provides: { name: 'upload', path: 'input' },
    note: 'Returns an input, upload:<sha256>, that every route taking url accepts for the next hour.',
  },
  transcript(
    'upload-transcript',
    'Transcribe the upload',
    [
      url('upload:9dd76462aaf0e20bd4984c7cb49f092d667ea7bbcb065d46814d570460ec89d7', {
        label: 'Input',
        type: 'text',
        from: 'upload',
        cli: undefined,
        mcp: undefined,
      }),
      format('srt'),
    ],
    'The input comes from the upload above once you run it. Uploads are transcribed by the speech-to-text chain.',
  ),
  {
    id: 'import-transcript',
    title: 'Import a transcript you already have',
    method: 'POST',
    path: '/api/v1/imports',
    fields: [
      url(ZOO, {
        in: 'body',
        cli: undefined,
        mcp: undefined,
        help: 'The video the transcript belongs to; its metadata comes from the platform.',
      }),
      {
        name: 'text',
        label: 'Transcript (SRT, WebVTT or plain text)',
        type: 'textarea',
        in: 'body',
        default: ZOO_SRT,
        help: 'Edit a line and run it again: the import keeps your wording and timing.',
      },
      { ...lang('en'), in: 'body', key: 'language', cli: undefined, mcp: undefined },
    ],
    response: 'json',
    note: 'Parses SRT, WebVTT, JSON segments or plain text into a VideoContext with origin "imported". Hosted servers return it without saving.',
  },
];

export function runnable(id: string): RunnableSpec {
  const spec = runnables.find((r) => r.id === id);
  if (!spec) throw new Error(`Unknown runnable "${id}". Add it to site/src/data/runnables.ts.`);
  return spec;
}
