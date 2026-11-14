#!/usr/bin/env -S npx tsx
import { createNodeContext, createRegistry, loadEnvFiles } from '@vid2context/registry/node';
import pkg from '../package.json' with { type: 'json' };
import { run } from './main.ts';

loadEnvFiles();
const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const env = verbose && !process.env.VID2CONTEXT_LOG_LEVEL ? { ...process.env, VID2CONTEXT_LOG_LEVEL: 'info' } : process.env;
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());

process.exitCode = await run(
  argv,
  {
    registry: createRegistry(),
    ctx: createNodeContext({ env, signal: abort.signal }),
    io: { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) },
  },
  pkg.version,
);
