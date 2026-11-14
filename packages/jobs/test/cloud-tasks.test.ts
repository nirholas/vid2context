import { createContext, MemoryKv } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { jobsRoutes } from '../src/http.ts';
import {
  buildCloudTask,
  cloudTasksConfigFromEnv,
  GOOGLE_JWKS_URL,
  GoogleOidcVerifier,
  importJwks,
  JobKinds,
  RemoteQueue,
  registerBuiltinKinds,
} from '../src/index.ts';
import { jobsFixture, youtubeCtx, youtubeRegistry } from './helpers.ts';

const QUEUE = 'projects/vid2context-demo/locations/us-central1/queues/jobs';
const RUN_URL = 'https://jobs.example.org/api/v1';
const jwks = () => jobsFixture('google-oauth2-v3-certs.json');

describe('Cloud Tasks task building', () => {
  it('reads the config from env and validates it', () => {
    expect(cloudTasksConfigFromEnv({})).toBeNull();
    const env = {
      VID2CONTEXT_CLOUD_TASKS_QUEUE: QUEUE,
      VID2CONTEXT_CLOUD_TASKS_RUN_URL: `${RUN_URL}/`,
      VID2CONTEXT_CLOUD_TASKS_SERVICE_ACCOUNT: 'jobs-invoker@vid2context-demo.iam.gserviceaccount.com',
    };
    expect(cloudTasksConfigFromEnv(env)).toEqual({
      queue: QUEUE,
      runUrl: RUN_URL,
      serviceAccountEmail: env.VID2CONTEXT_CLOUD_TASKS_SERVICE_ACCOUNT,
    });
    expect(() => cloudTasksConfigFromEnv({ ...env, VID2CONTEXT_CLOUD_TASKS_QUEUE: 'jobs' })).toThrow(/queue path/);
    expect(() => cloudTasksConfigFromEnv({ ...env, VID2CONTEXT_CLOUD_TASKS_RUN_URL: 'http://jobs.example.org' })).toThrow(
      /https/,
    );
  });

  it('builds an HTTP task with an OIDC token that POSTs the job id to the run endpoint', () => {
    const cfg = { queue: QUEUE, runUrl: RUN_URL, serviceAccountEmail: 'jobs-invoker@vid2context-demo.iam.gserviceaccount.com' };
    const now = Date.parse('2026-11-14T12:00:00Z');
    const task = buildCloudTask(cfg, { id: 'job_abcdefghijklmnopqrstuv' }, 4000, now);
    expect(task).toEqual({
      scheduleTime: '2026-11-14T12:00:04.000Z',
      dispatchDeadline: '1800s',
      httpRequest: {
        httpMethod: 'POST',
        url: `${RUN_URL}/jobs/job_abcdefghijklmnopqrstuv/run`,
        headers: { 'content-type': 'application/json' },
        body: btoa('{"jobId":"job_abcdefghijklmnopqrstuv"}'),
        oidcToken: { serviceAccountEmail: cfg.serviceAccountEmail, audience: RUN_URL },
      },
    });
    expect(buildCloudTask(cfg, { id: 'job_abcdefghijklmnopqrstuv' }).scheduleTime).toBeUndefined();
  });
});

describe('OIDC verification (recorded JWKS)', () => {
  it('imports every RSA signing key Google publishes', async () => {
    const doc = JSON.parse(jwks()) as { keys: { kid: string }[] };
    const keys = await importJwks(doc as never);
    expect([...keys.keys()].sort()).toEqual(doc.keys.map((k) => k.kid).sort());
    for (const key of keys.values()) expect(key.algorithm).toMatchObject({ name: 'RSASSA-PKCS1-v1_5' });
  });

  it('rejects malformed tokens and requests without a token with 401', async () => {
    const verifier = new GoogleOidcVerifier({ audience: RUN_URL });
    const ctx = testContext({ fetch: replayFetch([{ url: GOOGLE_JWKS_URL, response: { body: jwks() } }]) });
    await expect(verifier.verify('not-a-token', ctx)).rejects.toMatchObject({ code: 'auth', status: 401 });

    const queue = new RemoteQueue({ kv: new MemoryKv(), dispatch: async () => {}, ctx });
    const app = new Hono().route(
      '/api/v1',
      jobsRoutes({
        registry: youtubeRegistry(),
        makeCtx: () => ctx,
        storage: async () => {
          throw new Error('unused');
        },
        queue,
        run: {
          verifier,
          consumer: () => ({ kv: new MemoryKv(), kinds: new JobKinds(), registry: youtubeRegistry(), ctx }),
          dispatch: async () => {},
        },
      }),
    );
    const missing = await app.request('/api/v1/jobs/job_abcdefghijklmnopqrstuv/run', { method: 'POST' });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ error: { code: 'auth', message: 'Missing bearer token.' }, attempts: [] });
    const garbage = await app.request('/api/v1/jobs/job_abcdefghijklmnopqrstuv/run', {
      method: 'POST',
      headers: { authorization: 'Bearer a.b.c' },
    });
    expect(garbage.status).toBe(401);
  });
});

const METADATA = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';

async function metadataToken(audience: string): Promise<string | null> {
  try {
    const res = await fetch(`${METADATA}?audience=${encodeURIComponent(audience)}&format=full`, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(3000),
    });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

// Needs LIVE=1 and a GCP machine whose metadata server issues identity tokens (Cloud Run, GCE, Cloud Workstations).
describe.skipIf(!process.env.LIVE)('OIDC verification against a real Google-issued token (LIVE)', () => {
  it('accepts a real token for the right audience and rejects wrong audience, account and signature', async (t) => {
    const token = await metadataToken(RUN_URL);
    if (!token) t.skip();
    const ctx = createContext({ runtime: 'node', env: {} });
    const claims = await new GoogleOidcVerifier({ audience: RUN_URL }).verify(token as string, ctx);
    expect(claims.iss).toBe('https://accounts.google.com');
    expect(claims.aud).toBe(RUN_URL);
    await new GoogleOidcVerifier({ audience: RUN_URL, serviceAccountEmail: claims.email }).verify(token as string, ctx);

    await expect(new GoogleOidcVerifier({ audience: `${RUN_URL}/other` }).verify(token as string, ctx)).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      new GoogleOidcVerifier({ audience: RUN_URL, serviceAccountEmail: `x${claims.email}` }).verify(token as string, ctx),
    ).rejects.toMatchObject({
      status: 401,
    });
    const [h, p, s] = (token as string).split('.') as [string, string, string];
    const flipped = `${h}.${p}.${s.slice(0, -4)}${s.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`;
    await expect(new GoogleOidcVerifier({ audience: RUN_URL }).verify(flipped, ctx)).rejects.toMatchObject({ status: 401 });
  });

  it('runs a dispatched job when the run endpoint receives a real Cloud Tasks style request', async (t) => {
    const token = await metadataToken(RUN_URL);
    if (!token) t.skip();
    const kv = new MemoryKv();
    const kinds = new JobKinds();
    const jobCtx = youtubeCtx();
    const live = createContext({ runtime: 'node', env: {} });
    const dispatched: string[] = [];
    const queue = new RemoteQueue({ kv, kinds, ctx: jobCtx, dispatch: async (job) => void dispatched.push(job.id) });
    registerBuiltinKinds(queue);
    const app = new Hono().route(
      '/api/v1',
      jobsRoutes({
        registry: youtubeRegistry(),
        makeCtx: () => live,
        storage: async () => {
          throw new Error('unused');
        },
        queue,
        run: {
          verifier: new GoogleOidcVerifier({ audience: RUN_URL }),
          consumer: () => ({ kv, kinds, registry: youtubeRegistry(), ctx: jobCtx }),
          dispatch: async () => {},
        },
      }),
    );
    const job = await queue.enqueue('context', 'jNQXAC9IVRw');
    expect(dispatched).toEqual([job.id]);
    const res = await app.request(`/api/v1/jobs/${job.id}/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: job.id }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: 'succeeded', job: { id: job.id, status: 'succeeded' } });
    expect((await queue.get(job.id))?.status).toBe('succeeded');
  });
});
