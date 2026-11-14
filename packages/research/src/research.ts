/**
 * research(): answer "what do these videos say about X?" with a few hundred
 * tokens of ranked, cited excerpts instead of whole transcripts.
 *
 *   inputs (1 to 10 URLs; playlists expand) -> contexts (storage is the cache, 3 at a time)
 *   -> 30 s windows every 15 s -> BM25 (+ exact-phrase boost) -> merge near windows
 *   -> excerpts with context -> global token cap
 *
 * Purely lexical: no LLM, no key, no embeddings. When nothing matches, the
 * result says so and lists words the transcripts do use, so the calling agent
 * can retry with a synonym.
 */
import {
  type Attempt,
  attemptsOf,
  estimateTokens,
  expandInput,
  formatTimestamp,
  getVideoContext,
  type Segment,
  segmentsToText,
  type TranscriptMode,
  timestampUrl,
  Vid2ContextError,
  type VideoContext,
  type VideoRef,
} from '@vid2context/core';
import { buildWindows, DEFAULT_WINDOW_SEC, documentFrequency, type ScoredWindow, scoreWindows, type Window } from './bm25.ts';
import { mapLimit, openStorage, type ResearchDeps } from './deps.ts';
import { editDistance, type ParsedQuery, parseQuery, STOP_WORDS, stem, tokenize } from './text.ts';

export const MAX_VIDEOS = 10;
export const DEFAULTS = { contextSec: 20, maxExcerpts: 3, maxTokens: 2000, concurrency: 3 } as const;

export interface ResearchOptions {
  /** Seconds of transcript to include before and after each match. Default 20, 0 to 120. */
  contextSec?: number;
  /** Excerpts per video. Default 3, 1 to 10. */
  maxExcerpts?: number;
  /** Cap on the whole result in estimated tokens. Default 2000, 200 to 20000. */
  maxTokens?: number;
  /** Window length in seconds. Default 30; windows start every half window. */
  windowSec?: number;
  /** Transcript strategy for videos not already saved. Default auto. */
  mode?: TranscriptMode;
  /** Preferred transcript language (BCP-47). */
  language?: string;
  /** Videos fetched at once. Default 3. */
  concurrency?: number;
}

export interface ResearchExcerpt {
  startSec: number;
  endSec: number;
  /** "[m:ss]" of startSec, ready to cite. */
  timestamp: string;
  /** The matched transcript text. */
  text: string;
  /** Transcript text just before and after the match, up to `contextSec` seconds each way. Empty when cut for the token cap. */
  context: { before: string; after: string; fromSec: number; toSec: number };
  /** Opens the video at startSec, when the platform has deep links. */
  url?: string;
  score: number;
  /** Query words found in this excerpt. */
  matched: string[];
}

export interface ResearchVideoResult {
  videoId: string;
  title: string;
  channel?: string;
  url?: string;
  durationSec?: number;
  origin: VideoContext['transcript']['origin'];
  language: string;
  /** Estimated tokens of the whole transcript, for comparison with the excerpts. */
  transcriptTokens: number;
  /** Best first. */
  excerpts: ResearchExcerpt[];
}

export interface ResearchFailure {
  input: string;
  videoId?: string;
  error: string;
  message: string;
  hint?: string;
  attempts: Attempt[];
}

export interface ResearchSuggestions {
  /** Words the transcripts use that look like the query words (other forms, near spellings, auto-caption variants). */
  similar: string[];
  /** The most distinctive words in these transcripts. */
  topics: string[];
}

export interface ResearchResult {
  query: string;
  /** Query words used for ranking (stop words removed). */
  terms: string[];
  /** Quoted phrases that got the exact-phrase boost. */
  phrases: string[];
  /** Videos with at least one excerpt first, best match first. */
  results: ResearchVideoResult[];
  failed: ResearchFailure[];
  /** Estimated tokens of the rendered excerpts. */
  tokens: number;
  /** Estimated tokens of the full transcripts searched. */
  transcriptTokens: number;
  /** True when excerpts or their context were cut to fit maxTokens. */
  truncated: boolean;
  notes: string[];
  /** Present only when nothing matched. */
  suggestions?: ResearchSuggestions;
}

function bad(message: string, hint: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', message, { hint });
}

function checkRange(name: string, v: number | undefined, min: number, max: number, def: number): number {
  if (v === undefined) return def;
  if (!Number.isFinite(v) || v < min || v > max)
    throw bad(`${name} must be between ${min} and ${max}.`, `Pass ${name} from ${min} to ${max}, or leave it out for ${def}.`);
  return v;
}

function errorOf(input: string, err: unknown, videoId?: string): ResearchFailure {
  const e = err instanceof Vid2ContextError ? err : undefined;
  return {
    input,
    ...(videoId ? { videoId } : {}),
    error: e?.code ?? 'error',
    message: err instanceof Error ? err.message : String(err),
    ...(e?.hint ? { hint: e.hint } : {}),
    attempts: attemptsOf(err),
  };
}

/** Resolve inputs to at most MAX_VIDEOS distinct video refs; playlists, channels and feeds expand. */
async function expand(
  inputs: string[],
  deps: ResearchDeps,
  failed: ResearchFailure[],
  notes: string[],
): Promise<{ input: string; ref: VideoRef }[]> {
  const out: { input: string; ref: VideoRef }[] = [];
  const seen = new Set<string>();
  let capped = false;
  for (const input of inputs) {
    if (out.length >= MAX_VIDEOS) {
      capped = true;
      break;
    }
    try {
      const { ref } = deps.registry.resolve(input);
      const refs =
        ref.kind === 'video' ? [ref] : await expandInput(deps.registry, input, deps.ctx, { limit: MAX_VIDEOS - out.length + 1 });
      for (const r of refs) {
        if (seen.has(r.id)) continue;
        if (out.length >= MAX_VIDEOS) {
          capped = true;
          break;
        }
        seen.add(r.id);
        out.push({ input, ref: r });
      }
    } catch (err) {
      failed.push(errorOf(input, err));
    }
  }
  if (capped) notes.push(`Searched the first ${MAX_VIDEOS} videos only; research takes at most ${MAX_VIDEOS} per call.`);
  return out;
}

interface Draft {
  doc: number;
  first: number;
  last: number;
  score: number;
  matched: Set<string>;
}

/**
 * Pick up to `max` excerpts for one video from its scored windows, best first.
 * A window close to an excerpt already picked (its context would repeat that
 * excerpt's text) is merged into it when it scores at least half as well and
 * the result stays under `maxSpan` seconds; otherwise it is skipped.
 */
export function pickExcerpts(
  scored: ScoredWindow[],
  segments: Segment[],
  opts: { max: number; contextSec: number; maxSpan: number },
): Draft[] {
  const drafts: Draft[] = [];
  const startOf = (i: number) => segments[i]?.startSec ?? 0;
  const endOf = (i: number) => segments[i]?.endSec ?? 0;
  const gap = 2 * opts.contextSec;
  for (const sw of scored) {
    const w = sw.window;
    const near = drafts.find((d) => w.startSec <= endOf(d.last) + gap && w.endSec >= startOf(d.first) - gap);
    if (near) {
      const first = Math.min(near.first, w.first);
      const last = Math.max(near.last, w.last);
      if (sw.score >= near.score / 2 && endOf(last) - startOf(first) <= opts.maxSpan) {
        near.first = first;
        near.last = last;
        near.score = Math.max(near.score, sw.score);
        for (const m of sw.matched) near.matched.add(m);
      }
      continue;
    }
    if (drafts.length < opts.max)
      drafts.push({ doc: w.doc, first: w.first, last: w.last, score: sw.score, matched: new Set(sw.matched) });
  }
  return drafts.sort((a, b) => b.score - a.score);
}

/** Turn a draft into an excerpt with its context. */
export function toExcerpt(
  draft: Draft,
  segments: Segment[],
  ref: VideoRef,
  contextSec: number,
  query: ParsedQuery,
): ResearchExcerpt {
  const startSec = segments[draft.first]?.startSec ?? 0;
  const endSec = segments[draft.last]?.endSec ?? startSec;
  const before: Segment[] = [];
  for (let i = draft.first - 1; i >= 0 && contextSec > 0; i--) {
    const s = segments[i];
    if (!s || s.endSec <= startSec - contextSec) break;
    before.unshift(s);
  }
  const after: Segment[] = [];
  for (let i = draft.last + 1; i < segments.length && contextSec > 0; i++) {
    const s = segments[i];
    if (!s || s.startSec >= endSec + contextSec) break;
    after.push(s);
  }
  const url = timestampUrl(ref, startSec);
  return {
    startSec,
    endSec,
    timestamp: `[${formatTimestamp(startSec)}]`,
    text: segmentsToText(segments.slice(draft.first, draft.last + 1)),
    context: {
      before: segmentsToText(before),
      after: segmentsToText(after),
      fromSec: before[0]?.startSec ?? startSec,
      toSec: after.at(-1)?.endSec ?? endSec,
    },
    ...(url ? { url } : {}),
    score: Math.round(draft.score * 1000) / 1000,
    matched: query.terms.filter((t) => draft.matched.has(t)).map((t) => query.display.get(t) ?? t),
  };
}

/** Words the transcripts use that resemble the query words, and the transcripts' most distinctive words. */
export function suggest(query: ParsedQuery, windows: Window[], contexts: VideoContext[]): ResearchSuggestions {
  const surface = new Map<string, Map<string, number>>();
  const count = new Map<string, number>();
  for (const c of contexts) {
    for (const seg of c.transcript.segments) {
      for (const word of tokenize(seg.text)) {
        if (word.length < 3 || STOP_WORDS.has(word)) continue;
        const s = stem(word);
        count.set(s, (count.get(s) ?? 0) + 1);
        const forms = surface.get(s) ?? new Map<string, number>();
        forms.set(word, (forms.get(word) ?? 0) + 1);
        surface.set(s, forms);
      }
    }
  }
  const wordOf = (s: string): string => {
    const forms = [...(surface.get(s) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]);
    return forms[0]?.[0] ?? s;
  };
  const queryStems = new Set(query.terms);
  const similar = [...count.keys()]
    .filter((s) => !queryStems.has(s))
    .filter((s) =>
      query.terms.some((q) => {
        if (q.length < 3) return false;
        if (q.length >= 5 && s.length >= 5 && s.slice(0, 4) === q.slice(0, 4)) return true;
        if (s.length >= 4 && (q.startsWith(s) || s.startsWith(q))) return true;
        return editDistance(s, q, q.length >= 6 ? 2 : 1) <= (q.length >= 6 ? 2 : 1);
      }),
    )
    .sort((a, b) => (count.get(b) ?? 0) - (count.get(a) ?? 0))
    .slice(0, 8)
    .map(wordOf);

  const df = documentFrequency(windows);
  const n = windows.length || 1;
  const topics = [...count.entries()]
    .filter(([s]) => s.length >= 3)
    .map(([s, c]) => ({ s, w: c * Math.log(1 + n / (df.get(s) ?? 1)) }))
    .sort((a, b) => b.w - a.w)
    .slice(0, 12)
    .map((x) => wordOf(x.s));
  return { similar, topics };
}

function excerptLine(e: ResearchExcerpt): string {
  const cite = e.url ? `[${formatTimestamp(e.startSec)}](${e.url})` : e.timestamp;
  const before = e.context.before ? `...${e.context.before} ` : '';
  const after = e.context.after ? ` ${e.context.after}...` : '';
  return `${cite} (${formatTimestamp(e.startSec)} to ${formatTimestamp(e.endSec)}, matched: ${e.matched.join(', ')})\n${before}**${e.text}**${after}\n`;
}

function videoHeader(v: ResearchVideoResult): string {
  return `## ${v.title}${v.channel ? ` (${v.channel})` : ''}\n${v.url ?? v.videoId}\n`;
}

/** Render a result as compact Markdown for an agent: one block per video, matches in bold, every excerpt cited. */
export function renderResearch(r: ResearchResult): string {
  const total = r.results.reduce((n, v) => n + v.excerpts.length, 0);
  const lines: string[] = [
    `Research: "${r.query}" in ${r.results.length} video${r.results.length === 1 ? '' : 's'}: ${total} excerpt${total === 1 ? '' : 's'}, about ${r.tokens} tokens (the full transcripts are about ${r.transcriptTokens} tokens).`,
  ];
  for (const note of r.notes) lines.push(`Note: ${note}`);
  if (r.suggestions) {
    if (r.suggestions.similar.length > 0) lines.push(`Similar words these transcripts use: ${r.suggestions.similar.join(', ')}.`);
    lines.push(`Frequent topic words: ${r.suggestions.topics.join(', ')}.`);
  }
  lines.push('');
  for (const v of r.results) {
    lines.push(videoHeader(v));
    if (v.excerpts.length === 0) lines.push('No matching excerpt.\n');
    for (const e of v.excerpts) lines.push(excerptLine(e));
  }
  for (const f of r.failed) lines.push(`Failed: ${f.input}: ${f.error}: ${f.message}${f.hint ? ` (${f.hint})` : ''}`);
  return `${lines.join('\n').trim()}\n`;
}

/** Search 1 to 10 videos for `query` and return ranked excerpts with context and timestamp links. */
export async function research(
  inputs: string[],
  query: string,
  opts: ResearchOptions,
  deps: ResearchDeps,
): Promise<ResearchResult> {
  const list = inputs.map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) throw bad('No video to research.', 'Pass 1 to 10 video URLs, or a playlist URL.');
  if (list.length > MAX_VIDEOS)
    throw bad(
      `Too many inputs (${list.length}).`,
      `Pass at most ${MAX_VIDEOS} URLs per call and split the rest into more calls.`,
    );
  const q = query.trim();
  if (!q) throw bad('The query is empty.', 'Pass the words to look for, for example "timing chain".');
  const parsed = parseQuery(q);
  if (parsed.terms.length === 0) {
    throw bad(
      `The query "${q}" has only common words.`,
      'Use the distinctive words you expect the speaker to say, for example a model name or a part.',
    );
  }
  const contextSec = checkRange('contextSec', opts.contextSec, 0, 120, DEFAULTS.contextSec);
  const maxExcerpts = Math.floor(checkRange('maxExcerpts', opts.maxExcerpts, 1, 10, DEFAULTS.maxExcerpts));
  const maxTokens = Math.floor(checkRange('maxTokens', opts.maxTokens, 200, 20_000, DEFAULTS.maxTokens));
  const windowSec = checkRange('windowSec', opts.windowSec, 10, 120, DEFAULT_WINDOW_SEC);

  const failed: ResearchFailure[] = [];
  const notes: string[] = [];
  const refs = await expand(list, deps, failed, notes);
  if (refs.length === 0) {
    const first = failed[0];
    if (failed.length === 1 && first) {
      throw Object.assign(new Vid2ContextError(first.error as Vid2ContextError['code'], first.message, { hint: first.hint }), {
        attempts: first.attempts,
      });
    }
    throw bad('None of the inputs gave a video to research.', failed.map((f) => `${f.input}: ${f.hint ?? f.message}`).join(' '));
  }

  const storage = await openStorage(deps);
  const fetched = await mapLimit(refs, opts.concurrency ?? DEFAULTS.concurrency, async ({ input, ref }) => {
    try {
      return await getVideoContext(
        deps.registry,
        ref.url ?? ref.input,
        { storage, mode: opts.mode, language: opts.language },
        deps.ctx,
      );
    } catch (err) {
      failed.push(errorOf(input, err, ref.id));
      return null;
    }
  });
  const contexts = fetched.filter((c): c is VideoContext => c !== null);
  if (contexts.length === 0) {
    const first = refs.length === 1 ? failed.at(-1) : undefined;
    if (first) {
      throw Object.assign(new Vid2ContextError(first.error as Vid2ContextError['code'], first.message, { hint: first.hint }), {
        attempts: first.attempts,
      });
    }
    throw Object.assign(
      new Vid2ContextError('no-transcript', `Could not get a transcript for any of the ${refs.length} videos.`, {
        hint: 'See `attempts` for why each failed; retry later or with fewer videos.',
      }),
      { attempts: failed.flatMap((f) => f.attempts) },
    );
  }

  const windows = contexts.flatMap((c, doc) => buildWindows(c.transcript.segments, doc, { windowSec }));
  const scored = scoreWindows(windows, parsed);
  if (parsed.phrases.length > 0 && scored.length > 0 && !scored.some((s) => s.phrases > 0)) {
    notes.push(
      `The exact phrase ${parsed.phraseText.map((p) => `"${p}"`).join(', ')} was not found; these excerpts match its words.`,
    );
  }

  const results: (ResearchVideoResult & { best: number; drafts: Draft[]; source: VideoContext })[] = contexts.map((c, doc) => {
    const drafts = pickExcerpts(
      scored.filter((s) => s.window.doc === doc),
      c.transcript.segments,
      { max: maxExcerpts, contextSec, maxSpan: 2 * windowSec },
    );
    return {
      videoId: c.metadata.ref.id,
      title: c.metadata.title,
      ...(c.metadata.channel?.name ? { channel: c.metadata.channel.name } : {}),
      ...(c.metadata.ref.url ? { url: c.metadata.ref.url } : {}),
      ...(c.metadata.durationSec ? { durationSec: c.metadata.durationSec } : {}),
      origin: c.transcript.origin,
      language: c.transcript.language,
      transcriptTokens: estimateTokens(segmentsToText(c.transcript.segments)),
      excerpts: [],
      best: drafts[0]?.score ?? 0,
      drafts,
      source: c,
    };
  });

  // Global token cap: best excerpts first across all videos; drop context before dropping an excerpt.
  const all = results
    .flatMap((v) =>
      v.drafts.map((d) => ({
        v,
        excerpt: toExcerpt(d, v.source.transcript.segments, v.source.metadata.ref, contextSec, parsed),
      })),
    )
    .sort((a, b) => b.excerpt.score - a.excerpt.score);
  let used = 60; // the summary line
  let cut = 0;
  let trimmed = 0;
  const headed = new Set<string>();
  for (const { v, excerpt } of all) {
    const head = headed.has(v.videoId) ? 0 : estimateTokens(videoHeader(v));
    const full = estimateTokens(excerptLine(excerpt)) + head;
    const bare = { ...excerpt, context: { before: '', after: '', fromSec: excerpt.startSec, toSec: excerpt.endSec } };
    const bareCost = estimateTokens(excerptLine(bare)) + head;
    if (used + full <= maxTokens) {
      v.excerpts.push(excerpt);
      used += full;
    } else if (used + bareCost <= maxTokens) {
      v.excerpts.push(bare);
      used += bareCost;
      trimmed++;
    } else {
      cut++;
      continue;
    }
    headed.add(v.videoId);
  }
  if (cut > 0 || trimmed > 0) {
    const parts = [
      cut > 0 ? `cut ${cut} lower-ranked excerpt${cut === 1 ? '' : 's'}` : '',
      trimmed > 0 ? `dropped the context of ${trimmed}` : '',
    ];
    notes.push(
      `To stay under ${maxTokens} tokens, ${parts.filter(Boolean).join(' and ')}. Raise maxTokens, or lower contextSec or maxExcerpts.`,
    );
  }

  const ordered = results
    .map((v, i) => ({ v, i }))
    .sort((a, b) => Number(b.v.excerpts.length > 0) - Number(a.v.excerpts.length > 0) || b.v.best - a.v.best || a.i - b.i)
    .map(({ v }) => {
      const { best: _best, drafts: _drafts, source: _source, ...rest } = v;
      return rest;
    });

  const result: ResearchResult = {
    query: q,
    terms: parsed.terms.map((t) => parsed.display.get(t) ?? t),
    phrases: parsed.phraseText,
    results: ordered,
    failed,
    tokens: 0,
    transcriptTokens: ordered.reduce((n, v) => n + v.transcriptTokens, 0),
    truncated: cut > 0 || trimmed > 0,
    notes,
  };
  if (scored.length === 0) {
    result.suggestions = suggest(parsed, windows, contexts);
    notes.unshift(
      `No excerpt in ${contexts.length === 1 ? 'this video' : `these ${contexts.length} videos`} contains ${parsed.terms.map((t) => `"${parsed.display.get(t) ?? t}"`).join(' or ')}. ` +
        'The search is lexical (only words actually spoken match), so try synonyms, related words or other spellings; the lists below show words these transcripts do use.',
    );
  }
  result.tokens = estimateTokens(renderResearch(result));
  return result;
}
