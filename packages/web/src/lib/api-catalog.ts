/**
 * Every route of the vid2context HTTP API (docs/contracts/http-api.md) as the
 * API page shows it: parameters with real defaults, example bodies built from
 * the chosen video, and what each route needs to work. Paths are relative to
 * the API base (/api/v1). Routes the server has that are missing here are
 * merged in from its /openapi.json by mergeOpenApi in playground.ts.
 */

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** Values every default and example body is built from. */
export interface Vars {
  /** The video URL the user picked. */
  video: string;
  /** Its library id (youtube:<id>) when the URL is a YouTube link, else the input itself. */
  videoId: string;
  /** A word that occurs in the transcript. */
  topic: string;
  /** A question the video answers. */
  question: string;
  /** The last id a create call in this group returned (a collection, job, webhook or key). */
  lastId: string;
}

export interface Field {
  name: string;
  in: 'query' | 'path' | 'file';
  kind: 'text' | 'number' | 'select' | 'bool' | 'file';
  description: string;
  required?: boolean;
  options?: string[];
  /** A fixed default, or one built from the video. Empty means not sent. */
  value?: string | ((v: Vars) => string);
  placeholder?: string;
}

export type ResponseKind = 'json' | 'text' | 'zip' | 'sse';

export interface Endpoint {
  id: string;
  method: Method;
  /** Relative to the API base, with {id} style path parameters. Absolute when `root` is set. */
  path: string;
  group: string;
  summary: string;
  description?: string;
  fields: Field[];
  /** A JSON body built from the video. */
  body?: (v: Vars) => unknown;
  response: ResponseKind;
  /** What must be set on the server for the route to answer (an LLM key, a jobs queue, hosted mode). */
  needs?: string;
  /** True for routes that change saved data. "Test all" skips them. */
  mutates?: boolean;
  /** Read-only routes "Test all" runs against the chosen video. */
  smoke?: boolean;
  /** The path is from the server root (MCP, well-known), not the API base. */
  root?: boolean;
}

export const GROUPS = [
  'Server',
  'Videos',
  'Transcripts',
  'Research',
  'Intelligence',
  'Library',
  'Collections',
  'Exports',
  'Jobs',
  'Webhooks',
  'Account',
  'Other',
] as const;

const MODES = ['auto', 'captions', 'stt', 'video'];
const FORMATS = ['text', 'json', 'markdown', 'srt', 'vtt', 'pack'];
const TEMPLATES = ['brief', 'buyer-guide', 'comparison', 'tutorial-steps', 'summary'];
export const SKIP_CATEGORIES = [
  'sponsor',
  'selfpromo',
  'interaction',
  'intro',
  'outro',
  'preview',
  'hook',
  'filler',
  'music_offtopic',
  'poi_highlight',
  'exclusive_access',
  'chapter',
];
const WEBHOOK_EVENTS = ['video.ingested', 'collection.updated', 'job.succeeded', 'job.failed', 'brief.ready'];
const LLM = 'An LLM rung: any free key such as GROQ_API_KEY or CEREBRAS_API_KEY, a local model, or a keyless rung.';

const url: Field = {
  name: 'url',
  in: 'query',
  kind: 'text',
  required: true,
  description: 'A video URL, a YouTube id, or upload:<sha256> from POST /uploads.',
  value: (v) => v.video,
};
const mode: Field = {
  name: 'mode',
  in: 'query',
  kind: 'select',
  options: MODES,
  description:
    'auto: captions first, then speech-to-text. captions: never download audio. stt: always transcribe. video: a multimodal model.',
};
const lang: Field = {
  name: 'lang',
  in: 'query',
  kind: 'text',
  description: 'Preferred transcript language, BCP-47.',
  placeholder: 'en',
};
const format: Field = {
  name: 'format',
  in: 'query',
  kind: 'select',
  options: FORMATS,
  value: 'text',
  description: 'A formatter id from GET /formats.',
};
const timestamps: Field = {
  name: 'timestamps',
  in: 'query',
  kind: 'bool',
  description: 'Prefix lines with timestamps where the format allows.',
};
const limit = (description: string, value = ''): Field => ({ name: 'limit', in: 'query', kind: 'number', description, value });
const pathId = (description: string, value: Field['value'] = (v) => v.lastId): Field => ({
  name: 'id',
  in: 'path',
  kind: 'text',
  required: true,
  description,
  value,
});

export const CATALOG: Endpoint[] = [
  // Server
  {
    id: 'health',
    method: 'GET',
    path: '/health',
    group: 'Server',
    summary: 'Health and providers',
    description: 'Liveness, version, formats, and every provider and rung with whether it is enabled. Open without an API key.',
    fields: [],
    response: 'json',
    smoke: true,
  },
  {
    id: 'formats',
    method: 'GET',
    path: '/formats',
    group: 'Server',
    summary: 'Output formats',
    description: 'Every formatter the server can render, with its MIME type and file extension.',
    fields: [],
    response: 'json',
    smoke: true,
  },
  {
    id: 'models',
    method: 'GET',
    path: '/models',
    group: 'Server',
    summary: 'Models',
    description: 'Every model rung the server knows, enabled or not, and the default policy.',
    fields: [
      {
        name: 'kind',
        in: 'query',
        kind: 'select',
        options: ['llm', 'stt', 'embed', 'video', 'visual'],
        description: 'Only rungs of this kind.',
      },
    ],
    response: 'json',
    smoke: true,
  },
  {
    id: 'openapi',
    method: 'GET',
    path: '/openapi.json',
    group: 'Server',
    summary: 'OpenAPI document',
    description: 'OpenAPI 3.1 for every route this server serves, generated from the routes it actually has.',
    fields: [],
    response: 'json',
  },

  // Videos
  {
    id: 'context',
    method: 'GET',
    path: '/context',
    group: 'Videos',
    summary: 'Full video context',
    description:
      'Metadata, the timed transcript, optional visual notes and comments, and every attempt. The first call fetches the video; later calls read the library copy.',
    fields: [
      url,
      mode,
      lang,
      { name: 'refresh', in: 'query', kind: 'bool', description: 'Ignore the library copy and rebuild.' },
    ],
    response: 'json',
    smoke: true,
  },
  {
    id: 'metadata',
    method: 'GET',
    path: '/metadata',
    group: 'Videos',
    summary: 'Metadata only',
    description: 'Title, channel, duration, chapters and tags, without fetching captions or audio.',
    fields: [url],
    response: 'json',
    smoke: true,
  },
  {
    id: 'outline',
    method: 'GET',
    path: '/outline',
    group: 'Videos',
    summary: 'Outline with token counts',
    description:
      'Chapters (or five-minute sections when the video has none) with token estimates, so an agent can pick what to read.',
    fields: [url, mode, lang],
    response: 'json',
    smoke: true,
  },
  {
    id: 'comments',
    method: 'GET',
    path: '/comments',
    group: 'Videos',
    summary: 'Top comments',
    description: 'Top comments from the source. Answers no-provider (503) when the source cannot fetch comments.',
    fields: [url, limit('1 to 1000.', '20')],
    response: 'json',
    smoke: true,
  },
  {
    id: 'items',
    method: 'GET',
    path: '/items',
    group: 'Videos',
    summary: 'Expand a playlist or channel',
    description: 'Expands a playlist, channel, feed or page into video refs. A single video returns itself.',
    fields: [
      { ...url, description: 'A playlist, channel, feed or page URL (a single video returns itself).' },
      limit('1 to 500.', '10'),
    ],
    response: 'json',
    smoke: true,
  },
  {
    id: 'caption-languages',
    method: 'GET',
    path: '/caption-languages',
    group: 'Videos',
    summary: 'Caption languages',
    description: 'The caption tracks the platform has for the video, creator and automatic, without downloading any.',
    fields: [url],
    response: 'json',
    smoke: true,
  },
  {
    id: 'skips',
    method: 'GET',
    path: '/skips',
    group: 'Videos',
    summary: 'Sponsor segments',
    description:
      'SponsorBlock segments for a YouTube video (sponsor reads, self-promotion, intros), with how much of the transcript they cover. Data from SponsorBlock.',
    fields: [
      url,
      {
        name: 'categories',
        in: 'query',
        kind: 'text',
        description: `Comma-separated. Any of: ${SKIP_CATEGORIES.join(', ')}.`,
        placeholder: 'sponsor,selfpromo',
      },
    ],
    response: 'json',
    smoke: true,
  },
  {
    id: 'uploads',
    method: 'POST',
    path: '/uploads',
    group: 'Videos',
    summary: 'Upload a file',
    description:
      'Multipart upload of an audio or video file. Answers with an input (upload:<sha256>) that every route taking url accepts. Audio is much smaller than video and goes further.',
    fields: [{ name: 'file', in: 'file', kind: 'file', required: true, description: 'An audio or video file.' }],
    response: 'json',
    needs: 'A speech-to-text rung to transcribe it afterwards.',
  },

  // Transcripts
  {
    id: 'transcript',
    method: 'GET',
    path: '/transcript',
    group: 'Transcripts',
    summary: 'Transcript in any format',
    description: "The transcript rendered by a formatter, with that formatter's Content-Type.",
    fields: [
      url,
      format,
      timestamps,
      mode,
      lang,
      {
        name: 'skip',
        in: 'query',
        kind: 'text',
        description: 'Remove SponsorBlock segments from a copy: categories like sponsor,selfpromo, or 1 for the defaults.',
        placeholder: 'sponsor,selfpromo',
      },
      {
        name: 'translate',
        in: 'query',
        kind: 'bool',
        description: 'Translate into lang: the platform track first, else an LLM that keeps every timestamp. Needs lang.',
      },
    ],
    response: 'text',
    smoke: true,
  },
  {
    id: 'section',
    method: 'GET',
    path: '/section',
    group: 'Transcripts',
    summary: 'One section',
    description: 'One time range or chapter of the transcript. Give from and to (seconds or m:ss), or a chapter.',
    fields: [
      url,
      { name: 'from', in: 'query', kind: 'text', description: 'Start, in seconds or m:ss.', value: '0:00' },
      { name: 'to', in: 'query', kind: 'text', description: 'End, in seconds or m:ss.', value: '0:15' },
      {
        name: 'chapter',
        in: 'query',
        kind: 'text',
        description: 'An outline index (0-based) or a chapter title, instead of from and to.',
      },
      format,
      timestamps,
      mode,
      lang,
    ],
    response: 'text',
    smoke: true,
  },
  {
    id: 'pack',
    method: 'GET',
    path: '/pack',
    group: 'Transcripts',
    summary: 'Context pack',
    description: 'One Markdown file sized for a token budget, with citation instructions for an agent.',
    fields: [url, { name: 'maxTokens', in: 'query', kind: 'number', description: 'Token budget.', value: '4000' }, mode, lang],
    response: 'text',
    smoke: true,
  },
  {
    id: 'pack-many',
    method: 'POST',
    path: '/pack',
    group: 'Transcripts',
    summary: 'Context pack for many videos',
    description: 'One pack for several videos: inputs (playlists are expanded) and/or a collection. At most 100 videos.',
    fields: [],
    body: (v) => ({ inputs: [v.video], maxTokens: 8000 }),
    response: 'text',
  },
  {
    id: 'bundle',
    method: 'GET',
    path: '/bundle',
    group: 'Transcripts',
    summary: 'Bundle as .zip',
    description: 'A .zip with context.md, transcripts in every chosen format, metadata and a manifest.',
    fields: [
      url,
      {
        name: 'formats',
        in: 'query',
        kind: 'text',
        description: 'Comma-separated formatter ids.',
        value: 'text,markdown,srt,json',
      },
      { name: 'comments', in: 'query', kind: 'bool', description: 'Include top comments.' },
      { name: 'maxTokens', in: 'query', kind: 'number', description: 'Token budget for context.md.' },
      mode,
      lang,
    ],
    response: 'zip',
  },
  {
    id: 'bundle-many',
    method: 'POST',
    path: '/bundle',
    group: 'Transcripts',
    summary: 'Bundle many as .zip',
    description: 'One .zip for several videos: inputs and/or a collection. At most 100 videos.',
    fields: [],
    body: (v) => ({ inputs: [v.video], formats: ['text', 'srt'] }),
    response: 'zip',
  },

  // Research
  {
    id: 'search',
    method: 'GET',
    path: '/search',
    group: 'Research',
    summary: 'Search saved transcripts',
    description:
      'Hybrid keyword and vector search across every saved transcript, with timestamp links. Open a video with /context first so it is in the library.',
    fields: [
      {
        name: 'q',
        in: 'query',
        kind: 'text',
        required: true,
        description: 'Words, "phrases" and -excluded words.',
        value: (v) => v.topic,
      },
      limit('1 to 100.', '5'),
      { name: 'mode', in: 'query', kind: 'select', options: ['hybrid', 'keyword', 'vector'], description: 'Which side to run.' },
      { name: 'collectionId', in: 'query', kind: 'text', description: 'Only this collection.' },
      { name: 'videoIds', in: 'query', kind: 'text', description: 'Comma-separated video ids.' },
      { name: 'rerank', in: 'query', kind: 'bool', description: 'Rerank the hits with a model.' },
    ],
    response: 'json',
    needs: 'Vector search needs an embedding rung; keyword search works without one.',
  },
  {
    id: 'research',
    method: 'POST',
    path: '/research',
    group: 'Research',
    summary: 'Find a topic across videos',
    description: 'Every place the words come up across the videos, with surrounding context and timestamp links.',
    fields: [],
    body: (v) => ({ urls: [v.video], query: v.topic, contextSec: 20, maxExcerpts: 5 }),
    response: 'json',
  },
  {
    id: 'key-moments',
    method: 'GET',
    path: '/key-moments',
    group: 'Research',
    summary: 'Key moments',
    description: 'The most important moments of the video, with timestamps.',
    fields: [url, { name: 'count', in: 'query', kind: 'number', description: 'How many moments.', value: '5' }],
    response: 'json',
    smoke: true,
  },

  // Intelligence
  {
    id: 'ask',
    method: 'POST',
    path: '/ask',
    group: 'Intelligence',
    summary: 'Ask a question',
    description: 'An answer grounded in the videos, citing moments as [n] with timestamp links.',
    fields: [],
    body: (v) => ({ question: v.question, inputs: [v.video] }),
    response: 'json',
    needs: LLM,
  },
  {
    id: 'chat',
    method: 'POST',
    path: '/chat',
    group: 'Intelligence',
    summary: 'Chat (streaming)',
    description:
      'Multi-turn answers grounded in videos, streamed as server-sent events: meta, delta, then done or error. Omit model for Auto.',
    fields: [],
    body: (v) => ({ messages: [{ role: 'user', content: v.question }], context: { inputs: [v.video] } }),
    response: 'sse',
    needs: LLM,
  },
  {
    id: 'briefs',
    method: 'POST',
    path: '/briefs',
    group: 'Intelligence',
    summary: 'Cited brief',
    description: `Verified claims with citations, consensus and disagreements across videos. Templates: ${TEMPLATES.join(', ')}. Answers 202 with a job when the server has a jobs queue.`,
    fields: [],
    body: (v) => ({ inputs: [v.video], question: v.question, template: 'brief' }),
    response: 'json',
    needs: LLM,
  },
  {
    id: 'extract',
    method: 'POST',
    path: '/extract',
    group: 'Intelligence',
    summary: 'Structured extraction',
    description:
      'Data matching a template or your own JSON Schema, with verified citations. Answers 202 with a job when the server has a jobs queue.',
    fields: [],
    body: (v) => ({ inputs: [v.video], template: 'summary' }),
    response: 'json',
    needs: LLM,
  },
  {
    id: 'chapters',
    method: 'POST',
    path: '/chapters',
    group: 'Intelligence',
    summary: 'Generate chapters',
    description:
      'Chapters for a video, offline (TextTiling) or with an LLM for titles and summaries. A video with chapters needs force: true.',
    fields: [],
    body: (v) => ({ url: v.video, force: true, summaries: false }),
    response: 'json',
    needs: 'Nothing for offline chapters; an LLM rung for titles and summaries.',
  },

  // Library
  {
    id: 'library',
    method: 'GET',
    path: '/library',
    group: 'Library',
    summary: 'Saved videos',
    description: 'Every saved video, newest first, one page at a time.',
    fields: [limit('1 to 200.', '20'), { name: 'cursor', in: 'query', kind: 'text', description: 'From the previous page.' }],
    response: 'json',
  },
  {
    id: 'library-get',
    method: 'GET',
    path: '/library/{id}',
    group: 'Library',
    summary: 'One saved video',
    description: 'The saved VideoContext. 404 until the video has been opened once.',
    fields: [pathId('A video id such as youtube:jNQXAC9IVRw.', (v) => v.videoId)],
    response: 'json',
  },
  {
    id: 'library-delete',
    method: 'DELETE',
    path: '/library/{id}',
    group: 'Library',
    summary: 'Remove a saved video',
    description: 'Removes the video from the library and from every collection.',
    fields: [pathId('A video id such as youtube:jNQXAC9IVRw.', (v) => v.videoId)],
    response: 'json',
    mutates: true,
  },

  // Collections
  {
    id: 'collections',
    method: 'GET',
    path: '/collections',
    group: 'Collections',
    summary: 'List collections',
    fields: [],
    response: 'json',
  },
  {
    id: 'collections-create',
    method: 'POST',
    path: '/collections',
    group: 'Collections',
    summary: 'Create a collection',
    description: 'sources must be lists (playlists, channels, feeds) to watch; add single videos with /collections/{id}/items.',
    fields: [],
    body: () => ({ name: 'API page test', description: 'Made from the vid2context API page.' }),
    response: 'json',
    mutates: true,
  },
  {
    id: 'collections-get',
    method: 'GET',
    path: '/collections/{id}',
    group: 'Collections',
    summary: 'One collection',
    fields: [pathId('A collection id. Filled from the last one you created.')],
    response: 'json',
  },
  {
    id: 'collections-patch',
    method: 'PATCH',
    path: '/collections/{id}',
    group: 'Collections',
    summary: 'Rename or change a collection',
    fields: [pathId('A collection id.')],
    body: () => ({ name: 'API page test (renamed)' }),
    response: 'json',
    mutates: true,
  },
  {
    id: 'collections-delete',
    method: 'DELETE',
    path: '/collections/{id}',
    group: 'Collections',
    summary: 'Delete a collection',
    description: 'Saved transcripts stay in the library.',
    fields: [pathId('A collection id.')],
    response: 'json',
    mutates: true,
  },
  {
    id: 'collections-add',
    method: 'POST',
    path: '/collections/{id}/items',
    group: 'Collections',
    summary: 'Add videos',
    description: 'Videos or lists. Answers 202 with a job when the server has a jobs queue, else runs inline.',
    fields: [pathId('A collection id.')],
    body: (v) => ({ inputs: [v.video] }),
    response: 'json',
    mutates: true,
  },
  {
    id: 'collections-remove',
    method: 'DELETE',
    path: '/collections/{id}/items',
    group: 'Collections',
    summary: 'Remove videos',
    fields: [pathId('A collection id.')],
    body: (v) => ({ videoIds: [v.videoId] }),
    response: 'json',
    mutates: true,
  },
  {
    id: 'collections-refresh',
    method: 'POST',
    path: '/collections/{id}/refresh',
    group: 'Collections',
    summary: 'Refresh sources',
    description: 'Re-expands the sources and ingests new uploads.',
    fields: [pathId('A collection id.')],
    body: () => ({}),
    response: 'json',
    mutates: true,
  },
  {
    id: 'collections-export',
    method: 'GET',
    path: '/collections/{id}/export',
    group: 'Collections',
    summary: 'Export definition',
    description: 'The collection as a portable definition (sources and video ids, no transcripts).',
    fields: [pathId('A collection id.')],
    response: 'json',
  },
  {
    id: 'collections-import',
    method: 'POST',
    path: '/collections/import',
    group: 'Collections',
    summary: 'Import a definition',
    fields: [{ name: 'refresh', in: 'query', kind: 'bool', description: 'Ingest the videos at once.' }],
    body: (v) => ({
      format: 'vid2context.collection',
      version: 1,
      name: 'Imported from the API page',
      sources: [],
      videos: [v.video],
    }),
    response: 'json',
    mutates: true,
  },

  // Exports
  {
    id: 'exports-obsidian',
    method: 'POST',
    path: '/exports/obsidian',
    group: 'Exports',
    summary: 'Obsidian notes',
    description: 'Markdown notes with front matter and timestamp links, one per video, as files in JSON.',
    fields: [],
    body: (v) => ({ inputs: [v.video], folder: 'vid2context' }),
    response: 'json',
  },
  {
    id: 'exports-notion',
    method: 'POST',
    path: '/exports/notion',
    group: 'Exports',
    summary: 'Notion pages',
    description: 'One Notion page per video under a parent page.',
    fields: [],
    body: (v) => ({ inputs: [v.video] }),
    response: 'json',
    needs: 'NOTION_TOKEN and a parent page (parentPageId or NOTION_PARENT_PAGE_ID) on the server.',
    mutates: true,
  },

  // Jobs
  {
    id: 'jobs-create',
    method: 'POST',
    path: '/jobs',
    group: 'Jobs',
    summary: 'Start a job',
    description: 'Built-in kinds: context (one URL), items (a playlist; options limit, concurrency), bundle (one or more URLs).',
    fields: [],
    body: (v) => ({ kind: 'context', input: v.video }),
    response: 'json',
    needs: 'A jobs queue (the Node server has one).',
  },
  {
    id: 'jobs-get',
    method: 'GET',
    path: '/jobs/{id}',
    group: 'Jobs',
    summary: 'Job status',
    fields: [pathId('A job id. Filled from the last job you started.')],
    response: 'json',
    needs: 'A jobs queue.',
  },
  {
    id: 'jobs-events',
    method: 'GET',
    path: '/jobs/{id}/events',
    group: 'Jobs',
    summary: 'Job events (streaming)',
    description: 'Server-sent events: progress, item, then done or error. Replays the state first.',
    fields: [pathId('A job id.')],
    response: 'sse',
    needs: 'A jobs queue.',
  },
  {
    id: 'jobs-cancel',
    method: 'DELETE',
    path: '/jobs/{id}',
    group: 'Jobs',
    summary: 'Cancel a job',
    fields: [pathId('A job id.')],
    response: 'json',
    needs: 'A jobs queue.',
    mutates: true,
  },

  // Webhooks
  {
    id: 'webhooks',
    method: 'GET',
    path: '/webhooks',
    group: 'Webhooks',
    summary: 'List webhooks',
    fields: [],
    response: 'json',
  },
  {
    id: 'webhooks-create',
    method: 'POST',
    path: '/webhooks',
    group: 'Webhooks',
    summary: 'Register a webhook',
    description: `Put your own HTTPS endpoint in url. Events: ${WEBHOOK_EVENTS.join(', ')}.`,
    fields: [],
    body: () => ({ url: 'https://example.com/hook', events: ['video.ingested', 'collection.updated'] }),
    response: 'json',
    mutates: true,
  },
  {
    id: 'webhooks-test',
    method: 'POST',
    path: '/webhooks/{id}/test',
    group: 'Webhooks',
    summary: 'Send a test event',
    fields: [pathId('A webhook id. Filled from the last one you registered.')],
    response: 'json',
  },
  {
    id: 'webhooks-delete',
    method: 'DELETE',
    path: '/webhooks/{id}',
    group: 'Webhooks',
    summary: 'Delete a webhook',
    fields: [pathId('A webhook id.')],
    response: 'json',
    mutates: true,
  },

  // Account (hosted mode)
  {
    id: 'me',
    method: 'GET',
    path: '/me',
    group: 'Account',
    summary: 'Who am I',
    fields: [],
    response: 'json',
    needs: 'Hosted mode (VID2CONTEXT_HOSTED=1) and a session or v2c_ key.',
  },
  {
    id: 'me-usage',
    method: 'GET',
    path: '/me/usage',
    group: 'Account',
    summary: 'Usage and quota',
    fields: [],
    response: 'json',
    needs: 'Hosted mode and a session or key.',
  },
  {
    id: 'me-keys',
    method: 'GET',
    path: '/me/keys',
    group: 'Account',
    summary: 'List API keys',
    fields: [],
    response: 'json',
    needs: 'Hosted mode and a session or key.',
  },
  {
    id: 'me-keys-create',
    method: 'POST',
    path: '/me/keys',
    group: 'Account',
    summary: 'Create an API key',
    description: 'The key is shown once, in this response.',
    fields: [],
    body: () => ({ name: 'API page' }),
    response: 'json',
    needs: 'Hosted mode and a session or key.',
    mutates: true,
  },
  {
    id: 'me-keys-delete',
    method: 'DELETE',
    path: '/me/keys/{id}',
    group: 'Account',
    summary: 'Revoke an API key',
    fields: [pathId('A key id. Filled from the last one you created.')],
    response: 'json',
    needs: 'Hosted mode and a session or key.',
    mutates: true,
  },
];

/** The library id of a YouTube link (youtube:<11 chars>), else the input unchanged. */
export function videoIdOf(input: string): string {
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return `youtube:${s}`;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
    let id: string | null = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0] ?? null;
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      id = u.searchParams.get('v') ?? u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/)?.[1] ?? null;
    }
    if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return `youtube:${id}`;
  } catch {
    // Not a URL: an id of another platform or a path, used as is.
  }
  return s;
}

export function findEndpoint(list: Endpoint[], id: string | undefined): Endpoint | undefined {
  return id ? list.find((e) => e.id === id) : undefined;
}
