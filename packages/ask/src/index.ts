/**
 * @vid2context/ask: answers over videos with verified timestamp citations.
 *
 *   ask()          one question, one result: answer, citations, sources, rung
 *   askStream()    the same as events: meta, reasoning, delta, done or error
 *   prepareAsk() + streamAnswer()  the two halves, for servers that must fail before streaming starts
 *   defaultRetriever  whole transcripts when they fit, else keyword + vector search fused with RRF
 *
 * Runtime-neutral: Node, Workers and the browser. HTTP routes come from
 * ./http.ts (askRoutes) and the MCP tool from ./mcp.ts (registerAskTools).
 */

export { chunkByTime, MAX_CHUNK_SEC, TARGET_CHUNK_SEC, type TimeChunk } from './chunk.ts';
export { buildCitations, CitationFilter, type Rewritten, rewriteCitations } from './cite.ts';
export { ask, askStream, firstRung, LIMITS, type PreparedAsk, prepareAsk, streamAnswer } from './engine.ts';
export { ANSWER_SYSTEM_PROMPT, answerMessages, CONDENSE_SYSTEM_PROMPT, condenseMessages } from './prompt.ts';
export { defaultRetriever, fuseRankings, keywords, toSources } from './retrieve.ts';
export type { ModelChoice } from '@vid2context/core';
export type {
  AskEvent,
  AskOptions,
  AskResult,
  Citation,
  HistoryMessage,
  RetrievalScope,
  Retriever,
  Source,
  SourceRef,
  Usage,
} from './types.ts';
