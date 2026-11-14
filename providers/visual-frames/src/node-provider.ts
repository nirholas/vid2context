/**
 * Node entry (package.json condition `node`): the vision rungs plus local OCR
 * with tesseract.js reading language data from disk.
 *
 *   TESSERACT_LANG_PATH set   tesseract.js reads <lang>.traineddata.gz from that directory or URL
 *   one bundled language      read straight from the installed @tesseract.js-data/<lang> package
 *                             (eng ships as a dependency, so English OCR works offline, nothing written)
 *   otherwise                 <VID2CONTEXT_HOME or ./.vid2context>/models/tesseract is filled once:
 *                             bundled languages are copied, others downloaded from the jsDelivr CDN
 *                             through ctx.fetch, then every language is read from there
 */
import { copyFile, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { type Ctx, type Env, fetchWithTimeout, Vid2ContextError } from '@vid2context/core';
import { dataHome } from '@vid2context/ffmpeg';
import { createVisualProvider } from './provider.ts';
import { type TesseractLangSource, tesseractRungs } from './tesseract.ts';
import { PROVIDER_ID } from './vision.ts';

export * from './shared.ts';
export {
  cdnLangSource,
  DEFAULT_MIN_CONFIDENCE,
  MIN_TEXT_CHARS,
  type TesseractLangSource,
  terminateTesseract,
  tesseractEnabled,
  tesseractLangs,
  tesseractRungs,
  textFromBlocks,
} from './tesseract.ts';

const require = createRequire(import.meta.url);

/** The LSTM model directory tesseract.js uses with OEM 1. */
const MODEL_DIR = '4.0.0_best_int';

/** Directory holding <lang>.traineddata.gz in an installed @tesseract.js-data/<lang> package, or null. */
export async function bundledLangDir(lang: string): Promise<string | null> {
  let pkg: string;
  try {
    pkg = require.resolve(`@tesseract.js-data/${lang}/package.json`);
  } catch {
    return null;
  }
  const dir = join(dirname(pkg), MODEL_DIR);
  return (await exists(join(dir, `${lang}.traineddata.gz`))) ? dir : null;
}

export function tesseractCacheDir(env: Env): string {
  return join(dataHome(env), 'models', 'tesseract');
}

export function cdnTraineddataUrl(lang: string): string {
  return `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}/${MODEL_DIR}/${lang}.traineddata.gz`;
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

async function download(lang: string, target: string, ctx: Ctx): Promise<void> {
  const url = cdnTraineddataUrl(lang);
  ctx.log.info('tesseract: downloading language data once', { lang, url });
  const res = await fetchWithTimeout(ctx, url, {}, 5 * 60_000);
  if (!res.ok) {
    throw new Vid2ContextError(
      res.status === 404 ? 'bad-request' : 'upstream',
      `No tesseract language data for "${lang}" (HTTP ${res.status}).`,
      {
        hint: 'Use tesseract language codes in TESSERACT_LANGS (eng, deu, fra, ces, chi_sim, ...), or set TESSERACT_LANG_PATH.',
      },
    );
  }
  const tmp = `${target}.${process.pid}.part`;
  await writeFile(tmp, new Uint8Array(await res.arrayBuffer()));
  await rename(tmp, target);
}

export const nodeLangSource: TesseractLangSource = async (langs, ctx) => {
  if (ctx.env.TESSERACT_LANG_PATH) return { options: { langPath: ctx.env.TESSERACT_LANG_PATH, cacheMethod: 'none' } };
  const bundled = await Promise.all(langs.map(bundledLangDir));
  const only = bundled[0];
  if (langs.length === 1 && only) return { options: { langPath: only, cacheMethod: 'none' } };

  const dir = tesseractCacheDir(ctx.env);
  await mkdir(dir, { recursive: true });
  for (const [i, lang] of langs.entries()) {
    const target = join(dir, `${lang}.traineddata.gz`);
    if (await exists(target)) continue;
    const from = bundled[i];
    if (from) await copyFile(join(from, `${lang}.traineddata.gz`), target);
    else await download(lang, target, ctx);
  }
  return { options: { langPath: dir, cacheMethod: 'none' } };
};

/** Vision rungs plus tesseract with bundled or cached language data. */
export const nodeVisualProvider = createVisualProvider((env) => tesseractRungs(env, nodeLangSource, PROVIDER_ID));

export default nodeVisualProvider;
