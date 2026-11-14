/**
 * The G-Wagon series fixtures: index 0 is the shared part-1 fixture
 * (tests/fixtures/contexts), 1 to 3 are this package's recordings. No vitest
 * import, so scripts and examples can use it too.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VideoContext } from '@vid2context/core';

const FIXTURES = join(import.meta.dirname, 'fixtures');

export const GWAGON_IDS = ['cCPsdFdlshc', 'q6dzm-O1i2o', 'ovIkN7UgbgE', '1Xx1fmHIsiA'] as const;

export function gwagonContext(i: number): VideoContext {
  const id = GWAGON_IDS[i];
  const file =
    i === 0
      ? join(import.meta.dirname, '../../../tests/fixtures/contexts/youtube-cCPsdFdlshc.json')
      : join(FIXTURES, 'contexts', `youtube-${id}.json`);
  return JSON.parse(readFileSync(file, 'utf8')) as VideoContext;
}

export function gwagonContexts(): VideoContext[] {
  return GWAGON_IDS.map((_, i) => gwagonContext(i));
}
