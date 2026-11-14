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
import { type TesseractLangSource, tesseractRungs } from './tesseract.ts';
import { PROVIDER_ID, visionRungs } from './vision.ts';

export function visualRungs(env: Env, tesseract?: TesseractLangSource): VisualRung[] {
  return [...visionRungs(env), ...(tesseract ? tesseractRungs(env, tesseract, PROVIDER_ID) : [])];
}

export function createVisualProvider(tesseract?: TesseractLangSource): VisualProvider {
  return defineProvider({
    id: PROVIDER_ID,
    kind: 'visual',
    name: 'Frames: OCR and vision models',
    runtimes: ['node', 'workers', 'browser'],
    rungs: (env: Env) => visualRungs(env, tesseract),
  });
}
