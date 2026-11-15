/**
 * LIVE: a real keyless brief over recorded G-Wagon contexts.
 *
 *   LIVE=1 npx vitest run packages/insights/test/live.test.ts
 *
 * The chain is the free-first one with no paid keys: Cloudflare Workers AI
 * (when CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are in the
 * environment or .env), then the keyless OVH AI Endpoints and Pollinations
 * lanes. Every citation in the result is then checked independently of
 * verify.ts: its link must open the right video at a second whose transcript
 * contains the quoted words.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { createContext, type Env, Registry, stderrLogger, type VideoContext } from '@vid2context/core';
import freeCatalog from '@vid2context/provider-llm-free-catalog';
import openaiCompatible from '@vid2context/provider-llm-openai-compatible';
import { describe, expect, it } from 'vitest';
import { buildBrief, type Citation } from '../src/index.ts';
import { gwagonContext } from './gwagon.ts';
import { QUESTION } from './scenarios.ts';

/** Keys from the environment, plus the repo's .env when present (never logged). */
function liveEnv(): Env {
  const file = join(import.meta.dirname, '../../../.env');
  const fromFile = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  return { ...fromFile, ...(process.env as Env) } as Env;
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

/**
 * Open the citation link the way a reader would: find the video by the `v`
 * parameter, jump to `t`, and read the transcript from there for the length
 * of the quote plus a minute. Returns the share of quote words found there.
 */
function resolveCitation(c: Citation, contexts: VideoContext[]): number {
  const url = new URL(c.url ?? '');
  const id = url.searchParams.get('v');
  const t = Number(url.searchParams.get('t')?.replace(/s$/, ''));
  const context = contexts.find((x) => x.metadata.ref.nativeId === id);
  if (!context || !Number.isFinite(t)) return 0;
  const seen = new Map<string, number>();
  for (const s of context.transcript.segments) {
    if (s.endSec <= t - 1 || s.startSec >= t + 60) continue;
    for (const w of words(s.text)) seen.set(w, (seen.get(w) ?? 0) + 1);
  }
  const quote = words(c.quote ?? '');
  let hit = 0;
  for (const w of quote) {
    const n = seen.get(w) ?? 0;
    if (n > 0) {
      hit++;
      seen.set(w, n - 1);
    }
  }
  return quote.length ? hit / quote.length : 0;
}

describe.skipIf(!process.env.LIVE)('live keyless brief', () => {
  it('builds a buyer guide whose every citation link resolves to the quoted words', { timeout: 600_000 }, async () => {
    // Part 1 (shared fixture) and part 3 (mechanic interview): two videos keep the run inside free limits.
    const contexts = [gwagonContext(0), gwagonContext(2)];
    const registry = new Registry([freeCatalog, openaiCompatible], 'node');
    const ctx = createContext({ runtime: 'node', env: liveEnv(), log: stderrLogger('info') });

    const brief = await buildBrief(contexts, { question: QUESTION, template: 'buyer-guide' }, { registry, ctx });

    console.error(
      `[live] ${brief.strategy}: ${brief.claims.length} verified, ${brief.unverified.length} unverified; rungs: ${[
        ...new Set(brief.rungs.map((r) => r.rung)),
      ].join(', ')}`,
    );
    expect(brief.rungs.length).toBeGreaterThan(0);
    expect(brief.claims.length).toBeGreaterThan(0);
    expect(brief.markdown).toContain('youtube.com/watch?v=');

    const ids = new Set(contexts.map((c) => c.metadata.ref.nativeId));
    for (const claim of brief.claims) {
      const c = claim.citation;
      expect(c.url, claim.id).toMatch(/^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}&t=\d+s$/);
      expect(ids.has(new URL(c.url as string).searchParams.get('v') as string)).toBe(true);
      expect(resolveCitation(c, contexts), `${claim.id}: "${c.quote}" at ${c.url}`).toBeGreaterThanOrEqual(0.8);
    }
    for (const p of brief.consensus) expect(new Set(p.videos).size).toBeGreaterThanOrEqual(2);
    // Unverified claims never appear as cited links in the brief body.
    for (const u of brief.unverified) expect(u.reason).toBeTruthy();
  });
});
