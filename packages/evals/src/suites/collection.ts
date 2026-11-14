/** Load the recorded transcripts a citations or search dataset is labeled on. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vid2ContextError, type VideoContext } from '@vid2context/core';

/** Collection paths in datasets are relative to the repository root. */
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export function loadCollection(collection: readonly { videoId: string; transcript: string }[]): VideoContext[] {
  return collection.map((c) => {
    const ctx = JSON.parse(readFileSync(resolve(REPO_ROOT, c.transcript), 'utf8')) as VideoContext;
    if (ctx.metadata?.ref?.id !== c.videoId) {
      throw new Vid2ContextError(
        'bad-request',
        `Collection file ${c.transcript} holds ${ctx.metadata?.ref?.id}, not ${c.videoId}.`,
        {
          hint: 'Point the collection entry at the recorded VideoContext JSON of that video.',
        },
      );
    }
    return ctx;
  });
}

/** Sum of `ms` over successful attempts of one stage. */
export function stageMs(attempts: readonly { stage: string; outcome: string; ms?: number }[], stage: string): number {
  return attempts.filter((a) => a.stage === stage && a.outcome === 'ok').reduce((n, a) => n + (a.ms ?? 0), 0);
}
