import type { Ctx } from '@vid2context/core';

export async function bad(ctx: Ctx) {
  const key = process.env.GROQ_API_KEY;
  const res = await fetch('https://example.org');
  const other = await globalThis.fetch('https://example.org');
  return [key, res, other, ctx];
}

export async function good(ctx: Ctx) {
  // process.env and fetch( in a comment are fine.
  const msg = 'set it in process.env, then call fetch(url)';
  const res = await ctx.fetch('https://example.org');
  return [ctx.env.GROQ_API_KEY, res, msg];
}

export default {
  async fetch(request: Request) {
    return new Response(String(request.url));
  },
};
