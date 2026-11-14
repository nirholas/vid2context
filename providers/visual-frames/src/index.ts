/**
 * Default and browser entry: the vision rungs plus local OCR with
 * tesseract.js. Language data comes from TESSERACT_LANG_PATH when set, else
 * from tesseract.js's CDN (cached in IndexedDB by the browser build). Node
 * resolves the `node` condition to src/node-provider.ts instead, which uses
 * the bundled eng data and needs no download.
 */
import { createVisualProvider } from './provider.ts';
import { cdnLangSource } from './tesseract.ts';

export * from './shared.ts';
export { cdnLangSource, DEFAULT_MIN_CONFIDENCE, MIN_TEXT_CHARS, type TesseractLangSource, tesseractEnabled, tesseractLangs, tesseractRungs, terminateTesseract, textFromBlocks } from './tesseract.ts';

export default createVisualProvider(cdnLangSource);
