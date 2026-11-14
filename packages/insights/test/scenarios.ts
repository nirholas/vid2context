/**
 * The recorded scenarios: which fixtures and options each recording used.
 * The recording script and the replay tests share this, so a replay runs
 * exactly the code path that was recorded.
 */
import type { BriefOptions, ExtractOptions, JsonSchema } from '../src/index.ts';

export const QUESTION = 'Which G-Wagon should I buy: model, year range and mileage, and what should I check before buying?';

/** Short strings and few items: a schema real models often break on the first try. */
export const REPAIR_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    bestYears: { type: 'array', maxItems: 2, items: { type: 'string', pattern: '^\\d{4}-\\d{4}$' } },
    problems: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        properties: { name: { type: 'string', maxLength: 10 }, fixCost: { type: 'string', pattern: '^\\$' } },
        required: ['name', 'fixCost'],
        additionalProperties: false,
      },
    },
  },
  required: ['bestYears', 'problems'],
  additionalProperties: false,
};

type Scenario =
  | { kind: 'brief'; videos: number[]; options: BriefOptions }
  | { kind: 'extract'; videos: number[]; options: ExtractOptions };

export const SCENARIOS = {
  'brief-single': { kind: 'brief', videos: [0, 1, 2, 3], options: { question: QUESTION, template: 'buyer-guide' } },
  'brief-map-reduce': {
    kind: 'brief',
    videos: [0, 2],
    options: { question: QUESTION, template: 'buyer-guide', maxChunkTokens: 2500 },
  },
  'extract-buyer': { kind: 'extract', videos: [0, 1, 2, 3], options: { template: 'buyer-guide', question: QUESTION } },
  'extract-repair': {
    kind: 'extract',
    videos: [0],
    options: { schema: REPAIR_SCHEMA, question: 'Best years and the three most common problems.' },
  },
} satisfies Record<string, Scenario>;
