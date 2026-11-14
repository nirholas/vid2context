/**
 * The `visual-frames` provider, assembled per runtime (runtime-neutral).
 *
 * The package exports three entries through package.json conditions so the
 * generated registries stay correct without per-rung runtimes:
 *
 *   workerd / worker  src/edge.ts           vision rungs only (no tesseract.js)
 *   browser, default  src/index.ts          vision rungs + tesseract (language data from TESSERACT_LANG_PATH or the CDN)
 *   node              src/node-provider.ts  vision rungs + tesseract with the bundled eng data, cached under .vid2context/models
 */
import { defineProvider, type Env, type VisualProvider, type VisualRung } from '@vid2context/core';
import { PROVIDER_ID, visionRungs } from './vision.ts';

/** Builds extra rungs from env (the tesseract rung, added by the browser and Node entries only). */
export type RungFactory = (env: Env) => VisualRung[];

/** The vision rungs plus any extra rungs. This module never imports tesseract, so the edge entry cannot reach it. */
export function visualRungs(env: Env, extra?: RungFactory): VisualRung[] {
  return [...visionRungs(env), ...(extra ? extra(env) : [])];
}

export function createVisualProvider(extra?: RungFactory): VisualProvider {
  return defineProvider({
    id: PROVIDER_ID,
    kind: 'visual',
    name: 'Frames: OCR and vision models',
    runtimes: ['node', 'workers', 'browser'],
    rungs: (env: Env) => visualRungs(env, extra),
  });
}
