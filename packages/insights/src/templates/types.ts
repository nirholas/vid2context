import type { JsonSchema } from '../schema.ts';

export interface Template {
  /** Stable id used by the API, MCP and CLI: 'brief', 'buyer-guide', ... */
  id: string;
  title: string;
  description: string;
  /** Topic labels the map step should prefer, in the order the brief shows them. */
  topics: string[];
  /** Markdown prompt text: what to look for and how to organize it. */
  instructions: string;
  /** JSON Schema of the structured extraction (within the supported subset; see schema.ts). */
  schema: JsonSchema;
}
