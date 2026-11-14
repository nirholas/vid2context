/**
 * Token-aware chunking, outlines, sections and budget planning. Surfaces use
 * these to show "this video has these sections and costs this many tokens",
 * fetch exactly one section, and fit many videos into one context window.
 */
export { type BudgetItem, type BudgetOptions, type BudgetPlan, type BudgetRange, fitToBudget } from './budget.ts';
export { type ChunkOptions, chunkTranscript, type TranscriptChunk } from './chunk.ts';
export { type ApiOutline, type OutlineSection, outlineForApi, type TranscriptOutline, transcriptOutline } from './outline.ts';
export { getSection, parseTimeArg, type SectionInfo, type SectionSelector } from './section.ts';
