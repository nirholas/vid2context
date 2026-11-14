/**
 * Minimal Worker used only by the LIVE wrangler test: serves assets through
 * fetchAssetWithSpaFallback, so the fallback runs in the real Workers runtime
 * against the real assets binding. Not deployed anywhere.
 */
import { type AssetsBinding, fetchAssetWithSpaFallback } from '../cloudflare/spa-fallback.ts';

export default {
  fetch(req: Request, env: { ASSETS: AssetsBinding }): Promise<Response> {
    return fetchAssetWithSpaFallback(req, env.ASSETS);
  },
};
