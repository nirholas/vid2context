/**
 * Test Worker for the LIVE binding checks in ../live.test.ts. Run by
 * `wrangler dev --config providers/cloudflare-ai/test/worker/wrangler.jsonc`;
 * Workers AI always runs remotely, so it needs CLOUDFLARE_ACCOUNT_ID and
 * CLOUDFLARE_API_TOKEN in the shell. It splits env the way createWorkersContext
 * does (strings to ctx.env, objects to ctx.bindings) without importing the
 * whole Workers registry, so other providers' state cannot break this check.
 */
import { type Ctx, createContext, type Env, streamFromRung, Vid2ContextError } from '@vid2context/core';
import { embedRungs, llmRungs, sttRungs } from '../../src/index.ts';

function workersContext(env: Record<string, unknown>, signal: AbortSignal): Ctx {
  const strings: Env = {};
  const bindings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') strings[k] = v;
    else if (v !== undefined && v !== null) bindings[k] = v;
  }
  return createContext({ runtime: 'workers', env: strings, signal, bindings });
}

function fail(err: unknown): Response {
  const e = err instanceof Vid2ContextError ? { code: err.code, message: err.message, hint: err.hint } : { message: String(err) };
  return Response.json({ error: e }, { status: 500 });
}

export default {
  async fetch(req: Request, env: Record<string, unknown>): Promise<Response> {
    const ctx = workersContext(env, req.signal);
    const url = new URL(req.url);
    const model = url.searchParams.get('model') ?? undefined;
    try {
      if (url.pathname === '/bindings') {
        return Response.json({ bindings: Object.keys(ctx.bindings ?? {}), env: Object.keys(ctx.env).sort() });
      }
      if (url.pathname === '/stt') {
        const rungs = sttRungs({ ...ctx.env, ...(model ? { CLOUDFLARE_STT_MODEL: model } : {}) });
        const rung = rungs.find((r) => r.service === 'cloudflare-binding');
        if (!rung) throw new Error('no binding rung');
        const data = new Uint8Array(await req.arrayBuffer());
        const res = await rung.transcribe({ kind: 'bytes', data, mimeType: 'audio/mpeg', filename: 'audio.mp3' }, {}, ctx);
        return Response.json(res);
      }
      if (url.pathname === '/chat' || url.pathname === '/stream') {
        const rungs = llmRungs({ ...ctx.env, ...(model ? { CLOUDFLARE_BINDING_MODEL: model } : {}) });
        const rung = rungs[0];
        if (!rung) throw new Error('no llm rung');
        const req2 = {
          messages: [
            { role: 'system' as const, content: 'Reply with a JSON object only.' },
            {
              role: 'user' as const,
              content: 'Give the speaker and year of "one small step for man" as {"speaker": string, "year": number}.',
            },
          ],
          maxTokens: 300,
          json: url.searchParams.has('json'),
        };
        if (url.pathname === '/chat') return Response.json(await rung.chat(req2, ctx));
        const events = [];
        for await (const e of streamFromRung(rung, req2, ctx)) events.push(e);
        return Response.json(events);
      }
      if (url.pathname === '/embed') {
        const rung = embedRungs(ctx.env).find((r) => r.service === 'cloudflare-binding');
        if (!rung) throw new Error('no embed rung');
        const vectors = await rung.embed(['one small step for man', 'a giant leap for mankind'], ctx);
        return Response.json({ dimensions: rung.dimensions, lengths: vectors.map((v) => v.length) });
      }
      return new Response('not found', { status: 404 });
    } catch (err) {
      return fail(err);
    }
  },
};
