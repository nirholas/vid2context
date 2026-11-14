import { readFileSync } from 'node:fs';
import type { VideoContext } from '@vid2context/core';

const own = new URL('./fixtures/', import.meta.url);
const shared = new URL('../../../tests/fixtures/contexts/', import.meta.url);

/** A real VideoContext recorded with the vid2context CLI (see test/fixtures/README.md and tests/fixtures/README.md). */
export function loadFixture(name: string, where: 'own' | 'shared' = 'own'): VideoContext {
  return JSON.parse(readFileSync(new URL(name, where === 'own' ? own : shared), 'utf8')) as VideoContext;
}
