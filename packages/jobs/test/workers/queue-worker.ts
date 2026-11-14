/**
 * A Worker for the Miniflare test: `fetch` is the producer (enqueues through
 * RemoteQueue + cloudflareDispatch, reads jobs back), `queue` is the consumer
 * (handleQueueBatch over Workers KV). Provider calls are answered from the
 * recorded YouTube fixtures the test injects as FIXTURES at bundle time.
 */
import { type Ctx, createContext, errorFromResponse, Registry } from '@vid2context/core';
import { type RecordedCall, replayFetch } from '@vid2context/core/testing';
import youtube, { parseSrv3 } from '@vid2context/provider-youtube';
import {
  cloudflareDispatch,
  handleQueueBatch,
  JobKinds,
  type JobMessageBody,
  type KvNamespace,
  type MessageBatch,
  type QueueProducer,
  RemoteQueue,
  registerBuiltinKinds,
  workersKv,
} from '../../src/index.ts';

declare const FIXTURES: Record<string, string>;

interface Env {
  JOBS: QueueProducer<JobMessageBody>;
  JOBS_KV: KvNamespace;
}

const registry = new Registry(youtube, 'workers');
const kinds = new JobKinds();
registerBuiltinKinds(kinds);

// A kind that fetches one caption track: the first request answers the recorded 429, the next the recorded track.
let timedtextCalls = 0;
kinds.register(
  'timedtext',
  async ({ ctx, input }) => {
    const res = await ctx.fetch(String(input));
    if (!res.ok) throw await errorFromResponse(res, 'YouTube timedtext');
    return { segments: parseSrv3(await res.text()).length };
  },
  { maxAttempts: 3, backoff: { baseMs: 0 } },
);

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const env = {};

function ctx(): Ctx {
  const fetch = replayFetch([
    {
      method: 'POST',
      url: /youtubei\/v1\/player/,
      response: (call: RecordedCall) => {
        const { videoId } = JSON.parse(String(call.body)) as { videoId: string };
        const body = videoId === 'jNQXAC9IVRw' ? FIXTURES.player : FIXTURES.unavailable;
        return { body: body as string, headers: { 'content-type': 'application/json' } };
      },
    },
    {
      url: /timedtext\?v=jNQXAC9IVRw.*probe=retry/,
      response: () => {
        timedtextCalls += 1;
        return timedtextCalls === 1 ? { status: 429, body: FIXTURES.blocked as string } : { body: FIXTURES.en as string };
      },
    },
    { url: /timedtext\?v=jNQXAC9IVRw.*lang=en/, response: { body: FIXTURES.en as string } },
    { url: /timedtext\?v=jNQXAC9IVRw.*lang=de/, response: { body: FIXTURES.de as string } },
  ]);
  return createContext({ runtime: 'workers', env, fetch, log: silent });
}

function producer(e: Env): RemoteQueue {
  return new RemoteQueue({ kv: workersKv(e.JOBS_KV), dispatch: cloudflareDispatch(e.JOBS), ctx: ctx(), kinds });
}

export default {
  async fetch(req: Request, e: Env): Promise<Response> {
    const url = new URL(req.url);
    const queue = producer(e);
    if (req.method === 'POST' && url.pathname === '/jobs') {
      const body = (await req.json()) as { kind: string; input: unknown };
      return Response.json(await queue.enqueue(body.kind, body.input), { status: 202 });
    }
    const id = /^\/jobs\/([^/]+)$/.exec(url.pathname)?.[1];
    if (id && req.method === 'GET') return Response.json({ job: await queue.get(id), snapshot: await queue.snapshot(id) });
    return new Response('not found', { status: 404 });
  },
  async queue(batch: MessageBatch<unknown>, e: Env): Promise<void> {
    await handleQueueBatch(batch, e, (x) => ({ kv: workersKv(x.JOBS_KV), kinds, registry, ctx: ctx() }));
  },
};
