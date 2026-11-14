/**
 * Innertube player clients, in fallback order.
 *
 * Only clients verified live from a GCP VM on 2026-11-14 are listed (they
 * returned caption tracks for jNQXAC9IVRw). Checked and dropped the same day,
 * with the recorded responses in test/fixtures/:
 *   TVHTML5_SIMPLY_EMBEDDED_PLAYER  ERROR "YouTube is no longer supported in this application or device."
 *   WEB, MWEB                       UNPLAYABLE "The page needs to be reloaded." (even with visitorData; they now need a PO token)
 *   ANDROID_VR, TVHTML5             LOGIN_REQUIRED "Sign in to confirm you're not a bot" (from the VM; ANDROID and IOS passed)
 *
 * YouTube raises the minimum accepted version from time to time (an old one
 * gets HTTP 400 "Precondition check failed"). Override any version with
 * YOUTUBE_<KEY>_VERSION and the order with YOUTUBE_CLIENTS=ios,android
 * without a release.
 */
import { type Env, Vid2ContextError } from '@vid2context/core';

export interface ClientSpec {
  /** Lowercase key used in YOUTUBE_CLIENTS and YOUTUBE_<KEY>_VERSION. */
  key: string;
  clientName: string;
  /** Numeric id sent as x-youtube-client-name. */
  clientId: number;
  version: string;
  userAgent: (version: string) => string;
  /** Extra fields merged into context.client. */
  context: Record<string, string | number>;
}

export const CLIENTS: readonly ClientSpec[] = [
  {
    key: 'android',
    clientName: 'ANDROID',
    clientId: 3,
    version: '20.10.38',
    userAgent: (v) => `com.google.android.youtube/${v} (Linux; U; Android 11) gzip`,
    context: { androidSdkVersion: 30, osName: 'Android', osVersion: '11' },
  },
  {
    key: 'ios',
    clientName: 'IOS',
    clientId: 5,
    version: '20.10.4',
    userAgent: (v) => `com.google.ios.youtube/${v} (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)`,
    context: { deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82' },
  },
];

function withVersion(spec: ClientSpec, env: Env): ClientSpec {
  const v = env[`YOUTUBE_${spec.key.toUpperCase()}_VERSION`]?.trim();
  return v ? { ...spec, version: v } : spec;
}

/** The clients to try, in order, after applying YOUTUBE_CLIENTS and the version overrides. */
export function resolveClients(env: Env): ClientSpec[] {
  const raw = env.YOUTUBE_CLIENTS?.trim();
  if (!raw) return CLIENTS.map((c) => withVersion(c, env));
  const keys = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const unknown = keys.filter((k) => !CLIENTS.some((c) => c.key === k));
  if (unknown.length > 0 || keys.length === 0) {
    throw new Vid2ContextError('bad-request', `YOUTUBE_CLIENTS has unknown client names: ${unknown.join(', ') || '(empty)'}`, {
      hint: `Use a comma-separated list of: ${CLIENTS.map((c) => c.key).join(', ')}.`,
    });
  }
  return [...new Set(keys)].map((k) => withVersion(CLIENTS.find((c) => c.key === k) as ClientSpec, env));
}

/** Look up a client by key or clientName ('android' or 'ANDROID'). */
export function clientByName(name: string, env: Env): ClientSpec | undefined {
  const n = name.toLowerCase();
  const spec = CLIENTS.find((c) => c.key === n || c.clientName.toLowerCase() === n);
  return spec ? withVersion(spec, env) : undefined;
}
