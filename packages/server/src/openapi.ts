/**
 * OpenAPI 3.1 for every route the app serves. Each route module registers a
 * RouteDoc next to its handler; buildOpenApi walks the routes Hono actually
 * has (including mounted sub-apps) and pairs each with its doc, so the
 * document can never list a route that does not exist or miss one that does.
 * Sub-apps without docs of their own still appear, with a generic entry.
 */

type Schema = Record<string, unknown>;

export interface ParamDoc {
  name: string;
  in?: 'query' | 'path' | 'header';
  description: string;
  required?: boolean;
  schema?: Schema;
}

export interface ResponseDoc {
  description: string;
  /** Content type to schema. */
  content?: Record<string, Schema>;
  headers?: Record<string, string>;
}

export interface RouteDoc {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** Hono path, e.g. `/api/v1/library/:id`. */
  path: string;
  summary: string;
  description?: string;
  tags: string[];
  params?: ParamDoc[];
  body?: { description?: string; required?: boolean; content: Record<string, Schema> };
  /** Success responses. Error responses are added from the shared Error schema. */
  responses: Record<string, ResponseDoc>;
  /** `false` for routes open without an API key (only /health). */
  auth?: boolean;
}

/** An OpenAPI `paths` object a sub-app package may export, relative to /api/v1 (or to the root for root mounts). */
export type PathsObject = Record<string, Record<string, unknown>>;

export const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
export const json = (schema: Schema): Record<string, Schema> => ({ 'application/json': schema });
const str = (description?: string): Schema => ({ type: 'string', ...(description ? { description } : {}) });
const num = (description?: string): Schema => ({ type: 'number', ...(description ? { description } : {}) });
const int = (description?: string): Schema => ({ type: 'integer', ...(description ? { description } : {}) });
const arr = (items: Schema): Schema => ({ type: 'array', items });
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
});

/** Query parameters shared by many routes. */
export const P = {
  url: { name: 'url', description: 'Any input a source understands: a video URL, a YouTube id, upload:<sha256>, or a local path (Node, not in public mode). URL-encode it.', required: true },
  mode: { name: 'mode', description: 'Transcript strategy.', schema: { type: 'string', enum: ['auto', 'captions', 'stt', 'video'], default: 'auto' } },
  lang: { name: 'lang', description: 'Preferred transcript language, BCP-47 (en, de, pt-BR).' },
  format: { name: 'format', description: 'A formatter id from GET /api/v1/formats.', schema: { type: 'string', default: 'text' } },
  timestamps: { name: 'timestamps', description: '1, true or yes to prefix lines with timestamps where the format allows.' },
  limit: (description: string) => ({ name: 'limit', description, schema: { type: 'integer', minimum: 1 } }),
} satisfies Record<string, ParamDoc | ((d: string) => ParamDoc)>;

/** A response rendered by a formatter: its Content-Type is the formatter's MIME type (text/plain, text/markdown, application/json, ...). */
export const textResponse = (description = "The rendered output. Content-Type is the chosen formatter's MIME type."): ResponseDoc => ({
  description,
  content: { 'text/plain': { type: 'string' }, 'text/markdown': { type: 'string' } },
});

/** Component schemas for the core data types, matching packages/core/src/types.ts and storage.ts. */
export const SCHEMAS: Record<string, Schema> = {
  Error: obj(
    {
      error: obj({ code: str('A core ErrorCode, or internal, unauthorized, forbidden.'), message: str(), hint: str('How to recover.') }, ['code', 'message']),
      attempts: arr(ref('Attempt')),
    },
    ['error', 'attempts'],
  ),
  Attempt: obj(
    {
      id: str('Rung or provider id.'),
      stage: { type: 'string', enum: ['resolve', 'metadata', 'captions', 'audio', 'stt', 'video', 'llm', 'embed', 'visual'] },
      outcome: { type: 'string', enum: ['ok', 'skipped', 'empty', 'error'] },
      reason: str(),
      detail: str(),
      ms: num(),
    },
    ['id', 'stage', 'outcome'],
  ),
  VideoRef: obj(
    {
      input: str(),
      platform: str(),
      kind: { type: 'string', enum: ['video', 'playlist', 'channel', 'feed', 'page'] },
      id: str('platform:nativeId'),
      nativeId: str(),
      url: str(),
    },
    ['input', 'platform', 'kind', 'id', 'nativeId'],
  ),
  Chapter: obj({ title: str(), startSec: num(), endSec: num() }, ['title', 'startSec']),
  VideoMetadata: obj(
    {
      ref: ref('VideoRef'),
      title: str(),
      channel: obj({ name: str(), id: str(), url: str() }, ['name']),
      description: str(),
      durationSec: num(),
      publishedAt: str('ISO 8601.'),
      thumbnailUrl: str(),
      language: str(),
      tags: arr(str()),
      chapters: arr(ref('Chapter')),
      isLive: { type: 'boolean' },
      extra: { type: 'object', additionalProperties: true },
    },
    ['ref', 'title', 'chapters'],
  ),
  Segment: obj({ startSec: num(), endSec: num(), text: str(), speaker: str(), confidence: num() }, ['startSec', 'endSec', 'text']),
  Transcript: obj(
    {
      ref: ref('VideoRef'),
      language: str(),
      origin: { type: 'string', enum: ['creator-captions', 'auto-captions', 'native-transcript', 'stt', 'video-model'] },
      producer: str(),
      model: str(),
      translated: { type: 'boolean' },
      segments: arr(ref('Segment')),
      createdAt: str(),
    },
    ['ref', 'language', 'origin', 'producer', 'segments', 'createdAt'],
  ),
  VisualNote: obj(
    { atSec: num(), kind: { type: 'string', enum: ['ocr', 'description', 'slide', 'code', 'chart'] }, text: str(), producer: str() },
    ['atSec', 'kind', 'text', 'producer'],
  ),
  Comment: obj(
    {
      id: str(),
      author: str(),
      text: str(),
      likes: num(),
      publishedAt: str(),
      isCreator: { type: 'boolean' },
      isPinned: { type: 'boolean' },
      replies: arr(ref('Comment')),
    },
    ['id', 'author', 'text'],
  ),
  VideoContext: obj(
    {
      metadata: ref('VideoMetadata'),
      transcript: ref('Transcript'),
      visual: arr(ref('VisualNote')),
      comments: arr(ref('Comment')),
      attempts: arr(ref('Attempt')),
    },
    ['metadata', 'transcript', 'attempts'],
  ),
  VideoSummary: obj(
    {
      id: str(),
      ref: ref('VideoRef'),
      title: str(),
      channel: str(),
      durationSec: num(),
      origin: str(),
      language: str(),
      savedAt: str(),
    },
    ['id', 'ref', 'title', 'origin', 'language', 'savedAt'],
  ),
  ModelInfo: obj(
    {
      id: str('Rung id.'),
      kind: { type: 'string', enum: ['llm', 'stt', 'embed', 'video', 'visual'] },
      label: str(),
      service: str(),
      provider: str(),
      model: str(),
      tier: { type: 'string', enum: ['local', 'free', 'keyless', 'paid'] },
      quality: num(),
      capabilities: arr(str()),
      contextTokens: int(),
      enabled: { type: 'boolean' },
      requires: arr(str('Env var name, never its value.')),
    },
    ['id', 'kind', 'label', 'service', 'provider', 'model', 'tier', 'quality', 'capabilities', 'enabled', 'requires'],
  ),
  Upload: obj(
    { input: str('upload:<sha256>'), filename: str(), bytes: int(), mimeType: str(), expiresAt: str('ISO 8601.') },
    ['input', 'filename', 'bytes', 'mimeType', 'expiresAt'],
  ),
  Format: obj({ id: str(), description: str(), mimeType: str(), extension: str() }, ['id', 'description', 'mimeType', 'extension']),
};

const ERROR_RESPONSES: Record<string, ResponseDoc> = {
  '400': { description: 'Bad request or unsupported input.', content: json(ref('Error')) },
  '401': { description: 'Missing or invalid API key (only when the server has keys).', content: json(ref('Error')) },
  '403': { description: 'The key lacks the scope, or the video is unavailable.', content: json(ref('Error')) },
  '429': { description: 'Rate limited. See Retry-After.', content: json(ref('Error')) },
  default: { description: 'Error with code, hint and attempts.', content: json(ref('Error')) },
};

/** Collects RouteDocs from the route modules. */
export class RouteDocs {
  private docs = new Map<string, RouteDoc>();

  add(doc: RouteDoc): void {
    this.docs.set(`${doc.method.toUpperCase()} ${doc.path}`, doc);
  }

  find(method: string, path: string): RouteDoc | undefined {
    return this.docs.get(`${method.toUpperCase()} ${path}`);
  }
}

/** `/library/:id` to `/library/{id}`, plus the names of its path parameters. */
export function toOpenApiPath(path: string): { path: string; params: string[] } {
  const params: string[] = [];
  const out = path.replace(/:([A-Za-z0-9_]+)(\{[^}]*\})?/g, (_m, name: string) => {
    params.push(name);
    return `{${name}}`;
  });
  return { path: out, params };
}

function responsesFor(doc: RouteDoc): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [status, r] of Object.entries({ ...doc.responses, ...ERROR_RESPONSES })) {
    if (doc.auth === false && (status === '401' || status === '403')) continue;
    out[status] = {
      description: r.description,
      ...(r.headers
        ? { headers: Object.fromEntries(Object.entries(r.headers).map(([h, d]) => [h, { description: d, schema: { type: 'string' } }])) }
        : {}),
      ...(r.content ? { content: Object.fromEntries(Object.entries(r.content).map(([t, schema]) => [t, { schema }])) } : {}),
    };
  }
  return out;
}

function operationFor(doc: RouteDoc, pathParams: string[]): Record<string, unknown> {
  const params = [
    ...pathParams.map((name) => {
      const given = doc.params?.find((p) => p.name === name && p.in === 'path');
      return { name, in: 'path', required: true, description: given?.description ?? name, schema: given?.schema ?? { type: 'string' } };
    }),
    ...(doc.params ?? [])
      .filter((p) => (p.in ?? 'query') !== 'path')
      .map((p) => ({
        name: p.name,
        in: p.in ?? 'query',
        description: p.description,
        required: Boolean(p.required),
        schema: p.schema ?? { type: 'string' },
      })),
  ];
  return {
    operationId: `${doc.method}${doc.path
      .replace(/^\/api\/v1/, '')
      .split(/[/:.-]+/)
      .filter(Boolean)
      .map((s) => s[0]?.toUpperCase() + s.slice(1))
      .join('')}`,
    summary: doc.summary,
    ...(doc.description ? { description: doc.description } : {}),
    tags: doc.tags,
    ...(params.length ? { parameters: params } : {}),
    ...(doc.body
      ? {
          requestBody: {
            required: doc.body.required ?? true,
            ...(doc.body.description ? { description: doc.body.description } : {}),
            content: Object.fromEntries(Object.entries(doc.body.content).map(([t, schema]) => [t, { schema }])),
          },
        }
      : {}),
    responses: responsesFor(doc),
    ...(doc.auth === false ? { security: [] } : {}),
  };
}

export interface OpenApiOptions {
  version: string;
  /** Every route the app serves, as Hono lists them (`app.routes`). */
  routes: { method: string; path: string }[];
  docs: RouteDocs;
  /** Paths objects exported by mounted sub-apps, keyed by their mount prefix. */
  subAppPaths?: { prefix: string; paths: PathsObject; tag: string }[];
  /** Tag for routes that come from each mount prefix without docs (for grouping). */
  tagFor?: (path: string) => string;
}

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

export function buildOpenApi(opts: OpenApiOptions): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const seen = new Set<string>();
  for (const route of opts.routes) {
    const method = route.method.toLowerCase();
    if (!METHODS.has(method) || route.path.includes('*')) continue;
    const key = `${method} ${route.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { path, params } = toOpenApiPath(route.path);
    const item = (paths[path] ??= {});
    const doc = opts.docs.find(method, route.path);
    if (doc) {
      item[method] = operationFor(doc, params);
      continue;
    }
    const sub = opts.subAppPaths?.find((s) => route.path.startsWith(s.prefix));
    const subPath = sub ? toOpenApiPath(route.path.slice(sub.prefix.length) || '/').path : undefined;
    const subOp = sub && subPath ? sub.paths[subPath]?.[method] : undefined;
    if (subOp && sub) {
      item[method] = { tags: [sub.tag], ...(subOp as Record<string, unknown>) };
      continue;
    }
    item[method] = operationFor(
      {
        method: method as RouteDoc['method'],
        path: route.path,
        summary: `${method.toUpperCase()} ${path}`,
        description: 'Served by a mounted sub-app that does not publish an OpenAPI description. See docs/contracts/http-api.md.',
        tags: [opts.tagFor?.(route.path) ?? 'other'],
        responses: { '200': { description: 'Success.', content: { 'application/json': {} } } },
      },
      params,
    );
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'vid2context HTTP API',
      version: opts.version,
      description:
        'Turn any video into context for AI agents: transcripts, metadata, chapters, sections, outlines, context packs and bundles. Errors share one body: { error: { code, message, hint? }, attempts }.',
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    servers: [{ url: '/' }],
    security: [{ bearerAuth: [] }, {}],
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
    components: {
      schemas: SCHEMAS,
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Required when the server sets VID2CONTEXT_API_KEYS; otherwise the server is open.',
        },
      },
    },
  };
}
