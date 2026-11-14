#!/usr/bin/env -S npx tsx
import { createNodeContext, createRegistry, loadEnvFiles } from '@vid2context/registry/node';
import pkg from '../package.json' with { type: 'json' };
import { run } from './main.ts';

// .env files first; variables already set in the shell win.
loadEnvFiles();
const argv = process.argv.slice(2);
const quiet = argv.includes('--quiet') || argv.includes('-q');
const verbose = argv.includes('--verbose');
const level = verbose ? 'info' : quiet ? 'error' : undefined;
const env = level && !process.env.VID2CONTEXT_LOG_LEVEL ? { ...process.env, VID2CONTEXT_LOG_LEVEL: level } : process.env;
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());

process.exitCode = await run(
  argv,
  {
    registry: createRegistry(),
    ctx: createNodeContext({ env, signal: abort.signal }),
    io: {
      stdout: (s) => process.stdout.write(s),
      stderr: (s) => process.stderr.write(s),
      stderrIsTTY: Boolean(process.stderr.isTTY),
    },
  },
  pkg.version,
);
