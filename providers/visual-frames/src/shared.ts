/** Exports shared by every entry of the package (runtime-neutral). */

export {
  dHash,
  type GrayImage,
  grayFromRgba,
  hammingDistance,
  resizeGray,
  sharpness,
  THUMB_HEIGHT,
  THUMB_WIDTH,
} from './hash.ts';
export { createVisualProvider, type RungFactory, visualRungs } from './provider.ts';
export {
  DEFAULT_HASH_THRESHOLD,
  type DistinctFrame,
  dedupeFrames,
  MERGE_SIMILARITY,
  mergeNotes,
  normalizeText,
  type SampledFrame,
  selectBudget,
  textSimilarity,
} from './select.ts';
export { resetThrottle, throttleRemainingMs } from './throttle.ts';
export {
  answerText,
  buildVisionBody,
  clock,
  dataUrl,
  type Frame,
  GEMINI_CHAT_URL,
  LANES,
  mapKind,
  notesFromReply,
  OVH_CHAT_URL,
  PROVIDER_ID,
  parseJsonObject,
  VISION_PROMPT,
  visionRungs,
} from './vision.ts';
