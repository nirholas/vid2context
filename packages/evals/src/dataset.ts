/**
 * Dataset files under packages/evals/datasets/. Each lists real public videos
 * with the ground truth its suite needs, plus why each video was chosen and
 * its license or terms. Loading validates the shape so a typo fails with a
 * clear message instead of a confusing score.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vid2ContextError } from '@vid2context/core';

export interface VideoItem {
  /** Short stable slug used in reports, e.g. 'ted-ed-bridge-riddle'. */
  id: string;
  url: string;
  title: string;
  channel: string;
  /** BCP-47 language spoken in the video and of the reference captions. */
  language: string;
  durationSec: number;
  /** Why this video is in the set: accent, music, jargon, length. */
  why: string;
  tags: string[];
  /** License or terms note. */
  license: string;
  /** Where the reference transcript comes from. */
  reference: 'creator-captions';
}

export interface Dataset<T> {
  suite: string;
  description: string;
  items: T[];
}

export interface CitationQuestion {
  id: string;
  question: string;
  /** Places in the collection that answer it; a cited answer should point near one of them. */
  expected: { videoId: string; startSec: number; endSec: number; quote: string }[];
}

export interface CitationsDataset {
  suite: 'citations';
  description: string;
  /** Video ids (`platform:nativeId`) of the collection, each with a recorded transcript file. */
  collection: { videoId: string; url: string; transcript: string }[];
  questions: CitationQuestion[];
}

export interface SearchQuery {
  id: string;
  query: string;
  note: string;
  expected: { videoId: string; startSec: number; endSec: number }[];
}

export interface SearchDataset {
  suite: 'search';
  description: string;
  collection: { videoId: string; url: string; transcript: string }[];
  queries: SearchQuery[];
}

export const DATASETS_DIR = fileURLToPath(new URL('../datasets/', import.meta.url));

function bad(file: string, msg: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', `Dataset ${file}: ${msg}`, {
    hint: 'Fix the entry so it matches the shape documented in docs/evals.md ("Adding a dataset entry").',
  });
}

function readJson(file: string, dir: string): unknown {
  try {
    return JSON.parse(readFileSync(join(dir, file), 'utf8'));
  } catch (err) {
    throw bad(file, `cannot be read as JSON (${(err as Error).message})`);
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Validate one video item; returns a list of problems (empty when valid). */
export function videoItemProblems(v: unknown): string[] {
  const o = (v ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  for (const k of ['id', 'url', 'title', 'channel', 'language', 'why', 'license']) if (!isStr(o[k])) problems.push(`${k} missing`);
  if (typeof o.durationSec !== 'number' || o.durationSec <= 0) problems.push('durationSec must be a positive number');
  if (!Array.isArray(o.tags)) problems.push('tags must be an array');
  if (o.reference !== 'creator-captions') problems.push('reference must be "creator-captions"');
  return problems;
}

export function loadVideoDataset(file: string, dir = DATASETS_DIR): Dataset<VideoItem> {
  const data = readJson(file, dir) as Dataset<unknown>;
  if (!data || !Array.isArray(data.items)) throw bad(file, 'has no "items" array');
  const ids = new Set<string>();
  data.items.forEach((item, i) => {
    const problems = videoItemProblems(item);
    if (problems.length > 0) throw bad(file, `item ${i}: ${problems.join(', ')}`);
    const id = (item as VideoItem).id;
    if (ids.has(id)) throw bad(file, `duplicate id "${id}"`);
    ids.add(id);
  });
  return data as Dataset<VideoItem>;
}

export function loadCitationsDataset(file = 'citations.json', dir = DATASETS_DIR): CitationsDataset {
  const data = readJson(file, dir) as CitationsDataset;
  if (!Array.isArray(data?.collection) || !Array.isArray(data?.questions)) throw bad(file, 'needs "collection" and "questions"');
  for (const q of data.questions) {
    if (!isStr(q.id) || !isStr(q.question) || !Array.isArray(q.expected) || q.expected.length === 0) {
      throw bad(file, `question ${q.id ?? '?'} needs id, question and at least one expected place`);
    }
  }
  return data;
}

export function loadSearchDataset(file = 'search.json', dir = DATASETS_DIR): SearchDataset {
  const data = readJson(file, dir) as SearchDataset;
  if (!Array.isArray(data?.collection) || !Array.isArray(data?.queries)) throw bad(file, 'needs "collection" and "queries"');
  for (const q of data.queries) {
    if (!isStr(q.id) || !isStr(q.query) || !Array.isArray(q.expected) || q.expected.length === 0) {
      throw bad(file, `query ${q.id ?? '?'} needs id, query and at least one expected range`);
    }
  }
  return data;
}
