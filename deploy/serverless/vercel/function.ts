/**
 * Vercel Node.js function: the vid2context HTTP API (createApp from
 * packages/server) as a Node request listener.
 *
 * It uses the fetch-only provider set (the same one the Cloudflare Worker
 * runs), not the Node registry: serverless functions cannot run yt-dlp,
 * ffmpeg or local models, and a public deployment must never read files from
 * the server (the media-file source). Provider keys come from the Vercel
 * project's environment variables.
 */
import { getRequestListener } from '@hono/node-server';
import { createContext, type Env } from '@vid2context/core';
import { createRegistry } from '@vid2context/registry/workers';
import { createApp } from '@vid2context/server';
import pkg from '../../../packages/server/package.json' with { type: 'json' };

const registry = createRegistry();

export const app = createApp({
  registry,
  makeCtx: (req) => createContext({ runtime: 'node', env: process.env as Env, signal: req.signal }),
  version: pkg.version,
});

export default getRequestListener(app.fetch);
