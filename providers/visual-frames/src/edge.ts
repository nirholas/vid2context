/**
 * Workers entry (package.json conditions `workerd` and `worker`): the vision
 * rungs only. tesseract.js needs WebAssembly workers that Cloudflare Workers
 * do not provide, so the OCR rung is left out of edge bundles entirely.
 */
import { createVisualProvider } from './provider.ts';

export * from './shared.ts';

export default createVisualProvider();
