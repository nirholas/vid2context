/**
 * @vid2context/insights: cited briefs and structured extraction over one or
 * many VideoContexts.
 *
 * - Agent-side (default, free): briefPrompt() and extractPrompt() return
 *   messages the calling agent follows; briefInstructions() and
 *   buyerGuideInstructions() are the text behind the MCP prompts.
 * - Server-side: buildBrief() and extract() run the core LLM chain (free
 *   first), single pass or map-reduce, and verify every citation.
 * - verifyCitations() checks quotes against transcripts near their timestamps.
 * - insightsRoutes (./http) and registerInsightsTools (./mcp) are the surfaces.
 */
export { buildBrief, classify, type InsightsDeps } from './brief.ts';
export { type ExtractOptions, extract, verifyExtraction } from './extract.ts';
export { BRIEF_JOB, briefJob, EXTRACT_JOB, extractJob, registerInsightsJobs } from './jobs.ts';
export { MAX_CHUNK_TOKENS, parseJsonObject, sourceBudget } from './llm.ts';
export { type LoadDeps, type LoadRequest, loadContexts, MAX_VIDEOS, type StorageSource } from './load.ts';
export { citeMd, escapeMd, renderBrief } from './markdown.ts';
export { type BriefRequest, type ExtractRequest, parseBriefRequest, parseExtractRequest } from './parse.ts';
export {
  AGREEMENT_RULES,
  briefInstructions,
  briefPrompt,
  buyerGuideInstructions,
  CITATION_RULE,
  EXTRACT_CITATION_RULE,
  extractionSchema,
  extractPrompt,
  MAP_SCHEMA,
  REDUCE_SCHEMA,
  SINGLE_SCHEMA,
} from './prompts.ts';
export { assertSupportedSchema, type JsonSchema, SUPPORTED_KEYWORDS, validate } from './schema.ts';
export { sourceSet, summarizeSource } from './sources.ts';
export { CITE_SCHEMA, getTemplate, type Template, templates } from './templates/index.ts';
export { normalize, parseSeconds, topicKey } from './text.ts';
export type * from './types.ts';
export { MIN_QUOTE_TOKENS, THRESHOLD, verifyCitations, verifyQuote, WINDOW_SEC } from './verify.ts';
