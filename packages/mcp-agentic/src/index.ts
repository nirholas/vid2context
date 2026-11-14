/**
 * @vid2context/mcp-agentic: the MCP features that let the server work with
 * the client instead of only answering it.
 *
 *   sampling       digest_videos: the client's own model writes a cited digest (no server key)
 *   elicitation    choose_caption_track, confirmExpensive: ask the user mid-call
 *   completions    prompt `digest` arguments complete collection ids and saved videos
 *   subscriptions  vid2context://collection/{id}/latest, updated through notifyCollectionUpdated
 *
 * Mount with `registerAgenticFeatures(server, { registry, ctx, storage? })`
 * before `server.connect(transport)`.
 */
export {
  chunkTranscript,
  DEFAULT_MAX_TOKENS_PER_CHUNK,
  MIN_TOKENS_PER_CHUNK,
  type TranscriptChunk,
  videoDuration,
} from './chunking.ts';
export {
  type CheckOptions,
  type CitationSource,
  checkDigest,
  checkNotes,
  checkTimestamp,
  DEFAULT_TOLERANCE_SEC,
  type DigestCheck,
  type DroppedClaim,
  invalidCitations,
  type NotesCheck,
  parseTimestamp,
  sourceOf,
} from './citations.ts';
export { completeCollections, completeListItem, completeVideos, MAX_COMPLETIONS } from './completions.ts';
export {
  buildChunkPlan,
  DEFAULT_CONCURRENCY,
  type DigestArgs,
  digestInputSchema,
  runDigest,
  SAMPLING_TIMEOUT_MS,
} from './digest.ts';
export {
  chooseCaptionTrack,
  confirmExpensive,
  confirmThresholdMinutes,
  DEFAULT_CONFIRM_STT_MINUTES,
  type TrackOption,
  trackOptions,
} from './elicitation.ts';
export { MAX_VIDEOS, resolveSources } from './inputs.ts';
export {
  MAP_MAX_TOKENS,
  MAP_MODEL_PREFERENCES,
  MAP_SYSTEM,
  REDUCE_MAX_TOKENS,
  REDUCE_MODEL_PREFERENCES,
  REDUCE_SYSTEM,
} from './prompts.ts';
export { LATEST_LIMIT, registerAgenticFeatures } from './register.ts';
export { type AgenticDeps, clientSupportsElicitation, clientSupportsSampling } from './shared.ts';
export {
  collectionLatestUri,
  collectionUri,
  enableSubscriptions,
  notifyCollectionUpdated,
  notifyResourceUpdated,
  subscribedUris,
} from './subscriptions.ts';
