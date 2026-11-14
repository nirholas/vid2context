/**
 * Shared bits for the setup scripts: a Node context with .env loaded, and
 * error output with the recovery hint. Output goes to stderr except for data
 * meant to be piped (the Slack manifest).
 */
import { type Ctx, Vid2ContextError } from '@vid2context/core';
import { createNodeContext, loadEnvFiles } from '@vid2context/registry/node';

export function scriptContext(): Ctx {
  loadEnvFiles();
  return createNodeContext();
}

export function fail(err: unknown): never {
  if (err instanceof Vid2ContextError) {
    console.error(`error (${err.code}): ${err.message}`);
    if (err.hint) console.error(`hint: ${err.hint}`);
  } else {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
}
