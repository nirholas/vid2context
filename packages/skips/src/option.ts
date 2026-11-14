/**
 * The `skip=` transcript option, shared by every surface: item 46 honours
 * `GET /transcript?...&skip=sponsor,selfpromo` with one call.
 */
import type { Ctx, Transcript } from '@vid2context/core';
import { applySkips } from './apply.ts';
import { defaultCategories, getSkipSegments, parseCategories, type SkipCategory, sponsorBlockEnabled } from './sponsorblock.ts';

/** Header a surface can set on responses that used SponsorBlock data. */
export const ATTRIBUTION_HEADER = 'x-data-attribution';

/**
 * Read a `skip` value: empty, "0", "false", "no" or "none" mean no skipping
 * (undefined); "1", "true", "yes" or "default" mean the default categories;
 * anything else is a comma-separated category list (unknown names throw
 * `bad-request`).
 */
export function readSkipValue(skip: string | undefined, ctx: Ctx): SkipCategory[] | undefined {
  const v = (skip ?? '').trim().toLowerCase();
  if (!v || v === '0' || v === 'false' || v === 'no' || v === 'none') return undefined;
  if (v === '1' || v === 'true' || v === 'yes' || v === 'default') return defaultCategories(ctx);
  return parseCategories(v);
}

/**
 * Apply a `skip=` option to a transcript. Returns the input unchanged when
 * `skip` is empty, when lookups are off, and when SponsorBlock fails (logged
 * as a warning: skipping ads never blocks a transcript). Otherwise returns a
 * new layer without the overlapping lines, producer "<original>+skips"; the
 * input object, and so the stored raw transcript, is never changed.
 *
 *   const transcript = await skipQueryOption(context.transcript, ctx, c.req.query('skip') ?? '');
 *
 * When the producer ends in "+skips", SponsorBlock data was used: show
 * SPONSORBLOCK_ATTRIBUTION (for example in the ATTRIBUTION_HEADER header).
 */
export async function skipQueryOption(transcript: Transcript, ctx: Ctx, skip: string): Promise<Transcript> {
  const categories = readSkipValue(skip, ctx);
  if (!categories || !sponsorBlockEnabled(ctx)) return transcript;
  try {
    const lookup = await getSkipSegments(transcript.ref, ctx, { categories });
    if (!lookup.looked) return transcript;
    return applySkips(transcript, lookup.segments).transcript;
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    ctx.log.warn('SponsorBlock lookup failed; returning the transcript without skips', {
      video: transcript.ref.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return transcript;
  }
}
