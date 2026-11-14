/**
 * The local data directory: ./.vid2context in the working directory, or
 * VID2CONTEXT_HOME when set (see docs/prompts/SHARED-CONTRACTS.md section 9).
 */
import { join, resolve } from 'node:path';
import type { Env } from '@vid2context/core';

export function dataHome(env: Env = {}): string {
  const home = env.VID2CONTEXT_HOME?.trim();
  return home ? resolve(home) : resolve('.vid2context');
}

/** Managed binaries: <home>/bin. */
export function managedBinDir(env: Env = {}): string {
  return join(dataHome(env), 'bin');
}

/** Cross-process locks: <home>/locks. */
export function locksDir(env: Env = {}): string {
  return join(dataHome(env), 'locks');
}
