/**
 * @vid2context/research: three tools that let an agent ask about videos
 * without reading whole transcripts.
 *
 *   research()             ranked, cited excerpts across 1 to 10 videos (BM25, no LLM)
 *   listCaptionLanguages() caption tracks and YouTube translation targets
 *   keyMoments()           LLM-picked moments, every timestamp checked against real segments
 *
 * Runtime-neutral: Node, Workers and the browser. MCP tools come from
 * ./mcp.ts (registerResearchTools) and HTTP routes from ./http.ts
 * (researchRoutes).
 */
export { buildWindows, scoreWindows } from './bm25.ts';
export type { ResearchDeps, StorageSource } from './deps.ts';
export {
  type CaptionLanguages,
  fetchYouTubePlayer,
  listCaptionLanguages,
  readTranslationLanguages,
  sharePlayerRequests,
  type TranslationTarget,
} from './languages.ts';
export {
  type DroppedMoment,
  type KeyMoment,
  type KeyMomentsOptions,
  type KeyMomentsResult,
  keyMoments,
  renderKeyMoments,
  validateMoments,
} from './moments.ts';
export {
  DEFAULTS,
  MAX_VIDEOS,
  type ResearchExcerpt,
  type ResearchFailure,
  type ResearchOptions,
  type ResearchResult,
  type ResearchSuggestions,
  type ResearchVideoResult,
  renderResearch,
  research,
} from './research.ts';
export { parseQuery, stem, terms, tokenize } from './text.ts';
