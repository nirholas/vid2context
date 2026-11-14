/**
 * Every runnable example on the docs site. A page shows one with a fenced
 * block whose info string is `run <id>`; the build renders the form, the
 * snippets and the response recorded in site/test/fixtures/runnables/<id>.json
 * (scripts/record-runnables.ts writes those from a real server).
 *
 * The videos are real and public: "Me at the zoo" (0:19, three chapters), a
 * G-Wagon buyer video (18 min, nine chapters) and its playlist, and
 * Kurzgesagt's "Optimistic Nihilism" (SponsorBlock segments), and a 15-minute
 * G-Wagon ownership video from the playlist that has no chapters. Responses that would carry an email address (the G-Wagon
 * description has one) are refused by the recorder, so no example shows that
 * video's metadata.
 */
import { formatters } from '@vid2context/core';
import type { Field, RunnableSpec } from '../lib/runnable.ts';

export const ZOO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
export const GWAGON = 'https://www.youtube.com/watch?v=cCPsdFdlshc';
export const GWAGON_PLAYLIST = 'https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b';
export const NIHILISM = 'https://www.youtube.com/watch?v=MBRqu0YOH14';
/** From the G-Wagon playlist: 15:06 with no chapters, for five-minute sections and generated chapters. */
export const OWNING = 'https://www.youtube.com/watch?v=1Xx1fmHIsiA';
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
    fields: [url(OWNING, { cli: undefined }), lang(), mode()],
    response: 'json',
    mcp: { tool: 'get_outline' },
    note: 'No chapters, so the outline is five-minute sections.',
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
      url(OWNING, { in: 'body', cli: undefined, mcp: undefined }),
      { name: 'summaries', label: 'Summaries', type: 'checkbox', in: 'body', default: '' },
    ],
    response: 'json',
    note: 'For videos without chapters: an LLM on the free chain picks chapter titles from the transcript.',
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
      { name: 'maxExcerpts', label: 'Max excerpts', type: 'number', in: 'body', default: '3', optional: true, mcp: { arg: 'maxExcerpts' } },
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
      { name: 'q', label: 'Query', type: 'text', in: 'query', default: 'elephants', cli: { positional: true }, mcp: { arg: 'query' } },
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
];

export function runnable(id: string): RunnableSpec {
  const spec = runnables.find((r) => r.id === id);
  if (!spec) throw new Error(`Unknown runnable "${id}". Add it to site/src/data/runnables.ts.`);
  return spec;
}
