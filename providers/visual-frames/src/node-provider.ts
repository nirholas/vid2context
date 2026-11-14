/**
 * Node entry (package.json condition `node`): the vision rungs plus local OCR
 * with tesseract.js reading bundled language data.
 *
 * For each language in TESSERACT_LANGS, an installed `@tesseract.js-data/<lang>`
 * package is read straight from disk (eng ships as a dependency, so English
 * OCR works offline). Other languages are downloaded once by tesseract.js and
 * cached under <VID2CONTEXT_HOME or ./.vid2context>/models/tesseract.
 * TESSERACT_LANG_PATH points every language at your own directory or URL.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { dataHome } from '@vid2context/ffmpeg';
import { createVisualProvider } from './provider.ts';
import type { TesseractLang, TesseractLangSource } from './tesseract.ts';

export * from './shared.ts';
export { cdnLangSource, DEFAULT_MIN_CONFIDENCE, MIN_TEXT_CHARS, type TesseractLang, type TesseractLangSource, tesseractEnabled, tesseractLangs, tesseractRungs, terminateTesseract, textFromBlocks } from './tesseract.ts';

const require = createRequire(import.meta.url);

/** Bytes of the LSTM traineddata from an installed @tesseract.js-data/<lang> package, or null when it is not installed. */
export async function bundledTraineddata(lang: string): Promise<Uint8Array | null> {
  let dir: string;
  try {
    dir = dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
  } catch {
    return null;
  }
  try {
    return new Uint8Array(await readFile(join(dir, '4.0.0_best_int', `${lang}.traineddata.gz`)));
  } catch {
    return null;
  }
}

export function tesseractCacheDir(env: Record<string, string | undefined>): string {
  return join(dataHome(env), 'models', 'tesseract');
}

export const nodeLangSource: TesseractLangSource = async (langs, ctx) => {
  const cachePath = tesseractCacheDir(ctx.env);
  if (ctx.env.TESSERACT_LANG_PATH) {
    await mkdir(cachePath, { recursive: true });
    return { langs, options: { langPath: ctx.env.TESSERACT_LANG_PATH, cachePath } };
  }
  const out: TesseractLang[] = [];
  let downloads = false;
  for (const code of langs) {
    const data = await bundledTraineddata(code);
    if (data) out.push({ code, data });
    else {
      out.push(code);
      downloads = true;
    }
  }
  if (!downloads) return { langs: out, options: { cacheMethod: 'none' } };
  await mkdir(cachePath, { recursive: true });
  ctx.log.info('tesseract: languages without a bundled package are downloaded once and cached', { cachePath });
  return { langs: out, options: { cachePath, cacheMethod: 'write' } };
};

export default createVisualProvider(nodeLangSource);
