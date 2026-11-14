#!/usr/bin/env -S npx tsx
/**
 * stdio MCP server. stdout carries the protocol, so nothing else may write to
 * it: all logging goes to stderr through ctx.log.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MemoryStorage, type Storage } from '@vid2context/core';
import { createFfmpegExtractor } from '@vid2context/live/node';
import { createNodeContext, createRegistry, loadEnvFiles } from '@vid2context/registry/node';
import pkg from '../package.json' with { type: 'json' };
import { createServer } from './server.ts';

loadEnvFiles();
const ctx = createNodeContext();
const registry = createRegistry();
// Open the library backend up front so every tool and wired package shares the real instance.
let storage: Storage;
try {
  storage = (await registry.openStorage(ctx)) ?? new MemoryStorage();
} catch (err) {
  ctx.log.warn('storage backend failed to open, using memory storage', { error: err instanceof Error ? err.message : String(err) });
  storage = new MemoryStorage();
}
const server = createServer(registry, ctx, pkg.version, {
  storage,
  extractAudio: createFfmpegExtractor({ env: ctx.env }),
});
await server.connect(new StdioServerTransport());
ctx.log.info('vid2context MCP server ready on stdio', { storage: storage.backend });
