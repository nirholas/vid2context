/**
 * Vertex AI configuration and auth. Rungs are enabled from env alone:
 * GOOGLE_CLOUD_PROJECT plus a token source, either GOOGLE_ACCESS_TOKEN (any
 * runtime; for example `gcloud auth print-access-token`, valid about an hour)
 * or VID2CONTEXT_GCE_METADATA=1 (Node on Google Cloud: the metadata server).
 */
import { type Ctx, type Env, Vid2ContextError } from '@vid2context/core';

export function vertexEnabled(env: Env): boolean {
  return Boolean(env.GOOGLE_CLOUD_PROJECT) && (Boolean(env.GOOGLE_ACCESS_TOKEN) || env.VID2CONTEXT_GCE_METADATA === '1');
}

/** Env var names shown in health output for Vertex rungs. */
export function vertexRequires(env: Env): string[] {
  return [
    'GOOGLE_CLOUD_PROJECT',
    env.GOOGLE_ACCESS_TOKEN || env.VID2CONTEXT_GCE_METADATA !== '1' ? 'GOOGLE_ACCESS_TOKEN' : 'VID2CONTEXT_GCE_METADATA',
  ];
}

/** `global` lives on aiplatform.googleapis.com; regions on {location}-aiplatform.googleapis.com. */
export function vertexHost(location: string): string {
  return location === 'global' ? 'https://aiplatform.googleapis.com' : `https://${location}-aiplatform.googleapis.com`;
}

export function vertexModelUrl(
  env: Env,
  location: string,
  publisher: 'google' | 'anthropic',
  model: string,
  method: string,
): string {
  const project = encodeURIComponent(env.GOOGLE_CLOUD_PROJECT ?? '');
  return `${vertexHost(location)}/v1/projects/${project}/locations/${location}/publishers/${publisher}/models/${encodeURIComponent(model)}:${method}`;
}

export async function vertexToken(ctx: Ctx): Promise<string> {
  const token = ctx.env.GOOGLE_ACCESS_TOKEN;
  if (token) return token;
  if (ctx.env.VID2CONTEXT_GCE_METADATA === '1') {
    if (ctx.runtime !== 'node') {
      throw new Vid2ContextError('auth', `The GCE metadata server is only used on Node (runtime is ${ctx.runtime}).`, {
        hint: 'Set GOOGLE_ACCESS_TOKEN for Vertex AI on this runtime.',
      });
    }
    const { metadataToken } = await import('./gce-metadata.ts');
    return metadataToken(ctx);
  }
  throw new Vid2ContextError('auth', 'No Google Cloud access token.', {
    hint: 'Set GOOGLE_ACCESS_TOKEN (gcloud auth print-access-token) or, on Google Cloud, VID2CONTEXT_GCE_METADATA=1.',
  });
}

export async function vertexHeaders(ctx: Ctx): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await vertexToken(ctx)}` };
}

export const VERTEX_AUTH_HINT =
  'Vertex AI refused the token. Refresh GOOGLE_ACCESS_TOKEN (tokens last about an hour), and check the account has the Vertex AI User role and the model is enabled in Model Garden.';
