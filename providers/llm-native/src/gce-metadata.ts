/**
 * Access token from the GCE metadata server, for Node on a Google Cloud VM,
 * Cloud Run or GKE. Loaded only through a dynamic import when ctx.runtime is
 * 'node', so Workers and browser code paths never reach it (the metadata host
 * only exists inside Google Cloud anyway).
 *
 * The VM's service account needs the cloud-platform scope (or an equivalent
 * Vertex AI scope) and the Vertex AI User role; the default Compute Engine
 * scopes are not enough.
 */
import { type Ctx, fetchWithTimeout, Vid2ContextError } from '@vid2context/core';

export const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/** Refresh this long before the token expires. */
const EARLY_MS = 120_000;

let cached: { token: string; expiresAt: number } | undefined;

/** Forget the cached token (tests, or after a 401). */
export function clearMetadataToken(): void {
  cached = undefined;
}

export async function metadataToken(ctx: Ctx, now = Date.now()): Promise<string> {
  if (cached && cached.expiresAt - EARLY_MS > now) return cached.token;
  let res: Response;
  try {
    res = await fetchWithTimeout(ctx, METADATA_TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' } }, 5_000);
  } catch (err) {
    throw new Vid2ContextError('auth', 'GCE metadata server unreachable.', {
      cause: err,
      hint: 'VID2CONTEXT_GCE_METADATA=1 only works on Google Cloud (Compute Engine, Cloud Run, GKE). Elsewhere set GOOGLE_ACCESS_TOKEN.',
    });
  }
  if (!res.ok) {
    throw new Vid2ContextError('auth', `GCE metadata token: HTTP ${res.status}`, {
      status: res.status,
      hint: 'The instance has no usable service account. Attach one, or set GOOGLE_ACCESS_TOKEN.',
    });
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Vid2ContextError('auth', 'GCE metadata token: response had no access_token.');
  cached = { token: body.access_token, expiresAt: now + (body.expires_in ?? 300) * 1000 };
  return body.access_token;
}
