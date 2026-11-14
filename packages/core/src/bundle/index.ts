/**
 * The .zip bundle and "Copy for agents". Runtime-neutral: Node 22+, Workers
 * and browsers produce byte-identical bundles from the same code.
 */
export * from './agent-prompt.ts';
export * from './build.ts';
export { crc32 } from './crc32.ts';
export { safeFileName, slugify, UniqueNames } from './names.ts';
export * from './zip.ts';
