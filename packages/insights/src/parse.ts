/**
 * Request validation shared by the HTTP routes, the job handlers and the MCP
 * tools, so every surface accepts the same bodies and fails the same way.
 *
 *   POST /briefs   { collectionId?, inputs?: string[], question?, template? }
 *   POST /extract  { inputs?: string[], collectionId?, template?, schema?, question? }
 */
import { Vid2ContextError } from '@vid2context/core';
import { MAX_VIDEOS } from './load.ts';
import { assertSupportedSchema, type JsonSchema } from './schema.ts';
import { getTemplate } from './templates/index.ts';

export interface BriefRequest {
  inputs?: string[];
  collectionId?: string;
  question?: string;
  template?: string;
}

export interface ExtractRequest {
  inputs?: string[];
  collectionId?: string;
  template?: string;
  schema?: JsonSchema;
  question?: string;
}

function bad(message: string, hint: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', message, { hint });
}

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw bad('The body must be a JSON object.', 'Send {"inputs": ["<video URL>"], ...} with Content-Type: application/json.');
  }
  return body as Record<string, unknown>;
}

function optString(b: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = b[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw bad(`${key} must be a string.`, `Send ${key} as text, or leave it out.`);
  if (v.length > max) throw bad(`${key} is longer than ${max} characters.`, `Shorten ${key}.`);
  return v.trim();
}

function sources(b: Record<string, unknown>): { inputs?: string[]; collectionId?: string } {
  const inputs = b.inputs ?? b.urls;
  if (inputs !== undefined && (!Array.isArray(inputs) || inputs.some((u) => typeof u !== 'string'))) {
    throw bad('inputs must be an array of strings.', 'Send video URLs or ids as "inputs": ["https://youtu.be/..."].');
  }
  const list = (inputs as string[] | undefined)?.map((s) => s.trim()).filter(Boolean);
  if (list && list.length > MAX_VIDEOS) throw bad(`At most ${MAX_VIDEOS} inputs per request.`, 'Split the videos into several requests.');
  const collectionId = optString(b, 'collectionId', 200) ?? optString(b, 'collection', 200);
  if ((!list || list.length === 0) && !collectionId) {
    throw bad('Nothing to read: send inputs or a collectionId.', 'Send {"inputs": ["<video URL>", ...]} or {"collectionId": "<id>"}.');
  }
  return { ...(list && list.length > 0 ? { inputs: list } : {}), ...(collectionId ? { collectionId } : {}) };
}

export function parseBriefRequest(body: unknown): BriefRequest {
  const b = asObject(body);
  const template = optString(b, 'template', 64);
  if (template) getTemplate(template);
  const question = optString(b, 'question', 2000);
  return { ...sources(b), ...(question ? { question } : {}), ...(template ? { template } : {}) };
}

export function parseExtractRequest(body: unknown): ExtractRequest {
  const b = asObject(body);
  const template = optString(b, 'template', 64);
  const schema = b.schema;
  if (template && schema !== undefined && schema !== null) {
    throw bad('Send either template or schema, not both.', 'Use a template id, or a custom JSON Schema as "schema".');
  }
  if (template) getTemplate(template);
  if (schema !== undefined && schema !== null) assertSupportedSchema(schema);
  const question = optString(b, 'question', 2000);
  return {
    ...sources(b),
    ...(template ? { template } : {}),
    ...(schema !== undefined && schema !== null ? { schema: schema as JsonSchema } : {}),
    ...(question ? { question } : {}),
  };
}
