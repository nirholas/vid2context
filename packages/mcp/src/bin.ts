#!/usr/bin/env -S npx tsx
/**
 * stdio MCP server. stdout carries the protocol, so nothing else may write to
 * it: all logging goes to stderr through ctx.log.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createNodeContext, createRegistry, loadEnvFiles } from '@vid2context/registry/node';
import pkg from '../package.json' with { type: 'json' };
import { createServer } from './server.ts';

loadEnvFiles();
const ctx = createNodeContext();
const server = createServer(createRegistry(), ctx, pkg.version);
await server.connect(new StdioServerTransport());
ctx.log.info('vid2context MCP server ready on stdio');
