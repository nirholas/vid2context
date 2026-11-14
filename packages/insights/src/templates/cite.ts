import type { JsonSchema } from '../schema.ts';

/**
 * A citation as models write it inside extraction results. `videoId` is the
 * source label (V1, V2, ...) or id; `startSec` the number in brackets of the
 * line where the quote starts; `quote` words copied from that line. After
 * verification each one is replaced with a full Citation (title, snapped
 * startSec, endSec, timestamp url, quote) or removed and listed as unverified.
 */
export const CITE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    videoId: { type: 'string', description: 'Source label, for example V1' },
    startSec: { type: ['number', 'string'], description: 'Seconds from the [n] at the start of the quoted line' },
    quote: { type: 'string', description: '8 to 30 words copied exactly from the transcript' },
  },
  required: ['videoId', 'startSec', 'quote'],
  additionalProperties: false,
};

/** One or more citations backing an item. */
export const SOURCES: JsonSchema = { type: 'array', minItems: 1, items: CITE_SCHEMA };

/** An object schema whose properties are all listed in `required` except those in `optional`. */
export function obj(properties: Record<string, JsonSchema>, optional: string[] = []): JsonSchema {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties).filter((k) => !optional.includes(k)),
    additionalProperties: false,
  };
}

export const str = (description: string): JsonSchema => ({ type: 'string', description });
export const list = (items: JsonSchema, description?: string): JsonSchema => ({
  type: 'array',
  items,
  ...(description ? { description } : {}),
});
