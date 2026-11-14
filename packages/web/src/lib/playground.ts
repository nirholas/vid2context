/**
 * The API page's request side: turn an endpoint and the form into a request,
 * show it as curl, and merge the server's own /openapi.json into the catalog
 * so every route it serves is listed and routes it lacks are marked.
 */
import { type Endpoint, type Field, type Method, type Vars, videoIdOf } from './api-catalog.ts';
import { EXAMPLES } from './examples.ts';

/** The user's edits to one endpoint's form: field overrides and the body text. Unset means "use the default". */
export interface FormState {
  values: Record<string, string>;
  body?: string;
}

export function varsFor(video: string, lastId = ''): Vars {
  const example = EXAMPLES.find((e) => e.url === video.trim());
  return {
    video: video.trim(),
    videoId: videoIdOf(video),
    topic: example?.topic ?? 'video',
    question: example?.question ?? 'What is this video about? Cite the moments you use.',
    lastId,
  };
}

export function defaultValue(field: Field, vars: Vars): string {
  const v = field.value;
  return typeof v === 'function' ? v(vars) : (v ?? '');
}

export function fieldValue(field: Field, form: FormState | undefined, vars: Vars): string {
  return form?.values[field.name] ?? defaultValue(field, vars);
}

export function defaultBody(ep: Endpoint, vars: Vars): string {
  return ep.body ? JSON.stringify(ep.body(vars), null, 2) : '';
}

export function bodyText(ep: Endpoint, form: FormState | undefined, vars: Vars): string {
  return form?.body ?? defaultBody(ep, vars);
}

export function hasBody(ep: Endpoint): boolean {
  return !!ep.body;
}

/** The server root for routes outside the API base: the base without its trailing /api/v1. */
export function rootOf(base: string): string {
  return base.replace(/\/api\/v\d+$/, '');
}

export interface BuiltRequest {
  method: Method;
  url: string;
  headers: Record<string, string>;
  /** JSON text, or a multipart file. */
  body?: string | { file: File | null; field: string };
  /** Required fields that are empty. The request is not sent while any are. */
  missing: string[];
  /** Set when the body is not valid JSON. */
  bodyError?: string;
}

export function buildRequest(
  ep: Endpoint,
  form: FormState | undefined,
  vars: Vars,
  base: string,
  opts: { file?: File | null; apiKey?: string } = {},
): BuiltRequest {
  const missing: string[] = [];
  let path = ep.path;
  const q = new URLSearchParams();
  for (const f of ep.fields) {
    if (f.in === 'file') {
      if (f.required && !opts.file) missing.push(f.name);
      continue;
    }
    const raw = fieldValue(f, form, vars).trim();
    const value = f.kind === 'bool' ? (raw === '1' ? '1' : '') : raw;
    if (!value) {
      if (f.required) missing.push(f.name);
      continue;
    }
    if (f.in === 'path') path = path.replace(`{${f.name}}`, encodeURIComponent(value));
    else q.set(f.name, value);
  }
  const qs = q.toString();
  const url = `${ep.root ? rootOf(base) : base}${path}${qs ? `?${qs}` : ''}`;
  const headers: Record<string, string> = {
    accept: ep.response === 'sse' ? 'text/event-stream' : ep.response === 'zip' ? 'application/zip' : 'application/json, text/*',
  };
  if (opts.apiKey?.trim()) headers.authorization = `Bearer ${opts.apiKey.trim()}`;

  const fileField = ep.fields.find((f) => f.in === 'file');
  if (fileField) return { method: ep.method, url, headers, body: { file: opts.file ?? null, field: fileField.name }, missing };

  if (!hasBody(ep)) return { method: ep.method, url, headers, missing };
  const text = bodyText(ep, form, vars).trim();
  if (!text) return { method: ep.method, url, headers, missing };
  headers['content-type'] = 'application/json';
  let bodyError: string | undefined;
  try {
    JSON.parse(text);
  } catch (err) {
    bodyError = err instanceof Error ? err.message : String(err);
  }
  return { method: ep.method, url, headers, body: text, missing, bodyError };
}

/** Single-quote a value for POSIX shells. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The request as a curl command. The key is never written into the command:
 * it reads $VID2CONTEXT_API_KEY, so a copied command is safe to paste anywhere.
 */
export function toCurl(req: BuiltRequest, origin: string): string {
  const abs = new URL(req.url, origin).href;
  const parts = ['curl', '-sS'];
  if (req.method !== 'GET') parts.push('-X', req.method);
  parts.push(shellQuote(abs));
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === 'accept' && !v.includes('event-stream')) continue;
    if (k === 'authorization') parts.push('-H', '"Authorization: Bearer $VID2CONTEXT_API_KEY"');
    else parts.push('-H', shellQuote(`${k}: ${v}`));
  }
  if (req.headers.accept?.includes('event-stream')) parts.splice(1, 0, '-N');
  if (typeof req.body === 'string') {
    let compact = req.body;
    try {
      compact = JSON.stringify(JSON.parse(req.body));
    } catch {
      // Invalid JSON is shown as typed, so the command matches what would be sent.
    }
    parts.push('-d', shellQuote(compact));
  } else if (req.body) {
    parts.push('-F', shellQuote(`${req.body.field}=@${req.body.file?.name ?? 'file'}`));
  }
  if (req.headers.accept === 'application/zip') parts.push('-o', 'bundle.zip');
  return parts.join(' ');
}

interface OpenApiDoc {
  paths?: Record<
    string,
    Record<string, { summary?: string; description?: string; tags?: string[]; parameters?: OpenApiParam[] }>
  >;
}
interface OpenApiParam {
  name: string;
  in: string;
  description?: string;
  required?: boolean;
}

const METHODS = new Set(['get', 'post', 'patch', 'delete']);

/** Browser sign-in and OAuth flows: redirects and form posts, not something to call with fetch. */
export function isBrowserFlow(path: string): boolean {
  return path.startsWith('/oauth/') || path.startsWith('/api/v1/auth/');
}

export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path.replace(/:([A-Za-z_]+)/g, '{$1}')}`;
}

/** Path of a catalog entry as the server's OpenAPI document spells it. */
export function serverPath(ep: Endpoint): string {
  return ep.root ? ep.path : `/api/v1${ep.path}`;
}

export interface Merged {
  endpoints: Endpoint[];
  /** Route keys the server serves; undefined when its OpenAPI document could not be read. */
  served?: Set<string>;
}

/**
 * The catalog plus every route in the server's OpenAPI document that the
 * catalog lacks (in group Other), minus browser sign-in flows.
 */
export function mergeOpenApi(catalog: Endpoint[], doc: unknown): Merged {
  const paths = (doc as OpenApiDoc | null)?.paths;
  if (!paths || typeof paths !== 'object') return { endpoints: catalog };
  const served = new Set<string>();
  const known = new Set(catalog.map((e) => routeKey(e.method, serverPath(e))));
  const extra: Endpoint[] = [];
  for (const [path, ops] of Object.entries(paths)) {
    for (const [m, op] of Object.entries(ops ?? {})) {
      if (!METHODS.has(m)) continue;
      const key = routeKey(m, path);
      served.add(key);
      if (known.has(key) || isBrowserFlow(path)) continue;
      const inApi = path.startsWith('/api/v1/');
      const fields: Field[] = (op.parameters ?? [])
        .filter((p) => p.in === 'query' || p.in === 'path')
        .map((p) => ({
          name: p.name,
          in: p.in as 'query' | 'path',
          kind: 'text',
          required: p.required || p.in === 'path',
          description: p.description ?? '',
        }));
      extra.push({
        id: `${m}${path}`.replace(/[^A-Za-z0-9]+/g, '-').replace(/-$/, ''),
        method: m.toUpperCase() as Method,
        path: inApi ? path.slice('/api/v1'.length) : path,
        root: inApi ? undefined : true,
        group: 'Other',
        summary: op.summary && !op.summary.startsWith(m.toUpperCase()) ? op.summary : path,
        description: op.description ?? (op.tags?.length ? `Served by ${op.tags.join(', ')}.` : undefined),
        fields,
        body: m === 'post' || m === 'patch' ? () => ({}) : undefined,
        response: 'json',
      });
    }
  }
  return { endpoints: [...catalog, ...extra], served };
}

/** True when the server's document was read and does not list the route. */
export function isMissing(ep: Endpoint, served: Set<string> | undefined): boolean {
  return !!served && !served.has(routeKey(ep.method, serverPath(ep)));
}

/**
 * The id a successful call created, and which group's {id} fields it fills:
 * a job (any route that answers 202 with a Job), or the collection, webhook or
 * key a create route returned.
 */
export function createdId(ep: Endpoint, json: unknown): { group: string; id: string } | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const o = json as Record<string, unknown>;
  if (typeof o.id === 'string' && typeof o.kind === 'string' && typeof o.status === 'string') return { group: 'Jobs', id: o.id };
  if (ep.method !== 'POST') return undefined;
  if (typeof o.id === 'string') return { group: ep.group, id: o.id };
  const nested = (o.collection as Record<string, unknown> | undefined)?.id;
  if (typeof nested === 'string') return { group: 'Collections', id: nested };
  return undefined;
}
